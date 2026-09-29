import { PoseLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

const $ = s => document.querySelector(s);
const canvas = $('#stage');
const ctx = canvas.getContext('2d');
const video = $('#cam');

// ============================================================ utils
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeIn = t => t * t * t;
function angleAt(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
  return Math.acos(clamp((v1x * v2x + v1y * v2y) / d, -1, 1)) * 180 / Math.PI;
}

// ============================================================ screen
let W = 0, H = 0, DPR = 1, frost = null;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  W = innerWidth; H = innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  frost = null;
}
addEventListener('resize', resize);
resize();

// Rect where the (mirrored) camera image is drawn, "cover" style
function camRect() {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.max(W / vw, H / vh);
  const w = vw * s, h = vh * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

// ============================================================ audio
const sfx = (() => {
  let ac = null, master = null, noiseBuf = null, hum = null, muted = false;
  function init() {
    if (ac) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = 0.55; master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function env(g, t, gain, attack, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function noise({ dur = 1, type = 'lowpass', f0 = 1000, f1 = f0, q = 1, gain = 0.5, attack = 0.01, delay = 0 }) {
    if (!ac) return;
    const t = ac.currentTime + delay;
    const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ac.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain(); env(g, t, gain, attack, dur);
    src.connect(f).connect(g).connect(master);
    src.start(t); src.stop(t + dur + 0.05);
  }
  function tone({ dur = 0.5, type = 'sine', f0 = 440, f1 = f0, gain = 0.3, attack = 0.01, delay = 0 }) {
    if (!ac) return;
    const t = ac.currentTime + delay;
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain(); env(g, t, gain, attack, dur);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  return {
    init,
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.55;
      if (muted && 'speechSynthesis' in window) speechSynthesis.cancel();
      return muted;
    },
    hum(level) {
      if (!ac) return;
      if (!hum) {
        const o1 = ac.createOscillator(); o1.type = 'sawtooth';
        const o2 = ac.createOscillator(); o2.type = 'square';
        const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
        const g = ac.createGain(); g.gain.value = 0;
        o1.connect(f); o2.connect(f); f.connect(g).connect(master);
        o1.start(); o2.start();
        hum = { o1, o2, f, g };
      }
      const t = ac.currentTime, base = 55 + 190 * level;
      hum.g.gain.setTargetAtTime(level > 0.01 ? 0.04 + 0.14 * level : 0, t, 0.08);
      hum.o1.frequency.setTargetAtTime(base, t, 0.1);
      hum.o2.frequency.setTargetAtTime(base * 1.505, t, 0.1);
      hum.f.frequency.setTargetAtTime(300 + 2600 * level, t, 0.1);
    },
    beam(p) {
      noise({ dur: 1.5 + 1.7 * p, type: 'bandpass', f0: 900, f1: 180, q: 0.8, gain: 0.7, attack: 0.03 });
      tone({ dur: 1.4 + 1.7 * p, type: 'sawtooth', f0: 110, f1: 45, gain: 0.25, attack: 0.02 });
      noise({ dur: 0.5, type: 'highpass', f0: 2000, f1: 5000, gain: 0.35 });
    },
    boom() {
      noise({ dur: 2.2, type: 'lowpass', f0: 1200, f1: 50, gain: 0.95, attack: 0.005 });
      tone({ dur: 1.4, type: 'sine', f0: 110, f1: 28, gain: 0.8, attack: 0.005 });
    },
    thunder() {
      noise({ dur: 0.18, type: 'highpass', f0: 3000, f1: 6000, gain: 0.5, attack: 0.002 });
      noise({ dur: 1.6, type: 'lowpass', f0: 2500, f1: 70, gain: 0.8, attack: 0.01, delay: 0.05 });
    },
    whoosh() {
      noise({ dur: 0.35, type: 'bandpass', f0: 300, f1: 3000, q: 1.5, gain: 0.6 });
      tone({ dur: 0.12, type: 'square', f0: 1400, f1: 700, gain: 0.12, delay: 0.22 });
    },
    freeze() {
      [1760, 2350, 3140, 4200].forEach((f, i) => tone({ dur: 1.4, f0: f, f1: f * 1.02, gain: 0.06, attack: 0.05, delay: i * 0.06 }));
      noise({ dur: 1.2, type: 'highpass', f0: 5000, f1: 9000, gain: 0.25, attack: 0.1 });
    },
    shatter() {
      noise({ dur: 0.7, type: 'highpass', f0: 2500, f1: 1200, gain: 0.7, attack: 0.002 });
      for (let i = 0; i < 8; i++) tone({ dur: 0.18, f0: rand(2000, 5500), gain: 0.07, delay: rand(0, 0.25) });
    },
    powerUp() {
      tone({ dur: 0.7, type: 'sawtooth', f0: 90, f1: 700, gain: 0.25 });
      noise({ dur: 1.4, type: 'bandpass', f0: 400, f1: 2400, gain: 0.5, delay: 0.1 });
    },
  };
})();

// ============================================================ speech
let voices = [];
if ('speechSynthesis' in window) {
  const load = () => { voices = speechSynthesis.getVoices(); };
  load(); speechSynthesis.onvoiceschanged = load;
}
const hasVoice = lang => voices.some(v => v.lang.toLowerCase().startsWith(lang));
function say(text, lang = 'es-ES', rate = 1, pitch = 1, cancel = false) {
  if (!('speechSynthesis' in window) || sfx.muted) return;
  if (cancel) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = voices.find(v => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  if (v) u.voice = v;
  u.lang = lang; u.rate = rate; u.pitch = pitch; u.volume = 1;
  speechSynthesis.speak(u);
}

// ============================================================ moves / HUD
const MOVES = [
  { id: 'kame', icon: '🌊', name: 'Kamehameha', who: 'Goku · Dragon Ball', color: '#4cc3ff', pts: 300, shout: 'KAMEHAMEHA!',
    how: 'Junta las manos a un lado de la cadera y aguanta para cargar. Luego súbelas juntas delante del pecho: ¡fuego!' },
  { id: 'genki', icon: '🌕', name: 'Genkidama', who: 'Goku · Dragon Ball', color: '#9fdcff', pts: 400, shout: 'GENKIDAMA!',
    how: 'Levanta las dos manos por encima de la cabeza y aguanta para reunir energía. Bájalas para lanzarla.' },
  { id: 'ssj', icon: '⚡', name: 'Super Saiyan', who: 'Goku · Dragon Ball', color: '#ffcf33', pts: 250, shout: 'SUPER SAIYAN!',
    how: 'Puños a la altura de la cintura con los codos doblados hacia fuera, en tensión, ~1 segundo.' },
  { id: 'spear', icon: '🪝', name: 'Get over here!', who: 'Scorpion · Mortal Kombat', color: '#ff9a1a', pts: 200, shout: 'GET OVER HERE!',
    how: 'Con la mano cerca del pecho, extiende un brazo recto hacia el lado de golpe.' },
  { id: 'freeze', icon: '❄️', name: 'Congelación', who: 'Sub-Zero · Mortal Kombat', color: '#8fe3ff', pts: 200, shout: 'FREEZE!',
    how: 'Cruza los brazos en X delante del pecho y aguanta un instante.' },
  { id: 'raiden', icon: '🌩️', name: 'Rayo de Raiden', who: 'Raiden · Mortal Kombat', color: '#b9c8ff', pts: 200, shout: 'RAIDEN!',
    how: 'Levanta un solo brazo por encima de la cabeza (el otro abajo) y aguanta.' },
];
const MOVE = Object.fromEntries(MOVES.map(m => [m.id, m]));
const counts = Object.fromEntries(MOVES.map(m => [m.id, 0]));
const moveEls = {};

function buildPanel() {
  const ul = $('#moves');
  for (const m of MOVES) {
    const li = document.createElement('li');
    li.className = 'move';
    li.style.setProperty('--c', m.color);
    li.innerHTML = `<div class="ico">${m.icon}</div><div class="name">${m.name}</div><div class="count">×0</div>
      <div class="who">${m.who}</div><div class="how">${m.how}</div><div class="bar"><i></i></div>`;
    ul.appendChild(li);
    moveEls[m.id] = { li, bar: li.querySelector('.bar i'), count: li.querySelector('.count') };
  }
  $('#panelHead').onclick = () => $('#panel').classList.toggle('collapsed');
  if (innerWidth < 760) $('#panel').classList.add('collapsed');
}
const progress = {};
function setProgress(id, v) {
  v = clamp(v, 0, 1);
  if (progress[id] !== undefined && Math.abs(progress[id] - v) < 0.01) return;
  progress[id] = v;
  moveEls[id].bar.style.width = (v * 100).toFixed(1) + '%';
}

const game = { players: 1, skeleton: false, running: false, shake: 0 };
function performed(pl, id) {
  const m = MOVE[id];
  const now = performance.now() / 1000;
  pl.combo = now - pl.lastMoveT < 4 ? pl.combo + 1 : 1;
  pl.lastMoveT = now;
  pl.score += m.pts * pl.combo;
  counts[id]++;
  pl.scoreEl.textContent = pl.score.toLocaleString('es-ES');
  const el = moveEls[id];
  el.count.textContent = '×' + counts[id];
  el.li.classList.add('done', 'hit');
  setTimeout(() => el.li.classList.remove('hit'), 700);
  const who = game.players > 1 ? pl.name + ' · ' : '';
  banner(m.shout, m.color, who + (pl.combo > 1 ? `COMBO ×${pl.combo}  +${m.pts * pl.combo}` : `${m.who.split(' · ')[0]}  +${m.pts}`));
}
function banner(text, color, sub) {
  const b = $('#banner');
  b.style.setProperty('--c', color);
  b.querySelector('.big').textContent = text;
  b.querySelector('.sub').textContent = sub || '';
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
}
function setStatus(text, cls = '') {
  const s = $('#status');
  if (s.textContent !== text) s.textContent = text;
  s.className = 'status ' + cls;
}

// ============================================================ players
// Each detected person gets a slot with its own pose, gesture state, SSJ hair, aura mask and score.
const PLAYER_COLORS = ['#ffcf33', '#4cc3ff'];
const canvas2d = () => { const c = document.createElement('canvas'); return [c, c.getContext('2d')]; };
function newGestures() {
  return {
    kame: { state: 'idle', charge: 0, pos: { x: 0, y: 0 }, side: 1, lost: 0, cd: 0, voiced: false },
    genki: { level: 0, pos: { x: 0, y: 0 }, lost: 0, started: false },
    ssj: { hold: 0, until: 0, start: 0 },
    spear: { bentT: [-9, -9], cd: 0 },
    freeze: { hold: 0, cd: 0 },
    raiden: { hold: 0, cd: 0 },
  };
}
function newPlayer(i) {
  const [maskCanvas, maskCtx] = canvas2d(), [midCanvas, midCtx] = canvas2d(), [smallCanvas, smallCtx] = canvas2d();
  return {
    i, name: 'J' + (i + 1), color: PLAYER_COLORS[i],
    smooth: null, lastSeen: -1e9, cx: 0.5, P: null, body: null, G: newGestures(),
    score: 0, combo: 0, lastMoveT: -99, scoreEl: null,
    wantMask: false, mask: { canvas: maskCanvas, ctx: maskCtx, img: null, mid: midCanvas, midCtx, small: smallCanvas, smallCtx, ready: false, time: 0 },
    hair: {
      u: 0, ang: 0, c: null, vel: { x: 0, y: 0 }, lastT: 0,
      locks: [...HAIR_FRONT, ...HAIR_BACK, ...HAIR_BANGS].map(() => ({ a: 0, v: 0, ph: rand(0, 6.28), f: rand(7, 12) })),
    },
  };
}
let players = [];

// ============================================================ pose detection
let landmarker = null, lastVideoTime = -1;
const [personCanvas, personCtx] = canvas2d();

async function initPose() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = delegate => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO', numPoses: game.players, outputSegmentationMasks: true,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch (e) { console.warn('GPU no disponible, usando CPU', e); landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
}

function detect(now) {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  try { landmarker.detectForVideo(video, now, onResult); } catch (e) { console.warn(e); }
}

// Pairs each detection with a player slot. With two people on screen, J1 is always the one on the
// left; with only one, it keeps the slot whose last position is closest so charges don't jump.
function assignPlayers(dets, t) {
  if (players.length === 1) return [[players[0], dets[0]]];
  if (dets.length >= 2) {
    dets.sort((a, b) => a.cx - b.cx);
    return [[players[0], dets[0]], [players[1], dets[1]]];
  }
  const d = dets[0];
  const recent = players.filter(p => t - p.lastSeen < 1000);
  const pl = recent.length
    ? recent.reduce((a, b) => Math.abs(a.cx - d.cx) <= Math.abs(b.cx - d.cx) ? a : b)
    : players[d.cx < 0.5 ? 0 : 1];
  return [[pl, d]];
}

function onResult(res) {
  const all = res.landmarks || [];
  if (!all.length) return;
  const t = performance.now();
  // horizontal center of the shoulders, in mirrored screen space (0 = left)
  const dets = all.map((lm, k) => ({ lm, k, cx: 1 - (lm[11].x + lm[12].x) / 2 }));
  for (const [pl, { lm, k, cx }] of assignPlayers(dets, t)) {
    if (!pl.smooth || t - pl.lastSeen > 400) {
      pl.smooth = lm.map(p => ({ x: p.x, y: p.y, v: p.visibility ?? 1 }));
    } else {
      for (let i = 0; i < lm.length; i++) {
        const s = pl.smooth[i], p = lm[i];
        s.x = lerp(s.x, p.x, 0.6); s.y = lerp(s.y, p.y, 0.6); s.v = lerp(s.v, p.visibility ?? 1, 0.5);
      }
    }
    pl.lastSeen = t; pl.cx = cx;
    const m = res.segmentationMasks && res.segmentationMasks[k];
    if (pl.wantMask && m) updateMask(pl.mask, m.getAsFloat32Array(), m.width, m.height);
  }
}

function updateMask(M, data, w, h) {
  if (M.canvas.width !== w || M.canvas.height !== h) {
    M.canvas.width = w; M.canvas.height = h;
    M.img = M.ctx.createImageData(w, h);
    M.mid.width = Math.max(1, w >> 2); M.mid.height = Math.max(1, h >> 2);
    M.small.width = Math.max(1, w >> 4); M.small.height = Math.max(1, h >> 4);
  }
  const d = M.img.data;
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    d[j] = 255; d[j + 1] = 205; d[j + 2] = 50; d[j + 3] = data[i] * 255;
  }
  M.ctx.putImageData(M.img, 0, 0);
  M.ready = true; M.time = performance.now();
}

function getPose(pl, r) {
  if (!pl.smooth || performance.now() - pl.lastSeen > 500) return null;
  return pl.smooth.map(p => ({ x: r.x + (1 - p.x) * r.w, y: r.y + p.y * r.h, v: p.v }));
}

// ============================================================ particles & effects
const parts = [];
function spawn(o) {
  if (parts.length > 1800) return;
  const p = { x: 0, y: 0, vx: 0, vy: 0, life: 1, size: 3, color: '255,255,255', drag: 0, grav: 0, ...o };
  p.max = p.life;
  parts.push(p);
}
function updateParts(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.target) {
      const t = p.target();
      const dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy) || 1;
      if (d < (p.killR || 10)) p.life = 0;
      p.vx = lerp(p.vx, dx / d * p.speed, 0.15); p.vy = lerp(p.vy, dy / d * p.speed, 0.15);
    }
    if (p.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
    p.vx *= 1 - p.drag * dt; p.vy = p.vy * (1 - p.drag * dt) + p.grav * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.vr) p.rot += p.vr * dt;
  }
}
function drawParts() {
  ctx.save();
  for (const p of parts) {
    const a = clamp(p.life / p.max, 0, 1);
    if (p.shape === 'shard') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = `rgba(${p.color},${a * 0.85})`; ctx.strokeStyle = `rgba(255,255,255,${a})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, -p.size); ctx.lineTo(p.size * 0.6, p.size * 0.7); ctx.lineTo(-p.size * 0.5, p.size * 0.4); ctx.closePath();
      ctx.fill(); ctx.stroke(); ctx.restore();
    } else {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(${p.color},${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * a), 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

const effects = [];
const flashes = [];
function flash(color, alpha, dur) { flashes.push({ color, alpha, dur, t: 0 }); }
function addShake(v) { game.shake = Math.max(game.shake, v); }

function glowCircle(x, y, r, stops) {
  if (r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

// Lightning path via midpoint displacement
function bolt(x1, y1, x2, y2, disp, minLen = 10) {
  let pts = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
  let d = disp;
  for (let iter = 0; iter < 8; iter++) {
    const np = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = dist(a, b) || 1;
      const off = (Math.random() - 0.5) * d;
      np.push({ x: (a.x + b.x) / 2 - (b.y - a.y) / len * off, y: (a.y + b.y) / 2 + (b.x - a.x) / len * off }, b);
    }
    pts = np; d /= 2;
    if (dist(pts[0], pts[1]) < minLen) break;
  }
  return pts;
}
function strokePts(pts) {
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}
function drawBolt(pts, s = 1, color = '120,160,255') {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgba(${color},0.22)`; ctx.lineWidth = 16 * s; strokePts(pts);
  ctx.strokeStyle = `rgba(${color},0.6)`; ctx.lineWidth = 6 * s; strokePts(pts);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 2 * s; strokePts(pts);
}

function drawEnergyBall(x, y, r, t) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const fl = 1 + 0.08 * Math.sin(t * 40) + 0.06 * Math.random();
  glowCircle(x, y, r * 2.6 * fl, [[0, 'rgba(90,180,255,0.55)'], [0.4, 'rgba(40,110,255,0.22)'], [1, 'rgba(0,40,255,0)']]);
  glowCircle(x, y, r * fl, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(210,245,255,0.95)'], [0.7, 'rgba(90,180,255,0.6)'], [1, 'rgba(40,100,255,0)']]);
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * Math.PI * 2, L = r * rand(1.2, 2.2);
    drawBolt(bolt(x, y, x + Math.cos(a) * L, y + Math.sin(a) * L, r * 0.5, 6), 0.35, '140,200,255');
  }
  ctx.restore();
}

function drawGenki(x, y, r, t) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  glowCircle(x, y, r * 1.8, [[0, 'rgba(170,215,255,0.45)'], [0.55, 'rgba(90,150,255,0.18)'], [1, 'rgba(40,80,255,0)']]);
  glowCircle(x, y, r, [[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(215,240,255,0.95)'], [0.85, 'rgba(120,190,255,0.8)'], [1, 'rgba(60,120,255,0.1)']]);
  ctx.strokeStyle = `rgba(230,245,255,${0.4 + 0.3 * Math.sin(t * 12)})`; ctx.lineWidth = Math.max(2, r * 0.03);
  ctx.beginPath(); ctx.arc(x, y, r * (0.98 + 0.02 * Math.sin(t * 30)), 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// ---------- Kamehameha beam
class Beam {
  constructor(pl, power, dir, origin) {
    this.pl = pl; this.t = 0; this.p = power; this.dir = dir; this.dur = 1.4 + 1.8 * power;
    this.o = { ...origin };
  }
  width() {
    const base = Math.min(W, H) * (0.08 + 0.14 * this.p);
    const grow = easeOut(clamp(this.t / 0.18, 0, 1));
    const fade = clamp((this.dur - this.t) / 0.45, 0, 1);
    return base * grow * fade * (1 + 0.06 * Math.sin(this.t * 50));
  }
  update(dt) {
    this.t += dt;
    const body = this.pl.body;
    if (body) { this.o.x = lerp(this.o.x, body.hm.x, 0.25); this.o.y = lerp(this.o.y, body.hm.y, 0.25); }
    addShake(5 + 10 * this.p);
    const w = this.width();
    for (let i = 0; i < 5; i++) {
      spawn({ x: this.o.x + this.dir * rand(0, W), y: this.o.y + rand(-w, w) * 0.6, vx: this.dir * rand(300, 900), vy: rand(-120, 120),
        life: rand(0.25, 0.6), size: rand(2, 5), color: '170,225,255' });
    }
    return this.t < this.dur;
  }
  draw() {
    const w = this.width(); if (w < 1) return;
    const len = W * 1.6 * easeOut(clamp(this.t / 0.3, 0, 1));
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.translate(this.o.x, this.o.y); ctx.scale(this.dir, 1);
    const layers = [[2.7, '30,90,255', 0.16], [1.9, '60,150,255', 0.32], [1.25, '120,200,255', 0.55], [0.8, '200,240,255', 0.85], [0.4, '255,255,255', 1]];
    for (const [m, c, a] of layers) {
      const hw = w * m / 2;
      ctx.fillStyle = `rgba(${c},${a})`;
      ctx.beginPath(); ctx.moveTo(0, -hw * 0.6);
      for (let x = 0; x <= len; x += 24) ctx.lineTo(x, -hw * (1 + 0.08 * Math.sin(x * 0.03 - this.t * 35 + m * 3)));
      for (let x = Math.floor(len / 24) * 24; x >= 0; x -= 24) ctx.lineTo(x, hw * (1 + 0.08 * Math.sin(x * 0.027 - this.t * 31 + m * 5)));
      ctx.lineTo(0, hw * 0.6);
      ctx.closePath(); ctx.fill();
    }
    ctx.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      const x = (this.t * 1500 + i * len / 6) % Math.max(1, len);
      ctx.strokeStyle = 'rgba(210,245,255,0.35)';
      ctx.beginPath(); ctx.ellipse(x, 0, w * 0.12, w * 0.8, 0, 0, Math.PI * 2); ctx.stroke();
    }
    glowCircle(0, 0, w * 1.6, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(200,240,255,0.9)'], [0.6, 'rgba(70,150,255,0.45)'], [1, 'rgba(20,60,255,0)']]);
    ctx.restore();
  }
}

// ---------- Genkidama throw
class GenkiThrow {
  constructor(pos, r, lvl) { this.t = 0; this.p0 = { ...pos }; this.r0 = r; this.l = lvl; this.dur = 0.9; this.boom = false; }
  update(dt) {
    this.t += dt;
    addShake(4 + 12 * this.l * (this.t / this.dur));
    if (this.t >= this.dur && !this.boom) {
      this.boom = true;
      flash('255,255,255', 0.95, 1.1); addShake(45); sfx.boom();
      for (let i = 0; i < 160; i++) {
        const a = rand(0, Math.PI * 2), s = rand(300, 1400);
        spawn({ x: W / 2, y: H / 2, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.5, 1.4), size: rand(3, 9), color: '190,225,255', drag: 1.5 });
      }
    }
    return !this.boom;
  }
  draw() {
    const k = easeIn(clamp(this.t / this.dur, 0, 1));
    drawGenki(lerp(this.p0.x, W / 2, k), lerp(this.p0.y, H / 2, k), lerp(this.r0, Math.hypot(W, H) * 0.75, k), this.t);
  }
}

// ---------- Scorpion spear
class Spear {
  constructor(pl, arm, dir) {
    const body = pl.body;
    this.pl = pl; this.arm = arm; this.dir = dir; this.t = 0; this.tOut = 0.18; this.tHold = 0.5; this.tBack = 0.3;
    this.last = body ? { ...(arm ? body.rw : body.lw) } : { x: W / 2, y: H * 0.45 };
  }
  hand() { const body = this.pl.body; if (body) { const w = this.arm ? body.rw : body.lw; if (w.v > 0.3) this.last = { x: w.x, y: w.y }; } return this.last; }
  frac() {
    const t = this.t;
    if (t < this.tOut) return easeOut(t / this.tOut);
    if (t < this.tOut + this.tHold) return 1;
    return 1 - easeOut(clamp((t - this.tOut - this.tHold) / this.tBack, 0, 1));
  }
  update(dt) {
    const prev = this.t; this.t += dt;
    const h = this.hand();
    if (prev < this.tOut && this.t >= this.tOut) {
      const x = this.dir > 0 ? W - 30 : 30;
      addShake(14); flash('255,120,20', 0.25, 0.2);
      for (let i = 0; i < 30; i++) spawn({ x, y: h.y, vx: -this.dir * rand(100, 700), vy: rand(-400, 400), life: rand(0.2, 0.5), size: rand(2, 4), color: '255,200,120', drag: 3 });
    }
    for (let i = 0; i < 3; i++) spawn({ x: h.x + rand(-15, 15), y: h.y + rand(-10, 10), vx: rand(-40, 40), vy: rand(-260, -120), life: rand(0.3, 0.6), size: rand(3, 7), color: `255,${(rand(80, 180)) | 0},20` });
    return this.t < this.tOut + this.tHold + this.tBack;
  }
  draw() {
    const h = this.hand();
    const edge = this.dir > 0 ? W - 30 - h.x : h.x - 30;
    const L = Math.max(60, edge) * this.frac();
    const s = Math.min(W, H) * 0.035;
    ctx.save();
    ctx.translate(h.x, h.y); ctx.scale(this.dir, 1);
    // rope/chain
    ctx.lineWidth = 3;
    const n = Math.floor(L / 13);
    for (let i = 0; i < n; i++) {
      const x = i * 13 + 6, y = Math.sin(i * 0.7 + this.t * 25) * 3 * (1 - this.frac() * 0.6);
      ctx.strokeStyle = i % 2 ? '#e6c56a' : '#a8843a';
      ctx.beginPath(); ctx.ellipse(x, y, 8, i % 2 ? 4 : 1.5, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // kunai
    ctx.translate(L, 0);
    ctx.shadowColor = 'rgba(255,140,0,0.9)'; ctx.shadowBlur = 20;
    const g = ctx.createLinearGradient(0, -s, 0, s); g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#b8c0cc'); g.addColorStop(1, '#5d6570');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(s * 2.4, 0); ctx.lineTo(0, -s * 0.75); ctx.lineTo(s * 0.35, 0); ctx.lineTo(0, s * 0.75); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#5a2d12'; ctx.fillRect(-s * 0.9, -s * 0.17, s * 0.95, s * 0.34);
    ctx.strokeStyle = '#d9b45a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(-s * 1.15, 0, s * 0.28, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

// ---------- Sub-Zero freeze
function buildFrost() {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) / 2);
  vg.addColorStop(0, 'rgba(200,235,255,0)'); vg.addColorStop(1, 'rgba(225,245,255,0.8)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  g.lineCap = 'round';
  const k = Math.min(W, H) / 800 + 0.4;
  function branch(x, y, a, len, depth) {
    if (depth <= 0 || len < 3) return;
    const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
    g.strokeStyle = `rgba(235,250,255,${0.2 + depth * 0.1})`; g.lineWidth = depth * 0.6;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
    const n = Math.random() < 0.4 ? 3 : 2;
    for (let i = 0; i < n; i++) branch(x2, y2, a + rand(-0.9, 0.9), len * rand(0.55, 0.75), depth - 1);
  }
  const seeds = Math.round((W + H) / 22);
  for (let i = 0; i < seeds; i++) {
    const side = i % 4; let x, y, a;
    if (side === 0) { x = rand(0, W); y = 0; a = Math.PI / 2; }
    else if (side === 1) { x = W; y = rand(0, H); a = Math.PI; }
    else if (side === 2) { x = rand(0, W); y = H; a = -Math.PI / 2; }
    else { x = 0; y = rand(0, H); a = 0; }
    branch(x, y, a + rand(-0.6, 0.6), rand(40, 110) * k, 5);
  }
  frost = c;
}
class Freeze {
  constructor() { this.t = 0; this.dur = 4.2; if (!frost) buildFrost(); }
  alpha() { return clamp(this.t / 0.5, 0, 1) * clamp((this.dur - this.t) / 0.25, 0, 1); }
  update(dt) {
    this.t += dt;
    for (let i = 0; i < 3; i++) spawn({ x: rand(0, W), y: -10, vx: rand(-40, 40), vy: rand(60, 180), life: rand(2, 4), size: rand(1.5, 3.5), color: '230,245,255' });
    if (this.t >= this.dur) {
      sfx.shatter(); flash('220,245,255', 0.7, 0.4); addShake(18);
      for (let i = 0; i < 120; i++) {
        const x = rand(0, W), y = rand(0, H), a = Math.atan2(y - H / 2, x - W / 2);
        spawn({ shape: 'shard', x, y, vx: Math.cos(a) * rand(100, 500), vy: Math.sin(a) * rand(100, 500) - 200, grav: 1100,
          life: rand(0.8, 1.5), size: rand(8, 26), color: '200,235,255', rot: rand(0, 6), vr: rand(-8, 8) });
      }
      return false;
    }
    return true;
  }
  drawOverlay() {
    const a = this.alpha(); if (a <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `rgba(130,195,255,${0.55 * a})`; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = `rgba(120,190,255,${0.2 * a})`; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = a; ctx.drawImage(frost, 0, 0, W, H);
    ctx.restore();
  }
}

// ---------- Raiden lightning
class Raiden {
  constructor(pl, arm) { this.pl = pl; this.arm = arm; this.t = 0; this.dur = 2.6; this.next = 0; this.bolts = []; this.thunders = 0; this.last = { x: W / 2, y: H * 0.3 }; }
  hand() { const body = this.pl.body; if (body) { const w = this.arm ? body.rw : body.lw; if (w.v > 0.3) this.last = { x: w.x, y: w.y }; } return this.last; }
  update(dt) {
    this.t += dt;
    const h = this.hand();
    if (this.t >= this.next) {
      this.next = this.t + rand(0.06, 0.14);
      this.bolts = [];
      const n = 1 + (Math.random() * 2 | 0);
      for (let i = 0; i < n; i++) {
        const main = bolt(h.x + rand(-W * 0.25, W * 0.25), -20, h.x, h.y, Math.max(80, h.y * 0.35));
        this.bolts.push(main);
        if (Math.random() < 0.8) {
          const k = main[Math.floor(main.length * rand(0.2, 0.6))];
          this.bolts.push(bolt(k.x, k.y, k.x + rand(-220, 220), k.y + rand(60, 240), 60));
        }
      }
      if (Math.random() < 0.5) flash('200,215,255', 0.35, 0.12);
      addShake(10);
      if (this.thunders < 4 && (this.thunders === 0 || Math.random() < 0.2)) { this.thunders++; sfx.thunder(); }
      for (let i = 0; i < 12; i++) spawn({ x: h.x, y: h.y, vx: rand(-450, 450), vy: rand(-450, 450), life: rand(0.2, 0.5), size: rand(1.5, 3), color: '190,215,255', drag: 3 });
    }
    return this.t < this.dur;
  }
  draw() {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const b of this.bolts) drawBolt(b, 1.2);
    const h = this.hand();
    glowCircle(h.x, h.y, Math.min(W, H) * 0.1, [[0, 'rgba(255,255,255,0.9)'], [0.4, 'rgba(140,180,255,0.5)'], [1, 'rgba(60,90,255,0)']]);
    const body = this.pl.body;
    if (body) {
      const P = body.P, ids = [11, 12, 13, 14, 15, 16, 23, 24];
      for (let i = 0; i < 2; i++) {
        const a = P[ids[Math.random() * ids.length | 0]], b = P[ids[Math.random() * ids.length | 0]];
        if (a !== b && a.v > 0.5 && b.v > 0.5) drawBolt(bolt(a.x, a.y, b.x, b.y, 40), 0.45);
      }
    }
    ctx.restore();
  }
}

// ============================================================ gestures
const genkiR = l => Math.min(W, H) * (0.04 + 0.2 * l);

function fireKame(pl) {
  const k = pl.G.kame;
  effects.push(new Beam(pl, k.charge, -k.side, pl.body ? pl.body.hm : k.pos));
  flash('180,230,255', 0.5, 0.35); addShake(25);
  sfx.beam(k.charge);
  say(hasVoice('ja') ? '波ーーーっ!' : '¡HAAAAAAA!', hasVoice('ja') ? 'ja-JP' : 'es-ES', 0.9, 0.7, true);
  performed(pl, 'kame');
  k.state = 'cooldown'; k.cd = 1; k.charge = 0;
}
function throwGenki(pl) {
  const g = pl.G.genki;
  effects.push(new GenkiThrow(g.pos, genkiR(g.level), g.level));
  say('¡Genkidama!', 'es-ES', 1.05, 0.8, true);
  performed(pl, 'genki');
  g.level = 0; g.started = false; g.lost = 0;
}
function activateSSJ(pl) {
  const s = pl.G.ssj;
  s.start = performance.now() / 1000; s.until = s.start + 12; s.hold = 0;
  flash('255,220,80', 0.8, 0.6); addShake(35); sfx.boom(); sfx.powerUp();
  say('¡Aaaaaaaaah!', 'es-ES', 0.8, 0.6, true);
  performed(pl, 'ssj');
}
function fireSpear(pl, arm, dir) {
  effects.push(new Spear(pl, arm, dir));
  sfx.whoosh();
  say('Get over here!', 'en-US', 1.05, 0.5, true);
  performed(pl, 'spear');
}
function triggerFreeze(pl) {
  effects.push(new Freeze());
  flash('220,245,255', 0.6, 0.35); sfx.freeze(); addShake(10);
  performed(pl, 'freeze');
}
function triggerRaiden(pl, arm) {
  effects.push(new Raiden(pl, arm));
  performed(pl, 'raiden');
}

function updateGestures(pl, dt, now) {
  const P = pl.P, G = pl.G;
  const k = G.kame, g = G.genki, s = G.ssj, sp = G.spear, f = G.freeze, rd = G.raiden;
  sp.cd -= dt; f.cd -= dt; rd.cd -= dt; k.cd -= dt;
  const ssjActive = now < s.until;

  let body = null;
  if (P) {
    const [ls, rs] = [P[11], P[12]];
    const sw = dist(ls, rs);
    if (ls.v > 0.5 && rs.v > 0.5 && sw > 25) {
      const sm = mid(ls, rs);
      const lh = P[23], rh = P[24];
      const torso = lh.v > 0.5 && rh.v > 0.5 ? Math.max(sw * 0.8, mid(lh, rh).y - sm.y) : sw * 1.5;
      const lw = P[15], rw = P[16], le = P[13], re = P[14];
      body = { P, sw, sm, torso, hipY: sm.y + torso, lw, rw, le, re, ls, rs, nose: P[0], hm: mid(lw, rw), hd: dist(lw, rw),
        angL: angleAt(ls, le, lw), angR: angleAt(rs, re, rw), wOK: lw.v > 0.3 && rw.v > 0.3 };
    }
  }
  pl.body = body;

  if (!body) {
    if (k.state === 'charging') k.state = 'idle';
    k.charge = Math.max(0, k.charge - dt * 2);
    g.level = Math.max(0, g.level - dt); if (g.level === 0) g.started = false;
    s.hold = 0; f.hold = 0; rd.hold = 0;
  } else {
    const { sw, sm, torso, hipY, lw, rw, ls, rs, nose, hm, hd, angL, angR, wOK } = body;

    // --- Kamehameha: hands together at one hip -> charge; bring them up to the chest -> fire
    const chargePose = wOK && hd < 0.75 * sw && hm.y > sm.y + 0.5 * torso && Math.abs(hm.x - sm.x) > 0.3 * sw;
    const firePose = wOK && hd < 1.0 * sw && hm.y < sm.y + 0.45 * torso && hm.y > sm.y - 0.6 * sw;
    if (k.state === 'idle') {
      k.charge = Math.max(0, k.charge - dt * 2);
      if (chargePose) { k.state = 'charging'; k.side = Math.sign(hm.x - sm.x) || 1; k.charge = 0; k.lost = 0; k.voiced = false; }
    } else if (k.state === 'charging') {
      k.pos = hm;
      if (chargePose) {
        k.charge = Math.min(1, k.charge + dt / 1.6); k.lost = 0;
        if (!k.voiced && k.charge > 0.12) {
          k.voiced = true;
          if (hasVoice('ja')) say('かめ… はめ…', 'ja-JP', 0.6, 0.8, true); else say('Ka... me... ha... me...', 'es-ES', 0.6, 0.8, true);
        }
      } else if (firePose && k.charge > 0.3) {
        fireKame(pl);
      } else {
        k.lost += dt;
        if (k.lost > 0.8 || hd > 1.6 * sw) k.state = 'idle';
      }
      if (k.state === 'charging') {
        const r = Math.min(W, H) * 0.25;
        for (let i = 0; i < 2 + k.charge * 4; i++) {
          const a = rand(0, Math.PI * 2), d = rand(0.5, 1) * r;
          spawn({ x: k.pos.x + Math.cos(a) * d, y: k.pos.y + Math.sin(a) * d, life: 0.8, size: rand(1.5, 3.5), color: '150,215,255',
            target: () => k.pos, speed: rand(300, 600), killR: 12 });
        }
      }
    } else if (k.state === 'cooldown' && k.cd <= 0 && !chargePose) {
      k.state = 'idle';
    }

    // --- Genkidama: both hands above the head -> gather; lower them -> throw
    const upPose = wOK && lw.y < nose.y - 0.1 * sw && rw.y < nose.y - 0.1 * sw;
    if (upPose) {
      g.level = Math.min(1, g.level + dt / 3); g.lost = 0; g.started = true;
      const R = genkiR(g.level);
      g.pos = { x: hm.x, y: Math.min(lw.y, rw.y) - R * 0.9 };
      for (let i = 0; i < 2 + g.level * 5; i++) {
        const e = Math.random() * 4 | 0;
        const x = e === 0 ? 0 : e === 1 ? W : rand(0, W), y = e === 2 ? H : e === 3 ? 0 : rand(0, H);
        spawn({ x, y, life: 2, size: rand(1.5, 3.5), color: '200,230,255', target: () => g.pos, speed: rand(500, 1000), killR: R * 0.7 });
      }
    } else if (g.started) {
      g.lost += dt;
      if (g.level > 0.3 && hm.y > sm.y + 0.1 * sw) throwGenki(pl);
      else if (g.lost > 1.2) { g.level = Math.max(0, g.level - dt * 1.5); if (g.level === 0) g.started = false; }
    }

    // --- Super Saiyan: fists at the waist, elbows bent outwards, tension
    const ssjPose = wOK && angL < 145 && angR < 145 && hd > 1.0 * sw &&
      lw.y > sm.y + 0.35 * torso && rw.y > sm.y + 0.35 * torso && lw.y < hipY + 0.5 * torso && rw.y < hipY + 0.5 * torso &&
      k.state !== 'charging';
    if (!ssjActive) {
      if (ssjPose) {
        s.hold += dt; addShake(2 + 8 * s.hold);
        for (let i = 0; i < 4; i++) spawn({ x: sm.x + rand(-1.2, 1.2) * sw, y: sm.y + rand(-0.2, 1.2) * torso, vx: rand(-20, 20), vy: -rand(150, 450),
          life: rand(0.4, 0.8), size: rand(2, 4), color: '255,215,90' });
        if (s.hold > 1.2) activateSSJ(pl);
      } else s.hold = Math.max(0, s.hold - dt * 1.5);
    }

    // --- Scorpion spear: from bent to straight arm sideways, fast
    [[ls, lw, angL, 0], [rs, rw, angR, 1]].forEach(([sh, w, ang, i]) => {
      if (w.v < 0.4) return;
      const out = Math.sign(sh.x - sm.x) || (i ? 1 : -1);
      const dx = (w.x - sh.x) * out;
      if (dx < 0.55 * sw) sp.bentT[i] = now;
      const ext = dx > 1.1 * sw && Math.abs(w.y - sh.y) < 0.5 * sw && ang > 145;
      if (ext && now - sp.bentT[i] < 0.5 && sp.cd <= 0) { fireSpear(pl, i, out); sp.cd = 1.5; }
    });

    // --- Sub-Zero: arms crossed in X in front of the chest
    const crossed = wOK && lw.x - rw.x > 0.1 * sw &&
      lw.y > sm.y - 0.4 * sw && rw.y > sm.y - 0.4 * sw && lw.y < sm.y + 0.8 * torso && rw.y < sm.y + 0.8 * torso;
    if (crossed && f.cd <= 0) { f.hold += dt; if (f.hold > 0.6) { triggerFreeze(pl); f.cd = 6; f.hold = 0; } }
    else f.hold = Math.max(0, f.hold - dt * 2);

    // --- Raiden: one arm up above the head, the other one down
    const isUp = w => w.v > 0.4 && w.y < nose.y - 0.35 * sw;
    const isDown = w => w.v < 0.4 || w.y > sm.y;
    let arm = -1;
    if (isUp(lw) && isDown(rw)) arm = 0; else if (isUp(rw) && isDown(lw)) arm = 1;
    if (arm >= 0 && rd.cd <= 0) { rd.hold += dt; if (rd.hold > 0.6) { triggerRaiden(pl, arm); rd.cd = 4; rd.hold = 0; } }
    else rd.hold = Math.max(0, rd.hold - dt * 2);
  }

  // SSJ ambience while active
  if (ssjActive && body) {
    const { sm, sw, torso } = body;
    for (let i = 0; i < 3; i++) spawn({ x: sm.x + rand(-1.3, 1.3) * sw, y: sm.y + rand(-0.6, 1.3) * torso, vx: rand(-20, 20), vy: -rand(200, 500),
      life: rand(0.4, 0.9), size: rand(2, 4.5), color: '255,215,90' });
  }
  pl.wantMask = ssjActive || s.hold > 0.2;

  // HUD progress + charging hum (the caller merges both players)
  return {
    progress: {
      kame: k.state === 'charging' ? k.charge : 0,
      genki: g.level,
      ssj: ssjActive ? (s.until - now) / 12 : s.hold / 1.2,
      spear: sp.cd > 0 ? 1 - sp.cd / 1.5 : 0,
      freeze: f.cd > 0 ? 1 - f.cd / 6 : f.hold / 0.6,
      raiden: rd.cd > 0 ? 1 - rd.cd / 4 : rd.hold / 0.6,
    },
    hum: Math.max(k.state === 'charging' ? k.charge : 0, g.started ? g.level : 0, ssjActive ? 0 : s.hold / 1.2),
  };
}

function updatePlayers(dt, now, r) {
  const prog = Object.fromEntries(MOVES.map(m => [m.id, 0]));
  let hum = 0;
  for (const pl of players) {
    pl.P = getPose(pl, r);
    const o = updateGestures(pl, dt, now);
    for (const id in prog) prog[id] = Math.max(prog[id], o.progress[id]);
    hum = Math.max(hum, o.hum);
  }
  for (const id in prog) setProgress(id, prog[id]);
  sfx.hum(hum);
}

// ============================================================ rendering
function drawMirrored(src, r) {
  ctx.save(); ctx.translate(r.x + r.w, r.y); ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0, r.w, r.h);
  ctx.restore();
}

function drawAura(pl, r, I, t) {
  const body = pl.body, M = pl.mask;
  const fresh = M.ready && performance.now() - M.time < 400;
  if (fresh) {
    M.midCtx.clearRect(0, 0, M.mid.width, M.mid.height);
    M.midCtx.drawImage(M.canvas, 0, 0, M.mid.width, M.mid.height);
    M.smallCtx.clearRect(0, 0, M.small.width, M.small.height);
    M.smallCtx.drawImage(M.mid, 0, 0, M.small.width, M.small.height);
    // center of scaling (in un-mirrored local coords)
    const cx = body ? r.x + r.w - body.sm.x : r.w / 2;
    const cy = body ? body.sm.y + body.torso * 0.5 - r.y : r.h / 2;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.translate(r.x + r.w, r.y); ctx.scale(-1, 1);
    for (let i = 0; i < 3; i++) {
      const sc = 1.05 + i * 0.08 + 0.03 * Math.sin(t * 22 + i * 2);
      const up = r.h * (0.02 + 0.025 * i) * (1 + 0.3 * Math.sin(t * 17 + i));
      ctx.globalAlpha = clamp(I * (0.95 - i * 0.25) * rand(0.8, 1), 0, 1);
      ctx.drawImage(i ? M.small : M.mid, cx - cx * sc, cy - cy * sc - up, r.w * sc, r.h * sc);
    }
    ctx.restore();
    // redraw the person on top so the aura sits behind them
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && personCanvas.width !== vw) { personCanvas.width = vw; personCanvas.height = vh; }
    if (vw) {
      personCtx.globalCompositeOperation = 'copy';
      personCtx.drawImage(video, 0, 0, vw, vh);
      personCtx.globalCompositeOperation = 'destination-in';
      personCtx.drawImage(M.canvas, 0, 0, vw, vh);
      drawMirrored(personCanvas, r);
      ctx.save(); ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = 0.35 * I;
      drawMirrored(M.canvas, r); ctx.restore();
    }
  } else {
    const x = body ? body.sm.x : W / 2, y = body ? body.sm.y + body.torso * 0.4 : H * 0.55;
    const R = body ? body.sw * 2.2 : Math.min(W, H) * 0.45;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    glowCircle(x, y, R * rand(0.95, 1.05), [[0, `rgba(255,210,60,${0.4 * I})`], [1, 'rgba(255,160,0,0)']]);
    ctx.restore();
  }
}

// ---------- Super Saiyan hair
// Everything is drawn in a head-local frame: origin = between the ears, x = towards the right ear,
// y = down, unit u = ear-to-ear distance. Each lock is a curved spike with its own spring, so the
// hair lags behind head movements and flutters with the aura.
const deg = d => d * Math.PI / 180;
// [angle around the head (deg, 90 = up), length (u), base width (u)]
const HAIR_FRONT = [[-28, 0.5, 0.26], [0, 0.78, 0.3], [25, 1.0, 0.32], [50, 1.22, 0.34], [74, 1.42, 0.36], [98, 1.38, 0.36],
  [122, 1.2, 0.34], [147, 0.98, 0.32], [172, 0.76, 0.3], [200, 0.5, 0.26]];
const HAIR_BACK = [[-12, 0.72, 0.3], [13, 0.98, 0.32], [38, 1.25, 0.34], [62, 1.5, 0.36], [86, 1.62, 0.36], [110, 1.5, 0.36],
  [135, 1.25, 0.34], [160, 0.98, 0.32], [186, 0.72, 0.3]];
// forehead bangs: [base x, base y, angle (deg, canvas), length, width]
const HAIR_BANGS = [[-0.22, -0.3, 108, 0.24, 0.17], [0.03, -0.34, 88, 0.32, 0.14], [0.25, -0.3, 70, 0.22, 0.16]];
const CAP = { cy: -0.3, rx: 0.6, ry: 0.64 };

function hairFrame(P, body) {
  const le = P[7], re = P[8], ey1 = P[2], ey2 = P[5];
  let c, u, ang;
  if (le.v > 0.4 && re.v > 0.4 && dist(le, re) > 12) {
    c = mid(le, re); u = dist(le, re); ang = Math.atan2(re.y - le.y, re.x - le.x);
  } else if (ey1.v > 0.4 && ey2.v > 0.4 && dist(ey1, ey2) > 5) {
    c = mid(ey1, ey2); u = dist(ey1, ey2) * 2.3; ang = Math.atan2(ey2.y - ey1.y, ey2.x - ey1.x);
  } else return null;
  if (body) u = Math.max(u, body.sw * 0.38); // turning the head shrinks the ear distance
  return { c, u, ang };
}

function updateHairPhysics(hair, fr, t, dt, flutter) {
  if (!hair.c) { hair.c = { ...fr.c }; hair.u = fr.u; hair.ang = fr.ang; }
  const vx = (fr.c.x - hair.c.x) / Math.max(dt, 1e-3) / fr.u, vy = (fr.c.y - hair.c.y) / Math.max(dt, 1e-3) / fr.u;
  hair.vel.x = lerp(hair.vel.x, clamp(vx, -12, 12), 0.35); hair.vel.y = lerp(hair.vel.y, clamp(vy, -12, 12), 0.35);
  hair.c = { ...fr.c }; hair.u = lerp(hair.u, fr.u, 0.3);
  let da = fr.ang - hair.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
  hair.ang += da * 0.5;
  // head velocity in head-local coords; tips lag in the opposite direction
  const cs = Math.cos(-hair.ang), sn = Math.sin(-hair.ang);
  const lx = hair.vel.x * cs - hair.vel.y * sn, ly = hair.vel.x * sn + hair.vel.y * cs;
  const dirs = [...HAIR_FRONT, ...HAIR_BACK].map(([th]) => lockAngle(th)).concat(HAIR_BANGS.map(b => deg(b[2])));
  hair.locks.forEach((L, i) => {
    const d = dirs[i];
    const target = clamp((Math.cos(d) * -ly - Math.sin(d) * -lx) * 0.1, -0.7, 0.7)
      + Math.sin(t * L.f + L.ph) * flutter;
    L.v += (-140 * (L.a - target) - 9 * L.v) * dt;
    L.a += L.v * dt;
  });
}

// spike direction: radial from the head, pulled upwards (SSJ hair defies gravity)
const lockAngle = th => lerp(-deg(th), -Math.PI / 2, 0.3);

function drawLock(bx, by, ang, len, wid, bend, back, u) {
  const dx = Math.cos(ang + bend), dy = Math.sin(ang + bend);
  const tx = bx + dx * len, ty = by + dy * len;
  const px = -Math.sin(ang), py = Math.cos(ang); // base perpendicular
  const lx = bx + px * wid / 2, ly = by + py * wid / 2, rx = bx - px * wid / 2, ry = by - py * wid / 2;
  const nx = -dy, ny = dx; // perpendicular to the (bent) axis
  const curve = bend * len * 0.45, bulge = wid * 0.18;
  const c1x = (lx + tx) / 2 + nx * (curve + bulge), c1y = (ly + ty) / 2 + ny * (curve + bulge);
  const c2x = (rx + tx) / 2 + nx * (curve - bulge), c2y = (ry + ty) / 2 + ny * (curve - bulge);
  const outline = () => { ctx.beginPath(); ctx.moveTo(lx, ly); ctx.quadraticCurveTo(c1x, c1y, tx, ty); ctx.quadraticCurveTo(c2x, c2y, rx, ry); ctx.closePath(); };

  const g = ctx.createLinearGradient(bx, by, tx, ty);
  if (back) { g.addColorStop(0, '#c77800'); g.addColorStop(0.6, '#f0b000'); g.addColorStop(1, '#ffd84a'); }
  else { g.addColorStop(0, '#f2a900'); g.addColorStop(0.45, '#ffd31f'); g.addColorStop(1, '#fff6b8'); }
  outline(); ctx.fillStyle = g; ctx.fill();
  // cel shading: one half of the lock darker
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(rx, ry); ctx.quadraticCurveTo(c2x, c2y, tx, ty);
  ctx.quadraticCurveTo((bx + tx) / 2 + nx * curve, (by + ty) / 2 + ny * curve, bx, by);
  ctx.fillStyle = back ? 'rgba(120,50,0,0.35)' : 'rgba(190,95,0,0.28)'; ctx.fill();
  outline(); ctx.strokeStyle = '#6e3f00'; ctx.lineWidth = Math.max(1.2, u * 0.016) / u; ctx.stroke();
  if (!back) { // shine streak
    ctx.beginPath();
    ctx.moveTo(bx + (tx - bx) * 0.12 + px * wid * 0.12, by + (ty - by) * 0.12 + py * wid * 0.12);
    ctx.quadraticCurveTo((bx + tx) / 2 + nx * curve + px * wid * 0.14, (by + ty) / 2 + ny * curve + py * wid * 0.14,
      bx + (tx - bx) * 0.72 + nx * curve * 0.5, by + (ty - by) * 0.72 + ny * curve * 0.5);
    ctx.strokeStyle = 'rgba(255,255,235,0.55)'; ctx.lineWidth = Math.max(1, u * 0.022) / u; ctx.stroke();
  }
}

function drawHair(pl, t, active) {
  const hair = pl.hair, fr = hairFrame(pl.P, pl.body);
  if (!fr) { hair.c = null; return; }
  const dt = clamp(t - (hair.lastT || t), 0, 0.05); hair.lastT = t;
  const s = pl.G.ssj;
  let grow, alpha = 1, flutter = 0.05;
  if (active) {
    const e = t - s.start, left = s.until - t;
    grow = e < 1.2 ? 1 - Math.exp(-7 * e) * Math.cos(11 * e) : 1; // elastic pop-in
    if (left < 0.5) grow *= left / 0.5;
    if (e < 1) flutter = 0.18 * (1 - e) + 0.05;
  } else { // powering up: flickering, growing
    grow = (s.hold / 1.2) * 0.7; alpha = Math.random() < 0.5 ? 0.85 : 0.25; flutter = 0.15;
  }
  updateHairPhysics(hair, fr, t, dt, flutter);
  if (grow <= 0.02) return;

  const u = hair.u, L = hair.locks, gw = Math.sqrt(grow);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(hair.c.x, hair.c.y); ctx.rotate(hair.ang); ctx.scale(u, u);
  // everything below is in u units
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const base = th => ({ x: Math.cos(deg(th)) * CAP.rx * 0.82, y: CAP.cy - Math.sin(deg(th)) * CAP.ry * 0.82 });

  // glow behind everything
  ctx.shadowColor = 'rgba(255,200,40,0.9)'; ctx.shadowBlur = 40;
  HAIR_BACK.forEach(([th, len, w], i) => {
    const b = base(th);
    drawLock(b.x, b.y, lockAngle(th), len * grow, w * gw, L[HAIR_FRONT.length + i].a, true, u);
    if (i === 0) ctx.shadowBlur = 0; // only the first fill needs the blur to light the halo
  });
  ctx.shadowBlur = 0;

  // skull cap with an M-shaped hairline
  const capPath = () => {
    ctx.beginPath();
    ctx.ellipse(0, CAP.cy, CAP.rx, CAP.ry, 0, deg(15), deg(165), true);
    ctx.lineTo(-0.5, 0.02); ctx.lineTo(-0.42, -0.2); ctx.lineTo(-0.3, -0.3); ctx.lineTo(-0.12, -0.25); ctx.lineTo(0, -0.34);
    ctx.lineTo(0.12, -0.25); ctx.lineTo(0.3, -0.3); ctx.lineTo(0.42, -0.2); ctx.lineTo(0.5, 0.02); ctx.closePath();
  };
  const cg = ctx.createLinearGradient(0, CAP.cy - CAP.ry, 0, 0);
  cg.addColorStop(0, '#ffe45c'); cg.addColorStop(1, '#e89c00');
  capPath(); ctx.fillStyle = cg; ctx.fill();
  ctx.strokeStyle = '#6e3f00'; ctx.lineWidth = Math.max(1.2, u * 0.016) / u; ctx.stroke();

  HAIR_FRONT.forEach(([th, len, w], i) => {
    const b = base(th);
    drawLock(b.x, b.y, lockAngle(th), len * grow, w * gw, L[i].a, false, u);
  });
  HAIR_BANGS.forEach(([x, y, a, len, w], i) => {
    drawLock(x, y, deg(a), len * grow, w * gw, clamp(L[HAIR_FRONT.length + HAIR_BACK.length + i].a * 0.7, -0.35, 0.35), false, u);
  });
  ctx.restore();
}

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [15, 19], [16, 20]];
function drawSkeleton(P) {
  ctx.save(); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,255,170,0.8)'; ctx.fillStyle = '#fff';
  for (const [a, b] of BONES) if (P[a].v > 0.5 && P[b].v > 0.5) { ctx.beginPath(); ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); ctx.stroke(); }
  for (const i of [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24]) if (P[i].v > 0.5) { ctx.beginPath(); ctx.arc(P[i].x, P[i].y, 5, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

// small name tag above each head so both players know who is who
function drawTag(pl) {
  const b = pl.body; if (!b) return;
  const x = b.nose.x, y = b.nose.y - b.sw * 1.1;
  ctx.save();
  ctx.font = `${Math.round(clamp(b.sw * 0.28, 16, 34))}px Bangers, Impact, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 5; ctx.strokeStyle = '#000'; ctx.strokeText(pl.name, x, y);
  ctx.fillStyle = pl.color; ctx.fillText(pl.name, x, y);
  ctx.restore();
}

function renderPlayer(pl, now) {
  const P = pl.P, body = pl.body;
  const s = pl.G.ssj, ssjActive = now < s.until;
  if (P && (ssjActive || s.hold > 0.4)) drawHair(pl, now, ssjActive);
  if (ssjActive && P) {
    if (Math.random() < 0.25 && body) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const x = body.sm.x + rand(-1.2, 1.2) * body.sw, y = body.sm.y + rand(-0.5, 1) * body.torso;
      drawBolt(bolt(x, y, x + rand(-60, 60), y + rand(-60, 60), 30, 5), 0.3, '160,200,255');
      ctx.restore();
    }
  }

  if (game.skeleton && P) drawSkeleton(P);
  if (game.players > 1) drawTag(pl);

  // charging visuals
  const k = pl.G.kame;
  if (k.state === 'charging' && k.charge > 0) drawEnergyBall(k.pos.x, k.pos.y, Math.min(W, H) * (0.015 + 0.06 * k.charge), now);
  const g = pl.G.genki;
  if (g.started && g.level > 0) drawGenki(g.pos.x, g.pos.y, genkiR(g.level), now);
}

function render(r, now) {
  const sx = game.shake ? rand(-1, 1) * game.shake : 0, sy = game.shake ? rand(-1, 1) * game.shake : 0;
  ctx.save();
  ctx.fillStyle = '#05050a'; ctx.fillRect(0, 0, W, H);
  ctx.translate(sx, sy);

  if (video.readyState >= 2) drawMirrored(video, r);
  else {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, '#1d2a6b'); g.addColorStop(1, '#05050a'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // auras first so neither one covers the other player's hair
  for (const pl of players) {
    const s = pl.G.ssj;
    const aura = now < s.until ? 1 : s.hold / 1.2;
    if (aura > 0.05) drawAura(pl, r, aura, now);
  }
  for (const pl of players) renderPlayer(pl, now);

  for (const e of effects) if (e.draw) e.draw();
  drawParts();
  for (const e of effects) if (e.drawOverlay) e.drawOverlay();

  ctx.restore();

  for (const f of flashes) {
    ctx.fillStyle = `rgba(${f.color},${f.alpha * (1 - f.t / f.dur)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

// ============================================================ main loop
let lastT = performance.now(), lastStatusT = 0;
function frame(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  const now = t / 1000;
  detect(t);
  const r = camRect();
  updatePlayers(dt, now, r);

  for (let i = effects.length - 1; i >= 0; i--) if (!effects[i].update(dt)) effects.splice(i, 1);
  for (let i = flashes.length - 1; i >= 0; i--) { flashes[i].t += dt; if (flashes[i].t >= flashes[i].dur) flashes.splice(i, 1); }
  updateParts(dt);
  game.shake = Math.max(0, game.shake - dt * 60) * 0.92;

  render(r, now);

  if (t - lastStatusT > 250) {
    lastStatusT = t;
    if (!video.srcObject) setStatus('Modo sin cámara · pulsa 1–6' + (game.players > 1 ? ' (J1) o Q–Y (J2)' : '') + ' para ver los efectos', 'warn');
    else if (!landmarker) setStatus('Cargando el detector de poses…', 'warn');
    else if (game.players > 1) setStatus(...duoStatus());
    else if (!players[0].P) setStatus('No te veo 👀 · ponte delante de la cámara', 'warn');
    else if (!players[0].body) setStatus('Aléjate un poco: necesito verte los hombros', 'warn');
    else if (!players[0].body.wOK) setStatus('Aléjate un poco más: necesito verte las manos', 'warn');
    else setStatus('¡Te veo! Haz una técnica 🔥', 'ok');
  }
  requestAnimationFrame(frame);
}

function duoStatus() {
  const seen = players.filter(pl => pl.P);
  if (!seen.length) return ['No os veo 👀 · poneos los dos delante de la cámara', 'warn'];
  if (seen.length < 2) return [`Solo veo a ${seen[0].name} · que entre el otro jugador`, 'warn'];
  const far = players.find(pl => !pl.body || !pl.body.wOK);
  if (far) return [`${far.name}: aléjate un poco, necesito verte hombros y manos`, 'warn'];
  return ['¡Os veo a los dos! J1 a la izquierda, J2 a la derecha 🔥', 'ok'];
}

// ============================================================ boot
function setupPlayers() {
  players = Array.from({ length: game.players }, (_, i) => newPlayer(i));
  const scores = [...document.querySelectorAll('.score')];
  scores.forEach((el, i) => {
    el.hidden = i >= game.players;
    el.style.setProperty('--pc', PLAYER_COLORS[i]);
    el.querySelector('small').textContent = game.players > 1 ? 'PUNTOS J' + (i + 1) : 'PUNTOS';
  });
  players.forEach((pl, i) => { pl.scoreEl = scores[i].querySelector('b'); });
  $('#keysP2').hidden = game.players < 2;
}

function startLoop() {
  if (game.running) return;
  game.running = true;
  setupPlayers();
  $('#intro').classList.add('hidden');
  $('#hud').hidden = false;
  requestAnimationFrame(t => { lastT = t; frame(t); });
}

$('#startBtn').onclick = async () => {
  const btn = $('#startBtn'), msg = $('#introMsg');
  btn.disabled = true; msg.textContent = '';
  sfx.init();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    msg.textContent = e.message === 'insecure'
      ? 'La cámara solo funciona en https:// o en http://localhost. Abre el juego desde localhost.'
      : 'No he podido acceder a la cámara (' + (e.name || e.message) + '). Revisa los permisos del navegador.';
    return;
  }
  startLoop();
  initPose().catch(e => { console.error(e); setStatus('Error cargando el detector: ' + e.message, 'warn'); });
};
$('#noCamBtn').onclick = () => { sfx.init(); startLoop(); };
document.querySelectorAll('#modePick button').forEach(b => b.onclick = () => {
  game.players = +b.dataset.players;
  document.querySelectorAll('#modePick button').forEach(o => o.classList.toggle('on', o === b));
});

function toggleSkeleton() { game.skeleton = !game.skeleton; $('#btnSkel').classList.toggle('off', !game.skeleton); }
function toggleMute() { const m = sfx.toggleMute(); $('#btnMute').textContent = m ? '🔇' : '🔊'; }
$('#btnSkel').onclick = toggleSkeleton;
$('#btnMute').onclick = toggleMute;
$('#btnSkel').classList.add('off');

// Test keys: 1–6 for J1, Q W E R T Y for J2
const TEST_KEYS = ['123456', 'qwerty'];
function testMove(pl, n) {
  const { G, body } = pl, duo = game.players > 1, left = pl.i === 0;
  const homeX = duo ? (left ? W * 0.3 : W * 0.7) : W * 0.62; // with no body on screen
  switch (n) {
    case 0: G.kame.charge = 0.9; G.kame.side = duo && left ? -1 : 1; if (!body) G.kame.pos = { x: homeX, y: H * 0.55 }; fireKame(pl); break;
    case 1: G.genki.level = 0.9; G.genki.pos = body ? { x: body.sm.x, y: Math.max(genkiR(0.9), body.nose.y - body.sw * 2) } : { x: duo ? homeX : W / 2, y: H * 0.28 }; throwGenki(pl); break;
    case 2: activateSSJ(pl); break;
    case 3: duo && !left ? fireSpear(pl, 0, -1) : fireSpear(pl, 1, 1); break;
    case 4: triggerFreeze(pl); break;
    case 5: triggerRaiden(pl, 1); break;
  }
}
addEventListener('keydown', e => {
  if (!game.running) return;
  const k = e.key.toLowerCase();
  if (k === 's') return toggleSkeleton();
  if (k === 'm') return toggleMute();
  players.forEach((pl, i) => { const n = TEST_KEYS[i].indexOf(k); if (n >= 0) testMove(pl, n); });
});

buildPanel();
