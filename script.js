class ChatBot {
    constructor() {
        /** @type {HTMLElement} */
        this.messagesContainer = document.getElementById('messages');
        /** @type {HTMLInputElement} */
        this.messageInput = document.getElementById('messageInput');
        /** @type {HTMLButtonElement} */
        this.sendButton = document.getElementById('sendButton');
        /** @type {HTMLElement} */
        this.videoContainer = document.getElementById('videoContainer');
        /** @type {HTMLElement} */
        this.videoClipsContainer = document.getElementById('videoClips');
        /** @type {HTMLElement} */
        this.messagesContainer = document.getElementById('messages');
        /** @type {HTMLInputElement} */
        this.messageInput = document.getElementById('messageInput');
        /** @type {HTMLButtonElement} */
        this.sendButton = document.getElementById('sendButton');
        /** @type {HTMLElement} */
        this.videoContainer = document.getElementById('videoContainer');
        /** @type {HTMLElement} */
        this.videoClipsContainer = document.getElementById('videoClips');
        /** @type {HTMLElement} */
        this.loadingOverlay = document.getElementById('loadingOverlay');
        
        // Validate that all required elements exist
        if (!this.messagesContainer || !this.messageInput || !this.sendButton || 
            !this.videoContainer || !this.videoClipsContainer || !this.loadingOverlay) {
            console.error('Required DOM elements not found');
            return;
        }
        
        this.initializeEventListeners();
        this.addWelcomeMessage();
    }
    
    initializeEventListeners() {
        if (!this.sendButton || !this.messageInput) return;
        
        this.sendButton.addEventListener('click', () => this.sendMessage());
        this.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });
    }
    
    addWelcomeMessage() {
        this.addMessage('assistant', 'Hello! I\'m your Training Video Assistant. Ask me questions about the training videos, and I\'ll provide relevant information along with video clips to help you learn.');
    }
    
    async sendMessage() {
        if (!this.messageInput) return;
        
        const message = this.messageInput.value.trim();
        if (!message) return;
        
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.setLoading(true);
        
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
            
            if (data.error) {
                throw new Error(data.error);
            }
            
            this.addMessage('assistant', data.response);
            
            if (data.sources && data.sources.length > 0) {
                this.addSourceInfo(data.sources);
            }
            
            if (data.videoClips && data.videoClips.length > 0) {
                this.displayVideoClips(data.videoClips);
            }
            
        } catch (error) {
            console.error('Error:', error);
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
        bubbleDiv.textContent = content;
        
        messageDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom();
    }
    
    addSourceInfo(sources) {
        if (!this.messagesContainer || !sources || sources.length === 0) return;
        
        const sourceDiv = document.createElement('div');
        sourceDiv.className = 'source-info';
        
        const sourceText = sources.length === 1 
            ? `Source: ${sources[0].title}` 
            : `Sources: ${sources.map(s => s.title).join(', ')}`;
            
        sourceDiv.textContent = sourceText;
        this.messagesContainer.appendChild(sourceDiv);
        this.scrollToBottom();
    }
    
    addErrorMessage(message) {
        if (!this.messagesContainer) return;
        
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        this.messagesContainer.appendChild(errorDiv);
        this.scrollToBottom();
    }
    
    displayVideoClips(clips) {
        if (!this.videoClipsContainer || !this.videoContainer || !clips || clips.length === 0) return;
        
        this.videoClipsContainer.innerHTML = '';

        clips.forEach((clip, index) => {
            const clipDiv = document.createElement('div');
            clipDiv.className = 'video-clip';
            
            const videoId = `video-${index}`;
            
            clipDiv.innerHTML = `
                <video id="${videoId}" controls preload="metadata">
                    <source src="${clip.videoPath}#t=${clip.startTime},${clip.endTime}" type="video/mp4">
                    Your browser does not support the video tag.
                </video>
                <div class="video-info">
                    <div class="video-title">${clip.title}</div>
                    <div class="video-timestamp">
                        ${this.formatTimestamp(clip.startTime)} - ${this.formatTimestamp(clip.endTime)}
                        <button class="play-clip-btn" data-video-id="${videoId}" data-start="${clip.startTime}" data-end="${clip.endTime}">
                            Play Clip
                        </button>
                    </div>
                    <div class="video-description">${clip.description}</div>
                </div>
            `;
            
            this.videoClipsContainer.appendChild(clipDiv);
            
            // Add event listeners for clip control
            const video = document.getElementById(videoId);
            const playButton = clipDiv.querySelector('.play-clip-btn');
            
            if (video && playButton) {
                // Set initial video time
                video.addEventListener('loadedmetadata', () => {
                    video.currentTime = clip.startTime;
                });
                
                // Handle play clip button
                playButton.addEventListener('click', () => {
                    video.currentTime = clip.startTime;
                    video.play();
                });
                
                // Stop video at end time
                video.addEventListener('timeupdate', () => {
                    if (video.currentTime >= clip.endTime) {
                        video.pause();
                        video.currentTime = clip.startTime; // Reset to start
                    }
                });
                
                // Handle video loading
                video.addEventListener('loadstart', () => {
                    video.currentTime = clip.startTime;
                });
            }
        });
        
        this.videoContainer.style.display = 'block';
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

// Initialize the chatbot when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new ChatBot();
});
