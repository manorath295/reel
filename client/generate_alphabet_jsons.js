/**
 * generate_alphabet_jsons.js — v2
 * Fixed arm positions so Kalidokit detects the arm raise correctly
 * 75 frames (3s of video) per letter so you can see the sign clearly
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'public', 'alphabets');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const FPS = 25;
const FRAMES = 75; // 3 seconds at 25fps

// ── Build correct arm-raised body pose ──────────────────────────────────────
// MediaPipe normalized coords: x=0..1 (left→right), y=0..1 (top→bottom)
// For ISL: right hand raised in front of face/chest
function makePose() {
  const p = Array.from({ length: 33 }, (_, i) => ({ id: i, x: 0.5, y: 0.5 + i * 0.01, z: 0, visibility: 0.5 }));
  // Face
  p[0] = { id: 0, x: 0.50, y: 0.18, z: 0, visibility: 1 };  // nose
  // Shoulders
  p[11] = { id: 11, x: 0.40, y: 0.36, z: 0, visibility: 1 }; // L shoulder
  p[12] = { id: 12, x: 0.60, y: 0.36, z: 0, visibility: 1 }; // R shoulder
  // Left arm — natural/resting down
  p[13] = { id: 13, x: 0.37, y: 0.55, z: 0, visibility: 1 }; // L elbow
  p[15] = { id: 15, x: 0.36, y: 0.72, z: 0, visibility: 1 }; // L wrist
  // Right arm — RAISED to chest/face signing position
  p[14] = { id: 14, x: 0.65, y: 0.32, z: -0.05, visibility: 1 }; // R elbow (slightly above shoulder)
  p[16] = { id: 16, x: 0.58, y: 0.22, z: -0.10, visibility: 1 }; // R wrist (in front of face)
  // Hips
  p[23] = { id: 23, x: 0.45, y: 0.68, z: 0, visibility: 1 };
  p[24] = { id: 24, x: 0.55, y: 0.68, z: 0, visibility: 1 };
  return p;
}

const SIGN_POSE = makePose();

// ── Hand landmark builder ────────────────────────────────────────────────────
// Center of hand near the right wrist position (0.58, 0.22)
const CX = 0.58, CY = 0.22; // hand center (wrist coords)

function h(wrist, th, ix, mi, ri, pi) {
  const pts = [wrist, ...th, ...ix, ...mi, ...ri, ...pi];
  return pts.map(([x, y], id) => ({ id, x, y, z: -0.05 }));
}

// Finger positions relative to wrist center
// Fingers go UP from wrist (decreasing y = higher on screen)
const HANDS = {
  // A — Fist
  A: h([CX, CY],
    [[CX-0.03, CY-0.03],[CX-0.04, CY-0.05],[CX-0.04, CY-0.06],[CX-0.04, CY-0.07]],
    [[CX-0.01, CY-0.04],[CX-0.01, CY-0.05],[CX-0.01, CY-0.05],[CX-0.01, CY-0.05]],
    [[CX+0.00, CY-0.04],[CX+0.00, CY-0.05],[CX+0.00, CY-0.05],[CX+0.00, CY-0.05]],
    [[CX+0.01, CY-0.04],[CX+0.01, CY-0.05],[CX+0.01, CY-0.05],[CX+0.01, CY-0.05]],
    [[CX+0.02, CY-0.03],[CX+0.02, CY-0.04],[CX+0.02, CY-0.04],[CX+0.02, CY-0.04]]),
  // B — Open palm (all fingers extended)
  B: h([CX, CY],
    [[CX-0.04, CY-0.03],[CX-0.05, CY-0.05],[CX-0.06, CY-0.07],[CX-0.07, CY-0.09]],
    [[CX-0.01, CY-0.04],[CX-0.01, CY-0.07],[CX-0.01, CY-0.09],[CX-0.01, CY-0.11]],
    [[CX+0.00, CY-0.04],[CX+0.00, CY-0.07],[CX+0.00, CY-0.10],[CX+0.00, CY-0.12]],
    [[CX+0.01, CY-0.04],[CX+0.01, CY-0.07],[CX+0.01, CY-0.09],[CX+0.01, CY-0.11]],
    [[CX+0.02, CY-0.03],[CX+0.02, CY-0.06],[CX+0.02, CY-0.08],[CX+0.02, CY-0.09]]),
  // L — Thumb + Index (L shape)
  L: h([CX, CY],
    [[CX-0.04, CY-0.02],[CX-0.06, CY-0.04],[CX-0.08, CY-0.06],[CX-0.09, CY-0.08]],
    [[CX-0.01, CY-0.04],[CX-0.01, CY-0.07],[CX-0.01, CY-0.09],[CX-0.01, CY-0.11]],
    [[CX+0.00, CY-0.04],[CX+0.00, CY-0.05],[CX+0.00, CY-0.05],[CX+0.00, CY-0.05]],
    [[CX+0.01, CY-0.04],[CX+0.01, CY-0.05],[CX+0.01, CY-0.05],[CX+0.01, CY-0.05]],
    [[CX+0.02, CY-0.03],[CX+0.02, CY-0.04],[CX+0.02, CY-0.04],[CX+0.02, CY-0.04]]),
  // V — Index + Middle extended
  V: h([CX, CY],
    [[CX-0.04, CY-0.03],[CX-0.04, CY-0.04],[CX-0.04, CY-0.05],[CX-0.04, CY-0.05]],
    [[CX-0.01, CY-0.04],[CX-0.01, CY-0.07],[CX-0.01, CY-0.09],[CX-0.01, CY-0.11]],
    [[CX+0.00, CY-0.04],[CX+0.00, CY-0.07],[CX+0.00, CY-0.10],[CX+0.00, CY-0.12]],
    [[CX+0.01, CY-0.04],[CX+0.01, CY-0.05],[CX+0.01, CY-0.05],[CX+0.01, CY-0.05]],
    [[CX+0.02, CY-0.03],[CX+0.02, CY-0.04],[CX+0.02, CY-0.04],[CX+0.02, CY-0.04]]),
  // D — Index pointing up
  D: h([CX, CY],
    [[CX-0.04, CY-0.03],[CX-0.04, CY-0.05],[CX-0.04, CY-0.06],[CX-0.04, CY-0.06]],
    [[CX-0.01, CY-0.04],[CX-0.01, CY-0.07],[CX-0.01, CY-0.10],[CX-0.01, CY-0.12]],
    [[CX+0.00, CY-0.04],[CX+0.00, CY-0.05],[CX+0.00, CY-0.05],[CX+0.00, CY-0.05]],
    [[CX+0.01, CY-0.04],[CX+0.01, CY-0.05],[CX+0.01, CY-0.05],[CX+0.01, CY-0.05]],
    [[CX+0.02, CY-0.03],[CX+0.02, CY-0.04],[CX+0.02, CY-0.04],[CX+0.02, CY-0.04]]),
};

// Assign each letter a hand shape
const LETTER_MAP = {
  A:'A', B:'B', C:'B', D:'D', E:'A', F:'B', G:'D', H:'V',
  I:'A', J:'A', K:'V', L:'L', M:'A', N:'A', O:'B', P:'D',
  Q:'D', R:'V', S:'A', T:'A', U:'V', V:'V', W:'B', X:'D',
  Y:'L', Z:'D',
};

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
for (const letter of letters) {
  const handKey = LETTER_MAP[letter] || 'B';
  const rightHand = HANDS[handKey];
  const frame = { pose: SIGN_POSE, pose3d: SIGN_POSE, right_hand: rightHand, left_hand: null };
  const frames = Array.from({ length: FRAMES }, () => frame);
  const json = { metadata: { fps: FPS, total_frames: FRAMES, letter }, frames };
  fs.writeFileSync(path.join(OUT_DIR, `${letter}.json`), JSON.stringify(json));
  console.log(`✅ ${letter} → hand shape: ${handKey}`);
}
console.log(`\n🎉 Done! ${letters.length} files written to public/alphabets/`);
