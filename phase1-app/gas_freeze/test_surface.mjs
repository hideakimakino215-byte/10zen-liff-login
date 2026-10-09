// 追加する GAS ファイルの『公開関数』(末尾が _ でない=画面から誰でも呼べる)を機械的に確認する。ソースの写しは不要。
// 実行: node --experimental-strip-types test_surface.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const files = { "freeze.gs": read("./freeze.gs"), "backup.gs": read("../gas_backup/backup.gs"), "notifyNexto.gs": read("../gas_sync/notifyNexto.gs"), "nexto.gs": read("../gas_sync/nexto.gs") };
const OWNER_ONLY = new Set(["freezeOn", "drainStatus", "snapshotUsers", "abortCutoverUnfreeze", "dailyBackupNow", "replayNextoFailures", "previewResyncToNexto", "resyncAllToNexto"]);
const THROTTLED = new Set(["dailyBackup"]);
const found = [];
for (const [f, src] of Object.entries(files)) for (const m of src.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{\n?([^\n]*(?:\n[^\n]*){0,2})/gm)) if (!m[1].endsWith("_")) found.push([f, m[1], m[2]]);
const names = found.map((x) => x[1]).sort();
assert.deepEqual(names, [...OWNER_ONLY, ...THROTTLED].sort());
ok("公開関数(末尾が _ でない関数)は想定した9個だけ: " + names.join(" / "));
for (const [f, name, head] of found) { if (OWNER_ONLY.has(name)) assert.match(head, /assertOwner_\(\)/, `${f}:${name} の先頭に assertOwner_() がない`); }
const dbk = files["backup.gs"].slice(files["backup.gs"].indexOf("function dailyBackup()")); assert.match(dbk.slice(0, 400), /BACKUP_LAST_ATTEMPT/);
ok("所有者のみの8関数は先頭で assertOwner_() を呼び、トリガーの入口 dailyBackup は6時間に1回までの制限つき");
assert.ok(!/function\s+freezeOff\b/.test(files["freeze.gs"]) && !/function\s+notifyNexto\s*\(/.test(files["notifyNexto.gs"]) && /function\s+notifyNexto_\s*\(/.test(files["notifyNexto.gs"]));
ok("freezeOff は存在せず、notifyNexto は notifyNexto_ に改名されている(画面から呼べない)");
console.log(`\n${n} surface tests passed`);
