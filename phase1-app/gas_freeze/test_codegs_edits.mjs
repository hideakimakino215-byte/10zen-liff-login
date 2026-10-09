// A3 手順4 の最終編集(apply_edits.mjs)の検証。配信中コード.gs の抜粋の写し(fixtures/)に適用して確認する。実行: node --experimental-strip-types test_codegs_edits.mjs
import fs from "node:fs"; import vm from "node:vm"; import assert from "node:assert/strict";
import { applyEdits, GUARDS } from "./apply_edits.mjs";
const src = fs.readFileSync(new URL("./fixtures/codegs_excerpt.txt", import.meta.url), "utf8");
const freeze = fs.readFileSync(new URL("./freeze.gs", import.meta.url), "utf8");
const nexto6 = fs.readFileSync(new URL("../gas_sync/nexto_v6_combined.gs", import.meta.url), "utf8");
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const { out, log } = applyEdits(src);
// 1. 6入口すべてで、ガードが宣言行の直後(最初の文)にある。getAdminDashboardData は try の外
for (const [sig, add] of GUARDS) { const i = out.indexOf(sig); assert.ok(out.slice(i + sig.length).replace(/^\s+/, "").startsWith(add), sig); }
assert.match(out, /function getAdminDashboardData\(\) \{\n  freezeGuard_\(\);\n  try \{/);
assert.match(out, /function usePoints\(userId, useAmount, inputPin\) \{\n  freezeGuard_\(\);\n  if \(inputPin !== STAFF_PIN\)/);
ok("6つの入口すべてで、凍結ガードが関数の最初の文(getAdminDashboardData は try の外、usePoints は PIN 判定より前)");
// 2. 改名: notifyNexto( は残らず、notifyNexto_( が2か所(lineEntry 内)。旧関数名は変わらない
assert.equal((out.match(/(?<![A-Za-z0-9_])notifyNexto\(/g) || []).length, 0);
assert.equal((out.match(/notifyNexto_\(/g) || []).length, 2);
assert.ok(out.includes("function notifyNextoLegacyUnused_("));
const le = out.slice(out.indexOf("function lineEntry"));
assert.equal((le.match(/notifyNexto_\(/g) || []).length, 2);
ok("notifyNexto( の呼び出し2か所(どちらも lineEntry)が notifyNexto_( になり、旧関数 notifyNextoLegacyUnused_ は変わらない");
// 3. 構文と結合: 編集後の コード.gs + freeze.gs + backup.gs + v6 を同じプロジェクトとして読み込める。notifyNexto_ は v6 に定義がある
const backup = fs.readFileSync(new URL("../gas_backup/backup.gs", import.meta.url), "utf8");
new vm.Script([out, freeze, backup, nexto6].join("\n"));
assert.ok(/function notifyNexto_\(/.test(nexto6) && !/function notifyNexto\(/.test(nexto6));
ok("編集後の コード.gs と freeze.gs / backup.gs / nexto.gs(v6) を同一プロジェクトとして読み込める(関数の重複定義なし・構文OK)");
// 4. キャンペーン停止: 期間条件が、停止前は 10/10〜10/31 で真、停止後は全期間で偽。0pt履歴・案内文の分岐に入らない
function campaignHit(code, iso) {
  const RealDate = Date; const fixed = new RealDate(iso).getTime();
  class D extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
  const ctx = { Date: D, console, JSON, HtmlService: {}, ContentService: {}, LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, globalThis: {} };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext("function freezeGuard_() {}; function freezeGuardGet_() { return null; }", ctx); vm.runInContext(code, ctx);
  const r = vm.runInContext('registerNewUser("a","")', ctx); return { hit: !!ctx.__campaignHit, msg: r.message };
}
assert.equal(campaignHit(src, "2026-10-15T12:00:00+09:00").hit, true);   // 停止前は動く(対照)
assert.equal(campaignHit(src, "2026-10-09T12:00:00+09:00").hit, false);
for (const d of ["2026-10-09T12:00:00+09:00", "2026-10-10T00:00:00+09:00", "2026-10-15T12:00:00+09:00", "2026-10-31T23:59:59+09:00", "2026-11-01T00:00:00+09:00", "2027-06-01T00:00:00+09:00"]) {
  const r = campaignHit(out, d); assert.equal(r.hit, false, d); assert.ok(!r.msg.includes("キャンペーン"), d);
}
ok("キャンペーン停止: 編集前は 10/15 に動く(対照)。編集後は 10/9〜翌年まで一度も分岐に入らず、0pt履歴・案内文も作られない");
// 5. 変更はこの9か所だけ(行単位の差分が、追加6行+改名2行+期間1行)
const a = src.split("\n"), b = out.split("\n"); assert.equal(b.length - a.length, 6);
let changed = 0; { let j = 0; for (let i = 0; i < a.length; i++, j++) { while (j < b.length && b[j] !== a[i] && /^  (freezeGuard_|var fg_)/.test(b[j])) j++; if (b[j] !== a[i]) changed++; } }
assert.equal(changed, 3, "既存の行の変更は 改名2+期間1 のみ: " + changed);
ok("既存の行の変更は『改名2行+キャンペーン期間1行』だけで、他の行は一切変えていない(追加は6行)");
// 6. 安全側: 想定と違うソースには適用しない
assert.throws(() => applyEdits(src.replace("function processUser(userId, action) {", "function processUser(userId) {")), /1つではありません/);
assert.throws(() => applyEdits(src.replace('2026-10-31T23:59:59', '2026-11-30T23:59:59')), /CAMPAIGN_END/);
assert.throws(() => applyEdits(src + "\nnotifyNexto(1);"), /2か所/);
ok("宣言行・期間・呼び出し数が想定と違うソースには適用せずエラーにする(推測で編集しない)");
console.log(`${n} codegs-edit checks passed`);
