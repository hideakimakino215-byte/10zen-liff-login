// 五行の図(10ZEN のオリジナル。お席の QR カードの背景などに薄く敷く)。2026-10-16 牧野さんの依頼「五行の図をうっすら裏に(既存の図のままは使わない)」。
//   配置は一般的な五行の並び(上=木・右上=火・右下=土・左下=金・左上=水)。外周の円が相生(木→火→土→金→水→木の巡り)、内側の星形が相剋。
//   既存の図の意匠(立体の玉・縫い目の点線・矢印)は使わず、細い線と平らな円・明朝の漢字だけで描く。色は app-core/constitution.mjs の五行の色。
//   createElementNS だけで組み立てる(文字列を HTML として差し込まない)。
import { ELEMENTS, ELEMENT_INFO, ELEMENT_COLORS, ELEMENT_SOFT_COLORS, ELEMENT_TEXT_COLORS } from "./constitution.mjs";

const NS = "http://www.w3.org/2000/svg";
// 中心(100,100)・半径 r の五角形の頂点(木を真上から時計回り)
export function gogyoPoints(r = 70, cx = 100, cy = 100) {
  return Object.fromEntries(ELEMENTS.map((e, i) => { const a = (-90 + 72 * i) * Math.PI / 180; return [e, [Math.round((cx + r * Math.cos(a)) * 10) / 10, Math.round((cy + r * Math.sin(a)) * 10) / 10]]; }));
}
// 相剋(木→土→水→火→金→木): 五角形の1つ飛ばしの線
export const KOKU_PAIRS = Object.freeze([["wood", "earth"], ["earth", "water"], ["water", "fire"], ["fire", "metal"], ["metal", "wood"]]);

export function gogyoMarkSvg(doc, { id, className = "gogyo-mark" } = {}) {
  const mk = (tag, attrs = {}) => { const e = doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
  const svg = mk("svg", { viewBox: "0 0 200 200", class: className, "aria-hidden": "true", focusable: "false", ...(id ? { id } : {}) });
  const P = gogyoPoints();
  svg.append(mk("circle", { cx: 100, cy: 100, r: 70, fill: "none", stroke: "#b9ae9c", "stroke-width": 1.2 }));                       // 相生の巡り
  for (const [a, b] of KOKU_PAIRS) svg.append(mk("line", { x1: P[a][0], y1: P[a][1], x2: P[b][0], y2: P[b][1], stroke: "#cfc6b8", "stroke-width": 1, "stroke-dasharray": "3 4" }));   // 相剋
  for (const e of ELEMENTS) {
    const [x, y] = P[e];
    svg.append(mk("circle", { cx: x, cy: y, r: 19, fill: ELEMENT_SOFT_COLORS[e], stroke: ELEMENT_COLORS[e], "stroke-width": 1.6, "data-element": e }));
    const t = mk("text", { x, y: y + 6.5, "text-anchor": "middle", "font-size": 18, fill: ELEMENT_TEXT_COLORS[e], "font-family": "Hiragino Mincho ProN, Yu Mincho, Noto Serif JP, serif" });
    t.textContent = ELEMENT_INFO[e].kanji; svg.append(t);
  }
  return svg;
}
