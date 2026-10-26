/**
 * A posable stick figure in OpenPose's 18-keypoint layout, drawn the way the OpenPose ControlNet
 * expects it (coloured limbs on black). The artist drags the joints in the Generate tab; the
 * rendered figure goes to the sidecar as a "pose" control and pins where the body is, how many
 * limbs it has and where they go. The style LoRA and the prompt then only have to supply the look.
 *
 * Keypoints: 0 nose, 1 neck, 2 right shoulder, 3 right elbow, 4 right wrist, 5 left shoulder,
 * 6 left elbow, 7 left wrist, 8 right hip, 9 right knee, 10 right ankle, 11 left hip, 12 left knee,
 * 13 left ankle, 14 right eye, 15 left eye, 16 right ear, 17 left ear. "Right" is the figure's right,
 * which is on the viewer's left when the figure faces us. Coordinates are 0..1 of the frame.
 */
export type Pt = { x: number; y: number };
export interface Pose { pts: Pt[]; /** keypoints left out of the drawing (hidden behind the body, out of frame) */ off: boolean[] }

export const JOINT_NAMES = ["nose", "neck", "R shoulder", "R elbow", "R wrist", "L shoulder", "L elbow", "L wrist", "R hip", "R knee", "R ankle", "L hip", "L knee", "L ankle", "R eye", "L eye", "R ear", "L ear"];

// limb list and colours exactly as controlnet_aux draws them (1-based pairs in the original; 0-based here)
const LIMBS: Array<[number, number]> = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
const COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]];

const P = (x: number, y: number): Pt => ({ x, y });
/** head keypoints around a nose position, facing the viewer; `turn` leans the face left/right */
const head = (nx: number, ny: number, s = 0.028, turn = 0): Pt[] => [P(nx, ny), P(nx - s * (1 - turn), ny - s * 0.5), P(nx + s * (1 + turn), ny - s * 0.5), P(nx - 2.1 * s * (1 - turn), ny - s * 0.3), P(nx + 2.1 * s * (1 + turn), ny - s * 0.3)];
const build = (nose: Pt, neck: Pt, rs: Pt, re: Pt, rw: Pt, ls: Pt, le: Pt, lw: Pt, rh: Pt, rk: Pt, ra: Pt, lh: Pt, lk: Pt, la: Pt, turn = 0, off: number[] = []): Pose => {
  const h = head(nose.x, nose.y, 0.028, turn);
  const pts = [nose, neck, rs, re, rw, ls, le, lw, rh, rk, ra, lh, lk, la, h[1]!, h[2]!, h[3]!, h[4]!];
  const o = pts.map(() => false); for (const i of off) o[i] = true;
  return { pts, off: o };
};

/** ready-made poses, in a 2:3 portrait frame; the editor rescales to the panel's shape */
export const POSE_PRESETS: Record<string, () => Pose> = {
  standing: () => build(P(0.5, 0.13), P(0.5, 0.22), P(0.41, 0.23), P(0.39, 0.37), P(0.38, 0.5), P(0.59, 0.23), P(0.61, 0.37), P(0.62, 0.5), P(0.44, 0.52), P(0.44, 0.72), P(0.44, 0.92), P(0.56, 0.52), P(0.56, 0.72), P(0.56, 0.92)),
  walking: () => build(P(0.5, 0.13), P(0.5, 0.22), P(0.42, 0.23), P(0.36, 0.35), P(0.42, 0.46), P(0.58, 0.23), P(0.64, 0.35), P(0.58, 0.46), P(0.45, 0.52), P(0.38, 0.7), P(0.33, 0.9), P(0.55, 0.52), P(0.62, 0.7), P(0.68, 0.9)),
  running: () => build(P(0.56, 0.14), P(0.52, 0.23), P(0.44, 0.24), P(0.32, 0.3), P(0.3, 0.18), P(0.6, 0.24), P(0.7, 0.35), P(0.78, 0.26), P(0.47, 0.52), P(0.3, 0.62), P(0.22, 0.82), P(0.57, 0.52), P(0.7, 0.68), P(0.8, 0.86), 0.3),
  jumping: () => build(P(0.5, 0.12), P(0.5, 0.21), P(0.41, 0.22), P(0.32, 0.12), P(0.3, 0.02), P(0.59, 0.22), P(0.68, 0.12), P(0.7, 0.02), P(0.44, 0.48), P(0.36, 0.62), P(0.4, 0.78), P(0.56, 0.48), P(0.64, 0.62), P(0.6, 0.78)),
  punching: () => build(P(0.5, 0.15), P(0.5, 0.24), P(0.41, 0.25), P(0.3, 0.3), P(0.2, 0.26), P(0.59, 0.25), P(0.66, 0.36), P(0.58, 0.4), P(0.44, 0.53), P(0.36, 0.72), P(0.3, 0.92), P(0.56, 0.53), P(0.64, 0.72), P(0.7, 0.92), -0.3),
  kicking: () => build(P(0.47, 0.14), P(0.48, 0.23), P(0.4, 0.24), P(0.33, 0.33), P(0.28, 0.24), P(0.56, 0.24), P(0.64, 0.3), P(0.68, 0.22), P(0.44, 0.52), P(0.36, 0.7), P(0.32, 0.9), P(0.54, 0.52), P(0.68, 0.46), P(0.84, 0.36)),
  "sword swing": () => build(P(0.48, 0.14), P(0.5, 0.23), P(0.42, 0.24), P(0.3, 0.17), P(0.26, 0.04), P(0.58, 0.24), P(0.5, 0.3), P(0.34, 0.2), P(0.44, 0.52), P(0.34, 0.7), P(0.28, 0.9), P(0.56, 0.52), P(0.64, 0.7), P(0.72, 0.9), -0.2),
  shooting: () => build(P(0.5, 0.15), P(0.5, 0.24), P(0.42, 0.25), P(0.3, 0.3), P(0.2, 0.3), P(0.58, 0.25), P(0.4, 0.34), P(0.26, 0.33), P(0.44, 0.53), P(0.42, 0.72), P(0.4, 0.92), P(0.56, 0.53), P(0.6, 0.72), P(0.62, 0.92), -0.4),
  kneeling: () => build(P(0.5, 0.25), P(0.5, 0.34), P(0.41, 0.35), P(0.38, 0.48), P(0.4, 0.6), P(0.59, 0.35), P(0.62, 0.48), P(0.6, 0.6), P(0.44, 0.62), P(0.42, 0.82), P(0.3, 0.84), P(0.56, 0.62), P(0.62, 0.78), P(0.66, 0.92)),
  sneaking: () => build(P(0.58, 0.3), P(0.52, 0.38), P(0.45, 0.39), P(0.4, 0.5), P(0.48, 0.58), P(0.58, 0.39), P(0.64, 0.5), P(0.7, 0.58), P(0.44, 0.62), P(0.34, 0.74), P(0.42, 0.9), P(0.54, 0.62), P(0.64, 0.74), P(0.7, 0.9), 0.4),
  sitting: () => build(P(0.5, 0.2), P(0.5, 0.29), P(0.41, 0.3), P(0.38, 0.43), P(0.44, 0.54), P(0.59, 0.3), P(0.62, 0.43), P(0.56, 0.54), P(0.45, 0.56), P(0.33, 0.6), P(0.32, 0.82), P(0.55, 0.56), P(0.67, 0.6), P(0.68, 0.82)),
  "lying down": () => build(P(0.12, 0.6), P(0.2, 0.62), P(0.22, 0.56), P(0.32, 0.5), P(0.42, 0.54), P(0.22, 0.68), P(0.34, 0.72), P(0.44, 0.68), P(0.46, 0.58), P(0.64, 0.56), P(0.82, 0.58), P(0.46, 0.66), P(0.64, 0.7), P(0.82, 0.72), 0.6),
};

export function mirrorPose(p: Pose): Pose {
  // swap left/right pairs and flip x
  const swap: Array<[number, number]> = [[2, 5], [3, 6], [4, 7], [8, 11], [9, 12], [10, 13], [14, 15], [16, 17]];
  const pts = p.pts.map((q) => ({ x: 1 - q.x, y: q.y })); const off = p.off.slice();
  for (const [a, b] of swap) { [pts[a], pts[b]] = [pts[b]!, pts[a]!]; [off[a], off[b]] = [off[b]!, off[a]!]; }
  return { pts, off };
}

/** draw the figure on a context in a w x h frame (OpenPose colours on black), scale = line weight factor */
export function drawPose(g: CanvasRenderingContext2D, p: Pose, w: number, h: number, scale = 1): void {
  g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
  const sw = Math.max(2, 4 * scale * Math.min(w, h) / 512);
  const at = (i: number) => ({ x: p.pts[i]!.x * w, y: p.pts[i]!.y * h });
  LIMBS.forEach(([a, b], i) => {
    if (p.off[a] || p.off[b]) return;
    const A = at(a), B = at(b); const c = COLORS[i]!;
    g.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`; g.lineWidth = sw * 1.5; g.lineCap = "round";
    g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke();
  });
  p.pts.forEach((_, i) => {
    if (p.off[i]) return; const q = at(i); const c = COLORS[i]!;
    g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; g.beginPath(); g.arc(q.x, q.y, sw, 0, Math.PI * 2); g.fill();
  });
}

/** the figure as a PNG data URL at the generation size */
export function poseToPng(p: Pose, w: number, h: number): string {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  drawPose(c.getContext("2d")!, p, w, h, 1);
  return c.toDataURL("image/png");
}

/** index of the joint nearest to (x, y) in frame units, within `r`, or -1 */
export function hitJoint(p: Pose, x: number, y: number, r: number): number {
  let best = -1, bd = r;
  p.pts.forEach((q, i) => { const d = Math.hypot(q.x - x, q.y - y); if (d < bd) { bd = d; best = i; } });
  return best;
}

/** move a joint; moving the neck or a hip carries the limbs hanging from it along */
export function moveJoint(p: Pose, i: number, x: number, y: number, carry: boolean): Pose {
  const dx = x - p.pts[i]!.x, dy = y - p.pts[i]!.y;
  const pts = p.pts.map((q) => ({ ...q }));
  const group: Record<number, number[]> = { 1: [0, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17], 0: [14, 15, 16, 17], 2: [3, 4], 5: [6, 7], 3: [4], 6: [7], 8: [9, 10], 11: [12, 13], 9: [10], 12: [13] };
  const list = carry ? [i, ...(group[i] ?? [])] : [i];
  for (const k of list) { pts[k]!.x += dx; pts[k]!.y += dy; }
  return { pts, off: p.off.slice() };
}

/** rescale a 2:3 preset into another frame shape, keeping the figure centred and fully inside */
export function fitPose(p: Pose, aspect: number): Pose {
  // presets are authored for aspect 2/3; in a wider frame the figure keeps its height, in a taller one its width
  const k = aspect / (2 / 3);
  const pts = p.pts.map((q) => (k > 1 ? { x: 0.5 + (q.x - 0.5) / k, y: q.y } : { x: q.x, y: 0.5 + (q.y - 0.5) * k }));
  return { pts, off: p.off.slice() };
}
