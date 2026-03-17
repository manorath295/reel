import cv2
import json
import time
import numpy as np
# Load motion file
with open("expensive_motion.json", "r") as f:
    motion_data = json.load(f)

# Create blank canvas size
width = 800
height = 800

# Hand connections (MediaPipe format)
HAND_CONNECTIONS = [
    (0,1),(1,2),(2,3),(3,4),          # Thumb
    (0,5),(5,6),(6,7),(7,8),          # Index
    (0,9),(9,10),(10,11),(11,12),     # Middle
    (0,13),(13,14),(14,15),(15,16),   # Ring
    (0,17),(17,18),(18,19),(19,20)    # Pinky
]

# Simple pose connections (arms only)
POSE_CONNECTIONS = [
    (11,13), (13,15),  # Left arm
    (12,14), (14,16),  # Right arm
    (11,12)            # Shoulders
]

for frame in motion_data:

    canvas = 255 * np.ones((height, width, 3), dtype="uint8")

    # Draw pose
    pose = frame["pose"]
    if len(pose) > 0:
        for connection in POSE_CONNECTIONS:
            start = pose[connection[0]]
            end = pose[connection[1]]

            x1 = int(start[0] * width)
            y1 = int(start[1] * height)
            x2 = int(end[0] * width)
            y2 = int(end[1] * height)

            cv2.line(canvas, (x1,y1), (x2,y2), (0,0,0), 2)

    # Draw hands
    for hand_key in ["left_hand", "right_hand"]:
        hand = frame[hand_key]

        if len(hand) > 0:
            # Draw points
            for lm in hand:
                x = int(lm[0] * width)
                y = int(lm[1] * height)
                cv2.circle(canvas, (x,y), 4, (0,0,255), -1)

            # Draw connections
            for connection in HAND_CONNECTIONS:
                start = hand[connection[0]]
                end = hand[connection[1]]

                x1 = int(start[0] * width)
                y1 = int(start[1] * height)
                x2 = int(end[0] * width)
                y2 = int(end[1] * height)

                cv2.line(canvas, (x1,y1), (x2,y2), (255,0,0), 2)

    cv2.imshow("Stick Skeleton", canvas)

    if cv2.waitKey(30) & 0xFF == ord('q'):
        break

cv2.destroyAllWindows()
