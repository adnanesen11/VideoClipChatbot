class IndustryStandardChatBot {
    constructor() {
        // DOM elements
        this.messagesContainer = document.getElementById('messages');
        this.messageInput = document.getElementById('messageInput');
        this.sendButton = document.getElementById('sendButton');
        this.videoContainer = document.getElementById('videoContainer');
        this.videoClipsContainer = document.getElementById('videoClips');
        this.loadingOverlay = document.getElementById('loadingOverlay');
        
        // INDUSTRY STANDARD: Enhanced state management
        this.currentQuery = '';
        this.sessionId = null;
        this.clipAnalytics = new Map(); // Track clip interactions
        this.feedbackEnabled = true;
        
        // Validate required elements
        if (!this.messagesContainer || !this.messageInput || !this.sendButton || 
            !this.videoContainer || !this.videoClipsContainer || !this.loadingOverlay) {
            console.error('Required DOM elements not found');
            return;
        }
        
        this.initializeEventListeners();
        this.addWelcomeMessage();
        this.initializeAnalytics();
    }
    
    initializeEventListeners() {
        if (!this.sendButton || !this.messageInput) return;
        
        this.sendButton.addEventListener('click', () => this.sendMessage());
        this.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // INDUSTRY STANDARD: Enhanced input handling
        this.messageInput.addEventListener('input', () => {
            this.sendButton.disabled = !this.messageInput.value.trim();
        });
    }

    // INDUSTRY STANDARD: Analytics and feedback tracking
    initializeAnalytics() {
        // Track page visibility for engagement metrics
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.trackEvent('page_hidden');
            } else {
                this.trackEvent('page_visible');
            }
        });
    }
    
    addWelcomeMessage() {
        const welcomeMessage = 'Hello! I\'m your Enterprise AI Video Assistant powered by Claude 3.5 Sonnet and AWS Knowledge Base. Ask questions about training content and receive AI-curated clips with semantic search intelligence.';
        this.addMessage('assistant', welcomeMessage);
    }
    
    async sendMessage() {
        if (!this.messageInput) return;
        
        const message = this.messageInput.value.trim();
        if (!message) return;
        
        // INDUSTRY STANDARD: Store query for analytics
        this.currentQuery = message;
        this.trackEvent('query_sent', { query_length: message.length });
        
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.sendButton.disabled = true;
        this.setLoading(true);
        
        const startTime = Date.now();
        
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message }),
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            const processingTime = Date.now() - startTime;
            
            if (data.error) {
                throw new Error(data.error);
            }
            
            // INDUSTRY STANDARD: Track response metrics
            this.trackEvent('response_received', {
                processing_time: processingTime,
                has_clips: !!(data.videoClips && data.videoClips.length > 0),
                clip_count: data.videoClips?.length || 0,
                has_llm_enhancement: data.metadata?.hasLLMEnhancement || false
            });
            
            this.sessionId = data.sessionId;
            this.addMessage('assistant', data.response);
            
            if (data.sources && data.sources.length > 0) {
                this.addSourceInfo(data.sources);
            }
            
            if (data.videoClips && data.videoClips.length > 0) {
                this.displayIndustryStandardClips(data.videoClips);
            } else {
                this.addNoClipsMessage();
            }
            
        } catch (error) {
            console.error('Error:', error);
            this.trackEvent('error_occurred', { error_type: error.name });
            this.addErrorMessage('Sorry, there was an error processing your request. Please try again.');
        } finally {
            this.setLoading(false);
            this.sendButton.disabled = false;
        }
    }
    
    addMessage(sender, content) {
        if (!this.messagesContainer) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}`;
        
        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'message-bubble';
        
        // INDUSTRY STANDARD: Support for rich content
        if (sender === 'assistant' && content.includes('\n')) {
            bubbleDiv.innerHTML = content.replace(/\n/g, '<br>');
        } else {
            bubbleDiv.textContent = content;
        }
        
        messageDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom();
    }
    
    addSourceInfo(sources) {
        if (!this.messagesContainer || !sources || sources.length === 0) return;
        
        const sourceDiv = document.createElement('div');
        sourceDiv.className = 'source-info';
        
        // INDUSTRY STANDARD: Enhanced source display
        if (sources.length === 1) {
            sourceDiv.innerHTML = `📄 <strong>Source:</strong> ${sources[0].title}`;
        } else {
            sourceDiv.innerHTML = `📄 <strong>Sources:</strong> ${sources.map(s => s.title).join(', ')}`;
        }
            
        this.messagesContainer.appendChild(sourceDiv);
        this.scrollToBottom();
    }

    // INDUSTRY STANDARD: Enhanced clip display with feedback
    displayIndustryStandardClips(clips) {
        if (!this.videoClipsContainer || !this.videoContainer || !clips || clips.length === 0) return;
        
        this.videoClipsContainer.innerHTML = '';
        
        // Add header with clip count and AI indicator
        const headerDiv = document.createElement('div');
        headerDiv.className = 'clips-header';
        headerDiv.innerHTML = `
            <h3>🎯 Relevant Video Clips (${clips.length})</h3>
            ${clips.some(c => c.aiGenerated) ? '<span class="ai-badge">🤖 AI-Curated</span>' : ''}
        `;
        this.videoClipsContainer.appendChild(headerDiv);

        clips.forEach((clip, index) => {
            const clipId = `clip-${Date.now()}-${index}`;
            const clipDiv = document.createElement('div');
            clipDiv.className = 'video-clip industry-standard';
            clipDiv.setAttribute('data-clip-id', clipId);
            
            const videoId = `video-${index}`;
            const duration = Math.round(clip.endTime - clip.startTime);
            
            clipDiv.innerHTML = `
                <div class="clip-header">
                    <div class="clip-metadata">
                        <span class="clip-index">#${index + 1}</span>
                        <span class="clip-duration">${duration}s</span>
                        ${clip.relevanceScore ? `<span class="relevance-score">⭐ ${Math.round(clip.relevanceScore * 100)}%</span>` : ''}
                        ${clip.aiGenerated ? '<span class="ai-generated">🤖 AI</span>' : ''}
                    </div>
                </div>
                
                <video id="${videoId}" controls preload="metadata" class="industry-video">
                    <source src="${clip.videoPath}#t=${clip.startTime},${clip.endTime}" type="video/mp4">
                    Your browser does not support the video tag.
                </video>
                
                <div class="video-info enhanced">
                    <div class="video-title">${clip.title}</div>
                    <div class="video-timestamp">
                        ⏱️ ${this.formatTimestamp(clip.startTime)} - ${this.formatTimestamp(clip.endTime)}
                        <button class="play-clip-btn modern" data-video-id="${videoId}" data-start="${clip.startTime}" data-end="${clip.endTime}">
                            ▶️ Play Clip
                        </button>
                    </div>
                    <div class="video-description">${clip.description}</div>
                    
                    ${clip.keyTopics && clip.keyTopics.length > 0 ? `
                        <div class="key-topics">
                            <strong>📋 Key Topics:</strong> 
                            ${clip.keyTopics.map(topic => `<span class="topic-tag">${topic}</span>`).join('')}
                        </div>
                    ` : ''}
                    
                    ${this.feedbackEnabled ? `
                        <div class="clip-feedback">
                            <span class="feedback-label">Was this clip helpful?</span>
                            <button class="feedback-btn" data-feedback="helpful" data-clip-id="${clipId}">👍</button>
                            <button class="feedback-btn" data-feedback="not-helpful" data-clip-id="${clipId}">👎</button>
                            <button class="feedback-btn" data-feedback="report" data-clip-id="${clipId}">⚠️</button>
                        </div>
                    ` : ''}
                </div>
            `;
            
            this.videoClipsContainer.appendChild(clipDiv);
            this.setupClipInteractions(clipDiv, clip, clipId, videoId);
        });
        
        this.videoContainer.style.display = 'block';
        this.trackEvent('clips_displayed', { count: clips.length });
    }

    // INDUSTRY STANDARD: Enhanced clip interaction handling
    setupClipInteractions(clipDiv, clip, clipId, videoId) {
        const video = document.getElementById(videoId);
        const playButton = clipDiv.querySelector('.play-clip-btn');
        const feedbackButtons = clipDiv.querySelectorAll('.feedback-btn');
        
        if (video && playButton) {
            // Enhanced video control
            video.addEventListener('loadedmetadata', () => {
                video.currentTime = clip.startTime;
            });
            
            playButton.addEventListener('click', () => {
                this.trackClipInteraction(clipId, 'play');
                video.currentTime = clip.startTime;
                video.play();
                playButton.textContent = '⏸️ Playing...';
                playButton.disabled = true;
            });
            
            // Auto-stop at end time with better UX
            video.addEventListener('timeupdate', () => {
                if (video.currentTime >= clip.endTime) {
                    video.pause();
                    video.currentTime = clip.startTime;
                    playButton.textContent = '🔄 Play Again';
                    playButton.disabled = false;
                    this.trackClipInteraction(clipId, 'completed');
                }
            });
            
            // Track video events
            video.addEventListener('play', () => this.trackClipInteraction(clipId, 'video_play'));
            video.addEventListener('pause', () => this.trackClipInteraction(clipId, 'video_pause'));
            video.addEventListener('seeked', () => this.trackClipInteraction(clipId, 'video_seek'));
        }
        
        // INDUSTRY STANDARD: Feedback handling
        feedbackButtons.forEach(button => {
            button.addEventListener('click', () => {
                const feedback = button.getAttribute('data-feedback');
                this.submitClipFeedback(clipId, feedback, clip);
                
                // Visual feedback
                button.style.backgroundColor = feedback === 'helpful' ? '#4CAF50' : 
                                              feedback === 'not-helpful' ? '#f44336' : '#ff9800';
                button.disabled = true;
                
                // Disable other feedback buttons
                feedbackButtons.forEach(btn => btn.disabled = true);
            });
        });
    }

    // INDUSTRY STANDARD: Feedback submission
    async submitClipFeedback(clipId, feedback, clip) {
        try {
            await fetch('/api/clip-feedback', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    clipId,
                    feedback,
                    rating: feedback === 'helpful' ? 5 : feedback === 'not-helpful' ? 1 : 3,
                    query: this.currentQuery,
                    clipData: {
                        title: clip.title,
                        relevanceScore: clip.relevanceScore,
                        duration: clip.endTime - clip.startTime,
                        aiGenerated: clip.aiGenerated
                    }
                })
            });
            
            this.trackEvent('feedback_submitted', { feedback, clipId });
            
        } catch (error) {
            console.error('Failed to submit feedback:', error);
        }
    }

    // INDUSTRY STANDARD: Analytics tracking
    trackClipInteraction(clipId, action) {
        if (!this.clipAnalytics.has(clipId)) {
            this.clipAnalytics.set(clipId, {
                views: 0,
                plays: 0,
                completions: 0,
                seeks: 0
            });
        }
        
        const analytics = this.clipAnalytics.get(clipId);
        
        switch (action) {
            case 'view':
                analytics.views++;
                break;
            case 'play':
            case 'video_play':
                analytics.plays++;
                break;
            case 'completed':
                analytics.completions++;
                break;
            case 'video_seek':
                analytics.seeks++;
                break;
        }
        
        this.trackEvent('clip_interaction', { clipId, action, analytics });
    }

    trackEvent(eventName, data = {}) {
        // INDUSTRY STANDARD: Event tracking for analytics
        const event = {
            timestamp: new Date().toISOString(),
            event: eventName,
            sessionId: this.sessionId,
            query: this.currentQuery,
            ...data
        };
        
        console.log('📊 Analytics Event:', event);
        
        // TODO: Send to analytics service (Google Analytics, Mixpanel, etc.)
        // analytics.track(eventName, event);
    }
    
    addErrorMessage(message) {
        if (!this.messagesContainer) return;
        
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message enhanced';
        errorDiv.innerHTML = `❌ <strong>Error:</strong> ${message}`;
        this.messagesContainer.appendChild(errorDiv);
        this.scrollToBottom();
    }

    addNoClipsMessage() {
        if (!this.messagesContainer) return;
        
        const noClipsDiv = document.createElement('div');
        noClipsDiv.className = 'info-message';
        noClipsDiv.innerHTML = `
            ℹ️ <strong>No video clips found</strong> for this query. The response above contains all available information.
            <br><small>Try rephrasing your question or asking about specific topics covered in the training videos.</small>
        `;
        this.messagesContainer.appendChild(noClipsDiv);
        this.scrollToBottom();
    }
    
    formatTimestamp(seconds) {
        if (typeof seconds !== 'number') {
            console.error('Invalid timestamp format:', seconds);
            return '0:00';
        }
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
    
    setLoading(loading) {
        if (this.loadingOverlay) {
            this.loadingOverlay.style.display = loading ? 'flex' : 'none';
            
            // INDUSTRY STANDARD: Enhanced loading states
            if (loading) {
                this.loadingOverlay.innerHTML = `
                    <div class="loading-content">
                        <div class="spinner"></div>
                        <div class="loading-text">
                            <div>🔍 Searching video content...</div>
                            <div class="loading-subtext">Using AI to find the most relevant clips</div>
                        </div>
                    </div>
                `;
            }
        }
        
        if (this.sendButton) {
            this.sendButton.disabled = loading;
        }
        if (this.messageInput) {
            this.messageInput.disabled = loading;
        }
    }
    
    scrollToBottom() {
        if (this.messagesContainer) {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }
    }
}

// FIXED: Robust initialization that works regardless of DOM state
function initializeChatBot() {
    console.log('🚀 Initializing Training Video Assistant...');
    try {
        window.chatBot = new IndustryStandardChatBot();
        console.log('✅ ChatBot initialized successfully');
    } catch (error) {
        console.error('❌ Failed to initialize ChatBot:', error);
        // Retry after a short delay
        setTimeout(initializeChatBot, 500);
    }
}

// Multiple initialization strategies to ensure it always works
if (document.readyState === 'loading') {
    // DOM hasn't finished loading
    document.addEventListener('DOMContentLoaded', initializeChatBot);
} else if (document.readyState === 'interactive' || document.readyState === 'complete') {
    // DOM is already loaded
    initializeChatBot();
} else {
    // Fallback - try after a short delay
    setTimeout(initializeChatBot, 100);
}

// Additional safety net - try initialization on window load as well
window.addEventListener('load', () => {
    if (!window.chatBot) {
        console.log('🔄 Retrying ChatBot initialization on window load...');
        initializeChatBot();
    }
});

console.log('📝 Industry Standard ChatBot script loaded successfully');