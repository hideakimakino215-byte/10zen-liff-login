// 1分体質チェックの判定(見た目に依存しない・依存なし)。設計: CONSTITUTION_CHECK_DESIGN_20261015.md
// 判定の正本は DB(db/103_constitution_check.sql の _cc_result / _cc_focus / _tea_of_day)。ここは表示とテストのための同じ決め方の写し。
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

// 今日の体調(1問1タップ。選んだ五行に2点を足す)。value は DB に送るコード
export const CONDITION_QUESTIONS = Object.freeze([
  { key: "temp", label: "今日のからだは?", options: [{ value: "cold", label: "冷えている", element: "water" }, { value: "hot", label: "ほてっている", element: "fire" }, { value: "normal", label: "ふつう", element: null }] },
  { key: "energy", label: "今日の調子は?", options: [{ value: "tired", label: "疲れ・胃が重い", element: "earth" }, { value: "stress", label: "ストレス・張り", element: "wood" }, { value: "fine", label: "元気", element: null }] },
  { key: "concern", label: "今日気になることは?", options: [{ value: "dry", label: "乾燥・のど", element: "metal" }, { value: "swelling", label: "むくみ・だるさ", element: "earth" }, { value: "none", label: "特になし", element: null }] },
]);

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

// 今日の体調: 体質の点数に、選んだ五行の2点を足して、今日のおすすめの五行を決める(DB の _cc_focus と同じ)
export function conditionFocus(scores, { temp, energy, concern }, dateStr) {
  const t = { ...scores };
  for (const [q, v] of [[0, temp], [1, energy], [2, concern]]) {
    const el = CONDITION_QUESTIONS[q].options.find((o) => o.value === v)?.element;
    if (el) t[el] += 2;
  }
  return pickElement(t, seasonElement(dateStr));
}

// 五巡茶の日替わり(DB の _tea_of_day と同じ)
export function teaOfDay(dateStr) {
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return { 2: "fire", 3: "water", 4: "wood", 5: "metal", 6: "earth" }[dow] ?? seasonElement(dateStr);
}
