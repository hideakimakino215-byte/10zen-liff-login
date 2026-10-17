// お客様向けの画面の英語・中国語(app-core/i18n.mjs と screens.mjs の messages)を確かめる。実行: node app-core/test_i18n.mjs
//  * 言語の選び方(選んだ言語 → LINE → 端末。知らない言語は英語)
//  * 3か国語で項目がそろっている(英語・中国語に抜けがない)
//  * 言葉づかいのきまり(治る・効く・改善 / cure・treat・heal・improve / 治疗・治愈・改善…)と、アレルギーで「大丈夫」と言わない
//  * DB の日本語のチケット名・ディナーの五巡茶の名前を言語ごとに直せる。日本語の表示は今までと同じ
import assert from "node:assert/strict";
import { LANGS, detectLang, normalizeLang, storedLang, saveLang, ccText, cardText, orderText, ticketTitle, dinnerTeaLabel, KIOSK_I18N, KIOSK_ROTATION, RANK_PERKS_I18N, BANNED, LANG_KEY } from "./i18n.mjs";
import { messages, memberView, constitutionResultView, rankUpNotice } from "./screens.mjs";
import * as JA from "./constitution-content.mjs";
import { ORDER_NOTE } from "./dinii.mjs";

let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const SAMPLE = [3, 120, "AMBER", "2026-11-30"];
// 文を全部集める(関数は見本の値で呼ぶ)
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (typeof v === "function") { try { strings(v(...SAMPLE), out); } catch (_e) { /* 引数の形が違う */ } }
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// 1 言語の選び方
assert.equal(detectLang({ stored: "zh", liff: "en", nav: ["ja-JP"] }), "zh");             // 選んだ言語がいちばん
assert.equal(detectLang({ liff: "en-US", nav: ["ja-JP"] }), "en");                         // 次に LINE の言語
assert.equal(detectLang({ liff: "zh-Hans", nav: [] }), "zh"); assert.equal(detectLang({ liff: "zh-TW" }), "zh"); assert.equal(detectLang({ liff: "zh_CN" }), "zh");
assert.equal(detectLang({ nav: ["ja-JP", "en"] }), "ja"); assert.equal(detectLang({ liff: "ja" }), "ja");
assert.equal(detectLang({ liff: "ko-KR" }), "en"); assert.equal(detectLang({ nav: ["th"] }), "en");   // 知らない言語は英語
assert.equal(detectLang({}), "ja"); assert.equal(detectLang({ stored: "fr" }), "ja");                // 何も分からなければ日本語
assert.equal(normalizeLang("EN-gb"), "en"); assert.equal(normalizeLang(""), null); assert.equal(normalizeLang(null), null);
const mem = new Map(), storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
saveLang(storage, "fr"); assert.equal(storedLang(storage), null); saveLang(storage, "en"); assert.equal(storedLang(storage), "en"); assert.equal(mem.get(LANG_KEY), "en");
assert.equal(storedLang({ getItem: () => { throw new Error("blocked"); } }), null);         // 使えない端末でも止まらない
assert.equal(storedLang(null), null);
ok("言語の選び方: 選んだ言語 → LINE の言語 → 端末の言語。知らない言語は英語、何も分からなければ日本語。この端末に覚える(使えない端末でも止まらない)");

// 2 項目がそろっている
const keysOf = (o) => Object.keys(o).sort();
for (const [name, get] of [["ccText", ccText], ["cardText", cardText], ["orderText", orderText]]) {
  const ja = keysOf(get("ja")), en = keysOf(get("en")), zh = keysOf(get("zh"));
  assert.deepEqual(en, zh, `${name}: 英語と中国語の項目が違う`);
  for (const k of ja) assert.ok(en.includes(k), `${name}: 英語に ${k} がない`);
  for (const l of ["en", "zh"]) for (const [k, v] of Object.entries(get(l))) if (v !== null && k !== "dishPending") assert.ok(strings(v).every((s) => s.length > 0), `${name}.${l}.${k} が空`);
}
for (const l of ["en", "zh"]) {
  const C = ccText(l);
  assert.equal(C.questions.length, 15); assert.deepEqual(keysOf(C.answers), ["0", "1", "2"]); assert.deepEqual(keysOf(C.moods), keysOf(ccText("ja").moods));
  for (const g of ["kanji", "typeName", "organ", "state", "seasonNames", "seasonLines", "teaLines", "dishReasons"]) assert.deepEqual(keysOf(C[g]), ["earth", "fire", "metal", "water", "wood"], `${l}.${g}`);
  assert.deepEqual(keysOf(C.typeLines), keysOf(ccText("ja").typeLines)); assert.equal(C.weekdays.length, 7);
  assert.deepEqual(keysOf(messages[l]), keysOf(messages.ja), `messages.${l} の項目が日本語と違う`);
  assert.deepEqual(keysOf(KIOSK_I18N[l]).filter((k) => !["sampleAria", "qrAria", "perksAria", "stepsAria"].includes(k)).length > 0, true);
  assert.equal(RANK_PERKS_I18N[l].length, 5);
}
assert.deepEqual(keysOf(KIOSK_I18N.en), keysOf(KIOSK_I18N.zh));
assert.equal(ccText("fr"), ccText("ja")); assert.equal(cardText(undefined), cardText("ja"));   // 知らない値は日本語
ok("3か国語で項目がそろっている(体質チェック15問・答え・気分・五行ごとの文・曜日・会員証・注文・お知らせ・店頭の QR)。空の文がない");

// 3 言葉づかいのきまり
const all = { ja: [], en: [], zh: [] };
for (const l of LANGS) all[l].push(...strings(ccText(l)), ...strings(cardText(l)), ...strings(orderText(l)), ...strings(messages[l]));
all.en.push(...strings(KIOSK_I18N.en), ...strings(RANK_PERKS_I18N.en)); all.zh.push(...strings(KIOSK_I18N.zh), ...strings(RANK_PERKS_I18N.zh));
for (const l of LANGS) {
  assert.ok(all[l].length > 150, `${l}: 文が少ない(${all[l].length})`);
  for (const s of all[l]) { assert.doesNotMatch(s, BANNED[l], `${l}: 「${s}」`); assert.doesNotMatch(s, /大丈夫|no problem|safe for|没问题|放心/i, `${l}: 「${s}」`); }
}
for (const l of ["en", "zh"]) assert.match(orderText(l).note, l === "en" ? /staff/ : /工作人员/);          // アレルギーはスタッフへ
assert.match(ccText("en").disclaimer, /not a medical diagnosis/); assert.match(ccText("zh").disclaimer, /并非医学诊断/);
assert.doesNotMatch(all.zh.join(""), /[ぁ-んァ-ヶ・「」〜]/);                                     // 中国語の文にかな・日本語の記号が混ざっていない
for (const t of all.zh) { const u = t.replace(/https?:\/\/\S+/g, "").replace(/\d[,:]\d/g, ""); assert.doesNotMatch(u, /[,:()?]/, `中国語の句読点が半角: 「${t}」`); }   // ，：（）？ は全角(数字の間・URL は除く)
assert.equal(ccText("zh").latestLabel("2026-10-17"), "上次的倾向（2026-10-17）"); assert.match(cardText("zh").hours, /11:00～21:00/);
ok("言葉づかいのきまり: 3か国語とも「治る・効く・改善」(cure・treat・heal・improve / 治疗・治愈・改善…)を使わない。アレルギーで「大丈夫」と言わずスタッフへ。診断ではない旨。中国語にかなが混ざらず、句読点は全角(，：（）？ · “”)");

// 4 日本語は今までと同じ
const C = ccText("ja");
assert.equal(C.consent, JA.CONSENT_TEXT); assert.equal(C.disclaimer, JA.DISCLAIMER); assert.equal(C.yourTeaLabel, "あなたにおすすめの五巡茶"); assert.equal(orderText("ja").note, ORDER_NOTE);
const ev = { scores: { wood: 6, fire: 1, earth: 2, metal: 1, water: 0 }, primary: "wood", balanced: false, mood: "soup" };
const ja = constitutionResultView(ev, { todayStr: "2026-10-17" }), en = constitutionResultView(ev, { todayStr: "2026-10-17", lang: "en" }), zh = constitutionResultView(ev, { todayStr: "2026-10-17", lang: "zh" });
assert.equal(ja.typeName, constitutionResultView(ev, { todayStr: "2026-10-17", lang: "ja" }).typeName);
assert.equal(en.typeName, "The Tense & Stuck Type"); assert.equal(zh.typeName, "郁闷堵塞型"); assert.notEqual(ja.typeName, en.typeName);
assert.equal(en.dish?.name, ja.dish?.name);                                                       // お料理の名前はメニューが決まるまで日本語
ok("日本語の表示は今までと同じ(同意文・診断ではない旨・注文の注意)。結果のタイプ名は言語ごと、お料理の名前は日本語のまま");

// 5 チケット名・ディナーの五巡茶
assert.equal(ticketTitle({ title: "AMBER 到達のお祝い・豆花 1つ" }, "ja"), "AMBER 到達のお祝い・豆花 1つ");
assert.equal(ticketTitle({ title: "AMBER 到達のお祝い・豆花 1つ" }, "en"), "AMBER rank-up gift: 1 douhua");
assert.equal(ticketTitle({ title: "EMERALD 到達のお祝い・持ち帰り用のお茶 1袋" }, "zh"), "EMERALD 升级纪念：外带茶1袋");
assert.equal(ticketTitle({ title: "季節の豆花チケット(秋)" }, "en"), "1 seasonal douhua (Autumn)");
assert.equal(ticketTitle({ title: "持ち帰りの五巡茶(水) 1つ(冬)" }, "zh"), "外带五巡茶（水）1份（冬）");
assert.match(ticketTitle({ title: "お友だち紹介・ディナーの五巡茶 飲み放題" }, "en"), /unlimited/);
assert.equal(ticketTitle({ title: "知らない名前" }, "en"), "知らない名前"); assert.equal(ticketTitle(null, "en"), null);   // 分からなければ日本語のまま
assert.equal(dinnerTeaLabel("ディナーの五巡茶 1杯", "en"), "1 cup of Gojun tea at dinner"); assert.equal(dinnerTeaLabel("ディナーの五巡茶 飲み放題", "zh"), "晚餐五巡茶畅饮");
assert.equal(dinnerTeaLabel("ディナーの五巡茶 1杯", "ja"), "ディナーの五巡茶 1杯");
ok("DB の日本語のチケット名(到達のお祝い・季節・紹介)とディナーの五巡茶を言語ごとに直す。分からない名前は日本語のまま");

// 6 会員証の数字と日付(言語が変わっても数字は同じ)
const member = { memberNo: "AO00001", displayName: "Test", rank: "amber", nextRank: { label: "EMERALD", remainingPoints: 1500, percent: 50 }, points: 1200, lifetimePoints: 1500, expiresOn: "2026-11-30", yenPer100pt: 10, redeemUnit: 100, rankLabel: "AMBER", tickets: [], visitedToday: false };
const vj = memberView(member, Date.parse("2026-10-17T03:00:00Z"), "ja"), ve = memberView(member, Date.parse("2026-10-17T03:00:00Z"), "en"), vz = memberView(member, Date.parse("2026-10-17T03:00:00Z"), "zh");
assert.equal(ve.points, vj.points); assert.equal(vz.points, vj.points); assert.equal(ve.rank, vj.rank);
assert.match(ve.expirySoonText ?? "", /2026|Nov/); assert.doesNotMatch(ve.expirySoonText ?? "", /[ぁ-んァ-ヶ]/);
assert.doesNotMatch(rankUpNotice("white_opal", ve, "en") ?? "", /[ぁ-んァ-ヶ]/); assert.match(rankUpNotice("white_opal", vz, "zh") ?? "", /AMBER/);
assert.equal(cardText("zh").nextRank("AMBER", vz.next.remainingText), `距离AMBER ${vz.next.remainingText}`); assert.equal((cardText("zh").nextRank("AMBER", vz.next.remainingText).match(/还差/g) ?? []).length, 1);   // 「还差」が2回出ない
assert.equal(cardText("en").nextRank("EMERALD", "1,700 pt left"), "1,700 pt left to EMERALD");
ok("会員証: 言語が変わってもポイント・ランクは同じ。期限のお知らせ・ランクアップのお知らせは英語・中国語で出る(かなが混ざらない)");

// 7 店頭の QR 画面: 日本語10秒 → 英語5秒 → 中国語5秒(2:1:1)
assert.deepEqual(KIOSK_ROTATION.map(([l]) => l), ["ja", "en", "zh"]);
const [j, e, z] = KIOSK_ROTATION.map(([, ms]) => ms); assert.equal(j, 2 * e); assert.equal(e, z); assert.equal(j + e + z, 20_000);
// 数字は日本語と同じ(来店 100pt・100pt=10円・ランクの基準 1,000 / 3,000 / 6,000 / 10,000。日本語は tools/test_kiosk_copy.mjs が DB と照らす)
for (const l of ["en", "zh"]) {
  const K = KIOSK_I18N[l]; assert.equal(K.perks[0].v, "100pt"); assert.match(K.perks[1].v, l === "en" ? /^100pt = ¥10$/ : /^100pt=10日元$/);
  assert.deepEqual(K.ranks.map(([c]) => c), ["white_opal", "amber", "emerald", "ruby", "onyx"]); assert.match(K.ranks[0][2], l === "en" ? /100pt = ¥10/ : /100pt=10日元/);
  const ja = cardText("ja").benefits, b = cardText(l).benefits; assert.deepEqual(b.map(([c]) => c), ja.map(([c]) => c));
  ja.forEach(([, t], i) => { for (const num of t.match(/\d[\d,]*pt/g) ?? []) assert.ok(b[i][1].replace(/ /g, "").includes(num), `${l}: 特典の ${num} がない: ${b[i][1]}`); });
}
ok("店頭の QR 画面: 日本語10秒 → 英語5秒 → 中国語5秒(2:1:1)で自動で切り替わる。英語・中国語の数字(来店100pt・100pt=10円・ランクの基準)は日本語と同じ");

console.log(`\n${n} i18n checks passed`);
