# System Patterns

## Architecture Overview
```
[Frontend (Vanilla JS)] <-> [Backend (Node.js/Express)] <-> [AWS Services]
                                     |
                              [Frame Extraction]
                                     |
                              [Document Generation]
                                     |
                              [Validation Layer]
```

## Key Components

### Frontend Layer
1. UI Components:
   - Chat interface
   - Document preview panel
   - Frame selection widget with validation
   - Mode selection dropdown
   - Progress tracking display

2. State Management:
   - Direct DOM manipulation
   - Real-time updates for frame selection
   - Dynamic HTML rendering
   - Validation state tracking

### Backend Layer
1. Core Services:
   - Express server
   - Frame extraction (ffmpeg)
   - AWS integration
   - PDF generation
   - Document validation

2. AWS Integration:
   - Bedrock (Claude 3.5 Sonnet)
   - Knowledge Base
   - Titan embeddings

### Frame Processing
1. Extraction Pipeline:
   - ffmpeg-based frame extraction
   - Timestamp-based frame selection
   - Frame caching mechanism
   - Validation checks

2. Frame Selection Flow:
   - Backend extracts frames from timestamps
   - Strict validation of visual steps (exactly 4)
   - Frontend displays candidate frames
   - UI enables SME selection with validation
   - Real-time HTML updates with progress tracking

## Design Patterns

### Frontend Patterns
- Modular JavaScript organization
- Event-driven UI updates
- Responsive pane layout
- ChatGPT-inspired styling
- Validation-aware components

### Backend Patterns
- RESTful API endpoints
- Async frame processing
- Caching strategies
- Service-based architecture
- Strict validation layer

### Validation Patterns
1. Document Structure:
   ```
   Claude Prompt -> Strict Rules -> JSON Generation -> Validation Layer -> Document Creation
   ```

2. Frame Selection:
   ```
   Visual Steps (4) -> Frame Extraction -> Validation -> UI Display -> Progress Tracking
   ```

3. PDF Generation:
   ```
   Validation -> Content Loading -> Image Processing -> PDF Creation -> Quality Check
   ```

## Critical Implementation Paths
1. Document Generation:
   ```
   User Request -> KB Query -> Claude Processing (4 visuals) -> Validation -> HTML Rendering
   ```

2. Frame Selection:
   ```
   Timestamp -> Validation -> Frame Extraction -> Cache -> UI Display -> Progress Check -> HTML Update
   ```

3. PDF Export:
   ```
   Validation -> Content Loading -> Image Processing -> Style Application -> PDF Generation -> Download
   ```

## Technical Decisions
1. Vanilla JS Frontend:
   - Lightweight implementation
   - Direct DOM control
   - Minimal dependencies
   - Validation-aware components

2. Node.js/Express Backend:
   - Efficient video processing
   - AWS service integration
   - RESTful API support
   - Strict validation layer

3. AWS Integration:
   - Claude for document generation (4 visual steps)
   - Knowledge Base for transcript storage
   - Titan for embeddings

4. Frame Extraction:
   - ffmpeg for reliable frame capture
   - Timestamp-based accuracy
   - Caching for performance
   - Validation checks

5. PDF Generation:
   - Enhanced Puppeteer configuration
   - Strict content validation
   - Image optimization and validation
   - Print-optimized styles
   - Error recovery

6. Validation Layer:
   - Document structure validation
   - Frame count enforcement (4 visuals)
   - Progress tracking
   - Error handling
   - User feedback

## Implementation Guidelines
1. Document Structure:
   - Enforce exactly 4 visual steps
   - Validate needsVisual flags
   - Track progress
   - Handle errors gracefully

2. Frame Selection:
   - Validate visual step count
   - Track selection progress
   - Provide clear feedback
   - Ensure data consistency

3. PDF Generation:
   - Validate content completeness
   - Optimize images
   - Handle errors
   - Ensure quality output
