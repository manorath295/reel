"""
ISL Sign Kit - FastAPI Backend
Whisper (local) + Gemini (GenAI) → ISL Gloss → Animation JSON sequence
"""
from __future__ import annotations
import os, re, json, glob, tempfile, traceback, base64
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

load_dotenv()

# ── Dependencies ──────────────────────────────────────────────────────────────
import whisper
import google.generativeai as genai

# ── Config ────────────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
# The folder where all *_motion.json files live (Vite serves from /client/public/)
PUBLIC_DIR = Path(__file__).parent.parent / "client" / "public"

# ── MongoDB Connection ────────────────────────────────────────────────────────
import urllib.parse
from pymongo import MongoClient
try:
    password = urllib.parse.quote_plus("56VZ4jyL7rO01vhH")
    MONGO_URL = f"mongodb+srv://learn4833_db_user:{password}@cluster0.zcnodn7.mongodb.net/?appName=Cluster0"
    mongo_client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
    db = mongo_client["sign_kit_db"]
    motions_collection = db["motions"]
    print("✅ Connected to MongoDB Atlas")
except Exception as e:
    print(f"⚠️  Failed to connect to MongoDB: {e}")
    motions_collection = None

# ── Gemini system prompt ──────────────────────────────────────────────────────
ISL_SYSTEM_PROMPT = """
You are an expert Indian Sign Language (ISL) linguist.
Convert the given English/Hindi text into ISL Gloss following these strict rules:

1. ISL uses SOV (Subject-Object-Verb) word order, NOT SVO.
   Example: "I am going to school" → ["I", "SCHOOL", "GO"]
2. Remove all articles: a, an, the
3. Remove all helping verbs: is, are, am, was, were, be, been, being, do, does, did
4. Remove all prepositions: in, on, at, to, from, of, for, with
5. Keep core nouns, verbs, and adjectives only
6. Use UPPERCASE root words
7. Output ONLY a valid JSON array of strings. No explanation, no markdown, just the JSON array.

Example input: "The farmer is going to the green field"
Example output: ["FARMER", "GREEN", "FIELD", "GO"]
"""

# ── Startup: load models once ─────────────────────────────────────────────────
print("Loading Whisper model (this may moment on first run)...")
whisper_model = whisper.load_model("base")
print("✅ Whisper ready.")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel(
        model_name="gemini-2.5-flash", # Updated to a stable version name if 2.5 was hallucinated
        system_instruction=ISL_SYSTEM_PROMPT,
    )
    print("✅ Gemini ready.")
else:
    gemini_model = None
    print("⚠️  No GEMINI_API_KEY found in .env — translation will be skipped.")

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="ISL Sign Kit API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db_motion_words() -> set[str]:
    """Returns a set of all words currently stored in MongoDB."""
    if motions_collection is None:
        return set()
    try:
        # Fetch just the 'word' field from all documents
        docs = motions_collection.find({}, {"word": 1, "_id": 0})
        return {doc["word"] for doc in docs}
    except Exception as e:
        print(f"⚠️  Failed to fetch words from MongoDB: {e}")
        return set()

def get_available_motion_files() -> dict[str, str]:
    """Returns a dict mapping WORD → /public/XXX_motion.json URL path (Local)."""
    mapping: dict[str, str] = {}
    for path in PUBLIC_DIR.glob("*_motion.json"):
        # e.g. "agriculture_motion.json" → key "AGRICULTURE"
        word = path.stem.replace("_motion", "").upper()
        # URL the browser can fetch from Vite dev server
        mapping[word] = f"/{path.name}"
    return mapping


ALPHABET_FILES: dict[str, str] = {
    ch: f"/alphabets/{ch.upper()}.json"
    for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
}


def build_animation_sequence(gloss_words: list[str]) -> list[dict]:
    """
    Map each ISL gloss word → animation file.
    First tries compound combinations (e.g. SAVING+ACCOUNT → SAVING_ACCOUNT_motion.json),
    then falls back to letter-by-letter fingerspelling.
    """
    available_local = get_available_motion_files()
    available_db = get_db_motion_words()
    
    sequence: list[dict] = []
    i = 0
    while i < len(gloss_words):
        key = gloss_words[i].upper().strip()

        # Try compound: current + next word joined by underscore
        matched_compound = False
        if i + 1 < len(gloss_words):
            compound = key + "_" + gloss_words[i+1].upper().strip()
            
            if compound in available_db:
                sequence.append({"word": compound, "file": f"http://localhost:8000/motion/{compound}", "type": "sign"})
                print(f"   ☁️  Compound match (DB): '{compound}'")
                i += 2
                matched_compound = True
            elif compound in available_local:
                sequence.append({"word": compound, "file": available_local[compound], "type": "sign"})
                print(f"   ✅ Compound match (Local): '{compound}' → {available_local[compound]}")
                i += 2
                matched_compound = True

        if not matched_compound:
            if key in available_db:
                sequence.append({"word": key, "file": f"http://localhost:8000/motion/{key}", "type": "sign"})
                print(f"   ☁️  Word match (DB): '{key}'")
            elif key in available_local:
                sequence.append({"word": key, "file": available_local[key], "type": "sign"})
                print(f"   ✅ Word match (Local): '{key}' → {available_local[key]}")
            else:
                # Fingerspell the word character by character
                print(f"   ✏️  No match for '{key}', finger-spelling...")
                for ch in key:
                    if ch.isalpha():
                        sequence.append({
                            "word": ch,
                            "file": ALPHABET_FILES.get(ch, f"/alphabets/{ch}.json"),
                            "type": "fingerspell",
                        })
            i += 1
    return sequence


@app.get("/")
async def root():
    return {"status": "ISL Sign Kit API is running", "version": "1.0.0"}


@app.get("/motion/{word}")
async def get_motion_data(word: str):
    """Fetch motion JSON data straight from MongoDB by word name."""
    if motions_collection is None:
        raise HTTPException(status_code=500, detail="Database not connected.")
    
    word = word.upper().strip()
    doc = motions_collection.find_one({"word": word}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail=f"Motion data for '{word}' not found in DB.")
    
    # Return the dictionary document exactly as Vite would serve the JSON file
    return doc


@app.get("/available-animations")
async def available_animations():
    """List all available word animation JSON files."""
    available = get_available_motion_files()
    return {
        "total": len(available),
        "words": list(available.keys()),
        "files": available,
    }


@app.post("/transcribe-and-sign")
async def transcribe_and_sign(audio: UploadFile = File(...)):
    """
    Main endpoint:
    1. Receive audio file
    2. Transcribe with Whisper (local)
    3. Convert to ISL Gloss with Gemini
    4. Return animation file sequence
    """
    # Save audio to a temp file
    suffix = Path(audio.filename).suffix if audio.filename else ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await audio.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # ── Step 1: Transcribe ────────────────────────────────────────────────
        print(f"\n{'='*55}")
        print(f"🎵 AUDIO: {audio.filename} ({len(content)/1024:.1f} KB)")
        print(f"{'='*55}")
        print("STEP 1 ▶️  Whisper transcribing...")
        result = whisper_model.transcribe(tmp_path)
        transcript = result["text"].strip()
        print(f"STEP 1 ✅  Transcript: '{transcript}'")

        # ── Step 2: ISL Gloss via Gemini ──────────────────────────────────────
        gloss: list[str] = []
        if gemini_model and transcript:
            print(f"STEP 2 ▶️  Sending to Gemini: '{transcript}'")
            try:
                response = gemini_model.generate_content(transcript)
                raw = response.text.strip()
                print(f"STEP 2 🤖  Gemini raw: {raw!r}")
                raw = re.sub(r"```(?:json)?", "", raw).strip().strip("```").strip()
                gloss = json.loads(raw)
                print(f"STEP 2 ✅  ISL Gloss: {gloss}")
            except Exception as e:
                print(f"STEP 2 ❌  Gemini error: {e}")
                gloss = [w.upper() for w in transcript.split() if len(w) > 2]
                print(f"STEP 2 ⚠️  Fallback gloss: {gloss}")
        elif not gemini_model:
            print("STEP 2 ⚠️  No Gemini key — naive split")
            gloss = [w.upper() for w in transcript.split() if len(w) > 2]
            print(f"STEP 2    Fallback gloss: {gloss}")

        # ── Step 3: Build animation sequence ─────────────────────────────────
        print(f"STEP 3 ▶️  Mapping gloss → motion files...")
        available = get_available_motion_files()
        print(f"STEP 3 📁  Available words: {list(available.keys())}")
        animation_sequence = build_animation_sequence(gloss)
        print(f"STEP 3 ✅  Sequence ({len(animation_sequence)} clips):")
        for clip in animation_sequence:
            icon = '✔️' if clip['type'] == 'sign' else '✏️'
            print(f"         {icon} '{clip['word']}' → {clip['file']}")
        print(f"{'='*55}\n")

        return JSONResponse({
            "transcript": transcript,
            "gloss": gloss,
            "animation_sequence": animation_sequence,
        })

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.post("/text-to-sign")
async def text_to_sign(payload: dict):
    """
    Convenience endpoint: skip audio, just pass text.
    Body: { "text": "The farmer goes to the field" }
    """
    text = payload.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text field is required")

    print("\n" + "="*55)
    print(f"📝 TEXT-TO-SIGN: '{text}'")
    print("="*55)

    gloss: list[str] = []
    if gemini_model:
        try:
            print("STEP 1 ▶️  Sending to Gemini...")
            # Fetch available combinations
            available_db = list(get_db_motion_words())
            available_local = list(get_available_motion_files().keys())
            all_available = ", ".join(available_db + available_local)

            dynamic_prompt = (
                f"Translate this text to ISL Gloss: '{text}'.\n"
                f"HINT: We have exact animations for these words: [{all_available}].\n"
                f"If the text contains variations (like 'allergy' vs 'allergies'), you MUST use the exact word from the hint list if available."
            )

            response = gemini_model.generate_content(dynamic_prompt)
            raw = response.text.strip()
            raw = re.sub(r"```(?:json)?", "", raw).strip().strip("```").strip()
            gloss = json.loads(raw)
            print(f"STEP 2 🤖  Gemini ISL Gloss: {gloss}")
        except Exception as e:
            print(f"STEP 2 ❌  Gemini failed: {e}, falling back to word split")
            gloss = [w.upper() for w in text.split() if len(w) > 2]
    else:
        print("STEP 1 ⚠️  No Gemini key, splitting text manually")
        gloss = [w.upper() for w in text.split() if len(w) > 2]

    available = get_available_motion_files()
    animation_sequence = build_animation_sequence(gloss)
    
    return JSONResponse({
        "text": text,
        "gloss": gloss,
        "animation_sequence": animation_sequence,
    })


# ── Video OCR endpoint ────────────────────────────────────────────────────────

@app.post("/video-ocr-to-sign")
async def video_ocr_to_sign(video: UploadFile = File(...)):
    """
    Instagram Reel / Short video pipeline:
    1. Extract key frames → Gemini Vision OCR → on-screen text
    2. Extract audio → Whisper → spoken text
    3. Combine both → Gemini ISL Gloss → animation sequence
    """
    import cv2

    suffix = Path(video.filename).suffix if video.filename else ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await video.read()
        tmp.write(content)
        tmp_path = tmp.name

    print("\n" + "="*55)
    print(f"🎬 VIDEO-OCR-TO-SIGN: '{video.filename}'")
    print("="*55)

    ocr_texts = []
    whisper_text = ""

    try:
        # ── STEP 1: Extract key frames (1 frame every 2 seconds) ──────────────
        cap = cv2.VideoCapture(tmp_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        interval = int(fps * 2)  # every 2 seconds
        frame_idx = 0
        frames_b64 = []

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            if frame_idx % interval == 0:
                _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                frames_b64.append(base64.b64encode(buf).decode())
            frame_idx += 1
        cap.release()
        print(f"STEP 1 🖼️   Extracted {len(frames_b64)} key frames for OCR")

        # ── STEP 2: Gemini Vision OCR on key frames ───────────────────────────
        if gemini_model and frames_b64:
            # Use a vision-capable model for OCR
            vision_model = genai.GenerativeModel("gemini-2.5-flash")
            # Send up to 6 frames to avoid large payloads
            frames_to_send = frames_b64[:6]
            parts = [{
                "inline_data": {"mime_type": "image/jpeg", "data": f}
            } for f in frames_to_send]
            parts.insert(0, {
                "text": (
                    "These are frames from a video. "
                    "Extract all visible text/captions/subtitles from these frames. "
                    "Combine them into a single clean English sentence. "
                    "If no text is visible, reply with: NO_TEXT"
                )
            })
            try:
                resp = vision_model.generate_content(parts)
                ocr_text = resp.text.strip()
                if ocr_text and ocr_text != "NO_TEXT":
                    ocr_texts.append(ocr_text)
                print(f"STEP 2 👁️   Gemini OCR result: {ocr_text}")
            except Exception as e:
                print(f"STEP 2 ❌  OCR failed: {e}")

        # ── STEP 3: Whisper audio transcription ───────────────────────────────
        try:
            result = whisper_model.transcribe(tmp_path)
            whisper_text = result["text"].strip()
            if whisper_text:
                print(f"STEP 3 🎤  Whisper: '{whisper_text}'")
            else:
                print("STEP 3 🎤  Whisper: (no speech detected)")
        except Exception as e:
            # Whisper fails via ffmpeg if the video literally has no audio track
            print(f"STEP 3 ⚠️  Whisper ignored (likely no audio stream in video)")

        # ── STEP 4: Combine both sources ──────────────────────────────────────
        all_text_parts = [t for t in [whisper_text] + ocr_texts if t]
        combined_text = " ".join(all_text_parts)
        print(f"STEP 4 📝  Combined text: '{combined_text}'")

        # ── STEP 5: Gemini ISL gloss ───────────────────────────────────────────
        gloss: list[str] = []
        if gemini_model and combined_text:
            try:
                response = gemini_model.generate_content(combined_text)
                raw = response.text.strip()
                raw = re.sub(r"```(?:json)?", "", raw).strip().strip("```").strip()
                gloss = json.loads(raw)
                print(f"STEP 5 ✋  ISL Gloss: {gloss}")
            except Exception as e:
                print(f"STEP 5 ❌  Gloss failed: {e}")
                gloss = [w.upper() for w in combined_text.split() if len(w) > 2]
        elif combined_text:
            gloss = [w.upper() for w in combined_text.split() if len(w) > 2]

        animation_sequence = build_animation_sequence(gloss)
        print(f"STEP 6 ✅  {len(animation_sequence)} animation clips ready")
        print("="*55 + "\n")

        return JSONResponse({
            "whisper_text": whisper_text,
            "ocr_text": " | ".join(ocr_texts),
            "combined_text": combined_text,
            "gloss": gloss,
            "animation_sequence": animation_sequence,
        })

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)