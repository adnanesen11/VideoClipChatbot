class IndustryStandardChatBot {
    constructor() {
        // DOM elements
        this.messagesContainer = document.getElementById('messages');
        this.messageInput = document.getElementById('messageInput');
        this.sendButton = document.getElementById('sendButton');
        this.videoContainer = document.getElementById('videoContainer');
        this.videoClipsContainer = document.getElementById('videoClips');
        this.loadingOverlay = document.getElementById('loadingOverlay');
        
        // INDUSTRY STANDARD: Enhanced state management with session support
        this.currentQuery = '';
        this.sessionId = null;
        this.kbSessionId = null; // NEW: Separate session for KB context
        this.clipAnalytics = new Map(); // Track clip interactions
        this.feedbackEnabled = true;
        this.performanceMode = 'smart'; // 'direct', 'agent', 'smart'
        this.performanceMetrics = [];
        
        // Frame selection state
        this.activeVisual = null;
        this.videoDuration = 0;
        
        // Validate required elements
        if (!this.messagesContainer || !this.messageInput || !this.sendButton || 
            !this.videoContainer || !this.videoClipsContainer || !this.loadingOverlay) {
            console.error('Required DOM elements not found');
            return;
        }
        
        this.initializeEventListeners();
        this.addWelcomeMessage();
        this.initializeAnalytics();
        this.addPerformanceModeSelector();
        this.initializeResizablePanes(); // NEW: Add resize functionality
    }
    
    // Frame Selection Methods with Enhanced Error Handling
    async openFrameSelection(btn) {
        try {
            const visual = btn.closest('.step-visual');
            if (!visual) {
                console.error('Could not find visual element');
                return;
            }

            const videoPath = visual.dataset.videoPath;
            const timestamp = parseFloat(visual.dataset.timestamp);
            
            if (!videoPath || isNaN(timestamp)) {
                console.error('Invalid video path or timestamp:', { videoPath, timestamp });
                return;
            }
            
            this.activeVisual = visual;
            
            // Get video metadata
            const metadataResponse = await fetch(`/api/video-metadata?videoPath=${encodeURIComponent(videoPath)}`);
            if (!metadataResponse.ok) {
                throw new Error(`Failed to get video metadata: ${metadataResponse.status}`);
            }
            
            const metadata = await metadataResponse.json();
            if (!metadata.duration) {
                throw new Error('Invalid video metadata: missing duration');
            }
            
            this.videoDuration = metadata.duration;
            
            // Update timeline
            const slider = document.getElementById('timelineSlider');
            if (!slider) {
                throw new Error('Timeline slider element not found');
            }
            
            slider.max = metadata.duration;
            slider.value = timestamp;
            
            const durationElement = document.getElementById('totalDuration');
            if (durationElement) {
                durationElement.textContent = this.formatTimestamp(metadata.duration);
            }
            
            this.updateTimestamp(timestamp);
            
            // Load initial frame
            await this.updateFramePreview(timestamp);
            
            // Show modal
            const modal = document.getElementById('frameSelectionModal');
            if (!modal) {
                throw new Error('Frame selection modal not found');
            }
            modal.style.display = 'block';
            
        } catch (error) {
            console.error('Failed to open frame selection:', error);
            this.addErrorMessage('Failed to open frame selection. Please try again.');
        }
    }
    
    async updateFramePreview(timestamp) {
        if (!this.activeVisual) {
            console.error('No active visual element');
            return;
        }
        
        const videoPath = this.activeVisual.dataset.videoPath;
        if (!videoPath) {
            console.error('No video path found');
            return;
        }
        
        try {
            const response = await fetch(`/api/frame-at-timestamp?videoPath=${encodeURIComponent(videoPath)}&timestamp=${timestamp}`);
            if (!response.ok) {
                throw new Error(`Failed to load frame: ${response.status}`);
            }
            
            const data = await response.json();
            if (!data.base64Image) {
                throw new Error('No image data received');
            }
            
            const framePreview = document.getElementById('framePreview');
            if (!framePreview) {
                throw new Error('Frame preview element not found');
            }
            
            framePreview.src = data.base64Image;
            framePreview.alt = `Frame at ${this.formatTimestamp(timestamp)}`;
            
        } catch (error) {
            console.error('Failed to update frame preview:', error);
            const framePreview = document.getElementById('framePreview');
            if (framePreview) {
                framePreview.src = '';
                framePreview.alt = 'Failed to load frame';
            }
        }
    }
    
    updateTimestamp(timestamp) {
        try {
            const element = document.getElementById('currentTimestamp');
            if (!element) {
                throw new Error('Timestamp element not found');
            }
            element.textContent = this.formatTimestamp(timestamp);
        } catch (error) {
            console.error('Failed to update timestamp:', error);
        }
    }
    
    async seekFrame(offset) {
        try {
            const slider = document.getElementById('timelineSlider');
            if (!slider) {
                throw new Error('Timeline slider not found');
            }
            
            if (!this.videoDuration) {
                throw new Error('Video duration not set');
            }
            
            const newTime = Math.max(0, Math.min(this.videoDuration, parseFloat(slider.value) + offset));
            slider.value = newTime;
            this.updateTimestamp(newTime);
            await this.updateFramePreview(newTime);
            
        } catch (error) {
            console.error('Failed to seek frame:', error);
        }
    }
    
    async selectFrame() {
        if (!this.activeVisual) {
            console.error('No active visual element');
            return;
        }
        
        try {
            const slider = document.getElementById('timelineSlider');
            if (!slider) {
                throw new Error('Timeline slider not found');
            }
            
            const timestamp = parseFloat(slider.value);
            if (isNaN(timestamp)) {
                throw new Error('Invalid timestamp');
            }
            
            const videoPath = this.activeVisual.dataset.videoPath;
            if (!videoPath) {
                throw new Error('No video path found');
            }
            
            const response = await fetch(`/api/frame-at-timestamp?videoPath=${encodeURIComponent(videoPath)}&timestamp=${timestamp}`);
            if (!response.ok) {
                throw new Error(`Failed to get frame: ${response.status}`);
            }
            
            const data = await response.json();
            if (!data.base64Image) {
                throw new Error('No image data received');
            }
            
            // Update the visual element
            const img = this.activeVisual.querySelector('img');
            if (!img) {
                throw new Error('Image element not found');
            }
            
            img.src = data.base64Image;
            this.activeVisual.dataset.timestamp = timestamp;
            
            // Update timestamp info
            const timestampInfo = this.activeVisual.querySelector('.timestamp-info');
            if (timestampInfo) {
                timestampInfo.textContent = `Video: ${videoPath.split('/').pop()} at ${this.formatTimestamp(timestamp)}`;
            }
            
            // Close modal
            const modal = document.getElementById('frameSelectionModal');
            if (modal) {
                modal.style.display = 'none';
            }
            
            this.activeVisual = null;
            
        } catch (error) {
            console.error('Failed to select frame:', error);
            this.addErrorMessage('Failed to update frame. Please try again.');
        }
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

        this.messageInput.addEventListener('input', () => {
            this.sendButton.disabled = !this.messageInput.value.trim();
        });
    }

    addWelcomeMessage() {
        const welcomeMessage = 'Hello! I\'m your Enterprise AI Video Assistant powered by Claude 3.5 Sonnet and AWS Knowledge Base. Ask questions about training content and receive AI-curated clips with semantic search intelligence. I now have multiple performance modes for optimal speed!';
        this.addMessage('assistant', welcomeMessage);
    }

    initializeAnalytics() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.trackEvent('page_hidden');
            } else {
                this.trackEvent('page_visible');
            }
        });
    }

    addPerformanceModeSelector() {
        const chatContainer = document.querySelector('.chat-container');
        if (!chatContainer) return;
        
        const modeSelector = document.createElement('div');
        modeSelector.className = 'performance-mode-selector';
        modeSelector.innerHTML = `
            <div class="mode-controls">
                <label>⚡ Mode:</label>
                <select id="performanceMode" class="mode-select">
                    <option value="smart">🎯 Smart Routing (Chat)</option>
                    <option value="direct">📚 Direct KB (Chat)</option>
                    <option value="agent">🤖 Agent (Chat)</option>
                    <option value="document">📄 Document Generation</option>
                </select>
                <button id="performanceTest" class="test-btn">🏁 Test Performance</button>
            </div>
            <div id="performanceStats" class="performance-stats"></div>
        `;
        
        const messagesContainer = document.getElementById('messages');
        if (messagesContainer && messagesContainer.parentNode) {
            messagesContainer.parentNode.insertBefore(modeSelector, messagesContainer);
        }
        
        const modeSelect = document.getElementById('performanceMode');
        const testButton = document.getElementById('performanceTest');
        
        if (modeSelect) {
            modeSelect.addEventListener('change', (e) => {
                const newMode = e.target.value;
                const oldMode = this.performanceMode;
                this.performanceMode = newMode;
                
                this.trackEvent('performance_mode_changed', { 
                    oldMode,
                    newMode,
                    hadDocument: !!this.videoContainer.querySelector('.document-container')
                });
                
                if (oldMode === 'document' && newMode !== 'document') {
                    this.videoContainer.className = 'video-container';
                    this.videoContainer.innerHTML = '<div id="videoClips"></div>';
                    this.videoClipsContainer = document.getElementById('videoClips');
                } else if (oldMode !== 'document' && newMode === 'document') {
                    this.videoContainer.innerHTML = '';
                }
                
                if (this.messageInput) {
                    this.messageInput.placeholder = this.performanceMode === 'document' 
                        ? "Describe the process or training document you need..." 
                        : "Ask about training content...";
                }
                
                this.messagesContainer.innerHTML = '';
                this.addWelcomeMessage();
                
                this.updatePerformanceStats();
            });
        }
        
        if (testButton) {
            testButton.addEventListener('click', () => this.runPerformanceTest());
        }
    }

    initializeResizablePanes() {
        const main = document.querySelector('.main');
        if (!main) return;
        
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'resize-handle';
        
        const chatContainer = document.querySelector('.chat-container');
        const videoContainer = document.querySelector('.video-container');
        
        if (chatContainer && videoContainer) {
            main.insertBefore(resizeHandle, videoContainer);
            
            let isResizing = false;
            let startX = 0;
            let startLeftWidth = 0;
            let startRightWidth = 0;
            
            resizeHandle.addEventListener('mousedown', (e) => {
                isResizing = true;
                startX = e.clientX;
                
                const mainRect = main.getBoundingClientRect();
                const chatRect = chatContainer.getBoundingClientRect();
                const videoRect = videoContainer.getBoundingClientRect();
                
                startLeftWidth = chatRect.width;
                startRightWidth = videoRect.width;
                
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                
                e.preventDefault();
            });
            
            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                
                const deltaX = e.clientX - startX;
                const mainRect = main.getBoundingClientRect();
                const totalWidth = mainRect.width - 8;
                
                const newLeftWidth = startLeftWidth + deltaX;
                const newRightWidth = startRightWidth - deltaX;
                
                if (newLeftWidth >= 300 && newRightWidth >= 300) {
                    const leftPercent = (newLeftWidth / totalWidth) * 100;
                    const rightPercent = (newRightWidth / totalWidth) * 100;
                    
                    main.style.gridTemplateColumns = `${leftPercent}% 8px ${rightPercent}%`;
                }
                
                e.preventDefault();
            });
            
            document.addEventListener('mouseup', () => {
                if (isResizing) {
                    isResizing = false;
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                }
            });
            
            resizeHandle.addEventListener('dblclick', () => {
                main.style.gridTemplateColumns = '1fr 8px 1fr';
            });
        }
    }

    async sendMessage() {
        if (!this.messageInput) return;
        
        const message = this.messageInput.value.trim();
        if (!message) return;
        
        this.currentQuery = message;
        const startTime = Date.now();

        if (this.performanceMode === 'document') {
            await this.generateDocument(message);
            return;
        }

        this.trackEvent('query_sent', { 
            query_length: message.length,
            performance_mode: this.performanceMode,
            timestamp: startTime
        });
        
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.sendButton.disabled = true;
        this.setLoading(true);
        
        try {
            const endpoint = this.getEndpointForMode(this.performanceMode);
            
            const requestPayload = { 
                message,
                method: this.performanceMode 
            };
            
            if (this.performanceMode === 'direct' && this.kbSessionId) {
                requestPayload.sessionId = this.kbSessionId;
            } else if (this.performanceMode !== 'direct' && this.sessionId) {
                requestPayload.sessionId = this.sessionId;
            }
            
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestPayload),
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }
            
            // Calculate performance metrics
            const endTime = Date.now();
            const processingTime = endTime - startTime;
            
            const performanceData = {
                processing_time: processingTime,
                method_used: data.metadata?.method || this.performanceMode,
                has_clips: !!(data.videoClips && data.videoClips.length > 0),
                clip_count: data.videoClips?.length || 0,
                has_llm_enhancement: data.metadata?.hasLLMEnhancement || false,
                kb_time: data.metadata?.kbProcessingTime,
                clip_time: data.metadata?.clipProcessingTime,
                total_server_time: data.metadata?.totalProcessingTime
            };
            
            this.performanceMetrics.push(performanceData);
            this.trackEvent('response_received', performanceData);
            
            if (data.metadata?.method === 'direct_kb') {
                this.kbSessionId = data.sessionId;
            } else {
                this.sessionId = data.sessionId;
            }
            
            this.addMessage('assistant', data.response.trim());
            
            if (data.metadata?.totalProcessingTime) {
                const perfData = {
                    total: data.metadata.totalProcessingTime + 's',
                    method: data.metadata.method
                };
                
                if (data.metadata.kbProcessingTime) {
                    perfData.kbRetrieveGenerate = data.metadata.kbProcessingTime + 's';
                }
                if (data.metadata.clipProcessingTime) {
                    perfData.clipExtraction = data.metadata.clipProcessingTime + 's';
                }
                if (data.metadata.agentTime) {
                    perfData.agentProcessing = data.metadata.agentTime + 's';
                }
                if (data.metadata.processingTime) {
                    perfData.responseProcessing = data.metadata.processingTime + 's';
                }
                
                this.addPerformanceInfo(perfData, data.metadata.method);
            }
            
            if (data.videoClips && data.videoClips.length > 0) {
                this.displayIndustryStandardClips(data.videoClips);
            } else {
                this.addNoClipsMessage();
            }
            
            this.updatePerformanceStats();
            
        } catch (error) {
            console.error('Error:', error);
            this.trackEvent('error_occurred', { 
                error_type: error.name,
                performance_mode: this.performanceMode 
            });
            this.addErrorMessage('Sorry, there was an error processing your request. Please try again.');
        } finally {
            this.setLoading(false);
            this.sendButton.disabled = false;
        }
    }

    getEndpointForMode(mode) {
        switch (mode) {
            case 'direct':
                return '/api/chat-direct';
            case 'agent':
                return '/api/chat';
            case 'smart':
            default:
                return '/api/chat-smart';
        }
    }

    addMessage(sender, content) {
        if (!this.messagesContainer) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}`;
        
        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'message-bubble';
        
        const cleanContent = content.trim();
        
        if (sender === 'assistant' && cleanContent.includes('\n')) {
            bubbleDiv.innerHTML = cleanContent.replace(/\n/g, '<br>');
        } else {
            bubbleDiv.textContent = cleanContent;
        }
        
        messageDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom();
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
            
            if (loading) {
                const loadingMessages = {
                    'direct': '📚 Using Direct Knowledge Base (Fastest)',
                    'agent': '🤖 Using Agent Processing (Comprehensive)',
                    'smart': '🎯 Smart Routing - Finding Best Method'
                };
                
                this.loadingOverlay.innerHTML = `
                    <div class="loading-content">
                        <div class="spinner"></div>
                        <div class="loading-text">
                            <div>${loadingMessages[this.performanceMode] || '🔍 Processing your request...'}</div>
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

    async generateDocument(message) {
        const startTime = Date.now();
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.sendButton.disabled = true;
        this.setLoading(true);
    
        try {
            this.trackEvent('document_generation_started', { query: message });
            
            const response = await fetch('/api/generate-document', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: message })
            });
            
            if (!response.ok) {
                throw new Error(`Failed to generate document: ${response.status}`);
            }
            
            const data = await response.json();
            if (!data || !data.documentId) {
                throw new Error('Invalid document data received');
            }
            
            const processingTime = Date.now() - startTime;
            this.trackEvent('document_generation_complete', {
                documentId: data.documentId,
                processingTime,
                title: data.title
            });
            
            this.addMessage('assistant', 'I\'ve generated your process document. You can see it in the right panel.');
            
            // Display document
            try {
                await this.displayDocument(data);
            } catch (displayError) {
                console.error('Error displaying document:', displayError);
                this.addErrorMessage('The document was generated but there was an error displaying it. Please try refreshing the page.');
                return;
            }
            
        } catch (error) {
            console.error('Error:', error);
            let errorMessage = 'Sorry, there was an error generating your document.';
            
            if (error.message.includes('Failed to generate')) {
                errorMessage = 'Failed to generate the document. Please try again.';
            } else if (error.message.includes('Invalid document data')) {
                errorMessage = 'The server returned invalid document data. Please try again.';
            }
            
            this.trackEvent('document_generation_error', {
                error: error.message,
                errorType: error.name,
                processingTime: Date.now() - startTime
            });
            
            this.addErrorMessage(errorMessage);
        } finally {
            this.setLoading(false);
            this.sendButton.disabled = false;
        }
    }

    displayDocument(data) {
        if (!this.videoContainer) return;
        
        // Reset container
        this.videoContainer.innerHTML = '';
        this.videoContainer.className = 'document-container';
        
        // Create document wrapper for proper spacing
        const documentWrapper = document.createElement('div');
        documentWrapper.className = 'document-wrapper';
        
        const headerDiv = document.createElement('div');
        headerDiv.className = 'document-header';
        headerDiv.innerHTML = `
            <h3>${data.title || 'Process Document'}</h3>
            <div class="document-actions">
                <button class="document-action-btn" onclick="window.open('/api/export-pdf?id=${data.documentId}', '_blank')">
                    📥 Export PDF
                </button>
            </div>
        `;
        documentWrapper.appendChild(headerDiv);
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'document-content';
        
        // Add metadata section
        const metadataDiv = document.createElement('div');
        metadataDiv.className = 'document-metadata';
        metadataDiv.innerHTML = `
            <div class="metadata-item">
                <span class="metadata-label">Generated:</span>
                <span class="metadata-value">${new Date().toLocaleString()}</span>
            </div>
            <div class="metadata-item">
                <span class="metadata-label">Document ID:</span>
                <span class="metadata-value">${data.documentId}</span>
            </div>
        `;
        contentDiv.appendChild(metadataDiv);
        
        // Add main content with proper spacing
        const mainContent = document.createElement('div');
        mainContent.className = 'document-main-content';
        mainContent.innerHTML = data.htmlContent;
        contentDiv.appendChild(mainContent);
        
        documentWrapper.appendChild(contentDiv);
        this.videoContainer.appendChild(documentWrapper);
        
        // Add print styles for PDF export
        const styleSheet = document.createElement('style');
        styleSheet.textContent = `
            @media print {
                .document-wrapper {
                    padding: 20mm;
                }
                .document-header {
                    margin-bottom: 10mm;
                }
                .document-content {
                    font-size: 11pt;
                    line-height: 1.6;
                }
                .document-metadata {
                    margin-bottom: 8mm;
                }
                .process-step {
                    page-break-inside: avoid;
                    margin: 5mm 0;
                }
                .step-visual {
                    page-break-inside: avoid;
                    margin: 5mm 0;
                }
                .document-actions {
                    display: none;
                }
            }
        `;
        document.head.appendChild(styleSheet);
        
        this.videoContainer.style.display = 'block';
    }

    addPerformanceInfo(performance, method) {
        if (!this.messagesContainer) return;
        
        const perfDiv = document.createElement('div');
        perfDiv.className = 'performance-info';
        
        const methodName = {
            'direct_kb': '📚 Direct Knowledge Base',
            'agent': '🤖 Agent Processing',
            'agent_fallback': '🔄 Agent Fallback'
        }[method] || method;
        
        const perfButton = document.createElement('button');
        perfButton.className = 'performance-popup-btn';
        perfButton.textContent = 'Performance';
        
        const perfDetails = `
            <strong>${methodName}</strong><br><br>
            ${performance.kbRetrieveGenerate ? `KB Processing: ${performance.kbRetrieveGenerate}<br>` : ''}
            ${performance.clipExtraction ? `Clip Extraction: ${performance.clipExtraction}<br>` : ''}
            <strong>Total Time: ${performance.total}</strong>
        `;
        
        perfButton.addEventListener('click', () => {
            this.showPerformanceModal(perfDetails);
        });
        
        perfDiv.appendChild(perfButton);
        this.messagesContainer.appendChild(perfDiv);
        this.scrollToBottom();
    }

    showPerformanceModal(details) {
        const modal = document.createElement('div');
        modal.className = 'performance-modal';
        modal.innerHTML = `
            <div class="performance-modal-content">
                <div class="performance-modal-header">
                    <div class="performance-modal-title">⚡ Performance Breakdown</div>
                    <button class="modal-close-btn">&times;</button>
                </div>
                <div class="performance-modal-details">${details}</div>
            </div>
        `;
        
        const closeBtn = modal.querySelector('.modal-close-btn');
        closeBtn.addEventListener('click', () => modal.remove());
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
        
        document.body.appendChild(modal);
        
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
    }

    updatePerformanceStats() {
        const statsDiv = document.getElementById('performanceStats');
        if (!statsDiv) return;
        
        if (this.performanceMetrics.length === 0) {
            statsDiv.style.display = 'none';
            return;
        }
        
        statsDiv.style.display = 'block';
        
        const recentMetrics = this.performanceMetrics.slice(-5);
        const avgTime = recentMetrics.reduce((sum, m) => sum + m.processing_time, 0) / recentMetrics.length;
        const avgClips = recentMetrics.reduce((sum, m) => sum + m.clip_count, 0) / recentMetrics.length;
        
        const currentModeMetrics = recentMetrics.filter(m => m.method_used.includes(this.performanceMode));
        const currentModeAvg = currentModeMetrics.length > 0 ? 
            currentModeMetrics.reduce((sum, m) => sum + m.processing_time, 0) / currentModeMetrics.length : 0;
        
        statsDiv.innerHTML = `
            <div class="stats-content">
                <div class="stat-item">
                    <span class="stat-label">Avg Response Time:</span>
                    <span class="stat-value">${(avgTime / 1000).toFixed(1)}s</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Avg Clips Found:</span>
                    <span class="stat-value">${avgClips.toFixed(1)}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Current Mode Avg:</span>
                    <span class="stat-value">${currentModeAvg > 0 ? (currentModeAvg / 1000).toFixed(1) : 'N/A'}s</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Total Queries:</span>
                    <span class="stat-value">${this.performanceMetrics.length}</span>
                </div>
            </div>
        `;
    }

    trackEvent(eventName, data = {}) {
        const event = {
            timestamp: new Date().toISOString(),
            event: eventName,
            sessionId: this.sessionId,
            query: this.currentQuery,
            ...data
        };
        
        console.log('📊 Analytics Event:', event);
    }

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
        
        // Handle feedback
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
}

// Initialize chatbot
function initializeChatBot() {
    console.log('🚀 Initializing Training Video Assistant with Performance Modes...');
    try {
        window.chatBot = new IndustryStandardChatBot();
        console.log('✅ ChatBot initialized successfully');
        console.log('📊 Available performance modes:');
        console.log('  🎯 Smart Routing (Recommended) - Auto-selects best method');
        console.log('  📚 Direct KB (Fastest) - Direct knowledge base access');
        console.log('  🤖 Agent (Comprehensive) - Full agent processing');
    } catch (error) {
        console.error('❌ Failed to initialize ChatBot:', error);
        setTimeout(initializeChatBot, 500);
    }
}

// Enhanced frame selection event handlers
window.openFrameSelection = function(btn) {
    if (!window.chatBot) {
        console.error('ChatBot not initialized');
        return;
    }
    window.chatBot.openFrameSelection(btn);
};

window.seekFrame = function(offset) {
    if (!window.chatBot) {
        console.error('ChatBot not initialized');
        return;
    }
    window.chatBot.seekFrame(offset);
};

window.selectFrame = function() {
    if (!window.chatBot) {
        console.error('ChatBot not initialized');
        return;
    }
    window.chatBot.selectFrame();
};

// Enhanced modal event listeners
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('frameSelectionModal');
    const slider = document.getElementById('timelineSlider');
    
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
                if (window.chatBot) {
                    window.chatBot.activeVisual = null;
                }
            }
        });
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'block') {
                modal.style.display = 'none';
                if (window.chatBot) {
                    window.chatBot.activeVisual = null;
                }
            }
        });
    } else {
        console.error('Frame selection modal not found');
    }
    
    if (slider) {
        slider.addEventListener('input', async (e) => {
            if (window.chatBot) {
                try {
                    const timestamp = parseFloat(e.target.value);
                    if (isNaN(timestamp)) {
                        throw new Error('Invalid timestamp');
                    }
                    window.chatBot.updateTimestamp(timestamp);
                    await window.chatBot.updateFramePreview(timestamp);
                } catch (error) {
                    console.error('Error updating frame:', error);
                }
            }
        });
    } else {
        console.error('Timeline slider not found');
    }
});

// Multiple initialization strategies
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeChatBot);
} else if (document.readyState === 'interactive' || document.readyState === 'complete') {
    initializeChatBot();
} else {
    setTimeout(initializeChatBot, 100);
}

window.addEventListener('load', () => {
    if (!window.chatBot) {
        console.log('🔄 Retrying ChatBot initialization on window load...');
        initializeChatBot();
    }
});

console.log('📝 Industry Standard ChatBot with Performance Modes script loaded successfully');
