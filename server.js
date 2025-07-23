const express = require('express');
const path = require('path');
const cors = require('cors');
const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const fs = require('fs').promises;
const util = require('util');
const fsSync = require('fs');

// INDUSTRY STANDARD: Use AWS Bedrock for LLM calls
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

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
    },
    
    perf: function(d) {
        const message = typeof d === 'object' ? JSON.stringify(d, null, 2) : d;
        this.file.write('PERF: ' + util.format(message) + '\n');
        this.stdout.write('⚡ PERF: ' + util.format(message) + '\n');
    }
};

// INDUSTRY STANDARD: Enhanced clip configuration
const CLIP_CONFIG = {
    MIN_RELEVANCE_SCORE: 0.1,    // Semantic similarity threshold
    MIN_LLM_SCORE: 0.6,          // LLM quality threshold
    MIN_DURATION: 8,             // Minimum clip length
    MAX_DURATION: 90,            // Maximum clip length
    OPTIMAL_DURATION: 45,        // Target clip length
    MAX_CLIPS: 4,                // Max clips to return
    CONTEXT_BUFFER: 3,           // Seconds before/after
    // Use AWS Bedrock Claude instead of external APIs
    CLAUDE_MODEL_ID: 'arn:aws:bedrock:us-east-1:225989333617:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0' // AWS native embedding model
};

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// AWS Configuration
let bedrockClient;
let bedrockRuntimeClient;

try {
    const awsConfig = {
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            sessionToken: process.env.AWS_SESSION_TOKEN,
        },
    };
    
    bedrockClient = new BedrockAgentRuntimeClient(awsConfig);
    bedrockRuntimeClient = new BedrockRuntimeClient(awsConfig);
    
    logger.log('AWS Bedrock clients initialized successfully');
    logger.log('Using region:', process.env.AWS_REGION || 'us-east-1');
} catch (error) {
    logger.error('Failed to initialize AWS clients:', error);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/videos', express.static(path.join(__dirname, 'videos')));

// INDUSTRY STANDARD: Video clip extractor with AWS Bedrock LLM + embeddings
class IndustryStandardVideoExtractor {
    constructor(videosDirectory = './videos', bedrockRuntimeClient = null) {
        this.videosDirectory = videosDirectory;
        this.videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm'];
        this.bedrockRuntimeClient = bedrockRuntimeClient;
        this.embeddingCache = new Map(); // Cache to reduce API calls
    }

    async extractRelevantClips(agentTrace, sources, agentResponse = '', userQuery = '') {
    const totalStartTime = Date.now();
    try {
        logger.log('🔍 Starting optimized clip extraction...');
        logger.log(`📋 Query: "${userQuery.substring(0, 50)}${userQuery.length > 50 ? '...' : ''}"`);
        
        let clips = [];
        
        // Phase 1: Extract references (fast)
        const refStartTime = Date.now();
        if (agentTrace) {
            const references = this.extractStructuredReferences(agentTrace);
            const refTime = ((Date.now() - refStartTime) / 1000).toFixed(1);
            logger.log(`📄 Reference extraction: ${refTime}s`);
            
            // Phase 2: Create semantic clips (optimized with parallel processing)
            const semanticStartTime = Date.now();
            clips = await this.createSemanticClips(references, userQuery, agentResponse);
            const semanticTime = ((Date.now() - semanticStartTime) / 1000).toFixed(1);
            logger.log(`🧠 Semantic processing: ${semanticTime}s`);
        }
        
        // Phase 3: LLM optimization (optimized with batching)
        if (clips.length > 0 && this.bedrockRuntimeClient) {
            const llmStartTime = Date.now();
            clips = await this.optimizeClipsWithLLM(clips, userQuery, agentResponse);
            const llmTime = ((Date.now() - llmStartTime) / 1000).toFixed(1);
            logger.log(`🤖 LLM optimization: ${llmTime}s`);
        }
        
        // Phase 4: Fallback if needed
        if (clips.length === 0) {
            logger.log('⚠️  No clips found, creating fallbacks...');
            clips = await this.createIntelligentFallbacks(userQuery, agentResponse);
        }
        
        const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1);
        logger.log(`✅ COMPLETE: Generated ${clips.length} clips in ${totalTime}s`);
        logger.log(`📊 Performance breakdown saved to debug.txt`);
        
        return clips;
        
    } catch (error) {
        const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1);
        logger.error(`❌ Extraction failed after ${totalTime}s:`, error.message);
        return await this.fallbackExtraction(agentTrace, sources, agentResponse);
    }
}

    // INDUSTRY STANDARD: Structured reference extraction (replaces regex)
    extractStructuredReferences(trace) {
        const references = [];
        
        try {
            if (Array.isArray(trace.all_events)) {
                for (const event of trace.all_events) {
                    // Direct AWS SDK access - no manual parsing
                    const observation = event.trace?.orchestrationTrace?.observation;
                    const kbRefs = observation?.knowledgeBaseLookupOutput?.retrievedReferences;
                    
                    if (kbRefs && Array.isArray(kbRefs)) {
                        references.push(...kbRefs.map(ref => ({
                            ...ref,
                            parsedTimestamps: null // Will be parsed later
                        })));
                    }
                }
            }
            
            logger.log(`Extracted ${references.length} structured references`);
            return references;
            
        } catch (error) {
            logger.error('Structured reference extraction failed:', error);
            return [];
        }
    }

    // INDUSTRY STANDARD: Robust JSON parsing (replaces regex completely)
    async parseTimestampsRobustly(content) {
        try {
            // Method 1: Try direct JSON parsing
            const timestamps = this.parseDirectJSON(content);
            if (timestamps.length > 0) {
                logger.log(`Direct JSON parsing successful: ${timestamps.length} timestamps`);
                return timestamps;
            }
            
            // Method 2: Stream parsing for malformed JSON
            const streamParsed = this.parseJSONStream(content);
            if (streamParsed.length > 0) {
                logger.log(`Stream parsing successful: ${streamParsed.length} timestamps`);
                return streamParsed;
            }
            
            // Method 3: Last resort - improved regex with validation
            return this.parseWithValidation(content);
            
        } catch (error) {
            logger.error('All parsing methods failed:', error);
            return [];
        }
    }

    parseDirectJSON(content) {
        const timestamps = [];
        try {
            // Clean the content
            const cleaned = content
                .replace(/\\"/g, '"')
                .replace(/\\r\\n/g, '')
                .replace(/\\\\/g, '\\');
            
            // Try to find JSON arrays or objects
            const jsonMatches = cleaned.match(/\[.*?\]|\{.*?\}/gs);
            
            if (jsonMatches) {
                for (const match of jsonMatches) {
                    try {
                        const parsed = JSON.parse(match);
                        this.extractTimestampsFromObject(parsed, timestamps);
                    } catch (e) {
                        continue; // Skip invalid JSON
                    }
                }
            }
            
        } catch (error) {
            logger.error('Direct JSON parsing error:', error);
        }
        
        return timestamps.sort((a, b) => a.start - b.start);
    }

    parseJSONStream(content) {
        const timestamps = [];
        const lines = content.split(/\r?\n/);
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || (!trimmed.includes('"text"') && !trimmed.includes('"start"'))) {
                continue;
            }
            
            try {
                // Try to parse line as JSON
                const cleaned = trimmed.replace(/,$/, ''); // Remove trailing comma
                const obj = JSON.parse(cleaned);
                
                if (obj.text && obj.start && obj.end) {
                    timestamps.push({
                        text: obj.text.trim(),
                        start: this.timeToSeconds(obj.start),
                        end: this.timeToSeconds(obj.end),
                        confidence: obj.confidence || 1.0
                    });
                }
            } catch (e) {
                // Try to extract from partial JSON
                this.extractFromPartialLine(trimmed, timestamps);
            }
        }
        
        return timestamps.sort((a, b) => a.start - b.start);
    }

    extractTimestampsFromObject(obj, timestamps = []) {
        if (Array.isArray(obj)) {
            obj.forEach(item => this.extractTimestampsFromObject(item, timestamps));
        } else if (obj && typeof obj === 'object') {
            if (obj.text && obj.start && obj.end) {
                timestamps.push({
                    text: obj.text.trim(),
                    start: this.timeToSeconds(obj.start),
                    end: this.timeToSeconds(obj.end),
                    confidence: obj.confidence || 1.0
                });
            } else {
                Object.values(obj).forEach(value => 
                    this.extractTimestampsFromObject(value, timestamps)
                );
            }
        }
        return timestamps;
    }

    // INDUSTRY STANDARD: Semantic clip creation with embeddings
async createSemanticClips(references, userQuery, agentResponse) {
    const startTime = Date.now();
    logger.log(`🚀 Processing ${references.length} references in parallel...`);
    
    // OPTIMIZATION: Process all references in parallel instead of sequentially
    const clipPromises = references.map(async (ref, index) => {
        try {
            const content = ref.content?.text;
            const s3Uri = ref.location?.s3Location?.uri;
            
            if (!content || !s3Uri) return [];
            
            logger.log(`📄 Processing reference ${index + 1}/${references.length}`);
            
            // Parse timestamps (fast operation)
            const timestamps = await this.parseTimestampsRobustly(content);
            if (timestamps.length === 0) return [];
            
            // Find video file (fast operation)
            const videoFile = await this.findVideoFile(s3Uri);
            if (!videoFile) return [];
            
            // Create semantic segments (involves embeddings)
            const segments = await this.createSemanticSegments(timestamps, userQuery);
            
            // OPTIMIZATION: Process all segments for this reference in parallel
            const segmentPromises = segments.map(segment => 
                this.enhanceClipWithLLM(segment, videoFile, userQuery, agentResponse)
            );
            
            const segmentClips = await Promise.all(segmentPromises);
            const validClips = segmentClips.filter(Boolean);
            
            logger.log(`✅ Reference ${index + 1} produced ${validClips.length} clips`);
            return validClips;
            
        } catch (error) {
            logger.error(`❌ Error processing reference ${index + 1}:`, error.message);
            return [];
        }
    });
    
    // Wait for all references to complete in parallel
    const allClipArrays = await Promise.all(clipPromises);
    const allClips = allClipArrays.flat();
    
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.log(`⚡ Parallel processing completed in ${processingTime}s - Generated ${allClips.length} clips`);
    
    return allClips;
}

    // INDUSTRY STANDARD: Semantic segmentation with AWS embeddings
async createSemanticSegments(timestamps, query) {
    if (!this.bedrockRuntimeClient) {
        return this.createFallbackSegments(timestamps);
    }
    
    try {
        // Get query embedding (single call)
        const queryEmbedding = await this.getAWSEmbedding(query);
        if (!queryEmbedding) {
            return this.createFallbackSegments(timestamps);
        }
        
        // Create sliding windows
        const windows = this.createSlidingWindows(timestamps, 45);
        logger.log(`🔍 Analyzing ${windows.length} windows in parallel...`);
        
        // OPTIMIZATION: Process all windows in parallel instead of sequentially
        const windowPromises = windows.map(async (window, index) => {
            try {
                const text = window.map(t => t.text).join(' ');
                const embedding = await this.getAWSEmbedding(text);
                
                if (embedding) {
                    const similarity = this.cosineSimilarity(queryEmbedding, embedding);
                    
                    if (similarity > CLIP_CONFIG.MIN_RELEVANCE_SCORE) {
                        return {
                            timestamps: window,
                            similarity: similarity,
                            text: text,
                            startTime: window[0].start,
                            endTime: window[window.length - 1].end
                        };
                    }
                }
                return null;
            } catch (error) {
                logger.error(`Error processing window ${index + 1}:`, error.message);
                return null;
            }
        });
        
        // Wait for all windows to complete
        const scoredWindows = (await Promise.all(windowPromises)).filter(Boolean);
        
        logger.log(`📊 Found ${scoredWindows.length} relevant segments`);
        
        return scoredWindows
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 6);
            
    } catch (error) {
        logger.error('Semantic segmentation failed:', error.message);
        return this.createFallbackSegments(timestamps);
    }
}

    // INDUSTRY STANDARD: LLM-enhanced clip optimization using AWS Bedrock Claude
    async enhanceClipWithLLM(segment, videoFile, userQuery, agentResponse) {
        if (!this.bedrockRuntimeClient) {
            return this.createBasicClip(segment, videoFile);
        }
        
        try {
            const transcript = segment.text;
            const duration = segment.endTime - segment.startTime;
            
            const prompt = `You are an expert video clip curator for training systems. Analyze this transcript segment.

USER QUERY: "${userQuery}"
CONTEXT: "${agentResponse.substring(0, 300)}..."
TRANSCRIPT: "${transcript}"
DURATION: ${Math.round(duration)} seconds

Evaluate this segment and respond with JSON only:
{
  "relevance_score": number (0.0-1.0),
  "quality_score": number (0.0-1.0), 
  "title": "compelling 6-8 word title",
  "description": "2-sentence description explaining value",
  "key_topics": ["topic1", "topic2", "topic3"],
  "optimal_start_offset": number (seconds to trim from start),
  "optimal_end_offset": number (seconds to trim from end),
  "include_clip": boolean,
  "reasoning": "brief explanation"
}

Only include clips that directly answer the query or provide essential context.`;

            const analysis = await this.callClaudeViaAWS(prompt);
            
            if (analysis && analysis.include_clip && analysis.relevance_score > CLIP_CONFIG.MIN_LLM_SCORE) {
                const optimizedStart = Math.max(0, segment.startTime + (analysis.optimal_start_offset || 0));
                const optimizedEnd = segment.endTime - (analysis.optimal_end_offset || 0);
                
                return {
                    title: analysis.title || this.generateFallbackTitle(transcript),
                    description: analysis.description || this.generateFallbackDescription(transcript),
                    videoPath: `/videos/${videoFile}`,
                    startTime: optimizedStart - CLIP_CONFIG.CONTEXT_BUFFER,
                    endTime: optimizedEnd + CLIP_CONFIG.CONTEXT_BUFFER,
                    transcript: transcript,
                    relevanceScore: analysis.relevance_score,
                    qualityScore: analysis.quality_score,
                    keyTopics: analysis.key_topics || [],
                    sourceId: videoFile,
                    aiGenerated: true,
                    reasoning: analysis.reasoning
                };
            }
            
            return null;
            
        } catch (error) {
            logger.error('LLM enhancement failed:', error);
            return this.createBasicClip(segment, videoFile);
        }
    }

    // INDUSTRY STANDARD: LLM ranking and final selection using AWS Bedrock Claude
async optimizeClipsWithLLM(clips, userQuery, agentResponse) {
    if (!this.bedrockRuntimeClient || clips.length === 0) {
        return clips.slice(0, CLIP_CONFIG.MAX_CLIPS);
    }
    
    const startTime = Date.now();
    logger.log(`🤖 Optimizing ${clips.length} clips with Claude...`);
    
    try {
        // OPTIMIZATION: If we have many clips, batch them intelligently
        if (clips.length > 8) {
            // For large numbers of clips, pre-filter by relevance before LLM analysis
            clips = clips
                .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
                .slice(0, 8); // Only analyze top 8 clips with LLM
            
            logger.log(`📉 Pre-filtered to top ${clips.length} clips by relevance`);
        }
        
        const clipsForAnalysis = clips.map((clip, index) => ({
            index,
            title: clip.title,
            description: clip.description,
            duration: Math.round(clip.endTime - clip.startTime),
            relevance_score: clip.relevanceScore,
            key_topics: clip.keyTopics,
            video_source: clip.sourceId
        }));
        
        const prompt = `You are a video curation expert. Select and rank the best ${CLIP_CONFIG.MAX_CLIPS} clips.

USER QUERY: "${userQuery}"
CONTEXT: "${agentResponse.substring(0, 400)}..."

CANDIDATE CLIPS:
${JSON.stringify(clipsForAnalysis, null, 2)}

Select the best clips that:
1. Directly answer the user's question
2. Provide diverse perspectives (prefer clips from different videos)
3. Have optimal duration (30-60 seconds preferred)
4. Cover different aspects of the topic

Respond with JSON only:
{
  "selected_clips": [index1, index2, index3, index4],
  "reasoning": "brief explanation of selection criteria",
  "diversity_score": number (0.0-1.0)
}`;

        const result = await this.callClaudeViaAWS(prompt);
        
        if (result && result.selected_clips) {
            const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
            logger.log(`🎯 LLM optimization completed in ${processingTime}s`);
            logger.log(`📋 Selection reasoning: ${result.reasoning}`);
            logger.log(`🎨 Diversity score: ${(result.diversity_score * 100).toFixed(0)}%`);
            
            return result.selected_clips
                .slice(0, CLIP_CONFIG.MAX_CLIPS)
                .map(index => clips[index])
                .filter(Boolean);
        }
        
    } catch (error) {
        logger.error('LLM optimization failed:', error.message);
    }
    
    // Fallback to relevance-based selection
    logger.log('📉 Using fallback relevance-based selection');
    return clips
        .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
        .slice(0, CLIP_CONFIG.MAX_CLIPS);
}

    // INDUSTRY STANDARD: AWS Bedrock Claude API calling
    async callClaudeViaAWS(prompt) {
        try {
            const payload = {
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 8000,
                temperature: 0.1,
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ]
            };

            const command = new InvokeModelCommand({
                modelId: CLIP_CONFIG.CLAUDE_MODEL_ID,
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify(payload)
            });

            const response = await this.bedrockRuntimeClient.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            
            logger.log('Claude response received:', responseBody.usage);
            
            // Parse JSON from Claude's response
            const content = responseBody.content[0].text;
            return JSON.parse(content);
            
        } catch (error) {
            logger.error('AWS Bedrock Claude call failed:', error);
            return null;
        }
    }

    // INDUSTRY STANDARD: AWS Titan embedding utilities
async getAWSEmbedding(text) {
    const cacheKey = text.substring(0, 100);
    if (this.embeddingCache.has(cacheKey)) {
        return this.embeddingCache.get(cacheKey);
    }
    
    try {
        const payload = {
            inputText: text.substring(0, 8000),
            dimensions: 1024,
            normalize: true
        };

        const command = new InvokeModelCommand({
            modelId: CLIP_CONFIG.EMBEDDING_MODEL_ID,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(payload)
        });

        // OPTIMIZATION: Add timeout to prevent hanging requests
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Embedding timeout')), 10000)
        );
        
        const response = await Promise.race([
            this.bedrockRuntimeClient.send(command),
            timeoutPromise
        ]);
        
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const embedding = responseBody.embedding;
        
        // Cache the result
        this.embeddingCache.set(cacheKey, embedding);
        return embedding;
        
    } catch (error) {
        // Only log embedding errors once per session to reduce console spam
        if (!this.embeddingErrorLogged) {
            logger.error('Embedding generation failed - using fallback:', error.message);
            this.embeddingErrorLogged = true;
        }
        return null;
    }
}

    cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // Utility methods and fallbacks
    createSlidingWindows(timestamps, windowDuration = 45) {
        const windows = [];
        let currentWindow = [];
        let windowStart = null;
        
        for (const timestamp of timestamps) {
            if (!windowStart) {
                windowStart = timestamp.start;
                currentWindow = [timestamp];
            } else if (timestamp.start - windowStart <= windowDuration) {
                currentWindow.push(timestamp);
            } else {
                if (currentWindow.length > 2) { // Minimum window size
                    windows.push([...currentWindow]);
                }
                windowStart = timestamp.start;
                currentWindow = [timestamp];
            }
        }
        
        if (currentWindow.length > 2) {
            windows.push(currentWindow);
        }
        
        return windows;
    }

    createFallbackSegments(timestamps) {
        const segments = [];
        const windowSize = 30; // 30-second windows
        
        for (let i = 0; i < timestamps.length; i += 8) {
            const window = timestamps.slice(i, i + 8);
            if (window.length > 0) {
                segments.push({
                    timestamps: window,
                    similarity: 0.5,
                    text: window.map(t => t.text).join(' '),
                    startTime: window[0].start,
                    endTime: window[window.length - 1].end
                });
            }
        }
        
        return segments;
    }

    createBasicClip(segment, videoFile) {
        return {
            title: this.generateFallbackTitle(segment.text),
            description: this.generateFallbackDescription(segment.text),
            videoPath: `/videos/${videoFile}`,
            startTime: Math.max(0, segment.startTime - 2),
            endTime: segment.endTime + 2,
            transcript: segment.text,
            relevanceScore: segment.similarity || 0.5,
            sourceId: videoFile
        };
    }

    generateFallbackTitle(text) {
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
        if (sentences.length > 0) {
            const sentence = sentences[0].trim();
            return sentence.length > 60 ? sentence.substring(0, 60) + '...' : sentence;
        }
        return text.substring(0, 60) + '...';
    }

    generateFallbackDescription(text) {
        return text.length > 200 ? text.substring(0, 200) + '...' : text;
    }

    // Keep existing utility methods...
    async fallbackExtraction(agentTrace, sources, agentResponse) {
        // Your existing extraction logic as fallback
        logger.log('Using fallback extraction');
        // ... implement existing logic
        return [];
    }

    // Keep all your existing utility methods (timeToSeconds, findVideoFile, etc.)
    timeToSeconds(timeStr) {
        if (typeof timeStr === 'number') return timeStr;
        const parts = String(timeStr).split(':');
        const seconds = parseFloat(parts.pop() || 0);
        const minutes = parseInt(parts.pop() || '0');
        const hours = parseInt(parts.pop() || '0');
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    async findAllVideoFiles() {
        try {
            const files = await fs.readdir(this.videosDirectory);
            return files.filter(file => 
                this.videoExtensions.some(ext => file.toLowerCase().endsWith(ext))
            );
        } catch (error) {
            logger.error('Error finding video files:', error);
            return [];
        }
    }

    async findVideoFile(s3Uri) {
        // Keep your existing implementation - it works well
        try {
            if (!s3Uri) return null;
            
            const files = await this.findAllVideoFiles();
            if (files.length === 0) return null;
            
            // Extract timestamp from S3 URI
            const timestampMatch = s3Uri.match(/(\d{8}_\d{6})/);
            const timestamp = timestampMatch ? timestampMatch[1] : null;
            
            if (timestamp) {
                const exactMatch = files.find(file => file.includes(timestamp));
                if (exactMatch) return exactMatch;
            }
            
            // Fallback distribution
            const hash = this.simpleHash(s3Uri);
            return files[hash % files.length];
            
        } catch (error) {
            logger.error('Error finding video file:', error);
            return null;
        }
    }

    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }

    async createIntelligentFallbacks(userQuery, agentResponse) {
        const videoFiles = await this.findAllVideoFiles();
        const clips = [];
        
        for (let i = 0; i < Math.min(videoFiles.length, 2); i++) {
            const videoFile = videoFiles[i];
            clips.push({
                title: `Relevant Content: ${this.getVideoDisplayName(videoFile)}`,
                description: `This segment may contain information related to: "${userQuery}"`,
                videoPath: `/videos/${videoFile}`,
                startTime: i * 45,
                endTime: (i * 45) + 60,
                sourceId: videoFile,
                relevanceScore: 0.4 - (i * 0.1),
                isFallback: true
            });
        }
        
        return clips;
    }

    getVideoDisplayName(filename) {
        return filename
            .replace(/\.(mp4|avi|mov|mkv|webm)$/i, '')
            .replace(/[-_]/g, ' ')
            .replace(/\d{8}_\d{6}/, '')
            .replace(/Meeting\s+(Recording|Transcript)/i, '')
            .trim();
    }

    extractFromPartialLine(line, timestamps) {
        // Last resort parsing for malformed JSON
        const textMatch = line.match(/"text":\s*"([^"]+)"/);
        const startMatch = line.match(/"start":\s*"([^"]+)"/);
        const endMatch = line.match(/"end":\s*"([^"]+)"/);
        
        if (textMatch && startMatch && endMatch) {
            timestamps.push({
                text: textMatch[1].trim(),
                start: this.timeToSeconds(startMatch[1]),
                end: this.timeToSeconds(endMatch[1]),
                confidence: 0.7
            });
        }
    }

    parseWithValidation(content) {
        // Enhanced regex with validation
        const timestamps = [];
        const regex = /"text":\s*"([^"]+)",\s*"start":\s*"([^"]+)",\s*"end":\s*"([^"]+)"/g;
        let match;
        
        while ((match = regex.exec(content)) !== null) {
            const [_, text, start, end] = match;
            const startTime = this.timeToSeconds(start);
            const endTime = this.timeToSeconds(end);
            
            // Validate timestamp
            if (startTime >= 0 && endTime > startTime && text.trim().length > 0) {
                timestamps.push({
                    text: text.trim(),
                    start: startTime,
                    end: endTime,
                    confidence: 0.8
                });
            }
        }
        
        return timestamps.sort((a, b) => a.start - b.start);
    }
}

// Initialize with industry standard extractor using AWS Bedrock
const clipExtractor = new IndustryStandardVideoExtractor('./videos', bedrockRuntimeClient);

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/chat', async (req, res) => {
    const TOTAL_START_TIME = Date.now(); // ← ADD THIS
    
    try {
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        // Store original user query for semantic analysis
        const userQuery = message;
        logger.log(`🔍 TOTAL PROCESSING START: "${userQuery}"`); // ← ADD THIS
        
        // AWS Agent timing - ADD THIS BLOCK
        const agentStartTime = Date.now();
        const command = new InvokeAgentCommand({
            agentId: process.env.AGENT_ID,
            agentAliasId: process.env.AGENT_ALIAS_ID,
            sessionId: generateSessionId(),
            inputText: message,
            enableTrace: true,
        });
        
        // Send request to AWS
        const response = await bedrockClient.send(command);
        const agentTime = ((Date.now() - agentStartTime) / 1000).toFixed(1);
        logger.log(`🤖 AWS Agent query: ${agentTime}s`); // ← ADD THIS
        
        // Response processing timing - ADD THIS
        const processingStartTime = Date.now();
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
                    
                    // Get references from the agent trace
                    const references = event.trace?.orchestrationTrace?.observation?.knowledgeBaseLookupOutput?.retrievedReferences || [];
                    
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
        
        const processingTime = ((Date.now() - processingStartTime) / 1000).toFixed(1);
        logger.log(`📄 Response processing: ${processingTime}s`); // ← ADD THIS
        
        // Extract relevant video clips using industry standard methods
        agentTrace = {
            all_events: traceEvents
        };
        
        // INDUSTRY STANDARD: Pass user query for semantic analysis
        const videoClips = await clipExtractor.extractRelevantClips(
            agentTrace, 
            sources, 
            agentResponse, 
            userQuery  // ← This is key for semantic matching
        );
        
        const TOTAL_TIME = ((Date.now() - TOTAL_START_TIME) / 1000).toFixed(1);
        logger.log(`⏱️  TOTAL END-TO-END TIME: ${TOTAL_TIME}s`); // ← ADD THIS
        
        res.json({
            response: agentResponse,
            sources: sources,
            videoClips: videoClips,
            sessionId: command.input.sessionId,
            // INDUSTRY STANDARD: Include metadata for frontend optimization
            metadata: {
                clipCount: videoClips.length,
                hasLLMEnhancement: !!bedrockRuntimeClient,
                totalProcessingTime: TOTAL_TIME // ← ADD THIS
            }
        });
        
    } catch (error) {
        const TOTAL_TIME = ((Date.now() - TOTAL_START_TIME) / 1000).toFixed(1); // ← ADD THIS
        logger.error(`❌ Total request failed after ${TOTAL_TIME}s:`, error); // ← ADD THIS
        res.status(500).json({ 
            error: 'An error occurred while processing your request.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// INDUSTRY STANDARD: Add clip feedback endpoint for continuous improvement
app.post('/api/clip-feedback', async (req, res) => {
    try {
        const { clipId, feedback, rating, query } = req.body;
        
        // Log feedback for model improvement
        logger.log('CLIP FEEDBACK:', {
            clipId,
            feedback,
            rating,
            query,
            timestamp: new Date().toISOString()
        });
        
        // TODO: Store in database for model retraining
        
        res.json({ success: true });
    } catch (error) {
        logger.error('Error processing feedback:', error);
        res.status(500).json({ error: 'Failed to process feedback' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        llmEnabled: !!bedrockRuntimeClient,
        embeddingCacheSize: clipExtractor.embeddingCache.size
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
    logger.log(`LLM Client: AWS Bedrock Claude 3.5 Sonnet`);
    logger.log(`Embedding Model: AWS Titan v2`);
    logger.log(`Embedding Cache: Enabled`);
});