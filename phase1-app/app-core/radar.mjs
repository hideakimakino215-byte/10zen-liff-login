// 五角形(レーダー)グラフの座標の計算(見た目に依存しない・依存なし)。描画は各画面が inline SVG(createElementNS)で行う。
// 軸の順: 木(上)から時計回りに 火・土・金・水(五行の相生の順)。
import { ELEMENTS } from "./constitution.mjs";

const r2 = (x) => Math.round(x * 100) / 100;
// values: { wood, fire, earth, metal, water }(null は 0 として扱う)。max: 外周の値。rings: 目盛りの輪の数
export function radarGeometry(values, { max = 6, cx = 100, cy = 100, r = 70, rings = 3, labelGap = 16 } = {}) {
  const at = (i, k) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / ELEMENTS.length; return [r2(cx + Math.cos(a) * r * k), r2(cy + Math.sin(a) * r * k)]; };
  const pts = (k) => ELEMENTS.map((_, i) => at(i, k).join(",")).join(" ");
  const clamp = (v) => Math.max(0, Math.min(max, Number(v) || 0)) / max;
  return {
    rings: Array.from({ length: rings }, (_, j) => pts((j + 1) / rings)),
    axes: ELEMENTS.map((el, i) => { const [x, y] = at(i, 1); const [lx, ly] = at(i, 1 + labelGap / r); return { element: el, x, y, lx, ly }; }),
    polygon: ELEMENTS.map((el, i) => at(i, clamp(values?.[el])).join(",")).join(" "),
    dots: ELEMENTS.map((el, i) => { const [x, y] = at(i, clamp(values?.[el])); return { element: el, x, y }; }),
  };
}

// inline SVG の五角形グラフを組み立てる(createElementNS と textContent だけ。innerHTML・外部のライブラリは使わない)。
//   doc: document。labels: { wood: "木", … }(軸の名前)。見た目(色・線)は各画面の CSS で、class 名 radar-ring / radar-axis / radar-area / radar-dot / radar-label を使う
//   dotColors / labelColors: { wood: "#4f8a5b", … }(省略可。constitution.mjs の ELEMENT_COLORS / ELEMENT_TEXT_COLORS を渡す)。渡すと、頂点の点と軸の名前を五行ごとの色にする
//   (面は各画面の CSS のまま無彩色)。点の縁は labelColors の濃い色。色は #rrggbb だけを受け付ける(それ以外は無視して CSS の色のまま)。各点・各名前に data-element を付ける
const HEX = /^#[0-9a-fA-F]{6}$/;
export function radarSvg(doc, values, { labels = {}, max = 6, title = "", id, valueText = null, dotColors = null, labelColors = null } = {}) {
  const NS = "http://www.w3.org/2000/svg", g = radarGeometry(values, { max, cx: 120, cy: 112, r: 76, labelGap: 20 });
  const mk = (tag, attrs = {}, text) => { const e = doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text !== undefined) e.textContent = text; return e; };
  const color = (map, el) => (map && HEX.test(String(map[el] ?? "")) ? map[el] : null);
  const svg = mk("svg", { viewBox: "0 0 240 220", role: "img", class: "radar", ...(id ? { id } : {}) });
  if (title) svg.append(mk("title", {}, title));
  for (const p of g.rings) svg.append(mk("polygon", { points: p, class: "radar-ring" }));
  for (const a of g.axes) svg.append(mk("line", { x1: 120, y1: 112, x2: a.x, y2: a.y, class: "radar-axis" }));
  svg.append(mk("polygon", { points: g.polygon, class: "radar-area" }));
  for (const d of g.dots) {
    const fill = color(dotColors, d.element), edge = color(labelColors, d.element) ?? fill;
    svg.append(mk("circle", { cx: d.x, cy: d.y, r: fill ? 4.5 : 3, class: "radar-dot", "data-element": d.element,
      ...(fill ? { style: `fill:${fill};stroke:${edge};stroke-width:1.2` } : {}) }));
  }
  for (const a of g.axes) {
    const fill = color(labelColors, a.element);
    const t = mk("text", { x: a.lx, y: a.ly, class: "radar-label", "text-anchor": "middle", "dominant-baseline": "middle", "data-element": a.element,
      ...(fill ? { style: `fill:${fill};font-weight:700` } : {}) }, labels[a.element] ?? a.element);
    if (valueText) t.append(mk("tspan", { class: "radar-value", dx: 3 }, valueText(values?.[a.element])));
    svg.append(t);
  }
  return svg;
}
