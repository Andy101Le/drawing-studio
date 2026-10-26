/**
 * Tool icons: original 24 px line glyphs (1.5 px stroke, round joins) in the studio's
 * monochrome silver. Each one shows the tool in use rather than the object alone:
 * the brush leaves a tapered stroke, the eraser a cleared gap in a line, the pen nib a
 * bezier it is tracing, the bucket pours into a region, the wand selects a dashed blob,
 * the knife cuts a panel in two, the eyedropper lifts a drop from a swatch.
 */
const S = (body: string, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

export const ICONS: Record<string, string> = {
  // script: a page with lines and a quote mark, for the story script
  script: S(`<path d="M6 3.5 H15 L19 7.5 V20.5 H6 Z"/><path d="M15 3.5 V7.5 H19"/><path d="M8.5 11 H16.5 M8.5 14 H16.5 M8.5 17 H13"/>`),
  // photos: two stacked picture frames, for the training set
  photos: S(`<rect x="3" y="7" width="13" height="11" rx="1.5"/><path d="M5 16 L8.5 12 L11 14.5 L12.5 13 L15 16"/><path d="M8 4.5 H19 A1.5 1.5 0 0 1 20.5 6 V15"/><circle cx="7" cy="10" r="1.2"/>`),
  // redraw: a picture frame with a pen tracing over it
  redraw: S(`<rect x="2.5" y="3.5" width="13" height="11" rx="1.5" opacity=".55"/><path d="M5 12 L8 8.5 L10.5 11 L12 9.5 L14 12" opacity=".55"/><path d="M13 21.5 L21.5 13 L19 10.5 L10.5 19 L10 22 Z"/><path d="M17.5 12 L20 14.5"/>`),
  // round brush: handle, ferrule, tuft, and the pressure-tapered stroke it leaves
  brush: S(`<path d="M21 2.5 L11.5 12"/><path d="M12.5 13 L10.5 11 L19.5 2 L22 4.5 Z" fill="currentColor" opacity=".3"/><path d="M10.5 11 C7.5 11.5 6.5 13.5 6 16 C5.5 18.5 4.5 19.5 2.5 20.5 C6.5 21.5 9.5 20.5 11 18 C12.5 15.5 12.5 13.5 12.5 13"/><path d="M2.5 23 Q8 21.5 13 23 Q18 24.5 22 22" stroke-width="2.4" opacity=".5"/><path d="M2.5 23 Q8 21.5 13 23 Q18 24.5 22 22" stroke-width=".9"/>`),
  // eraser: block eraser, the line it is clearing, dust at the edge
  eraser: S(`<path d="M2 15.5 L11 6.5 L17.5 13 L10 20.5 L6 20.5 Z"/><path d="M7.5 10 L14 16.5"/><path d="M2 20.5 L6 20.5"/><path d="M13 21.5 L22 21.5" stroke-dasharray="1 2.2"/><path d="M14 3.5 L22 3.5 M19 6.5 L22 6.5"/>`),
  // vector pen: nib with ink slit on a bezier it is tracing, anchor at the tip
  vector: S(`<path d="M3 21 C7 13 11 10 19 9"/><circle cx="19" cy="9" r="1.6" fill="currentColor"/><path d="M12 3 L15.5 6.5 L8.5 13.5 L5 13.5 L5 10 Z"/><path d="M8 11 L11 8"/><path d="M12 3 L14 1 L17.5 4.5 L15.5 6.5"/>`),
  // node edit: anchor with tangent handles on a curve, arrow pointer grabbing one
  node: S(`<path d="M3 19 C7 7 13 7 20 13"/><path d="M6.5 11.5 L13 7.5 L18 10.5" opacity=".7"/><circle cx="6.5" cy="11.5" r="1.5" fill="currentColor"/><circle cx="18" cy="10.5" r="1.5" fill="currentColor"/><rect x="10.8" y="5.3" width="4.4" height="4.4" fill="#0f0f0f"/><path d="M14 14 L21 16.5 L18.2 17.6 L17 20.5 Z" fill="currentColor"/>`),
  // fill: bucket tipping, paint pouring, region filling under the ink line
  fill: S(`<path d="M9 3 L19.5 9 L12.5 19 L2.5 13 Z"/><path d="M5.5 10.5 Q10.5 7 15.5 10.5" opacity=".5"/><path d="M19.5 9 L22 13 Q22.5 16 20.5 16.5 Q18.5 16 19 13 Z" fill="currentColor" opacity=".6"/><path d="M2 21.5 Q8 20 14 21.5 Q18 22.5 22 21" stroke-width="2" opacity=".35"/>`),
  // marquee: dashed selection rectangle being dragged from a corner
  select: S(`<rect x="3.5" y="4.5" width="13" height="11" stroke-dasharray="2.5 2"/><path d="M16.5 15.5 L21.5 20.5"/><path d="M16.5 15.5 L21 16.5 L19 18.5 Z" fill="currentColor"/><path d="M3.5 4.5 L1.5 4.5 M3.5 4.5 L3.5 2.5"/>`),
  // magic wand: wand with sparks over a dashed blob it just selected
  wand: S(`<path d="M3 21 L13 11"/><path d="M13 11 L15.5 8.5" stroke-width="2.4"/><path d="M17 3 L17.6 5.4 L20 6 L17.6 6.6 L17 9 L16.4 6.6 L14 6 L16.4 5.4 Z" fill="currentColor"/><path d="M21 10.5 L21 12.5 M20 11.5 L22 11.5"/><path d="M4 11 Q3 6 7.5 6.5 Q11 7 10 10.5 Q9 13.5 5.5 13 Q3.5 12.5 4 11 Z" stroke-dasharray="1.8 1.6"/>`),
  // move: floating pixels with transform frame and four-way arrow
  move: S(`<rect x="7" y="7" width="10" height="10" stroke-dasharray="2 1.5"/><path d="M12 2.5 V7 M12 17 V21.5 M2.5 12 H7 M17 12 H21.5"/><path d="M12 2.5 L10 4.5 M12 2.5 L14 4.5 M12 21.5 L10 19.5 M12 21.5 L14 19.5 M2.5 12 L4.5 10 M2.5 12 L4.5 14 M21.5 12 L19.5 10 M21.5 12 L19.5 14"/>`),
  // pan: open hand dragging the page
  pan: S(`<path d="M8 11.5 V5.5 Q8 4 9.5 4 Q11 4 11 5.5 V10.5"/><path d="M11 5 Q11 3.5 12.5 3.5 Q14 3.5 14 5 V10.5"/><path d="M14 6.5 Q14 5 15.5 5 Q17 5 17 6.5 V13"/><path d="M17 13 Q17 19.5 12.5 20.5 H11 Q7.5 20.5 5.5 17 L3.5 13.5 Q2.8 12 4.3 11.5 Q5.5 11.2 6.3 12.5 L8 14.5"/><path d="M19 9 L22 9 M20.5 7.5 L22 9 L20.5 10.5" opacity=".6"/>`),
  // zoom: magnifier with plus and a grid being enlarged
  zoom: S(`<circle cx="10" cy="10" r="6.5"/><path d="M15 15 L21.5 21.5" stroke-width="2.2"/><path d="M7.5 10 H12.5 M10 7.5 V12.5"/><path d="M3 20 H6 M3 20 V17" opacity=".5"/>`),
  // rotate: page corner swinging on an arc around a pivot
  rotate: S(`<path d="M19.5 12 A7.5 7.5 0 1 1 12 4.5"/><path d="M12 1.5 L15 4.5 L12 7.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><path d="M9 15 L15 15 L15 20 L9 20 Z" opacity=".45" transform="rotate(-20 12 17.5)"/>`),
  // panel cut: knife slicing a panel frame into two, gutter appearing
  "panel-cut": S(`<rect x="3" y="4" width="18" height="16"/><path d="M14.5 4 L9.5 20" stroke-width="2.6" stroke="#0f0f0f"/><path d="M15.5 4 L10.5 20 M13.5 4 L8.5 20" opacity=".9"/><path d="M19 1.5 L11.5 11.5" stroke-width="1.8"/><path d="M11.5 11.5 L9.5 15 L13 13 Z" fill="currentColor"/>`),
  // eyedropper: pipette lifting a drop from a swatch square
  eyedrop: S(`<path d="M16.5 3 L21 7.5 L17.5 11 L13 6.5 Z"/><path d="M13 6.5 L6.5 13 L5.5 18.5 L11 17.5 L17.5 11"/><path d="M19.5 1.5 L22.5 4.5"/><path d="M8 14 L10.5 16.5"/><rect x="2" y="2" width="6" height="6" fill="currentColor" opacity=".35"/><path d="M4 21 Q3 23 5 23 Q7 23 6 21 L5 19 Z" fill="currentColor" opacity=".8"/>`),
  // text / balloon: speech balloon with tail and a glyph inside
  text: S(`<path d="M12 3 C17.5 3 21.5 6 21.5 10 C21.5 14 17.5 17 12 17 C10.5 17 9 16.8 7.8 16.4 L3.5 19.5 L5 15 C3.4 13.7 2.5 12 2.5 10 C2.5 6 6.5 3 12 3 Z"/><path d="M9 7.5 H15 M12 7.5 V13"/>`),
  // ruler: straight edge with ticks and a stroke snapping along it
  ruler: S(`<path d="M2 17 L17 2 L22 7 L7 22 Z"/><path d="M6 18 L8 16 M9 15 L10.5 13.5 M12 12 L14 10 M15 9 L16.5 7.5 M18 6 L19.5 4.5"/><path d="M3 8 L10 1" stroke-dasharray="2 1.5" opacity=".6"/>`),
  // perspective ruler: two lines converging on a vanishing point on the horizon
  perspective: S(`<path d="M2 8 H22" stroke-dasharray="2 2" opacity=".6"/><circle cx="12" cy="8" r="1.5" fill="currentColor"/><path d="M12 8 L2.5 21 M12 8 L21.5 21 M12 8 L6 21 M12 8 L18 21"/><path d="M5 17 H19" opacity=".6"/>`),
  layers: S(`<path d="M12 3 L21 8 L12 13 L3 8 Z"/><path d="M3 12 L12 17 L21 12"/><path d="M3 16 L12 21 L21 16"/>`),
  palette: S(`<path d="M12 3 C6.5 3 2.5 7 2.5 11.5 C2.5 16 6 19.5 10 19.5 C11.5 19.5 12 18.5 12 17.5 C12 16.5 11.5 16 11.5 15 C11.5 14 12.3 13.3 13.3 13.3 H15.5 C19 13.3 21.5 11 21.5 8.5 C21.5 5.5 17 3 12 3 Z"/><circle cx="7.5" cy="10" r="1.3" fill="currentColor"/><circle cx="11" cy="7" r="1.3" fill="currentColor"/><circle cx="15.5" cy="7.5" r="1.3" fill="currentColor"/>`),
  tone: S(`<rect x="3" y="3" width="18" height="18" rx="1.5"/><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor"/><circle cx="12" cy="7.5" r="1.3" fill="currentColor"/><circle cx="16.5" cy="7.5" r="1.3" fill="currentColor"/><circle cx="7.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="16.5" cy="12" r="1.3" fill="currentColor"/><circle cx="7.5" cy="16.5" r="1.3" fill="currentColor"/><circle cx="12" cy="16.5" r="1.3" fill="currentColor"/><circle cx="16.5" cy="16.5" r="1.3" fill="currentColor"/>`),
  book: S(`<path d="M3 4.5 H10 C11.2 4.5 12 5.3 12 6.5 V20 C12 19 11.2 18.5 10 18.5 H3 Z"/><path d="M21 4.5 H14 C12.8 4.5 12 5.3 12 6.5 V20 C12 19 12.8 18.5 14 18.5 H21 Z"/><path d="M5.5 8.5 H9.5 M5.5 11.5 H9.5 M14.5 8.5 H18.5"/>`),
  page: S(`<path d="M6 2.5 H14.5 L19.5 7.5 V21.5 H6 Z"/><path d="M14.5 2.5 V7.5 H19.5"/><path d="M8.5 12 H17 M8.5 15.5 H17 M8.5 19 H13"/>`),
  cube: S(`<path d="M12 2.5 L20.5 7 V17 L12 21.5 L3.5 17 V7 Z"/><path d="M3.5 7 L12 11.5 L20.5 7 M12 11.5 V21.5"/>`),
  link: S(`<path d="M10 14 L14 10"/><path d="M8.5 15.5 L6.5 17.5 A3.5 3.5 0 0 1 1.5 12.5 L5 9 A3.5 3.5 0 0 1 10 9"/><path d="M15.5 8.5 L17.5 6.5 A3.5 3.5 0 0 1 22.5 11.5 L19 15 A3.5 3.5 0 0 1 14 15"/>`),
  lock: S(`<rect x="5" y="10.5" width="14" height="11" rx="1.5"/><path d="M8 10.5 V7.5 A4 4 0 0 1 16 7.5 V10.5"/><circle cx="12" cy="16" r="1.4" fill="currentColor"/>`),
  gear: S(`<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5 V5.5 M12 18.5 V21.5 M2.5 12 H5.5 M18.5 12 H21.5 M5.3 5.3 L7.4 7.4 M16.6 16.6 L18.7 18.7 M5.3 18.7 L7.4 16.6 M16.6 7.4 L18.7 5.3"/>`),
  gradient: S(`<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 4 H11 V20 H3 Z" fill="currentColor" opacity=".55"/><path d="M11 4 H15 V20 H11 Z" fill="currentColor" opacity=".3"/><path d="M15 4 H18 V20 H15 Z" fill="currentColor" opacity=".12"/><path d="M6 12 L19 12 M16 9.5 L19 12 L16 14.5" stroke="#0f0f0f" stroke-width="2.4"/><path d="M6 12 L19 12 M16 9.5 L19 12 L16 14.5"/>`),
  spark: S(`<path d="M12 3 L13.8 9.2 L20 11 L13.8 12.8 L12 19 L10.2 12.8 L4 11 L10.2 9.2 Z"/><path d="M19 3 L19.6 5 L21.5 5.6 L19.6 6.2 L19 8 L18.4 6.2 L16.5 5.6 L18.4 5 Z"/><path d="M5 16 L5.5 17.5 L7 18 L5.5 18.5 L5 20 L4.5 18.5 L3 18 L4.5 17.5 Z"/>`),
  live: S(`<circle cx="9" cy="8" r="3.2"/><path d="M3 19 C3 15 5.5 13.5 9 13.5 C12.5 13.5 15 15 15 19"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 13.5 C19 13.5 21.5 15 21.5 18.5"/><circle cx="19.5" cy="4" r="1.2" fill="currentColor"/>`),
  undo: S(`<path d="M8 7 L3 11.5 L8 16"/><path d="M3.5 11.5 H14 C18 11.5 20.5 14 20.5 17 C20.5 19 19.5 20.5 18 21"/>`),
  redo: S(`<path d="M16 7 L21 11.5 L16 16"/><path d="M20.5 11.5 H10 C6 11.5 3.5 14 3.5 17 C3.5 19 4.5 20.5 6 21"/>`),
};

export function icon(name: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "icon"; span.innerHTML = ICONS[name] ?? "";
  span.style.display = "inline-grid"; span.style.placeItems = "center"; span.style.lineHeight = "0";
  return span;
}
