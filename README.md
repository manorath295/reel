# Sign Kit - Avatar-based ISL Toolkit

An AI-powered Indian Sign Language (ISL) generation toolkit. This project translates English/Hindi text or audio, and even Instagram Reels/Shorts (OCR text + audio transcription), directly into ISL 3D Avatar animations in real-time.

## Tech Stack
- **Frontend**: React, Three.js, React Three Fiber, Kalidokit (for IK body solving).
- **Backend**: FastAPI (Python).
- **AI Models**: OpenAI Whisper (Audio to Text), Google Gemini (Text meaning to ISL Gloss & Vision OCR for videos), MediaPipe (Pose/Hand detection).

---

## 🚀 Setup & the Execution Guide

The project is split into two parts: `client` (Frontend) and `server` (Backend). You need 2 terminals to run them simultaneously.

### 1. Backend (Server) Setup
Open Terminal 1 and navigate to the `server` directory.

```bash
cd server
```

**Step 1: Create and activate a Virtual Environment**
```bash
python -m venv venv
# On Windows:
source venv/Scripts/activate
# On Mac/Linux:
source venv/bin/activate
```

**Step 2: Install dependencies**
```bash
pip install -r requirements.txt
# Ensure you also have dependencies for mediapipe extractor:
pip install "mediapipe==0.10.14" opencv-python
```

**Step 3: Setup Environment Variables**
Create a `.env` file in the `server` folder and add your Gemini API Key:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

**Step 4: Run the Backend server**
```bash
uvicorn main:app --port 8000 --reload
```
The backend is now running at `http://localhost:8000`

---

### 2. Frontend (Client) Setup
Open Terminal 2 and navigate to the `client` directory.

```bash
cd client
```

**Step 1: Install dependencies**
```bash
npm install
# or if using legacy peer deps:
npm install --legacy-peer-deps
```

**Step 2: Start the React App**
```bash
npm run dev
```
The frontend is now running at `http://localhost:5173`. Open this URL in your browser!

---

## 🛠 Features Unlocked
- **Classic Text to Sign**: Type text and the Avatar fingerspells or signs predefined words.
- **Audio to Sign (Whisper)**: Upload audio, Whisper transcribes it, Gemini converts to ISL root words (SOV grammar), and Avatar signs it.
- **Video Reel to Sign (Vision OCR + Whisper)**: Upload an MP4. The system isolates audio for Whisper whilst snapping keyframes for Gemini Vision OCR to read on-screen text. The combined text is then signed by the Avatar.
- **Auto-interpolation**: The MediaPipe offline extractor interpolates lost hand tracking frames for smooth animations.

## 🤝 Adding New Signs (Advanced)
If you want to add a new full-word sign instead of having it fingerspelled:
1. Record an MP4 of a person signing the word.
2. Run the extractor script:
   ```bash
   cd server
   python mediapipe_extractor.py "path/to/video.mp4" --out WORD_motion.json
   ```
3. The `.json` is saved dynamically into `client/public/`. The system immediately recognizes it and next time you type that word, the Avatar will perform the full animation!
