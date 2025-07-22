const express = require('express');
const path = require('path');
const cors = require('cors');
const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const fs = require('fs').promises;
const util = require('util');
const fsSync = require('fs');

// Custom logger
const logger = {
    file: fsSync.createWriteStream('debug.txt', {flags: 'a'}),
    stdout: process.stdout,
    
    log: function(d) {
        const message = typeof d === 'object' ? JSON.stringify(d, null, 2) : d;
        this.file.write(util.format(message) + '\n');
        this.stdout.write(util.format(message) + '\n');
    },
    
    error: function(d) {
        const message = typeof d === 'object' ? JSON.stringify(d, null, 2) : d;
        this.file.write('ERROR: ' + util.format(message) + '\n');
        this.stdout.write('ERROR: ' + util.format(message) + '\n');
    }
};

// Clip extraction configuration
const CLIP_CONFIG = {
    MIN_SCORE: 0.5,          // Minimum quality score (0-1)
    MIN_DURATION: 5,         // Minimum clip length in seconds
    MAX_DURATION: 60,        // Maximum clip length in seconds  
    MAX_GAP_SECONDS: 3,      // Max gap between timestamps to group
    MAX_CLIPS: 3,           // Max number of clips to return
    CONTEXT_WINDOW: 2        // Number of timestamps before/after for context
};

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// AWS Configuration
let bedrockClient;

try {
    bedrockClient = new BedrockAgentRuntimeClient({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            sessionToken: process.env.AWS_SESSION_TOKEN,
        },
    });
    
    logger.log('AWS client initialized successfully');
    logger.log('Using region:', process.env.AWS_REGION || 'us-east-1');
    logger.log('Access Key ID (first 10 chars):', process.env.AWS_ACCESS_KEY_ID?.substring(0, 10) + '...');
} catch (error) {
    logger.error('Failed to initialize AWS client:', error);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/videos', express.static(path.join(__dirname, 'videos')));

// Video clip extractor class
class VideoClipExtractor {
    constructor(videosDirectory = './videos') {
        this.videosDirectory = videosDirectory;
        this.videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm'];
    }

    async extractRelevantClips(agentTrace, sources, agentResponse = '') {
        try {
            console.log('=== EXTRACTING CLIPS ===');
            console.log('Agent Response:', agentResponse);
            
            let clips = [];
            
            // First try to extract clips from trace
            if (agentTrace) {
                clips = await this.extractVideoClipsFromTrace(agentTrace, agentResponse);
            }
            
            // Fallback to default clips from multiple videos if no clips found
            if (clips.length === 0) {
                clips = await this.createFallbackClips(agentResponse);
            }
            
            // Filter and improve clips
            clips = this.filterAndImproveClips(clips, agentResponse);
            
            return clips;
        } catch (error) {
            console.error('Error extracting video clips:', error);
            return [];
        }
    }

    async extractVideoClipsFromTrace(trace, agentResponse) {
        const clips = [];
        try {
            // Get references from the trace
            const references = [];
            
            // The trace is an array of events
            if (Array.isArray(trace.all_events)) {
                for (const event of trace.all_events) {
                    // Look for knowledge base lookup output
                    if (event.trace?.orchestrationTrace?.observation?.knowledgeBaseLookupOutput?.retrievedReferences) {
                        const refs = event.trace.orchestrationTrace.observation.knowledgeBaseLookupOutput.retrievedReferences;
                        references.push(...refs);
                    }
                }
            }
            
            console.log('References found:', references.length);
            
            for (const ref of references) {
                const content = ref.content?.text;
                const s3Uri = ref.location?.s3Location?.uri;
                
                if (!content || !s3Uri) {
                    console.log('Skipping reference - missing content or URI');
                    continue;
                }
                
                console.log('\nProcessing reference:');
                console.log('Content preview:', content.substring(0, 100));
                console.log('S3 URI:', s3Uri);
                
                // Extract timestamps from content
                const timestamps = this.parseTimestampsFromContent(content);
                if (timestamps.length === 0) {
                    console.log('No timestamps found in reference');
                    continue;
                }
                
                console.log('Found timestamps:', timestamps.length);
                
                // Find matching video file
                const videoFile = await this.findVideoFile(s3Uri);
                if (!videoFile) {
                    console.log('No matching video file found');
                    continue;
                }
                
                console.log('Matched to video file:', videoFile);
                
                // Create intelligent clips instead of one big clip
                const intelligentClips = this.createIntelligentClips(timestamps, videoFile, agentResponse, s3Uri);
                console.log(`Created ${intelligentClips.length} clips from ${videoFile}`);
                
                // Add each clip individually to preserve video diversity
                intelligentClips.forEach(clip => {
                    console.log(`Adding clip: ${clip.title} from ${clip.videoPath} (${clip.startTime}-${clip.endTime})`);
                    clips.push(clip);
                });
            }
            
        } catch (error) {
            console.error('Error extracting clips from trace:', error);
        }
        
        console.log('\nTotal clips created:', clips.length);
        console.log('Clips by video:');
        const clipsByVideo = clips.reduce((acc, clip) => {
            acc[clip.videoPath] = (acc[clip.videoPath] || 0) + 1;
            return acc;
        }, {});
        console.log(clipsByVideo);
        
        return clips;
    }

    createIntelligentClips(timestamps, videoFile, agentResponse, s3Uri) {
        const clips = [];
        const keywords = this.extractKeywords(agentResponse);
        
        console.log(`Creating clips for ${videoFile} with ${timestamps.length} timestamps`);
        console.log('Keywords:', keywords);
        
        // Group timestamps by relevance and proximity
        const groups = this.groupRelevantTimestamps(timestamps, keywords);
        console.log(`Created ${groups.length} timestamp groups`);
        
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            if (group.length === 0) continue;
            
            const startTime = group[0].start;
            const endTime = group[group.length - 1].end;
            const duration = endTime - startTime;
            
            console.log(`Group ${i}: ${startTime}-${endTime} (${duration}s, ${group.length} timestamps)`);
            
            // Skip clips that are too long (over 2 minutes) or too short (under 5 seconds)
            if (duration > 120) {
                console.log(`Skipping group ${i}: too long (${duration}s)`);
                continue;
            }
            if (duration < 5) {
                console.log(`Skipping group ${i}: too short (${duration}s)`);
                continue;
            }
            
            const transcript = group.map(t => t.text).join(' ');
            const relevanceScore = this.calculateRelevanceScore(transcript, keywords);
            
            console.log(`Group ${i} relevance score: ${relevanceScore}`);
            
            // Only include clips with decent relevance
            if (relevanceScore > 0.05) { // Lowered threshold to be more inclusive
                const clip = {
                    title: this.generateClipTitle(transcript, keywords),
                    description: this.generateClipDescription(transcript),
                    videoPath: `/videos/${videoFile}`,
                    startTime: Math.max(0, startTime - 2), // Add 2 second buffer
                    endTime: endTime + 2, // Add 2 second buffer
                    transcript: transcript,
                    relevanceScore: relevanceScore,
                    sourceId: videoFile,
                    s3Uri: s3Uri // Track which S3 URI this came from
                };
                
                clips.push(clip);
                console.log(`Created clip: "${clip.title}" (${clip.startTime}-${clip.endTime}) from ${videoFile}`);
            } else {
                console.log(`Skipping group ${i}: low relevance (${relevanceScore})`);
            }
        }
        
        // Sort by relevance and return top 2 clips per video to ensure diversity
        const sortedClips = clips
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, 2);
        
        console.log(`Returning ${sortedClips.length} clips from ${videoFile}`);
        return sortedClips;
    }

    groupRelevantTimestamps(timestamps, keywords) {
        const groups = [];
        let currentGroup = [];
        let lastEndTime = 0;
        
        for (const timestamp of timestamps) {
            const isRelevant = this.isTimestampRelevant(timestamp.text, keywords);
            const timeSinceLastGroup = timestamp.start - lastEndTime;
            
            // Start new group if gap is too large (>10 seconds) or if starting fresh
            if (timeSinceLastGroup > 10 || currentGroup.length === 0) {
                if (currentGroup.length > 0) {
                    groups.push([...currentGroup]);
                }
                currentGroup = isRelevant ? [timestamp] : [];
            } else if (isRelevant) {
                currentGroup.push(timestamp);
            }
            
            lastEndTime = timestamp.end;
        }
        
        // Add the last group
        if (currentGroup.length > 0) {
            groups.push(currentGroup);
        }
        
        return groups.filter(group => group.length > 0);
    }

    extractKeywords(text) {
        // Extract meaningful keywords from the query/response
        const words = text.toLowerCase()
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter(word => word.length > 2)
            .filter(word => !['the', 'and', 'but', 'for', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'can', 'will', 'would', 'could', 'should', 'this', 'that', 'with', 'what', 'when', 'where', 'who', 'why', 'how'].includes(word));
        
        return [...new Set(words)]; // Remove duplicates
    }

    isTimestampRelevant(text, keywords) {
        const textLower = text.toLowerCase();
        return keywords.some(keyword => textLower.includes(keyword));
    }

    calculateRelevanceScore(text, keywords) {
        const textLower = text.toLowerCase();
        let score = 0;
        let totalWords = text.split(/\s+/).length;
        
        for (const keyword of keywords) {
            const matches = (textLower.match(new RegExp(keyword, 'g')) || []).length;
            score += matches;
        }
        
        return totalWords > 0 ? score / totalWords : 0;
    }

    generateClipTitle(transcript, keywords) {
        // Find the most relevant sentence or phrase
        const sentences = transcript.split(/[.!?]+/).filter(s => s.trim().length > 0);
        
        for (const sentence of sentences) {
            const sentenceLower = sentence.toLowerCase();
            if (keywords.some(keyword => sentenceLower.includes(keyword))) {
                const trimmed = sentence.trim();
                return trimmed.length > 50 ? trimmed.substring(0, 50) + '...' : trimmed;
            }
        }
        
        // Fallback to first few words
        const words = transcript.split(/\s+/).slice(0, 8).join(' ');
        return words.length > 50 ? words.substring(0, 50) + '...' : words;
    }

    generateClipDescription(transcript) {
        const trimmed = transcript.trim();
        return trimmed.length > 150 ? trimmed.substring(0, 150) + '...' : trimmed;
    }

    async createFallbackClips(agentResponse) {
        const videoFiles = await this.findAllVideoFiles();
        const clips = [];
        
        // Create diverse clips from different videos
        for (let i = 0; i < Math.min(videoFiles.length, 2); i++) {
            const videoFile = videoFiles[i];
            const startTime = i * 30; // Different start times for variety
            
            clips.push({
                title: `Related Content from ${this.getVideoDisplayName(videoFile)}`,
                description: `This clip may contain relevant information based on your query: "${agentResponse.substring(0, 100)}..."`,
                videoPath: `/videos/${videoFile}`,
                startTime: startTime,
                endTime: startTime + 60,
                sourceId: videoFile,
                relevanceScore: 0.5 - (i * 0.1) // Decreasing relevance for fallbacks
            });
        }
        
        return clips;
    }

    filterAndImproveClips(clips, agentResponse) {
        console.log(`\n=== FILTERING ${clips.length} CLIPS ===`);
        
        // Log all clips before filtering
        clips.forEach((clip, i) => {
            console.log(`Clip ${i}: "${clip.title}" from ${clip.videoPath} (${clip.startTime}-${clip.endTime}) score: ${clip.relevanceScore}`);
        });
        
        // Remove duplicates based on similar time ranges within the same video
        const filtered = [];
        
        for (const clip of clips) {
            const isDuplicate = filtered.some(existing => 
                existing.videoPath === clip.videoPath &&
                Math.abs(existing.startTime - clip.startTime) < 10 &&
                Math.abs(existing.endTime - clip.endTime) < 10
            );
            
            if (!isDuplicate) {
                filtered.push(clip);
            } else {
                console.log(`Removing duplicate: "${clip.title}"`);
            }
        }
        
        console.log(`After deduplication: ${filtered.length} clips`);
        
        // Ensure video diversity - try to include clips from different videos
        const clipsByVideo = {};
        for (const clip of filtered) {
            if (!clipsByVideo[clip.videoPath]) {
                clipsByVideo[clip.videoPath] = [];
            }
            clipsByVideo[clip.videoPath].push(clip);
        }
        
        console.log('Clips by video after filtering:');
        Object.keys(clipsByVideo).forEach(videoPath => {
            console.log(`  ${videoPath}: ${clipsByVideo[videoPath].length} clips`);
        });
        
        // Select clips ensuring video diversity
        const finalClips = [];
        const maxClipsPerVideo = 2;
        const totalMaxClips = 4;
        
        // Sort videos by number of clips (ascending) to give preference to videos with fewer clips
        const sortedVideos = Object.keys(clipsByVideo).sort((a, b) => 
            clipsByVideo[a].length - clipsByVideo[b].length
        );
        
        for (const videoPath of sortedVideos) {
            const videoClips = clipsByVideo[videoPath]
                .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
                .slice(0, maxClipsPerVideo);
            
            for (const clip of videoClips) {
                if (finalClips.length < totalMaxClips) {
                    finalClips.push(clip);
                    console.log(`Selected: "${clip.title}" from ${clip.videoPath}`);
                }
            }
        }
        
        // Sort final clips by relevance
        const result = finalClips.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
        
        console.log(`\nFinal selection: ${result.length} clips`);
        result.forEach((clip, i) => {
            console.log(`  ${i+1}. "${clip.title}" from ${clip.videoPath} (score: ${clip.relevanceScore})`);
        });
        
        return result;
    }

    getVideoDisplayName(filename) {
        return filename
            .replace(/\.(mp4|avi|mov|mkv|webm)$/i, '')
            .replace(/[-_]/g, ' ')
            .replace(/\d{8}_\d{6}/, '')
            .replace(/Meeting\s+(Recording|Transcript)/i, '')
            .trim();
    }

    parseTimestampsFromContent(content) {
        const timestamps = [];
        try {
            // Clean up escaped characters
            const cleanContent = content
                .replace(/\\r/g, '')
                .replace(/\\\"/g, '"')
                .replace(/\\\\/g, '\\');
            
            // Extract timestamps with regex
            const regex = /"text":\s*"([^"]+)",\s*"start":\s*"([^"]+)",\s*"end":\s*"([^"]+)"/g;
            let match;
            
            while ((match = regex.exec(cleanContent)) !== null) {
                const [_, text, start, end] = match;
                timestamps.push({
                    text: text.trim(),
                    start: this.timeToSeconds(start),
                    end: this.timeToSeconds(end)
                });
            }
            
            if (timestamps.length === 0) {
                console.log('No timestamps found in content');
                console.log('Content preview:', cleanContent.substring(0, 200));
            } else {
                console.log(`Found ${timestamps.length} timestamps`);
            }
            
        } catch (error) {
            console.error('Error parsing timestamps:', error);
        }
        
        return timestamps;
    }

    timeToSeconds(timeStr) {
        const parts = timeStr.split(':');
        const seconds = parseFloat(parts.pop());  // Get seconds from end
        const minutes = parseInt(parts.pop() || '0');  // Get minutes
        const hours = parseInt(parts.pop() || '0');  // Get hours if they exist
        return (hours * 3600) + (minutes * 60) + seconds;
    }
    
    async findAllVideoFiles() {
        try {
            const files = await fs.readdir(this.videosDirectory);
            return files.filter(file => 
                this.videoExtensions.some(ext => file.toLowerCase().endsWith(ext))
            );
        } catch (error) {
            console.error('Error finding video files:', error);
            return [];
        }
    }
    
    async findVideoFile(s3Uri) {
        try {
            if (!s3Uri) return null;
            
            const files = await this.findAllVideoFiles();
            if (files.length === 0) return null;
            
            console.log('Looking for video file matching S3 URI:', s3Uri);
            console.log('Available video files:', files);
            
            // Extract timestamp from S3 URI (e.g., "20250320_213116")
            const timestampMatch = s3Uri.match(/(\d{8}_\d{6})/);
            const timestamp = timestampMatch ? timestampMatch[1] : null;
            
            console.log('Extracted timestamp from S3 URI:', timestamp);
            
            if (timestamp) {
                // First try to find exact timestamp match
                const exactMatch = files.find(file => file.includes(timestamp));
                if (exactMatch) {
                    console.log('Found exact timestamp match:', exactMatch);
                    return exactMatch;
                }
                
                console.log('No exact timestamp match found');
            }
            
            // Extract base name from S3 URI for fallback matching
            const s3FileName = s3Uri.split('/').pop();
            const baseName = s3FileName
                .replace('_sentences.json', '')
                .replace('.json', '')
                .replace(/[-_]\d{8}_\d{6}-Meeting\s+(Recording|Transcript)/i, '')
                .toLowerCase()
                .trim();
            
            console.log('Extracted base name for fallback:', baseName);
            
            // Try partial name matching
            if (baseName) {
                const partialMatch = files.find(file => {
                    const fileBaseName = file
                        .replace(/\.(mp4|avi|mov|mkv|webm)$/i, '')
                        .replace(/[-_]\d{8}_\d{6}-Meeting\s+(Recording|Transcript)/i, '')
                        .toLowerCase()
                        .trim();
                    
                    console.log(`Comparing "${baseName}" with "${fileBaseName}"`);
                    return fileBaseName.includes(baseName) || baseName.includes(fileBaseName);
                });
                
                if (partialMatch) {
                    console.log('Found partial match:', partialMatch);
                    return partialMatch;
                }
            }
            
            // If no match found, distribute across available videos
            // Use a hash of the S3 URI to consistently assign the same URI to the same video
            const hash = this.simpleHash(s3Uri);
            const videoIndex = hash % files.length;
            const fallbackVideo = files[videoIndex];
            
            console.log(`No match found, using fallback video at index ${videoIndex}:`, fallbackVideo);
            return fallbackVideo;
            
        } catch (error) {
            console.error('Error finding video file:', error);
            return null;
        }
    }
    
    // Simple hash function to consistently distribute S3 URIs across videos
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }
}

// Initialize video clip extractor
const clipExtractor = new VideoClipExtractor();

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        // Invoke AWS Bedrock Agent
        const command = new InvokeAgentCommand({
            agentId: process.env.AGENT_ID,
            agentAliasId: process.env.AGENT_ALIAS_ID,
            sessionId: generateSessionId(),
            inputText: message,
            enableTrace: true,
        });
        
        // Send request to AWS
        const response = await bedrockClient.send(command);
        
        // Process the response
        let agentResponse = '';
        let sources = [];
        let agentTrace = null;
        let traceEvents = [];
        
        if (response.completion) {
            for await (const event of response.completion) {
                if (event.chunk && event.chunk.bytes) {
                    agentResponse += new TextDecoder().decode(event.chunk.bytes);
                }
                
                if (event.trace) {
                    traceEvents.push(event.trace);
                    logger.log('=== TRACE DEBUG ===');
                    logger.log('Agent Trace:', JSON.stringify(event.trace, null, 2));
                    
                    // Get references from the agent trace
                    const references = event.trace?.orchestrationTrace?.observation?.knowledgeBaseLookupOutput?.retrievedReferences || [];
                    logger.log('References:', references.length);
                    
                    if (references.length > 0) {
                        sources = references.map(ref => ({
                            id: ref.metadata?.sourceId || ref.location?.s3Location?.uri || 'unknown',
                            title: ref.metadata?.title || ref.metadata?.source || ref.location?.s3Location?.uri || 'Unknown Source',
                            content: ref.content?.text || '',
                            score: ref.score || 0
                        }));
                    }
                }
            }
        }
        
        // Extract relevant video clips
        agentTrace = {
            all_events: traceEvents
        };
        const videoClips = await clipExtractor.extractRelevantClips(agentTrace, sources, agentResponse);
        
        res.json({
            response: agentResponse,
            sources: sources,
            videoClips: videoClips,
            sessionId: command.input.sessionId
        });
        
    } catch (error) {
        logger.error('Error processing chat request:', error);
        res.status(500).json({ 
            error: 'An error occurred while processing your request.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Generate a unique session ID
function generateSessionId() {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(port, () => {
    logger.log(`Server running on http://localhost:${port}`);
    logger.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.log(`AWS Region: ${process.env.AWS_REGION || 'us-east-1'}`);
    logger.log(`Agent ID: ${process.env.AGENT_ID}`);
    logger.log(`Agent Alias ID: ${process.env.AGENT_ALIAS_ID}`);
});
