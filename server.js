const express = require('express');
const path = require('path');
const cors = require('cors');
const { BedrockAgentRuntimeClient, InvokeAgentCommand, RetrieveAndGenerateCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const fs = require('fs').promises;
const util = require('util');
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const puppeteer = require('puppeteer');

// Configure ffmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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

// INDUSTRY STANDARD: Enhanced clip configuration with more permissive settings
const CLIP_CONFIG = {
    MIN_RELEVANCE_SCORE: 0.05,   // LOWERED from 0.1 - more permissive
    MIN_LLM_SCORE: 0.4,          // LOWERED from 0.6 - more permissive  
    MIN_DURATION: 5,             // LOWERED from 8 - shorter clips ok
    MAX_DURATION: 90,            // Maximum clip length
    OPTIMAL_DURATION: 45,        // Target clip length
    MAX_CLIPS: 4,                // Max clips to return
    CONTEXT_BUFFER: 3,           // Seconds before/after
    // Use AWS Bedrock Claude instead of external APIs
    CLAUDE_MODEL_ID: 'arn:aws:bedrock:us-east-1:225989333617:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    EMBEDDING_MODEL_ID: 'cohere.embed-multilingual-v3' // AWS native embedding model
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
app.use('/frames', express.static(path.join(__dirname, 'frames')));

// Frame Extractor Class
class FrameExtractor {
    constructor() {
        this.frameCache = new Map();
        this.extractionQueue = new Map();
    }

    async getVideoDuration(videoPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(metadata.format.duration);
            });
        });
    }

     async extractFrame(videoPath, timestamp, retryCount = 0) {
        const maxRetries = 3;
        const cacheKey = `${path.basename(videoPath)}-${timestamp}`;
        
        // Check cache first
        if (this.frameCache.has(cacheKey)) {
            const cached = this.frameCache.get(cacheKey);
            if (cached.error) {
                logger.log(`Using cached error state for ${cacheKey}`);
                return null;
            }
            return cached.path;
        }
        
        // Check if extraction is already in progress
        if (this.extractionQueue.has(cacheKey)) {
            return this.extractionQueue.get(cacheKey);
        }
        
        try {
            // FIXED: Normalize path for Windows
            const normalizedPath = path.resolve(videoPath);
            
            // Validate video path
            const videoExists = await fs.access(normalizedPath).then(() => true).catch(() => false);
            if (!videoExists) {
                logger.error(`Video file not found: ${normalizedPath}`);
                this.frameCache.set(cacheKey, { error: 'video_not_found' });
                return null;
            }
            
            // Get video duration with validation
            let duration;
            try {
                duration = await this.getVideoDuration(normalizedPath);
                if (!duration || duration <= 0) {
                    throw new Error('Invalid duration');
                }
            } catch (error) {
                logger.error(`Failed to get video duration: ${error.message}`);
                this.frameCache.set(cacheKey, { error: 'duration_failed' });
                return null;
            }
            
            // FIXED: Smart timestamp validation and adjustment
            let adjustedTimestamp = timestamp;
            if (timestamp >= duration) {
                adjustedTimestamp = Math.max(0, duration - 5); // 5 seconds before end
                logger.log(`Timestamp ${timestamp}s beyond duration ${duration}s, adjusted to ${adjustedTimestamp}s`);
            }
            
            // Ensure minimum timestamp
            adjustedTimestamp = Math.max(1, adjustedTimestamp); // Never extract at 0s
            
            // Create output directory if it doesn't exist
            const framesDir = path.join(__dirname, 'frames');
            await fs.mkdir(framesDir, { recursive: true });
            
            const outputPath = path.join(framesDir, `${cacheKey.replace(/[^a-zA-Z0-9.-]/g, '_')}.jpg`);
            
            // FIXED: Multiple extraction strategies with better fallbacks
            const extractionStrategies = [
                // Strategy 1: Single frame at adjusted timestamp
                { timestamps: [adjustedTimestamp], name: 'primary' },
                // Strategy 2: Multiple attempts around the timestamp
                { 
                    timestamps: [
                        Math.max(1, adjustedTimestamp - 1),
                        adjustedTimestamp,
                        Math.min(duration - 1, adjustedTimestamp + 1)
                    ].filter(t => t > 0 && t < duration), 
                    name: 'range' 
                },
                // Strategy 3: Safe timestamps
                { 
                    timestamps: [
                        Math.max(1, duration * 0.1), // 10% into video
                        Math.max(1, duration * 0.3), // 30% into video
                        Math.max(1, duration * 0.5)  // 50% into video
                    ].filter(t => t > 0 && t < duration), 
                    name: 'safe' 
                }
            ];
            
            // Create promise for frame extraction
            const extractionPromise = new Promise(async (resolve, reject) => {
                let lastError = null;
                
                for (const strategy of extractionStrategies) {
                    try {
                        logger.log(`Trying ${strategy.name} strategy with timestamps: ${strategy.timestamps.join(', ')}`);
                        
                        await new Promise((strategyResolve, strategyReject) => {
                            const timeout = setTimeout(() => {
                                strategyReject(new Error('Strategy timeout'));
                            }, 15000); // Reduced timeout per strategy
                            
                            let ffmpegCommand = ffmpeg(normalizedPath);
                            
                            // FIXED: More conservative ffmpeg options for better compatibility
                            ffmpegCommand
                                .seekInput(strategy.timestamps[0]) // Seek to first timestamp
                                .outputOptions([
                                    '-vframes 1',           // Extract only 1 frame
                                    '-q:v 2',              // High quality
                                    '-vf scale=640:360',   // Consistent size
                                    '-y'                   // Overwrite existing files
                                ])
                                .output(outputPath)
                                .on('end', () => {
                                    clearTimeout(timeout);
                                    strategyResolve();
                                })
                                .on('error', (err) => {
                                    clearTimeout(timeout);
                                    strategyReject(err);
                                })
                                .run();
                        });
                        
                        // Verify the file was created and is valid
                        const fileExists = await fs.access(outputPath).then(() => true).catch(() => false);
                        if (fileExists) {
                            const stats = await fs.stat(outputPath);
                            if (stats.size > 1000) { // Minimum 1KB file size
                                logger.log(`✅ Frame extracted successfully using ${strategy.name} strategy`);
                                this.frameCache.set(cacheKey, { path: outputPath });
                                this.extractionQueue.delete(cacheKey);
                                resolve(outputPath);
                                return;
                            } else {
                                logger.log(`File too small (${stats.size} bytes), trying next strategy`);
                                await fs.unlink(outputPath).catch(() => {}); // Clean up small file
                            }
                        }
                        
                    } catch (error) {
                        lastError = error;
                        logger.log(`${strategy.name} strategy failed: ${error.message}`);
                        continue;
                    }
                }
                
                // All strategies failed
                this.extractionQueue.delete(cacheKey);
                reject(lastError || new Error('All extraction strategies failed'));
            });
            
            // Store promise in queue
            this.extractionQueue.set(cacheKey, extractionPromise);
            
            return await extractionPromise;
            
        } catch (error) {
            logger.error(`Frame extraction failed for ${videoPath} at ${timestamp}:`, error.message);
            
            // Retry with exponential backoff
            if (retryCount < maxRetries) {
                const delay = Math.pow(2, retryCount) * 1000;
                logger.log(`Retrying frame extraction in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.extractFrame(videoPath, timestamp, retryCount + 1);
            }
            
            // Cache the error state
            this.frameCache.set(cacheKey, { error: error.message });
            return null;
        }
    }

     async cleanCache() {
        const maxCacheAge = 24 * 60 * 60 * 1000; // 24 hours
        const now = Date.now();
        
        for (const [key, frameData] of this.frameCache.entries()) {
            if (frameData.path) {
                try {
                    const stats = await fs.stat(frameData.path);
                    if (now - stats.mtime.getTime() > maxCacheAge) {
                        await fs.unlink(frameData.path);
                        this.frameCache.delete(key);
                    }
                } catch (error) {
                    // File might not exist anymore
                    this.frameCache.delete(key);
                }
            }
        }
    }
}

// Initialize frame extractor
const frameExtractor = new FrameExtractor();

// Clean cache periodically
setInterval(() => frameExtractor.cleanCache(), 60 * 60 * 1000); // Every hour

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
                const startTime = this.timeToSeconds(obj.start);
                const endTime = this.timeToSeconds(obj.end);
                
                // FIXED: Validate timestamps before adding
                if (startTime >= 0 && endTime > startTime && obj.text.trim().length > 0) {
                    timestamps.push({
                        text: obj.text.trim(),
                        start: startTime,
                        end: endTime,
                        confidence: obj.confidence || 1.0
                    });
                } else {
                    logger.error(`Invalid timestamp found: start=${startTime}, end=${endTime}, text="${obj.text}"`);
                }
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
            logger.log('No Bedrock client - creating basic clip');
            return this.createBasicClip(segment, videoFile);
        }
        
        try {
            const transcript = segment.text;
            const duration = segment.endTime - segment.startTime;
            
            logger.log(`🤖 Analyzing segment: duration=${duration}s, transcript="${transcript.substring(0, 50)}..."`);
            
            // FIXED: Validate segment timing before processing
            if (duration <= 0) {
                logger.error(`Invalid segment duration: ${duration}s (start: ${segment.startTime}, end: ${segment.endTime})`);
                return null;
            }
            
            const prompt = `You are an expert video clip curator for training systems. Analyze this transcript segment.

USER QUERY: "${userQuery}"
CONTEXT: "${agentResponse.substring(0, 300)}..."
TRANSCRIPT: "${transcript}"
DURATION: ${Math.round(duration)} seconds
START_TIME: ${segment.startTime} seconds
END_TIME: ${segment.endTime} seconds

Evaluate this segment and respond with JSON only:
{
  "relevance_score": number (0.0-1.0),
  "quality_score": number (0.0-1.0), 
  "title": "compelling 6-8 word title",
  "description": "2-sentence description explaining value",
  "key_topics": ["topic1", "topic2", "topic3"],
  "optimal_start_offset": number (seconds to trim from start, must be >= 0),
  "optimal_end_offset": number (seconds to trim from end, must be >= 0),
  "include_clip": boolean,
  "reasoning": "brief explanation"
}

IMPORTANT: Be generous with inclusion. Include clips with relevance_score >= 0.4. Focus on helpfulness over perfect relevance.`;

            const analysis = await this.callClaudeViaAWS(prompt);
            
            if (!analysis) {
                logger.error('Claude analysis returned null');
                return null;
            }
            
            logger.log(`🤖 Claude analysis: include=${analysis.include_clip}, relevance=${analysis.relevance_score}, reasoning="${analysis.reasoning}"`);
            
            // MORE PERMISSIVE: Lower threshold and better fallback
            if (analysis.include_clip && analysis.relevance_score >= CLIP_CONFIG.MIN_LLM_SCORE) {
                // FIXED: Better timestamp validation and calculation
                const rawStartOffset = Math.max(0, analysis.optimal_start_offset || 0);
                const rawEndOffset = Math.max(0, analysis.optimal_end_offset || 0);
                
                // Ensure offsets don't make the clip invalid
                const maxOffset = Math.max(0, duration - 5); // Keep at least 5 seconds
                const startOffset = Math.min(rawStartOffset, maxOffset);
                const endOffset = Math.min(rawEndOffset, maxOffset);
                
                const optimizedStart = segment.startTime + startOffset;
                const optimizedEnd = segment.endTime - endOffset;
                
                // Final validation
                if (optimizedEnd <= optimizedStart) {
                    logger.error(`Invalid optimized timestamps: start=${optimizedStart}, end=${optimizedEnd}`);
                    // Use original timestamps if optimization fails
                    return this.createValidClip(segment, videoFile, transcript, analysis);
                }
                
                const finalStart = Math.max(0, optimizedStart - CLIP_CONFIG.CONTEXT_BUFFER);
                const finalEnd = optimizedEnd + CLIP_CONFIG.CONTEXT_BUFFER;
                
                logger.log(`✅ Creating clip: ${finalStart}s - ${finalEnd}s (${(finalEnd - finalStart).toFixed(1)}s duration)`);
                
                return {
                    title: analysis.title || this.generateFallbackTitle(transcript),
                    description: analysis.description || this.generateFallbackDescription(transcript),
                    videoPath: `/videos/${videoFile}`,
                    startTime: finalStart,
                    endTime: finalEnd,
                    transcript: transcript,
                    relevanceScore: analysis.relevance_score,
                    qualityScore: analysis.quality_score,
                    keyTopics: analysis.key_topics || [],
                    sourceId: videoFile,
                    aiGenerated: true,
                    reasoning: analysis.reasoning,
                    originalDuration: duration,
                    optimizedDuration: finalEnd - finalStart
                };
            } else {
                logger.log(`❌ Clip rejected: include=${analysis.include_clip}, relevance=${analysis.relevance_score}, threshold=${CLIP_CONFIG.MIN_LLM_SCORE}`);
                return null;
            }
            
        } catch (error) {
            logger.error('LLM enhancement failed:', error);
            return this.createBasicClip(segment, videoFile);
        }
    }
    
    // NEW: Create a valid clip when optimization fails
    createValidClip(segment, videoFile, transcript, analysis) {
        const finalStart = Math.max(0, segment.startTime - CLIP_CONFIG.CONTEXT_BUFFER);
        const finalEnd = segment.endTime + CLIP_CONFIG.CONTEXT_BUFFER;
        
        return {
            title: analysis?.title || this.generateFallbackTitle(transcript),
            description: analysis?.description || this.generateFallbackDescription(transcript),
            videoPath: `/videos/${videoFile}`,
            startTime: finalStart,
            endTime: finalEnd,
            transcript: transcript,
            relevanceScore: analysis?.relevance_score || 0.7,
            qualityScore: analysis?.quality_score || 0.7,
            keyTopics: analysis?.key_topics || [],
            sourceId: videoFile,
            aiGenerated: true,
            reasoning: 'Used original timestamps due to optimization failure'
        };
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

    // INDUSTRY STANDARD: AWS Bedrock Claude API calling with better error handling
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
                    },
                    {
                        role: "assistant", 
                        content: "{"  // Put words in Claude's mouth for better JSON
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
            
            // Parse JSON from Claude's response with better error handling
            const content = responseBody.content[0].text;
            const fullJson = "{" + content; // Reconstruct the JSON
            
            try {
                const parsed = JSON.parse(fullJson);
                logger.log('Successfully parsed Claude JSON response');
                return parsed;
            } catch (parseError) {
                logger.error('JSON parsing failed, raw content:', content);
                logger.error('Parse error:', parseError.message);
                
                // Try to extract JSON using regex as fallback
                const jsonMatch = fullJson.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        const extracted = JSON.parse(jsonMatch[0]);
                        logger.log('Successfully extracted JSON using regex fallback');
                        return extracted;
                    } catch (regexParseError) {
                        logger.error('Regex extraction also failed:', regexParseError.message);
                    }
                }
                
                // Ultimate fallback - return a default response
                logger.log('Using fallback JSON response');
                return {
                    include_clip: true,
                    relevance_score: 0.7,
                    quality_score: 0.7,
                    title: "Relevant Content",
                    description: "This content appears relevant to your query.",
                    key_topics: ["general"],
                    optimal_start_offset: 0,
                    optimal_end_offset: 0,
                    reasoning: "Fallback due to JSON parsing issues"
                };
            }
            
        } catch (error) {
            logger.error('AWS Bedrock Claude call failed:', error);
            
            // Return fallback response instead of null
            return {
                include_clip: true,
                relevance_score: 0.6,
                quality_score: 0.6,
                title: "Content from Transcript",
                description: "Unable to analyze with AI, but content may be relevant.",
                key_topics: ["general"],
                optimal_start_offset: 0,
                optimal_end_offset: 0,
                reasoning: "Fallback due to API error"
            };
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

    // FIXED: Better sliding window creation with validation
    createSlidingWindows(timestamps, windowDuration = 45) {
        const windows = [];
        let currentWindow = [];
        let windowStart = null;
        
        // Sort timestamps by start time to ensure proper ordering
        const sortedTimestamps = timestamps.sort((a, b) => a.start - b.start);
        
        for (const timestamp of sortedTimestamps) {
            // Skip invalid timestamps
            if (timestamp.end <= timestamp.start) {
                logger.error(`Skipping invalid timestamp: start=${timestamp.start}, end=${timestamp.end}`);
                continue;
            }
            
            if (!windowStart) {
                windowStart = timestamp.start;
                currentWindow = [timestamp];
            } else if (timestamp.start - windowStart <= windowDuration) {
                currentWindow.push(timestamp);
            } else {
                if (currentWindow.length > 1) { // Minimum window size reduced to 1
                    // Validate window has proper timing
                    const windowStartTime = Math.min(...currentWindow.map(t => t.start));
                    const windowEndTime = Math.max(...currentWindow.map(t => t.end));
                    
                    if (windowEndTime > windowStartTime) {
                        windows.push([...currentWindow]);
                    }
                }
                windowStart = timestamp.start;
                currentWindow = [timestamp];
            }
        }
        
        // Add the last window
        if (currentWindow.length > 1) {
            const windowStartTime = Math.min(...currentWindow.map(t => t.start));
            const windowEndTime = Math.max(...currentWindow.map(t => t.end));
            
            if (windowEndTime > windowStartTime) {
                windows.push(currentWindow);
            }
        }
        
        logger.log(`Created ${windows.length} valid sliding windows from ${sortedTimestamps.length} timestamps`);
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
        return [];
    }

    // FIXED: Better time parsing with validation
    timeToSeconds(timeStr) {
        if (typeof timeStr === 'number') {
            return Math.max(0, timeStr); // Ensure non-negative
        }
        
        if (!timeStr) return 0;
        
        try {
            const str = String(timeStr).trim();
            
            // Handle pure numbers (already in seconds)
            if (/^\d+(\.\d+)?$/.test(str)) {
                return Math.max(0, parseFloat(str));
            }
            
            // Handle MM:SS or HH:MM:SS format
            const parts = str.split(':');
            let seconds = 0;
            
            if (parts.length === 1) {
                // Just seconds
                seconds = parseFloat(parts[0] || 0);
            } else if (parts.length === 2) {
                // MM:SS format
                const minutes = parseInt(parts[0] || '0');
                const secs = parseFloat(parts[1] || 0);
                seconds = (minutes * 60) + secs;
            } else if (parts.length === 3) {
                // HH:MM:SS format
                const hours = parseInt(parts[0] || '0');
                const minutes = parseInt(parts[1] || '0');
                const secs = parseFloat(parts[2] || 0);
                seconds = (hours * 3600) + (minutes * 60) + secs;
            }
            
            const result = Math.max(0, seconds);
            
            if (isNaN(result)) {
                logger.error(`Could not parse time: "${timeStr}"`);
                return 0;
            }
            
            return result;
            
        } catch (error) {
            logger.error(`Error parsing time "${timeStr}":`, error);
            return 0;
        }
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
        try {
            if (!s3Uri) return null;
            
            const files = await this.findAllVideoFiles();
            if (files.length === 0) return null;
            
            // Extract filename from S3 URI and remove _sentences.json suffix
            const uriParts = s3Uri.split('/');
            const s3Filename = uriParts[uriParts.length - 1].replace('_sentences.json', '');
            
            // Try to find matching video file
            const match = files.find(file => {
                // Remove video extension for comparison
                const videoName = file.replace(/\.(mp4|avi|mov|mkv|webm)$/i, '');
                return videoName === s3Filename;
            });
            
            if (match) {
                logger.log(`Found exact match for ${s3Filename}`);
                return match;
            }
            
            logger.log(`No match found for ${s3Filename}`);
            return null;
            
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

// NEW: Direct Knowledge Base route (FASTEST)
app.post('/api/chat-direct', async (req, res) => {
    const TOTAL_START_TIME = Date.now();
    
    try {
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        const userQuery = message;
        logger.log(`🚀 DIRECT KB PROCESSING START: "${userQuery}"`);
        
        // PHASE 1: Direct Knowledge Base Retrieve + Generate
        const kbStartTime = Date.now();
        const command = new RetrieveAndGenerateCommand({
            input: {
                text: message
            },
            retrieveAndGenerateConfiguration: {
                type: "KNOWLEDGE_BASE",
                knowledgeBaseConfiguration: {
                knowledgeBaseId: "0STV2BEIMA", // Your Knowledge Base ID
                    modelArn: CLIP_CONFIG.CLAUDE_MODEL_ID,
                    retrievalConfiguration: {
                        vectorSearchConfiguration: {
                            numberOfResults: 8, // Increased for better coverage
                            overrideSearchType: "HYBRID" // Use hybrid search for better results
                        }
                    }
                }
            }
        });
        
        const response = await bedrockClient.send(command);
        const kbTime = ((Date.now() - kbStartTime) / 1000).toFixed(1);
        logger.log(`📚 Direct KB retrieve + generate: ${kbTime}s`);
        
        // PHASE 2: Extract response and references
        const agentResponse = response.output?.text || '';
        const citations = response.citations || [];
        
        logger.log(`📄 Retrieved ${citations.length} citations`);
        
        // PHASE 3: Convert citations to your format for clip extraction
        const sources = citations.map((citation, index) => {
            const retrievedRefs = citation.retrievedReferences || [];
            return retrievedRefs.map(ref => ({
                id: ref.location?.s3Location?.uri || `citation-${index}`,
                title: ref.metadata?.source || ref.location?.s3Location?.uri || 'Unknown Source',
                content: ref.content?.text || '',
                score: ref.metadata?.score || 0.8
            }));
        }).flat();
        
        logger.log(`🔗 Processed ${sources.length} sources`);
        
        // PHASE 4: Create fake agent trace for your existing clip extractor
        const agentTrace = {
            all_events: [{
                trace: {
                    orchestrationTrace: {
                        observation: {
                            knowledgeBaseLookupOutput: {
                                retrievedReferences: citations.flatMap(citation => 
                                    citation.retrievedReferences || []
                                )
                            }
                        }
                    }
                }
            }]
        };
        
        // PHASE 5: Your existing AI processing (UNCHANGED)
        const clipStartTime = Date.now();
        const videoClips = await clipExtractor.extractRelevantClips(
            agentTrace, 
            sources, 
            agentResponse, 
            userQuery
        );
        const clipTime = ((Date.now() - clipStartTime) / 1000).toFixed(1);
        logger.log(`🎬 Clip extraction: ${clipTime}s`);
        
        const TOTAL_TIME = ((Date.now() - TOTAL_START_TIME) / 1000).toFixed(1);
        logger.log(`⚡ DIRECT KB TOTAL TIME: ${TOTAL_TIME}s`);
        
        res.json({
            response: agentResponse,
            sources: sources,
            videoClips: videoClips,
            sessionId: `direct-kb-${Date.now()}`,
            metadata: {
                clipCount: videoClips.length,
                hasLLMEnhancement: true,
                totalProcessingTime: TOTAL_TIME,
                method: 'direct_kb',
                kbProcessingTime: kbTime,
                clipProcessingTime: clipTime,
                performance: {
                    kbRetrieveGenerate: `${kbTime}s`,
                    clipExtraction: `${clipTime}s`,
                    total: `${TOTAL_TIME}s`
                }
            }
        });
        
    } catch (error) {
        const TOTAL_TIME = ((Date.now() - TOTAL_START_TIME) / 1000).toFixed(1);
        logger.error(`❌ Direct KB processing failed after ${TOTAL_TIME}s:`, error);
        
        res.status(500).json({ 
            error: 'Direct KB processing failed',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined,
            metadata: {
                method: 'direct_kb_failed',
                totalProcessingTime: TOTAL_TIME
            }
        });
    }
});

// ORIGINAL: Agent route (for comparison/fallback)
app.post('/api/chat', async (req, res) => {
    const TOTAL_START_TIME = Date.now();
    
    try {
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        // Store original user query for semantic analysis
        const userQuery = message;
        logger.log(`🔍 AGENT PROCESSING START: "${userQuery}"`);
        
        // AWS Agent timing
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
        logger.log(`🤖 AWS Agent query: ${agentTime}s`);
        
        // Response processing timing
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
        logger.log(`📄 Response processing: ${processingTime}s`);
        
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
        logger.log(`⏱️  AGENT TOTAL TIME: ${TOTAL_TIME}s`);
        
        res.json({
            response: agentResponse,
            sources: sources,
            videoClips: videoClips,
            sessionId: command.input.sessionId,
            metadata: {
                clipCount: videoClips.length,
                hasLLMEnhancement: !!bedrockRuntimeClient,
                totalProcessingTime: TOTAL_TIME,
                method: 'agent',
                agentTime: agentTime,
                processingTime: processingTime
            }
        });
        
    } catch (error) {
        const TOTAL_TIME = ((Date.now() - TOTAL_START_TIME) / 1000).toFixed(1);
        logger.error(`❌ Agent request failed after ${TOTAL_TIME}s:`, error);
        res.status(500).json({ 
            error: 'An error occurred while processing your request.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// NEW: Smart routing (tries direct first, falls back to agent)
app.post('/api/chat-smart', async (req, res) => {
    const TOTAL_START_TIME = Date.now();
    
    try {
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        logger.log(`🎯 Smart routing for: "${message.substring(0, 50)}..."`);
        
        // Try direct KB first
        try {
            logger.log('📚 Trying direct KB method...');
            
            const directResponse = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Direct KB timeout')), 30000);
                
                fetch(`http://localhost:${port}/api/chat-direct`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message })
                })
                .then(response => {
                    clearTimeout(timeout);
                    resolve(response);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });
            
            if (directResponse.ok) {
                const data = await directResponse.json();
                const TOTAL_TIME = ((Date.now() - TOTAL_START_TIME) / 1000).toFixed(1);
                
                data.metadata = {
                    ...data.metadata,
                    smartRouting: true,
                    selectedMethod: 'direct_kb',
                    totalSmartTime: TOTAL_TIME
                };
                
                logger.log(`✅ Direct KB succeeded in ${TOTAL_TIME}s`);
                return res.json(data);
            }
        } catch (directError) {
            logger.log(`⚠️ Direct KB failed: ${directError.message}`);
        }
        
        // Fallback to agent method
        logger.log('🤖 Falling back to agent method...');
        const agentResponse = await fetch(`http://localhost:${port}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        
        if (!agentResponse.ok) {
            throw new Error(`Agent method also failed: ${agentResponse.status}`);
        }
        
        const data = await agentResponse.json();
        const TOTAL_TIME = ((Date.now() - TOTAL_START_TIME) / 1000).toFixed(1);
        
        data.metadata = {
            ...data.metadata,
            smartRouting: true,
            selectedMethod: 'agent_fallback',
            totalSmartTime: TOTAL_TIME
        };
        
        logger.log(`✅ Agent fallback completed in ${TOTAL_TIME}s`);
        return res.json(data);
        
    } catch (error) {
        const TOTAL_TIME = ((Date.now() - TOTAL_START_TIME) / 1000).toFixed(1);
        logger.error(`❌ Smart routing failed after ${TOTAL_TIME}s:`, error);
        
        res.status(500).json({ 
            error: 'Both direct KB and agent methods failed',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Performance comparison endpoint for testing
app.post('/api/performance-test', async (req, res) => {
    const { message } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }
    
    logger.log(`🏁 Performance test starting for: "${message}"`);
    
    const results = {};
    
    // Test direct KB method
    try {
        const directStart = Date.now();
        const directResponse = await fetch(`http://localhost:${port}/api/chat-direct`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        
        if (directResponse.ok) {
            const directData = await directResponse.json();
            results.direct_kb = {
                success: true,
                time: ((Date.now() - directStart) / 1000).toFixed(1),
                clips: directData.videoClips?.length || 0,
                metadata: directData.metadata
            };
        } else {
            results.direct_kb = {
                success: false,
                time: ((Date.now() - directStart) / 1000).toFixed(1),
                error: 'Request failed'
            };
        }
    } catch (error) {
        results.direct_kb = {
            success: false,
            error: error.message
        };
    }
    
    // Test agent method
    try {
        const agentStart = Date.now();
        const agentResponse = await fetch(`http://localhost:${port}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        
        if (agentResponse.ok) {
            const agentData = await agentResponse.json();
            results.agent = {
                success: true,
                time: ((Date.now() - agentStart) / 1000).toFixed(1),
                clips: agentData.videoClips?.length || 0,
                metadata: agentData.metadata
            };
        } else {
            results.agent = {
                success: false,
                time: ((Date.now() - agentStart) / 1000).toFixed(1),
                error: 'Request failed'
            };
        }
    } catch (error) {
        results.agent = {
            success: false,
            error: error.message
        };
    }
    
    // Calculate performance comparison
    if (results.direct_kb?.success && results.agent?.success) {
        const directTime = parseFloat(results.direct_kb.time);
        const agentTime = parseFloat(results.agent.time);
        const improvement = ((agentTime - directTime) / agentTime * 100).toFixed(1);
        
        results.comparison = {
            directKB: `${directTime}s`,
            agent: `${agentTime}s`,
            improvement: `${improvement}% faster`,
            winner: directTime < agentTime ? 'direct_kb' : 'agent'
        };
    }
    
    logger.log('🏆 Performance test results:', results);
    
    res.json({
        query: message,
        results: results,
        timestamp: new Date().toISOString()
    });
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

// Get frame at timestamp endpoint
app.get('/api/frame-at-timestamp', async (req, res) => {
    try {
        const { videoPath, timestamp } = req.query;
        
        if (!videoPath || timestamp === undefined) {
            return res.status(400).json({ error: 'Video path and timestamp are required' });
        }
        
        // Remove /videos/ prefix if present
        const cleanPath = videoPath.replace(/^\/videos\//, '');
        const fullPath = path.join(__dirname, 'videos', cleanPath);
        
        // Extract frame
        const framePath = await frameExtractor.extractFrame(fullPath, parseFloat(timestamp));
        
        if (!framePath) {
            return res.status(500).json({ error: 'Failed to extract frame' });
        }
        
        // Convert to base64
        const imageBuffer = await fs.readFile(framePath);
        const base64Image = imageBuffer.toString('base64');
        
        res.json({
            imagePath: `/frames/${path.basename(framePath)}`,
            base64Image: `data:image/jpeg;base64,${base64Image}`,
            timestamp: parseFloat(timestamp)
        });
        
    } catch (error) {
        logger.error('Error extracting frame:', error);
        res.status(500).json({ error: 'Failed to extract frame' });
    }
});

// Get video metadata endpoint
app.get('/api/video-metadata', async (req, res) => {
    try {
        const { videoPath } = req.query;
        
        if (!videoPath) {
            return res.status(400).json({ error: 'Video path is required' });
        }
        
        // Remove /videos/ prefix if present
        const cleanPath = videoPath.replace(/^\/videos\//, '');
        const fullPath = path.join(__dirname, 'videos', cleanPath);
        
        // Get video duration and other metadata
        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(fullPath, (err, data) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(data);
            });
        });
        
        res.json({
            duration: metadata.format.duration,
            size: metadata.format.size,
            bitrate: metadata.format.bit_rate,
            format: metadata.format.format_name,
            filename: path.basename(videoPath)
        });
        
    } catch (error) {
        logger.error('Error getting video metadata:', error);
        res.status(500).json({ error: 'Failed to get video metadata' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        llmEnabled: !!bedrockRuntimeClient,
        embeddingCacheSize: clipExtractor.embeddingCache.size,
        endpoints: {
            '/api/chat': 'Original agent method',
            '/api/chat-direct': 'Fast direct KB method',
            '/api/chat-smart': 'Smart routing (recommended)',
            '/api/performance-test': 'Performance comparison'
        }
    });
});
// Document generation endpoint
app.post('/api/generate-document', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { query } = req.body;
        
        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }
        
        logger.log(`📄 Generating document for: "${query}"`);
        
        // Step 1: Get content from KB
        const kbResponse = await fetch(`http://localhost:${port}/api/chat-direct`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: query })
        });
        
        const kbData = await kbResponse.json();
        
        // Step 2: Generate document structure using Claude
        const documentStructure = await generateDocumentStructure(query, kbData, bedrockRuntimeClient);
        
        // Step 3: Extract frames for visuals
        const documentWithFrames = await extractDocumentFrames(documentStructure, kbData.videoClips);
        
        // Step 4: Generate HTML
        const htmlContent = generateDocumentHTML(documentWithFrames);
        
// Step 5: Store for PDF export with selected frames tracking
        // Initialize document with proper structure
        const documentId = uuidv4();
        const cached = initializeDocument(documentId, documentWithFrames);
        cached.html = htmlContent;
        
        // Validate structure
        if (!validateDocumentStructure(documentWithFrames)) {
            throw new Error('Invalid document structure');
        }
        
        logger.log(`Document cache initialized with ID: ${documentId}`);
        
        const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.log(`✅ Document generated in ${processingTime}s`);
        
        // Add export button with proper document ID
        const exportButton = `
            <div class="document-actions">
                <button class="document-action-btn" data-document-id="${documentId}" onclick="exportPDF('${documentId}')" style="opacity: 0.5; cursor: not-allowed;">
                    📥 Export PDF
                </button>
            </div>
        `;
        
        // Insert export button into HTML content
        const htmlWithExport = htmlContent.replace(
            '<div class="document-intro">',
            `<div class="document-actions">${exportButton}</div><div class="document-intro">`
        );
        
        res.json({
            title: documentWithFrames.title,
            htmlContent: htmlWithExport,
            documentId: documentId,
            metadata: {
                processingTime: processingTime,
                sections: documentWithFrames.sections.length
            }
        });
        
    } catch (error) {
        logger.error('Document generation failed:', error);
        res.status(500).json({ error: 'Failed to generate document' });
    }
});

// Document cache and endpoints
const documentCache = new Map();

// Initialize document cache with proper structure
function initializeDocument(documentId, structure = null) {
    try {
        if (!documentCache.has(documentId)) {
            const newDoc = {
                structure: structure ? JSON.parse(JSON.stringify(structure)) : {},
                selectedFrames: new Map(),
                isReadyForPDF: false,
                created: new Date(),
                lastUpdated: new Date()
            };
            documentCache.set(documentId, newDoc);
            logger.log(`Initialized document cache for ${documentId}`);
            return newDoc;
        }
        
        const cached = documentCache.get(documentId);
        if (structure) {
            cached.structure = JSON.parse(JSON.stringify(structure));
            cached.lastUpdated = new Date();
            documentCache.set(documentId, cached);
            logger.log(`Updated document structure for ${documentId}`);
        }
        return cached;
    } catch (error) {
        logger.error(`Failed to initialize document cache: ${error.message}`);
        throw new Error('Document cache initialization failed');
    }
}

// Validate document structure
function validateDocumentStructure(structure) {
    if (!structure || typeof structure !== 'object') {
        return false;
    }
    if (!Array.isArray(structure.sections)) {
        return false;
    }

    // Count total visual steps across all sections
    let visualStepCount = 0;
    for (const section of structure.sections) {
        if (!section || !Array.isArray(section.steps)) {
            return false;
        }
        for (const step of section.steps) {
            if (!step || typeof step !== 'object' || typeof step.number !== 'number') {
                return false;
            }
            // Ensure needsVisual is explicitly set
            if (step.needsVisual === undefined) {
                return false;
            }
            // Count visual steps
            if (step.needsVisual === true) {
                visualStepCount++;
            }
            // Validate visualDescription
            if (step.needsVisual === true && !step.visualDescription) {
                return false;
            }
            if (step.needsVisual === false && step.visualDescription !== null) {
                return false;
            }
        }
    }

    // Must have exactly 4 visual steps
    if (visualStepCount !== 4) {
        logger.error(`Invalid visual step count: ${visualStepCount} (must be exactly 4)`);
        return false;
    }

    return true;
}

// Update selected frame endpoint
app.post('/api/update-selected-frame', async (req, res) => {
    try {
        const { documentId, stepIndex, sectionIndex, frameData } = req.body;
        
        if (!documentId || stepIndex === undefined || sectionIndex === undefined || !frameData) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        
        // Get document from cache
        const cached = documentCache.get(documentId);
        if (!cached || !cached.structure || !cached.structure.sections) {
            logger.error(`Invalid document structure for ID: ${documentId}`);
            return res.status(400).json({ error: 'Invalid document structure' });
        }

        // Validate section and step indices
        if (sectionIndex >= cached.structure.sections.length) {
            return res.status(400).json({ error: 'Invalid section index' });
        }

        const section = cached.structure.sections[sectionIndex];
        if (!section.steps || stepIndex >= section.steps.length) {
            return res.status(400).json({ error: 'Invalid step index' });
        }

        // Update selected frame for this step
        const key = `${sectionIndex}-${stepIndex}`;
        cached.selectedFrames.set(key, {
            ...frameData,
            timestamp: Date.now()
        });

        // Check if all required frames are selected
        let totalSteps = 0;
        let selectedSteps = 0;

        // First pass: Count total required frames
        for (const section of cached.structure.sections) {
            if (!section.steps) continue;
            for (const step of section.steps) {
                // Only count steps that are explicitly marked as needing visuals
                if (step.needsVisual === true) {
                    totalSteps++;
                    logger.log(`Found step needing visual: Section ${sectionIndex}, Step ${step.number}`);
                }
            }
        }

        // Second pass: Count selected frames that match required steps
        for (const [key, frame] of cached.selectedFrames.entries()) {
            if (frame && frame.success) {
                // Parse section and step index from key
                const [frameSection, frameStep] = key.split('-').map(Number);
                
                // Verify this frame corresponds to a step that needs a visual
                if (frameSection < cached.structure.sections.length) {
                    const section = cached.structure.sections[frameSection];
                    if (section.steps && frameStep < section.steps.length) {
                        const step = section.steps[frameStep];
                        if (step.needsVisual === true) {
                            selectedSteps++;
                            logger.log(`Found selected frame for required step: Section ${frameSection}, Step ${step.number}`);
                        }
                    }
                }
            }
        }

        // Update ready state
        const allFramesSelected = totalSteps > 0 && selectedSteps >= totalSteps;

        cached.isReadyForPDF = allFramesSelected;
        cached.lastUpdated = new Date();
        documentCache.set(documentId, cached);

        logger.log(`Frame selection updated: ${selectedSteps}/${totalSteps} frames selected`);

        res.json({ 
            success: true, 
            isReadyForPDF: allFramesSelected,
            progress: {
                total: totalSteps,
                selected: selectedSteps,
                remaining: totalSteps - selectedSteps
            }
        });
    } catch (error) {
        logger.error('Error updating selected frame:', error);
        res.status(500).json({ 
            error: 'Failed to update selected frame',
            details: error.message
        });
    }
});

// PDF export endpoint with enhanced error handling and optimization
app.get('/api/export-pdf', async (req, res) => {
    let browser = null;
    const maxRetries = 3;
    let attempt = 0;
    
    try {
        const { id } = req.query;
        const cached = documentCache.get(id);
        
        if (!cached) {
            return res.status(404).json({ error: 'Document not found' });
        }

        if (!cached.isReadyForPDF) {
            return res.status(400).json({ error: 'Please select all required frames before generating PDF' });
        }
        
        logger.log(`📄 Starting PDF export for document: ${cached.structure.title}`);

        // Update structure with selected frames
        const updatedStructure = JSON.parse(JSON.stringify(cached.structure));
        updatedStructure.sections.forEach((section, secIdx) => {
            section.steps.forEach((step, stepIdx) => {
                if (step.needsVisual) {
                    const selectedFrame = cached.selectedFrames.get(`${secIdx}-${stepIdx}`);
                    if (selectedFrame) {
                        step.visual = selectedFrame;
                    }
                }
            });
        });
        
        // Step 1: Optimize images with better error handling
        let optimizedStructure;
        try {
            optimizedStructure = await optimizeImagesForPDF(updatedStructure);
            logger.log('✅ Images optimized successfully');
        } catch (optimizeError) {
            logger.error('Image optimization failed:', optimizeError);
            // Fallback to original structure if optimization fails
            optimizedStructure = cached.structure;
        }
        
        // Step 2: Generate HTML with enhanced print styles
        const optimizedHTML = generateDocumentHTML(optimizedStructure, true);
        
        while (attempt < maxRetries) {
            try {
                attempt++;
                logger.log(`🚀 PDF export attempt ${attempt}/${maxRetries}`);
                
                browser = await puppeteer.launch({ 
                    headless: 'new',
                    executablePath: process.env.CHROME_PATH || undefined,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-gpu',
                        '--disable-dev-shm-usage',
                        '--disable-extensions',
                        '--font-render-hinting=none',
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding',
                        '--disable-software-rasterizer',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--enable-font-antialiasing',
                        '--hide-scrollbars',
                        '--font-render-hinting=medium',
                        '--force-color-profile=srgb',
                        '--force-device-scale-factor=2'
                    ],
                    timeout: 90000, // Increased timeout
                    ignoreHTTPSErrors: true,
                    defaultViewport: {
                        width: 1200,
                        height: 1600,
                        deviceScaleFactor: 2,
                        isLandscape: false
                    }
                });
                
                const page = await browser.newPage();
                
                // Increase timeouts for better reliability
                page.setDefaultTimeout(60000);
                page.setDefaultNavigationTimeout(60000);
                
                // Enhanced page configuration for better rendering
                await page.evaluateOnNewDocument(() => {
                    document.body.style.webkitFontSmoothing = 'antialiased';
                    document.body.style.textRendering = 'optimizeLegibility';
                    document.body.style.printColorAdjust = 'exact';
                    document.body.style.WebkitPrintColorAdjust = 'exact';
                    
                    // Force JPEG image format for better compression
                    const images = document.getElementsByTagName('img');
                    for (const img of images) {
                        img.style.imageRendering = 'auto';
                        if (!img.complete || !img.naturalWidth) {
                            img.onerror = () => {
                                img.src = 'data:image/svg+xml,' + encodeURIComponent(`
                                    <svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
                                        <rect width="100%" height="100%" fill="#f8f9fa"/>
                                        <text x="50%" y="50%" font-family="Arial" font-size="24" fill="#666" text-anchor="middle">
                                            Image failed to load
                                        </text>
                                    </svg>
                                `);
                            };
                        }
                    }
                });
                
                // Wait for network to be idle
                await page.setRequestInterception(true);
                page.on('request', request => {
                    if (request.resourceType() === 'image') {
                        request.continue();
                    } else {
                        request.continue();
                    }
                });
                
                // Enhanced HTML with embedded styles and fonts
// Create clean HTML without embedded styles
const enhancedHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${optimizedStructure.title}</title>
    <style>
        @page { margin: 20mm; size: A4; }
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background: white; }
        .document-title { font-size: 24pt; font-weight: bold; margin-bottom: 15px; text-align: center; }
        .document-introduction { font-size: 12pt; margin-bottom: 20px; text-align: center; }
        .section-title { font-size: 18pt; font-weight: bold; margin: 30px 0 15px 0; border-bottom: 2px solid #000; page-break-after: avoid; }
        .process-step { margin: 20px 0; padding: 15px; border-left: 2px solid #000; page-break-inside: avoid; }
        .step-number { font-weight: bold; margin-bottom: 10px; }
        .step-content { margin-bottom: 15px; }
        .step-visual { text-align: center; margin: 15px 0; page-break-inside: avoid; }
        .step-visual img { max-width: 100%; height: auto; margin: 10px 0; }
        .visual-caption { font-style: italic; color: #666; font-size: 10pt; margin-top: 8px; }
    </style>
</head>
<body>
    <div class="document-title">${optimizedStructure.title}</div>
    <div class="document-introduction">${optimizedStructure.introduction}</div>
    ${optimizedStructure.sections.map(section => `
        <div class="document-section">
            <div class="section-title">${section.title}</div>
            ${section.steps.map(step => `
                <div class="process-step">
                    <div class="step-number">Step ${step.number}</div>
                    <div class="step-content">${step.text}</div>
                    ${step.visual ? `
                        <div class="step-visual">
                            <img src="${step.visual.base64Image}" alt="Visual aid" style="max-width: 100%; height: auto;">
                            <div class="visual-caption">${step.visual.caption}</div>
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>
    `).join('')}
    ${optimizedStructure.conclusion ? `
        <div class="document-section">
            <div class="section-title">Conclusion</div>
            <div class="step-content">${optimizedStructure.conclusion}</div>
        </div>
    ` : ''}
</body>
</html>`;
                
                logger.log(`📝 Setting page content...`);
                
                // Enhanced content loading with better error handling
                await Promise.race([
                    page.setContent(enhancedHTML, { 
                        waitUntil: ['load', 'networkidle0', 'domcontentloaded'],
                        timeout: 60000
                    }),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Content loading timeout')), 60000)
                    )
                ]);
                
                // Ensure all content is loaded
                await page.evaluate(() => {
                    return new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('Content loading timed out')), 30000);
                        
                        Promise.all([
                            document.fonts.ready,
                            new Promise(resolve => {
                                if (document.readyState === 'complete') {
                                    resolve();
                                } else {
                                    window.addEventListener('load', resolve);
                                }
                            }),
                            new Promise(resolve => {
                                const images = Array.from(document.images);
                                const loadedImages = images.map(img => {
                                    if (img.complete) {
                                        return Promise.resolve();
                                    }
                                    return new Promise(resolve => {
                                        img.onload = img.onerror = resolve;
                                    });
                                });
                                Promise.all(loadedImages).then(resolve);
                            })
                        ]).then(() => {
                            clearTimeout(timeout);
                            resolve();
                        });
                    });
                });
                
                // Wait for fonts and images
                await Promise.all([
                    page.waitForFunction(() => document.fonts.ready, { timeout: 10000 }),
                    page.waitForFunction(() => {
                        const images = Array.from(document.images);
                        return images.every(img => img.complete);
                    }, { timeout: 10000 })
                ]);
                
                // Validate and optimize page content
                const validationResult = await validatePageContent(page);
                if (validationResult.issues.length > 0) {
                    logger.log(`⚠️ Found ${validationResult.issues.length} content issues to fix`);
                    await fixContentIssues(page, validationResult.issues);
                }
                
                logger.log(`🎨 Generating PDF with enhanced settings...`);
                
                // Enhanced PDF generation with optimized settings
                const pdf = await page.pdf({
                    format: 'A4',
                    printBackground: true,
                    margin: {
                        top: '20mm',
                        right: '20mm',
                        bottom: '20mm',
                        left: '20mm'
                    },
                    preferCSSPageSize: true,
                    displayHeaderFooter: false,
                    scale: 1,
                    landscape: false,
                    pageRanges: '',
                    headerTemplate: '',
                    footerTemplate: '',
                    omitBackground: false,
                    timeout: 60000,
                });

                // Validate PDF buffer
                if (!pdf || pdf.length === 0) {
                    throw new Error('Generated PDF buffer is empty');
                }

                // Create a copy of the buffer to ensure it's properly closed
                const pdfBuffer = Buffer.from(pdf);
                
                await browser.close();
                browser = null;
                
                const pdfSize = pdf.length / (1024 * 1024);
                logger.log(`✅ PDF generated successfully (${pdfSize.toFixed(2)} MB)`);
                
                const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
                const filename = `${cached.structure.title.replace(/[^a-z0-9]/gi, '_')}-${timestamp}.pdf`;
                
                // Send PDF in chunks
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                res.setHeader('Content-Length', pdfBuffer.length);
                
                const chunkSize = 16384; // 16KB chunks
                for (let i = 0; i < pdfBuffer.length; i += chunkSize) {
                    const chunk = pdfBuffer.slice(i, i + chunkSize);
                    res.write(chunk);
                }
                res.end();
                
                logger.log(`✅ PDF sent successfully (${(pdfBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);
                return;
                
            } catch (error) {
                logger.error(`PDF export attempt ${attempt} failed:`, error.message);
                
                if (browser) {
                    try {
                        await browser.close();
                    } catch (closeError) {
                        logger.error('Error closing browser:', closeError);
                    }
                    browser = null;
                }
                
                if (attempt === maxRetries) {
                    throw new Error(`Failed to export PDF after ${maxRetries} attempts: ${error.message}`);
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    } catch (error) {
        if (browser) {
            try {
                await browser.close();
            } catch (closeError) {
                logger.error('Error closing browser:', closeError);
            }
        }
        
        logger.error('PDF export failed:', error);
        res.status(500).json({ 
            error: 'Failed to export PDF',
            details: process.env.NODE_ENV === 'development' ? error.message : 'PDF generation failed. Please try again.'
        });
    }
});

// Helper functions for PDF generation
const sharp = require('sharp');

async function optimizeImagesForPDF(structure) {
    const optimizedStructure = JSON.parse(JSON.stringify(structure)); // Deep clone
    
    for (const section of optimizedStructure.sections) {
        for (const step of section.steps) {
            if (step.visual && step.visual.base64Image) {
                try {
                    // Extract base64 data
                    const base64Data = step.visual.base64Image.replace(/^data:image\/\w+;base64,/, '');
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    
                    // Optimize image
                    const optimizedBuffer = await sharp(imageBuffer)
                        .resize(800, 600, { // Reduced size
                            fit: 'inside',
                            withoutEnlargement: true
                        })
                        .jpeg({ // Convert to JPEG
                            quality: 80,
                            progressive: true
                        })
                        .toBuffer();
                    
                    // Update base64 image
                    step.visual.base64Image = `data:image/jpeg;base64,${optimizedBuffer.toString('base64')}`;
                    
                    const savings = ((imageBuffer.length - optimizedBuffer.length) / imageBuffer.length * 100).toFixed(1);
                    logger.log(`Optimized image: ${savings}% size reduction`);
                    
                } catch (error) {
                    logger.error(`Image optimization failed: ${error.message}`);
                }
            }
        }
    }
    
    return optimizedStructure;
}

async function validatePageContent(page) {
    const issues = [];
    
    // Check images
    const imageIssues = await page.evaluate(() => {
        return Array.from(document.images).map(img => {
            if (!img.complete) return { type: 'image_incomplete', element: img.outerHTML };
            if (!img.naturalWidth) return { type: 'image_invalid', element: img.outerHTML };
            if (img.naturalWidth < 50) return { type: 'image_too_small', element: img.outerHTML };
            return null;
        }).filter(Boolean);
    });
    issues.push(...imageIssues);
    
    // Check text content
    const textIssues = await page.evaluate(() => {
        const issues = [];
        const textElements = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
        
        textElements.forEach(el => {
            const style = window.getComputedStyle(el);
            if (parseFloat(style.fontSize) < 8) {
                issues.push({ type: 'text_too_small', element: el.outerHTML });
            }
        });
        
        return issues;
    });
    issues.push(...textIssues);
    
    return { issues };
}

async function fixContentIssues(page, issues) {
    for (const issue of issues) {
        switch (issue.type) {
            case 'image_incomplete':
            case 'image_invalid':
                await page.evaluate((html) => {
                    const temp = document.createElement('div');
                    temp.innerHTML = html;
                    const img = temp.querySelector('img');
                    if (img) {
                        const placeholder = document.createElement('div');
                        placeholder.className = 'visual-placeholder';
                        placeholder.innerHTML = `
                            <div style="padding: 20px; text-align: center; background: #f8f9fa; border-radius: 8px;">
                                <div style="font-size: 24px; margin-bottom: 10px;">🖼️</div>
                                <div>Image could not be loaded</div>
                            </div>
                        `;
                        img.parentNode.replaceChild(placeholder, img);
                    }
                }, issue.element);
                break;
                
            case 'text_too_small':
                await page.evaluate((html) => {
                    const temp = document.createElement('div');
                    temp.innerHTML = html;
                    const el = temp.firstElementChild;
                    if (el) {
                        el.style.fontSize = '12px';
                    }
                }, issue.element);
                break;
        }
    }
}

async function generateDocumentStructure(query, kbData, bedrockRuntimeClient) {
    const prompt = `Create a structured process document based on this query and content.

QUERY: "${query}"
CONTENT: "${kbData.response}"

CRITICAL RULES FOR VISUAL STEPS:
1. Create EXACTLY 4 visual steps total across all sections
2. Mark these 4 key steps with needsVisual=true
3. All other steps must have needsVisual=false
4. Each visual step must have a clear visualDescription
5. Choose only the most critical steps that absolutely require visual demonstration

FORMAT RULES:
1. Each step must have these exact properties:
   - number: (integer)
   - text: (string) step description
   - needsVisual: (boolean) exactly true for 4 steps, false for all others
   - visualDescription: (string) required if needsVisual=true, null if false

Respond with JSON only:
{
  "title": "Document Title",
  "introduction": "Brief introduction",
  "sections": [
    {
      "title": "Section Title",
      "steps": [
        {
          "number": 1,
          "text": "Step description",
          "needsVisual": false,
          "visualDescription": null
        }
      ]
    }
  ],
  "conclusion": "Brief conclusion",
  "metadata": {
    "visualStepCount": 4,
    "totalSteps": 0
  }
}

STRICT VALIDATION:
1. Count total needsVisual=true steps across ALL sections
2. Must be EXACTLY 4 visual steps
3. Each visual step must have non-null visualDescription
4. All non-visual steps must have visualDescription=null
5. All steps must have needsVisual explicitly set to true or false`;

    try {
        const command = new InvokeModelCommand({
            modelId: CLIP_CONFIG.CLAUDE_MODEL_ID,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 8000,
                temperature: 0.1,
                messages: [
                    { role: "user", content: prompt },
                    { role: "assistant", content: "{" }
                ]
            })
        });

        const response = await bedrockRuntimeClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const content = "{" + responseBody.content[0].text;
        
        return JSON.parse(content);
    } catch (error) {
        logger.error('Document structure generation failed:', error);
        // Return fallback structure
        return {
            title: "Process Documentation",
            introduction: kbData.response.substring(0, 200) + "...",
            sections: [{
                title: "Process Steps",
                steps: [{
                    number: 1,
                    text: kbData.response,
                    needsVisual: false
                }]
            }],
            conclusion: "End of process documentation."
        };
    }
}

// Cache for full transcripts
const transcriptCache = new Map();

// Load and cache full transcript for a video
async function loadFullTranscript(videoPath) {
    if (transcriptCache.has(videoPath)) {
        return transcriptCache.get(videoPath);
    }

    try {
        // Find corresponding transcript file
        const videoName = path.basename(videoPath, path.extname(videoPath));
        const transcriptPath = path.join(__dirname, 'transcripts', `${videoName}.json`);
        
        const transcriptContent = await fs.readFile(transcriptPath, 'utf8');
        const transcript = JSON.parse(transcriptContent);
        
        transcriptCache.set(videoPath, transcript);
        return transcript;
    } catch (error) {
        logger.error(`Failed to load transcript for ${videoPath}:`, error);
        return null;
    }
}

// Find best frame timestamp using transcript context
async function findBestFrameTimestamp(clip, transcript) {
    if (!transcript) return clip.startTime + 2;

    try {
        // Find transcript segments around the clip time
        const relevantSegments = transcript.segments.filter(seg => 
            seg.start >= clip.startTime - 5 && seg.end <= clip.endTime + 5
        );

        if (relevantSegments.length === 0) {
            return clip.startTime + 2;
        }

        // Find segment with most stable scene (longer duration)
        const bestSegment = relevantSegments.reduce((best, current) => 
            (current.end - current.start > best.end - best.start) ? current : best
        );

        // Return timestamp at 1/3 into the segment for stable frame
        return bestSegment.start + ((bestSegment.end - bestSegment.start) / 3);
    } catch (error) {
        logger.error('Error finding best frame timestamp:', error);
        return clip.startTime + 2;
    }
}

async function extractDocumentFrames(structure, videoClips) {
    let visualIndex = 0;
    
    // Group clips by video for efficient transcript loading
    const clipsByVideo = new Map();
    videoClips.forEach(clip => {
        const videoPath = clip.videoPath.replace(/^\/videos\//, '');
        if (!clipsByVideo.has(videoPath)) {
            clipsByVideo.set(videoPath, []);
        }
        clipsByVideo.get(videoPath).push(clip);
    });
    
    // Load transcripts for all unique videos
    const transcripts = new Map();
    for (const videoPath of clipsByVideo.keys()) {
        const transcript = await loadFullTranscript(videoPath);
        if (transcript) {
            transcripts.set(videoPath, transcript);
        }
    }
    
    for (const section of structure.sections) {
        for (const step of section.steps) {
            if (step.needsVisual && videoClips[visualIndex]) {
                const clip = videoClips[visualIndex];
                const videoPath = clip.videoPath.replace(/^\/videos\//, '');
                const transcript = transcripts.get(videoPath);
                
                try {
                    // FIXED: Better timestamp calculation with validation
                    let timestamp = await findBestFrameTimestamp(clip, transcript);
                    
                    // FIXED: Ensure timestamp is within clip bounds
                    timestamp = Math.max(clip.startTime + 2, Math.min(timestamp, clip.endTime - 2));
                    
                    logger.log(`Extracting frame for step "${step.text.substring(0, 30)}..." at ${timestamp}s from ${videoPath}`);
                    
                    // FIXED: Proper path construction for Windows
                    const fullVideoPath = path.join(__dirname, 'videos', videoPath);
                    
                    // Try to extract frame with multiple fallback timestamps
                    const fallbackTimestamps = [
                        timestamp,
                        clip.startTime + 3,
                        clip.startTime + 5,
                        (clip.startTime + clip.endTime) / 2,
                        clip.endTime - 5,
                        clip.endTime - 3
                    ].filter(t => t >= clip.startTime && t <= clip.endTime);
                    
                    let framePath = null;
                    let usedTimestamp = timestamp;
                    
                    for (const tryTimestamp of fallbackTimestamps) {
                        framePath = await frameExtractor.extractFrame(fullVideoPath, tryTimestamp);
                        if (framePath) {
                            usedTimestamp = tryTimestamp;
                            logger.log(`✅ Frame extracted at ${tryTimestamp}s`);
                            break;
                        }
                    }
                    
                    if (framePath) {
                        try {
                            // FIXED: Convert image to base64 for reliable PDF export
                            const imageBuffer = await fs.readFile(framePath);
                            const base64Image = imageBuffer.toString('base64');
                            
                            step.visual = {
                                imagePath: `/frames/${path.basename(framePath)}`,
                                base64Image: `data:image/jpeg;base64,${base64Image}`,
                                videoPath: clip.videoPath,
                                timestamp: usedTimestamp,
                                caption: step.visualDescription || `From: ${clip.title}`,
                                success: true
                            };
                            
                            logger.log(`✅ Frame successfully processed for step ${visualIndex + 1}`);
                        } catch (readError) {
                            logger.error(`Failed to read extracted frame: ${readError.message}`);
                            step.visual = createFallbackVisual(clip, usedTimestamp, step.visualDescription);
                        }
                    } else {
                        logger.error(`❌ All frame extraction attempts failed for ${videoPath}`);
                        step.visual = createFallbackVisual(clip, timestamp, step.visualDescription);
                    }
                } catch (error) {
                    logger.error('Frame extraction error:', error);
                    step.visual = createFallbackVisual(clip, timestamp, step.visualDescription);
                }
                
                visualIndex++;
            }
        }
    }
    
    return structure;
}

// FIXED: Create consistent fallback visual
function createFallbackVisual(clip, timestamp, description) {
    return {
        videoPath: clip.videoPath,
        timestamp: timestamp,
        caption: description || `From: ${clip.title}`,
        error: 'Frame extraction failed',
        success: false,
        fallback: true
    };
}

// FIXED: Much more robust HTML generation for PDF
function generateDocumentHTML(doc, forPDF = false) {
    const sanitizeText = (text) => {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    let html = `
        <style>
            /* Frame Selection UI */
            .frame-selection-modal {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.8);
                z-index: 1000;
                overflow: auto;
            }
            
            .frame-selection-content {
                background: white;
                margin: 40px auto;
                padding: 20px;
                max-width: 900px;
                border-radius: 12px;
                box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
            }
            
            .frame-preview {
                text-align: center;
                margin: 20px 0;
            }
            
            .frame-preview img {
                max-width: 100%;
                border-radius: 8px;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            
            .timeline-container {
                padding: 20px;
                background: #f8fafc;
                border-radius: 8px;
                margin: 20px 0;
            }
            
            .timeline-slider {
                width: 100%;
                margin: 10px 0;
            }
            
            .timeline-controls {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 10px;
            }
            
            .timeline-timestamp {
                font-family: monospace;
                font-size: 14px;
                color: #4a5568;
            }
            
            .timeline-buttons {
                display: flex;
                gap: 10px;
            }
            
            .timeline-button {
                background: #e53e3e;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s ease;
            }
            
            .timeline-button:hover {
                background: #c53030;
                transform: translateY(-1px);
            }
            
            .select-frame-btn {
                background: linear-gradient(135deg, #e53e3e, #f56500);
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                margin-top: 20px;
            }
            
            .select-frame-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(229, 62, 62, 0.3);
            }
            
            /* Visual element enhancements */
            .step-visual {
                position: relative;
            }
            
            .change-frame-btn {
                position: absolute;
                top: 10px;
                right: 10px;
                background: rgba(0, 0, 0, 0.6);
                color: white;
                border: none;
                padding: 8px 12px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                transition: all 0.2s ease;
                opacity: 0;
            }
            
            .step-visual:hover .change-frame-btn {
                opacity: 1;
            }
            
            .change-frame-btn:hover {
                background: rgba(0, 0, 0, 0.8);
                transform: translateY(-1px);
            }
        </style>
        
        <div class="document-intro">
            <h1 class="document-title">${sanitizeText(doc.title)}</h1>
            <div class="document-introduction">${sanitizeText(doc.introduction)}</div>
        </div>
    `;
    
    for (const section of doc.sections) {
        html += `
        <div class="document-section">
            <h2 class="section-title">${sanitizeText(section.title)}</h2>
        `;
        
        for (const step of section.steps) {
            html += `
            <div class="process-step">
                <div class="step-number">Step ${step.number}</div>
                <div class="step-content">${sanitizeText(step.text)}</div>
            `;
            
            if (step.visual) {
                if ((step.visual.success || forPDF) && step.visual.base64Image) {
                    // Working image
                    html += `
                    <div class="step-visual" data-video-path="${step.visual.videoPath}" data-timestamp="${step.visual.timestamp}">
                        <img src="${step.visual.base64Image}" 
                             alt="${sanitizeText(step.visual.caption)}" 
                             style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                        <button class="change-frame-btn" onclick="openFrameSelection(this)">Change Frame</button>
                        <div class="visual-caption">
                            <div class="caption-text">${sanitizeText(step.visual.caption)}</div>
                            <div class="timestamp-info">
                                Video: ${sanitizeText(step.visual.videoPath.split('/').pop())} 
                                at ${Math.floor(step.visual.timestamp / 60)}:${String(Math.floor(step.visual.timestamp % 60)).padStart(2, '0')}
                            </div>
                        </div>
                    </div>
                    `;
                } else {
                    // FIXED: Better fallback placeholder
                    html += `
                    <div class="step-visual">
                        <div class="visual-placeholder" style="
                            background: linear-gradient(135deg, #f0f4f8 0%, #d9e2ec 100%);
                            padding: 40px 20px;
                            border-radius: 8px;
                            text-align: center;
                            border: 2px dashed #cbd5e0;
                            margin: 15px 0;
                            color: #4a5568;
                        ">
                            <div style="font-size: 3rem; margin-bottom: 15px; opacity: 0.7;">🎬</div>
                            <div style="font-weight: 600; margin-bottom: 8px; font-size: 1.1rem;">
                                Video Reference
                            </div>
                            <div style="margin-bottom: 5px;">
                                ${sanitizeText(step.visual.videoPath.split('/').pop())}
                            </div>
                            <div style="font-size: 0.9rem; opacity: 0.8;">
                                Timestamp: ${Math.floor(step.visual.timestamp / 60)}:${String(Math.floor(step.visual.timestamp % 60)).padStart(2, '0')}
                            </div>
                        </div>
                        <div class="visual-caption">
                            <div class="caption-text">${sanitizeText(step.visual.caption)}</div>
                            <div class="timestamp-info">
                                Video: ${sanitizeText(step.visual.videoPath.split('/').pop())} 
                                at ${Math.floor(step.visual.timestamp / 60)}:${String(Math.floor(step.visual.timestamp % 60)).padStart(2, '0')}
                            </div>
                        </div>
                    </div>
                    `;
                }
            }
            
            html += `</div>`;
        }
        
        html += `</div>`;
    }
    
    if (doc.conclusion) {
        html += `
            <div class="document-section conclusion">
                <h2 class="section-title">Conclusion</h2>
                <div class="conclusion-content">${sanitizeText(doc.conclusion)}</div>
            </div>
        `;
    }
    
    // Add frame selection modal
    html += `
        <div id="frameSelectionModal" class="frame-selection-modal">
            <div class="frame-selection-content">
                <div class="frame-preview">
                    <img id="framePreview" src="" alt="Frame preview">
                </div>
                <div class="timeline-container">
                    <input type="range" id="timelineSlider" class="timeline-slider" min="0" max="100" value="0">
                    <div class="timeline-controls">
                        <span class="timeline-timestamp" id="currentTimestamp">0:00</span>
                        <div class="timeline-buttons">
                            <button class="timeline-button" onclick="seekFrame(-10)">-10s</button>
                            <button class="timeline-button" onclick="seekFrame(-5)">-5s</button>
                            <button class="timeline-button" onclick="seekFrame(5)">+5s</button>
                            <button class="timeline-button" onclick="seekFrame(10)">+10s</button>
                        </div>
                        <span class="timeline-timestamp" id="totalDuration">0:00</span>
                    </div>
                </div>
                <div style="text-align: center;">
                    <button class="select-frame-btn" onclick="selectFrame()">Select Frame</button>
                </div>
            </div>
        </div>
        
        <script>
            let activeVisual = null;
            let videoDuration = 0;
            
            async function openFrameSelection(btn) {
                const visual = btn.closest('.step-visual');
                const videoPath = visual.dataset.videoPath;
                const timestamp = parseFloat(visual.dataset.timestamp);
                
                activeVisual = visual;
                
                // Get video metadata
                const metadataResponse = await fetch(\`/api/video-metadata?videoPath=\${encodeURIComponent(videoPath)}\`);
                const metadata = await metadataResponse.json();
                videoDuration = metadata.duration;
                
                // Update timeline
                const slider = document.getElementById('timelineSlider');
                slider.max = metadata.duration;
                slider.value = timestamp;
                
                document.getElementById('totalDuration').textContent = formatTimestamp(metadata.duration);
                updateTimestamp(timestamp);
                
                // Load initial frame
                await updateFramePreview(timestamp);
                
                // Show modal
                document.getElementById('frameSelectionModal').style.display = 'block';
            }
            
            async function updateFramePreview(timestamp) {
                const videoPath = activeVisual.dataset.videoPath;
                
                try {
                    const response = await fetch(\`/api/frame-at-timestamp?videoPath=\${encodeURIComponent(videoPath)}&timestamp=\${timestamp}\`);
                    const data = await response.json();
                    
                    document.getElementById('framePreview').src = data.base64Image;
                } catch (error) {
                    console.error('Failed to load frame:', error);
                }
            }
            
            function updateTimestamp(timestamp) {
                document.getElementById('currentTimestamp').textContent = formatTimestamp(timestamp);
            }
            
            function formatTimestamp(seconds) {
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = Math.floor(seconds % 60);
                return \`\${minutes}:\${String(remainingSeconds).padStart(2, '0')}\`;
            }
            
            async function seekFrame(offset) {
                const slider = document.getElementById('timelineSlider');
                const newTime = Math.max(0, Math.min(videoDuration, parseFloat(slider.value) + offset));
                slider.value = newTime;
                updateTimestamp(newTime);
                await updateFramePreview(newTime);
            }
            
            document.getElementById('timelineSlider').addEventListener('input', async function(e) {
                const timestamp = parseFloat(e.target.value);
                updateTimestamp(timestamp);
                await updateFramePreview(timestamp);
            });
            
            async function selectFrame() {
                const timestamp = parseFloat(document.getElementById('timelineSlider').value);
                const videoPath = activeVisual.dataset.videoPath;
                
                try {
                    const response = await fetch(\`/api/frame-at-timestamp?videoPath=\${encodeURIComponent(videoPath)}&timestamp=\${timestamp}\`);
                    const data = await response.json();
                    
                    // Update the visual element
                    const img = activeVisual.querySelector('img');
                    img.src = data.base64Image;
                    
                    // Update timestamp
                    activeVisual.dataset.timestamp = timestamp;
                    
                    // Update timestamp info
                    const timestampInfo = activeVisual.querySelector('.timestamp-info');
                    if (timestampInfo) {
                        timestampInfo.textContent = \`Video: \${videoPath.split('/').pop()} at \${formatTimestamp(timestamp)}\`;
                    }
                    
                    // Get section and step indices
                    const step = activeVisual.closest('.process-step');
                    const section = step.closest('.document-section');
                    const sections = Array.from(document.querySelectorAll('.document-section'));
                    const sectionIndex = sections.indexOf(section);
                    const stepIndex = Array.from(section.querySelectorAll('.process-step')).indexOf(step);
                    
                    // Get document ID from export button
                    const exportBtn = document.querySelector('.document-action-btn');
                    const documentId = exportBtn.getAttribute('data-document-id');
                    
                    if (!documentId) {
                        throw new Error('Document ID not found');
                    }
                    
                    // Update selected frame in document cache
                    const updateResponse = await fetch('/api/update-selected-frame', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            documentId,
                            sectionIndex,
                            stepIndex,
                            frameData: {
                                base64Image: data.base64Image,
                                videoPath,
                                timestamp,
                                caption: activeVisual.querySelector('.visual-caption')?.textContent || '',
                                success: true
                            }
                        })
                    });
                    
                    if (!updateResponse.ok) {
                        throw new Error('Failed to update document cache');
                    }
                    
                    const updateData = await updateResponse.json();
                    
                    // Update export button state and style
                    if (updateData.isReadyForPDF) {
                        exportBtn.style.opacity = '1';
                        exportBtn.style.cursor = 'pointer';
                        exportBtn.style.backgroundColor = '#4CAF50';
                        exportBtn.title = 'All frames selected - Ready to export PDF';
                    } else {
                        exportBtn.style.opacity = '0.5';
                        exportBtn.style.cursor = 'not-allowed';
                        exportBtn.style.backgroundColor = '#ccc';
                        exportBtn.title = 'Please select all required frames before exporting';
                    }
                    
                    // Close modal
                    const modal = document.getElementById('frameSelectionModal');
                    if (modal) {
                        modal.style.display = 'none';
                        activeVisual = null;
                    }
                    
                } catch (error) {
                    console.error('Failed to update frame:', error);
                    alert('Failed to update frame. Please try again.');
                }
            }
            
            // Close modal when clicking outside
            const modal = document.getElementById('frameSelectionModal');
            if (modal) {
                modal.addEventListener('click', function(e) {
                    if (e.target === this) {
                        this.style.display = 'none';
                        activeVisual = null;
                        // Reset preview image
                        const preview = document.getElementById('framePreview');
                        if (preview) {
                            preview.src = '';
                        }
                    }
                });
            }
            
            // Close modal with Escape key
            document.addEventListener('keydown', function(e) {
                const modal = document.getElementById('frameSelectionModal');
                if (e.key === 'Escape' && modal && modal.style.display === 'block') {
                    modal.style.display = 'none';
                    activeVisual = null;
                    // Reset preview image
                    const preview = document.getElementById('framePreview');
                    if (preview) {
                        preview.src = '';
                    }
                }
            });
        </script>
    `;
    
    return html;
}

function wrapHTMLForPDF(content) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <style>
        @page { 
            margin: 25mm 15mm;
            size: A4;
        }
        body { 
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background: white;
            margin: 0;
            padding: 0;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }
        .document-intro { margin-bottom: 30px; text-align: center; }
        .document-title { 
            color: #333;
            font-size: 24pt;
            font-weight: bold;
            margin-bottom: 15px;
        }
        .document-introduction { font-size: 12pt; margin-bottom: 20px; }
        .document-section { margin-bottom: 30px; }
        .section-title { 
            color: #333;
            font-size: 18pt;
            font-weight: bold;
            margin-bottom: 15px;
            border-bottom: 2px solid #333;
        }
        .process-step { 
            margin: 20px 0;
            padding: 15px;
            background: #f8f8f8;
            border-left: 3px solid #333;
        }
        .step-number { font-weight: bold; margin-bottom: 10px; }
        .step-content { margin-bottom: 15px; }
        .step-visual { margin: 15px 0; text-align: center; }
        .step-visual img { max-width: 100%; height: auto; }
        .visual-caption { 
            font-style: italic;
            color: #666;
            margin-top: 8px;
            font-size: 10pt;
        }
        @media print {
            body { background: white; }
            img { max-width: 100% !important; }
            button { display: none !important; }
        }
    </style>
        /* Reset and base styles */
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        
        body { 
            font-family: 'Arial', sans-serif; 
            line-height: 1.6; 
            color: #333;
            background: white;
            font-size: 12pt;
        }
        
        /* Page layout */
        @page {
            size: A4;
            margin: 25mm 15mm;
        }
        
        /* Document structure */
        .document-intro {
            margin-bottom: 30px;
            text-align: center;
            page-break-after: avoid;
        }
        
        .document-title { 
            color: #e53e3e; 
            font-size: 28pt; 
            font-weight: 700;
            margin-bottom: 15px;
            line-height: 1.2;
        }
        
        .document-introduction {
            font-size: 14pt;
            color: #4a5568;
            line-height: 1.6;
            margin-bottom: 20px;
        }
        
        /* Section styling */
        .document-section { 
            margin-bottom: 30px;
            page-break-inside: avoid;
        }
        
        .section-title { 
            color: #e53e3e; 
            font-size: 20pt; 
            font-weight: 600;
            margin-bottom: 15px;
            padding-bottom: 8px;
            border-bottom: 2px solid #e53e3e;
            page-break-after: avoid;
        }
        
        /* Step styling */
        .process-step { 
            margin: 20px 0;
            padding: 15px;
            background: #f8fafc;
            border-left: 4px solid #e53e3e;
            border-radius: 0 8px 8px 0;
            page-break-inside: avoid;
        }
        
        .step-number { 
            background: linear-gradient(135deg, #e53e3e, #f56500);
            color: white;
            padding: 5px 10px;
            border-radius: 12px;
            display: inline-block;
            margin-bottom: 10px;
            font-weight: 600;
            font-size: 11pt;
        }
        
        .step-content {
            font-size: 12pt;
            line-height: 1.7;
            color: #2d3748;
            margin-bottom: 15px;
        }
        
        /* Visual elements */
        .step-visual { 
            margin: 15px 0;
            text-align: center;
            page-break-inside: avoid;
        }
        
        .step-visual img {
            max-width: 100%;
            height: auto;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .visual-placeholder {
            max-width: 100%;
            margin: 10px auto;
        }
        
        .visual-caption {
            font-style: italic;
            color: #666;
            margin-top: 8px;
            font-size: 10pt;
            line-height: 1.4;
        }
        
        .caption-text {
            margin-bottom: 4px;
        }
        
        .timestamp-info {
            font-size: 9pt;
            color: #888;
        }
        
        /* Conclusion */
        .conclusion {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
        }
        
        .conclusion-content {
            font-size: 12pt;
            color: #4a5568;
            line-height: 1.7;
        }
        
        /* Print optimizations */
        @media print {
            body {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
                -webkit-font-smoothing: antialiased;
                margin: 0;
                padding: 0;
                min-height: 100vh;
            }

            /* Force image loading */
            img {
                display: block !important;
                break-inside: avoid !important;
                max-width: 100% !important;
                height: auto !important;
                page-break-before: auto !important;
                page-break-after: auto !important;
                page-break-inside: avoid !important;
            }

            /* Ensure all content is rendered */
            * {
                -webkit-print-color-adjust: exact !important;
                color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
            
            img {
                max-width: 100% !important;
                page-break-inside: avoid;
                display: block;
            }
            
            .document-section {
                break-inside: avoid;
                page-break-inside: avoid;
                margin-bottom: 20mm;
            }
            
            .process-step {
                break-inside: avoid;
                page-break-inside: avoid;
                margin: 10mm 0;
                background-color: #f8fafc !important;
                border-left: 4px solid #e53e3e !important;
            }
            
            .step-visual {
                break-inside: avoid;
                page-break-inside: avoid;
                margin: 8mm 0;
            }
            
            .step-number {
                background: linear-gradient(135deg, #e53e3e, #f56500) !important;
                color: white !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
            
            .visual-caption {
                margin-top: 3mm;
                font-size: 9pt;
            }
            
            /* Hide interactive elements */
            .change-frame-btn,
            .frame-selection-modal,
            button {
                display: none !important;
            }
            
            /* Force background colors and gradients */
            * {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
            
            /* Ensure proper page breaks */
            h1, h2 {
                page-break-after: avoid;
            }
            
            /* Ensure images are loaded */
            img {
                image-rendering: -webkit-optimize-contrast;
            }
        }
    </style>
</head>
<body>${content}</body>
</html>`;
}
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
    logger.log(`Knowledge Base ID: 0STV2BEIMA`);
    logger.log(`LLM Client: AWS Bedrock Claude 3.5 Sonnet`);
    logger.log(`Embedding Model: cohere.embed-multilingual-v3`);
    logger.log(`Embedding Cache: Enabled`);
    logger.log('Available endpoints:');
    logger.log('  /api/chat - Original agent method');
    logger.log('  /api/chat-direct - Fast direct KB method');
    logger.log('  /api/chat-smart - Smart routing (recommended)');
    logger.log('  /api/performance-test - Performance comparison');
});
