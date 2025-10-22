const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');

class VideoGenerator {
  constructor(videosDirectory = './videos', outputDirectory = './generated_videos') {
    this.videosDirectory = videosDirectory;
    this.outputDirectory = outputDirectory;
    this.segmentCache = new Map();
    this.durationCache = new Map();
    this.logger = console;
  }

  async initialize() {
    await fs.mkdir(this.outputDirectory, { recursive: true });
    
    // Test FFmpeg capabilities
    await this.testFFmpegCapabilities();
  }

  async testFFmpegCapabilities() {
    return new Promise((resolve) => {
      // Test if lavfi protocol is available
      ffmpeg()
        .input('lavfi:testsrc=duration=1:size=320x240:rate=1')
        .output('/dev/null')
        .on('error', (err) => {
          this.logger.log('⚠️  lavfi protocol not available, using fallback methods');
          this.lavfiSupported = false;
          resolve();
        })
        .on('end', () => {
          this.logger.log('✅ lavfi protocol supported');
          this.lavfiSupported = true;
          resolve();
        })
        .run();
    });
  }

  // ---------- logging helpers ----------
  logStart(cmd) { try { this.logger.log(`FFmpeg start: ${cmd}`); } catch(_){} }
  logError(prefix, err) { try { this.logger.error(`${prefix}: ${err?.message || err}`);} catch(_){} }

  // ---------- ffprobe helpers ----------
  async getVideoDurationSec(inputPath) {
    const key = path.resolve(inputPath);
    if (this.durationCache.has(key)) return this.durationCache.get(key);

    const seconds = await new Promise((resolve) => {
      ffmpeg.ffprobe(inputPath, (err, meta) => {
        if (err || !meta) return resolve(NaN);
        let dur = Number(meta?.format?.duration);
        if (!Number.isFinite(dur)) {
          // fallback: max of stream durations if present
          const sDur = (meta.streams || [])
            .map(s => Number(s.duration))
            .filter(Number.isFinite);
          dur = sDur.length ? Math.max(...sDur) : NaN;
        }
        resolve(dur);
      });
    });

    if (Number.isFinite(seconds)) this.durationCache.set(key, seconds);
    return seconds;
  }

  async ffprobeHasVideo(inputPath) {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(inputPath, (err, meta) => {
        if (err || !meta) return resolve(false);
        const hasVideo = (meta.streams || []).some(s => s.codec_type === 'video');
        resolve(hasVideo);
      });
    });
  }

  // ---------- FIXED: Better timestamp handling ----------
  normalizeTimestamp(timestamp) {
    // Handle different timestamp formats
    if (typeof timestamp === 'string') {
      // Handle MM:SS or HH:MM:SS format
      if (timestamp.includes(':')) {
        const parts = timestamp.split(':').map(Number);
        if (parts.length === 2) {
          return parts[0] * 60 + parts[1]; // MM:SS
        } else if (parts.length === 3) {
          return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
        }
      }
      timestamp = parseFloat(timestamp);
    }
    
    // Convert to number and handle edge cases
    let num = Number(timestamp) || 0;
    
    // FIXED: Detect Unix timestamps (13 digits) vs video timestamps
    if (num > 1000000000000) { // Unix timestamp in milliseconds (13+ digits)
      this.logger.log(`⚠️  Detected Unix timestamp: ${num}, this seems wrong for video timing`);
      // This is likely an error - Unix timestamps shouldn't be used for video timing
      // Return a safe fallback timestamp
      return 30; // Default to 30 seconds into video
    }
    
    // If timestamp seems too large (likely milliseconds), convert to seconds
    if (num > 10000 && num < 1000000000) { // Between 10k and 1B (likely milliseconds)
      return num / 1000;
    }
    
    return Math.max(0, num);
  }

  normalizeTimes(rawStart, rawEnd, videoDurationSec) {
    let start = this.normalizeTimestamp(rawStart);
    let end = this.normalizeTimestamp(rawEnd);

    this.logger.log(`Raw timestamps: start=${rawStart}, end=${rawEnd}`);
    this.logger.log(`Normalized timestamps: start=${start}s, end=${end}s`);

    // Ensure end is after start
    if (end <= start) {
      end = start + 5.0; // Default 5-second segment
    }

    // Ensure minimum segment duration
    const minDuration = 3.0;
    if ((end - start) < minDuration) {
      end = start + minDuration;
    }

    // Clamp to video duration if known
    if (Number.isFinite(videoDurationSec) && videoDurationSec > 0) {
      const safeEndBuffer = 2.0; // 2 second buffer from end
      const maxEnd = videoDurationSec - safeEndBuffer;
      
      // If segment would go beyond video end, adjust both start and end
      if (end > maxEnd) {
        const segmentDuration = end - start;
        end = maxEnd;
        start = Math.max(0, end - segmentDuration);
      }
      
      // Final clamp to ensure we're within bounds
      start = Math.max(0, Math.min(start, maxEnd - minDuration));
      end = Math.max(start + minDuration, Math.min(end, maxEnd));
    }

    this.logger.log(`Final timestamps: start=${start.toFixed(3)}s, end=${end.toFixed(3)}s (duration: ${(end-start).toFixed(3)}s)`);
    return { start, end };
  }

  // ---------- text escaping ----------
  escapeDrawtext(s = '') {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\\\'")
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  // ---------- core steps ----------
  async extractVideoSegment(videoPath, startTimeSec, endTimeSec) {
    const segmentId = `${path.basename(videoPath).replace(/[^\w.-]/g, '_')}-${startTimeSec.toFixed(3)}-${endTimeSec.toFixed(3)}`;
    if (this.segmentCache.has(segmentId)) return this.segmentCache.get(segmentId);

    try {
      const outputPath = path.join(this.outputDirectory, `segment-${segmentId}.mp4`);
      
      const actualStart = Math.max(0, startTimeSec);
      const duration = endTimeSec - actualStart;
      
      this.logger.log(`Extracting segment: start=${actualStart.toFixed(3)}s, duration=${duration.toFixed(3)}s from ${path.basename(videoPath)}`);

      // Check if file already exists and remove it
      if (fsSync.existsSync(outputPath)) {
        try {
          fsSync.unlinkSync(outputPath);
        } catch (e) {
          this.logger.log(`Warning: Could not remove existing file ${outputPath}`);
        }
      }

      await new Promise((resolve, reject) => {
        const command = ffmpeg(videoPath)
          .seekInput(actualStart)
          .duration(duration)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions([
            '-b:v', '2000k',
            '-b:a', '192k',
            '-r', '30',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-preset', 'fast',
            '-crf', '23'
          ])
          .size('1280x720')
          .on('start', (cmd) => this.logStart(cmd))
          .on('end', () => {
            this.logger.log(`Successfully extracted segment: ${outputPath}`);
            resolve(outputPath);
          })
          .on('error', (err) => {
            this.logError(`Failed to extract segment ${segmentId}`, err);
            reject(err);
          });

        // Add timeout to prevent hanging
        const timeout = setTimeout(() => {
          command.kill('SIGKILL');
          reject(new Error(`Extraction timeout for segment ${segmentId}`));
        }, 45000); // 45 second timeout

        command.on('end', () => clearTimeout(timeout));
        command.on('error', () => clearTimeout(timeout));

        command.output(outputPath).run();
      });

      // Verify the extracted segment is valid before caching
      const hasVideo = await this.ffprobeHasVideo(outputPath);
      if (!hasVideo) {
        throw new Error(`Extracted segment ${segmentId} has no video stream`);
      }

      this.segmentCache.set(segmentId, outputPath);
      return outputPath;
    } catch (error) {
      this.logError('Failed to extract video segment', error);
      throw error;
    }
  }

  async addCaptions(inputPath, outputPath, text) {
    // Verify input before processing
    const hasVideo = await this.ffprobeHasVideo(inputPath);
    if (!hasVideo) {
      this.logger.error(`No video stream found in ${inputPath}. Cannot add captions.`);
      throw new Error(`Invalid input video: ${inputPath}`);
    }

    const safe = this.escapeDrawtext(text || '');
    const filter =
      "scale=1280:720:force_original_aspect_ratio=decrease," +
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2," +
      `drawtext=text='${safe}':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.5:boxborderw=5:x=(w-text_w)/2:y=h-text_h-10`;

    try {
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions([
            '-r', '30',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart'
          ])
          .videoFilters(filter)
          .on('start', (cmd) => this.logStart(cmd))
          .on('end', () => {
            this.logger.log(`Successfully added captions: ${outputPath}`);
            resolve();
          })
          .on('error', reject)
          .output(outputPath)
          .run();
      });
    } catch (err) {
      // Missing drawtext/freetype or quoting trouble: fall back to no-text
      this.logError('drawtext failed; falling back to no-text transcode', err);
      await this.simpleTranscode(inputPath, outputPath);
    }
  }

  async simpleTranscode(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-r', '30',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart'
        ])
        .videoFilters("scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2")
        .on('start', (cmd) => this.logStart(cmd))
        .on('end', () => {
          this.logger.log(`Successfully transcoded: ${outputPath}`);
          resolve();
        })
        .on('error', reject)
        .output(outputPath)
        .run();
    });
  }

  // ---------- FIXED: Fallback transition creation ----------
  async createTransition(duration = 1) {
    // Skip transitions entirely if lavfi not supported
    if (!this.lavfiSupported) {
      this.logger.log('Skipping transitions (lavfi not supported)');
      return null;
    }
    
    const transitionPath = path.join(this.outputDirectory, `transition-${duration}s.mp4`);
    if (fsSync.existsSync(transitionPath)) return transitionPath;

    return this.createLavfiTransition(transitionPath, duration);
  }

  async createLavfiTransition(outputPath, duration) {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(`lavfi:color=c=black:s=1280x720:d=${duration}`)
        .input(`lavfi:anullsrc=channel_layout=stereo:sample_rate=48000`)
        .outputOptions([
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-r', '30',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-shortest'
        ])
        .complexFilter([
          `[0:v]fps=30,format=yuv420p,fade=t=in:st=0:d=${Math.min(0.5, duration/2)},fade=t=out:st=${Math.max(0, duration-0.5)}:d=${Math.min(0.5, duration/2)}[v]`
        ])
        .outputOptions(['-map', '[v]', '-map', '1:a'])
        .on('start', (cmd) => this.logStart(cmd))
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .output(outputPath)
        .run();
    });
  }

  async createFallbackTransition(outputPath, duration) {
    // Create a simple black video using a static image approach
    const tempImagePath = path.join(this.outputDirectory, 'temp_black.png');
    
    // Create a black image first (fallback method)
    return new Promise((resolve, reject) => {
      // Create black image using FFmpeg
      ffmpeg()
        .input('color=black:size=1280x720')
        .inputFormat('lavfi')
        .frames(1)
        .output(tempImagePath)
        .on('error', (err) => {
          // If lavfi still fails, try a different approach
          this.createStaticTransition(outputPath, duration).then(resolve).catch(reject);
        })
        .on('end', () => {
          // Now create video from the image
          ffmpeg()
            .input(tempImagePath)
            .inputOptions(['-loop', '1'])
            .duration(duration)
            .videoCodec('libx264')
            .outputOptions([
              '-r', '30',
              '-pix_fmt', 'yuv420p',
              '-movflags', '+faststart'
            ])
            .on('start', (cmd) => this.logStart(cmd))
            .on('end', () => {
              // Clean up temp image
              fs.unlink(tempImagePath).catch(() => {});
              resolve(outputPath);
            })
            .on('error', reject)
            .output(outputPath)
            .run();
        })
        .run();
    });
  }

  async createStaticTransition(outputPath, duration) {
    // Ultimate fallback: create a minimal black transition
    return new Promise((resolve, reject) => {
      const frames = Math.ceil(duration * 30); // 30 fps
      ffmpeg()
        .input('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
        .inputOptions(['-f', 'image2pipe', '-loop', '1'])
        .frames(frames)
        .videoCodec('libx264')
        .outputOptions([
          '-r', '30',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart'
        ])
        .on('start', (cmd) => this.logStart(cmd))
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .output(outputPath)
        .run();
    });
  }

  // ---------- FIXED: Fallback title card creation ----------
  async createTitleCard(title, duration = 3) {
    const titlePath = path.join(this.outputDirectory, `title-${uuidv4()}.mp4`);

    if (this.lavfiSupported) {
      return this.createLavfiTitleCard(titlePath, title, duration);
    } else {
      return this.createFallbackTitleCard(titlePath, title, duration);
    }
  }

  async createLavfiTitleCard(outputPath, title, duration) {
    const safe = this.escapeDrawtext(title || '');
    
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(`lavfi:color=c=black:s=1280x720:d=${duration}`)
        .input(`lavfi:anullsrc=channel_layout=stereo:sample_rate=48000`)
        .outputOptions([
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-r', '30',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-shortest'
        ])
        .complexFilter([
          `[0:v]drawtext=text='${safe}':fontcolor=white:fontsize=48:box=1:boxcolor=black@0.5:boxborderw=5:x=(w-text_w)/2:y=(h-text_h)/2[v]`
        ])
        .outputOptions(['-map', '[v]', '-map', '1:a'])
        .on('start', (cmd) => this.logStart(cmd))
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .output(outputPath)
        .run();
    });
  }

  async createFallbackTitleCard(outputPath, title, duration) {
    // Create title card without lavfi - use a simple approach
    const tempDir = path.join(this.outputDirectory, 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    
    // Skip title card if lavfi not available - just create a black video
    return this.createTransition(duration);
  }

  async generateVideo(segments, documentData = {}) {
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('No segments provided.');
    }

    // Deduplicate segments based on content and timing
    const uniqueSegments = this.deduplicateSegments(segments);
    this.logger.log(`Deduplicated ${segments.length} segments to ${uniqueSegments.length} unique segments`);

    const outputId = uuidv4();
    const finalOutput = path.join(this.outputDirectory, `final-${outputId}.mp4`);
    const tempDir = path.join(this.outputDirectory, 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    try {
      this.logger.log(`🎬 Generating video with ${uniqueSegments.length} segments`);
      
      // Create transition (only if supported)
      let transitionPath = null;
      if (this.lavfiSupported) {
        transitionPath = await this.createTransition(1);
      }

      // Process segments sequentially to avoid resource conflicts
      const processedSegments = [];
      
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        this.logger.log(`Processing segment ${i + 1}/${segments.length}: ${segment.type || 'content'}`);

        if (segment.type === 'title' || segment.type === 'section_title' || segment.type === 'conclusion') {
          // Create title card for title/section/conclusion
          try {
            // Longer duration for title cards to improve readability
            const duration = segment.type === 'title' ? 8 : // Increased from 5 to 8
                           segment.type === 'section_title' ? 5 : // Increased from 3 to 5
                           segment.duration || 6; // Increased from 4 to 6
            
            const titlePath = await this.createTitleCard(segment.title, duration);
            if (titlePath) {
              processedSegments.push({
                path: titlePath,
                type: segment.type,
                text: segment.text,
                duration: duration
              });
            }
          } catch (err) {
            this.logError(`Failed to create ${segment.type} card`, err);
          }
          continue;
        }

        if (segment.type === 'transition') {
          if (transitionPath) {
            processedSegments.push({
              path: transitionPath,
              type: 'transition',
              duration: segment.duration || 1.5 // Increased from 1 to 1.5
            });
          }
          continue;
        }

        // Process content segment
        if (!segment.videoPath) {
          this.logError(`Missing videoPath for segment ${i}`);
          continue;
        }

        const rel = segment.videoPath.replace(/^\/?videos\//, '');
        const videoPath = path.join(this.videosDirectory, rel);

        // Get real duration
        const durSec = await this.getVideoDurationSec(videoPath);
        this.logger.log(`Video duration: ${durSec.toFixed(3)}s`);

        // Calculate optimal clip duration based on content and importance
        const textLength = segment.text.length;
        const minDuration = 15; // Increased from 10 to 15
        const maxDuration = 45; // Increased from 30 to 45
        const wordsPerSecond = 2.0; // Reduced from 2.5 to 2.0 for better comprehension
        
        // Enhanced duration calculation
        const baseEstimatedDuration = Math.ceil(textLength / (wordsPerSecond * 5));
        const importanceMultiplier = segment.type === 'content' ? 1.2 : 1.0;
        const estimatedDuration = Math.ceil(baseEstimatedDuration * importanceMultiplier);
        
        // Add buffer for complex content
        const complexityBuffer = textLength > 200 ? 5 : 0;
        const optimalDuration = Math.min(maxDuration, Math.max(minDuration, estimatedDuration + complexityBuffer));

        // Improved lead-in and lead-out timing
        const leadIn = 3; // Increased from 2 to 3
        const leadOut = 3; // Increased from 2 to 3
        const totalDuration = optimalDuration + leadIn + leadOut;

        // Calculate start and end times with better context
        const centerTimestamp = segment.startTime;
        const contextWindow = 5; // Added 5-second context window
        const start = Math.max(0, centerTimestamp - (totalDuration / 2) - contextWindow);
        const end = Math.min(durSec, start + totalDuration + (contextWindow * 2));

        // Extract segment
        const segmentPath = await this.extractVideoSegment(videoPath, start, end);
        
        // Add captions with retry logic and better formatting
        const captionedPath = path.join(tempDir, `captioned-${outputId}-${i}.mp4`);
        
        try {
          // Enhanced caption with better formatting
          const captionText = segment.sectionTitle ? 
            `${segment.sectionTitle}\n${segment.stepNumber ? `Step ${segment.stepNumber}: ` : ''}${segment.text}` :
            segment.text;

          await this.addCaptions(segmentPath, captionedPath, captionText);
        } catch (err) {
          this.logError(`Caption failed for segment ${i}, using segment without captions`, err);
          await fs.copyFile(segmentPath, captionedPath);
        }

        processedSegments.push({
          path: captionedPath,
          type: 'content',
          text: segment.text,
          stepNumber: segment.stepNumber,
          duration: end - start,
          importance: segment.type === 'content' ? 1.2 : 1.0
        });
      }

      // Build final video with enhanced transitions and timing
      const allParts = [];
      let totalDuration = 0;
      let previousType = null;
      
      for (let i = 0; i < processedSegments.length; i++) {
        const current = processedSegments[i];
        
        // Add transition from previous segment if needed
        if (i > 0 && transitionPath) {
          const prev = processedSegments[i - 1];
          
          // Enhanced transition logic
          const needsTransition = 
            prev.type !== current.type || // Different segment types
            (current.type === 'content' && prev.type === 'content' && 
             (current.stepNumber !== prev.stepNumber || // Different steps
              current.importance > prev.importance)); // Importance change
          
          if (needsTransition) {
            allParts.push(transitionPath);
            totalDuration += 1.5; // Transition duration
          }
        }
        
        // Add current segment
        allParts.push(current.path);
        totalDuration += current.duration || 0;
        
        previousType = current.type;
      }

      this.logger.log(`Total video duration will be approximately ${Math.round(totalDuration)} seconds`);

      this.logger.log(`Concatenating ${allParts.length} video files...`);

      // FIXED: Declare filesToCleanup at the beginning
      let filesToCleanup = [...processedSegments];

      // Handle the simple case of just segments (no transitions/titles)
      if (allParts.length === processedSegments.length && allParts.every((part, i) => part === processedSegments[i])) {
        this.logger.log('Simple concatenation of segments only');
        
        // For simple cases, just concatenate the segments directly
        if (processedSegments.length === 1) {
          // Single segment - just copy it
          await fs.copyFile(processedSegments[0], finalOutput);
          this.logger.log(`✅ Single segment copied to: ${finalOutput}`);
        } else {
          // Multiple segments - use simple concat
          const fileListPath = path.join(tempDir, 'filelist.txt');
          const fileListContent = processedSegments
            .map(p => `file '${path.resolve(p).replace(/\\/g, '/')}'`)
            .join('\n');
          
          await fs.writeFile(fileListPath, fileListContent);

          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(fileListPath)
              .inputOptions(['-f', 'concat', '-safe', '0'])
              .videoCodec('copy') // Just copy streams for speed
              .audioCodec('copy')
              .on('start', (cmd) => this.logStart(cmd))
              .on('end', () => {
                this.logger.log(`✅ Successfully concatenated ${processedSegments.length} segments: ${finalOutput}`);
                resolve();
              })
              .on('error', reject)
              .output(finalOutput)
              .run();
          });
        }
      } else {
        // Complex case with transitions/titles - normalize and concat
        const normalizedParts = await Promise.all(allParts.map(async (inputPath, index) => {
          const normalizedPath = path.join(tempDir, `normalized-${index}.mp4`);
          
          await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
              .videoCodec('libx264')
              .audioCodec('aac')
              .outputOptions([
                '-r', '30',
                '-pix_fmt', 'yuv420p',
                '-s', '1280x720',
                '-movflags', '+faststart',
                '-crf', '23',
                '-preset', 'fast'
              ])
              .on('start', (cmd) => this.logStart(cmd))
              .on('end', resolve)
              .on('error', reject)
              .output(normalizedPath)
              .run();
          });
          
          return normalizedPath;
        }));

        // Add normalized parts to cleanup list
        filesToCleanup.push(...normalizedParts);

        // Create file list for concat demuxer
        const fileListPath = path.join(tempDir, 'filelist.txt');
        const fileListContent = normalizedParts
          .map(p => `file '${path.resolve(p).replace(/\\/g, '/')}'`)
          .join('\n');
        
        await fs.writeFile(fileListPath, fileListContent);

        // Use concat demuxer for final concatenation
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(fileListPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-movflags', '+faststart',
              '-r', '30',
              '-pix_fmt', 'yuv420p'
            ])
            .on('start', (cmd) => this.logStart(cmd))
            .on('end', () => {
              this.logger.log(`✅ Successfully generated final video: ${finalOutput}`);
              resolve();
            })
            .on('error', reject)
            .output(finalOutput)
            .run();
        });
      }

      // FIXED: Clean up all files
      await this.cleanup(tempDir, filesToCleanup);
      return finalOutput;

    } catch (err) {
      this.logError('Failed to generate video', err);
      await this.cleanup(tempDir);
      throw err;
    }
  }

  deduplicateSegments(segments) {
    // Track seen segments to avoid duplicates
    const seen = new Map();
    const uniqueSegments = [];
    
    for (const segment of segments) {
      // Skip invalid segments
      if (!segment || (segment.type === 'content' && !segment.videoPath)) {
        continue;
      }

      // Special segments (titles, transitions) are always kept
      if (segment.type === 'title' || segment.type === 'section_title' || 
          segment.type === 'transition' || segment.type === 'conclusion') {
        uniqueSegments.push(segment);
        continue;
      }

      // For content segments, check for duplicates
      if (segment.type === 'content') {
        const key = this.getSegmentKey(segment);
        const existing = seen.get(key);

        if (!existing) {
          // New unique segment
          seen.set(key, segment);
          uniqueSegments.push(segment);
        } else {
          // Check if this segment is better than the existing one
          if (this.isBetterSegment(segment, existing)) {
            // Replace existing with better segment
            const index = uniqueSegments.indexOf(existing);
            if (index !== -1) {
              uniqueSegments[index] = segment;
              seen.set(key, segment);
            }
          }
          // Otherwise keep existing segment
        }
      }
    }

    return uniqueSegments;
  }

  getSegmentKey(segment) {
    // Create a unique key based on content and timing
    const videoPath = segment.videoPath.replace(/^\/videos\//, '');
    const text = segment.text || '';
    const timing = `${Math.round(segment.startTime)}-${Math.round(segment.endTime)}`;
    return `${videoPath}:${timing}:${text.substring(0, 50)}`;
  }

  isBetterSegment(newSeg, existingSeg) {
    // Prefer segments with:
    // 1. Higher relevance/quality scores
    // 2. Better duration (closer to optimal)
    // 3. More complete metadata
    
    const optimalDuration = 30; // Target duration in seconds
    
    const getScore = (seg) => {
      let score = 0;
      
      // Relevance score (0-1)
      score += (seg.relevanceScore || 0) * 2;
      
      // Quality score (0-1) 
      score += (seg.qualityScore || 0) * 2;
      
      // Duration score (0-1, based on closeness to optimal)
      const duration = seg.endTime - seg.startTime;
      const durationScore = 1 - Math.min(1, Math.abs(duration - optimalDuration) / optimalDuration);
      score += durationScore;
      
      // Metadata completeness (0-1)
      const hasMetadata = ['title', 'description', 'keyTopics'].filter(k => seg[k]).length / 3;
      score += hasMetadata;
      
      return score;
    };
    
    return getScore(newSeg) > getScore(existingSeg);
  }

  async cleanup(tempDir, files = []) {
    try {
      // Wait a bit for Windows to release file handles
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to delete files with retries
      for (const file of files) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (fsSync.existsSync(file)) {
              await fs.unlink(file);
              break;
            }
          } catch (err) {
            if (attempt === 2) {
              this.logError(`Failed to delete ${file} after 3 attempts`, err);
            } else {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        }
      }
      
      // Try to remove temp directory
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        this.logError(`Failed to remove temp directory ${tempDir}`, err);
      }
    } catch (error) {
      this.logError('Cleanup error', error);
    }
  }
}

module.exports = VideoGenerator;
