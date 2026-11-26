// Streamer-cam layout: finds the streamer's webcam in the stream and stacks it above the gameplay in the 9:16 clip,
// so every clip shows both what happened and how the streamer reacted. Pure JS, shared by the browser and the server.
//
// Detection: a few frames sampled across the clip go through a small face detector (UltraFace RFB-640, MIT,
// public/models). A webcam shows a real face looking at the camera that stays in about the same place; players in
// third-person games are seen from behind and move. The webcam rectangle is then snapped to the overlay's border:
// a straight edge that is there in every frame, with the still room on the inside and moving gameplay outside.

export const ANALYSIS_W = 640;
export const ANALYSIS_H = 360;
export const SRC_ASPECT = 16 / 9;
export const SAMPLE_FRAMES = 6;
export const FACE_MODEL = 'ultraface-rfb-640.onnx';
export const FACE_IN_W = 640;
export const FACE_IN_H = 480;
const PAD = (FACE_IN_H - ANALYSIS_H) / 2; // frames are letterboxed into the model's 4:3 input

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r4 = (v) => Math.round(v * 10000) / 10000;
const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = ix * iy;
  return i / (a.w * a.h + b.w * b.h - i || 1);
};

// ---------- face detector input / output ----------
/** One ANALYSIS_W x ANALYSIS_H RGB frame -> the face model's input tensor data (1x3x480x640, letterboxed). */
export function faceInput(frame) {
  const plane = FACE_IN_W * FACE_IN_H;
  const t = new Float32Array(3 * plane);
  const { data, channels = 3 } = frame;
  for (let y = 0; y < ANALYSIS_H; y++) {
    for (let x = 0; x < ANALYSIS_W; x++) {
      const s = (y * ANALYSIS_W + x) * channels, d = (y + PAD) * FACE_IN_W + x;
      t[d] = (data[s] - 127) / 128;
      t[plane + d] = (data[s + 1] - 127) / 128;
      t[2 * plane + d] = (data[s + 2] - 127) / 128;
    }
  }
  return t;
}

/** Face model output (scores N x 2, corner boxes N x 4, normalized to the input) -> faces in frame coordinates. */
export function decodeFaces(scores, boxes, minScore = 0.7) {
  const found = [];
  for (let i = 0; i < scores.length / 2; i++) {
    const score = scores[i * 2 + 1];
    if (score < minScore) continue;
    const x1 = boxes[i * 4], y1 = (boxes[i * 4 + 1] * FACE_IN_H - PAD) / ANALYSIS_H;
    const x2 = boxes[i * 4 + 2], y2 = (boxes[i * 4 + 3] * FACE_IN_H - PAD) / ANALYSIS_H;
    if (x2 <= x1 || y2 <= y1) continue;
    found.push({ x: clamp(x1, 0, 1), y: clamp(y1, 0, 1), w: clamp(x2, 0, 1) - clamp(x1, 0, 1), h: clamp(y2, 0, 1) - clamp(y1, 0, 1), score });
  }
  found.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of found) if (f.w * f.h > 0.0003 && !keep.some((k) => iou(k, f) > 0.3)) keep.push(f);
  return keep.slice(0, 20);
}

/** Group faces from different frames that are the same face in (nearly) the same place. */
function clusters(perFrame) {
  const out = [];
  const same = (m, b) => iou(m, b) > 0.3
    || Math.hypot(m.x + m.w / 2 - b.x - b.w / 2, m.y + m.h / 2 - b.y - b.h / 2) < 0.5 * Math.max(m.w, m.h);
  perFrame.forEach((boxes, f) => {
    for (const b of boxes) {
      const c = out.find((k) => !k.frames.has(f) && same(k.mean, b));
      if (c) {
        c.boxes.push(b); c.frames.add(f);
        const n = c.boxes.length;
        c.mean = ['x', 'y', 'w', 'h'].reduce((m, k) => ({ ...m, [k]: c.boxes.reduce((s, x) => s + x[k], 0) / n }), {});
      } else out.push({ boxes: [b], frames: new Set([f]), mean: { x: b.x, y: b.y, w: b.w, h: b.h } });
    }
  });
  return out;
}

// ---------- snapping to the overlay border ----------
function gray(frame) {
  const { data, width, height, channels = 3 } = frame;
  if (channels === 1) return data;
  const g = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += channels) g[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  return g;
}

/**
 * Edge strength that holds in (almost) every frame (overlay borders, not moving content), and how much each pixel
 * changes over the clip (gameplay moves, a webcam's room doesn't).
 */
export function frameStats(frames) {
  const { width: w, height: h } = frames[0];
  const grays = frames.map(gray);
  const keep = Math.max(0, Math.floor(grays.length * 0.25)); // tolerate one odd frame
  const vx = new Uint8Array(w * h), hy = new Uint8Array(w * h), motion = new Uint8Array(w * h);
  const gx = new Array(grays.length), gy = new Array(grays.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let m = 0;
      for (let f = 0; f < grays.length; f++) {
        const g = grays[f];
        gx[f] = Math.abs(g[i + 1] - g[i - 1]);
        gy[f] = Math.abs(g[i + w] - g[i - w]);
        if (f) m += Math.abs(g[i] - grays[f - 1][i]);
      }
      vx[i] = gx.sort((a, b) => a - b)[keep];
      hy[i] = gy.sort((a, b) => a - b)[keep];
      motion[i] = Math.min(255, m / Math.max(1, grays.length - 1));
    }
  }
  return { w, h, vx, hy, motion };
}

const EDGE_T = 16;
// Fraction of a vertical line at column `at` (or horizontal line at row `at`) over [from, to] that is a static edge.
function lineScore(E, vertical, at, from, to) {
  const { w, h } = E;
  let hit = 0, n = 0;
  for (let t = Math.max(0, Math.round(from)); t <= Math.min(vertical ? h - 1 : w - 1, Math.round(to)); t++) {
    n++;
    let best = 0;
    for (let d = -1; d <= 1; d++) {
      const p = at + d;
      if (p < 1 || p >= (vertical ? w : h) - 1) continue;
      best = Math.max(best, vertical ? E.vx[t * w + p] : E.hy[p * w + t]);
    }
    if (best > EDGE_T) hit++;
  }
  return n ? hit / n : 0;
}

// Mean motion in a band beside the line, on the side given by `dir` (+1: right / below, -1: left / above).
function sideMotion(E, vertical, at, dir, from, to) {
  const { w, h } = E;
  let s = 0, n = 0;
  for (let t = Math.max(0, Math.round(from)); t <= Math.min(vertical ? h - 1 : w - 1, Math.round(to)); t += 2) {
    for (let k = 3; k <= 10; k++) {
      const p = at + dir * k;
      if (p < 0 || p >= (vertical ? w : h)) break;
      s += vertical ? E.motion[t * w + p] : E.motion[p * w + t];
      n++;
    }
  }
  return n ? s / n : 0;
}

/**
 * Best border in [lo, hi] (pixels). `outside` is the direction away from the face. A border is a straight static
 * edge, preferably with more movement outside than inside; the frame's own edge counts when it's in range.
 */
function snapSide(E, vertical, lo, hi, from, to, outside) {
  const max = vertical ? E.w : E.h;
  let best = null;
  for (let at = Math.max(1, Math.round(lo)); at <= Math.min(max - 2, Math.round(hi)); at++) {
    const line = lineScore(E, vertical, at, Math.round(from), Math.round(to));
    if (line < 0.6) continue;
    const mOut = sideMotion(E, vertical, at, outside, from, to), mIn = sideMotion(E, vertical, at, -outside, from, to);
    const s = line * (0.55 + clamp((mOut - mIn) / (mOut + mIn + 6), -0.5, 0.5));
    // Ties go to the outer line (the overlay's edge rather than a line in the streamer's room).
    if (s >= 0.5 && (!best || s > best.s + 0.03 || (s > best.s - 0.03 && (at - best.at) * outside > 0))) best = { at, s };
  }
  if (best) return best.at;
  const edge = outside > 0 ? max : 0;
  return (outside > 0 ? hi >= max - 2 : lo <= 1) ? edge : null;
}

/** Rectangle of the webcam overlay around a face (normalized), snapped to the overlay's borders when found. */
export function camRect(frames, f, stats = null) {
  const cx = f.x + f.w / 2;
  // Typical webcam framing when no border is found: head and shoulders with room around them.
  const rect = { x: cx - f.w * 2.6, y: f.y - f.h * 1.1, r: cx + f.w * 2.6, b: f.y + f.h * 3 };
  if (frames?.length > 1 || stats) {
    const E = stats || frameStats(frames);
    const W = E.w, H = E.h;
    const fx = f.x * W, fy = f.y * H, fw = f.w * W, fh = f.h * H, fcx = cx * W;
    const rows = [fy - fh * 0.5, fy + fh * 2], cols = [fx - fw, fx + fw * 2];
    const left = snapSide(E, true, fcx - fw * 6, fx - fw * 0.4, ...rows, -1);
    const right = snapSide(E, true, fx + fw * 1.4, fcx + fw * 6, ...rows, 1);
    const top = snapSide(E, false, fy - fh * 3, fy - fh * 0.3, ...cols, -1);
    const bottom = snapSide(E, false, fy + fh * 1.6, fy + fh * 5, ...cols, 1);
    if (left !== null) rect.x = left / W;
    if (right !== null) rect.r = right / W;
    if (top !== null) rect.y = top / H;
    if (bottom !== null) rect.b = bottom / H;
    rect.snapped = [left, right, top, bottom].filter((v) => v !== null).length;
  }
  const x = clamp(rect.x, 0, 1), y = clamp(rect.y, 0, 1);
  return { x: r4(x), y: r4(y), w: r4(clamp(rect.r, 0, 1) - x), h: r4(clamp(rect.b, 0, 1) - y), snapped: rect.snapped || 0 };
}

/**
 * Decide the layout from sampled frames + the faces found in each.
 * @returns {{type:'cam', cam:{x,y,w,h}, face:{x,y,w,h}} | {type:'full', focusX:number} | {type:'none', reason}}
 */
export function planFromFaces({ frames = [], faces = [] }) {
  const n = faces.length;
  if (!n) return { type: 'none', reason: 'no frames' };
  const cands = clusters(faces)
    .filter((c) => c.frames.size >= Math.max(2, Math.ceil(n * 0.4)))
    .map((c) => {
      const m = c.mean;
      const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
      const drift = Math.max(...c.boxes.map((b) => Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy))) / Math.max(m.w, m.h);
      const avg = c.boxes.reduce((s, b) => s + b.score, 0) / c.boxes.length;
      return { ...c, cx, cy, drift, score: (c.frames.size / n) * avg * (drift < 0.6 ? 1 : 0.4) };
    })
    .sort((a, b) => b.score - a.score);
  if (!cands.length) return { type: 'none', reason: 'no streamer face found' };
  // A big face fills the picture (IRL / Just Chatting): follow it with a vertical crop.
  const full = cands.find((c) => c.mean.h >= 0.14 && c.cx >= 0.15 && c.cx <= 0.85);
  const small = cands.filter((c) => c.mean.h < 0.14);
  let cam = null;
  if (small.length) {
    const stats = frames.length > 1 ? frameStats(frames) : null;
    // Among smaller faces, prefer one inside a real overlay (borders found) and toward the edges of the screen.
    cam = small.map((c) => {
      const rect = camRect(frames, c.mean, stats);
      const edge = Math.min(c.cx, 1 - c.cx, c.cy, 1 - c.cy) < 0.25 ? 1.2 : 1;
      return { c, rect, s: c.score * edge * (1 + 0.15 * rect.snapped) };
    }).sort((a, b) => b.s - a.s)[0];
  }
  if (full && (!cam || full.mean.h >= 0.2 || full.score >= cam.c.score)) {
    return { type: 'full', focusX: r4(full.cx), score: r4(full.score) };
  }
  if (!cam) return { type: 'none', reason: 'no streamer face found' };
  const m = cam.c.mean;
  const { snapped, ...rect } = cam.rect;
  return { type: 'cam', cam: rect, face: { x: r4(m.x), y: r4(m.y), w: r4(m.w), h: r4(m.h) }, score: r4(cam.c.score), borders: snapped };
}
/** A manually set cam rectangle (normalized source coordinates) as a plan. */
export function manualPlan(box) {
  if (!box || !(box.w > 0.02) || !(box.h > 0.02)) return { type: 'none', reason: 'manual: no cam' };
  const cam = { x: r4(clamp(box.x, 0, 1)), y: r4(clamp(box.y, 0, 1)), w: r4(clamp(box.w, 0, 1 - box.x)), h: r4(clamp(box.h, 0, 1 - box.y)) };
  return { type: 'cam', cam, face: { x: r4(cam.x + cam.w * 0.4), y: r4(cam.y + cam.h * 0.25), w: r4(cam.w * 0.2), h: r4(cam.h * 0.3) }, manual: true };
}

// ---------- geometry of the rendered frame ----------
/** Where everything goes in a W x H vertical frame for this plan (source rects are normalized). */
export function camGeometry(W, H, plan) {
  if (plan?.type === 'full') {
    const cw = (W / H) / SRC_ASPECT;
    return { type: 'full', crop: { x: r4(clamp(plan.focusX - cw / 2, 0, 1 - cw)), y: 0, w: r4(cw), h: 1 } };
  }
  if (plan?.type !== 'cam') return null;
  const c = plan.cam;
  const camAspect = (c.w * SRC_ASPECT) / c.h;
  const camH = even(clamp(W / camAspect, H * 0.3, H * 0.45));
  const gameH = H - camH;
  // Cam panel: fill it from the cam rectangle, keeping the face in view.
  const P = W / camH;
  let cam = { ...c };
  if (camAspect > P) {
    const w = (c.h * P) / SRC_ASPECT;
    const fx = plan.face ? plan.face.x + plan.face.w / 2 : c.x + c.w / 2;
    cam = { x: clamp(fx - w / 2, c.x, c.x + c.w - w), y: c.y, w, h: c.h };
  } else if (camAspect < P) {
    const h = (c.w * SRC_ASPECT) / P;
    const fy = plan.face ? plan.face.y + plan.face.h / 2 : c.y + c.h * 0.4;
    cam = { x: c.x, y: clamp(fy - h * 0.42, c.y, c.y + c.h - h), w: c.w, h };
  }
  // Gameplay panel: full height, centered.
  const gw = Math.min(1, (W / gameH) / SRC_ASPECT);
  const game = { x: (1 - gw) / 2, y: 0, w: gw, h: 1 };
  const n = (o) => ({ x: r4(o.x), y: r4(o.y), w: r4(o.w), h: r4(o.h) });
  return { type: 'cam', camH, gameH, cam: n(cam), game: n(game) };
}

/** ffmpeg filter (input [0:v]) that builds the base video [l0] for a cam/full plan. */
export function camFilter(W, H, geo, input = '[0:v]') {
  const crop = (r) => `crop=iw*${r.w}:ih*${r.h}:iw*${r.x}:ih*${r.y}`;
  if (geo.type === 'full') {
    return `${input}fps=30,${crop(geo.crop)},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[l0]`;
  }
  const line = Math.max(2, even(W / 180));
  return `${input}fps=30,split=2[camsrc][gamesrc];`
    + `[camsrc]${crop(geo.cam)},scale=${W}:${geo.camH}:force_original_aspect_ratio=increase,crop=${W}:${geo.camH},setsar=1[campanel];`
    + `[gamesrc]${crop(geo.game)},scale=${W}:${geo.gameH}:force_original_aspect_ratio=increase,crop=${W}:${geo.gameH},setsar=1[gamepanel];`
    + `[campanel][gamepanel]vstack=inputs=2,drawbox=x=0:y=${geo.camH - line / 2}:w=iw:h=${line}:color=black@0.85:t=fill[l0]`;
}

/** Text positions for the cam layout (720x1280 reference, scaled by u): headline under the seam, etc. */
export function camAnchors(W, H, geo) {
  const u = W / 720;
  if (geo.type === 'full') return null;
  return { u, hookY: geo.camH + 95 * u, subY: geo.camH + geo.gameH * 0.7 };
}

// ---------- per-streamer setting (stored by the server) ----------
const LAST_GOOD_MS = 30 * 24 * 3600 * 1000;
/** Does this streamer's setting need a detection run (manual / off don't)? */
export const needsDetection = (stored) => !stored || !['manual', 'off'].includes(stored.mode);

/**
 * The plan to render with: the user's own rectangle, "off", this clip's detection, or (when the streamer was off
 * camera in this clip) the last good detection for this streamer.
 */
export function resolvePlan(stored, detected, now = Date.now()) {
  if (stored?.mode === 'manual') return manualPlan(stored.box);
  if (stored?.mode === 'off') return { type: 'none', reason: 'turned off for this streamer' };
  if (detected && detected.type !== 'none') return detected;
  if (stored?.last && now - (stored.lastAt || 0) < LAST_GOOD_MS) return { ...stored.last, reused: true };
  return detected || { type: 'none', reason: 'not detected' };
}

/** Human-readable summary for the clip details / logs. */
export function describePlan(plan) {
  if (!plan) return 'Full frame';
  if (plan.type === 'cam') return plan.manual ? 'Streamer cam (set by you) above the gameplay' : plan.reused ? 'Streamer cam (last detected position) above the gameplay' : 'Streamer cam (detected) above the gameplay';
  if (plan.type === 'full') return 'Streamer fills the stream: vertical crop that follows them';
  return `No streamer cam found${plan.reason ? ` (${plan.reason})` : ''}: full frame`;
}
