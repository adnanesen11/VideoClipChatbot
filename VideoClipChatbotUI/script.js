// Sidebar functionality
const menuBtn = document.querySelector('.menu');
const sidebar = document.querySelector('.sidebar');

// Accordion
const accordions = Array.from(document.querySelectorAll('.accordion'));

// Helper to measure content height even if currently hidden
function computeHeight(content) {
  if (!content) return 0;
  if (content.scrollHeight > 0) return content.scrollHeight;

  const prev = {
    position: content.style.position || '',
    visibility: content.style.visibility || '',
    display: content.style.display || '',
    maxHeight: content.style.maxHeight || ''
  };

  content.style.position = 'absolute';
  content.style.visibility = 'hidden';
  content.style.display = 'block';
  content.style.maxHeight = 'none';

  const h = content.scrollHeight || 0;

  content.style.position = prev.position;
  content.style.visibility = prev.visibility;
  content.style.display = prev.display;
  content.style.maxHeight = prev.maxHeight;

  return h;
}

function openAccordion(acc) {
  if (!acc) return;
  const title = acc.querySelector('.accordion-title');
  const content = acc.querySelector('.accordion-description');
  if (!title || !content) return;

  accordions.forEach(a => {
    if (a !== acc) {
      const t = a.querySelector('.accordion-title');
      const c = a.querySelector('.accordion-description');
      if (t) t.classList.remove('active');
      if (c) c.style.maxHeight = null;
    }
  });

  title.classList.add('active');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const h = computeHeight(content);
      content.style.maxHeight = h ? h + 'px' : null;
    });
  });
}

function closeAccordion(acc) {
  if (!acc) return;
  const title = acc.querySelector('.accordion-title');
  const content = acc.querySelector('.accordion-description');
  if (!title || !content) return;
  title.classList.remove('active');
  content.style.maxHeight = null;
}

accordions.forEach(acc => {
  const title = acc.querySelector('.accordion-title');
  if (!title) return;
  title.addEventListener('click', () => {
    if (title.classList.contains('active')) closeAccordion(acc);
    else openAccordion(acc);
  });
});

if (menuBtn) {
  menuBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    if (sidebar.classList.contains('open')) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (accordions.length) openAccordion(accordions[0]);
        });
      });
    }
  });
}

// Chat functionality - Agent Mode Only
class VideoAssistantChatBot {
    constructor() {
        // DOM elements
        this.messagesContainer = document.getElementById('messages');
        this.messageInput = document.getElementById('messageInput');
        this.videoContainer = document.getElementById('videoContainer');
        this.videoClipsContainer = document.getElementById('videoClips');
        this.loadingOverlay = document.getElementById('loadingOverlay');

        // State management
        this.currentQuery = '';
        this.sessionId = null;
        this.clipAnalytics = new Map();
        this.feedbackEnabled = true;

        // Performance mode - check sessionStorage for mode
        this.performanceMode = sessionStorage.getItem('appMode') || 'agent';

        // Frame selection state
        this.activeVisual = null;
        this.videoDuration = 0;

        // Validate required elements
        if (!this.messagesContainer || !this.messageInput ||
            !this.videoContainer || !this.videoClipsContainer || !this.loadingOverlay) {
            console.error('Required DOM elements not found');
            return;
        }

        // Check for initial query BEFORE initializing listeners
        const initialQuery = sessionStorage.getItem('initialQuery');
        this.hasInitialQuery = !!initialQuery;

        this.initializeEventListeners();

        // Update input placeholder based on mode
        this.updatePlaceholder();

        // Only show welcome message if there's no initial query from landing page
        if (!this.hasInitialQuery) {
            this.addWelcomeMessage();
        }

        this.initializeAnalytics();
    }

    updatePlaceholder() {
        if (!this.messageInput) return;

        if (this.performanceMode === 'document') {
            this.messageInput.placeholder = 'Describe the process or training document you need...';
        } else {
            this.messageInput.placeholder = 'Ask about training content...';
        }
    }

    // Frame Selection Methods
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

            const metadataResponse = await fetch(`/api/video-metadata?videoPath=${encodeURIComponent(videoPath)}`);
            if (!metadataResponse.ok) {
                throw new Error(`Failed to get video metadata: ${metadataResponse.status}`);
            }

            const metadata = await metadataResponse.json();
            if (!metadata.duration) {
                throw new Error('Invalid video metadata: missing duration');
            }

            this.videoDuration = metadata.duration;

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
            await this.updateFramePreview(timestamp);

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

            const img = this.activeVisual.querySelector('img');
            if (!img) {
                throw new Error('Image element not found');
            }

            img.src = data.base64Image;
            this.activeVisual.dataset.timestamp = timestamp;

            const timestampInfo = this.activeVisual.querySelector('.timestamp-info');
            if (timestampInfo) {
                timestampInfo.textContent = `Video: ${videoPath.split('/').pop()} at ${this.formatTimestamp(timestamp)}`;
            }

            const step = this.activeVisual.closest('.process-step');
            const section = step.closest('.document-section');
            const sections = Array.from(document.querySelectorAll('.document-section'));
            const sectionIndex = sections.indexOf(section);
            const stepIndex = Array.from(section.querySelectorAll('.process-step')).indexOf(step);

            const exportBtn = document.querySelector('.document-action-btn');
            const documentId = exportBtn.getAttribute('data-document-id');
            if (!documentId) {
                throw new Error('Document ID not found');
            }

            let retryCount = 0;
            const maxRetries = 3;
            let updateSuccess = false;

            while (retryCount < maxRetries && !updateSuccess) {
                try {
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
                                timestamp: timestamp,
                                caption: this.activeVisual.querySelector('.visual-caption')?.textContent || '',
                                success: true,
                                selectedAt: new Date().toISOString()
                            }
                        })
                    });

                    if (!updateResponse.ok) {
                        throw new Error(`Failed to update document cache: ${updateResponse.status}`);
                    }

                    const updateData = await updateResponse.json();

                    // Update both PDF and Video buttons
                    const videoBtn = document.querySelector(`.document-action-btn.video-btn[data-document-id="${documentId}"]`);

                    if (updateData.isReadyForPDF) {
                        exportBtn.style.opacity = '1';
                        exportBtn.style.cursor = 'pointer';
                        exportBtn.style.backgroundColor = '#4CAF50';
                        exportBtn.title = 'All frames selected - Ready to export PDF';

                        if (videoBtn) {
                            videoBtn.style.opacity = '1';
                            videoBtn.style.cursor = 'pointer';
                            videoBtn.style.backgroundColor = '#667eea';
                            videoBtn.title = 'All frames selected - Ready to generate video';
                        }
                    } else {
                        exportBtn.style.opacity = '0.5';
                        exportBtn.style.cursor = 'not-allowed';
                        exportBtn.style.backgroundColor = '#ccc';
                        exportBtn.title = 'Please select all required frames before exporting';

                        if (videoBtn) {
                            videoBtn.style.opacity = '0.5';
                            videoBtn.style.cursor = 'not-allowed';
                            videoBtn.style.backgroundColor = '#ccc';
                            videoBtn.title = 'Please select all required frames before generating video';
                        }
                    }

                    updateSuccess = true;
                    console.log(`✅ Frame selected: ${videoPath} at ${timestamp}s (${this.formatTimestamp(timestamp)})`);

                } catch (error) {
                    retryCount++;
                    if (retryCount === maxRetries) {
                        throw error;
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                }
            }

            const modal = document.getElementById('frameSelectionModal');
            if (modal) {
                modal.style.display = 'none';
                const preview = document.getElementById('framePreview');
                if (preview) {
                    preview.src = '';
                }
            }

            this.activeVisual = null;

        } catch (error) {
            console.error('Failed to select frame:', error);
            this.addErrorMessage(`Failed to update frame: ${error.message}`);

            const preview = document.getElementById('framePreview');
            if (preview) {
                preview.src = '';
            }
        }
    }

    // Document Generation Methods
    async generateDocument(message) {
        const startTime = Date.now();
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.setLoading(true);
        this.addLoadingMessage();

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

            this.removeLoadingMessage();
            this.addMessage('assistant', 'I\'ve generated your process document. You can see it in the right panel.');

            // Display document
            try {
                this.displayDocument(data);
            } catch (displayError) {
                console.error('Error displaying document:', displayError);
                this.addErrorMessage('The document was generated but there was an error displaying it. Please try refreshing the page.');
                return;
            }

        } catch (error) {
            console.error('Error:', error);
            this.removeLoadingMessage();
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
                <button class="document-action-btn" data-document-id="${data.documentId}" onclick="exportPDF('${data.documentId}')" style="opacity: 0.5; cursor: not-allowed;">
                    📥 Export PDF
                </button>
                <button class="document-action-btn video-btn" data-document-id="${data.documentId}" onclick="generateVideo('${data.documentId}')" style="opacity: 0.5; cursor: not-allowed; margin-left: 10px;">
                    🎥 Generate Video
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
        // Remove any existing export buttons from the content
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = data.htmlContent;
        const exportButtons = tempDiv.querySelectorAll('.document-actions');
        exportButtons.forEach(btn => btn.remove());
        mainContent.innerHTML = tempDiv.innerHTML;
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

    initializeEventListeners() {
        if (!this.messageInput) return;

        this.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Check for initial query from welcome page
        if (this.hasInitialQuery) {
            const initialQuery = sessionStorage.getItem('initialQuery');
            if (initialQuery) {
                sessionStorage.removeItem('initialQuery');
                this.messageInput.value = initialQuery;

                // Auto-submit after a brief delay to ensure everything is loaded
                // Don't add loading message here - sendMessage() will do it
                setTimeout(() => {
                    this.sendMessage();
                }, 300);
            }
        }
    }

    addWelcomeMessage() {
        const welcomeMessage = 'Hello! I\'m your Enterprise AI Video Assistant powered by Claude 3.5 Sonnet and AWS Bedrock Agent. Ask questions about training content and receive AI-curated clips with semantic search intelligence.';
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

    async sendMessage() {
        if (!this.messageInput) return;

        const message = this.messageInput.value.trim();
        if (!message) return;

        // Check if we're in document generation mode
        if (this.performanceMode === 'document') {
            await this.generateDocument(message);
            return;
        }

        this.currentQuery = message;
        const startTime = Date.now();

        this.trackEvent('query_sent', {
            query_length: message.length,
            timestamp: startTime
        });

        this.addMessage('user', message);
        this.messageInput.value = '';
        this.setLoading(true);

        // Add loading message
        this.addLoadingMessage();

        try {
            const requestPayload = {
                message,
                stream: true
            };

            if (this.sessionId) {
                requestPayload.sessionId = this.sessionId;
            }

            let response = await fetch('/api/chat-stream', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestPayload),
            });

            // Fallback to non-streaming if streaming endpoint not available
            if (!response.ok && response.status === 404) {
                console.warn('Streaming endpoint not available, falling back to regular endpoint');
                this.removeLoadingMessage();
                this.addLoadingMessage();

                response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ message, sessionId: this.sessionId }),
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                // Handle non-streaming response
                const data = await response.json();
                this.removeLoadingMessage();

                if (data.error) {
                    throw new Error(data.error);
                }

                this.sessionId = data.sessionId;
                this.addMessage('assistant', data.response.trim());

                const endTime = Date.now();
                const processingTime = endTime - startTime;

                if (data.metadata?.totalProcessingTime) {
                    const perfData = {
                        total: data.metadata.totalProcessingTime + 's',
                        method: 'agent'
                    };

                    if (data.metadata.agentTime) {
                        perfData.agentProcessing = data.metadata.agentTime + 's';
                    }
                    if (data.metadata.processingTime) {
                        perfData.responseProcessing = data.metadata.processingTime + 's';
                    }
                    if (data.metadata.clipProcessingTime) {
                        perfData.clipExtraction = data.metadata.clipProcessingTime + 's';
                    }

                    this.addPerformanceInfo(perfData);
                }

                if (data.videoClips && data.videoClips.length > 0) {
                    this.displayVideoClips(data.videoClips);
                } else {
                    this.addNoClipsMessage();
                }

                this.trackEvent('response_received', {
                    processing_time: processingTime,
                    method_used: 'agent',
                    has_clips: !!(data.videoClips && data.videoClips.length > 0),
                    clip_count: data.videoClips?.length || 0,
                });

                return;
            }

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Remove loading message before streaming
            this.removeLoadingMessage();

            // Create assistant message bubble for streaming
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message assistant';
            const bubbleDiv = document.createElement('div');
            bubbleDiv.className = 'message-bubble';
            messageDiv.appendChild(bubbleDiv);
            this.messagesContainer.appendChild(messageDiv);

            let fullResponse = '';
            let metadata = null;
            let videoClips = null;
            let sessionId = null;

            // Read the stream
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));

                            if (data.type === 'content') {
                                fullResponse += data.text;
                                bubbleDiv.textContent = fullResponse;
                                this.scrollToBottom();
                            } else if (data.type === 'metadata') {
                                metadata = data.metadata;
                                sessionId = data.sessionId;
                            } else if (data.type === 'clips') {
                                videoClips = data.clips;
                            } else if (data.type === 'error') {
                                throw new Error(data.message);
                            }
                        } catch (e) {
                            // Skip invalid JSON lines
                            if (line.trim() !== '') {
                                console.warn('Failed to parse stream chunk:', line, e);
                            }
                        }
                    }
                }
            }

            const endTime = Date.now();
            const processingTime = endTime - startTime;

            const performanceData = {
                processing_time: processingTime,
                method_used: 'agent',
                has_clips: !!(videoClips && videoClips.length > 0),
                clip_count: videoClips?.length || 0,
                has_llm_enhancement: metadata?.hasLLMEnhancement || false,
                total_server_time: metadata?.totalProcessingTime
            };

            this.trackEvent('response_received', performanceData);

            if (sessionId) {
                this.sessionId = sessionId;
            }

            if (metadata?.totalProcessingTime) {
                const perfData = {
                    total: metadata.totalProcessingTime + 's',
                    method: 'agent'
                };

                if (metadata.agentTime) {
                    perfData.agentProcessing = metadata.agentTime + 's';
                }
                if (metadata.processingTime) {
                    perfData.responseProcessing = metadata.processingTime + 's';
                }
                if (metadata.clipProcessingTime) {
                    perfData.clipExtraction = metadata.clipProcessingTime + 's';
                }

                this.addPerformanceInfo(perfData);
            }

            if (videoClips && videoClips.length > 0) {
                this.displayVideoClips(videoClips);
            } else {
                this.addNoClipsMessage();
            }

        } catch (error) {
            console.error('Error:', error);
            this.removeLoadingMessage();
            this.trackEvent('error_occurred', {
                error_type: error.name
            });
            this.addErrorMessage('Sorry, there was an error processing your request. Please try again.');
        } finally {
            this.setLoading(false);
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
        errorDiv.className = 'error-message';
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
        // Don't show the overlay anymore
        if (this.loadingOverlay) {
            this.loadingOverlay.style.display = 'none';
        }

        if (this.messageInput) {
            this.messageInput.disabled = loading;
        }
    }

    addLoadingMessage() {
        if (!this.messagesContainer) return;

        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'message assistant';
        loadingDiv.id = 'loading-message';

        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'message-bubble loading-bubble';
        bubbleDiv.innerHTML = '<span class="loading-dots">Loading</span>';

        loadingDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(loadingDiv);
        this.scrollToBottom();

        return loadingDiv;
    }

    removeLoadingMessage() {
        const loadingMsg = document.getElementById('loading-message');
        if (loadingMsg) {
            loadingMsg.remove();
        }
    }

    scrollToBottom() {
        if (this.messagesContainer) {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }
    }

    addPerformanceInfo(performance) {
        if (!this.messagesContainer) return;

        const perfDiv = document.createElement('div');
        perfDiv.className = 'performance-info';

        const perfButton = document.createElement('button');
        perfButton.className = 'performance-popup-btn';
        perfButton.textContent = 'Performance';

        const perfDetails = `
            <strong>🤖 Agent Processing</strong><br><br>
            ${performance.agentProcessing ? `Agent Time: ${performance.agentProcessing}<br>` : ''}
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
        modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(16, 10, 10, 0.3); display: flex; align-items: center; justify-content: center; z-index: 2000;';
        modal.innerHTML = `
            <div class="performance-modal-content">
                <div class="performance-modal-header">
                    <h3 class="performance-modal-title">⚡ Performance Breakdown</h3>
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

    displayVideoClips(clips) {
        if (!this.videoClipsContainer || !this.videoContainer || !clips || clips.length === 0) return;

        this.videoClipsContainer.innerHTML = '';

        clips.forEach((clip, index) => {
            const clipId = `clip-${Date.now()}-${index}`;
            const clipDiv = document.createElement('div');
            clipDiv.className = 'video-clip industry-standard';
            clipDiv.setAttribute('data-clip-id', clipId);

            const videoId = `video-${index}`;
            const duration = Math.round(clip.endTime - clip.startTime);

            clipDiv.innerHTML = `
                <div class="video-wrapper">
                    <video id="${videoId}" controls preload="metadata" class="industry-video">
                        <source src="${clip.videoPath}#t=${clip.startTime},${clip.endTime}" type="video/mp4">
                        Your browser does not support the video tag.
                    </video>
                </div>

                <div class="video-info enhanced">
                    <h4 class="video-title">${clip.title}</h4>
                    <div class="video-timestamp">
                        <img src="images/clock.svg" alt="clock" width="24" onerror="this.style.display='none'">
                        <span>${this.formatTimestamp(clip.startTime)} - ${this.formatTimestamp(clip.endTime)}</span>
                    </div>
                    <div class="video-description">${clip.description}</div>

                    ${clip.keyTopics && clip.keyTopics.length > 0 ? `
                        <div class="key-topics">
                            <h4>Key Topics:</h4>
                            <div class="topic-wrapper">
                                ${clip.keyTopics.map(topic => `<span class="topic-tag">${topic}</span>`).join('')}
                            </div>
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
        const feedbackButtons = clipDiv.querySelectorAll('.feedback-btn');

        if (video) {
            video.addEventListener('loadedmetadata', () => {
                video.currentTime = clip.startTime;
            });

            video.addEventListener('timeupdate', () => {
                if (video.currentTime >= clip.endTime) {
                    video.pause();
                    video.currentTime = clip.startTime;
                    this.trackClipInteraction(clipId, 'completed');
                }
            });

            video.addEventListener('play', () => this.trackClipInteraction(clipId, 'video_play'));
            video.addEventListener('pause', () => this.trackClipInteraction(clipId, 'video_pause'));
            video.addEventListener('seeked', () => this.trackClipInteraction(clipId, 'video_seek'));
        }

        feedbackButtons.forEach(button => {
            button.addEventListener('click', () => {
                const feedback = button.getAttribute('data-feedback');
                this.submitClipFeedback(clipId, feedback, clip);

                button.style.backgroundColor = feedback === 'helpful' ? '#4CAF50' :
                                              feedback === 'not-helpful' ? '#f44336' : '#ff9800';
                button.disabled = true;

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

// Document export functions
window.exportPDF = function(documentId) {
    const exportBtn = document.querySelector(`.document-action-btn[data-document-id="${documentId}"]`);

    // Check if all frames are selected (button should be enabled)
    if (exportBtn && exportBtn.style.opacity === '0.5') {
        alert('Please select all required frames before exporting to PDF.');
        return;
    }

    window.open(`/api/export-pdf?id=${documentId}`, '_blank');
};

window.generateVideo = async function(documentId) {
    try {
        console.log(`🎬 Starting video generation for document: ${documentId}`);

        // Show loading state
        const videoBtn = document.querySelector(`.document-action-btn.video-btn[data-document-id="${documentId}"]`);
        if (videoBtn) {
            videoBtn.disabled = true;
            videoBtn.innerHTML = '🔄 Generating...';
        }

        const response = await fetch('/api/generate-video', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ documentId })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to generate video');
        }

        // Handle video streaming
        const contentType = response.headers.get('content-type');

        if (contentType && contentType.includes('video/mp4')) {
            // Video is being streamed directly
            const videoBlob = await response.blob();
            const videoUrl = URL.createObjectURL(videoBlob);

            // Create video player modal
            showVideoModal(videoUrl, `Generated Video - ${documentId}`);
        } else {
            // JSON response with video path
            const data = await response.json();
            if (data.videoPath) {
                showVideoModal(data.videoPath, `Generated Video - ${documentId}`);
            }
        }

    } catch (error) {
        console.error('Video generation failed:', error);
        alert(`Video generation failed: ${error.message}`);
    } finally {
        // Reset button state
        const videoBtn = document.querySelector(`.document-action-btn.video-btn[data-document-id="${documentId}"]`);
        if (videoBtn) {
            videoBtn.disabled = false;
            videoBtn.innerHTML = '🎥 Generate Video';
        }
    }
};

function showVideoModal(videoUrl, title = 'Generated Video') {
    // Remove any existing video modal
    const existingModal = document.querySelector('.video-modal');
    if (existingModal) {
        existingModal.remove();
    }

    // Create video player modal
    const modal = document.createElement('div');
    modal.className = 'video-modal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); display: flex; align-items: center; justify-content: center; z-index: 3000;';
    modal.innerHTML = `
        <div class="video-modal-content" style="background: white; padding: 20px; border-radius: 8px; max-width: 90%; max-height: 90%; overflow: auto;">
            <div class="video-modal-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <h3 style="margin: 0;">${title}</h3>
                <button class="modal-close-btn" style="background: none; border: none; font-size: 28px; cursor: pointer; color: #666;">&times;</button>
            </div>
            <div class="video-player">
                <video controls autoplay style="width: 100%; max-width: 1280px;">
                    <source src="${videoUrl}" type="video/mp4">
                    Your browser does not support the video tag.
                </video>
            </div>
            <div class="video-modal-footer" style="margin-top: 15px; text-align: center;">
                <a href="${videoUrl}" download class="download-video-btn" style="display: inline-block; padding: 10px 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 4px;">💾 Download Video</a>
            </div>
        </div>
    `;

    // Add modal to body
    document.body.appendChild(modal);

    // Close modal functionality
    const closeBtn = modal.querySelector('.modal-close-btn');

    closeBtn.onclick = () => {
        modal.remove();
        // Clean up object URL if it was created
        if (videoUrl.startsWith('blob:')) {
            URL.revokeObjectURL(videoUrl);
        }
    };

    modal.onclick = (e) => {
        if (e.target === modal) {
            modal.remove();
            if (videoUrl.startsWith('blob:')) {
                URL.revokeObjectURL(videoUrl);
            }
        }
    };
}

// Initialize chatbot
function initializeChatBot() {
    // Only initialize chatbot if we're on the app page (not the landing page)
    const messagesContainer = document.getElementById('messages');
    if (!messagesContainer) {
        console.log('📝 Landing page detected - skipping chatbot initialization');
        return;
    }

    console.log('🚀 Initializing Video Assistant with AI Agent...');
    try {
        window.chatBot = new VideoAssistantChatBot();
        console.log('✅ ChatBot initialized successfully');
    } catch (error) {
        console.error('❌ Failed to initialize ChatBot:', error);
        setTimeout(initializeChatBot, 500);
    }
}

// Frame selection event handlers
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

// Modal event listeners
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
    }
});

// Dark Mode Toggle
let darkModeInitialized = false;

function initializeDarkMode() {
    // Prevent double initialization
    if (darkModeInitialized) {
        console.log('⚠️ Dark mode already initialized, skipping...');
        return;
    }

    console.log('🌙 Initializing dark mode...');
    const darkModeToggle = document.getElementById('darkModeToggle');
    console.log('Dark mode toggle button:', darkModeToggle);

    // Check for saved dark mode preference
    const darkMode = localStorage.getItem('darkMode');
    console.log('Saved dark mode preference:', darkMode);

    if (darkMode === 'enabled') {
        console.log('Enabling dark mode from saved preference');
        document.body.classList.add('dark-mode');
        if (darkModeToggle) {
            darkModeToggle.textContent = '☀️';
        }
    }

    if (darkModeToggle) {
        console.log('Adding click listener to dark mode toggle');

        // Remove any existing listeners by cloning the element
        const newToggle = darkModeToggle.cloneNode(true);
        darkModeToggle.parentNode.replaceChild(newToggle, darkModeToggle);

        newToggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Dark mode toggle clicked!');
            document.body.classList.toggle('dark-mode');

            // Update icon
            if (document.body.classList.contains('dark-mode')) {
                console.log('Switching to dark mode');
                newToggle.textContent = '☀️';
                localStorage.setItem('darkMode', 'enabled');
            } else {
                console.log('Switching to light mode');
                newToggle.textContent = '🌙';
                localStorage.setItem('darkMode', 'disabled');
            }
        });

        darkModeInitialized = true;
        console.log('✅ Dark mode initialized successfully');
    } else {
        console.error('❌ Dark mode toggle button not found!');
    }
}

// ============= VIDEO UPLOAD FUNCTIONALITY =============
function initializeVideoUpload() {
    const uploadToggleBtn = document.getElementById('uploadToggleBtn');
    const uploadFormModal = document.getElementById('uploadFormModal');
    const closeUploadModal = document.getElementById('closeUploadModal');
    const uploadTabs = document.querySelectorAll('.upload-tab');
    const youtubeUrl = document.getElementById('youtubeUrl');
    const videoTitle = document.getElementById('videoTitle');
    const submitYoutubeBtn = document.getElementById('submitYoutubeBtn');
    const videoFileInput = document.getElementById('videoFile');
    const fileNameDisplay = document.getElementById('fileNameDisplay');
    const submitFileBtn = document.getElementById('submitFileBtn');
    const uploadStatus = document.getElementById('uploadStatus');

    if (!uploadToggleBtn || !uploadFormModal) {
        console.log('Upload elements not found, skipping upload initialization');
        return;
    }

    // Toggle upload modal
    uploadToggleBtn.addEventListener('click', () => {
        uploadFormModal.style.display = 'flex';
    });

    // Close modal
    closeUploadModal.addEventListener('click', () => {
        uploadFormModal.style.display = 'none';
    });

    // Close on backdrop click
    uploadFormModal.addEventListener('click', (e) => {
        if (e.target === uploadFormModal) {
            uploadFormModal.style.display = 'none';
        }
    });

    // Close on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && uploadFormModal.style.display === 'flex') {
            uploadFormModal.style.display = 'none';
        }
    });

    // Tab switching
    uploadTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active class from all tabs
            uploadTabs.forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.upload-tab-content').forEach(c => c.classList.remove('active'));

            // Add active class to clicked tab
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            document.getElementById(tabName + 'Tab').classList.add('active');
        });
    });

    // File input change handler
    videoFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            fileNameDisplay.textContent = file.name;
            submitFileBtn.disabled = false;
        } else {
            fileNameDisplay.textContent = 'Choose video or audio file';
            submitFileBtn.disabled = true;
        }
    });

    // Submit YouTube video
    submitYoutubeBtn.addEventListener('click', async () => {
        const url = youtubeUrl.value.trim();
        const title = videoTitle.value.trim();

        if (!url) {
            showUploadStatus('Please enter a YouTube URL', 'error');
            return;
        }

        await processVideo({ youtubeUrl: url, videoTitle: title });
    });

    // Submit uploaded file
    submitFileBtn.addEventListener('click', async () => {
        const file = videoFileInput.files[0];
        if (!file) {
            showUploadStatus('Please select a file', 'error');
            return;
        }

        await processVideo({ file });
    });

    async function processVideo(data) {
        try {
            // Show processing status
            showUploadStatus('Processing video... This may take a few minutes.', 'processing');
            submitYoutubeBtn.disabled = true;
            submitFileBtn.disabled = true;

            // Prepare form data
            const formData = new FormData();

            if (data.file) {
                formData.append('video', data.file);
            } else {
                formData.append('youtubeUrl', data.youtubeUrl);
                if (data.videoTitle) {
                    formData.append('videoTitle', data.videoTitle);
                }
            }

            // Send to backend
            const response = await fetch('/api/upload-video', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (result.success) {
                showUploadStatus(
                    `Success! Video processed and added to knowledge base.\n` +
                    `File: ${result.data.fileName}\n` +
                    `Sentences: ${result.data.sentenceCount}\n` +
                    `Processing time: ${result.data.processingTime}`,
                    'success'
                );

                // Clear inputs
                youtubeUrl.value = '';
                videoTitle.value = '';
                videoFileInput.value = '';
                fileNameDisplay.textContent = 'Choose video or audio file';

                // Hide modal after success
                setTimeout(() => {
                    uploadFormModal.style.display = 'none';
                    // Reset status
                    uploadStatus.style.display = 'none';
                }, 3000);
            } else {
                showUploadStatus(
                    `Error: ${result.error}\n${result.details || ''}`,
                    'error'
                );
            }
        } catch (error) {
            console.error('Upload error:', error);
            showUploadStatus(
                `Failed to process video: ${error.message}`,
                'error'
            );
        } finally {
            submitYoutubeBtn.disabled = false;
            submitFileBtn.disabled = false;
        }
    }

    function showUploadStatus(message, type) {
        uploadStatus.textContent = message;
        uploadStatus.className = `upload-status ${type}`;
        uploadStatus.style.display = 'block';
    }

    console.log('✅ Video upload functionality initialized');
}

// Initialize on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initializeChatBot();
        initializeDarkMode();
        initializeVideoUpload();
    });
} else if (document.readyState === 'interactive' || document.readyState === 'complete') {
    initializeChatBot();
    initializeDarkMode();
    initializeVideoUpload();
} else {
    setTimeout(() => {
        initializeChatBot();
        initializeDarkMode();
        initializeVideoUpload();
    }, 100);
}

console.log('📝 Video Assistant ChatBot script loaded successfully');
