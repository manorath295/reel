import cv2
import mediapipe as mp
import json
import os
import argparse
import sys

# Define proper output folder
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'client', 'public')

# Initialize MediaPipe modules (works with mediapipe 0.10.x)
mp_pose  = mp.solutions.pose
mp_hands = mp.solutions.hands

def process_video(video_path, output_json_name=None):
    if not os.path.exists(video_path):
        print(f"Error: File '{video_path}' not found.")
        sys.exit(1)

    if not output_json_name:
        filename = os.path.basename(video_path)
        name, _ = os.path.splitext(filename)
        output_json_name = f"{name}_motion.json"

    output_path = os.path.join(OUTPUT_DIR, output_json_name)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps == 0.0 or not fps:
        fps = 25.0

    frames_data = []

    with mp_pose.Pose(
        min_detection_confidence=0.3,
        min_tracking_confidence=0.3,
        model_complexity=2
    ) as pose, mp_hands.Hands(
        min_detection_confidence=0.3,
        min_tracking_confidence=0.3,
        max_num_hands=2,
        model_complexity=1
    ) as hands:

        frame_idx = 0
        while cap.isOpened():
            success, image = cap.read()
            if not success:
                break

            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            image_rgb.flags.writeable = False

            pose_results  = pose.process(image_rgb)
            hands_results = hands.process(image_rgb)

            image_rgb.flags.writeable = True

            frame_data = {
                "frame": frame_idx,
                "pose": [],
                "pose3d": [],
                "left_hand": [],
                "right_hand": []
            }

            # 2D Pose landmarks
            if pose_results.pose_landmarks:
                for idx, lm in enumerate(pose_results.pose_landmarks.landmark):
                    frame_data["pose"].append({
                        "id": idx, "x": lm.x, "y": lm.y,
                        "z": lm.z, "visibility": lm.visibility
                    })

            # 3D Pose world landmarks
            if pose_results.pose_world_landmarks:
                w = image.shape[1]
                for idx, lm in enumerate(pose_results.pose_world_landmarks.landmark):
                    frame_data["pose3d"].append({
                        "id": idx, "x": lm.x, "y": lm.y,
                        "z": lm.z * w, "visibility": lm.visibility
                    })

            # Hand landmarks — classify left/right from handedness label
            if hands_results.multi_hand_landmarks and hands_results.multi_handedness:
                for hand_lms, handedness in zip(
                    hands_results.multi_hand_landmarks,
                    hands_results.multi_handedness
                ):
                    label = handedness.classification[0].label  # "Left" or "Right"
                    lm_list = []
                    for idx, lm in enumerate(hand_lms.landmark):
                        lm_list.append({
                            "id": idx, "x": lm.x, "y": lm.y,
                            "z": lm.z, "visibility": 1.0
                        })
                    # MediaPipe returns mirrored labels for front-facing camera
                    # "Right" hand from camera = left_hand in screen coords and vice versa
                    if label == "Right":
                        frame_data["right_hand"] = lm_list
                    else:
                        frame_data["left_hand"] = lm_list

            frames_data.append(frame_data)
            frame_idx += 1

            if frame_idx % 30 == 0:
                print(f"Processed {frame_idx} frames...")

    cap.release()

    # ── Carry-forward interpolation for missing hand frames ────────────────────
    # When hand goes out of frame briefly, copy last known position so animation
    # doesn't snap to zero (avoids jarring disappearing hands).
    last_left  = []
    last_right = []
    for frame in frames_data:
        if frame["left_hand"]:
            last_left = frame["left_hand"]
        elif last_left:
            frame["left_hand"] = last_left   # fill from last known

        if frame["right_hand"]:
            last_right = frame["right_hand"]
        elif last_right:
            frame["right_hand"] = last_right  # fill from last known
    # ──────────────────────────────────────────────────────────────────────────

    out_data = {
        "metadata": {
            "source": os.path.basename(video_path),
            "fps": fps,
            "total_frames": len(frames_data)
        },
        "frames": frames_data
    }

    with open(output_path, "w") as f:
        json.dump(out_data, f)

    left_count  = sum(1 for f in frames_data if f["left_hand"])
    right_count = sum(1 for f in frames_data if f["right_hand"])
    print(f"\n✅ Done! Extracted {len(frames_data)} frames.")
    print(f"   Left hand detected  in {left_count}/{len(frames_data)} frames")
    print(f"   Right hand detected in {right_count}/{len(frames_data)} frames")
    print(f"   Saved to: {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract 3D Pose + Hands from MP4 for ISL Sign Kit.")
    parser.add_argument("video", help="Path to input .mp4 file")
    parser.add_argument("--out", "-o", help="Output JSON filename (e.g. WORD_motion.json)", default=None)
    args = parser.parse_args()
    process_video(args.video, args.out)
