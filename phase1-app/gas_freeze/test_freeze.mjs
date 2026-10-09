// gas_freeze/freeze.gs と FREEZE_PATCH.md の検証。保存済みの GAS ソース(コード.gs の写し)に実際に6か所を追加し、
//  ①追加後もコードとして構文が正しい ②6関数すべてで凍結ガードが先頭にある ③凍結の有無でガードの挙動が変わる ④凍結中の確認関数(drain/snapshot)が期待どおり、を確かめる。
// 実行: node --experimental-strip-types test_freeze.mjs <GASソースの写し(コード.gs 部分を含むテキスト)>
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const srcPath = process.argv[2] || new URL("../gas/gas_source.txt", import.meta.url).pathname;
if (!fs.existsSync(srcPath)) { console.log("SKIP: GAS ソースの写し(非公開。共通PINを含むため同梱しない)が無いので、6か所への追加の検証は省略します。引数にパスを渡すと実行できます"); process.exit(0); }
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const raw = fs.readFileSync(srcPath, "utf8").replace(/\\_/g, "_").replace(/\\([*#`~\[\]()!<>])/g, "$1");
const start = raw.indexOf("// 店舗スタッフ用の共通暗証番号"), end = raw.indexOf("HtmlService.createHtmlOutputFromFile") >= 0 ? raw.length : raw.length;
let code = raw.slice(start, end);
const cut = code.search(/^\s*(?:admin|index)(?:HTML|html)?\s*$/m);   // コード.gs の後ろに HTML ファイルが続く場合は手前まで
const upto = code.indexOf("<!DOCTYPE"); if (upto > 0) code = code.slice(0, upto);
const insertions = [["function doGet(e) {", "var fg_ = freezeGuardGet_(e); if (fg_) return fg_;"], ["function lineEntry(lineUserId, displayName, refCode, action) {", "freezeGuard_();"],
  ["function registerNewUser(displayName, refCode) {", "freezeGuard_();"], ["function processUser(userId, action) {", "freezeGuard_();"],
  ["function usePoints(userId, useAmount, inputPin) {", "freezeGuard_();"], ["function getAdminDashboardData() {", "freezeGuard_();"]];
for (const [sig, add] of insertions) { assert.equal(code.split(sig).length - 1, 1, "入口が1つだけ見つかる: " + sig); code = code.replace(sig, sig + "\n  " + add); }
const callSites = code.split(/(?<![A-Za-z_])notifyNexto\(lineUserId, /).length - 1 - 1;   // 定義(function notifyNexto(lineUserId, ...)を除く呼び出し
assert.equal(callSites, 2, "コード.gs の notifyNexto 呼び出しは2か所: " + callSites);
// 構文の検証(HTML 以外の部分)
const js = code.slice(0, code.search(/<!DOCTYPE|<html/i) > 0 ? code.search(/<!DOCTYPE|<html/i) : code.length);
new vm.Script(js + "\n" + fs.readFileSync(new URL("./freeze.gs", import.meta.url), "utf8"));
ok("実際のソースに6か所を追加しても構文が正しく、freeze.gs と同居できる");
for (const [sig, add] of insertions) { const i = js.indexOf(sig); assert.ok(js.slice(i + sig.length, i + sig.length + 120).replace(/\s+/g, " ").startsWith(" " + add), sig); }
ok("6つの入口(doGet / lineEntry / registerNewUser / processUser / usePoints / getAdminDashboardData)すべてで、凍結ガードが関数の先頭にある");

// 挙動: ガードの単体
const who = { email: "me@example.test" }; const props = {}; const triggers = [{ f: "dailyBackup" }, { f: "nightlyThing" }, { f: "replayNextoFailures" }]; const deleted = []; let lockOk = true; const sheets = { NextoFailures: [["a"], ["x", "", "k", "", "", "", "", "", ""], ["x", "", "k2", "", "", "", "", "", "t"]] };
const ctx = { console, JSON, Date, Error, String, isNaN, parseInt,
  Session: { getEffectiveUser: () => ({ getEmail: () => "me@example.test" }), getActiveUser: () => ({ getEmail: () => who.email }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
  ContentService: { MimeType: { JAVASCRIPT: "js" }, createTextOutput: (t) => ({ t, setMimeType(m) { this.m = m; return this; } }) },
  HtmlService: { createHtmlOutput: (h) => ({ h }) },
  ScriptApp: { getProjectTriggers: () => triggers.filter((t) => !deleted.includes(t)).map((t) => ({ getHandlerFunction: () => t.f, t })), deleteTrigger: (o) => deleted.push(o.t) },
  LockService: { getScriptLock: () => ({ waitLock: () => { if (!lockOk) throw new Error("busy"); }, releaseLock() {} }) },
  Utilities: { DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }, computeDigest: (_a, t) => [...Buffer.from(require_crypto(t), "hex")], base64Encode: (b) => Buffer.from(b).toString("base64"), formatDate: (d) => d.toISOString().slice(0, 10) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (nm) => nm === "NextoFailures" ? { getLastRow: () => sheets.NextoFailures.length, getDataRange: () => ({ getValues: () => sheets.NextoFailures }) } : { getDataRange: () => ({ getValues: () => USERS }) } }) },
  parseCount_: (v) => (typeof v === "number" ? v : null), cellKind_: (v) => (v instanceof Date ? "date" : typeof v) };
import crypto from "node:crypto";
function require_crypto(t) { return crypto.createHash("sha256").update(t, "utf8").digest("hex"); }
let USERS = [["h"], ["user00001", "試験", "AMBER", 10000, new Date("2026-08-01T00:00:00Z"), new Date("2026-10-08T00:00:00Z"), "", "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"], ["user00002", "x", "WHITE OPAL", 100, 100, "2026-10-08", "", ""]];
vm.createContext(ctx); vm.runInContext(fs.readFileSync(new URL("./freeze.gs", import.meta.url), "utf8"), ctx);
const run = (c) => vm.runInContext(c, ctx);
assert.equal(run("freezeGuardGet_({parameter:{}})"), null); run("freezeGuard_()");
ok("凍結前(FROZEN 未設定): ガードは何もしない(従来どおり動く)");
const fz = run("freezeOn()"); assert.equal(JSON.stringify(fz.removedTriggers), '["nightlyThing","replayNextoFailures"]'); assert.equal(JSON.stringify(deleted.map((t) => t.f)), '["nightlyThing","replayNextoFailures"]');
assert.throws(() => run("freezeGuard_()"), /移行中/);
const jsonp = run("freezeGuardGet_({parameter:{callback:'cb_1'}})"); assert.match(jsonp.t, /^cb_1\(\{"status":"maintenance"/); assert.equal(jsonp.m, "js");
const evil = run("freezeGuardGet_({parameter:{callback:'alert(1);//'}})"); assert.ok(evil.h, "不正なコールバック名は JSONP にせず HTML を返す");
assert.ok(run("freezeGuardGet_({parameter:{page:'admin'}})").h.includes("移行中"));
ok("凍結中: 書込み系は例外、doGet は JSONP/HTML ともに『メンテナンス中』(不正なコールバック名は JSONP にしない)。書込みの可能性があるトリガーは削除し、バックアップのトリガーは残る");
let st = run("drainStatus()"); assert.equal(st.frozen, true); assert.equal(st.lockFree, true); assert.equal(st.pendingFailureQueue, 1);
sheets.NextoFailures[1][8] = "t"; st = run("drainStatus()"); assert.equal(st.pendingFailureQueue, 0); lockOk = false; st = run("drainStatus()"); assert.equal(st.lockFree, false); lockOk = true;
ok("書込み停止の確認(drainStatus): ロックが空いているか・失敗キューの未再送件数・残っているトリガーを返し、未完了なら『まだ完了していません』と出す");
const s1 = run("snapshotUsers()"), s2 = run("snapshotUsers()"); assert.equal(s1.hash, s2.hash); assert.equal(s1.rows[0].points, 10000); assert.equal(s1.rows[0].lifetime, null); assert.equal(s1.rows[0].lifetimeCell, "date");
assert.ok(!JSON.stringify(s1).includes("試験") && !JSON.stringify(s1).includes("Uxxxx"));
USERS[1][3] = 10100; assert.notEqual(run("snapshotUsers()").hash, s1.hash);
ok("最終値の確定(snapshotUsers): 値と型だけを出し(氏名・LINE ID は出さない)、変化が無ければハッシュが同じ・1件でも変わればハッシュが変わる。日付書式の累計は『読めない(null)』として扱い推測しない");
// 所有者以外(匿名・他のユーザー)は公開関数を呼べない。凍結の解除は ALLOW_UNFREEZE を手で設定したときだけ
for (const email of ["", "other@example.test"]) { who.email = email;
  for (const fn of ["freezeOn()", "drainStatus()", "snapshotUsers()", "abortCutoverUnfreeze()"]) assert.throws(() => run(fn), /権限がありません/, fn + " / " + email); }
who.email = "me@example.test"; assert.equal(props.FROZEN, "1");
assert.throws(() => run("abortCutoverUnfreeze()"), /ALLOW_UNFREEZE/); assert.equal(props.FROZEN, "1");
assert.equal(typeof run("typeof freezeOff"), "string"); assert.equal(run("typeof freezeOff"), "undefined");
props.ALLOW_UNFREEZE = "1"; run("abortCutoverUnfreeze()"); assert.equal(props.FROZEN, undefined); assert.equal(props.ALLOW_UNFREEZE, undefined);
ok("凍結の操作は所有者のみ(匿名・他のユーザーは全関数で拒否)。freezeOff は廃止し、解除は ALLOW_UNFREEZE=1 を手で設定したときだけ(外部から呼んでも書込みは再開しない)");
console.log(`\n${n} freeze tests passed`);
