// 「追加だけで既存に影響しない」の機械的な確認: db/100_phase1_schema.sql の文を走査し、既存の物を変更・削除する文がないことを確かめる。
// 実行: node --experimental-strip-types audit_additive.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const sql = fs.readFileSync(new URL("../db/100_phase1_schema.sql", import.meta.url), "utf8");
const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const created = new Set([...code.matchAll(/create\s+(?:table|sequence|function|trigger|policy|index|unique index)\s+(?:if not exists\s+)?(?:public\.)?([A-Za-z_0-9]+)/gi)].map((m) => m[1]));
const newTables = new Set([...code.matchAll(/create\s+table\s+public\.([A-Za-z_0-9]+)/gi)].map((m) => m[1]));
const EXISTING = ["customers", "interactions", "membership_events", "stores", "experiment_summary", "customer_profile_card", "line_webhook_events"];
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
assert.ok(!/create\s+or\s+replace/i.test(code)); assert.ok(!/\bdrop\s+(table|function|view|trigger|policy|index|sequence|schema)/i.test(code.replace(/drop function if exists %s/g, "")));
assert.ok(!/\btruncate\b/i.test(code.replace(/before truncate/gi, "")));
ok("既存の物を置き換え・削除・全消去する文がない(create or replace / drop / truncate なし。名前が衝突すれば単に失敗してトランザクション全体が取り消される)");
// 101(search_path の固定): 対象は 100 で作った新しい関数だけ。alter function ... set/reset search_path 以外の文はない
{ const c101 = fs.readFileSync(new URL("../db/101_search_path_fix.sql", import.meta.url), "utf8").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const stm = [...c101.matchAll(/alter\s+function\s+public\.([A-Za-z_0-9]+)\(([^)]*)\)\s+set\s+search_path\s*=\s*public\s*;/gi)];
  assert.equal(stm.length, 4); for (const m of stm) assert.ok(created.has(m[1]), "100 で作った関数以外: " + m[1]);
  const rest = c101.replace(/alter\s+function[^;]*;/gi, "").replace(/\b(begin|commit)\s*;/gi, "").trim(); assert.equal(rest, ""); }
const alters = [...code.matchAll(/alter\s+(table|function|sequence|view)\s+([A-Za-z_.0-9]+)\s+([^;]*);/gi)];
for (const a of alters) { const t = a[2].replace(/^public\./, ""); assert.ok(newTables.has(t), "新しい表以外への alter: " + a[0]); assert.match(a[3], /^enable row level security$/i); }
ok("101(search_path の固定)は、100 で作った関数4つへの alter function ... set search_path だけ");
ok(`alter は新しい表への「行レベルセキュリティの有効化」${alters.length}件のみ`);
const dml = [...code.matchAll(/(?:insert\s+into|update|delete\s+from)\s+public\.([A-Za-z_0-9]+)/gi)].map((m) => m[1]);
const touchedExisting = [...new Set(dml.filter((t) => EXISTING.includes(t)))];
assert.deepEqual(touchedExisting, []); 
ok("既存の表への直接の insert / update / delete がない");
const reads = [...new Set([...code.matchAll(/(?:from|join)\s+public\.([A-Za-z_0-9]+)/gi)].map((m) => m[1]).filter((t) => EXISTING.includes(t)))];
const calls = [...new Set([...code.matchAll(/to_regprocedure\('public\.([a-z_]+)\(/g)].map((m) => m[1]))];
assert.deepEqual(reads, ["stores"]); assert.deepEqual(calls.sort(), ["record_membership_checkin", "sync_membership_points"]);
ok(`既存オブジェクトとの接点は『stores の読み取り』と『既存の関数 ${calls.join(" / ")} の呼び出し』だけ(後者は state=open かつ本番会員のときのみ。試験・凍結では呼ばない=別テストで証明)`);
const grants = [...code.matchAll(/(?:grant|revoke)\s+[^;]*?\s+on\s+(?:table\s+|sequence\s+|function\s+)?([^;]*?)\s+(?:to|from)\s/gi)].map((m) => m[1]);
for (const g of grants) for (const e of EXISTING) assert.ok(!new RegExp(`\\b${e}\\b`).test(g), `既存の ${e} への権限変更: ${g}`);
ok("権限(grant / revoke)の対象に既存の表・関数は含まれない(権限の前後一致は test_phase1_db.mjs で別途確認)");
console.log(`\n${n} additive audit checks passed`);
