Enterprise AI Video Intelligence Platform – Document Generation Module

🔍 Project Overview
We've built an AI-powered learning chatbot that integrates with AWS Bedrock (Claude 3.5 Sonnet) and a Knowledge Base containing timestamped training video transcripts from M&T Bank.
The system supports multiple chat modes:

Agent mode (AWS Bedrock Agent)

Direct KB mode (bypasses agent)

Smart Routing mode (auto-chooses between Agent/KB)

Document Generation mode (our current focus)

In Document Generation mode:
- User requests a process-oriented document
- System queries AWS KB for transcript chunks
- Claude generates a structured document with exactly 4 visual steps
- Validation layer ensures document compliance
- HTML renders with visual placeholders
- SMEs select frames with progress tracking
- System validates frame selection completeness
- PDF export generates professional output

✅ What Works Now
- Chatbot UI & backend (Node.js/Express) are stable
- Document Generation with strict validation:
  - User request → KB query → Claude creates JSON (4 visual steps) → HTML generation
  - Validation layer ensures document structure compliance
  - Progress tracking for frame selection
  - PDF export with enhanced validation
- Frame extraction and selection:
  - FrameExtractor backend works reliably
  - Frame selection UI with validation
  - Progress tracking (4 required frames)
  - Real-time updates
- Agent, smart routing, and KB(direct) modes work and are performant

🔄 Recent Improvements
1. Document Structure:
   - Modified Claude prompt to enforce 4 visual steps
   - Added strict validation for needsVisual flags
   - Enhanced error handling and validation
   - Added progress tracking

2. Frame Selection:
   - Fixed frame counting logic
   - Added validation for visual steps
   - Improved error handling
   - Better progress tracking

3. PDF Export:
   - Enhanced validation checks
   - Improved error recovery
   - Better image handling
   - Refined print styles

🏗 Tech Stack
Frontend:
- Vanilla JS (script.js)
- HTML/CSS with resizable panes
- Validation-aware components
- Progress tracking UI

Backend:
- Node.js/Express (server.js)
- AWS Bedrock, Claude, Titan embeddings
- ffmpeg for frame extraction
- Validation layer
- Enhanced PDF generation

Styling:
- Modern, clean design
- ChatGPT-inspired UI
- Print-optimized styles
- Progress indicators

🎯 Next Steps

1️⃣ Testing & Validation
- Test frame selection with various documents
- Validate PDF generation extensively
- Verify error handling
- Check progress tracking

2️⃣ Performance Optimization
- Optimize frame extraction
- Enhance caching
- Improve validation efficiency
- Streamline PDF generation

3️⃣ User Experience
- Refine error messages
- Enhance progress indicators
- Optimize validation feedback
- Improve frame selection UI

4️⃣ Documentation
- Update technical documentation
- Add validation guidelines
- Document error handling
- Create user guides

Quality Standards:
1. Document Structure:
   - Exactly 4 visual steps per document
   - Clear step descriptions
   - Consistent formatting
   - Proper visual context

2. Frame Selection:
   - Intuitive interface
   - Clear progress tracking
   - Validation feedback
   - Real-time updates

3. PDF Export:
   - Professional formatting
   - Optimized images
   - Reliable generation
   - Error recovery
