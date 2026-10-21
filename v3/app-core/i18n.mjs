// お客様向けの画面(会員証・体質チェック・Web 版・店頭の QR)の多言語(2026-10-17 牧野さん決定: 英語・中国語(簡体字)。
// LINE の言語に合わせて自動で選び、画面の上の「日本語 / English / 中文」でも切り替えられる。店頭の QR 画面は3か国語を並べる)。
//  * 日本語は constitution.mjs / constitution-content.mjs の文をそのまま使う(日本語の表示は今までと同じ)。英語・中国語はここに置く。
//  * 言葉づかいのきまりは日本語と同じ: 治る・効く・改善(英語 cure / treat / heal / improve / effective、中国語 治疗 / 治愈 / 疗效 / 改善 / 功效 / 见效)を使わない。
//    (中国語の「有效」は有効期限の意味では使う。効き目の意味の 功效・见效・有效果 は使わない)。アレルギーは「大丈夫」と言わずスタッフへ。体質は「傾向の目安」で診断ではない。test_i18n.mjs が確かめる。
//  * 文案(翻訳の下書き)。英語・中国語のわかる方の確認と、薬日本堂の表現チェックの前。
//  * スタッフ画面は日本語のまま。
import * as JA from "./constitution-content.mjs";
import { ELEMENT_INFO, BALANCED_NAME, ALL_HIGH_NAME, QUESTIONS, ANSWER_OPTIONS } from "./constitution.mjs";
import { ORDER_LABEL, ORDER_BUTTON, ORDER_BUTTON_TABLE, ORDER_NOT_DINII, ORDER_NO_SCAN, ORDER_NOTE } from "./dinii.mjs";

export const LANGS = Object.freeze(["ja", "en", "zh"]);
export const LANG_LABELS = Object.freeze({ ja: "日本語", en: "English", zh: "中文" });
export const HTML_LANG = Object.freeze({ ja: "ja", en: "en", zh: "zh-Hans" });
export const LANG_KEY = "10zen_lang";
// "en-US" → en、"zh-CN" / "zh-Hans" / "zh-TW" → zh(繁体字はまだないので簡体字)、それ以外 → null
export function normalizeLang(code) {
  const c = String(code ?? "").trim().toLowerCase();
  if (!c) return null;
  if (c === "ja" || c.startsWith("ja-")) return "ja";
  if (c === "en" || c.startsWith("en-")) return "en";
  if (c === "zh" || c.startsWith("zh-") || c.startsWith("zh_")) return "zh";
  return null;
}
// 選んだ言語(端末に覚えたもの)→ LINE の言語 → ブラウザの言語 → 日本語。知らない言語(韓国語など)は英語
export function detectLang({ stored, liff, nav } = {}) {
  const s = normalizeLang(stored); if (s) return s;
  for (const c of [liff, ...(Array.isArray(nav) ? nav : [nav])]) { if (!c) continue; return normalizeLang(c) ?? "en"; }
  return "ja";
}
export function storedLang(storage) { try { return storage?.getItem(LANG_KEY) ?? null; } catch (_e) { return null; } }
export function saveLang(storage, lang) { try { if (LANGS.includes(lang)) storage?.setItem(LANG_KEY, lang); } catch (_e) { /* 使えない端末 */ } }
// 画面の上の切り替え(button を createElement で組む。文字列を HTML として差し込まない)
export function langSwitcher(doc, current, onPick) {
  const nav = doc.createElement("nav"); nav.className = "lang"; nav.id = "langSwitch"; nav.setAttribute("aria-label", "Language");
  for (const l of LANGS) {
    const b = doc.createElement("button"); b.type = "button"; b.textContent = LANG_LABELS[l]; b.dataset.lang = l; b.lang = HTML_LANG[l];
    if (l === current) b.setAttribute("aria-current", "true");
    b.onclick = () => { if (l !== current) onPick(l); };
    nav.append(b);
  }
  return nav;
}

// 中国語の句読点: 文案は半角・日本語の記号で書き、表示のときに簡体字の記号(，（）：？ · “” ～)にする。数字の間(1,000 / 11:00)と URL はそのまま
const URL_RE = /(https?:\/\/\S+)/;
export function zhPunct(text) {
  if (typeof text !== "string") return text;
  return text.split(URL_RE).map((part, i) => (i % 2 ? part : part.replace(/[,:]\s?/g, (m, off, str) => (/\d/.test(str[off - 1] ?? "") && /\d/.test(str[off + 1] ?? "") ? m : m[0] === "," ? "，" : "："))
    .replace(/\(/g, "（").replace(/\)/g, "）").replace(/\?/g, "？").replace(/・/g, "·").replace(/「/g, "“").replace(/」/g, "”").replace(/〜/g, "～"))).join("");
}
// 本文の中のかっこ書き: 日本語は今までどおり半角、英語は前に空白、中国語は全角
export const paren = (s, lang = "ja") => (lang === "zh" ? `（${s}）` : lang === "en" ? ` (${s})` : `(${s})`);
export function punctDeep(v) {
  if (typeof v === "string") return zhPunct(v);
  if (typeof v === "function") return (...a) => punctDeep(v(...a));
  if (Array.isArray(v)) return Object.freeze(v.map(punctDeep));
  if (v && typeof v === "object") return Object.freeze(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, punctDeep(x)])));
  return v;
}

const EL = ["wood", "fire", "earth", "metal", "water"];
const pick = (o) => Object.freeze(Object.fromEntries(EL.map((e) => [e, o[e]])));

// ---- 体質チェックの中身(日本語は constitution-content.mjs / constitution.mjs) ----
const JA_CC = {
  kanji: pick(Object.fromEntries(EL.map((e) => [e, ELEMENT_INFO[e].kanji]))),
  typeName: pick(Object.fromEntries(EL.map((e) => [e, ELEMENT_INFO[e].typeName]))),
  organ: pick(Object.fromEntries(EL.map((e) => [e, ELEMENT_INFO[e].organ]))),
  state: pick(Object.fromEntries(EL.map((e) => [e, ELEMENT_INFO[e].state]))),
  balancedName: BALANCED_NAME, allHighName: ALL_HIGH_NAME,
  questions: QUESTIONS.map((q) => q.text), answers: Object.fromEntries(ANSWER_OPTIONS.map((a) => [a.value, a.label])),
  typeLines: JA.TYPE_LINES, teaLines: JA.TEA_LINES, teaName: JA.TEA_NAME, seasonNames: JA.SEASON_NAMES, seasonLines: JA.SEASON_LINES,
  moodQuestion: JA.MOOD_QUESTION, moods: Object.fromEntries(JA.MOODS.map((m) => [m.code, m.label])), dishReasons: JA.DISH_REASONS,
  weekdays: ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"],
  checkName: JA.CHECK_NAME, disclaimer: JA.DISCLAIMER, nihondoLead: JA.NIHONDO_LEAD, nihondoButton: JA.NIHONDO_BUTTON, yourTeaDay: JA.yourTeaDayText,
  consent: JA.CONSENT_TEXT, intro: JA.INTRO_TEXT, todayTitle: JA.TODAY_CHECK_TITLE, todaySkip: JA.TODAY_SKIP, todayLabel: JA.TODAY_LABEL,
  profileLabel: JA.PROFILE_LABEL, yourTeaLabel: JA.YOUR_TEA_LABEL, todayCheckText: JA.TODAY_CHECK_TEXT, todayStart: JA.TODAY_START, historyLabel: JA.HISTORY_LABEL,
  latestLabel: JA.latestLabel, profileBasis: JA.profileBasisText, webIntro: JA.WEB_INTRO_TEXT, webPrivacy: JA.WEB_PRIVACY_NOTE, webCtaLead: JA.WEB_CTA_LEAD,
  webCtaButton: JA.WEB_CTA_BUTTON, evenNote: JA.EVEN_PICK_NOTE, registerLead: JA.CHECK_REGISTER_LEAD, registerButton: JA.CHECK_REGISTER_BUTTON, resume: JA.RESUME_BUTTON,
  // 体質チェックの画面(check.html / web-check.html)の部品
  introLabel: "はじめに", start: "はじめる", agreeStart: "同意してはじめる", back: "‹ 戻る", making: "結果を作っています…", loading: "読み込み中…",
  detailOpen: "五行・五臓・正式名称を見る", detailClose: "閉じる", formal: (k, o, s) => `五行: ${k} / 五臓: ${o} / 状態: ${s}`, organLine: (o, s) => `五臓: ${o} / ${s}`, points: (x) => `${x}点`,
  radarTitle: "五行ごとの点数(0〜6)", profileRadarTitle: "あなたの体質: 五行ごとの点数の平均(0〜6)", resultLabel: "あなたの体質の傾向",
  historyTitle: (h) => `${h}(新しい順・最大6回)`, dishToday: "今日のおすすめの一品(今日の傾向から)", dishLatest: "おすすめの一品(前回の傾向から)",
  todayTeaLabel: (w) => `今日の五巡茶(${w})`, seasonLabel: (s) => `季節のひとこと(${s})`, toCard: "会員証へ戻る", toCardShort: "会員証を見る", retake: "もう一度チェックする",
  retry: "もう一度試す", openInLine: "LINE アプリで開いてください", preparing: "ただいま体質チェックは準備中です", registerFailed: "登録できませんでした。もう一度お試しください",
  dishPending: "", balancedKanji: "バランス", allHighKanji: "全体", entryDone: "体質の結果と推移を見る",
  // 外部レビュー(2026-10-20): 五角形の点数の意味と五行の説明(薬日本堂の表現チェックに追加して確認する)
  radarNote: "点数が高いほど、その傾向にあてはまる回答が多かったことを示します(各0〜6点)。健康状態の良し悪しを示す点数ではありません。",
  gogyoNote: "五行は、自然やからだのはたらきを木・火・土・金・水の5つに分けて考える、東洋医学の考え方です。",
  // 2026-10-20 牧野さん決定(A): Web 版の結果は会員証に引き継がれないことを登録の案内に添える
  webNoCarry: "今回の結果は会員証には引き継がれません。登録後に会員証でチェックすると、その結果を記録できます。",
  // 英語・中国語の方だけ: 行き先が青山本店(日本語のページ)なので、事前の電話をすすめる(日本語では出さない)
  nihondoNote: "", nihondoTel: "",
};

const EN_CC = {
  kanji: pick({ wood: "Wood", fire: "Fire", earth: "Earth", metal: "Metal", water: "Water" }),
  typeName: pick({ wood: "The Tense & Stuck Type", fire: "The Running-Warm Type", earth: "The Low-Digestion-Energy Type", metal: "The Needs-Moisture Type", water: "The Runs-Cold Type" }),
  organ: pick({ wood: "Liver", fire: "Heart", earth: "Spleen", metal: "Lung", water: "Kidney" }),
  state: pick({ wood: "Qi stagnation", fire: "Excess heat", earth: "Spleen deficiency", metal: "Dryness / low fluids", water: "Yang deficiency" }),
  balancedName: "Well Balanced", allHighName: "The Easily-Swayed-Overall Type",
  questions: [
    "I get irritated easily, or my mood goes up and down a lot",
    "My eyes tire easily or my vision gets blurry",
    "I sigh often, or my stomach or chest feels tight",
    "I have trouble falling asleep, or I dream a lot",
    "My face feels flushed or turns red easily",
    "My heart races easily, or I sweat easily",
    "I get sleepy after meals, or my stomach feels heavy",
    "I swell easily, or I feel sluggish on humid days",
    "When I overthink, I lose my appetite or crave sweets",
    "My skin, hair or throat gets dry easily",
    "I catch colds easily, or often have nose or throat discomfort",
    "My stools are hard or difficult to pass",
    "My hands, feet or lower back get cold easily",
    "I wake up at night to use the toilet, or go often",
    "My lower back or knees feel tired, or my hair lacks body",
  ],
  answers: { 2: "Often", 1: "Sometimes", 0: "Rarely" },
  typeLines: {
    wood: "Your energy tends to get stuck and you can feel tense. Try meals with fragrant ingredients that help you feel at ease.",
    fire: "Heat tends to build up in your body, and you may notice flushing or trouble sleeping. Fresh, juicy ingredients that cool you down are a good choice.",
    earth: "Your stomach tires easily, and humidity or swelling may bother you. Warm, gently seasoned meals that are kind to your stomach are a good choice.",
    metal: "Your skin and throat dry out easily, and you may feel off when the seasons change. Try white ingredients and silky, thickened dishes for moisture.",
    water: "You get cold easily and your body warms up slowly. Try black ingredients and hot dishes that warm you from the core.",
    balanced: "No strong tendency shows right now. Keep it up with meals that suit the season.",
    allHigh: "Many of the items apply to you, so you may be easily swayed overall. Start by taking it easy with meals that suit the current season.",
  },
  teaLines: {
    wood: "A rose and jasmine tea for days you want a change of mood",
    fire: "A tea with a soft lavender scent for days you want to unwind",
    earth: "A Job's tears and citrus peel tea for the change of seasons",
    metal: "A quince and shiso tea for dry seasons",
    water: "A mugwort and eucommia leaf tea for days you want to warm up (have it hot if you feel cold)",
  },
  teaName: "Gojun Tea",
  seasonNames: pick({ wood: "Spring", fire: "Summer", earth: "Doyo (seasonal transition)", metal: "Autumn", water: "Winter" }),
  seasonLines: {
    wood: "Spring is a season of new growth, when feelings can run high. Grains, beans and sweet spring vegetables help keep your stomach strong.",
    fire: "Heat builds up easily this season. Stay refreshed with summer vegetables and a little bitterness, and go easy on cold foods.",
    earth: "Around the change of seasons, humidity can tire your stomach. Choose warm, easy-to-digest meals.",
    metal: "Autumn is dry, so think about moisture. Pair sour and sweet, such as pears, apples and honey.",
    water: "Winter is cold. Warm up from the core with warming ingredients like ginger and green onion, and black ingredients.",
  },
  moodQuestion: "What do you feel like eating today?",
  moods: { okayu: "Rice porridge", soup: "Soup", nabe_solo: "Hot pot for one", noodle: "Noodles", nabe_share: "Hot pot set" },
  dishReasons: {
    wood: "For when you want to feel at ease, with fragrant ingredients",
    fire: "For when you want to feel refreshed, with fresh, juicy ingredients",
    earth: "For when you want to be kind to your stomach, with warm, gentle flavors",
    metal: "For when you want moisture, with silky textures and white ingredients",
    water: "For when you want to warm up from the core, with hot dishes",
  },
  weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  checkName: "1-Minute Constitution Check", disclaimer: "This shows a general tendency of your constitution. It is not a medical diagnosis.",
  nihondoLead: "To learn more, try a Kampo consultation at Nihondo", nihondoButton: "Kampo consultation at Nihondo", yourTeaDay: (w) => `${w} is your tea day`,
  consent: "Your results will be saved to your membership card. Our staff will see them and use them to suggest teas and dishes for you. They also help us shape our restaurant.",
  intro: "15 questions and today's food mood show your current constitution tendency (about 1 minute).",
  todayTitle: "Today's 1-Minute Check", todaySkip: "Skip today", todayLabel: "Today's tendency", profileLabel: "Your constitution", yourTeaLabel: "Gojun tea recommended for you",
  todayCheckText: "Check on each visit to see \"Your constitution\" as an average of your last 3 checks (optional, about 1 minute).", todayStart: "Start today's check", historyLabel: "Past checks",
  latestLabel: (d) => `Last tendency (${d})`,
  profileBasis: (n) => (n >= 3 ? "Average of your last 3 checks" : n === 2 ? "Average of 2 checks (after 3 checks, this becomes the average of the last 3)" : "Result of 1 check (check on each visit to see the average of the last 3)"),
  webIntro: "15 questions show your current constitution tendency (about 1 minute).", webPrivacy: "Your answers stay on this screen and are not saved or sent.",
  webCtaLead: "Register for the 10ZEN LINE membership card to save your results, and we'll suggest teas and dishes for your constitution on each visit.",
  webCtaButton: "Register on LINE", evenNote: "Since no strong tendency shows, we chose the dish and tea from the current season and your highest-scoring items.",
  registerLead: "The constitution check is available with the free 10ZEN LINE membership card. Registering also gets you a ticket for free unlimited Gojun tea at dinner.", registerButton: "Register and start the check", resume: (n) => `Continue (question ${n})`,
  introLabel: "Before you start", start: "Start", agreeStart: "Agree and start", back: "‹ Back", making: "Preparing your results…", loading: "Loading…",
  detailOpen: "Show Five Elements and organ names", detailClose: "Close", formal: (k, o, s) => `Element: ${k} / Organ: ${o} / State: ${s}`, organLine: (o, s) => `Organ: ${o} / ${s}`, points: (x) => `${x} pts`,
  radarTitle: "Score for each element (0–6)", profileRadarTitle: "Your constitution: average score for each element (0–6)", resultLabel: "Your constitution tendency",
  historyTitle: (h) => `${h} (newest first, up to 6)`, dishToday: "Today's recommended dish (from today's tendency)", dishLatest: "Recommended dish (from your last tendency)",
  todayTeaLabel: (w) => `Today's Gojun tea (${w})`, seasonLabel: (s) => `A note for the season (${s})`, toCard: "Back to membership card", toCardShort: "View membership card", retake: "Check again",
  retry: "Try again", openInLine: "Please open this in the LINE app", preparing: "The constitution check is being prepared", registerFailed: "We couldn't register you. Please try again.",
  dishPending: "(Menu names are in Japanese while our menu is being finalized.)", balancedKanji: "Balanced", allHighKanji: "Overall", entryDone: "See your results and history",
  radarNote: "A higher score means more of your answers matched that tendency (0–6 each). It is not a score of how healthy you are.",
  gogyoNote: "The Five Elements (Wood, Fire, Earth, Metal, Water) are a way of grouping the workings of nature and the body in traditional East Asian medicine.",
  webNoCarry: "These results won't be carried over to your membership card. After registering, take the check on your card to save your results.",
  nihondoNote: "Nihondo's Aoyama flagship store is in the same building as 10ZEN (1F–2F). Its website is in Japanese, and English or Chinese consultation depends on staff availability, so please call before you visit.",
  nihondoTel: "Call the store: 03-5774-4193",
};

const ZH_CC = {
  kanji: pick({ wood: "木", fire: "火", earth: "土", metal: "金", water: "水" }),
  typeName: pick({ wood: "郁闷堵塞型", fire: "燥热内蕴型", earth: "消化力不足型", metal: "缺乏滋润型", water: "怕冷乏力型" }),
  organ: pick({ wood: "肝", fire: "心", earth: "脾", metal: "肺", water: "肾" }),
  state: pick({ wood: "气滞", fire: "偏热", earth: "脾虚", metal: "燥・津虚", water: "阳虚" }),
  balancedName: "整体平衡", allHighName: "整体容易波动型",
  questions: [
    "容易烦躁,情绪起伏较大",
    "眼睛容易疲劳、视物模糊",
    "常叹气,腹部或胸口发胀",
    "入睡困难,多梦",
    "脸部容易发热、发红",
    "容易心慌,容易出汗",
    "饭后犯困,胃部胀满",
    "容易浮肿,潮湿天气时感到倦怠",
    "思虑过多时食欲下降,或想吃甜食",
    "皮肤、头发、喉咙容易干燥",
    "容易感冒,鼻子或喉咙容易不适",
    "大便干硬、不易排出",
    "手脚或腰部容易发冷",
    "夜间起夜,或小便频繁",
    "腰膝容易酸软,头发缺乏弹性",
  ],
  answers: { 2: "经常", 1: "有时", 0: "很少" },
  typeLines: {
    wood: "气血容易停滞,容易紧绷的类型。建议选择香气宜人的食材,让身心舒展。",
    fire: "体内容易积热,容易在意燥热或入睡问题的类型。推荐能让热平静下来、水分丰富的食材。",
    earth: "肠胃容易疲劳,容易在意湿气或浮肿的类型。建议选择温热、口味柔和、照顾肠胃的饮食。",
    metal: "皮肤和喉咙容易干燥,换季时容易波动的类型。可以多选白色食材和带勾芡的料理,注意滋润。",
    water: "容易怕冷,温暖身体的力量较弱的类型。建议选择黑色食材和热菜,从身体内部温暖起来。",
    balanced: "目前没有明显的偏向。请继续搭配应季的饮食,保持现在的状态。",
    allHigh: "多数项目都比较符合,整体容易波动的类型。先从搭配当季的饮食开始,慢慢调整吧。",
  },
  teaLines: {
    wood: "玫瑰与茉莉飘香,适合想转换心情的日子",
    fire: "淡淡薰衣草香,适合想放松一下的日子",
    earth: "薏米与柑橘皮,适合在换季时饮用",
    metal: "木瓜与紫苏,适合在干燥的季节饮用",
    water: "艾草与杜仲叶,适合想让身体暖起来的日子(怕冷的人请选热饮)",
  },
  teaName: "五巡茶",
  seasonNames: pick({ wood: "春", fire: "夏", earth: "土用(换季期)", metal: "秋", water: "冬" }),
  seasonLines: {
    wood: "万物萌发的春天,是情绪容易高涨的季节。用谷物、豆类和带甜味的春季蔬菜,让肠胃保持活力。",
    fire: "容易积热的季节。用夏季蔬菜和适度的苦味让身体清爽,注意不要吃太多生冷食物。",
    earth: "换季时期,湿气容易让肠胃疲劳。请选择温热、易消化的饮食。",
    metal: "干燥的秋天,请注意滋润。可以搭配梨、苹果、蜂蜜等酸甜的组合。",
    water: "寒冷的冬天,用生姜、葱等温热食材和黑色食材,从身体内部暖起来。",
  },
  moodQuestion: "今天想吃什么?",
  moods: { okayu: "粥", soup: "汤", nabe_solo: "一人锅", noodle: "面", nabe_share: "火锅套餐" },
  dishReasons: {
    wood: "适合想放松身心的人,选用香气宜人的食材",
    fire: "适合想清爽一下的人,选用水分丰富的食材",
    earth: "适合想照顾肠胃的人,温热又口味柔和",
    metal: "适合想注意滋润的人,选用勾芡和白色食材",
    water: "适合想从内部暖起来的人,选用热菜",
  },
  weekdays: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"],
  checkName: "1分钟体质测试", disclaimer: "仅为体质倾向的参考,并非医学诊断",
  nihondoLead: "想进一步了解,请到药日本堂咨询汉方", nihondoButton: "前往药日本堂汉方咨询", yourTeaDay: (w) => `${w}是你的茶日`,
  consent: "测试结果将记录在会员卡中。店铺工作人员会查看结果,用于向您推荐茶饮和菜品,也会用于店铺的经营。",
  intro: "通过15个问题和今天想吃的食物,了解你现在的体质倾向(约1分钟)。",
  todayTitle: "今天的1分钟体质测试", todaySkip: "今天跳过", todayLabel: "今天的倾向", profileLabel: "你的体质", yourTeaLabel: "为你推荐的五巡茶",
  todayCheckText: "每次来店时测试,就能以最近3次的平均了解「你的体质」(自愿参加,约1分钟)。", todayStart: "开始今天的测试", historyLabel: "以往的测试",
  latestLabel: (d) => `上次的倾向(${d})`,
  profileBasis: (n) => (n >= 3 ? "最近3次测试的平均" : n === 2 ? "2次测试的平均(满3次后,将显示最近3次的平均)" : "1次测试的结果(每次来店测试,将显示最近3次的平均)"),
  webIntro: "通过15个问题,了解你现在的体质倾向(约1分钟)。", webPrivacy: "回答只在本页面中使用,不会保存或发送。",
  webCtaLead: "注册10ZEN的LINE会员卡,即可记录测试结果,每次来店时为你推荐适合体质的茶饮和菜品。",
  webCtaButton: "用LINE注册会员卡", evenNote: "由于没有明显的偏向,推荐的菜品和茶饮是根据当前季节和得分较高的项目选择的。",
  registerLead: "体质测试需使用10ZEN的LINE会员卡(免费)。注册即送晚餐五巡茶畅饮(免费)券。", registerButton: "注册会员并开始测试", resume: (n) => `继续(第${n}题)`,
  introLabel: "开始之前", start: "开始", agreeStart: "同意并开始", back: "‹ 返回", making: "正在生成结果…", loading: "加载中…",
  detailOpen: "查看五行・五脏・正式名称", detailClose: "关闭", formal: (k, o, s) => `五行: ${k} / 五脏: ${o} / 状态: ${s}`, organLine: (o, s) => `五脏: ${o} / ${s}`, points: (x) => `${x}分`,
  radarTitle: "各五行的得分(0〜6)", profileRadarTitle: "你的体质: 各五行的平均分(0〜6)", resultLabel: "你的体质倾向",
  historyTitle: (h) => `${h}(由新到旧,最多6次)`, dishToday: "今日推荐菜品(根据今天的倾向)", dishLatest: "推荐菜品(根据上次的倾向)",
  todayTeaLabel: (w) => `今天的五巡茶(${w})`, seasonLabel: (s) => `季节小贴士(${s})`, toCard: "返回会员卡", toCardShort: "查看会员卡", retake: "再测一次",
  retry: "重试", openInLine: "请在LINE应用中打开", preparing: "体质测试正在准备中", registerFailed: "注册失败,请重试。",
  dishPending: "(菜单正在定稿中,菜名暂以日文显示。)", balancedKanji: "平衡", allHighKanji: "整体", entryDone: "查看体质结果和变化",
  radarNote: "分数越高,表示符合该倾向的回答越多(各0〜6分)。分数并不代表健康状况的好坏。",
  gogyoNote: "五行是东洋医学的一种思路,把自然和身体的功能分为木、火、土、金、水五类。",
  webNoCarry: "本次的结果不会转入会员卡。注册后在会员卡上进行测试,即可记录结果。",
  nihondoNote: "药日本堂青山本店与10ZEN位于同一栋大楼（1～2楼）。网站为日文，能否用中文或英文咨询视工作人员安排而定，来店前请先致电。",
  nihondoTel: "致电门店：03-5774-4193",
};

const CC = { ja: JA_CC, en: EN_CC, zh: punctDeep(ZH_CC) };
export const ccText = (lang) => CC[lang] ?? CC.ja;

// ---- 会員証(card.html)の部品・ランク特典・チケット名 ----
const RANK_LABELS = { white_opal: "WHITE OPAL", amber: "AMBER", emerald: "EMERALD", ruby: "RUBY", onyx: "ONYX" };
const CARD = {
  ja: {   // card.html の今までの日本語(表示は変えない)
    pointsLabel: "ポイント", nextRank: (l, r) => `${l}まで ${r}`, lifetime: (a, b) => (b ? `累計 ${a} / ${b} pt` : `累計 ${a}`),
    flipHint: "タップで表裏を切り替え", backNote: "タップで表面へ", booking: "WEBご予約", checkLink: "1分体質チェック",
    hours: null, branch: "青山店", memberNo: (n) => `会員番号 ${n}`, clockLabel: "現在の時刻", cardAria: "会員証。タップで表裏を切り替え", nextAria: "次のランクまで",
    redeemLabel: (u) => `ポイントを使う(${u}pt単位)`, redeemButton: "ポイントを使う", quickAll: (n) => `全部(${n}pt)`, amountLabel: "使うポイント",
    pendingInfo: (p, y) => `使用の申請中: ${p}pt(${y}円分)`, pendingLeft: (s) => `あと ${s} 秒・スタッフにこのコードをお見せください`, cancelRedeem: "申請を取り消す",
    ticketsLabel: "特典チケット", use: "使う", useAria: (t) => `${t}を使う`, noTickets: "使えるチケットはありません",
    ticketPendingInfo: (t) => `チケットを使用中: ${t}`, ticketLeft: (s) => `あと ${s} 秒・スタッフにこのコードをお見せください`, cancelTicket: "使用を取り消す",
    ccLabel: "1分体質チェック", todayDish: "今日のおすすめ", todayTea: "今日の五巡茶",
    benefitsTitle: "会員ランク特典", perksNow: (l) => `${l} のいまの特典`,
    benefits: [["white_opal", "ご登録の特典:ディナーの五巡茶 飲み放題 無料のチケット(1回・ご登録から60日間)"], ["amber", "1,000pt達成:豆花を1つプレゼント・ディナーの五巡茶 飲み放題 無料(毎回)"],
      ["emerald", "3,000pt達成:持ち帰り用のお茶を1袋プレゼント・季節ごとに豆花チケット(年4枚)"], ["ruby", "6,000pt達成:持ち帰り用のお茶を1袋プレゼント・季節ごとに、あなたの体質の五巡茶(持ち帰り用)チケット(年4枚)"],
      ["onyx", "10,000pt達成:持ち帰り用のお茶を1袋プレゼント・新メニュー試食会へご招待"]],
    benefitNote: "上のランクでは、下のランクの特典も続けてご利用いただけます。ランクは累計ポイントで決まり、下がりません。ポイントはご来店の記録で、お会計での値引きには使えません。到達のお祝いのチケットは発行から60日間、季節のチケット(豆花・五巡茶)はその季節の終わりまで有効です。",
    onyxSpecial: "ONYX 会員特別ご招待", onyxSpecialNote: "新メニュー試食会へご招待します。ご案内は LINE でお送りします",
    register: "会員登録する", copyLink: "リンクをコピー", retry: "もう一度試す", openInLine: "LINE アプリで開いてください",
  },
  en: {
    pointsLabel: "Points", nextRank: (l, r) => `${r} to ${l}`, lifetime: (a, b) => (b ? `Total ${a} / ${b} pt` : `Total ${a}`),
    flipHint: "Tap to flip the card", backNote: "Tap to see the front", booking: "Book online", checkLink: "1-Minute Check",
    hours: "Hours: 11:00–21:00 (last order 20:30)", branch: "Aoyama", memberNo: (n) => `Member No. ${n}`, clockLabel: "Current time",
    redeemLabel: (u) => `Use points (in units of ${u} pt)`, redeemButton: "Use points", quickAll: (n) => `All (${n} pt)`, amountLabel: "Points to use",
    pendingInfo: (p, y) => `Request in progress: ${p} pt (¥${y})`, pendingLeft: (s) => `${s} sec left · Please show this code to our staff`, cancelRedeem: "Cancel request",
    ticketsLabel: "Reward tickets", use: "Use", useAria: (t) => `Use ${t}`, noTickets: "No tickets available",
    ticketPendingInfo: (t) => `Using ticket: ${t}`, ticketLeft: (s) => `${s} sec left · Please show this code to our staff`, cancelTicket: "Cancel",
    ccLabel: "1-Minute Constitution Check", todayDish: "Today's pick", todayTea: "Today's Gojun tea",
    benefitsTitle: "Membership rank benefits", perksNow: (l) => `Your current ${l} benefits`,
    benefits: [["white_opal", "Welcome gift: a ticket for free unlimited Gojun tea at dinner (once, valid 60 days after registering)"], ["amber", "At 1,000 pt: a free douhua (tofu pudding), plus free unlimited Gojun tea at dinner every visit"],
      ["emerald", "At 3,000 pt: a free bag of tea to take home, plus a douhua ticket each season (4 a year)"], ["ruby", "At 6,000 pt: a free bag of tea to take home, plus a ticket each season for Gojun tea to take home, chosen for your constitution (4 a year)"],
      ["onyx", "At 10,000 pt: a free bag of tea to take home, plus an invitation to our new menu tasting"]],
    benefitNote: "Higher ranks keep the benefits of lower ranks. Your rank is based on your total points and never goes down. Points record your visits and can't be used as a discount at checkout. Rank-up tickets are valid for 60 days, and seasonal tickets (douhua, Gojun tea) until the end of the season.",
    onyxSpecial: "Special invitation for ONYX members", onyxSpecialNote: "You're invited to our new menu tasting. We'll send details on LINE.",
    register: "Register", copyLink: "Copy link", retry: "Try again", openInLine: "Please open this in the LINE app", cardAria: "Membership card. Tap to flip", nextAria: "To the next rank",
  },
  zh: {
    pointsLabel: "积分", nextRank: (l, r) => `距离${l} ${r}`, lifetime: (a, b) => (b ? `累计 ${a} / ${b} pt` : `累计 ${a}`),
    flipHint: "点击翻转会员卡", backNote: "点击查看正面", booking: "网上预约", checkLink: "1分钟体质测试",
    hours: "营业时间: 11:00〜21:00(最后点餐 20:30)", branch: "青山店", memberNo: (n) => `会员编号 ${n}`, clockLabel: "当前时间",
    redeemLabel: (u) => `使用积分(以${u}pt为单位)`, redeemButton: "使用积分", quickAll: (n) => `全部(${n}pt)`, amountLabel: "要使用的积分",
    pendingInfo: (p, y) => `正在申请使用: ${p}pt(${y}日元)`, pendingLeft: (s) => `剩余 ${s} 秒・请向工作人员出示此代码`, cancelRedeem: "取消申请",
    ticketsLabel: "优惠券", use: "使用", useAria: (t) => `使用${t}`, noTickets: "暂无可用的优惠券",
    ticketPendingInfo: (t) => `正在使用优惠券: ${t}`, ticketLeft: (s) => `剩余 ${s} 秒・请向工作人员出示此代码`, cancelTicket: "取消使用",
    ccLabel: "1分钟体质测试", todayDish: "今日推荐", todayTea: "今天的五巡茶",
    benefitsTitle: "会员等级特典", perksNow: (l) => `${l} 当前可享特典`,
    benefits: [["white_opal", "注册礼: 晚餐五巡茶畅饮免费券(1次・注册后60天内有效)"], ["amber", "达到1,000pt: 赠送豆花1份・每次晚餐五巡茶畅饮免费"],
      ["emerald", "达到3,000pt: 赠送外带茶1袋・每季豆花券(每年4张)"], ["ruby", "达到6,000pt: 赠送外带茶1袋・每季一张适合你体质的五巡茶(外带)券(每年4张)"],
      ["onyx", "达到10,000pt: 赠送外带茶1袋・邀请参加新菜单试吃会"]],
    benefitNote: "高等级会员可继续享受低等级的特典。等级根据累计积分决定,不会下降。积分用于记录来店,不能在结账时抵扣。升级纪念券自发放起60天内有效,季节券(豆花・五巡茶)在该季节结束前有效。",
    onyxSpecial: "ONYX 会员特别邀请", onyxSpecialNote: "诚邀您参加新菜单试吃会。详情将通过LINE通知。",
    register: "注册会员", copyLink: "复制链接", retry: "重试", openInLine: "请在LINE应用中打开", cardAria: "会员卡。点击翻转", nextAria: "距离下一等级",
  },
};
CARD.zh = punctDeep(CARD.zh);
export const cardText = (lang) => CARD[lang] ?? CARD.ja;
export const rankLabel = (rank) => RANK_LABELS[rank] ?? rank;

// ランクごとの『来るたびに使える特典』(screens.mjs の RANK_PERKS と同じ順)
export const RANK_PERKS_I18N = Object.freeze({
  en: [["amber", "Free unlimited Gojun tea at dinner"], ["emerald", "A douhua ticket each season"], ["ruby", "A ticket each season for Gojun tea to take home, chosen for your constitution"],
    ["onyx", "Invitation to our new menu tasting"], ["emerald", "Nihondo member benefits (coming soon)", true]],
  zh: punctDeep([["amber", "晚餐五巡茶畅饮免费"], ["emerald", "每季豆花券1张"], ["ruby", "每季适合你体质的五巡茶(外带)券1张"], ["onyx", "邀请参加新菜单试吃会"], ["emerald", "药日本堂会员优惠(准备中)", true]]),
});

// チケット名(DB には日本語で保存)→ 言語ごと。種類は kind・rank・season と日本語の名前から判断する。分からなければ日本語のまま
const SEASON_OF_KEY = { spring: { en: "Spring", zh: "春" }, summer: { en: "Summer", zh: "夏" }, autumn: { en: "Autumn", zh: "秋" }, winter: { en: "Winter", zh: "冬" } };
const ELEMENT_OF_KANJI = { 木: "wood", 火: "fire", 土: "earth", 金: "metal", 水: "water" };
export function ticketTitle(t, lang) { const r = ticketTitleRaw(t, lang); return lang === "zh" ? zhPunct(r) : r; }
function ticketTitleRaw(t, lang) {
  if (lang === "ja" || !t || typeof t.title !== "string") return t?.title ?? null;
  const T = lang === "en" ? EN_CC : ZH_CC, title = t.title;
  const kind = t.kind ?? (/到達のお祝い/.test(title) ? "milestone" : /お友だち紹介/.test(title) ? "referral" : /ご登録の特典/.test(title) ? "welcome" : /\((春|夏|秋|冬)\)$/.test(title) ? "seasonal" : null);
  const rank = t.rank ?? (title.match(/^(WHITE OPAL|AMBER|EMERALD|RUBY|ONYX)/)?.[1] ?? "").toLowerCase().replace(" ", "_");
  const JA_SEASON = { 春: "spring", 夏: "summer", 秋: "autumn", 冬: "winter" };
  const seasonName = (() => { const k = String(t.season ?? "").split("-")[1] || JA_SEASON[title.match(/\((春|夏|秋|冬)\)$/)?.[1]]; return SEASON_OF_KEY[k]?.[lang] ?? null; })();
  t = { ...t, kind, rank };
  if (t.kind === "milestone") {
    const item = /豆花/.test(title) ? (lang === "en" ? "1 douhua" : "豆花1份") : /お茶/.test(title) ? (lang === "en" ? "1 bag of tea to take home" : "外带茶1袋") : null;
    if (!item) return title;
    return lang === "en" ? `${rankLabel(t.rank)} rank-up gift: ${item}` : `${rankLabel(t.rank)} 升级纪念: ${item}`;
  }
  if (t.kind === "seasonal" && seasonName) {
    const m = title.match(/五巡茶\((.)\)/);
    if (m && ELEMENT_OF_KANJI[m[1]]) { const e = ELEMENT_OF_KANJI[m[1]]; return lang === "en" ? `1 Gojun tea to take home (${T.kanji[e]}) (${seasonName})` : `外带五巡茶(${T.kanji[e]})1份(${seasonName})`; }
    if (/豆花/.test(title)) return lang === "en" ? `1 seasonal douhua (${seasonName})` : `季节豆花券1张(${seasonName})`;
    return title;
  }
  if (t.kind === "referral" || t.kind === "welcome") {   // 名前は「(無料)」つき(db/116)。英語・中国語も無料と分かるように
    const head = t.kind === "welcome" ? (lang === "en" ? "Welcome gift" : "注册礼") : (lang === "en" ? "Friend referral" : "好友推荐");
    return `${head}${lang === "en" ? ": " : "・"}${dinnerTeaLabel(title, lang)}`;
  }
  return title;
}
// ディナーの五巡茶の名前(DB の _dinner_tea_label: 「ディナーの五巡茶 1杯(無料)」/「… 飲み放題(無料)」。db/116 で「(無料)」が付いた)
export function dinnerTeaLabel(label, lang) {
  if (lang === "ja" || typeof label !== "string") return label;
  const free = /飲み放題/.test(label);
  return lang === "en" ? (free ? "free unlimited Gojun tea at dinner" : "1 free cup of Gojun tea at dinner") : (free ? "晚餐五巡茶畅饮(免费)" : "晚餐五巡茶1杯(免费)");
}

// ---- 店頭の QR 画面(qr.html)。2026-10-17 牧野さん決定: 言語が自動で切り替わる(日本語2:英語1:中国語1。QR はそのまま)----
//   日本語は qr.html の KIOSK_COPY。英語・中国語は同じ形(数字は日本語と同じ。tools/test_kiosk_copy.mjs が確かめる)
export const KIOSK_ROTATION = Object.freeze([["ja", 10_000], ["en", 5_000], ["zh", 5_000]]);
export const KIOSK_I18N = Object.freeze({
  en: {
    title: "Your 10ZEN membership card, on your phone.", lead: "Just scan with LINE. No app to download, nothing to type.",
    perks: [
      { k: "Welcome gift", v: "Free unlimited tea", d: "Gojun tea at dinner, once (valid 60 days after registering)" },
      { k: "Every visit", v: "100pt", d: "Scan this QR once a day to earn points" },
      { k: "Rank-up rewards", v: "Douhua, tea & more", d: "Higher ranks bring douhua, tea to take home and Gojun tea at dinner" },
    ],
    ranks: [["white_opal", "WHITE OPAL", "Welcome gift: free unlimited Gojun tea at dinner (once)"], ["amber", "AMBER", "A douhua gift · free unlimited Gojun tea at dinner"],
      ["emerald", "EMERALD", "Tea to take home · a douhua ticket each season"], ["ruby", "RUBY", "Tea to take home · Gojun tea for your constitution each season"],
      ["onyx", "ONYX", "Tea to take home · invitation to our new menu tasting"]],
    steps: [["Scan this QR code", "With LINE's QR reader or your phone camera"], ["Your 10ZEN card opens", "First time? Register on the spot (free unlimited Gojun tea at dinner)"], ["Earn visit points", "Points raise your rank and bring rewards"]],
    notes: ["Points set your rank (they aren't a discount at checkout)"], scanHead: "Scan to start", refresh: "The QR code changes every 30 seconds",
    sampleName: "Your name", sampleNo: "Member No. ····", sampleAria: "Sample 10ZEN membership card", qrAria: "QR code for your visit", perksAria: "Member benefits", stepsAria: "How to use",
    hidden: "The QR code can't be shown right now. Please ask our staff.",
  },
  zh: punctDeep({
    title: "把10ZEN会员卡放进手机。", lead: "用LINE扫一扫即可。无需下载应用,无需填写。",
    perks: [
      { k: "注册礼", v: "畅饮免费", d: "晚餐五巡茶1次(注册后60天内有效)" },
      { k: "每次来店", v: "100pt", d: "每天扫描一次此二维码即可累积" },
      { k: "升级特典", v: "豆花・茶等", d: "累计积分提升等级,可享豆花、外带茶、晚餐五巡茶等特典" },
    ],
    ranks: [["white_opal", "WHITE OPAL", "注册礼: 晚餐五巡茶畅饮免费(1次)"], ["amber", "AMBER", "豆花礼物・晚餐五巡茶畅饮免费"],
      ["emerald", "EMERALD", "外带茶・每季豆花券"], ["ruby", "RUBY", "外带茶・每季适合你体质的五巡茶"], ["onyx", "ONYX", "外带茶・邀请参加新菜单试吃会"]],
    steps: [["扫描此二维码", "使用LINE的二维码扫描或手机相机"], ["打开10ZEN会员卡", "首次使用可当场注册(赠送晚餐五巡茶畅饮券)"], ["累积来店积分", "积分提升等级,即可获得特典"]],
    notes: ["积分用于决定等级(不能在结账时抵扣)"], scanHead: "扫码开始", refresh: "二维码每30秒更新一次",
    sampleName: "你的名字", sampleNo: "会员编号 ・・・・", sampleAria: "10ZEN会员卡样例", qrAria: "来店用二维码", perksAria: "会员特典", stepsAria: "使用方法",
    hidden: "暂时无法显示二维码。请联系工作人员。",
  }),
});

// ---- 体質チェックの結果からの注文(ダイニー。dinii.mjs の日本語と同じ形)。アレルギーは「大丈夫」と言わずスタッフへ ----
const ORDER = {
  ja: { label: ORDER_LABEL, scan: ORDER_BUTTON, table: ORDER_BUTTON_TABLE, notDinii: ORDER_NOT_DINII, noScan: ORDER_NO_SCAN, note: ORDER_NOTE },
  en: { label: "Order", scan: "Order now (scan your table's QR code)", table: "Order now", notDinii: "This isn't a 10ZEN order QR code. Please scan the QR code at your table.",
    noScan: "Please scan the QR code at your table with your phone camera to order.",
    note: "The order screen shows our regular menu (it doesn't change with your check results). If you have questions about ingredients or allergies, please ask our staff." },
  zh: { label: "点餐", scan: "直接点餐(扫描桌上的二维码)", table: "直接点餐", notDinii: "这不是10ZEN的点餐二维码。请扫描桌上的二维码。",
    noScan: "请用手机相机扫描桌上的二维码点餐。",
    note: "点餐页面为常规菜单(不会根据体质测试结果改变)。如对食材或过敏有疑问,请咨询工作人员。" },
};
ORDER.zh = punctDeep(ORDER.zh);
export const orderText = (lang) => ORDER[lang] ?? ORDER.ja;

// 言葉づかいのきまりに引っかかる語(test_i18n.mjs が全部の文に当てる)
export const BANNED = Object.freeze({ ja: /治る|効く|改善/, en: /\b(cure|cures|cured|treat|treats|treatment|heal|heals|healing|improve|improves|improvement|effective|remedy)\b/i, zh: /治疗|治愈|疗效|改善|治好|功效|见效|有效果/ });
