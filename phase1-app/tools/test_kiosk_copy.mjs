// 店頭タブレットの QR 画面(qr.html)がお客様に見せる数字が、DB の設定と会員証の特典に合っているかを確かめる。
// 実行: node --experimental-strip-types test_kiosk_copy.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
// 会員証の特典の文は app-core/i18n.mjs の cardText("ja")(2026-10-17 の多言語化で card.html から移した)。英語・中国語の数字は test_i18n.mjs が日本語と照らす
const { cardText } = await import("../app-core/i18n.mjs");
const B = cardText("ja").benefits, benefitLine = (code) => B.find(([c]) => c === code)?.[1] ?? "";
const qr = read("../app-reference/qr.html"), sql = read("../db/100_phase1_schema.sql"), card = [read("../app-reference/card.html"), ...B.map(([c, t]) => `${c} ${t}`), cardText("ja").benefitNote].join("\n");
const copy = qr.slice(qr.indexOf("const KIOSK_COPY"), qr.indexOf("};", qr.indexOf("const KIOSK_COPY")));
const rule = (code) => Number(sql.match(new RegExp(`\\('${code}',\\s*(\\d+),\\s*true`))?.[1]);
const setting = (key) => Number(sql.match(new RegExp(`\\('${key}',\\s*'(\\d+)'`))?.[1]);

const visit = rule("visit");
assert.ok(visit > 0, "DB の初期値が読めない");
assert.match(copy, new RegExp(`v: "${visit}pt"`)); assert.match(copy, /1日1回/);
ok(`来店ポイント(${visit}pt・1日1回)が、DB の point_rules と同じ`);

// 2026-10-21 牧野さん決定(db/116): ポイントはお会計の値引きに使わない。初回特典はディナーの五巡茶 飲み放題 無料(ご登録から60日)
const sql116 = read("../db/116_points_policy.sql");
const welcomeDays = Number(sql116.match(/\('welcome_tea', 'welcome', 'white_opal', public\._dinner_tea_label\(\), (\d+)\)/)?.[1]);
assert.equal(welcomeDays, 60);
assert.match(sql116, /\('points_redeemable', 'false'/);
for (const [name, t] of [["QR 画面", copy], ["会員証", card]]) {
  for (const gone of ["10円", "ポイントを使う", "お会計で使える"]) assert.ok(!t.includes(gone), `${name} にポイントの値引きの案内(${gone})が残っている`);
  assert.ok(/飲み放題 無料|飲み放題/.test(t) && t.includes("無料"), `${name} に初回特典(ディナーの五巡茶 飲み放題 無料)がない`);
}
assert.match(copy, new RegExp(`ご登録から${welcomeDays}日間`)); assert.match(benefitLine("white_opal"), new RegExp(`ご登録から${welcomeDays}日間`));
assert.match(copy, /値引きはありません/); assert.match(cardText("ja").benefitNote, /値引きには使えません/);
ok(`ポイントの値引き(100pt=10円)の案内がなく、初回特典「ディナーの五巡茶 飲み放題 無料」(ご登録から${welcomeDays}日間)が DB(116)・QR 画面・会員証で同じ`);

for (const word of ["豆花", "お茶"]) { assert.ok(copy.includes(word), `QR 画面に ${word} がない`); assert.ok(card.includes(word), `会員証の特典に ${word} がない(QR 画面の宣伝と食い違う)`); }
// 会員証の見本で順に見せるランクと特典: 特典の要点が、会員証の特典の一覧(cardText("ja").benefits)にそのままある(RANK_PERKS_DESIGN_20261015.md の特典)
const ranks = [...copy.matchAll(/\["(\w+)", "([A-Z ]+)", "([^"]+)"\]/g)].map((m) => ({ code: m[1], label: m[2], text: m[3] }));
assert.deepEqual(ranks.map((r) => r.code), ["white_opal", "amber", "emerald", "ruby", "onyx"]);
const keys = { white_opal: ["五巡茶", "飲み放題 無料"], amber: ["豆花", "五巡茶"], emerald: ["お茶", "豆花"], ruby: ["お茶", "五巡茶"], onyx: ["お茶", "試食会"] };
for (const r of ranks) { const line = benefitLine(r.code); assert.ok(line, `会員証の特典に ${r.label} がない`);
  for (const k of keys[r.code]) assert.ok(r.text.includes(k) && line.includes(k), `${r.label} の特典が会員証と食い違う(${k}): ${r.text}`); }
assert.ok(!/キャンペーン/.test(copy), "期間限定のキャンペーンは常設の画面に書かない");
for (const [name, t] of [["QR 画面", copy], ["会員証", card]]) for (const gone of ["5%OFF", "薬膳スイーツ", "季節の薬膳茶"]) assert.ok(!t.includes(gone), `${name} に廃止した特典(${gone})が残っている`);
ok("ランク特典の例(豆花・お茶)と、見本で順に見せる5ランクの特典の要点(初回特典の五巡茶・豆花・五巡茶・お茶・あなたの五巡茶・試食会)が、会員証の特典と同じ。廃止した RUBY の5%OFF・旧特典は書いていない。期間限定のキャンペーンは書いていない");

// 会員証の特典に書いた『○○pt達成』が、DB のランクの基準(db/102_rank_perks.sql)と同じ
const sql102 = read("../db/102_rank_perks.sql");
for (const code of ["amber", "emerald", "ruby", "onyx"]) {
  const min = Number(sql102.match(new RegExp(`set min_points = (\\d+)\\s+where rank_code = '${code}'`))?.[1]);
  assert.ok(min > 0, `102 に ${code} の基準がない`);
  const line = benefitLine(code);
  assert.ok(line.includes(`${min.toLocaleString("en-US")}pt達成`), `会員証の ${code} の基準が DB(${min}pt)と違う`);
}
ok("会員証の特典の『○○pt達成』(1,000 / 3,000 / 6,000 / 10,000)が、DB のランクの基準と同じ");
console.log(`\n${n} kiosk copy checks passed`);
