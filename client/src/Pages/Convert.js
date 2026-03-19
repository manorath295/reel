import '../App.css';
import React, { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'font-awesome/css/font-awesome.min.css';

// React Three Fiber - declarative Three.js in React
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMHumanBoneName, VRMUtils } from '@pixiv/three-vrm';

// Kalidokit for ISL Gloss → bone rotation math
import { Pose as KalidokitPose, Hand as KalidokitHand } from 'kalidokit';

// Original Sign Kit hardcoded animations (still work!)
import * as words from '../Animations/words';
import * as alphabets from '../Animations/alphabets';
import { defaultPose } from '../Animations/defaultPose';

// Avatar model paths  
import xbotGlb from '../Models/xbot/xbot.glb';
import ybotGlb from '../Models/ybot/ybot.glb';
import xbotPic from '../Models/xbot/xbot.png';
import ybotPic from '../Models/ybot/ybot.png';

import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition';

// ── Kalidokit Finger Map ──────────────────────────────────────────────────────
const K_FINGER_MAP = {
  Thumb:  ['Thumb1', 'Thumb2', 'Thumb3'],
  Index:  ['IndexProximal', 'IndexIntermediate', 'IndexDistal'],
  Middle: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'],
  Ring:   ['RingProximal', 'RingIntermediate', 'RingDistal'],
  Pinky:  ['PinkyProximal', 'PinkyIntermediate', 'PinkyDistal'],
};

// ── VRM Avatar Scene Component ──────────────────────────────────────────
// Uses @pixiv/three-vrm which has a standardized humanoid skeleton → Kalidokit compatible
function VRMAvatarScene({ animRef, setVrmError }) {
  const vrmRef = useRef(null);
  const clockRef = useRef(new THREE.Clock());

  // Load VRM using GLTFLoader + VRMLoaderPlugin
  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
        loader.load(
      '/AvatarSample_B.vrm',
      (gltf) => {
        const vrm = gltf.userData.vrm;
        vrm.scene.rotation.y = 0; // VRM models default face toward camera (-Z)
        vrmRef.current = vrm;
        animRef.current.vrm = vrm;
        animRef.current.avatar = vrm; // keep backward compat alias
        // Disable the frustum culling so we don't get invisible arms
        vrm.scene.traverse((obj) => {
          obj.frustumCulled = false;
        });
      },
      undefined,
      (err) => {
        console.error('VRM load error:', err);
        if (setVrmError) setVrmError(err.message || String(err));
      }
    );
  }, [animRef, setVrmError]);

  const SMOOTH = 0.08; // Ultra-smooth gliding
  const HSMOOTH = 0.15;
  const lerpB = (cur, tar, a) => cur + (tar - cur) * a;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Helper: safely rotate a VRM humanoid bone 
  const rigRotation = (vrm, boneName, rotation, dampener = 1, lerpAmt = SMOOTH) => {
    if (!vrm || !rotation) return;
    const boneNode = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!boneNode) return;
    const euler = new THREE.Euler(rotation.x * dampener, rotation.y * dampener, rotation.z * dampener, 'XYZ');
    const quat = new THREE.Quaternion().setFromEuler(euler);
    boneNode.quaternion.slerp(quat, lerpAmt);
  };

  useFrame(() => {
    const ref = animRef.current;
    const vrm = ref.vrm;
    if (!vrm) return;
    // Keep reference alias for animation compatibility
    if (!ref.avatar) ref.avatar = vrm;

    // ── JSON Kalidokit animation playback ──────────────────────────────────
    if (ref.jsonFrames && ref.currentFrame < ref.jsonFrames.length) {
      const now = performance.now();
      // Frame duration in ms: base fps from video, scaled by speed slider (lower = faster)
      const frameDuration = (1000 / (ref.fps || 25)) * (0.1 / Math.max(ref.speed || 0.1, 0.01));

      if (now - (ref.lastFrameTime || 0) >= frameDuration) {
        const frameData = ref.jsonFrames[ref.currentFrame];

        // P = 2D screen-normalized coords (pose field, 0-1, Y=0 is top) — used for angles
        const P = Array(33).fill(null);
        (frameData.pose || []).forEach((lm) => {
          if ((lm.visibility || 1) > 0.15) P[lm.id] = { x: lm.x, y: lm.y };
        });

        // ── Draw large human stick figure on main canvas ─────────────────────
        const debugCanvas = document.getElementById('debug_canvas');
        if (debugCanvas) {
          // Sync canvas resolution to CSS size
          if (debugCanvas.width !== debugCanvas.clientWidth) debugCanvas.width = debugCanvas.clientWidth;
          if (debugCanvas.height !== debugCanvas.clientHeight) debugCanvas.height = debugCanvas.clientHeight;
          const W = debugCanvas.width;
          const H = debugCanvas.height;
          const ctx = debugCanvas.getContext('2d');
          ctx.clearRect(0, 0, W, H);

          // Helper: convert normalized [0-1] pose coords → canvas px
          const px = (lm) => lm ? { x: lm.x * W, y: lm.y * H } : null;

          // ── Draw a thick glowing bone line ──
          const bone = (a, b, color = '#4ade80', width = 8) => {
            const pa = px(a), pb = px(b);
            if (!pa || !pb) return;
            ctx.save();
            ctx.shadowBlur = 12;
            ctx.shadowColor = color;
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.stroke();
            ctx.restore();
          };

          // ── Draw a joint dot ──
          const joint = (lm, r = 7, fill = '#fff', glow = '#6ee7b7') => {
            const p = px(lm);
            if (!p) return;
            ctx.save();
            ctx.shadowBlur = 14;
            ctx.shadowColor = glow;
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          };

          // Body: torso
          bone(P[11], P[12], '#60a5fa', 10); // Shoulders
          bone(P[23], P[24], '#60a5fa', 10); // Hips
          bone(P[11], P[23], '#60a5fa', 8);  // Left torso
          bone(P[12], P[24], '#60a5fa', 8);  // Right torso

          // Arms
          bone(P[11], P[13], '#4ade80', 9);  // L upper arm
          bone(P[13], P[15], '#4ade80', 7);  // L lower arm
          bone(P[12], P[14], '#4ade80', 9);  // R upper arm
          bone(P[14], P[16], '#4ade80', 7);  // R lower arm

          // Neck
          const midShoulder = (P[11] && P[12]) ? { x: (P[11].x + P[12].x) / 2, y: (P[11].y + P[12].y) / 2 } : null;
          if (midShoulder && P[0]) bone(midShoulder, P[0], '#f9a8d4', 6);

          // Legs
          bone(P[23], P[25], '#a78bfa', 9);  // L upper leg
          bone(P[25], P[27], '#a78bfa', 7);  // L lower leg
          bone(P[24], P[26], '#a78bfa', 9);  // R upper leg
          bone(P[26], P[28], '#a78bfa', 7);  // R lower leg

          // Joint dots
          [11,12,13,14,15,16,23,24,25,26,27,28].forEach(i => joint(P[i], 7, '#fff', '#6ee7b7'));
          joint(P[15], 9, '#4ade80', '#4ade80'); // L wrist accent
          joint(P[16], 9, '#4ade80', '#4ade80'); // R wrist accent

          // ── Head circle ──
          if (P[0]) {
            const hp = px(P[0]);
            // Calculate head size relative to shoulder width
            const shoulderW = (P[11] && P[12]) ? Math.abs(P[12].x - P[11].x) * W : 60;
            const headR = Math.max(shoulderW * 0.35, 28);

            ctx.save();
            ctx.shadowBlur = 20;
            ctx.shadowColor = '#fbbf24';
            // Head fill
            ctx.fillStyle = '#fde68a';
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(hp.x, hp.y - headR * 0.5, headR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            const hy = hp.y - headR * 0.5;
            // Eyes
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#1e293b';
            ctx.beginPath(); ctx.arc(hp.x - headR * 0.3, hy - headR * 0.15, headR * 0.1, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(hp.x + headR * 0.3, hy - headR * 0.15, headR * 0.1, 0, Math.PI * 2); ctx.fill();
            // Smile
            ctx.strokeStyle = '#92400e';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(hp.x, hy + headR * 0.05, headR * 0.3, 0.2, Math.PI - 0.2);
            ctx.stroke();
            ctx.restore();
          }

          // ── Finger bones ──
          const FINGER_COLORS = ['#f87171', '#fbbf24', '#4ade80', '#60a5fa', '#c084fc'];
          const FINGER_CONNECTIONS = [
            [0,1],[1,2],[2,3],[3,4],
            [0,5],[5,6],[6,7],[7,8],
            [0,9],[9,10],[10,11],[11,12],
            [0,13],[13,14],[14,15],[15,16],
            [0,17],[17,18],[18,19],[19,20]
          ];
          const FCOLOR_IDX = [0,0,0,0, 1,1,1,1, 2,2,2,2, 3,3,3,3, 4,4,4,4];

          const drawHand = (hand) => {
            if (!hand || hand.length < 5) return;
            const lms = Array(21).fill(null);
            hand.forEach(p => { if (p && p.id != null) lms[p.id] = p; });
            FINGER_CONNECTIONS.forEach(([a, b], ci) => {
              const pa = lms[a] ? px(lms[a]) : null;
              const pb = lms[b] ? px(lms[b]) : null;
              if (!pa || !pb) return;
              const clr = FINGER_COLORS[FCOLOR_IDX[ci]];
              ctx.save();
              ctx.shadowBlur = 8; ctx.shadowColor = clr;
              ctx.strokeStyle = clr; ctx.lineWidth = 4; ctx.lineCap = 'round';
              ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
              ctx.restore();
            });
            lms.forEach(p => {
              if (!p) return;
              const pp = px(p);
              ctx.fillStyle = '#fff';
              ctx.beginPath(); ctx.arc(pp.x, pp.y, 4, 0, Math.PI * 2); ctx.fill();
            });
          };
          drawHand(frameData.left_hand);
          drawHand(frameData.right_hand);
        }

        // ── KALIDOKIT POSE SOLVE ────────────────────────────────────────────
        // Build properly-indexed [0..32] arrays (Kalidokit NEEDS id-order)
        const poseRaw3d = (frameData.pose3d || frameData.pose || []);
        const poseRaw2d = (frameData.pose || []);
        
        // Sometimes JSON is sparse arrays with ID field, sometimes it's direct array with nulls
        const p3d = Array(33).fill(null);
        const p2d = Array(33).fill(null);
        
        poseRaw3d.forEach((lm, i) => { 
            if (!lm) return;
            const id = lm.id !== undefined ? lm.id : i;
            if (id < 33) p3d[id] = { x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility || 1 }; 
        });
        
        poseRaw2d.forEach((lm, i) => { 
            if (!lm) return;
            const id = lm.id !== undefined ? lm.id : i;
            if (id < 33) p2d[id] = { x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility || 1 }; 
        });

        // Kalidokit needs p3d to be fully populated with at least *something* if it solves,
        // so we fill nulls with 0s to prevent crash, though visibility 0 ignores them.
        for(let i=0; i<33; i++) {
            if(!p3d[i]) p3d[i] = {x:0, y:0, z:0, visibility:0};
            if(!p2d[i]) p2d[i] = {x:0, y:0, z:0, visibility:0};
        }

        if (poseRaw3d.length >= 10) {
          let poseRig;
          try { poseRig = KalidokitPose.solve(p3d, p2d, { runtime: 'mediapipe', video: null }); } catch(e) { console.warn('pose solve err', e); }
          if (poseRig) {
            rigRotation(vrm, VRMHumanBoneName.Chest,         poseRig.Spine2, 0.6);
            rigRotation(vrm, VRMHumanBoneName.Spine,         poseRig.Spine, 0.45);
            rigRotation(vrm, VRMHumanBoneName.Neck,          poseRig.Neck, 0.8);
            rigRotation(vrm, VRMHumanBoneName.Head,          poseRig.Head, 0.7);
            rigRotation(vrm, VRMHumanBoneName.LeftUpperArm,  poseRig.LeftUpperArm, 1.0);
            rigRotation(vrm, VRMHumanBoneName.LeftLowerArm,  poseRig.LeftLowerArm, 1.0);
            rigRotation(vrm, VRMHumanBoneName.RightUpperArm, poseRig.RightUpperArm, 1.0);
            rigRotation(vrm, VRMHumanBoneName.RightLowerArm, poseRig.RightLowerArm, 1.0);
          }
        }

        // ── KALIDOKIT HAND SOLVE ──────────────────────────────────────────────
        const solveHand = (handData, side) => {
          if (!handData || handData.length < 5) return;
          
          const lms = Array(21).fill({x:0, y:0, z:0});
          handData.forEach((lm, i) => {
              if (!lm) return;
              const id = lm.id !== undefined ? lm.id : i;
              if (id < 21) lms[id] = { x: lm.x, y: lm.y, z: lm.z };
          });
          
          let rig; try { rig = KalidokitHand.solve(lms, side); } catch { return; }
          if (!rig) return;
          const S = side;
          // Wrists
          rigRotation(vrm, VRMHumanBoneName[`${S}Hand`], rig[`${S}Wrist`], 1.0, HSMOOTH);
          // Fingers
          const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
          fingers.forEach(f => {
            ['Proximal', 'Intermediate', 'Distal'].forEach((seg, idx) => {
              const kName = f === 'Little' ? `${S}Pinky${seg}` : `${S}${f}${seg}`;
              const bName = VRMHumanBoneName[`${S}${f === 'Little' ? 'Little' : f}${seg}`];
              if (bName) rigRotation(vrm, bName, rig[kName], 1.0, HSMOOTH);
            });
          });
        };
        solveHand(frameData.right_hand, 'Right');
        solveHand(frameData.left_hand,  'Left');


        ref.currentFrame++;
        ref.lastFrameTime = now;

        // Progress bar update (direct DOM — no React re-render lag)
        const pBar = document.getElementById('aiProgressBar');
        const pTxt = document.getElementById('aiProgressText');
        if (pBar && pTxt && ref.jsonFrames) {
          const pct = Math.round((ref.currentFrame / ref.jsonFrames.length) * 100);
          pBar.style.width = `${pct}%`;
          const totalSec = (ref.jsonFrames.length / (ref.fps || 25)).toFixed(1);
          const curSec = (ref.currentFrame / (ref.fps || 25)).toFixed(1);
          pTxt.innerText = `${curSec}s / ${totalSec}s  (${pct}%)`;
        }

        // Done with this clip
        if (ref.currentFrame >= ref.jsonFrames.length) {
          ref.jsonFrames = null;
          const pTxt2 = document.getElementById('aiProgressText');
          if (pTxt2) pTxt2.innerText = 'Finished ✅';
          if (ref.onJsonFinish) { const cb = ref.onJsonFinish; ref.onJsonFinish = null; cb(); }
        }
      }
    }

    // ── Classic hardcoded Sign Kit animation playback ─────────────────────
    if (!ref.jsonFrames && ref.animations?.length > 0) {
      if (ref.animations[0].length) {
        if (!ref.flag) {
          if (ref.animations[0][0] === 'add-text') {
            ref.setTextCb?.(prev => prev + ref.animations[0][1]);
            ref.animations.shift();
          } else {
            for (let i = 0; i < ref.animations[0].length;) {
              const [boneName, action, axis, limit, sign] = ref.animations[0][i];
              const bone = ref.avatar.getObjectByName(boneName);
              if (!bone) { i++; continue; }
              if (sign === '+' && bone[action][axis] < limit) {
                bone[action][axis] = Math.min(bone[action][axis] + (ref.speed || 0.1), limit);
                i++;
              } else if (sign === '-' && bone[action][axis] > limit) {
                bone[action][axis] = Math.max(bone[action][axis] - (ref.speed || 0.1), limit);
                i++;
              } else {
                ref.animations[0].splice(i, 1);
              }
            }
          }
        }
      } else {
        ref.flag = true;
        setTimeout(() => { ref.flag = false; }, ref.pause || 800);
        ref.animations.shift();
      }
    }

    // CRITICAL: update VRM physics/bone constraints every frame
    vrm.update(clockRef.current.getDelta());
  });

  return vrmRef.current ? <primitive object={vrmRef.current.scene} /> : null;
}

// ── Main Convert Component ────────────────────────────────────────────────────
function Convert() {
  const [text, setText] = useState('');
  const [botGlb, setBotGlb] = useState(ybotGlb);
  const [speed, setSpeed] = useState(0.1);
  const [vrmError, setVrmError] = useState(null);
  const [pause, setPause] = useState(800);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const [shouldRecord, setShouldRecord] = useState(false);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const startRecording = useCallback(() => {
    if (!shouldRecord) return;
    const canvas = document.getElementById('debug_canvas');
    if (!canvas) return;
    try {
      recordedChunksRef.current = [];
      const stream = canvas.captureStream(30);
      const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
      mr.ondataavailable = e => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sign_language_animation_${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };
      mr.start();
      mediaRecorderRef.current = mr;
    } catch (e) {
      console.warn("MediaRecorder issue:", e);
    }
  }, [shouldRecord]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const animRef = useRef({
    flag: false,
    animations: [],
    jsonFrames: null,
    currentFrame: 0,
    fps: 25,
    lastFrameTime: 0,
    speed: 0.1,
    pause: 800,
    avatar: null,
  });

  // Keep speed/pause in sync with animRef
  useEffect(() => { animRef.current.speed = speed; }, [speed]);
  useEffect(() => { animRef.current.pause = pause; }, [pause]);
  // Let the AvatarScene call setText
  useEffect(() => { animRef.current.setTextCb = setText; }, []);

  const textFromAudio = useRef(null);
  const textFromInput = useRef(null);
  const audioInputRef = useRef(null);

  const { transcript, listening, resetTranscript } = useSpeechRecognition();

  // ── JSON playback helpers ───────────────────────────────────────────────────
  const playJSONFile = useCallback((url) => {
    return new Promise(async (resolve) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Not found: ${url}`);
        let data = await res.json();

        // If the document from MongoDB only contains a link to Supabase, fetch THAT link
        if (data.animation_url) {
          const sRes = await fetch(data.animation_url);
          if (sRes.ok) {
            data = await sRes.json();
          }
        }

        // Removed defaultPose here to allow smooth blending from previous sign

        animRef.current.currentFrame = 0;
        animRef.current.jsonFrames = data.frames;
        animRef.current.fps = data.metadata?.fps || 25;
        animRef.current.lastFrameTime = performance.now();
        animRef.current.onJsonFinish = resolve;

        // Reset progress bar
        const pBar = document.getElementById('aiProgressBar');
        const pTxt = document.getElementById('aiProgressText');
        if (pBar) pBar.style.width = '0%';
        if (pTxt) pTxt.innerText = 'Playing…';
      } catch (e) {
        console.warn('Skipping:', url, e.message);
        resolve();
      }
    });
  }, []);

  const playSequence = useCallback(async (sequence) => {
    startRecording();
    const signClips = sequence.filter(s => s.type === 'sign');
    const spellClips = sequence.filter(s => s.type === 'fingerspell');
    setStatusMsg(`▶ Playing ${signClips.length} signs + ${spellClips.length} finger-spell letters`);
    setText('');
    for (const anim of sequence) {
      if (anim.type === 'sign') {
        setText(prev => prev + `[${anim.word}] `);
      } else {
        setText(prev => prev + anim.word);
      }
      setStatusMsg(`▶ Signing: ${anim.word} (${anim.type})`);
      await playJSONFile(anim.file);
      await new Promise(r => setTimeout(r, anim.type === 'sign' ? pause : (pause / 5)));
    }
    setStatusMsg('✅ Done signing!');
    stopRecording();
  }, [playJSONFile, pause, startRecording, stopRecording]);

  // ── Play demo agriculture_motion.json ──────────────────────────────────────
  const playDemo = useCallback(() => {
    setText('');
    setStatusMsg('▶ Playing demo…');
    playJSONFile('/agriculture_motion.json').then(() => setStatusMsg('✅ Done'));
  }, [playJSONFile]);

  // ── Play custom Agriculture JSON ────────────────────────────────────────
  const playAgriculture = useCallback(() => {
    setText('');
    setStatusMsg('▶ Playing Agriculture (26s)…');
    playJSONFile('/AGRICULTURE_motion.json').then(() => setStatusMsg('✅ Done'));
  }, [playJSONFile]);

  // ── Sign Classic: check MongoDB first, then fallback to hardcoded ──────────
  const sign = useCallback(async (inputRef) => {
    const str = (inputRef.current?.value || '').toUpperCase().trim();
    if (!str) return;
    const strWords = str.split(/\s+/);
    setText('');
    animRef.current.animations = [];
    setIsProcessing(true);
    setStatusMsg('🔍 Checking MongoDB for signs…');
    startRecording();

    for (const word of strWords) {
      // Try MongoDB first via /motion/:word
      let foundInDB = false;
      try {
        const res = await fetch(`http://localhost:8000/motion/${encodeURIComponent(word)}`);
        if (res.ok) {
          let data = await res.json();
          
          // If the DB only has the Supabase link, fetch the full animation data from that link
          if (data.animation_url && !data.frames) {
             const sRes = await fetch(data.animation_url);
             if (sRes.ok) {
               const supData = await sRes.json();
               data.frames = supData.frames;
             }
          }

          if (data.frames && data.frames.length > 0) {
            foundInDB = true;
            setStatusMsg(`▶ Playing from DB: ${word}`);
            setText(prev => prev + `[${word}] `);
            await new Promise(resolve => {
              animRef.current.currentFrame = 0;
              animRef.current.jsonFrames = data.frames;
              animRef.current.fps = data.metadata?.fps || 25;
              animRef.current.lastFrameTime = performance.now();
              animRef.current.onJsonFinish = resolve;
              const pBar = document.getElementById('aiProgressBar');
              const pTxt = document.getElementById('aiProgressText');
              if (pBar) pBar.style.width = '0%';
              if (pTxt) pTxt.innerText = `Playing ${word}…`;
            });
            await new Promise(r => setTimeout(r, pause));
          }
        }
      } catch (e) { /* server not reachable, fallback */ }

      if (!foundInDB) {
        // Fallback to hardcoded word animations
        if (words[word]) {
          setStatusMsg(`▶ Signing (hardcoded): ${word}`);
          setText(prev => prev + `[${word}] `);
          animRef.current.animations.push(['add-text', word + ' ']);
          words[word](animRef.current);
        } else {
          // Fingerspell using JSON files from /public/alphabets/
          setStatusMsg(`✏️ Finger-spelling: ${word}`);
          for (const ch of word.split('')) {
            const upper = ch.toUpperCase();
            if (upper >= 'A' && upper <= 'Z') {
              setText(prev => prev + ch);
              await playJSONFile(`/alphabets/${upper}.json`);
              // Small pause between letters (1/5th of word pause)
              await new Promise(r => setTimeout(r, pause / 5)); 
            }
          }
        }
      }
    }
    setIsProcessing(false);
    setStatusMsg('✅ Done signing!');
    stopRecording();
  }, [pause, startRecording, stopRecording]);

  // ── GenAI Audio Upload ─────────────────────────────────────────────────────
  const videoReelInputRef = useRef(null);

  // ── GenAI Video Reel / Short Upload (OCR + Audio) ─────────────────────────
  const uploadVideoReel = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsProcessing(true);
    setStatusMsg('🎬 Analysing reel… Whisper + Gemini Vision OCR (wait ~20s)');
    setText('');

    const formData = new FormData();
    formData.append('video', file);

    try {
      const res = await fetch('http://localhost:8000/video-ocr-to-sign', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();

      const ocrPart   = data.ocr_text    ? `👁️ OCR: "${data.ocr_text}"` : '';
      const audiopart = data.whisper_text ? `🎤 Heard: "${data.whisper_text}"` : '';
      setText(`${audiopart}\n${ocrPart}\n✋ ISL: ${data.gloss.join(' → ')}`);
      setStatusMsg(`🤖 ${data.gloss.length} signs from reel — playing…`);

      if (data.animation_sequence?.length > 0) {
        await playSequence(data.animation_sequence);
      } else {
        setStatusMsg('⚠️ No animations found for this reel.');
      }
    } catch (err) {
      setStatusMsg(`❌ Error: ${err.message}`);
    } finally {
      setIsProcessing(false);
      if (videoReelInputRef.current) videoReelInputRef.current.value = '';
    }
  }, [playSequence]);

  const uploadAudio = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsProcessing(true);
    setStatusMsg('🎙️ Transcribing with Whisper… (wait ~10s)');
    setText('');

    const formData = new FormData();
    formData.append('audio', file);

    try {
      const res = await fetch('http://localhost:8000/transcribe-and-sign', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();

      // Show transcript + gloss in text area
      setText(`🎙️ Heard: "${data.transcript}"\n✋ ISL Gloss: ${data.gloss.join(' → ')}\n\n`);
      setStatusMsg(`🤖 Gemini ISL: [${data.gloss.join(', ')}] — playing signs + dots…`);

      if (data.animation_sequence?.length > 0) {
        await playSequence(data.animation_sequence);
      } else {
        setStatusMsg('⚠️ No animations found. Only AGRICULTURE_motion.json available now.');
      }
    } catch (err) {
      setStatusMsg(`❌ Error: ${err.message}`);
      setText(`Error: ${err.message}`);
    } finally {
      setIsProcessing(false);
      e.target.value = '';
    }
  }, [playSequence]);

  // ── Text-to-Sign via backend ───────────────────────────────────────────────
  const signViaAI = useCallback(async (inputRef) => {
    const text = inputRef.current?.value?.trim();
    if (!text) return;
    setIsProcessing(true);
    setStatusMsg('🤖 Sending to Gemini…');

    try {
      const res = await fetch('http://localhost:8000/text-to-sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      setStatusMsg(`ISL Gloss: ${data.gloss.join(' ')}`);
      if (data.animation_sequence?.length > 0) {
        await playSequence(data.animation_sequence);
      }
    } catch (err) {
      // Fallback: hardcoded sign kit
      sign(inputRef);
    } finally {
      setIsProcessing(false);
    }
  }, [playSequence, sign]);

  return (
    <div className='container-fluid'>
      <div className='row'>

        {/* ── Left Panel (Controls) ─────────────────────────────────────── */}
        <div className='col-md-3' style={{ maxHeight: '100vh', overflowY: 'auto', padding: '12px' }}>

          {/* Processed text */}
          <label className='label-style'>Processed Text</label>
          <textarea rows={3} value={text} className='w-100 input-style' readOnly />

          {/* Status indicator */}
          {statusMsg && (
            <div className='alert alert-info py-1 px-2 mt-1' style={{ fontSize: '0.82rem' }}>
              {statusMsg}
            </div>
          )}

          {/* Speech recognition */}
          <label className='label-style'>Speech Recognition: {listening ? 'on 🔴' : 'off'}</label>
          <div className='space-between mb-2'>
            <button className='btn btn-primary btn-style w-33' onClick={() => SpeechRecognition.startListening({ continuous: true })}>
              Mic On <i className='fa fa-microphone' />
            </button>
            <button className='btn btn-primary btn-style w-33' onClick={SpeechRecognition.stopListening}>
              Mic Off <i className='fa fa-microphone-slash' />
            </button>
            <button className='btn btn-primary btn-style w-33' onClick={resetTranscript}>Clear</button>
          </div>
          <textarea rows={2} ref={textFromAudio} value={transcript} placeholder='Speech input…' className='w-100 input-style' readOnly />
          <button onClick={() => sign(textFromAudio)} className='btn btn-primary w-100 btn-style btn-start mt-1'>
            Sign (Classic)
          </button>
          <button onClick={() => signViaAI(textFromAudio)} disabled={isProcessing} className='btn btn-success w-100 btn-style btn-start mt-1'>
            Sign via AI 🤖
          </button>

          <hr />

          {/* Text input */}
          <label className='label-style'>Text Input</label>
          <textarea rows={2} ref={textFromInput} placeholder='Type English or Hindi…' className='w-100 input-style' />
          <button onClick={() => sign(textFromInput)} className='btn btn-primary w-100 btn-style btn-start mt-1'>
            Sign (Classic)
          </button>
          <button onClick={() => signViaAI(textFromInput)} disabled={isProcessing} className='btn btn-success w-100 btn-style btn-start mt-1'>
            Sign via AI 🤖
          </button>

          <hr />

          {/* Demo JSON playback */}
          <button onClick={playDemo} className='btn btn-warning w-100 btn-style btn-start'>
            ▶ Play Demo Motion (JSON)
          </button>
          
          <button onClick={playAgriculture} className='btn w-100 btn-style btn-start mt-2' style={{ backgroundColor: '#ff9800', borderColor: '#ff9800', color: 'white' }}>
            ▶ Play Agriculture Video (26s)
          </button>

          <hr />

          {/* GenAI audio + video reel upload */}
          <div className='p-3 rounded mt-2' style={{ background: '#f0ecfc', border: '1px solid #d5c8fa' }}>
            <label className='label-style mb-1' style={{ color: '#6f42c1' }}>
              <i className='fa fa-magic me-1' /> GenAI ISL Translator
            </label>
            <p style={{ fontSize: '0.75rem', color: '#6c757d', marginBottom: '6px' }}>
              Upload audio/video → Whisper + Gemini → ISL Avatar
            </p>

            {/* Audio upload */}
            <input
              type='file'
              accept='audio/*'
              ref={audioInputRef}
              onChange={uploadAudio}
              className='form-control mb-2'
              style={{ fontSize: '0.82rem' }}
              disabled={isProcessing}
            />
            <button
              onClick={() => audioInputRef.current?.click()}
              disabled={isProcessing}
              className='btn w-100 btn-style mb-2'
              style={{ backgroundColor: '#6f42c1', borderColor: '#6f42c1', color: '#fff' }}
            >
              {isProcessing ? '⏳ Processing…' : '🎙️ Upload Audio'}
            </button>

            {/* Video Reel upload */}
            <input
              type='file'
              accept='video/*'
              ref={videoReelInputRef}
              onChange={uploadVideoReel}
              className='form-control mb-2'
              style={{ fontSize: '0.82rem' }}
              disabled={isProcessing}
            />
            <button
              onClick={() => videoReelInputRef.current?.click()}
              disabled={isProcessing}
              className='btn w-100 btn-style'
              style={{ backgroundColor: '#e91e8c', borderColor: '#e91e8c', color: '#fff' }}
            >
              {isProcessing ? '⏳ Analysing Reel…' : '🎬 Upload Reel/Short (OCR)'}
            </button>
          </div>
        </div>

        {/* ── Centre (Stick Figure Canvas + Progress Bar) ──────────────── */}
        <div className='col-md-7 p-0' style={{ position: 'relative', backgroundColor: '#111827', display: 'flex', flexDirection: 'column' }}>
          {/* Main stick figure canvas — full height */}
          <canvas
            id="debug_canvas"
            style={{
              width: '100%',
              height: 'calc(100vh - 90px)',
              background: 'linear-gradient(180deg, #0f172a 0%, #1e293b 100%)'
            }}
          />

          {/* Progress Bar */}
          <div className='p-2' style={{ background: '#1e293b', borderTop: '1px solid #334155' }}>
            <div className='d-flex justify-content-between mb-1'>
              <small id='aiProgressText' className='fw-bold' style={{ color: '#94a3b8' }}>Ready</small>
            </div>
            <div className='progress' style={{ height: '8px', borderRadius: '8px', background: '#334155' }}>
              <div
                id='aiProgressBar'
                className='progress-bar progress-bar-striped progress-bar-animated'
                role='progressbar'
                style={{ width: '0%', transition: 'width 0.1s linear', background: 'linear-gradient(90deg, #6366f1, #8b5cf6)' }}
              />
            </div>
          </div>

          {/* Hidden 3D canvas kept for Kalidokit bone solve — invisible */}
          <div style={{ width: 0, height: 0, overflow: 'hidden', position: 'absolute' }}>
            <Canvas
              style={{ width: '1px', height: '1px' }}
              camera={{ position: [0, 0.9, 2.8], fov: 45 }}
              gl={{ preserveDrawingBuffer: false, powerPreference: 'low-power' }}
            >
              <ambientLight intensity={1} />
              <Suspense fallback={null}>
                <VRMAvatarScene animRef={animRef} setVrmError={setVrmError} />
              </Suspense>
            </Canvas>
          </div>
        </div>

        {/* ── Right Panel (Avatar + Speed) ─────────────────────────────── */}
        <div className='col-md-2' style={{ padding: '12px' }}>
          <p className='bot-label'>Select Avatar</p>
          <img src={xbotPic} className='bot-image col-md-11' onClick={() => setBotGlb(xbotGlb)} alt='XBOT' />
          <img src={ybotPic} className='bot-image col-md-11' onClick={() => setBotGlb(ybotGlb)} alt='YBOT' />

          <p className='label-style mt-3'>Animation Speed: {Math.round(speed * 100) / 100}</p>
          <input type="range" min="0.05" max="0.5" step="0.01" value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} className='form-range w-100' />

          <p className='label-style'>Pause time: {pause} ms</p>
          <input type="range" min="0" max="2000" step="100" value={pause} onChange={(e) => setPause(parseInt(e.target.value))} className='form-range w-100' />

          <div className="form-check mt-3 mb-3">
            <input className="form-check-input" type="checkbox" id="recordCheck" checked={shouldRecord} onChange={e => setShouldRecord(e.target.checked)} />
            <label className="form-check-label" htmlFor="recordCheck" style={{fontSize: '0.85rem', color: '#cbd5e1', cursor: 'pointer'}}>
               🎥 Auto-Download Video
            </label>
          </div>

          <hr />
          <p className='label-style' style={{ fontSize: '0.75rem' }}>
            <strong>Backend:</strong><br />
            <code>uvicorn main:app --port 8000</code>
          </p>
        </div>
      </div>
    </div>
  );
}

export default Convert;