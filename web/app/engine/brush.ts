/**
 * Brush engine v2 (Phase 3.1 dynamics + Phase 1 raster).
 *
 * Industry model (Clip Studio / Procreate / Photoshop): a stroke is rendered
 * into its own STROKE BUFFER with per-dab FLOW; the buffer is composited onto
 * the layer once with the stroke OPACITY. Overlaps inside one stroke therefore
 * build up only to the opacity cap, and pressure modulates size and flow
 * independently through a user-editable PRESSURE CURVE.
 *
 * Pipeline per sample:
 *   raw → OneEuro(x,y) → pressure curve → dab spacing along centripetal Catmull-Rom
 *       → tip (hardness, min 1 px anti-alias ring, tilt ellipse, rotation)
 *       → optional paper grain mask → stamp with flow into the buffer
 *
 * Smudge brushes bypass the buffer: they move pixels of the layer directly.
 * The One Euro filter mirrors core/include/omni/stroke_predictor.hpp.
 */

import { TILE, Layer, makeCanvas, type Tile } from "./document.js";
import { WET_DEFAULT, BODY_DEFAULT, wetField, bodyField, spongeFootprint, spongeMask, canvasFootprint, DISC, type WetParams, type BodyParams, type SpongeKind, type Footprint, type WetField, type BodyField } from "./media.js";

export type BrushKind = "paint" | "eraser" | "smudge" | "blur";
export type TipShape = "round" | "flat" | "bristle" | "custom" | "sponge";
export type Media = "none" | "water" | "acrylic";
export type WetEffect = "none" | "salt" | "alcohol" | "sand";
export type StrokeBlend = "normal" | "multiply";

export interface BrushPreset {
  name: string;
  category: "ink" | "pencil" | "paint" | "water" | "acrylic" | "sponge" | "air" | "fx" | "erase";
  kind: BrushKind;
  size: number; // DU diameter at full pressure
  minSizeRatio: number; // size at zero pressure, 0..1
  sizeByPressure: boolean;
  opacity: number; // stroke cap 0..1
  flow: number; // per-dab alpha 0..1
  flowByPressure: boolean;
  minFlowRatio: number;
  hardness: number; // 0..1
  spacing: number; // fraction of radius
  grain: number; // 0..1 paper texture strength
  grainScale: number; // DU per grain period
  tiltShape: boolean;
  velocityThin: number; // 0..1
  jitter: number; // 0..1 positional scatter in radii
  /** 0..1: per-dab radius noise (ragged edge like a worn nib or dry media) */
  sizeNoise: number;
  /** 0..1: per-dab flow noise (broken, textured deposit) */
  flowNoise: number;
  /** 0..1: how much pressure drives the per-stroke opacity ceiling (markers: 0, pencils: ~0.5) */
  opacityByPressure: number;
  /** direction-dependent width for round tips: 0 = none, 1 = full calligraphic (thin along the nib angle) */
  nibFlex: number;
  nibAngleDeg: number;
  blend: StrokeBlend;
  smoothing: number; // 0..1
  smudgeStrength: number; // 0..1 (smudge only)
  /** entry/exit taper length in DU (0 = off): radius ramps from 0 over this distance at both ends */
  taper: number;
  /** pull-string stabilizer radius in screen px (0 = off) */
  stabilizer: number;
  /** one line shown in the panel: what this brush is for and how it behaves */
  description: string;
  tipShape: TipShape;
  /** flat tips: fixed angle (deg) and minor/major ratio; bristle tips: count and spread (fraction of r) */
  tipAngleDeg: number;
  tipRatio: number;
  bristles: number;
  bristleSpread: number;
  /** wet mixing: pull the layer colour under the tip into the dab (0 = pure pigment, 1 = pure mixer) */
  mix: number;
  /** watercolour rim: pigment collects at the dab edge */
  wetEdge: number;
  /** spray: fraction of dab area filled by scattered droplets instead of one disc */
  scatter: number;
  scatterCount: number;
  /** tilt shading (pencils): size grows / flow drops as the pen lies down */
  tiltSize: number;
  /** flat tip turns to stay perpendicular to the stroke (ribbon / brush pen) instead of a fixed chisel angle */
  tipFollow: boolean;
  /** custom tip: PNG data URL (alpha, or luminance when the PNG is opaque: dark = ink) */
  tipImage: string | null;
  /** custom tip rotates with the stroke direction */
  tipImageFollow: boolean;
  /** dual brush: a second tip stamped at the same spot and intersected with the first (texture) */
  dual: boolean;
  dualShape: TipShape;
  dualImage: string | null;
  dualRatio: number;      // dual tip radius / main radius
  dualRotate: boolean;    // random rotation per dab
  /** px of stroke after which the reservoir is ~63% spent (0 = never runs dry); flow falls to inkMin */
  inkLoad: number;
  inkMin: number;
  /** 0..1: light pressure softens the edge towards hardness·(1-hardnessByPressure) */
  hardnessByPressure: number;
  tiltFlow: number;
  /** ink pooling: slow movement widens the line (nib/brush loads ink) */
  pooling: number;
  /** pressure curve: 4 control points, cubic Bézier from (0,0) to (1,1), x monotonic */
  curve: [number, number, number, number]; // [c1x, c1y, c2x, c2y]
  /** natural media: "water" runs the wet simulation (engine/media.ts), "acrylic" adds body and baked relief */
  media: Media;
  /** watercolour parameters (merged over WET_DEFAULT) */
  wet: Partial<WetParams>;
  /** acrylic parameters (merged over BODY_DEFAULT) */
  body: Partial<BodyParams>;
  /** sponge tips: which sponge, and whether every dab gets a random spin */
  spongeKind: SpongeKind;
  spinTip: boolean;
  /** acrylic: scrape body away under the tool (sgraffito, knife edge) */
  scrape: boolean;
  /** acrylic: mixing only with paint that is still open (recently laid), not with dry paint */
  mixOpen: boolean;
  /** watercolour: a texture effect applied under each dab instead of pigment */
  wetEffect: WetEffect;
}

const base = (o: Partial<BrushPreset> & Pick<BrushPreset, "name" | "category" | "size">): BrushPreset => ({
  kind: "paint", minSizeRatio: 0.1, sizeByPressure: true, opacity: 1, flow: 1, flowByPressure: false, minFlowRatio: 0.2,
  hardness: 0.9, spacing: 0.1, grain: 0, grainScale: 24, tiltShape: false, velocityThin: 0, jitter: 0, blend: "normal",
  smoothing: 0.5, smudgeStrength: 0.6, taper: 0, stabilizer: 0, description: "", tipShape: "round", tipAngleDeg: 45, tipRatio: 0.3, bristles: 12, bristleSpread: 0.9,
  mix: 0, wetEdge: 0, scatter: 0, scatterCount: 16, tiltSize: 0, tiltFlow: 0, pooling: 0, tipFollow: false, inkLoad: 0, inkMin: 0.25, hardnessByPressure: 0, tipImage: null, tipImageFollow: false, sizeNoise: 0, flowNoise: 0, opacityByPressure: 0, nibFlex: 0, nibAngleDeg: 45, dual: false, dualShape: "bristle", dualImage: null, dualRatio: 1.2, dualRotate: true, curve: [0.4, 0.2, 0.7, 0.9], media: "none", wet: {}, body: {}, spongeKind: "natural", spinTip: true, scrape: false, mixOpen: false, wetEffect: "none", ...o,
});

export const PRESETS: BrushPreset[] = [
  // ---- INK: hard, opaque, speed and pressure shape the line ----
  base({ name: "G-Pen", category: "ink", size: 10, minSizeRatio: 0.06, hardness: 0.98, spacing: 0.07, velocityThin: 0.3, taper: 14, stabilizer: 6, pooling: 0.25, curve: [0.35, 0.1, 0.65, 0.95],
    description: "Flexible steel nib. Pressure opens the line fast; fast strokes thin, slow starts pool. The manga workhorse." }),
  base({ name: "Real G-Pen", category: "ink", size: 11, minSizeRatio: 0.05, hardness: 0.95, spacing: 0.06, velocityThin: 0.3, taper: 14, stabilizer: 5, pooling: 0.2, sizeNoise: 0.35, flowNoise: 0.25, grain: 0.18, grainScale: 6, curve: [0.35, 0.1, 0.65, 0.95],
    description: "G-Pen with a worn, rougher nib: ragged edge and broken deposit for a rugged, hand-inked look. Opacity stays constant; pressure drives width only." }),
  base({ name: "Sketch Pen", category: "ink", size: 5, minSizeRatio: 0.3, opacity: 0.75, flow: 0.7, hardness: 0.9, spacing: 0.08, velocityThin: 0.45, taper: 6, sizeNoise: 0.2, flowNoise: 0.3, opacityByPressure: 0.4, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Loose rough-in pen: light, speed-thinned, slightly broken lines that stack darker where you go over them." }),
  base({ name: "Ballpoint", category: "ink", size: 2.6, minSizeRatio: 0.85, opacity: 0.85, flow: 0.55, flowByPressure: true, minFlowRatio: 0.25, hardness: 0.9, spacing: 0.08, grain: 0.3, grainScale: 5, sizeNoise: 0.1, curve: [0.4, 0.3, 0.7, 0.85],
    description: "Ballpoint: nearly constant width, ink builds with pressure and repeated passes, skips a little on texture." }),
  base({ name: "Fineliner", category: "ink", size: 2.2, minSizeRatio: 1, sizeByPressure: false, hardness: 1, spacing: 0.08, stabilizer: 6, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Felt-tip fineliner: constant width, full opacity, no response to pressure. Clean contour lines." }),
  base({ name: "Gel Pen", category: "ink", size: 3.2, minSizeRatio: 0.7, hardness: 1, spacing: 0.07, stabilizer: 4, pooling: 0.15, curve: [0.4, 0.25, 0.7, 0.9],
    description: "Gel pen: smooth, slightly wet line that pools when you pause. Works in white for highlights on ink." }),
  base({ name: "Brush Pen", category: "ink", size: 18, minSizeRatio: 0.03, hardness: 0.92, spacing: 0.05, velocityThin: 0.55, taper: 22, stabilizer: 6, pooling: 0.5, nibFlex: 0, curve: [0.55, 0.05, 0.8, 0.85],
    description: "Brush pen: hairline at a touch, a fat belly when pressed, long tapers in and out. The manga inking classic." }),
  base({ name: "Crosshatch", category: "ink", size: 22, minSizeRatio: 0.6, hardness: 0.95, spacing: 0.05, dual: true, dualShape: "bristle", dualRatio: 1.3, dualRotate: true, bristles: 7, bristleSpread: 1.05, flow: 0.85, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Dual brush with a spinning bristle mask: scribbled multi-direction hatch that darkens with pressure." }),
  base({ name: "Ink Stippling", category: "ink", size: 36, minSizeRatio: 0.4, opacity: 1, flow: 1, hardness: 1, spacing: 0.25, scatter: 1, scatterCount: 9, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Stipple: hard dots scattered in the tip radius; pressure widens the cloud and adds dots." }),
  base({ name: "Maru Pen", category: "ink", size: 4.5, minSizeRatio: 0.2, hardness: 1, spacing: 0.07, velocityThin: 0.15, taper: 8, stabilizer: 4, curve: [0.4, 0.3, 0.7, 0.9],
    description: "Mapping nib. Fine, stiff, crisp. Hatching, hair, small detail." }),
  base({ name: "Kabura Pen", category: "ink", size: 7, minSizeRatio: 0.5, hardness: 1, spacing: 0.08, velocityThin: 0.05, taper: 6, stabilizer: 5, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Turnip nib. Even, rounded line with little pressure response. Panel borders, balloons, lettering." }),
  base({ name: "Brush Ink", category: "ink", size: 26, minSizeRatio: 0.02, hardness: 0.85, spacing: 0.06, tiltShape: true, velocityThin: 0.5, taper: 30, stabilizer: 8, pooling: 0.6, wetEdge: 0.15, inkLoad: 1400, inkMin: 0.45, curve: [0.6, 0.05, 0.8, 0.8],
    description: "Fude brush. Hairline to full belly with pressure, loads ink when slow, tilt flattens the tuft, thins out on long strokes and reloads on lift." }),
  base({ name: "Ribbon Pen", category: "ink", size: 16, minSizeRatio: 0.5, hardness: 1, spacing: 0.05, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.18, tipFollow: true, taper: 10, stabilizer: 5, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Brush-pen nib that turns with the stroke: full width on every direction, thinning only through pressure. Lettering, hair flow, speed lines." }),
  base({ name: "Calligraphy", category: "ink", size: 22, minSizeRatio: 0.85, hardness: 1, spacing: 0.05, tipShape: "flat", tipAngleDeg: 35, tipRatio: 0.14, stabilizer: 4, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Broad nib held at 35°: thick on the down-left diagonal, hairline across it. Width comes from direction, not pressure." }),
  base({ name: "Rake", category: "ink", size: 24, minSizeRatio: 0.6, hardness: 0.9, spacing: 0.05, dual: true, dualShape: "bristle", dualRatio: 1.1, dualRotate: false, bristles: 9, bristleSpread: 1, flow: 0.9, taper: 8, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Dual brush: round tip intersected with a bristle tip that follows the stroke. Parallel hatch lines in one pass." }),
  base({ name: "Chalk", category: "pencil", size: 18, minSizeRatio: 0.5, opacity: 0.9, flow: 0.5, flowByPressure: true, minFlowRatio: 0.2, hardness: 0.8, spacing: 0.08, dual: true, dualShape: "bristle", dualRatio: 1.4, dualRotate: true, bristles: 30, bristleSpread: 1.1, grain: 0.3, grainScale: 12, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Dual brush with a spinning bristle mask: crumbly chalk edge that never repeats." }),
  base({ name: "Dry Brush", category: "ink", size: 30, minSizeRatio: 0.3, hardness: 0.9, spacing: 0.04, tipShape: "bristle", bristles: 22, bristleSpread: 0.95, flow: 0.35, flowByPressure: true, minFlowRatio: 0.15, grain: 0.45, grainScale: 9, taper: 20, inkLoad: 600, inkMin: 0.2, curve: [0.45, 0.15, 0.7, 0.9],
    description: "Starved brush. Separate bristle streaks that fill in under pressure. Speed lines, fur, texture." }),
  base({ name: "Technical 0.3", category: "ink", size: 3, minSizeRatio: 1, sizeByPressure: false, hardness: 1, spacing: 0.08, stabilizer: 10, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Drafting pen. Constant width whatever you do. Rulers, mechanical detail, backgrounds." }),
  base({ name: "Trace Pen", category: "ink", size: 10, minSizeRatio: 0, hardness: 1, spacing: 0.06, smoothing: 0, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Width follows pressure exactly (straight line, no taper, no lag). Redraw inks with it; also the cleanest pen for inking over a sketch." }),

  // ---- PENCIL: grain, tilt shading, build-up ----
  base({ name: "Graphite Control", category: "pencil", size: 5, minSizeRatio: 0.45, opacity: 0.8, flow: 0.45, flowByPressure: true, minFlowRatio: 0.15, hardness: 0.65, spacing: 0.1, grain: 0.7, grainScale: 12, tiltShape: true, tiltSize: 0.7, tiltFlow: 0.5, sizeNoise: 0.15, opacityByPressure: 0.5, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Rough-sketch pencil: shows the paper tooth, goes wide and pale when tilted flat, builds dark only when pressed." }),
  base({ name: "Charcoal", category: "pencil", size: 26, minSizeRatio: 0.5, opacity: 0.95, flow: 0.6, flowByPressure: true, minFlowRatio: 0.2, hardness: 0.6, spacing: 0.07, tipShape: "bristle", bristles: 40, bristleSpread: 1.15, grain: 0.8, grainScale: 16, tiltSize: 1, tiltFlow: 0.4, sizeNoise: 0.3, flowNoise: 0.35, curve: [0.45, 0.15, 0.75, 0.9],
    description: "Chunky charcoal: crumbly bristle mass with heavy tooth, big and smoky when tilted." }),
  base({ name: "Conte", category: "pencil", size: 12, minSizeRatio: 0.6, opacity: 1, flow: 0.8, flowByPressure: true, minFlowRatio: 0.3, hardness: 0.8, spacing: 0.08, tipShape: "flat", tipAngleDeg: 30, tipRatio: 0.45, grain: 0.55, grainScale: 10, sizeNoise: 0.2, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Conte crayon: dense, waxy, flat-edged stick with a hard tooth texture." }),
  base({ name: "Pencil 2B", category: "pencil", size: 7, minSizeRatio: 0.35, opacity: 0.85, flow: 0.55, flowByPressure: true, minFlowRatio: 0.15, hardness: 0.55, spacing: 0.12, grain: 0.75, grainScale: 18, tiltShape: true, tiltSize: 0.8, tiltFlow: 0.5, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Soft graphite. Tip for lines, lay it flat (tilt) for wide, lighter shading that shows the paper tooth." }),
  base({ name: "Pencil HB", category: "pencil", size: 4, minSizeRatio: 0.5, opacity: 0.7, flow: 0.4, flowByPressure: true, minFlowRatio: 0.2, hardness: 0.7, spacing: 0.12, grain: 0.6, grainScale: 14, tiltSize: 0.5, tiltFlow: 0.4, curve: [0.4, 0.3, 0.7, 0.8],
    description: "Medium graphite. Clean roughs and construction lines; builds slowly so it erases well." }),
  base({ name: "Pencil 6B", category: "pencil", size: 12, minSizeRatio: 0.3, opacity: 0.95, flow: 0.7, flowByPressure: true, minFlowRatio: 0.1, hardness: 0.4, spacing: 0.1, grain: 0.85, grainScale: 22, tiltShape: true, tiltSize: 1, tiltFlow: 0.6, curve: [0.5, 0.15, 0.75, 0.9],
    description: "Very soft graphite. Dark, smeary, grain-heavy. Blocking shadows and gesture." }),
  base({ name: "Col-erase Blue", category: "pencil", size: 5, minSizeRatio: 0.4, opacity: 0.6, flow: 0.35, flowByPressure: true, minFlowRatio: 0.2, hardness: 0.65, spacing: 0.12, grain: 0.7, grainScale: 12, blend: "multiply", curve: [0.4, 0.25, 0.7, 0.85],
    description: "Non-photo blue layout pencil. Multiply blend so ink reads over it; drop it before export." }),
  base({ name: "Mechanical 0.5", category: "pencil", size: 2.5, minSizeRatio: 0.7, opacity: 0.8, flow: 0.5, flowByPressure: true, minFlowRatio: 0.3, hardness: 0.85, spacing: 0.1, grain: 0.35, grainScale: 8, stabilizer: 3, curve: [0.4, 0.3, 0.7, 0.85],
    description: "Fine lead. Thin, consistent, slight tooth. Clean-up and tight detail." }),

  // ---- PAINT: flow, mixing, wet behaviour ----
  base({ name: "Marker Chisel", category: "paint", size: 34, minSizeRatio: 0.95, sizeByPressure: false, opacity: 0.6, flow: 1, hardness: 1, spacing: 0.06, tipShape: "flat", tipAngleDeg: 45, tipRatio: 0.28, blend: "multiply", curve: [0.33, 0.33, 0.66, 0.66],
    description: "Alcohol marker. Flat chisel tip, so thin on one axis and wide on the other; overlapping strokes darken, one stroke never does." }),
  base({ name: "Highlighter", category: "paint", size: 30, minSizeRatio: 1, sizeByPressure: false, opacity: 0.35, flow: 1, hardness: 1, spacing: 0.05, tipShape: "flat", tipAngleDeg: 90, tipRatio: 0.22, blend: "multiply", curve: [0.33, 0.33, 0.66, 0.66],
    description: "Highlighter: translucent chisel in multiply; overlaps darken, never opaque." }),
  base({ name: "Real Marker", category: "paint", size: 26, minSizeRatio: 0.9, sizeByPressure: false, opacity: 0.8, flow: 1, hardness: 0.92, spacing: 0.05, tipShape: "flat", tipAngleDeg: 60, tipRatio: 0.5, blend: "multiply", flowNoise: 0.15, grain: 0.25, grainScale: 7, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Alcohol marker: bullet-chisel, streaky second pass, bleeds dark where strokes overlap." }),
  base({ name: "Oil Brushy", category: "paint", size: 48, minSizeRatio: 0.7, opacity: 1, flow: 0.95, hardness: 0.9, spacing: 0.04, tipShape: "bristle", bristles: 34, bristleSpread: 1.0, mix: 0.45, pooling: 0.2, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Loaded oil brush: visible bristle streaks, drags and mixes the paint already on the layer." }),
  base({ name: "Oil Smooth", category: "paint", size: 40, minSizeRatio: 0.5, opacity: 1, flow: 1, hardness: 0.85, spacing: 0.06, mix: 0.3, wetEdge: 0.05, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Buttery oil round: opaque, soft-edged, blends into neighbours. Covers and high-contrast work." }),
  base({ name: "Watercolor Edge", category: "paint", size: 60, minSizeRatio: 0.7, opacity: 0.45, flow: 0.6, hardness: 0.3, spacing: 0.12, wetEdge: 0.6, mix: 0.25, flowNoise: 0.2, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Watercolor with a dark drying edge: soft centre, pigment settles at the rim. Romance-genre washes." }),
  base({ name: "Marker Brush", category: "paint", size: 20, minSizeRatio: 0.2, opacity: 0.55, flow: 1, hardness: 0.95, spacing: 0.07, blend: "multiply", velocityThin: 0.2, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Brush-tip marker. Pressure-sized, translucent layering for flats and cel shadows." }),
  base({ name: "Round Paint", category: "paint", size: 40, minSizeRatio: 0.3, opacity: 1, flow: 0.8, flowByPressure: true, hardness: 0.8, hardnessByPressure: 0.6, spacing: 0.1, mix: 0.25, inkLoad: 2400, inkMin: 0.5, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Round acrylic. Opaque, with a little wet mixing: it drags the colour already on the layer." }),
  base({ name: "Oil Flat", category: "paint", size: 44, minSizeRatio: 0.6, opacity: 1, flow: 0.9, flowByPressure: true, minFlowRatio: 0.4, hardness: 1, spacing: 0.05, tipShape: "bristle", bristles: 24, bristleSpread: 1, mix: 0.55, tiltShape: true, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Flat hog bristle. Streaky bristle marks, heavy mixing with what is underneath, follows stroke direction." }),
  base({ name: "Gouache", category: "paint", size: 30, minSizeRatio: 0.7, opacity: 1, flow: 0.95, hardness: 0.9, spacing: 0.08, mix: 0.1, grain: 0.15, grainScale: 30, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Opaque matte paint. Covers in one pass, faint paper texture, barely mixes." }),
  base({ name: "Watercolor", category: "paint", size: 70, minSizeRatio: 0.6, opacity: 0.55, flow: 0.12, flowByPressure: true, minFlowRatio: 0.3, hardness: 0.15, spacing: 0.16, grain: 0.35, grainScale: 40, wetEdge: 0.85, blend: "multiply", curve: [0.3, 0.4, 0.6, 0.9],
    description: "Wet wash. Pigment pools at the edge of every dab (wet edge), multiply layering, granulation in the paper." }),
  base({ name: "Ink Wash", category: "paint", size: 60, minSizeRatio: 0.5, opacity: 0.4, flow: 0.2, flowByPressure: true, minFlowRatio: 0.2, hardness: 0.3, spacing: 0.14, wetEdge: 0.5, blend: "multiply", curve: [0.35, 0.3, 0.65, 0.9],
    description: "Diluted sumi. Soft grey washes that build in layers; pressure deepens the tone." }),
  base({ name: "Mixer", category: "paint", size: 36, minSizeRatio: 0.6, opacity: 1, flow: 0.6, flowByPressure: true, hardness: 0.6, spacing: 0.1, mix: 0.95, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Mixer brush. Almost no pigment of its own: blends the colours already on the layer into soft gradients." }),

  // ---- AIR ----
  base({ name: "Airbrush", category: "air", size: 120, minSizeRatio: 0.7, opacity: 1, flow: 0.08, flowByPressure: true, minFlowRatio: 0.1, hardness: 0.02, spacing: 0.15, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Soft airbrush. Very low flow so tone builds over passes; pressure is the trigger." }),
  base({ name: "Airbrush Square", category: "air", size: 110, minSizeRatio: 0.8, opacity: 1, flow: 0.1, flowByPressure: true, minFlowRatio: 0.1, hardness: 0.75, spacing: 0.1, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.6, tipFollow: true, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Square-nozzle airbrush: a soft rectangular band that follows the stroke; flat gradients across panels." }),
  base({ name: "Airbrush Raw", category: "air", size: 100, minSizeRatio: 0.7, opacity: 1, flow: 0.12, flowByPressure: true, minFlowRatio: 0.1, hardness: 0.1, spacing: 0.12, grain: 0.5, grainScale: 20, flowNoise: 0.4, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Grainy airbrush: the same soft build-up with a speckled, raw deposit." }),
  base({ name: "Spray", category: "air", size: 90, minSizeRatio: 0.6, opacity: 1, flow: 0.9, hardness: 1, spacing: 0.2, scatter: 1, scatterCount: 22, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Spatter can. Hard droplets scattered inside the cone; pressure adds droplets." }),
  base({ name: "Stipple", category: "air", size: 40, minSizeRatio: 0.5, opacity: 1, flow: 1, hardness: 1, spacing: 0.3, scatter: 1, scatterCount: 6, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Dot shading. A few hard dots per dab for pointillist tone." }),

  // ---- FX: move or soften what is there ----
  base({ name: "Smudge", category: "fx", kind: "smudge", size: 36, minSizeRatio: 0.6, hardness: 0.5, spacing: 0.12, smudgeStrength: 0.75, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Finger smudge. Drags the pixels under the tip along the stroke; pressure sets how much comes along." }),
  base({ name: "Blur", category: "fx", kind: "blur", size: 48, minSizeRatio: 0.6, hardness: 0.3, spacing: 0.2, smudgeStrength: 0.6, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Local soften. Blurs only under the tip; strength is the blur radius." }),

  // ---- WATERCOLOR: every dab is water + pigment in the wet simulation (engine/media.ts). Washes keep moving until they dry. ----
  base({ name: "Flat Wash", category: "water", media: "water", size: 120, minSizeRatio: 0.85, flow: 0.9, hardness: 0.6, spacing: 0.08, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.45, tipFollow: true, wet: { water: 0.8, pigment: 0.4, diffusion: 0.55, edgeDark: 0.35, granulation: 0.2, bloom: 0.25, dryTime: 8 }, curve: [0.4, 0.3, 0.7, 0.9],
    description: "Big loaded flat. Lay overlapping passes while the paper is wet for an even sheet of colour; the edge darkens only where you let it dry." }),
  base({ name: "Graded Wash", category: "water", media: "water", size: 110, minSizeRatio: 0.8, flow: 0.9, flowByPressure: true, minFlowRatio: 0.05, hardness: 0.6, spacing: 0.08, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.45, tipFollow: true, inkLoad: 900, inkMin: 0.05, wet: { water: 0.85, pigment: 0.5, diffusion: 0.6, edgeDark: 0.3, bloom: 0.2, dryTime: 8 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Pigment runs out along the stroke (reservoir) and with lighter pressure, so one long pass fades from dark to clear." }),
  base({ name: "Wet-in-Wet", category: "water", media: "water", size: 90, minSizeRatio: 0.6, flow: 0.8, hardness: 0.3, spacing: 0.12, wet: { water: 0.95, pigment: 0.55, diffusion: 0.95, edgeDark: 0.25, granulation: 0.35, bloom: 0.5, dryTime: 10 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Very wet round. Colour dropped into a wet area spreads and feathers; drop a second colour in and they bleed together." }),
  base({ name: "Wet-on-Dry", category: "water", media: "water", size: 60, minSizeRatio: 0.3, flow: 0.9, hardness: 0.85, spacing: 0.08, velocityThin: 0.2, wet: { water: 0.35, pigment: 0.7, diffusion: 0.2, edgeDark: 0.85, granulation: 0.25, bloom: 0.2, dryTime: 4 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Less water, more pigment: a crisp hard-edged shape with a strong dark rim as it dries." }),
  base({ name: "Round Sable", category: "water", media: "water", size: 44, minSizeRatio: 0.08, flow: 0.9, hardness: 0.8, spacing: 0.07, velocityThin: 0.35, taper: 18, stabilizer: 4, wet: { water: 0.5, pigment: 0.65, diffusion: 0.35, edgeDark: 0.6, granulation: 0.25, bloom: 0.3, dryTime: 5 }, curve: [0.5, 0.1, 0.75, 0.9],
    description: "Pointed round with a fine tip and a full belly: lines under light pressure, shapes under heavy. The everyday watercolour brush." }),
  base({ name: "Detail Rigger", category: "water", media: "water", size: 9, minSizeRatio: 0.15, flow: 1, hardness: 0.95, spacing: 0.06, velocityThin: 0.2, taper: 10, stabilizer: 5, wet: { water: 0.2, pigment: 0.9, diffusion: 0.05, edgeDark: 0.4, granulation: 0, bloom: 0.05, dryTime: 2.5 }, curve: [0.45, 0.15, 0.75, 0.9],
    description: "Thin, nearly dry line for branches, rigging and final details; barely spreads." }),
  base({ name: "Glaze", category: "water", media: "water", size: 100, minSizeRatio: 0.8, flow: 0.6, hardness: 0.5, spacing: 0.1, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.5, tipFollow: true, wet: { water: 0.45, pigment: 0.22, diffusion: 0.3, edgeDark: 0.2, granulation: 0.1, bloom: 0.1, dryTime: 5 }, curve: [0.4, 0.3, 0.7, 0.9],
    description: "Thin transparent layer over a DRY wash: the colours multiply instead of mixing, so a yellow glaze over blue reads green." }),
  base({ name: "Dry Brush (WC)", category: "water", media: "water", size: 50, minSizeRatio: 0.5, flow: 0.8, flowByPressure: true, minFlowRatio: 0.3, hardness: 0.9, spacing: 0.05, tipShape: "bristle", bristles: 26, bristleSpread: 0.95, wet: { water: 0.08, pigment: 0.8, diffusion: 0, edgeDark: 0.1, granulation: 0.9, bloom: 0, dryTime: 1.5 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Almost no water: pigment catches the tops of the paper tooth and skips the valleys. Drag fast and light for sparkle on water or bark." }),
  base({ name: "Scumble (WC)", category: "water", media: "water", size: 40, minSizeRatio: 0.6, flow: 0.7, hardness: 0.7, spacing: 0.2, jitter: 0.6, sizeNoise: 0.4, flowNoise: 0.5, wet: { water: 0.12, pigment: 0.6, diffusion: 0.05, edgeDark: 0.2, granulation: 0.7, bloom: 0, dryTime: 2 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Scrubbing, circular broken marks with a fairly dry brush: foliage, texture, worn surfaces." }),
  base({ name: "Water Only", category: "water", media: "water", size: 80, minSizeRatio: 0.6, flow: 1, hardness: 0.4, spacing: 0.1, wet: { water: 0.9, pigment: 0, diffusion: 0.8, edgeDark: 0.4, granulation: 0, bloom: 0.6, dryTime: 9 }, curve: [0.4, 0.3, 0.7, 0.9],
    description: "Clear water. Pre-wet the paper for wet-in-wet, soften a hard edge (feather out), or drop it onto a half-dry wash for a bloom." }),
  base({ name: "Lift Out", category: "water", media: "water", size: 60, minSizeRatio: 0.5, flow: 1, flowByPressure: true, minFlowRatio: 0.3, hardness: 0.5, spacing: 0.1, wet: { water: 0.15, pigment: 0, diffusion: 0.1, edgeDark: 0.1, granulation: 0, bloom: 0, lift: 0.9, dryTime: 3 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Thirsty damp brush: pulls pigment back out of a wet wash for highlights, clouds and corrections. Does nothing on dry paint." }),
  base({ name: "Wipe Out", category: "water", media: "water", size: 140, minSizeRatio: 0.9, flow: 1, hardness: 0.3, spacing: 0.1, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.3, tipFollow: true, wet: { water: 0.1, pigment: 0, diffusion: 0, edgeDark: 0, granulation: 0, bloom: 0, lift: 1, dryTime: 2 }, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Paper towel: wipes a wide band of wet colour away in one pass (skies, soft light)." }),
  base({ name: "Pushing Pigment", category: "water", media: "water", size: 50, minSizeRatio: 0.5, flow: 1, hardness: 0.9, spacing: 0.06, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.35, tipFollow: true, wet: { water: 0.3, pigment: 0.05, diffusion: 0.5, edgeDark: 1, granulation: 0.1, bloom: 0, lift: 0.35, dryTime: 4 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Stiff damp flat that shoves wet pigment ahead of it: lifts where it passes and piles a dark edge where it stops." }),
  base({ name: "Granulating", category: "water", media: "water", size: 70, minSizeRatio: 0.7, flow: 0.9, hardness: 0.5, spacing: 0.1, wet: { water: 0.7, pigment: 0.6, diffusion: 0.45, edgeDark: 0.5, granulation: 1, bloom: 0.35, dryTime: 7 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Heavy mineral pigment (ultramarine, burnt sienna): settles into the paper valleys for a speckled, stony wash." }),
  base({ name: "Salt", category: "water", media: "water", size: 90, minSizeRatio: 0.9, flow: 1, hardness: 1, spacing: 0.5, wetEffect: "salt", wet: { dryTime: 4 }, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Sprinkle salt onto a damp wash: each grain drinks the pigment around it and leaves a pale star. Only works while the wash is wet." }),
  base({ name: "Rubbing Alcohol", category: "water", media: "water", size: 70, minSizeRatio: 0.9, flow: 1, hardness: 1, spacing: 0.6, wetEffect: "alcohol", wet: { dryTime: 4 }, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Drops of alcohol push wet pigment outward into pale rings with a dark rim (cells, bubbles, foam)." }),
  base({ name: "Sandpaper", category: "water", media: "water", size: 60, minSizeRatio: 0.8, flow: 1, hardness: 1, spacing: 0.3, wetEffect: "sand", wet: { dryTime: 2 }, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Scrapes pigment off the high points of the paper tooth: sparkle on water, rough stone, weathered wood." }),
  base({ name: "Splatter (WC)", category: "water", media: "water", size: 140, minSizeRatio: 0.7, flow: 0.9, hardness: 1, spacing: 0.4, jitter: 1, sizeNoise: 0.7, wet: { water: 0.7, pigment: 0.7, diffusion: 0.3, edgeDark: 0.6, granulation: 0.2, bloom: 0.8, dryTime: 5 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Flicked droplets. On dry paper they stay crisp; on a damp wash each one blooms into a soft star." }),
  base({ name: "Wet Sponge", category: "water", media: "water", size: 120, minSizeRatio: 0.8, flow: 1, hardness: 1, spacing: 0.35, tipShape: "sponge", spongeKind: "natural", spinTip: true, wet: { water: 0.6, pigment: 0.5, diffusion: 0.4, edgeDark: 0.5, granulation: 0.3, bloom: 0.4, dryTime: 6 }, curve: [0.4, 0.3, 0.7, 0.9],
    description: "Natural sponge dipped in a wash: cellular dabs that bleed into each other while wet. Dab, do not drag." }),

  // ---- ACRYLIC: opaque paint with body. Height builds under each dab and is lit at the end of the stroke. ----
  base({ name: "Acrylic Round", category: "acrylic", media: "acrylic", size: 36, minSizeRatio: 0.3, opacity: 1, flow: 0.95, flowByPressure: true, minFlowRatio: 0.5, hardness: 0.85, spacing: 0.08, mix: 0.35, mixOpen: true, body: { body: 0.35, open: 25, relief: 0.5, gloss: 0.25 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Soft round, creamy coverage. Mixes with paint laid in the last half minute, then sits on top once that has set." }),
  base({ name: "Acrylic Flat Bristle", category: "acrylic", media: "acrylic", size: 54, minSizeRatio: 0.65, opacity: 1, flow: 0.95, flowByPressure: true, minFlowRatio: 0.5, hardness: 0.9, spacing: 0.04, tipShape: "bristle", bristles: 48, bristleSpread: 0.95, sizeNoise: 0.08, mix: 0.45, mixOpen: true, body: { body: 0.6, open: 25, relief: 0.7, gloss: 0.3 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Hog-bristle flat: visible bristle ridges run along the stroke and catch the light. The workhorse for blocking in." }),
  base({ name: "Acrylic Dry Brush", category: "acrylic", media: "acrylic", size: 48, minSizeRatio: 0.6, opacity: 1, flow: 0.5, flowByPressure: true, minFlowRatio: 0.15, hardness: 0.95, spacing: 0.04, tipShape: "bristle", bristles: 26, bristleSpread: 1, grain: 0.9, grainScale: 7, inkLoad: 700, inkMin: 0.1, body: { body: 0.12, open: 10, relief: 0.4, gloss: 0 }, curve: [0.45, 0.1, 0.7, 0.9],
    description: "Little paint, stiff bristles: deposit breaks over the canvas weave and runs out along the stroke. Light pressure for grass, hair, texture." }),
  base({ name: "Scumble", category: "acrylic", media: "acrylic", size: 44, minSizeRatio: 0.7, opacity: 0.85, flow: 0.4, flowByPressure: true, minFlowRatio: 0.2, hardness: 0.7, spacing: 0.18, jitter: 0.5, sizeNoise: 0.45, flowNoise: 0.6, grain: 0.6, grainScale: 9, body: { body: 0.1, open: 10, relief: 0.3, gloss: 0 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Broken, scrubbed layer of a lighter colour over a dry darker one; the underlayer shows through the gaps." }),
  base({ name: "Acrylic Glaze", category: "acrylic", media: "acrylic", size: 90, minSizeRatio: 0.8, opacity: 0.35, flow: 0.9, hardness: 0.5, spacing: 0.1, blend: "multiply", body: { body: 0, open: 0, relief: 0, gloss: 0 }, curve: [0.4, 0.3, 0.7, 0.9],
    description: "Thin transparent film (paint + glazing medium) that tints what is beneath without covering it." }),
  base({ name: "Blend Soft", category: "acrylic", media: "acrylic", size: 60, minSizeRatio: 0.7, opacity: 1, flow: 0.6, flowByPressure: true, hardness: 0.3, spacing: 0.1, mix: 0.9, mixOpen: false, body: { body: 0.05, open: 10, relief: 0.2, gloss: 0 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Soft blender: pulls neighbouring colours into each other for smooth gradients and shaded spheres. Work fast; acrylic sets." }),
  base({ name: "Impasto Knife", category: "acrylic", media: "acrylic", size: 70, minSizeRatio: 0.9, opacity: 1, flow: 1, hardness: 1, spacing: 0.04, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.16, tipFollow: true, mix: 0.6, mixOpen: true, scrape: true, body: { body: 1, open: 40, relief: 1, gloss: 0.5 }, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Palette knife loaded with thick paint: a flat ribbon with a sharp raised edge, a highlight on the ridge and a shadow behind it. Dragging through wet paint streaks the colours." }),
  base({ name: "Knife Edge", category: "acrylic", media: "acrylic", size: 40, minSizeRatio: 0.9, opacity: 1, flow: 1, hardness: 1, spacing: 0.04, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.06, tipFollow: true, mix: 0.2, scrape: true, body: { body: 0.8, open: 40, relief: 1, gloss: 0.6 }, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Side of the knife: hairline ridges of paint for grass, masts, cracks, branches." }),
  base({ name: "Modelling Paste", category: "acrylic", media: "acrylic", size: 90, minSizeRatio: 0.9, opacity: 1, flow: 1, hardness: 0.9, spacing: 0.06, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.3, tipFollow: true, sizeNoise: 0.2, body: { body: 1, open: 60, relief: 1, gloss: 0.1 }, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Heavy matte paste spread with a knife: pure sculpted relief, dull surface, deep shadows. Paint over it once it is down." }),
  base({ name: "Gel Medium", category: "acrylic", media: "acrylic", size: 70, minSizeRatio: 0.9, opacity: 0.18, flow: 1, hardness: 0.8, spacing: 0.06, tipShape: "flat", tipAngleDeg: 0, tipRatio: 0.3, tipFollow: true, body: { body: 0.9, open: 60, relief: 0.9, gloss: 1 }, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Clear glossy gel: almost no colour, lots of body and a wet-looking specular highlight on every ridge." }),
  base({ name: "Sgraffito", category: "acrylic", media: "acrylic", kind: "eraser", size: 6, minSizeRatio: 0.6, flow: 0.9, hardness: 1, spacing: 0.08, scrape: true, body: { body: 0, open: 0, relief: 0, gloss: 0 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Scratch through the top layer with the end of the brush to reveal the colour underneath (use on a layer over the base colour)." }),
  base({ name: "Oil Pastel", category: "acrylic", media: "acrylic", size: 16, minSizeRatio: 0.7, opacity: 1, flow: 0.85, flowByPressure: true, minFlowRatio: 0.4, hardness: 0.75, spacing: 0.08, grain: 0.55, grainScale: 8, sizeNoise: 0.15, mix: 0.3, mixOpen: false, body: { body: 0.3, open: 600, relief: 0.4, gloss: 0.35 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Waxy stick: dense colour that skips the canvas weave and smears into the stroke before it. Never fully sets." }),
  base({ name: "Paint Pen", category: "acrylic", media: "acrylic", size: 5, minSizeRatio: 0.95, sizeByPressure: false, opacity: 1, flow: 1, hardness: 1, spacing: 0.08, stabilizer: 4, body: { body: 0.15, open: 5, relief: 0.3, gloss: 0.5 }, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Acrylic marker: uniform opaque line with a slight glossy bead, for outlines, dots and lettering on top of dry paint." }),
  base({ name: "Acrylic Splatter", category: "acrylic", media: "acrylic", size: 120, minSizeRatio: 0.7, opacity: 1, flow: 1, hardness: 1, spacing: 0.3, scatter: 1, scatterCount: 18, body: { body: 0.3, open: 5, relief: 0.5, gloss: 0.4 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Flicked thin paint: opaque dots of random size that sit as tiny beads." }),
  base({ name: "Drips", category: "acrylic", media: "acrylic", size: 14, minSizeRatio: 0.5, opacity: 1, flow: 1, hardness: 0.9, spacing: 0.06, pooling: 1.2, sizeNoise: 0.15, body: { body: 0.5, open: 20, relief: 0.6, gloss: 0.6 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Runny paint: the line swells wherever you slow down or stop, like a drip pooling at the bottom of a run. Pull straight down." }),
  base({ name: "Stencil Dab", category: "acrylic", media: "acrylic", size: 70, minSizeRatio: 0.8, opacity: 1, flow: 0.7, flowByPressure: true, minFlowRatio: 0.3, hardness: 1, spacing: 0.3, tipShape: "sponge", spongeKind: "stipple", spinTip: true, body: { body: 0.15, open: 5, relief: 0.35, gloss: 0.1 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Stencil sponge: pounce straight down inside a selection (the mask) for an even stippled fill." }),

  // ---- SPONGE: cellular natural-sponge masks stamped at random spin. ----
  base({ name: "Natural Sponge", category: "sponge", media: "acrylic", size: 110, minSizeRatio: 0.85, opacity: 1, flow: 0.85, flowByPressure: true, minFlowRatio: 0.3, hardness: 1, spacing: 0.4, tipShape: "sponge", spongeKind: "natural", spinTip: true, body: { body: 0.25, open: 15, relief: 0.45, gloss: 0.15 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Natural sponge with acrylic: open cellular dabs, each at a new angle. Build foliage and texture by overlapping lighter and darker passes." }),
  base({ name: "Sea Sponge", category: "sponge", media: "acrylic", size: 150, minSizeRatio: 0.9, opacity: 1, flow: 0.8, flowByPressure: true, minFlowRatio: 0.3, hardness: 1, spacing: 0.5, tipShape: "sponge", spongeKind: "sea", spinTip: true, body: { body: 0.3, open: 15, relief: 0.5, gloss: 0.15 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Large sea sponge: big open holes and thick walls, for skies, rock faces and faux-finish walls." }),
  base({ name: "Sponge Stipple", category: "sponge", media: "acrylic", size: 60, minSizeRatio: 0.8, opacity: 1, flow: 0.9, flowByPressure: true, minFlowRatio: 0.3, hardness: 1, spacing: 0.3, tipShape: "sponge", spongeKind: "stipple", spinTip: true, body: { body: 0.15, open: 10, relief: 0.35, gloss: 0.1 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Fine dense dots from a tight synthetic sponge: soft gradients when pounced, clouds, distant foliage." }),
  base({ name: "Synthetic Sponge", category: "sponge", media: "acrylic", size: 90, minSizeRatio: 0.9, opacity: 1, flow: 0.9, flowByPressure: true, minFlowRatio: 0.4, hardness: 1, spacing: 0.25, tipShape: "sponge", spongeKind: "synthetic", spinTip: false, tipImageFollow: false, body: { body: 0.2, open: 10, relief: 0.4, gloss: 0.1 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Kitchen sponge, regular pores, no spin: dragged for an even dotted band, dabbed for a block." }),
  base({ name: "Sponge Wash", category: "sponge", media: "water", size: 130, minSizeRatio: 0.9, flow: 1, hardness: 1, spacing: 0.4, tipShape: "sponge", spongeKind: "sea", spinTip: true, wet: { water: 0.7, pigment: 0.45, diffusion: 0.5, edgeDark: 0.45, granulation: 0.35, bloom: 0.45, dryTime: 6 }, curve: [0.4, 0.3, 0.7, 0.9],
    description: "Sea sponge in watercolour: the cell pattern bleeds and softens while the wash is wet, then dries with a rim." }),
  base({ name: "Sponge Lift", category: "sponge", media: "water", size: 100, minSizeRatio: 0.9, flow: 1, hardness: 1, spacing: 0.35, tipShape: "sponge", spongeKind: "natural", spinTip: true, wet: { water: 0.1, pigment: 0, diffusion: 0, edgeDark: 0, granulation: 0, bloom: 0, lift: 0.8, dryTime: 2 }, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Damp clean sponge pressed into a wet wash: lifts pigment out in a cellular pattern (clouds, foam, texture)." }),
  base({ name: "Sponge Eraser", category: "sponge", kind: "eraser", size: 90, minSizeRatio: 0.8, flow: 0.8, flowByPressure: true, hardness: 1, spacing: 0.35, tipShape: "sponge", spongeKind: "natural", spinTip: true, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Magic eraser: removes paint in a sponge pattern on any layer." }),

  // ---- ERASE ----
  base({ name: "Eraser Hard", category: "erase", kind: "eraser", size: 30, minSizeRatio: 0.4, hardness: 0.95, spacing: 0.1, curve: [0.33, 0.33, 0.66, 0.66],
    description: "Clean removal with a crisp edge." }),
  base({ name: "Eraser Soft", category: "erase", kind: "eraser", size: 80, minSizeRatio: 0.6, flow: 0.3, flowByPressure: true, hardness: 0.1, spacing: 0.15, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Feathered removal for fading edges and lightening." }),
  base({ name: "Kneaded", category: "erase", kind: "eraser", size: 40, minSizeRatio: 0.5, flow: 0.18, flowByPressure: true, minFlowRatio: 0.3, hardness: 0.35, spacing: 0.14, grain: 0.4, grainScale: 20, curve: [0.4, 0.2, 0.7, 0.9],
    description: "Lifts graphite gradually and unevenly, like a putty eraser on pencil." }),
];

/** Evaluate the pressure curve (cubic Bézier, solve x by bisection). */
export function pressureCurve(p: number, c: BrushPreset["curve"]): number {
  const [x1, y1, x2, y2] = c;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (bx(mid) < p) lo = mid; else hi = mid; }
  return Math.max(0, Math.min(1, by((lo + hi) / 2)));
}

class LowPass {
  private v = 0; private init = false;
  reset(): void { this.init = false; }
  filter(x: number, a: number): number { if (!this.init) { this.v = x; this.init = true; return x; } this.v = a * x + (1 - a) * this.v; return this.v; }
  get last(): number { return this.v; }
  get ready(): boolean { return this.init; }
}

export class OneEuro {
  private x = new LowPass(); private dx = new LowPass();
  private lastT = 0; private lastRaw = 0; private hasRaw = false;
  velocity = 0;
  constructor(private minCutoff = 1.0, private beta = 50, private dCutoff = 1.0) {}
  reset(): void { this.x.reset(); this.dx.reset(); this.hasRaw = false; this.lastT = 0; }
  private static alpha(cutoff: number, dt: number): number { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v: number, tSec: number): number {
    let dt = this.x.ready && tSec > this.lastT ? tSec - this.lastT : 1 / 240;
    dt = Math.max(1 / 1000, Math.min(1 / 30, dt)); // guard identical/far timestamps
    this.lastT = tSec;
    const rawD = this.hasRaw ? (v - this.lastRaw) / dt : 0;
    this.lastRaw = v; this.hasRaw = true;
    const d = this.dx.filter(rawD, OneEuro.alpha(this.dCutoff, dt));
    this.velocity = d;
    return this.x.filter(v, OneEuro.alpha(this.minCutoff + this.beta * Math.abs(d), dt));
  }
}

export interface StrokeSample { x: number; y: number; pressure: number; tiltX: number; tiltY: number; tMs: number }
export interface DirtyRect { x0: number; y0: number; x1: number; y1: number }
export const emptyRect = (): DirtyRect => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

// ---- paper grain: tileable value noise, generated once per scale ----
const grainCache = new Map<number, OffscreenCanvas | HTMLCanvasElement>();
export function grainTexture(scaleDU: number): OffscreenCanvas | HTMLCanvasElement {
  const key = Math.round(scaleDU);
  const hit = grainCache.get(key); if (hit) return hit;
  const N = 256;
  const c = makeCanvas(N, N);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  const img = ctx.createImageData(N, N); const d = img.data;
  const cells = Math.max(2, Math.round(N / Math.max(2, key)));
  const grid = new Float32Array((cells + 1) * (cells + 1));
  let seed = 1234567 + key; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const g = (x: number, y: number) => grid[((y % cells) + cells) % cells * (cells + 1) + (((x % cells) + cells) % cells)]!;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x / N) * cells, v = (y / N) * cells; const x0 = Math.floor(u), y0 = Math.floor(v);
    const fx = u - x0, fy = v - y0; const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const n = (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
    // fine speckle for tooth (integer hash, no visible lattice)
    let hsh = (x * 374761393 + y * 668265263 + key * 2246822519) | 0; hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177); const sp = ((hsh ^ (hsh >>> 16)) >>> 0) / 4294967295;
    const height = Math.min(1, Math.max(0, 0.5 + 1.1 * (n - 0.5) + 0.45 * (sp - 0.5)));
    const valley = 1 - height; // alpha = how much ink the paper valley rejects
    const i = (y * N + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = Math.round(valley * 255);
  }
  ctx.putImageData(img, 0, 0);
  grainCache.set(key, c);
  return c;
}

export interface StrokeContext {
  /** page size in DU; dabs entirely outside it are dropped so no tiles exist off-page */
  pageWidth?: number;
  pageHeight?: number;
  /**
   * exact: samples are taken as given (no position smoothing, no pressure low-pass). For strokes
   * whose path and width are already known, e.g. the Redraw tool replaying traced centre lines.
   */
  exact?: boolean;
  /** tip bitmaps shared between engines (many short strokes with one brush) */
  sharedTips?: Map<string, OffscreenCanvas | HTMLCanvasElement>;
  /** called before the first write to a layer tile in this stroke (undo capture) */
  beforeTileWrite?: (layer: Layer, tx: number, ty: number) => void;
  preset: BrushPreset;
  color: string;
  layer: Layer;
  docScale: number; // doc.width / 2480
  /** composite of the drawing under the active layer, for smudge sampling (optional) */
  sampleSource?: Layer[];
  /** active selection: paint/erase are clipped to it, smudge/blur dabs outside it are skipped */
  clip?: import("./selection.js").Selection | null;
  /** wasm brush core: round, grain-free tips are rasterised there and blitted per tile */
  wasm?: import("./wasm-brush.js").WasmBrush | null;
}

export class StrokeEngine {
  readonly preset: BrushPreset;
  readonly color: string;
  readonly layer: Layer;
  /** Temporary layer the stroke is painted into (paint/eraser kinds). */
  readonly buffer: Layer | null;
  private beforeWrite: ((layer: Layer, tx: number, ty: number) => void) | undefined;
  private clip: import("./selection.js").Selection | null = null;
  private touched = new Set<Tile>();
  private wasm: import("./wasm-brush.js").WasmBrush | null = null;
  private dualTmp: OffscreenCanvas | HTMLCanvasElement | null = null;
  private peakP = 0;
  private wasmSlots = new Map<Tile, number>();
  private wasmDirty = new Set<Tile>();
  wasmDabs = 0;
  private pageW = Infinity; private pageH = Infinity;
  private pts: Array<{ x: number; y: number; p: number; tx: number; ty: number; v: number }> = [];
  private fx: OneEuro; private fy: OneEuro;
  private pFilt = new LowPass();
  private carry = 0;
  private tipCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();
  private exact = false;
  private dabTmp: OffscreenCanvas | HTMLCanvasElement | null = null;
  private maskTmp: OffscreenCanvas | HTMLCanvasElement | null = null;
  private smudgeSrc: OffscreenCanvas | HTMLCanvasElement | null = null;
  private lastSmudge: { x: number; y: number } | null = null;
  private seed = 17;
  /** natural media state (engine/media.ts) */
  private wet: WetField | null = null;
  private body: BodyField | null = null;
  readonly wetParams: WetParams;
  readonly bodyParams: BodyParams;
  private fp: Footprint = DISC;
  private lastPresent = 0;
  private arc = 0; // distance travelled along the stroke (DU)
  /** dabs held back for the exit taper (rendered once the stroke has moved on by `taper` DU) */
  private pending: Array<{ x: number; y: number; s: { p: number; tx: number; ty: number; v: number; arc: number }; dir: number }> = [];
  dirty: DirtyRect = emptyRect();
  /** last effective pressure after the curve, for the UI meter */
  strength = 0;
  dabCount = 0;

  constructor(ctx: StrokeContext) {
    this.exact = !!ctx.exact; if (ctx.sharedTips) this.tipCache = ctx.sharedTips;
    this.preset = ctx.preset; this.color = ctx.color; this.layer = ctx.layer; this.beforeWrite = ctx.beforeTileWrite; this.clip = ctx.clip ?? null; this.wasm = ctx.wasm ?? null; if (this.wasm) this.wasm.reset();
    if (ctx.pageWidth) this.pageW = ctx.pageWidth; if (ctx.pageHeight) this.pageH = ctx.pageHeight;
    const minCut = 3 - 2.6 * this.preset.smoothing;
    this.fx = new OneEuro(minCut, 50 / ctx.docScale); this.fy = new OneEuro(minCut, 50 / ctx.docScale);
    this.buffer = this.preset.kind === "smudge" ? null : new Layer("stroke", "raster");
    if (this.buffer) this.buffer.transient = true;
    this.wetParams = { ...WET_DEFAULT, ...this.preset.wet }; this.bodyParams = { ...BODY_DEFAULT, ...this.preset.body };
    if (this.preset.tipShape === "sponge") this.fp = spongeFootprint(this.preset.spongeKind, 7);
    else if (this.preset.media === "water" && this.preset.tipShape !== "round") this.fp = canvasFootprint(this.tip(40, "#000000", 1, this.preset.tipShape, this.preset.tipImage));
    if (this.preset.media === "water") { this.wet = wetField(this.layer, true); this.wet.beforeWrite = this.beforeWrite ?? null; this.wet.params = this.wetParams; if (!this.wet.cells.size) this.wet.lastTick = performance.now(); }
    else { const w = wetField(this.layer); if (w && w.cells.size) { w.beforeWrite = this.beforeWrite ?? null; w.dryNow(this.wetParams); } } // a dry-media stroke on a wet layer fixes the wash first
    if (this.preset.media === "acrylic") this.body = bodyField(this.layer);
  }
  /** watercolour: write the wet field into the layer tiles (throttled while drawing, always on lift) */
  private presentWet(force: boolean): void {
    if (!this.wet) return; const now = performance.now(); if (!force && now - this.lastPresent < 40) return; this.lastPresent = now;
    const r = this.wet.present(this.wetParams); if (r) this.grow(r.x0, r.y0, r.x1, r.y1);
  }

  begin(s: StrokeSample): void {
    this.pts = []; this.fx.reset(); this.fy.reset(); this.pFilt.reset(); this.carry = 0; this.dirty = emptyRect(); this.lastSmudge = null; this.arc = 0; this.pending = []; this.peakP = 0;
    const p = this.push(s);
    this.dab(p.x, p.y, { ...p, arc: 0 }, 0); // cap
  }

  move(s: StrokeSample): void { this.push(s); this.render(); this.flushWasm(); this.applyClip(); this.presentWet(false); }

  /** blit wasm tile mirrors to their buffer canvases (one putImageData per touched tile) */
  private flushWasm(): void {
    if (!this.wasm || !this.wasmDirty.size) return;
    for (const t of this.wasmDirty) { const slot = this.wasmSlots.get(t); if (slot === undefined || !t.ctx) continue; (t.ctx as CanvasRenderingContext2D).putImageData(new ImageData(new Uint8ClampedArray(this.wasm.view(slot)), TILE, TILE), 0, 0); t.generation++; }
    this.wasmDirty.clear();
  }
  /** clip buffer tiles touched since the last call to the selection (binary mask: idempotent) */
  private applyClip(): void {
    if (!this.clip || !this.touched.size) return;
    for (const t of this.touched) if (t.ctx) this.clip.clipTile(t.ctx as CanvasRenderingContext2D, t.x, t.y);
    this.touched.clear();
  }

  end(): DirtyRect {
    const r = this.endInner(); this.flushWasm(); this.applyClip(); this.presentWet(true); return r;
  }
  private endInner(): DirtyRect {
    const last = this.pts[this.pts.length - 1];
    if (last && this.pts.length >= 2) { this.pts.push({ ...last }); this.render(); }
    // exit taper: held-back dabs shrink toward the lift point
    const total = this.arc;
    for (const q of this.pending) { const k = this.preset.taper > 0 ? Math.min(1, (total - q.s.arc) / this.preset.taper) : 1; this.dab(q.x, q.y, { ...q.s, exitK: k }, q.dir); }
    this.pending = [];
    return this.dirty;
  }

  /** Merge the stroke buffer into the layer with stroke opacity / blend / erase. */
  commit(): DirtyRect {
    if (this.wet) { this.presentWet(true); return this.dirty; } // wet strokes already live in the layer; drying continues in the render loop
    if (!this.buffer || !Number.isFinite(this.dirty.x0)) return this.dirty;
    this.flushWasm(); this.applyClip();
    const pr = this.preset;
    const opacity = pr.opacityByPressure > 0 ? pr.opacity * (1 - pr.opacityByPressure * (1 - this.peakP)) : pr.opacity;
    for (const bt of this.buffer.tiles.values()) {
      this.beforeWrite?.(this.layer, bt.x, bt.y);
      const t = this.layer.getTile(bt.x, bt.y, true)!;
      if (!t.ctx || !bt.canvas) continue;
      const ctx = t.ctx as CanvasRenderingContext2D;
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = pr.kind === "eraser" ? "destination-out" : pr.blend === "multiply" ? "multiply" : "source-over";
      ctx.drawImage(bt.canvas as CanvasImageSource, 0, 0);
      ctx.restore();
      t.generation++;
    }
    if (this.body) this.body.bake(this.dirty, this.bodyParams);
    this.layer.generation++;
    return this.dirty;
  }

  private push(s: StrokeSample) {
    const t = s.tMs / 1000;
    const x = this.exact ? s.x : this.fx.filter(s.x, t), y = this.exact ? s.y : this.fy.filter(s.y, t);
    const pRaw = Math.max(0, Math.min(1, this.exact ? s.pressure : this.pFilt.filter(s.pressure, 0.6)));
    const p = pressureCurve(pRaw, this.preset.curve);
    this.strength = p; if (p > this.peakP) this.peakP = p;
    const v = Math.hypot(this.fx.velocity, this.fy.velocity);
    const pt = { x, y, p, tx: s.tiltX, ty: s.tiltY, v };
    this.pts.push(pt);
    return pt;
  }

  private render(): void {
    const n = this.pts.length;
    if (n < 2) return;
    const p1 = this.pts[n - 2]!, p2 = this.pts[n - 1]!;
    const p0 = this.pts[Math.max(0, n - 3)]!, p3 = p2; // p3 unknown yet: use p2 (end-clamped Catmull-Rom)
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (segLen < 1e-6) return;
    const rMid = this.radius((p1.p + p2.p) / 2, (p1.v + p2.v) / 2);
    const step = Math.max(0.35, this.preset.spacing * Math.max(rMid, 0.6));
    let d = this.carry;
    const dir = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    while (d <= segLen) {
      const t = d / segLen;
      const [x, y] = catmull(p0, p1, p2, p3, t);
      const p = p1.p + (p2.p - p1.p) * t, tx = p1.tx + (p2.tx - p1.tx) * t, ty = p1.ty + (p2.ty - p1.ty) * t, v = p1.v + (p2.v - p1.v) * t;
      const sd = { p, tx, ty, v, arc: this.arc + d };
      if (this.preset.taper > 0) this.pending.push({ x, y, s: sd, dir }); else this.dab(x, y, sd, dir);
      d += step;
    }
    this.carry = d - segLen;
    this.arc += segLen;
    if (this.preset.taper > 0) {
      const limit = this.arc - this.preset.taper;
      while (this.pending.length && this.pending[0]!.s.arc <= limit) { const q = this.pending.shift()!; this.dab(q.x, q.y, q.s, q.dir); }
    }
  }

  radius(p: number, v: number): number {
    const pr = this.preset;
    const ps = pr.sizeByPressure ? pr.minSizeRatio + (1 - pr.minSizeRatio) * p : 1;
    let r = (pr.size / 2) * ps;
    if (pr.velocityThin > 0) { const vRef = 2200; r *= Math.max(0.3, 1 - pr.velocityThin * Math.min(1, v / vRef)); }
    return r;
  }

  flow(p: number): number {
    const pr = this.preset;
    return pr.flow * (pr.flowByPressure ? pr.minFlowRatio + (1 - pr.minFlowRatio) * p : 1);
  }

  /**
   * Anti-aliased tip. Coverage is preserved at every radius:
   *   solid core to hardness·r, quadratic falloff to r, then a 0.5 px AA skirt
   *   OUTSIDE r. Below r = 0.5 px the dab is a 0.75 px dot with area alpha.
   * Shapes: round disc; flat = ellipse (tipRatio) at a fixed angle, so the line
   * is thin on one axis like a chisel marker; bristle = a deterministic cluster
   * of small discs that streak along the stroke.
   * wetEdge pulls alpha from the centre to the rim (pigment settling at the edge
   * of a wet dab), which gives watercolour its darker outlines.
   */
  private tip(r: number, color = this.color, hardness = this.preset.hardness, shape: TipShape = this.preset.tipShape, image: string | null = this.preset.tipImage): OffscreenCanvas | HTMLCanvasElement {
    const pr = this.preset;
    const rq = Math.max(0.25, Math.round(r * 4) / 4);
    const hard = Math.round(hardness * 20) / 20;
    const key = `${rq}|${hard.toFixed(3)}|${shape}|${pr.wetEdge.toFixed(2)}|${color}|${image ? image.length : 0}`;
    let c = this.tipCache.get(key); if (c) return c;
    if (shape === "custom" && image) {
      const mask = tipMask(image);
      if (mask) {
        const size = Math.ceil(rq * 2) + 2;
        const cc = makeCanvas(size, size);
        const g = cc.getContext("2d") as CanvasRenderingContext2D;
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
        g.drawImage(mask, (size - rq * 2) / 2, (size - rq * 2) / 2, rq * 2, rq * 2);
        g.globalCompositeOperation = "source-in"; g.fillStyle = pr.kind === "eraser" ? "#000" : color; g.fillRect(0, 0, size, size);
        if (this.tipCache.size > 160) this.tipCache.clear(); this.tipCache.set(key, cc); return cc;
      }
    }
    if (shape === "sponge") {
      const size = Math.ceil(rq * 2) + 2; const m = spongeMask(pr.spongeKind, 7).canvas;
      const cc = makeCanvas(size, size);
      const g = cc.getContext("2d") as CanvasRenderingContext2D; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
      g.drawImage(m, (size - rq * 2) / 2, (size - rq * 2) / 2, rq * 2, rq * 2);
      g.globalCompositeOperation = "source-in"; g.fillStyle = pr.kind === "eraser" ? "#000" : color; g.fillRect(0, 0, size, size);
      if (this.tipCache.size > 160) this.tipCache.clear(); this.tipCache.set(key, cc); return cc;
    }
    const outer = rq + 0.5;
    const size = Math.ceil(outer * 2) + 2;
    c = makeCanvas(size, size);
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    const cx = size / 2;
    const col = pr.kind === "eraser" ? "0,0,0" : hexToRgb(color);
    const disc = (g: CanvasRenderingContext2D, R: number) => {
      if (R < 0.5) { const a = Math.min(1, (R / 0.5) * (R / 0.5)); g.fillStyle = `rgba(${col},${a.toFixed(3)})`; g.beginPath(); g.arc(0, 0, 0.75, 0, Math.PI * 2); g.fill(); return; }
      const o = R + 0.5; const grad = g.createRadialGradient(0, 0, 0, 0, 0, o);
      const core = (hard * R) / o, edge = R / o;
      const centerA = 1 - pr.wetEdge * 0.55;
      grad.addColorStop(0, `rgba(${col},${centerA.toFixed(3)})`);
      grad.addColorStop(core, `rgba(${col},${(centerA + (1 - centerA) * 0.6).toFixed(3)})`);
      const steps = 6;
      for (let i = 1; i < steps; i++) { const u = i / steps; const fall = 1 - u * u * (1 - 0.35); const a = pr.wetEdge > 0 ? Math.min(1, fall + pr.wetEdge * u) : fall; grad.addColorStop(core + (edge - core) * u, `rgba(${col},${a.toFixed(3)})`); }
      grad.addColorStop(edge, `rgba(${col},${hard >= 0.999 || pr.wetEdge > 0.3 ? 1 : 0.35})`);
      grad.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = grad; g.beginPath(); g.arc(0, 0, o, 0, Math.PI * 2); g.fill();
    };
    ctx.translate(cx, cx);
    if (shape === "flat") {
      ctx.rotate((pr.tipAngleDeg * Math.PI) / 180); ctx.scale(1, Math.max(0.08, pr.tipRatio)); disc(ctx, rq);
    } else if (shape === "bristle") {
      let seed = 0x9e3779b1 + Math.round(rq * 7);
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const n = Math.max(3, pr.bristles); const br = Math.max(0.3, rq * (0.085 + Math.max(0, n - 24) / 300)); // dense heads: thicker hairs so the body fills with ridges, not gaps
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * rq * pr.bristleSpread;
        ctx.save(); ctx.translate(Math.cos(a) * d, Math.sin(a) * d); disc(ctx, br * (0.6 + rnd() * 0.8)); ctx.restore();
      }
    } else disc(ctx, rq);
    if (this.tipCache.size > 160) this.tipCache.clear();
    this.tipCache.set(key, c);
    return c;
  }

  private rnd(): number { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x7fffffff; }

  private dab(x: number, y: number, s: { p: number; tx: number; ty: number; v: number; arc?: number; exitK?: number }, dir: number): void {
    const pr = this.preset;
    const tiltMag = Math.min(60, Math.hypot(s.tx, s.ty)) / 60; // 0..1
    let r = this.radius(s.p, s.v);
    if (pr.tiltSize > 0) r *= 1 + pr.tiltSize * 1.5 * tiltMag; // pencil laid flat covers more
    if (pr.pooling > 0) r *= 1 + pr.pooling * 0.8 * Math.max(0, 1 - s.v / 350); // nib loads ink when it lingers
    if (pr.taper > 0 && s.arc !== undefined) r *= Math.min(1, s.arc / pr.taper); // entry taper
    if (s.exitK !== undefined) r *= s.exitK; // exit taper
    if (r <= 0.05) return;
    if (x + r * 1.5 < 0 || y + r * 1.5 < 0 || x - r * 1.5 > this.pageW || y - r * 1.5 > this.pageH) return; // off the page
    if (pr.jitter > 0) { const a = this.rnd() * Math.PI * 2, m = this.rnd() * pr.jitter * r; x += Math.cos(a) * m; y += Math.sin(a) * m; }
    if (pr.sizeNoise > 0) r *= 1 - pr.sizeNoise * 0.6 * this.rnd();
    if (pr.nibFlex > 0 && pr.tipShape === "round") { // round nib that thins along a fixed angle: |sin(dir - nib)| drives width
      const rel = dir - (pr.nibAngleDeg * Math.PI) / 180; const k = Math.abs(Math.sin(rel)); r *= 1 - pr.nibFlex * (1 - k) * 0.85;
    }
    if (pr.kind === "smudge" || pr.kind === "blur") {
      if (this.clip && !this.clip.contains(x, y)) return;
      if (pr.kind === "smudge") this.smudge(x, y, r, s.p); else this.blur(x, y, r, s.p);
      return;
    }
    let a = this.flow(s.p);
    if (pr.flowNoise > 0) a *= 1 - pr.flowNoise * this.rnd();
    const spin = pr.spinTip && pr.tipShape === "sponge" ? this.rnd() * Math.PI * 2 : 0;
    let sx = 1, sy = 1, rot = spin;
    if (pr.tipShape === "flat" && pr.tipFollow) rot = dir + Math.PI / 2 - (pr.tipAngleDeg * Math.PI) / 180; // long axis across the stroke
    if (pr.tiltShape) {
      sy = Math.max(0.35, Math.cos(tiltMag * Math.PI / 3)); sx = 1 + (1 - sy) * 0.6;
      rot = tiltMag > 0.03 ? Math.atan2(s.ty, s.tx) : dir;
    }
    if (pr.tipShape === "bristle") rot = dir; // bristles streak along the stroke
    if (pr.tipShape === "custom" && pr.tipImageFollow) rot = dir;
    if (this.wet) { // watercolour: deposit into the wet field, the field renders itself into the layer
      if (this.clip && !this.clip.contains(x, y)) return;
      const rgb = hexToRgbTuple(this.color);
      if (pr.wetEffect !== "none") this.wet.effect(x, y, r, pr.wetEffect, (this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff));
      else this.wet.dab(x, y, r, this.wetParams, rgb, s.p, this.fp, rot, Math.min(1, a * 1.4));
      this.grow(x - r - 2, y - r - 2, x + r + 2, y + r + 2); this.dabCount++;
      return;
    }
    if (pr.tiltFlow > 0) a *= 1 - pr.tiltFlow * 0.7 * tiltMag; // flat pencil deposits less per pass
    if (pr.inkLoad > 0) { // reservoir: ink thins along the stroke and reloads on lift
      const spent = 1 - Math.exp(-(s.arc ?? this.arc) / pr.inkLoad);
      a *= 1 - (1 - pr.inkMin) * spent;
    }
    const hardness = pr.hardnessByPressure > 0 ? pr.hardness * (1 - pr.hardnessByPressure * (1 - s.p)) : pr.hardness;
    // wet mixing: pull the colour already on the layer under the tip into this dab
    let dabColor = this.color;
    if (pr.mix > 0 && pr.kind === "paint") {
      const sampled = this.sampleLayer(x, y, Math.max(2, r * 0.5));
      const openK = pr.mixOpen && this.body ? this.body.openness(x, y, this.bodyParams.open, performance.now()) : 1;
      if (sampled) { const k = pr.mix * sampled.a * openK; dabColor = mixHex(this.color, sampled.rgb, k); }
    }
    if (this.body) { // acrylic: body under the footprint; a knife or sgraffito tool scrapes it away first
      if (pr.scrape) this.body.scrape(x, y, r);
      if (pr.kind === "paint" && this.bodyParams.body > 0) this.body.addBody(x, y, r * 0.95, this.bodyParams.body * a * (0.4 + 0.6 * s.p) * 0.9, performance.now(), pr.tipShape === "bristle", dir, this.fp, spin);
    }
    if (pr.scatter > 0) { this.spray(x, y, r, a, s.p, dabColor); return; }
    if (this.wasm && pr.tipShape === "round" && pr.grain <= 0 && pr.wetEdge <= 0 && !pr.tiltShape && !pr.dual && pr.nibFlex <= 0) {
      const target = this.buffer as Layer; const rgb = pr.kind === "eraser" ? [0, 0, 0] as [number, number, number] : hexToRgbTuple(dabColor);
      const R = r + 1.5;
      this.grow(x - R, y - R, x + R, y + R); this.dabCount++; this.wasmDabs++;
      for (const t of target.tilesIn(x - R, y - R, x + R, y + R, true)) {
        if (!t.ctx) continue;
        let slot = this.wasmSlots.get(t);
        if (slot === undefined) { slot = this.wasm.alloc(); if (slot < 0) { this.wasm = null; break; } this.wasmSlots.set(t, slot); }
        this.wasm.dab(slot, x - t.x * TILE, y - t.y * TILE, r, hardness, a, rgb);
        this.wasmDirty.add(t); if (this.clip) this.touched.add(t);
      }
      if (this.wasm) return;
    }
    const tipC = this.tip(r, dabColor, hardness);
    const half = tipC.width / 2;
    const ext = half * Math.max(sx, sy) * 1.2;
    this.grow(x - ext, y - ext, x + ext, y + ext);
    this.dabCount++;
    const target = this.buffer as Layer;
    let src: OffscreenCanvas | HTMLCanvasElement = tipC;
    let srcHalf = half;
    if (pr.grain > 0) {
      // Paper-locked grain. mask = 1 - g·valley(doc position), g = grain·(1 - 0.6·pressure):
      // pressing harder pushes pigment into the valleys, exactly like a real pencil.
      const sz = Math.ceil(half * 2 * Math.max(sx, sy)) + 4;
      if (!this.dabTmp || this.dabTmp.width < sz) {
        this.dabTmp = makeCanvas(sz, sz);
        this.maskTmp = makeCanvas(sz, sz);
      }
      const tc = this.dabTmp.getContext("2d") as CanvasRenderingContext2D;
      const mc = (this.maskTmp as HTMLCanvasElement).getContext("2d") as CanvasRenderingContext2D;
      const g = pr.grain * (1 - 0.6 * s.p);
      const ox = ((x - sz / 2) % 256 + 256) % 256, oy = ((y - sz / 2) % 256 + 256) % 256;
      mc.setTransform(1, 0, 0, 1, 0, 0); mc.globalCompositeOperation = "source-over"; mc.globalAlpha = 1;
      mc.clearRect(0, 0, sz, sz); mc.fillStyle = "#fff"; mc.fillRect(0, 0, sz, sz);
      mc.globalCompositeOperation = "destination-out"; mc.globalAlpha = g;
      const pat = mc.createPattern(grainTexture(pr.grainScale) as CanvasImageSource, "repeat")!;
      mc.translate(-ox, -oy); mc.fillStyle = pat; mc.fillRect(ox, oy, sz, sz);
      mc.setTransform(1, 0, 0, 1, 0, 0); mc.globalAlpha = 1; mc.globalCompositeOperation = "source-over";
      tc.setTransform(1, 0, 0, 1, 0, 0); tc.globalCompositeOperation = "source-over"; tc.globalAlpha = 1; tc.clearRect(0, 0, sz, sz);
      tc.translate(sz / 2, sz / 2); tc.rotate(rot); tc.scale(sx, sy); tc.drawImage(tipC as CanvasImageSource, -half, -half);
      tc.setTransform(1, 0, 0, 1, 0, 0);
      tc.globalCompositeOperation = "destination-in"; tc.drawImage(this.maskTmp as CanvasImageSource, 0, 0);
      tc.globalCompositeOperation = "source-over";
      src = this.dabTmp; srcHalf = sz / 2; sx = 1; sy = 1; rot = 0;
    }
    if (pr.dual) {
      // dual brush: intersect the dab with a second tip (bristle / flat / custom) at its own size and a random spin
      const dr = Math.max(0.5, r * pr.dualRatio); const dualC = this.tip(dr, "#000000", pr.hardness, pr.dualShape, pr.dualImage); const dh = dualC.width / 2;
      const sz = Math.ceil(Math.max(srcHalf * Math.max(sx, sy), dh) * 2) + 4;
      if (!this.dualTmp || this.dualTmp.width < sz) this.dualTmp = makeCanvas(sz, sz);
      const dc = this.dualTmp.getContext("2d") as CanvasRenderingContext2D;
      dc.setTransform(1, 0, 0, 1, 0, 0); dc.globalCompositeOperation = "source-over"; dc.globalAlpha = 1; dc.clearRect(0, 0, sz, sz);
      dc.translate(sz / 2, sz / 2); dc.rotate(rot); dc.scale(sx, sy); dc.drawImage(src as CanvasImageSource, -srcHalf, -srcHalf);
      dc.setTransform(1, 0, 0, 1, 0, 0); dc.translate(sz / 2, sz / 2); dc.rotate(pr.dualRotate ? this.rnd() * Math.PI * 2 : dir);
      dc.globalCompositeOperation = "destination-in"; dc.drawImage(dualC as CanvasImageSource, -dh, -dh);
      dc.setTransform(1, 0, 0, 1, 0, 0); dc.globalCompositeOperation = "source-over";
      src = this.dualTmp; srcHalf = sz / 2; sx = 1; sy = 1; rot = 0;
    }
    for (const t of target.tilesIn(x - ext, y - ext, x + ext, y + ext, true)) {
      if (!t.ctx) continue;
      if (this.clip) this.touched.add(t);
      const ctx = t.ctx as CanvasRenderingContext2D;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(x - t.x * TILE, y - t.y * TILE); ctx.rotate(rot); ctx.scale(sx, sy);
      ctx.drawImage(src as CanvasImageSource, -srcHalf, -srcHalf);
      ctx.restore();
      t.generation++;
    }
  }

  private sampleTmp: OffscreenCanvas | HTMLCanvasElement | null = null;
  private sampleCount = 0;
  private lastSample: { rgb: [number, number, number]; a: number } | null = null;
  /** Average colour of the layer in a (2R)² box; re-sampled every 2nd dab to keep the cost down. */
  private sampleLayer(x: number, y: number, R: number): { rgb: [number, number, number]; a: number } | null {
    if ((this.sampleCount++ & 1) && this.lastSample) return this.lastSample;
    const S = 8;
    if (!this.sampleTmp) this.sampleTmp = makeCanvas(S, S);
    const c = this.sampleTmp.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, S, S);
    const x0 = x - R, y0 = y - R, sc = S / (2 * R);
    c.scale(sc, sc);
    for (const t of this.layer.tilesIn(x0, y0, x + R, y + R, false)) if (t.canvas) c.drawImage(t.canvas as CanvasImageSource, t.x * TILE - x0, t.y * TILE - y0);
    // include the in-progress stroke buffer so a stroke mixes with itself
    if (this.buffer) for (const t of this.buffer.tilesIn(x0, y0, x + R, y + R, false)) if (t.canvas) { c.globalAlpha = this.preset.opacity; c.drawImage(t.canvas as CanvasImageSource, t.x * TILE - x0, t.y * TILE - y0); c.globalAlpha = 1; }
    const d = c.getImageData(0, 0, S, S).data;
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < d.length; i += 4) { const al = d[i + 3]! / 255; r += d[i]! * al; g += d[i + 1]! * al; b += d[i + 2]! * al; a += al; }
    if (a < 0.02) { this.lastSample = null; return null; }
    this.lastSample = { rgb: [r / a, g / a, b / a], a: a / (S * S) };
    return this.lastSample;
  }

  /** Spray: hard droplets scattered in the cone; count scales with pressure. */
  private spray(x: number, y: number, r: number, flow: number, p: number, color: string): void {
    const pr = this.preset;
    const n = Math.max(1, Math.round(pr.scatterCount * (0.4 + 0.6 * p)));
    const target = this.buffer as Layer;
    this.grow(x - r - 2, y - r - 2, x + r + 2, y + r + 2);
    this.dabCount++;
    for (let i = 0; i < n; i++) {
      const ang = this.rnd() * Math.PI * 2, dist = Math.sqrt(this.rnd()) * r * pr.scatter;
      const dr = Math.max(0.4, r * (0.04 + this.rnd() * 0.08));
      const dx = x + Math.cos(ang) * dist, dy = y + Math.sin(ang) * dist;
      const tipC = this.tip(dr, color); const half = tipC.width / 2;
      for (const t of target.tilesIn(dx - half, dy - half, dx + half, dy + half, true)) {
        if (!t.ctx) continue;
        if (this.clip) this.touched.add(t);
        const ctx = t.ctx as CanvasRenderingContext2D; ctx.save(); ctx.globalAlpha = flow; ctx.drawImage(tipC as CanvasImageSource, dx - half - t.x * TILE, dy - half - t.y * TILE); ctx.restore(); t.generation++;
      }
    }
  }

  /** Blur: re-draw the region under the tip through a blur filter, masked by the tip. */
  private blur(x: number, y: number, r: number, p: number): void {
    const size = Math.ceil(r * 2) + 8;
    if (!this.smudgeSrc || this.smudgeSrc.width !== size) this.smudgeSrc = makeCanvas(size, size);
    const sc = this.smudgeSrc.getContext("2d") as CanvasRenderingContext2D;
    const px = x - size / 2, py = y - size / 2;
    sc.setTransform(1, 0, 0, 1, 0, 0); sc.globalCompositeOperation = "source-over"; sc.filter = "none"; sc.clearRect(0, 0, size, size);
    sc.filter = `blur(${(0.5 + this.preset.smudgeStrength * 3 * (0.3 + 0.7 * p)).toFixed(2)}px)`;
    for (const t of this.layer.tilesIn(px - 8, py - 8, px + size + 8, py + size + 8, false)) if (t.canvas) sc.drawImage(t.canvas as CanvasImageSource, t.x * TILE - px, t.y * TILE - py);
    sc.filter = "none";
    const tipC = this.tip(r); sc.globalCompositeOperation = "destination-in"; sc.drawImage(tipC as CanvasImageSource, size / 2 - tipC.width / 2, size / 2 - tipC.height / 2);
    this.grow(px, py, px + size, py + size);
    const tx0 = Math.floor(px / TILE), ty0 = Math.floor(py / TILE), tx1 = Math.floor((px + size) / TILE), ty1 = Math.floor((py + size) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.beforeWrite?.(this.layer, tx, ty);
    // replace (not accumulate): clear under the tip mask, then lay the blurred patch back
    for (const t of this.layer.tilesIn(px, py, px + size, py + size, true)) {
      if (!t.ctx) continue;
      const ctx = t.ctx as CanvasRenderingContext2D; ctx.save();
      ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(tipC as CanvasImageSource, x - tipC.width / 2 - t.x * TILE, y - tipC.height / 2 - t.y * TILE);
      ctx.globalCompositeOperation = "source-over"; ctx.drawImage(this.smudgeSrc as CanvasImageSource, px - t.x * TILE, py - t.y * TILE);
      ctx.restore(); t.generation++;
    }
  }

  private grow(x0: number, y0: number, x1: number, y1: number): void {
    this.dirty.x0 = Math.min(this.dirty.x0, x0); this.dirty.y0 = Math.min(this.dirty.y0, y0);
    this.dirty.x1 = Math.max(this.dirty.x1, x1); this.dirty.y1 = Math.max(this.dirty.y1, y1);
    this.frameDirty.x0 = Math.min(this.frameDirty.x0, x0); this.frameDirty.y0 = Math.min(this.frameDirty.y0, y0);
    this.frameDirty.x1 = Math.max(this.frameDirty.x1, x1); this.frameDirty.y1 = Math.max(this.frameDirty.y1, y1);
  }
  /** the area changed since the last call (what the viewport needs to repaint), not the whole stroke so far */
  private frameDirty: DirtyRect = emptyRect();
  takeDirty(): DirtyRect { const d = this.frameDirty; this.frameDirty = emptyRect(); return d; }

  /**
   * Undo snapshots for buffered strokes, taken while drawing instead of all at pen-up. The layer is
   * untouched until commit(), so a tile's pixels read now are its true before-state. A few tiles per
   * batch spreads the readbacks over the stroke; commit() captures whatever is left.
   */
  private prefetched = new Set<string>();
  prefetchHistory(max = 3): void {
    if (!this.buffer || !this.beforeWrite || this.wet || this.body || this.prefetched.size >= this.buffer.tiles.size) return;
    let n = 0;
    for (const bt of this.buffer.tiles.values()) {
      const k = `${bt.x},${bt.y}`; if (this.prefetched.has(k)) continue;
      this.prefetched.add(k); this.beforeWrite(this.layer, bt.x, bt.y);
      if (++n >= max) return;
    }
  }

  /** Smudge: drag the pixels under the previous dab to the current one, masked by the tip. */
  private smudge(x: number, y: number, r: number, p: number): void {
    const size = Math.ceil(r * 2) + 2;
    if (!this.smudgeSrc || this.smudgeSrc.width !== size) this.smudgeSrc = makeCanvas(size, size);
    const sc = this.smudgeSrc.getContext("2d") as CanvasRenderingContext2D;
    if (this.lastSmudge) {
      // 1. grab layer pixels under the previous position
      sc.setTransform(1, 0, 0, 1, 0, 0); sc.globalCompositeOperation = "source-over"; sc.clearRect(0, 0, size, size);
      const px = this.lastSmudge.x - size / 2, py = this.lastSmudge.y - size / 2;
      for (const t of this.layer.tilesIn(px, py, px + size, py + size, false)) if (t.canvas) sc.drawImage(t.canvas as CanvasImageSource, t.x * TILE - px, t.y * TILE - py);
      // 2. mask by tip
      sc.globalCompositeOperation = "destination-in"; sc.drawImage(this.tip(r) as CanvasImageSource, size / 2 - this.tip(r).width / 2, size / 2 - this.tip(r).height / 2);
      // 3. stamp at the new position with strength
      const a = this.preset.smudgeStrength * (0.4 + 0.6 * p);
      const nx = x - size / 2, ny = y - size / 2;
      this.grow(nx, ny, nx + size, ny + size);
      const tx0 = Math.floor(nx / TILE), ty0 = Math.floor(ny / TILE), tx1 = Math.floor((nx + size) / TILE), ty1 = Math.floor((ny + size) / TILE);
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.beforeWrite?.(this.layer, tx, ty);
      for (const t of this.layer.tilesIn(nx, ny, nx + size, ny + size, true)) {
        if (!t.ctx) continue;
        const ctx = t.ctx as CanvasRenderingContext2D;
        ctx.save(); ctx.globalAlpha = a; ctx.drawImage(this.smudgeSrc as CanvasImageSource, nx - t.x * TILE, ny - t.y * TILE); ctx.restore();
        t.generation++;
      }
    }
    this.lastSmudge = { x, y };
  }
}

function catmull(p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, t: number): [number, number] {
  const knot = (t0: number, a: { x: number; y: number }, b: { x: number; y: number }) => t0 + Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) + 1e-4;
  const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const L = (a: number, b: number, u: number) => a + (b - a) * u;
  const a1x = L(p0.x, p1.x, (tt - t0) / (t1 - t0)), a1y = L(p0.y, p1.y, (tt - t0) / (t1 - t0));
  const a2x = L(p1.x, p2.x, (tt - t1) / (t2 - t1)), a2y = L(p1.y, p2.y, (tt - t1) / (t2 - t1));
  const a3x = L(p2.x, p3.x, (tt - t2) / (t3 - t2)), a3y = L(p2.y, p3.y, (tt - t2) / (t3 - t2));
  const b1x = L(a1x, a2x, (tt - t0) / (t2 - t0)), b1y = L(a1y, a2y, (tt - t0) / (t2 - t0));
  const b2x = L(a2x, a3x, (tt - t1) / (t3 - t1)), b2y = L(a2y, a3y, (tt - t1) / (t3 - t1));
  return [L(b1x, b2x, (tt - t1) / (t2 - t1)), L(b1y, b2y, (tt - t1) / (t2 - t1))];
}

/** Mix pigment hex with a sampled rgb (0..255) by k in 0..1. */
export function mixHex(hex: string, rgb: [number, number, number], k: number): string {
  const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const q = (v: number) => Math.round(Math.max(0, Math.min(255, v)) / 8) * 8; // quantize so the tip cache stays small
  return "#" + [q(r + (rgb[0] - r) * k), q(g + (rgb[1] - g) * k), q(b + (rgb[2] - b) * k)].map((v) => Math.min(255, v).toString(16).padStart(2, "0")).join("");
}

/** Alpha mask for a custom tip image: uses the PNG's alpha when it varies, otherwise dark = opaque. Cached per data URL. */
const tipMaskCache = new Map<string, HTMLCanvasElement | null>();
const tipImgCache = new Map<string, HTMLImageElement>();
export function tipMask(dataUrl: string): HTMLCanvasElement | null {
  if (tipMaskCache.has(dataUrl)) return tipMaskCache.get(dataUrl)!;
  let img = tipImgCache.get(dataUrl);
  if (!img) { img = new Image(); img.src = dataUrl; tipImgCache.set(dataUrl, img); }
  if (!img.complete || !img.naturalWidth) { tipMaskCache.set(dataUrl, null); img.addEventListener("load", () => tipMaskCache.delete(dataUrl), { once: true }); return null; }
  const S = 256; const c = document.createElement("canvas"); c.width = S; c.height = S; const g = c.getContext("2d", { willReadFrequently: true })!;
  const k = Math.min(S / img.naturalWidth, S / img.naturalHeight); const w = img.naturalWidth * k, h = img.naturalHeight * k;
  g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
  const id = g.getImageData(0, 0, S, S); const d = id.data; let minA = 255, maxA = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i]! < minA) minA = d[i]!; if (d[i]! > maxA) maxA = d[i]!; }
  if (maxA - minA < 8) { // opaque image: luminance → alpha (dark = ink)
    for (let i = 0; i < d.length; i += 4) { const l = (d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114) / 255; d[i + 3] = Math.round((1 - l) * 255); d[i] = d[i + 1] = d[i + 2] = 0; }
  } else for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 0; }
  g.putImageData(id, 0, 0); tipMaskCache.set(dataUrl, c); return c;
}

export function hexToRgbTuple(hex: string): [number, number, number] { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

export interface FillOptions {
  tolerance: number; // 0..1 colour distance
  expand: number; // px, tucks the fill under anti-aliased line art
  mode: "contiguous" | "global"; // connected region vs every matching pixel
  antialias: boolean; // feather the outer edge by 1 px
  /** px: line art is virtually thickened so the flood cannot leak through gaps up to ~2x this wide */
  closeGap: number;
  /** try closeGap, then 2x, 4x ... up to maxAutoGap until the region stops touching the page border */
  autoClose: boolean;
  maxAutoGap: number;
  /** if the region still reaches the page border, do not fill and report `leaked` */
  stopLeaks: boolean;
  /** return the region mask (after expand) without writing any pixels: magic wand */
  maskOnly?: boolean;
}

export interface FillResult extends DirtyRect {
  leaked: boolean;      // region reached the page border (shape not enclosed)
  gapUsed: number;      // close-gap radius that produced the region
  pixels: number;       // region size
  filled: boolean;
  mask?: Uint8Array;    // maskOnly: 1 = selected, reference resolution
}

/**
 * Chamfer (3-4) distance transform: distance in px from every pixel to the nearest
 * pixel where `seed` is set. Two passes, O(n), values in 1/3 px units.
 */
function chamfer(seed: Uint8Array, w: number, h: number): Int32Array {
  const INF = 1 << 28; const d = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = seed[i] ? 0 : INF;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = d[i]!; if (v === 0) continue;
    if (x > 0) v = Math.min(v, d[i - 1]! + 3);
    if (y > 0) { v = Math.min(v, d[i - w]! + 3); if (x > 0) v = Math.min(v, d[i - w - 1]! + 4); if (x < w - 1) v = Math.min(v, d[i - w + 1]! + 4); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = d[i]!; if (v === 0) continue;
    if (x < w - 1) v = Math.min(v, d[i + 1]! + 3);
    if (y < h - 1) { v = Math.min(v, d[i + w]! + 3); if (x < w - 1) v = Math.min(v, d[i + w + 1]! + 4); if (x > 0) v = Math.min(v, d[i + w - 1]! + 4); }
    d[i] = v;
  }
  return d;
}

/** Chamfer feature transform: like `chamfer` but also returns the index of the nearest seed pixel. */
function chamferNearest(seed: Uint8Array, w: number, h: number): { d: Int32Array; near: Int32Array } {
  const INF = 1 << 28; const d = new Int32Array(w * h); const near = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) { d[i] = seed[i] ? 0 : INF; near[i] = seed[i] ? i : -1; }
  const relax = (i: number, j: number, c: number) => { const v = d[j]! + c; if (v < d[i]!) { d[i] = v; near[i] = near[j]!; } };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (d[i] === 0) continue;
    if (x > 0) relax(i, i - 1, 3);
    if (y > 0) { relax(i, i - w, 3); if (x > 0) relax(i, i - w - 1, 4); if (x < w - 1) relax(i, i - w + 1, 4); }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (d[i] === 0) continue;
    if (x < w - 1) relax(i, i + 1, 3);
    if (y < h - 1) { relax(i, i + w, 3); if (x < w - 1) relax(i, i + w + 1, 4); if (x > 0) relax(i, i + w - 1, 4); }
  }
  return { d, near };
}

/** scanline flood over `open` (1 = passable) from (sx,sy); returns the mask, bounds and whether it touched the border */
function flood(open: Uint8Array, w: number, h: number, sx: number, sy: number) {
  const mask = new Uint8Array(w * h);
  let x0 = sx, y0 = sy, x1 = sx, y1 = sy, count = 0, border = false;
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!; let x = stack.pop()!;
    let i = y * w + x; if (!open[i] || mask[i]) continue;
    while (x > 0 && open[i - 1] && !mask[i - 1]) { x--; i--; }
    let spanUp = false, spanDown = false;
    if (x === 0) border = true;
    while (x < w && open[i] && !mask[i]) {
      mask[i] = 1; count++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (y > 0) { const u = i - w; if (!spanUp && open[u] && !mask[u]) { stack.push(x, y - 1); spanUp = true; } else if (spanUp && !(open[u] && !mask[u])) spanUp = false; } else border = true;
      if (y < h - 1) { const dn = i + w; if (!spanDown && open[dn] && !mask[dn]) { stack.push(x, y + 1); spanDown = true; } else if (spanDown && !(open[dn] && !mask[dn])) spanDown = false; } else border = true;
      x++; i++;
    }
    if (x === w) border = true;
  }
  return { mask, x0, y0, x1, y1, count, border };
}

/**
 * Flood fill v3. `reference` is what the user sees (all layers or the current one) at
 * document resolution; the result is written to `target` (core region, replace) and
 * `underTarget` (dilated ring + feather, meant to be composited destination-over so
 * line art is never overwritten).
 *
 * Gap closing uses a distance transform: pixels closer than `g` px to a non-matching
 * pixel are obstacles for the flood, then the region grows back by `g` px onto matching
 * pixels only, so a gap narrower than ~2g is bridged with a round cap and nothing else
 * changes. With `autoClose`, g doubles until the region no longer reaches the page border.
 */
export function floodFill(reference: HTMLCanvasElement, target: Layer, x: number, y: number, color: string, opts: FillOptions, underTarget?: Layer): FillResult {
  const w = reference.width, h = reference.height;
  const none: FillResult = { ...emptyRect(), leaked: false, gapUsed: 0, pixels: 0, filled: false };
  const rc = reference.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const src = rc.getImageData(0, 0, w, h).data;
  const sx = Math.floor(x), sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return none;
  const i0 = (sy * w + sx) * 4;
  const tr = src[i0]!, tg = src[i0 + 1]!, tb = src[i0 + 2]!, ta = src[i0 + 3]!;
  const tol2 = (opts.tolerance * 441) ** 2;
  const n = w * h;
  const prof: Record<string, number> = {}; let tp = performance.now(); const mark = (k: string) => { const t = performance.now(); prof[k] = (prof[k] ?? 0) + t - tp; tp = t; };
  (globalThis as unknown as { __fillProf: unknown }).__fillProf = prof;
  mark("read");
  const matchMask = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const dr = src[j]! - tr, dg = src[j + 1]! - tg, db = src[j + 2]! - tb, da = src[j + 3]! - ta;
    if (dr * dr + dg * dg + db * db + da * da <= tol2) matchMask[i] = 1;
  }

  mark("match");
  let m: Uint8Array; let x0: number, y0: number, x1: number, y1: number; let leaked = false, gapUsed = 0, pixels = 0;
  if (opts.mode === "global") {
    m = matchMask; x0 = w; y0 = h; x1 = -1; y1 = -1;
    for (let i = 0; i < n; i++) if (m[i]) { const px = i % w, py = (i - px) / w; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; pixels++; }
    if (x1 < 0) return none;
  } else {
    // Gap search runs on a downsampled mask (<= ~1 Mpx, conservative: a block with any line pixel
    // counts as line) so each attempt is cheap; only the final flood runs at full resolution.
    const k = Math.max(1, Math.ceil(Math.sqrt(n / 1e6)));
    const lw = Math.ceil(w / k), lh = Math.ceil(h / k);
    const lowMatch = new Uint8Array(lw * lh).fill(1);
    for (let py = 0; py < h; py++) { const ly = Math.floor(py / k) * lw; for (let px = 0; px < w; px++) if (!matchMask[py * w + px]) lowMatch[ly + Math.floor(px / k)] = 0; }
    const lowInv = new Uint8Array(lw * lh); for (let i = 0; i < lw * lh; i++) lowInv[i] = lowMatch[i] ? 0 : 1;
    const lowDist = chamfer(lowInv, lw, lh);
    const lsx = Math.floor(sx / k), lsy = Math.floor(sy / k);
    let lowRes: ReturnType<typeof flood> | null = null;
    const tryLow = (g: number) => { // g in full-res px; returns border flag, keeps the flood for its bounds
      const open = new Uint8Array(lw * lh); const lim = (g / k) * 3;
      for (let i = 0; i < lw * lh; i++) open[i] = lowDist[i]! > lim ? 1 : 0;
      if (!open[lsy * lw + lsx]) return null;
      const r = flood(open, lw, lh, lsx, lsy); if (!r.border) lowRes = r; return r.border;
    };
    let gSel = opts.closeGap, leakedLow = true;
    if (!matchMask[sy * w + sx]) return none;
    const r0 = tryLow(opts.closeGap);
    if (r0 === null) { gSel = 0; leakedLow = tryLow(0) ?? true; }
    else {
      leakedLow = r0;
      if (leakedLow && opts.autoClose) {
        let lo = Math.max(2, opts.closeGap), hi = lo; let found = false;
        while (hi < opts.maxAutoGap) { hi = Math.min(opts.maxAutoGap, hi * 2); const r = tryLow(hi); if (r === null) break; if (!r) { found = true; break; } lo = hi; }
        if (found) { // binary refine between lo (leaks) and hi (enclosed) to the smallest closing gap
          for (let it = 0; it < 3 && hi - lo > 2; it++) { const mid = Math.round((lo + hi) / 2); const r = tryLow(mid); if (r === null || r) lo = mid; else hi = mid; }
          gSel = hi; leakedLow = false; tryLow(hi);
        } else gSel = Math.max(2, opts.closeGap);
      }
    }
    mark("search");
    if (leakedLow && opts.stopLeaks && opts.autoClose) return { ...none, leaked: true, gapUsed: gSel, pixels: 0 };
    // working window: the enclosed low-res region (scaled up) plus the gap and expand margins;
    // a leaking region uses the whole page
    const pad = gSel * 2 + opts.expand + 4;
    const lr = lowRes as ReturnType<typeof flood> | null;
    const wx0 = lr ? Math.max(0, lr.x0 * k - pad) : 0, wy0 = lr ? Math.max(0, lr.y0 * k - pad) : 0;
    const wx1 = lr ? Math.min(w - 1, (lr.x1 + 1) * k + pad) : w - 1, wy1 = lr ? Math.min(h - 1, (lr.y1 + 1) * k + pad) : h - 1;
    const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1, wn = ww * wh;
    const wm = new Uint8Array(wn);
    for (let py = 0; py < wh; py++) wm.set(matchMask.subarray((py + wy0) * w + wx0, (py + wy0) * w + wx0 + ww), py * ww);
    const wsx = sx - wx0, wsy = sy - wy0;
    // Final flood at full resolution inside the window. Gap closing: line art is thickened by g
    // (pixels within g of a line are obstacles), the region is flooded, then grown back by g onto
    // matching pixels. A grown pixel is kept only when its nearest line pixel and its nearest region
    // pixel lie on opposite sides of it (dot <= 0): that keeps the band along the ink and removes the
    // half-disc bulge an opening would leave outside the gap, so the bridge is nearly flat.
    let best: ReturnType<typeof flood> | null = null;
    let lineFT: { d: Int32Array; near: Int32Array } | null = null;
    if (gSel > 0) {
      const inv = new Uint8Array(wn); for (let i = 0; i < wn; i++) inv[i] = wm[i] ? 0 : 1;
      lineFT = chamferNearest(inv, ww, wh); const lim = gSel * 3;
      const open = new Uint8Array(wn); for (let i = 0; i < wn; i++) open[i] = lineFT.d[i]! > lim ? 1 : 0;
      if (open[wsy * ww + wsx]) { best = flood(open, ww, wh, wsx, wsy); gapUsed = gSel; }
    }
    if (!best) { best = flood(wm, ww, wh, wsx, wsy); gapUsed = 0; }
    leaked = lr ? false : best.border; mark("flood");
    let region = best.mask; let bx0 = best.x0, by0 = best.y0, bx1 = best.x1, by1 = best.y1;
    if (gapUsed > 0 && lineFT) {
      const reg = chamferNearest(best.mask, ww, wh); const lim = gapUsed * 3 + 1; const grown = new Uint8Array(wn);
      for (let i = 0; i < wn; i++) {
        if (best.mask[i]) { grown[i] = 1; continue; }
        if (!wm[i] || reg.d[i]! > lim) continue;
        const px = i % ww, py = (i - px) / ww;
        const li = lineFT.near[i]!, ri = reg.near[i]!;
        const lx = li % ww - px, ly = (li - (li % ww)) / ww - py, rx = ri % ww - px, ry = (ri - (ri % ww)) / ww - py;
        if (lx * rx + ly * ry <= 0) { grown[i] = 1; if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py; }
      }
      region = grown;
    }
    m = new Uint8Array(n);
    for (let py = 0; py < wh; py++) m.set(region.subarray(py * ww, py * ww + ww), (py + wy0) * w + wx0);
    x0 = bx0 + wx0; y0 = by0 + wy0; x1 = bx1 + wx0; y1 = by1 + wy0;
    pixels = best.count;
    if (leaked && opts.stopLeaks) return { ...none, leaked: true, gapUsed, pixels };
  }
  mark("grow");
  // expand ring: pixels within `expand` px of the core (any colour), written under the line art;
  // computed on a window around the region bounds
  const core = m;
  let ring: Uint8Array | null = null;
  if (opts.expand > 0 || opts.antialias) {
    const padR = opts.expand + 2;
    const rx0 = Math.max(0, x0 - padR), ry0 = Math.max(0, y0 - padR), rx1 = Math.min(w - 1, x1 + padR), ry1 = Math.min(h - 1, y1 + padR);
    const rw0 = rx1 - rx0 + 1, rh0 = ry1 - ry0 + 1;
    const wc = new Uint8Array(rw0 * rh0);
    for (let py = 0; py < rh0; py++) wc.set(core.subarray((py + ry0) * w + rx0, (py + ry0) * w + rx0 + rw0), py * rw0);
    const dcore = chamfer(wc, rw0, rh0); const lim = opts.expand * 3;
    ring = new Uint8Array(n);
    for (let py = 0; py < rh0; py++) for (let px = 0; px < rw0; px++) {
      const li = py * rw0 + px; if (wc[li]) continue; const d = dcore[li]!;
      if (d <= lim) ring[(py + ry0) * w + px + rx0] = 1;
      else if (opts.antialias && d <= lim + 3) ring[(py + ry0) * w + px + rx0] = 2; // feather: outermost px at half alpha
    }
    x0 = Math.max(0, x0 - opts.expand - 1); y0 = Math.max(0, y0 - opts.expand - 1); x1 = Math.min(w - 1, x1 + opts.expand + 1); y1 = Math.min(h - 1, y1 + opts.expand + 1);
  }
  mark("ring");
  if (opts.maskOnly) {
    const sel = new Uint8Array(core); if (ring) for (let i = 0; i < n; i++) if (ring[i] === 1) sel[i] = 1;
    return { x0, y0, x1: x1 + 1, y1: y1 + 1, leaked, gapUsed, pixels, filled: false, mask: sel };
  }
  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
  const over = new ImageData(rw, rh), under = new ImageData(rw, rh);
  const cn = parseInt(color.slice(1), 16); const cr = (cn >> 16) & 255, cg = (cn >> 8) & 255, cb = cn & 255;
  for (let py = 0; py < rh; py++) for (let px = 0; px < rw; px++) {
    const gi = (py + y0) * w + (px + x0);
    const o = (py * rw + px) * 4;
    if (core[gi]) { over.data[o] = cr; over.data[o + 1] = cg; over.data[o + 2] = cb; over.data[o + 3] = 255; }
    else if (ring && ring[gi]) { under.data[o] = cr; under.data[o + 1] = cg; under.data[o + 2] = cb; under.data[o + 3] = ring[gi] === 2 ? 128 : 255; }
  }
  const fcOver = document.createElement("canvas"); fcOver.width = rw; fcOver.height = rh; fcOver.getContext("2d")!.putImageData(over, 0, 0);
  const fcUnder = document.createElement("canvas"); fcUnder.width = rw; fcUnder.height = rh; fcUnder.getContext("2d")!.putImageData(under, 0, 0);
  for (const t of target.tilesIn(x0, y0, x1 + 1, y1 + 1, true)) {
    if (!t.ctx) continue;
    const c = t.ctx as CanvasRenderingContext2D; const ox = x0 - t.x * TILE, oy = y0 - t.y * TILE;
    c.drawImage(fcOver, ox, oy);
    if (!underTarget) { c.globalCompositeOperation = "destination-over"; c.drawImage(fcUnder, ox, oy); c.globalCompositeOperation = "source-over"; }
    t.generation++;
  }
  if (underTarget) for (const t of underTarget.tilesIn(x0, y0, x1 + 1, y1 + 1, true)) {
    if (!t.ctx) continue;
    (t.ctx as CanvasRenderingContext2D).drawImage(fcUnder, x0 - t.x * TILE, y0 - t.y * TILE); t.generation++;
  }
  mark("write");
  return { x0, y0, x1: x1 + 1, y1: y1 + 1, leaked, gapUsed, pixels, filled: true };
}

/** Enclose-and-fill: fill a lasso polygon (DU) on the layer, anti-aliased by the canvas rasterizer. */
export function polygonFill(target: Layer, poly: Array<{ x: number; y: number }>, color: string, beforeWrite?: (layer: Layer, tx: number, ty: number) => void): DirtyRect {
  if (poly.length < 3) return emptyRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of poly) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  const tx0 = Math.floor(x0 / TILE), ty0 = Math.floor(y0 / TILE), tx1 = Math.floor(x1 / TILE), ty1 = Math.floor(y1 / TILE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) beforeWrite?.(target, tx, ty);
  for (const t of target.tilesIn(x0, y0, x1, y1, true)) {
    if (!t.ctx) continue;
    const c = t.ctx as CanvasRenderingContext2D; c.save(); c.translate(-t.x * TILE, -t.y * TILE);
    c.beginPath(); poly.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y))); c.closePath(); c.fillStyle = color; c.fill(); c.restore(); t.generation++;
  }
  return { x0, y0, x1, y1 };
}
