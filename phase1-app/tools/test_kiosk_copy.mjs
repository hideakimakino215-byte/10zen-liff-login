// 店頭タブレットの QR 画面(qr.html)がお客様に見せる数字が、DB の設定と会員証の特典に合っているかを確かめる。
// 実行: node --experimental-strip-types test_kiosk_copy.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const qr = read("../app-reference/qr.html"), sql = read("../db/100_phase1_schema.sql"), card = read("../app-reference/card.html");
const copy = qr.slice(qr.indexOf("const KIOSK_COPY"), qr.indexOf("};", qr.indexOf("const KIOSK_COPY")));
const rule = (code) => Number(sql.match(new RegExp(`\\('${code}',\\s*(\\d+),\\s*true`))?.[1]);
const setting = (key) => Number(sql.match(new RegExp(`\\('${key}',\\s*'(\\d+)'`))?.[1]);

const visit = rule("visit"), welcome = rule("welcome"), yen = setting("yen_per_100pt");
assert.ok(visit > 0 && welcome > 0 && yen > 0, "DB の初期値が読めない");
assert.match(copy, new RegExp(`v: "${visit}pt"`)); assert.match(copy, /1日1回/);
assert.match(copy, new RegExp(`登録\\(${welcome}pt プレゼント\\)`));
ok(`来店ポイント(${visit}pt・1日1回)と登録のポイント(${welcome}pt)が、DB の point_rules と同じ`);

assert.match(copy, new RegExp(`v: "100pt=${yen}円"`)); assert.match(card, new RegExp(`100pt = ${yen}円`));
ok(`ポイントの価値(100pt=${yen}円)が、DB の app_settings と会員証の表示と同じ`);

for (const word of ["薬膳茶", "スイーツ"]) { assert.ok(copy.includes(word), `QR 画面に ${word} がない`); assert.ok(card.includes(word), `会員証の特典に ${word} がない(QR 画面の宣伝と食い違う)`); }
// 会員証の見本で順に見せるランクと特典: ランク名と特典の要点が、会員証の特典の一覧(BENEFITS)にそのままある
const benefits = card.slice(card.indexOf("const BENEFITS"), card.indexOf("]];", card.indexOf("const BENEFITS")));
const ranks = [...copy.matchAll(/\["(\w+)", "([A-Z ]+)", "([^"]+)"\]/g)].map((m) => ({ code: m[1], label: m[2], text: m[3] }));
assert.deepEqual(ranks.map((r) => r.code), ["white_opal", "amber", "emerald", "ruby", "onyx"]);
const keys = { white_opal: "10円", amber: "薬膳茶", emerald: "スイーツ", ruby: "5%OFF", onyx: "試食会" };
for (const r of ranks) { assert.ok(benefits.includes(`"${r.code}", "${r.label}"`), `会員証の特典に ${r.label} がない`); const line = benefits.slice(benefits.indexOf(`"${r.code}"`), benefits.indexOf("]", benefits.indexOf(`"${r.code}"`)));
  assert.ok(r.text.includes(keys[r.code]) && line.includes(keys[r.code]), `${r.label} の特典が会員証と食い違う: ${r.text}`); }
assert.ok(!/キャンペーン/.test(copy), "期間限定のキャンペーンは常設の画面に書かない");
ok("ランク特典の例(薬膳茶・スイーツ)と、見本で順に見せる5ランクの特典が、会員証の特典と同じ。期間限定のキャンペーンは書いていない");
console.log(`\n${n} kiosk copy checks passed`);
