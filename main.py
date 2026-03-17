import cv2
import mediapipe as mp
import json

mp_holistic = mp.solutions.holistic
mp_drawing = mp.solutions.drawing_utils

video_path = "expensive.mp4"
cap = cv2.VideoCapture(video_path)

motion_data = []

with mp_holistic.Holistic(
    static_image_mode=False,
    model_complexity=2,
    enable_segmentation=False,
    refine_face_landmarks=False
) as holistic:

    frame_id = 0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        frame_id += 1

        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = holistic.process(rgb_frame)

        frame_data = {
            "frame": frame_id,
            "pose": [],
            "left_hand": [],
            "right_hand": []
        }

        # Pose landmarks
        if results.pose_landmarks:
            for lm in results.pose_landmarks.landmark:
                frame_data["pose"].append([lm.x, lm.y, lm.z])

        # Left hand
        if results.left_hand_landmarks:
            for lm in results.left_hand_landmarks.landmark:
                frame_data["left_hand"].append([lm.x, lm.y, lm.z])

        # Right hand
        if results.right_hand_landmarks:
            for lm in results.right_hand_landmarks.landmark:
                frame_data["right_hand"].append([lm.x, lm.y, lm.z])

        motion_data.append(frame_data)

cap.release()

with open("expensive_motion.json", "w") as f:
    json.dump(motion_data, f)

print("Extraction complete!")
