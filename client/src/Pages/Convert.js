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

  const SMOOTH = 0.3;
  const HSMOOTH = 0.5;
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
      // 5x slow for demo / judge presentation
      const frameDuration = (1000 / (ref.fps || 25)) * (0.1 / Math.max(ref.speed || 0.1, 0.01)) * 5.0;

      if (now - (ref.lastFrameTime || 0) >= frameDuration) {
        const frameData = ref.jsonFrames[ref.currentFrame];

        // P = 2D screen-normalized coords (pose field, 0-1, Y=0 is top) — used for angles
        const P = Array(33).fill(null);
        (frameData.pose || []).forEach((lm) => {
          if ((lm.visibility || 1) > 0.15) P[lm.id] = { x: lm.x, y: lm.y };
        });

        // ── Draw OpenCV-style 2D skeleton on debug canvas ────────────────────
        const debugCanvas = document.getElementById('debug_canvas');
        if (debugCanvas) {
          // Resize to CSS layout
          if (debugCanvas.width !== debugCanvas.clientWidth) debugCanvas.width = debugCanvas.clientWidth;
          if (debugCanvas.height !== debugCanvas.clientHeight) debugCanvas.height = debugCanvas.clientHeight;
          const ctx = debugCanvas.getContext('2d');
          ctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
          
          const drawLine = (p1, p2) => {
            if (!p1 || !p2) return;
            ctx.beginPath();
            ctx.moveTo(p1.x * debugCanvas.width, p1.y * debugCanvas.height);
            ctx.lineTo(p2.x * debugCanvas.width, p2.y * debugCanvas.height);
            ctx.stroke();
          };
          // Draw skeleton bone lines
          ctx.strokeStyle = '#00ff00';
          ctx.lineWidth = 3;
          drawLine(P[11], P[13]); drawLine(P[13], P[15]); // L Arm
          drawLine(P[12], P[14]); drawLine(P[14], P[16]); // R Arm
          drawLine(P[11], P[12]); // Shoulders
          drawLine(P[23], P[24]); // Hips
          drawLine(P[11], P[23]); drawLine(P[12], P[24]); // Torso sides
          // Neck
          const midShoulder = (P[11] && P[12]) ? { x: (P[11].x + P[12].x) / 2, y: (P[11].y + P[12].y) / 2 } : null;
          if (midShoulder && P[0]) drawLine(midShoulder, P[0]);

          // ── Draw ANIME FACE at head (landmark 0 = nose tip) ──
          if (P[0]) {
            const fx = P[0].x * debugCanvas.width;
            const fy = P[0].y * debugCanvas.height;
            const headR = 28;
            // Face circle
            ctx.save();
            ctx.fillStyle = '#ffd9b0';   // skin tone
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(fx, fy - headR * 0.6, headR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            // Eyes
            ctx.fillStyle = '#222';
            ctx.beginPath(); ctx.arc(fx - 9, fy - headR * 0.7, 4, 0, Math.PI * 2); ctx.fill(); // L eye
            ctx.beginPath(); ctx.arc(fx + 9, fy - headR * 0.7, 4, 0, Math.PI * 2); ctx.fill(); // R eye
            // Eye shine
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.arc(fx - 7, fy - headR * 0.78, 1.5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(fx + 11, fy - headR * 0.78, 1.5, 0, Math.PI * 2); ctx.fill();
            // Blush
            ctx.fillStyle = 'rgba(255,120,120,0.35)';
            ctx.beginPath(); ctx.ellipse(fx - 13, fy - headR * 0.55, 7, 4, 0, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(fx + 13, fy - headR * 0.55, 7, 4, 0, 0, Math.PI * 2); ctx.fill();
            // Smile
            ctx.strokeStyle = '#c05050'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(fx, fy - headR * 0.45, 6, 0.2, Math.PI - 0.2); ctx.stroke();
            ctx.restore();
          }

          // ── Skull icons at major joints ──
          ctx.font = '18px serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          [11, 12, 13, 14, 15, 16, 23, 24].forEach(i => {
            const p = P[i];
            if (p) ctx.fillText('☠', p.x * debugCanvas.width, p.y * debugCanvas.height);
          });

          // ── Proper finger bone lines ──
          const FINGER_COLORS = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff'];
          const FINGER_CONNECTIONS = [
            [0,1],[1,2],[2,3],[3,4],       // Thumb
            [0,5],[5,6],[6,7],[7,8],       // Index
            [0,9],[9,10],[10,11],[11,12],  // Middle
            [0,13],[13,14],[14,15],[15,16],// Ring
            [0,17],[17,18],[18,19],[19,20] // Pinky
          ];
          const FINGER_COLORS_BY_CONN = [
            0,0,0,0, 1,1,1,1, 2,2,2,2, 3,3,3,3, 4,4,4,4
          ];
          const drawFingerLines = (hand, label) => {
            if (!hand || hand.length < 21) return;
            const lms = Array(21).fill(null);
            hand.forEach(p => { if (p && p.id != null) lms[p.id] = p; });
            // draw lines
            FINGER_CONNECTIONS.forEach(([a, b], ci) => {
              const pa = lms[a], pb = lms[b];
              if (!pa || !pb) return;
              ctx.strokeStyle = FINGER_COLORS[FINGER_COLORS_BY_CONN[ci]];
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(pa.x * debugCanvas.width, pa.y * debugCanvas.height);
              ctx.lineTo(pb.x * debugCanvas.width, pb.y * debugCanvas.height);
              ctx.stroke();
            });
            // draw joint dots
            ctx.fillStyle = '#fff';
            lms.forEach(p => {
              if (!p) return;
              ctx.beginPath();
              ctx.arc(p.x * debugCanvas.width, p.y * debugCanvas.height, 3, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            });
          };
          drawFingerLines(frameData.left_hand, 'L');
          drawFingerLines(frameData.right_hand, 'R');
        }

        // ── KALIDOKIT POSE SOLVE ────────────────────────────────────────────
        // Build properly-indexed [0..32] arrays (Kalidokit NEEDS id-order)
        const poseRaw3d = (frameData.pose3d || frameData.pose || []);
        const poseRaw2d = (frameData.pose || []);
        const p3d = Array(33).fill({ x: 0, y: 0, z: 0, visibility: 0 });
        const p2d = Array(33).fill({ x: 0, y: 0, z: 0, visibility: 0 });
        poseRaw3d.forEach(lm => { if (lm.id != null) p3d[lm.id] = { x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility || 1 }; });
        poseRaw2d.forEach(lm => { if (lm.id != null) p2d[lm.id] = { x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility || 1 }; });

        if (poseRaw3d.length >= 20) {
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
          if (!handData || handData.length < 21) return;
          const lms = [...handData].sort((a, b) => a.id - b.id).map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));
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
        const data = await res.json();

        defaultPose(animRef.current);

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
      await new Promise(r => setTimeout(r, anim.type === 'sign' ? 400 : 80)); // shorter pause for letters
    }
    setStatusMsg('✅ Done signing!');
  }, [playJSONFile]);

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

  // ── Hardcoded Sign Kit animated text ──────────────────────────────────────
  const sign = useCallback((inputRef) => {
    const str = (inputRef.current?.value || '').toUpperCase();
    const strWords = str.split(' ');
    setText('');
    animRef.current.animations = [];
    for (const word of strWords) {
      if (words[word]) {
        animRef.current.animations.push(['add-text', word + ' ']);
        words[word](animRef.current);
      } else {
        for (const [i, ch] of word.split('').entries()) {
          animRef.current.animations.push(['add-text', i === word.length - 1 ? ch + ' ' : ch]);
          if (alphabets[ch]) alphabets[ch](animRef.current);
        }
      }
    }
  }, []);

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

        {/* ── Centre (3D Canvas + Progress Bar) ────────────────────────── */}
        <div className='col-md-7 p-0' style={{ position: 'relative', backgroundColor: '#ffffff' }}>
          {vrmError && (
            <div style={{ position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%, -50%)', background: 'red', color: 'white', padding: '20px', borderRadius: '10px', zIndex: 100, maxWidth: '80%' }}>
              <h5>VRM Avatar Load Error</h5>
              <p>{vrmError}</p>
              <p style={{fontSize: '12px'}}>The file `AvatarSample_B.vrm` may be corrupt or blocked by Vite.</p>
            </div>
          )}
          <canvas id="debug_canvas" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 'calc(100vh - 90px)', pointerEvents: 'none', zIndex: 10 }} />
          <Canvas
            style={{ width: '100%', height: 'calc(100vh - 90px)' }}
            camera={{ position: [0, 0.9, 2.8], fov: 45 }}
            gl={{ preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
          >
            <ambientLight intensity={3} />
            <spotLight position={[0, 5, 5]} intensity={500} />
            <Suspense fallback={null}>
              <VRMAvatarScene animRef={animRef} setVrmError={setVrmError} />
            </Suspense>
            <OrbitControls enablePan={true} minDistance={1} maxDistance={5} target={[0, 0.9, 0]} />
          </Canvas>

          {/* Progress Bar (under canvas) */}
          <div className='p-2 bg-light shadow-sm'>
            <div className='d-flex justify-content-between mb-1'>
              <small id='aiProgressText' className='text-secondary fw-bold'>Ready</small>
            </div>
            <div className='progress' style={{ height: '10px', borderRadius: '8px' }}>
              <div
                id='aiProgressBar'
                className='progress-bar progress-bar-striped progress-bar-animated bg-success'
                role='progressbar'
                style={{ width: '0%', transition: 'width 0.1s linear' }}
              />
            </div>
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