/** How the terminals of a split tab share its space: one pane, or parts side
 * by side (a row) or stacked (a column), with each part's share of the length. */
export type Layout = { pane: string } | { dir: "row" | "column"; parts: Layout[]; sizes: number[] };

/** The edge of a pane another terminal goes on. */
export type Side = "left" | "right" | "top" | "bottom";

/** A tab holds this many terminals at most. */
export const MAX_PANES = 5;

/** A place in the tab's area, in fractions of its width and height. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line between two parts of a split, to drag. */
export interface Divider {
  /** The split, as part indexes from the top of the layout. */
  path: number[];
  /** The line is after this part. */
  index: number;
  dir: "row" | "column";
  /** The split's own area. */
  area: Rect;
  /** Where the line is: x for a row, y for a column. */
  at: number;
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

const even = (n: number) => Array.from({ length: n }, () => 1 / n);

/** The panes in order, left to right and top to bottom. */
export function panesOf(layout: Layout): string[] {
  return "pane" in layout ? [layout.pane] : layout.parts.flatMap(panesOf);
}

/** Lifts a part into its split when it runs the same way, drops splits of one
 * part, and makes the sizes add up to 1. */
function normalize(node: Layout): Layout {
  if ("pane" in node) return node;
  const parts: Layout[] = [];
  const sizes: number[] = [];
  node.parts.forEach((part, i) => {
    const p = normalize(part);
    if (!("pane" in p) && p.dir === node.dir) {
      p.parts.forEach((q, j) => {
        parts.push(q);
        sizes.push(node.sizes[i] * p.sizes[j]);
      });
    } else {
      parts.push(p);
      sizes.push(node.sizes[i]);
    }
  });
  if (parts.length === 1) return parts[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { dir: node.dir, parts, sizes: sizes.map((s) => s / total) };
}

/** Puts `add` on the `side` of the pane `target`. Panes in the same row or
 * column then share it evenly. */
export function insertPane(layout: Layout, target: string, side: Side, add: Layout): Layout {
  const dir = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "top";
  const visit = (node: Layout): Layout => {
    if ("pane" in node) {
      if (node.pane !== target) return node;
      return { dir, parts: before ? [add, node] : [node, add], sizes: [0.5, 0.5] };
    }
    const at = node.parts.findIndex((p) => "pane" in p && p.pane === target);
    if (at >= 0 && node.dir === dir) {
      const parts = [...node.parts];
      parts.splice(before ? at : at + 1, 0, add);
      return { dir, parts, sizes: even(parts.length) };
    }
    return { ...node, parts: node.parts.map(visit) };
  };
  return normalize(visit(layout));
}

/** The layout without the pane `id`; its space goes to the parts beside it.
 * Null when no pane is left. */
export function removePane(layout: Layout, id: string): Layout | null {
  if ("pane" in layout) return layout.pane === id ? null : layout;
  const parts: Layout[] = [];
  const sizes: number[] = [];
  layout.parts.forEach((part, i) => {
    const rest = removePane(part, id);
    if (rest) {
      parts.push(rest);
      sizes.push(layout.sizes[i]);
    }
  });
  if (!parts.length) return null;
  return normalize({ dir: layout.dir, parts, sizes });
}

/** Each pane's place. */
export function paneRects(layout: Layout, area: Rect = FULL, out = new Map<string, Rect>()): Map<string, Rect> {
  if ("pane" in layout) {
    out.set(layout.pane, area);
    return out;
  }
  let offset = 0;
  layout.parts.forEach((part, i) => {
    const size = layout.sizes[i];
    const rect =
      layout.dir === "row"
        ? { x: area.x + offset * area.w, y: area.y, w: size * area.w, h: area.h }
        : { x: area.x, y: area.y + offset * area.h, w: area.w, h: size * area.h };
    paneRects(part, rect, out);
    offset += size;
  });
  return out;
}

/** The lines between the parts of every split. */
export function dividers(layout: Layout, area: Rect = FULL, path: number[] = [], out: Divider[] = []): Divider[] {
  if ("pane" in layout) return out;
  let offset = 0;
  layout.parts.forEach((part, i) => {
    const size = layout.sizes[i];
    const rect =
      layout.dir === "row"
        ? { x: area.x + offset * area.w, y: area.y, w: size * area.w, h: area.h }
        : { x: area.x, y: area.y + offset * area.h, w: area.w, h: size * area.h };
    dividers(part, rect, [...path, i], out);
    offset += size;
    if (i < layout.parts.length - 1) {
      out.push({ path, index: i, dir: layout.dir, area, at: layout.dir === "row" ? area.x + offset * area.w : area.y + offset * area.h });
    }
  });
  return out;
}

/** Moves the line after part `index` of the split at `path` to `at`, a
 * fraction of that split's length, keeping both parts at least `min` long. */
export function resizeSplit(layout: Layout, path: number[], index: number, at: number, min: number): Layout {
  if ("pane" in layout) return layout;
  if (path.length) {
    const [head, ...rest] = path;
    return { ...layout, parts: layout.parts.map((p, i) => (i === head ? resizeSplit(p, rest, index, at, min) : p)) };
  }
  const sizes = [...layout.sizes];
  const start = sizes.slice(0, index).reduce((a, b) => a + b, 0);
  const pair = sizes[index] + sizes[index + 1];
  const first = Math.min(Math.max(at - start, min), pair - min);
  if (first <= 0 || first >= pair) return layout;
  sizes[index] = first;
  sizes[index + 1] = pair - first;
  return { ...layout, sizes };
}

/** The edge of `rect` nearest to the point x, y (in the same fractions). */
export function sideAt(rect: Rect, x: number, y: number): Side {
  const dx = (x - rect.x) / rect.w;
  const dy = (y - rect.y) / rect.h;
  const near: [Side, number][] = [
    ["left", dx],
    ["right", 1 - dx],
    ["top", dy],
    ["bottom", 1 - dy],
  ];
  return near.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

/** The half of `rect` on `side`. */
export function halfOf(rect: Rect, side: Side): Rect {
  if (side === "left") return { ...rect, w: rect.w / 2 };
  if (side === "right") return { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 };
  if (side === "top") return { ...rect, h: rect.h / 2 };
  return { ...rect, y: rect.y + rect.h / 2, h: rect.h / 2 };
}

/** The pane next to `from` in the direction of `side`, if any. */
export function paneTowards(layout: Layout, from: string, side: Side): string | null {
  const rects = paneRects(layout);
  const a = rects.get(from);
  if (!a) return null;
  const e = 1e-6;
  let best: { id: string; overlap: number } | null = null;
  for (const [id, b] of rects) {
    if (id === from) continue;
    const touches =
      side === "left" ? Math.abs(b.x + b.w - a.x) < e : side === "right" ? Math.abs(a.x + a.w - b.x) < e : side === "top" ? Math.abs(b.y + b.h - a.y) < e : Math.abs(a.y + a.h - b.y) < e;
    if (!touches) continue;
    const overlap =
      side === "left" || side === "right" ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (overlap > e && (!best || overlap > best.overlap)) best = { id, overlap };
  }
  return best?.id ?? null;
}
