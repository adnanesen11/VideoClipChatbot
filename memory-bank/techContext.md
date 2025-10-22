# Technical Context

## Development Environment

### Core Technologies
- Frontend: Vanilla JavaScript, HTML5, CSS3
- Backend: Node.js with Express
- Video Processing: ffmpeg
- AWS Services: Bedrock, Knowledge Base, Titan embeddings
- PDF Generation: Puppeteer with enhanced validation
- Validation Layer: Custom implementation

### Key Dependencies
```json
{
  "express": "Server framework",
  "ffmpeg": "Video frame extraction",
  "aws-sdk": "AWS service integration",
  "puppeteer": "PDF generation with validation",
  "node-cache": "Frame caching",
  "sharp": "Image optimization"
}
```

## Development Setup
1. Node.js Environment:
   - Node.js runtime
   - npm package manager
   - Express server framework
   - Validation middleware

2. AWS Configuration:
   - Bedrock access (Claude 3.5 Sonnet)
   - Knowledge Base setup
   - Titan embeddings configuration
   - Custom prompt templates

3. Video Processing:
   - ffmpeg installation
   - Frame extraction capabilities
   - Cache storage configuration
   - Validation checks

4. Document Generation:
   - Strict visual step validation
   - Frame count enforcement
   - Progress tracking
   - Error handling

## Technical Constraints

### Document Structure Constraints
- Exactly 4 visual steps required
- Strict needsVisual flag validation
- Clear visual step requirements
- Progress tracking requirements

### Performance Constraints
- Frame extraction processing time
- Video file size limitations
- Cache memory management
- Browser rendering performance
- Validation overhead

### Integration Constraints
- AWS service rate limits
- Claude API response times
- Knowledge Base query optimization
- PDF generation reliability
- Validation requirements

### Browser Constraints
- DOM manipulation performance
- Memory usage with multiple frames
- Print/PDF export compatibility
- Image loading and validation
- Print style consistency
- Progress tracking display

## Tool Usage Patterns

### Development Tools
1. Version Control:
   - Git repository
   - GitHub hosting
   - Feature branch workflow

2. Code Organization:
   - Modular JavaScript files
   - Separate concerns (UI/API/Processing/Validation)
   - Clear file structure
   - Validation layer

### Testing Approach
1. Manual Testing:
   - UI functionality
   - Frame extraction accuracy
   - PDF generation
   - AWS integration
   - Validation checks

2. Performance Testing:
   - Frame extraction speed
   - UI responsiveness
   - Cache effectiveness
   - Validation overhead

3. Validation Testing:
   - Document structure validation
   - Frame count verification
   - Progress tracking
   - Error handling

## Configuration Management
1. Environment Variables:
   - AWS credentials
   - API endpoints
   - Service configurations
   - Validation settings

2. Cache Settings:
   - Frame storage limits
   - Expiration policies
   - Memory management
   - Validation state

3. Video Processing:
   - Frame extraction parameters
   - Quality settings
   - Output formats
   - Validation checks

4. Document Generation:
   - Visual step constraints
   - Validation rules
   - Progress tracking
   - Error handling

## Deployment Considerations
1. Server Requirements:
   - Node.js runtime
   - ffmpeg installation
   - Sufficient storage for frames
   - Memory for caching
   - Validation processing

2. AWS Setup:
   - Service permissions
   - Rate limit considerations
   - Cost optimization
   - Custom prompt templates

3. Browser Support:
   - Modern browser compatibility
   - Print/PDF capabilities
   - Memory management
   - Image validation and fallbacks
   - Print style optimization
   - Progress tracking display

4. Validation Layer:
   - Document structure validation
   - Frame count enforcement
   - Progress tracking
   - Error handling
   - User feedback

## Implementation Notes
1. Document Generation:
   - Use strict validation for visual steps
   - Enforce exactly 4 visual elements
   - Track progress accurately
   - Handle errors gracefully

2. Frame Selection:
   - Validate frame count
   - Track selection progress
   - Provide clear feedback
   - Ensure data consistency

3. PDF Export:
   - Validate content completeness
   - Optimize images
   - Handle errors
   - Ensure quality output
   - Maintain print styles
