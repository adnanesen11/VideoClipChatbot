# Training Video Assistant Chatbot

A professional chatbot interface that demonstrates AWS Bedrock agent integration with a knowledge base containing timestamped training video transcripts. The bot answers questions about training videos and provides relevant video clips based on extracted timestamps.

## Features

- **Professional Chat Interface**: Clean, responsive design with smooth animations
- **AWS Bedrock Integration**: Connects to your configured AWS Bedrock agent
- **Knowledge Base Queries**: Searches through training video transcripts
- **Video Clip Extraction**: Automatically finds and displays relevant video clips
- **Timestamp Matching**: Matches agent responses to specific video timestamps
- **Real-time Processing**: Shows loading states and error handling

## Prerequisites

- Node.js (version 18 or higher)
- AWS account with Bedrock access
- Configured AWS Bedrock agent with knowledge base
- Training videos stored locally in `/videos` folder
- Timestamped transcripts in S3 (loaded into knowledge base)

## Installation

1. Clone or download the project files
2. Install dependencies:
   ```bash
   npm install
   ```
## Project Structure

```
training-video-chatbot/
├── index.html          # Main chatbot interface
├── styles.css          # Professional styling
├── script.js           # Frontend JavaScript logic
├── server.js           # Express server with AWS integration
├── package.json        # Node.js dependencies
├── .env                # Environment configuration
├── videos/             # Local video storage folder
└── README.md           # This file
```

## Setup Instructions

### 1. Video Files Setup
- Create a `videos/` folder in the project root
- Place your training video files (MP4, AVI, MOV, etc.) in this folder
- Ensure video files have the same base name as their transcripts in S3

### 2. Knowledge Base Requirements
Your S3 bucket should contain timestamped transcripts with formats like:
- `training_module_1_transcript.txt`
- `safety_procedures_timestamped.json`

The system will match these to video files like:
- `training_module_1.mp4`
- `safety_procedures.mp4`

### 3. AWS Permissions
Ensure your AWS credentials have permissions for:
- `bedrock-agent:InvokeAgent`
- Access to your specific agent and alias

### 4. Running the Application

Development mode (with auto-restart):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

The application will be available at `http://localhost:3000`

## How It Works

### 1. User Interaction
- User types a question about training videos
- Frontend sends the message to the Express server
- Loading overlay appears during processing

### 2. AWS Bedrock Agent Processing
- Server invokes the AWS Bedrock agent with the user's question
- Agent searches the knowledge base containing timestamped transcripts
- Agent returns a response with source references and traces

### 3. Video Clip Extraction
- System analyzes the agent's source references
- Extracts timestamps from transcript content using regex patterns:
  - `[01:30]` - Single timestamp format
  - `(2:45)` - Alternative timestamp format
  - `1:15-2:30` - Time range format
  - `at 3:20` - Natural language timestamps
- Matches source names to local video files
- Creates video clips with start/end times

### 4. Response Display
- Chat interface shows the agent's text response
- Relevant video clips appear in the side panel
- Each clip shows title, timestamp range, and description
- Videos can be played directly in the browser

## Timestamp Detection

The system automatically detects various timestamp formats in the transcript content:

- **Bracketed**: `[01:30]`, `[2:45]`
- **Parentheses**: `(01:30)`, `(2:45)`
- **Ranges**: `1:15-2:30`, `01:30-03:45`
- **Natural Language**: `at 2:30`, `time 1:45`

## File Naming Convention

For automatic video matching, ensure your files follow these patterns:

**S3 Transcript Files:**
- `module_1_transcript.txt`
- `safety_training_timestamped.json`
- `onboarding_session_transcript.txt`

**Local Video Files:**
- `module_1.mp4`
- `safety_training.mov`
- `onboarding_session.avi`

The system strips common suffixes (`_transcript`, `_timestamped`) and extensions to match files.

## API Endpoints

### POST `/api/chat`
Send a message to the chatbot
```json
{
  "message": "How do I handle emergency procedures?"
}
```

Response:
```json
{
  "response": "Emergency procedures should be followed...",
  "sources": [
    {
      "id": "source-123",
      "title": "Emergency Training Module",
      "content": "At [02:30] the instructor explains...",
      "score": 0.95
    }
  ],
  "videoClips": [
    {
      "title": "Emergency Training Module",
      "description": "At [02:30] the instructor explains...",
      "videoPath": "/videos/emergency_training.mp4",
      "startTime": 140,
      "endTime": 180,
      "sourceId": "source-123"
    }
  ]
}
```

### GET `/api/health`
Health check endpoint
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "environment": "development"
}
```

## Customization

### Styling
Modify `styles.css` to customize:
- Color scheme (update CSS variables)
- Layout dimensions
- Animation speeds
- Responsive breakpoints

### Timestamp Patterns
Add new timestamp detection patterns in `server.js`:
```javascript
const timestampPatterns = [
  // Add your custom patterns here
  /custom_pattern/g,
];
```

### Video Extensions
Support additional video formats by updating:
```javascript
const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v'];
```

## Troubleshooting

### Common Issues

**Agent Not Found Error:**
- Verify your `AGENT_ID` and `AGENT_ALIAS_ID` are correct
- Ensure the agent is deployed and active in AWS

**Access Denied Error:**
- Check AWS credentials and permissions
- Verify the IAM user/role has `bedrock-agent:InvokeAgent` permission

**No Video Clips Found:**
- Ensure video files exist in the `/videos` folder
- Check that video file names match transcript base names
- Verify timestamps exist in the transcript content

**Videos Not Playing:**
- Confirm video files are in supported formats (MP4 recommended)
- Check browser console for CORS or file access errors
- Ensure the Express server is serving the `/videos` static directory

### Debug Mode
Set `NODE_ENV=development` in your `.env` file to see detailed error messages and logs.

### Logs
The server logs important information:
- Agent invocation details
- Source extraction results
- Video clip matching process
- Timestamp detection results

## Security Considerations

- **Environment Variables**: Never commit `.env` file to version control
- **AWS Credentials**: Use IAM roles in production instead of access keys
- **CORS**: Configure CORS settings for your production domain
- **Input Validation**: The server validates user inputs before processing

## Performance Optimization

- **Video Compression**: Compress video files for faster loading
- **Caching**: Consider implementing response caching for frequently asked questions
- **CDN**: Use a CDN for video delivery in production
- **Pagination**: Implement pagination for large numbers of video clips

## License

MIT License - see package.json for details.
