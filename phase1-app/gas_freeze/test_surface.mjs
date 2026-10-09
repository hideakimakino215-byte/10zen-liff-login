// 追加する GAS ファイルの『公開関数』(末尾が _ でない=画面から誰でも呼べる)を機械的に確認する。ソースの写しは不要。
// 実行: node --experimental-strip-types test_surface.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const files = { "freeze.gs": read("./freeze.gs"), "backup.gs": read("../gas_backup/backup.gs"), "notifyNexto.gs": read("../gas_sync/notifyNexto.gs"), "nexto.gs": read("../gas_sync/nexto.gs") };
const OWNER_ONLY = new Set(["freezeOn", "drainStatus", "snapshotUsers", "abortCutoverUnfreeze", "dailyBackupNow", "installBackupTrigger", "replayNextoFailures", "previewResyncToNexto", "resyncAllToNexto"]);
const THROTTLED = new Set(["dailyBackup"]);
const found = [];
for (const [f, src] of Object.entries(files)) for (const m of src.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{\n?([^\n]*(?:\n[^\n]*){0,2})/gm)) if (!m[1].endsWith("_")) found.push([f, m[1], m[2]]);
const names = found.map((x) => x[1]).sort();
assert.deepEqual(names, [...OWNER_ONLY, ...THROTTLED].sort());
ok("公開関数(末尾が _ でない関数)は想定した10個だけ: " + names.join(" / "));
for (const [f, name, head] of found) { if (OWNER_ONLY.has(name)) assert.match(head, /assertOwner_\(\)/, `${f}:${name} の先頭に assertOwner_() がない`); }
const bk = files["backup.gs"]; assert.match(bk.slice(bk.indexOf("function dailyBackup()"), bk.indexOf("function dailyBackup()") + 200), /claimBackupSlot_\(\)/);
const claim = bk.slice(bk.indexOf("function claimBackupSlot_()"), bk.indexOf("function dailyBackup()")); assert.match(claim, /tryLock/); assert.match(claim, /BACKUP_LAST_ATTEMPT[\s\S]*setProperty[\s\S]*releaseLock/);
ok("所有者のみの9関数は先頭で assertOwner_() を呼び、トリガーの入口 dailyBackup は、ロック内で判定と実行枠の確保を行う6時間に1回までの制限つき");
assert.ok(!/function\s+freezeOff\b/.test(files["freeze.gs"]) && !/function\s+notifyNexto\s*\(/.test(files["notifyNexto.gs"]) && /function\s+notifyNexto_\s*\(/.test(files["notifyNexto.gs"]));
ok("freezeOff は存在せず、notifyNexto は notifyNexto_ に改名されている(画面から呼べない)");
// 貼り付け用の結合版(nexto_v6_combined.gs): 構文が正しく、同じ名前の関数が重複していない(後ろの定義が前を黙って上書きするため)、貼り付ける2ファイルの内容を過不足なく含む
{ const comb = read("../gas_sync/nexto_v6_combined.gs"); const vm = await import("node:vm"); new vm.Script(comb);
  const names = [...comb.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]); assert.equal(names.length, new Set(names).size, "重複: " + names.filter((x, i) => names.indexOf(x) !== i));
  assert.ok(comb.includes(files["nexto.gs"]) && comb.includes(files["notifyNexto.gs"]));
  assert.deepEqual(names.filter((x) => !x.endsWith("_")).sort(), ["previewResyncToNexto", "replayNextoFailures", "resyncAllToNexto"]); }
ok("貼り付け用の結合版: 構文OK・関数の重複なし・2ファイルの全文を含む・公開関数は所有者のみの3つだけ");
console.log(`\n${n} surface tests passed`);
