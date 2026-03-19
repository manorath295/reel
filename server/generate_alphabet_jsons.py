import cv2
import mediapipe as mp
import os
import json

# ── 1. CONFIG ──
INPUT_FOLDER = r"d:\ISL_CH"
OUTPUT_FOLDER = r"d:\Sign-Kit-An-Avatar-based-ISL-Toolkit\client\public\alphabets"

if not os.path.exists(OUTPUT_FOLDER):
    os.makedirs(OUTPUT_FOLDER)

mp_holistic = mp.solutions.holistic

def fmt(i, lm): 
    return {"id": i, "x": round(lm.x, 4), "y": round(lm.y, 4)}

processed_letters = set()

# ── 2. START PROCESSING ──
print(f"🔍 Scanning {INPUT_FOLDER}...")
with mp_holistic.Holistic(static_image_mode=True, model_complexity=1) as holistic:
    files = sorted(os.listdir(INPUT_FOLDER))
    
    for filename in files:
        if not filename.endswith((".jpg", ".png", ".jpeg")):
            continue
            
        # Extract letter from filename (e.g., "A (103).jpg" -> "A")
        # Handle cases like "A (103).jpg" or "E1 (108).jpg"
        clean_name = filename.split(" ")[0].upper()
        letter = clean_name[0] # Take first char (A-Z)
        
        if not letter.isalpha():
            continue

        # If we already have this letter, skip (user wants 26 files)
        if letter in processed_letters:
            continue
        
        img_path = os.path.join(INPUT_FOLDER, filename)
        img = cv2.imread(img_path)
        if img is None: 
            print(f"⚠️ Could not read {filename}")
            continue
        
        # Process image
        res = holistic.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        
        frames_data = []
        pose2d, left_hand, right_hand = [], None, None
        
        if res.pose_landmarks:
            pose2d = [fmt(i, lm) for i, lm in enumerate(res.pose_landmarks.landmark)]
        if res.left_hand_landmarks:
            left_hand = [fmt(i, lm) for i, lm in enumerate(res.left_hand_landmarks.landmark)]
        if res.right_hand_landmarks:
            right_hand = [fmt(i, lm) for i, lm in enumerate(res.right_hand_landmarks.landmark)]
            
        # An image is just 1 frame, but we repeat it for 10 frames 
        # to give the avatar time to hold the pose during fingerspelling
        for _ in range(10):
            frames_data.append({
                "pose": pose2d, 
                "left_hand": left_hand, 
                "right_hand": right_hand
            })
            
        # Save to local alphabets folder
        output_path = os.path.join(OUTPUT_FOLDER, f"{letter}.json")
        with open(output_path, "w") as f:
            json.dump({
                "word": letter, 
                "frames": frames_data, 
                "metadata": {"fps": 25, "total_frames": 10}
            }, f)
        
        processed_letters.add(letter)
        print(f"✅ Generated {letter}.json from {filename}")

print(f"\n🎉 DONE! Generated {len(processed_letters)} alphabet files in {OUTPUT_FOLDER}")
