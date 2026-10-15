// 1分体質チェックの判定(見た目に依存しない・依存なし。五行の色の定数だけは画面どうしで共有するためここに置く)。設計: CONSTITUTION_CHECK_DESIGN_20261015.md
// 判定の正本は DB(db/103_constitution_check.sql の _cc_result / _tea_of_day、db/107 の _cc_avg_result)。ここは表示とテストのための同じ決め方の写し。
// 一致は app-core/test_constitution.mjs が多数の回答と日付で確かめる。お客様向けの説明文は constitution-content.mjs に分けている。
export const ELEMENTS = ["wood", "fire", "earth", "metal", "water"];

// 五行・五臓・状態の名称(正式名称。タップした人にだけ見せる)と、表に出す言葉。正式名称は公開前に薬日本堂の方に確認してもらう(設計書 2章)
export const ELEMENT_INFO = Object.freeze({
  wood:  { kanji: "木", organ: "肝", state: "気滞(きたい)",          typeName: "モヤモヤ渋滞タイプ" },
  fire:  { kanji: "火", organ: "心", state: "偏熱(へんねつ)",        typeName: "カッカ熱こもりタイプ" },
  earth: { kanji: "土", organ: "脾", state: "脾虚(ひきょ)",          typeName: "消化パワー不足タイプ" },
  metal: { kanji: "金", organ: "肺", state: "燥(そう)・津虚(しんきょ)", typeName: "うるおい不足タイプ" },
  water: { kanji: "水", organ: "腎", state: "陽虚(ようきょ)",        typeName: "ぽかぽかパワー不足タイプ" },
});
export const BALANCED_NAME = "バランス良好";

// 五行の五色(2026-10-15 牧野さんの依頼「グラフが一色なので色つけて欲しい」)。白地で読みやすいように調整した色(金は白だと見えないので銀灰色)。
// グラフ(棒・五角形の点)・タイプの印はすべてここから使う(スタッフ画面・体質チェックの結果)。app-core/test_constitution.mjs が色とコントラストを確かめる。
//   ELEMENT_COLORS: 図形の色(棒・点・印の枠)。ELEMENT_TEXT_COLORS: 文字の色(白地・和紙色の地・ELEMENT_SOFT_COLORS の地で 4.5:1 以上になる濃いめの同系色)。
//   ELEMENT_SOFT_COLORS: タイプの印の淡い地。NEUTRAL_COLOR: どの五行でもないもの(バランス良好・ふつう・元気・特になし)。金(銀灰色)と区別するため、棒は斜線にする
export const ELEMENT_COLORS = Object.freeze({ wood: "#4f8a5b", fire: "#c2553f", earth: "#c39a2e", metal: "#8e99a6", water: "#2f3a56" });
export const ELEMENT_TEXT_COLORS = Object.freeze({ wood: "#42744c", fire: "#ab4b37", earth: "#81661e", metal: "#616871", water: "#2f3a56" });
export const ELEMENT_SOFT_COLORS = Object.freeze({ wood: "#e6efe8", fire: "#f6e7e4", earth: "#f7f1e2", metal: "#eff1f3", water: "#e2e3e7" });
export const NEUTRAL_COLOR = "#b8bfc8";

// 15問(設計書 3章の表のとおり。1〜3問=木、4〜6問=火、7〜9問=土、10〜12問=金、13〜15問=水)
export const QUESTIONS = Object.freeze([
  { no: 1,  element: "wood",  text: "イライラしたり、気分の浮き沈みが大きい" },
  { no: 2,  element: "wood",  text: "目が疲れやすい・かすみやすい" },
  { no: 3,  element: "wood",  text: "ため息が多い・お腹や胸が張る" },
  { no: 4,  element: "fire",  text: "寝つきが悪い・夢をよく見る" },
  { no: 5,  element: "fire",  text: "顔がほてる・赤くなりやすい" },
  { no: 6,  element: "fire",  text: "ドキドキしやすい・汗をかきやすい" },
  { no: 7,  element: "earth", text: "食後に眠くなる・胃がもたれる" },
  { no: 8,  element: "earth", text: "むくみやすい・湿気の多い日はだるい" },
  { no: 9,  element: "earth", text: "考えすぎると食欲が落ちる・甘いものが欲しくなる" },
  { no: 10, element: "metal", text: "肌・髪・のどが乾燥しやすい" },
  { no: 11, element: "metal", text: "風邪をひきやすい・鼻やのどの不調が出やすい" },
  { no: 12, element: "metal", text: "便が硬い・出にくい" },
  { no: 13, element: "water", text: "手足や腰が冷えやすい" },
  { no: 14, element: "water", text: "夜中にトイレに起きる・トイレが近い" },
  { no: 15, element: "water", text: "腰や膝がだるい・髪のハリが気になる" },
]);
export const ANSWER_OPTIONS = Object.freeze([{ value: 2, label: "よくある" }, { value: 1, label: "ときどき" }, { value: 0, label: "あまりない" }]);
export const CONSENT_VERSION = "constitution_v1";

// 五巡茶の曜日(曜日の名前どおり)。月曜・日曜は今の季節の五行
const WEEKDAYS = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
export const TEA_WEEKDAY = Object.freeze({ fire: 2, water: 3, wood: 4, metal: 5, earth: 6 });   // 0=日曜
export const teaWeekdayText = (el) => (el in TEA_WEEKDAY ? WEEKDAYS[TEA_WEEKDAY[el]] : null);
export const weekdayText = (dateStr) => WEEKDAYS[new Date(dateStr + "T00:00:00Z").getUTCDay()];

// 日本時間の日付(YYYY-MM-DD)
export const jstDate = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const md = (dateStr) => Number(dateStr.slice(5, 7)) * 100 + Number(dateStr.slice(8, 10));

// 季節の五行。土用(土)は立春・立夏・立秋・立冬の前の約18日を、年によらない固定の日付で近似する(1/17〜2/3・4/17〜5/4・7/20〜8/6・10/20〜11/6。両端を含む)
export function seasonElement(dateStr) {
  const x = md(dateStr);
  if ((x >= 117 && x <= 203) || (x >= 417 && x <= 504) || (x >= 720 && x <= 806) || (x >= 1020 && x <= 1106)) return "earth";
  if (x >= 301 && x <= 531) return "wood";
  if (x >= 601 && x <= 831) return "fire";
  if (x >= 901 && x <= 1130) return "metal";
  return "water";
}
// 季節の鍵(102 の _season_of と同じ。冬は12月の年。例 2026-winter は 2026/12〜2027/2)。季節が変わったかの判定に使う
export function seasonKey(dateStr) {
  const y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
  if (m >= 3 && m <= 5) return `${y}-spring`;
  if (m >= 6 && m <= 8) return `${y}-summer`;
  if (m >= 9 && m <= 11) return `${y}-autumn`;
  return m === 12 ? `${y}-winter` : `${y - 1}-winter`;
}

// 一番高い五行。同点は季節の五行を優先し、それでも決まらなければ 木・火・土・金・水 の順で先のもの
export function pickElement(scores, season) {
  const mx = Math.max(...ELEMENTS.map((e) => scores[e]));
  const tied = ELEMENTS.filter((e) => scores[e] === mx);
  return tied.includes(season) ? season : tied[0];
}

// 15問の回答(各 0〜2)→ 五行ごとの点数。形が違えば null
export function scoreAnswers(answers) {
  if (!Array.isArray(answers) || answers.length !== 15 || !answers.every((a) => Number.isInteger(a) && a >= 0 && a <= 2)) return null;
  const s = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  answers.forEach((a, i) => { s[ELEMENTS[Math.floor(i / 3)]] += a; });
  return s;
}

// 判定(DB の _cc_result と同じ形): { scores, primary, balanced(全部1点以下), seasonElement }
export function evaluate(answers, dateStr) {
  const scores = scoreAnswers(answers); if (!scores) return null;
  const se = seasonElement(dateStr);
  return { scores, primary: pickElement(scores, se), balanced: Math.max(...ELEMENTS.map((e) => scores[e])) <= 1, seasonElement: se };
}

// あなたの体質(DB の _cc_avg_result と同じ。db/107): 五行ごとの合計 sums(回数 n 回分)→ 平均(小数2桁)・主なタイプ・バランス良好。
//   比べるのは合計(回数が同じなので平均と同じ順・端数の誤差なし)。同点は season(平均に入れた回のうち最新の回の季節の五行)を優先。平均がすべて1点以下ならバランス良好
const round2 = (x) => Math.round(x * 100) / 100;
export function averageResult(sums, n, season) {
  if (!Number.isInteger(n) || n < 1 || !sums || !ELEMENTS.every((e) => Number.isInteger(sums[e]))) return null;
  return { count: n, scores: Object.fromEntries(ELEMENTS.map((e) => [e, round2(sums[e] / n)])), primary: pickElement(sums, season),
           balanced: Math.max(...ELEMENTS.map((e) => sums[e])) <= n };
}
export const PROFILE_CHECKS = 3;
// checks: 新しい順の結果 [{ scores, seasonElement }, …] → 最新の3回(3回未満ならその回数)の averageResult。0回は null
export function profileOf(checks) {
  const l = (Array.isArray(checks) ? checks : []).slice(0, PROFILE_CHECKS); if (!l.length) return null;
  const sums = Object.fromEntries(ELEMENTS.map((e) => [e, l.reduce((a, c) => a + c.scores[e], 0)]));
  return averageResult(sums, l.length, l[0].seasonElement);
}

// 五巡茶の日替わり(DB の _tea_of_day と同じ)
export function teaOfDay(dateStr) {
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return { 2: "fire", 3: "water", 4: "wood", 5: "metal", 6: "earth" }[dow] ?? seasonElement(dateStr);
}
