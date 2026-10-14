// A-1(管理ページ停止)の検証。実行: node --experimental-strip-types test_admin_stop.mjs
import fs from "node:fs"; import vm from "node:vm"; import assert from "node:assert/strict";
import { applyEdits } from "./apply_edits.mjs"; import { applyAdminStop } from "./apply_admin_stop.mjs";
const src = fs.readFileSync(new URL("./fixtures/codegs_excerpt.txt", import.meta.url), "utf8");
const base = applyEdits(src).out, out = applyAdminStop(base);
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const mk = (code) => {
  const ctx = { console, JSON, Date, Error, globalThis: {},
    HtmlService: { createHtmlOutput: (h) => ({ kind: "html", h }), createHtmlOutputFromFile: (f) => ({ kind: "file", f }), createTemplateFromFile: (f) => ({ evaluate: () => ({ kind: "tpl", f }) }) },
    ContentService: { MimeType: { JAVASCRIPT: "js" }, createTextOutput: (t) => ({ t, setMimeType(m) { this.m = m; return this; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) } };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext("function freezeGuard_() {}; function freezeGuardGet_() { return null; }", ctx); vm.runInContext(code, ctx); return ctx;
};
const before = mk(base), after = mk(out);
assert.equal(before.doGet({ parameter: { page: "admin" } }).kind, "file");           // 対照: 停止前は管理画面が返る
const a = after.doGet({ parameter: { page: "admin" } }); assert.equal(a.kind, "html"); assert.match(a.h, /停止しました/); assert.ok(!JSON.stringify(a).includes("admin'"));
ok("管理ページ(?page=admin)は停止のメッセージだけを返し、管理画面(admin)を返さない。停止前は返していた(対照)");
assert.doesNotThrow(() => before.getAdminDashboardData());
assert.throws(() => vm.runInContext("getAdminDashboardData()", after), /停止しました/);
ok("getAdminDashboardData は呼ぶと例外になる(画面からの直接呼び出しも拒否)。停止前は動いていた(対照)");
const p1 = JSON.stringify(vm.runInContext("doGet({parameter:{callback:'cb',api:'probe'}})", before)), p2 = JSON.stringify(vm.runInContext("doGet({parameter:{callback:'cb',api:'probe'}})", after));
assert.equal(p1, p2); assert.equal(after.doGet({ parameter: {} }).kind, "tpl");
ok("確認用の呼び出し(probe)の応答と、会員証の表示(パラメータなし)は変わらない");
const a1 = base.split("\n"), b1 = out.split("\n"); assert.equal(b1.length - a1.length, 2);
ok("変更は追加2行だけ(既存の行は一切変えていない)");
assert.throws(() => applyAdminStop(base.replace("function getAdminDashboardData() {", "function getAdminDashboardData(x) {")), /想定の形/);
assert.throws(() => applyAdminStop(base + "\nif (e.parameter && e.parameter.page === 'admin') {"), /1つではありません/);
ok("想定と違うソースには適用しない");
console.log(`${n} admin-stop checks passed`);
