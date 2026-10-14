// gas_backup/watchdog.gs(バックアップの見張り役)を、Google のサービスの代替(スタブ)の上で検証する。Edge Function は実物(handler.ts)+実 PostgreSQL。本番には接続しない。
// 実行: node --experimental-strip-types test_watchdog.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { startPg } from "../patches/pgdb.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { handle, statusToken, backupToken } from "../functions/backup-export/handler.ts";

const pg = startPg(); let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const SECRET = "k".repeat(64), URL_ = "https://edge.test/backup-export", H = 3600 * 1000;
const gasBytes = (buf) => [...buf].map((x) => (x > 127 ? x - 256 : x));
const fmt = (d, _tz, pat) => {   // Utilities.formatDate の代替(Asia/Tokyo 固定)
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return pat.replace("yyyy", p.year).replace("MM", p.month).replace("dd", p.day).replace("HH", p.hour).replace("mm", p.minute).replace(/^d$/, String(Number(p.day)));
};
try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant select on auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.loadFile("100_phase1_schema.sql");
  const sb = rpcOver(pg);
  const call = async (body, tok) => { const r = await handle(new Request(URL_, { method: "POST", headers: { authorization: "Bearer " + tok }, body: JSON.stringify(body) }), { supabase: sb, secret: SECRET, nowMs: () => Date.now() }); return { status: r.status, body: await r.json() }; };

  // ---- 本体(backup.gs)と見張り役(watchdog.gs)は別プロジェクト。それぞれ別の実行環境で読み込む ----
  const who = { email: "owner@example.test" };
  const common = () => ({ console, JSON, String, Date, Error, Number,
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.test" }), getActiveUser: () => ({ getEmail: () => who.email }) },
    Utilities: { computeHmacSha256Signature: (v, k) => gasBytes(crypto.createHmac("sha256", k).update(v).digest()), formatDate: fmt } });
  const mainProps = { CHECKIN_SECRET: SECRET };
  const main = vm.createContext({ ...common(), PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => mainProps[k] ?? null }) } });
  vm.runInContext(fs.readFileSync(new URL("./backup.gs", import.meta.url), "utf8"), main);
  vm.runInContext(fs.readFileSync(new URL("../gas_freeze/freeze.gs", import.meta.url), "utf8"), main);   // assertOwner_

  const wProps = {}, mails = [], fetched = [], triggers = []; let prepared = null, throwNet = false;
  const w = vm.createContext({ ...common(),
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => wProps[k] ?? null }) },
    MailApp: { sendEmail: (to, subj, body) => mails.push({ to, subj, body }) },
    UrlFetchApp: { fetch: (url, o) => { fetched.push({ url, body: JSON.parse(o.payload), auth: o.headers.Authorization }); if (throwNet) throw new Error("network down"); return prepared; } },
    ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyDays: (d) => ({ atHour: (h) => ({ inTimezone: (tz) => ({ create: () => triggers.push({ fn, d, h, tz, getHandlerFunction: () => fn }) }) }) }) }) }) } });
  const wsrc = fs.readFileSync(new URL("./watchdog.gs", import.meta.url), "utf8");
  vm.runInContext(wsrc, w);
  // GAS の fetch は同期。ハンドラー(実物)の応答を先に作っておき、見張り役に渡す
  const check = async (nowMs) => {
    const r = await call({ action: "status" }, wProps.BACKUP_STATUS_TOKEN);
    prepared = { getResponseCode: () => r.status, getContentText: () => JSON.stringify(r.body) };
    mails.length = 0; fetched.length = 0;
    return JSON.parse(JSON.stringify(vm.runInContext(`watchdogCheck_(${nowMs})`, w)));
  };

  // 1) トークン: 本体の showWatchdogToken(所有者のみ)で表示した値は、状態の確認だけに使える
  const tok = vm.runInContext("showWatchdogToken()", main);
  assert.equal(tok, await statusToken(SECRET)); assert.notEqual(tok, await backupToken(SECRET));
  who.email = "other@example.test"; assert.throws(() => vm.runInContext("showWatchdogToken()", main), /権限がありません/); who.email = "owner@example.test";
  assert.equal((await call({ action: "status" }, tok)).status, 200);
  assert.equal((await call({ action: "export" }, tok)).status, 403); assert.equal((await call({ action: "record", ok: true }, tok)).status, 403);
  assert.equal(pg.exec(`select count(*) from backup_runs;`), "0");
  assert.equal((await call({ action: "status" }, "0".repeat(64))).status, 401);
  assert.equal((await call({ action: "status" }, await backupToken(SECRET))).status, 200);   // 本体のトークンでも確認はできる
  ok("見張り用トークン: 本体の showWatchdogToken(所有者のみ)で表示でき、状態の確認だけに使える。会員データの書き出し・記録は 403、誤ったトークンは 401");

  Object.assign(wProps, { BACKUP_URL: URL_, BACKUP_STATUS_TOKEN: tok, WATCHDOG_NOTIFY: "makino@example.test" });
  const D = (s) => new Date(s).getTime();
  // 2) 一度も成功していない → 止まっている知らせ(「記録なし」)
  let r = await check(D("2026-10-15T00:00:00Z"));
  assert.equal(r.status, "stale"); assert.equal(mails.length, 1); assert.equal(mails[0].to, "makino@example.test");
  assert.match(mails[0].subj, /24時間以上止まっています/); assert.match(mails[0].body, /記録なし/); assert.match(mails[0].body, /dailyBackupNow/);
  assert.deepEqual(fetched.map((f) => [f.url, f.body.action]), [[URL_, "status"]]);
  ok("一度もバックアップが成功していないとき: 『24時間以上止まっています』のメール(最後の成功=記録なし、直し方つき)。問い合わせは status だけ");

  // 3) 成功の記録が新しい → メールなし。失敗の記録は「成功」に数えない
  pg.exec(`insert into backup_runs(at, ok) values ('2026-10-14T18:00:00Z', true), ('2026-10-15T18:00:00Z', false);`);
  r = await check(D("2026-10-15T09:00:00Z"));
  assert.equal(r.status, "ok"); assert.equal(r.lastSuccessAt.slice(0, 16), "2026-10-14T18:00"); assert.equal(mails.length, 0);
  ok("最後の成功から24時間以内: メールは出ない(失敗の記録は成功に数えない)");

  // 4) 36時間を超えた → 止まっている知らせ(最後の成功の日時つき・日本時間)
  r = await check(D("2026-10-14T18:00:00Z") + 25 * H);
  assert.equal(r.status, "stale"); assert.equal(mails.length, 1); assert.match(mails[0].body, /2026-10-15 03:00/);
  r = await check(D("2026-10-14T18:00:00Z") + 23 * H); assert.equal(r.status, "ok"); assert.equal(mails.length, 0);
  // 毎朝の具体例: 3:00(日本時間)に成功 → 同じ日の 9:00 は正常(6時間)。翌日のバックアップが失敗 → 翌日 9:00(30時間)に通知
  r = await check(D("2026-10-15T00:00:00Z")); assert.equal(r.status, "ok"); assert.equal(mails.length, 0);
  r = await check(D("2026-10-16T00:00:00Z")); assert.equal(r.status, "stale"); assert.equal(mails.length, 1);
  ok("最後の成功から24時間を超えたらメール(23時間ならなし)。毎朝3時のバックアップが1回失敗すると、その朝9時の確認で気づける");

  // 5) 問い合わせできない(通信エラー・HTTP 500・設定漏れ・トークン違い)も、黙らずにメール
  throwNet = true; r = await check(D("2026-10-15T09:00:00Z")); throwNet = false;
  assert.equal(r.status, "unreachable"); assert.equal(mails.length, 1); assert.match(mails[0].subj, /状態を確認できません/); assert.match(mails[0].body, /通信エラー/);
  const sb2 = rpcOver(pg, { failRpc: (x) => x === "from:backup_runs" });
  const r500 = await handle(new Request(URL_, { method: "POST", headers: { authorization: "Bearer " + tok }, body: '{"action":"status"}' }), { supabase: sb2, secret: SECRET, nowMs: () => Date.now() });
  assert.equal(r500.status, 500);
  mails.length = 0; prepared = { getResponseCode: () => 500, getContentText: () => "{}" }; vm.runInContext(`watchdogCheck_(${D("2026-10-15T09:00:00Z")})`, w);
  assert.equal(mails.length, 1); assert.match(mails[0].body, /HTTP 500/);
  wProps.BACKUP_STATUS_TOKEN = "0".repeat(64); r = await check(D("2026-10-15T09:00:00Z")); assert.equal(r.status, "unreachable"); assert.match(mails[0].body, /HTTP 401/);
  delete wProps.BACKUP_STATUS_TOKEN; mails.length = 0; fetched.length = 0; vm.runInContext(`watchdogCheck_(${D("2026-10-15T09:00:00Z")})`, w);
  assert.equal(mails.length, 1); assert.match(mails[0].body, /設定.*足りません/); assert.equal(fetched.length, 0);
  wProps.BACKUP_STATUS_TOKEN = tok;
  ok("問い合わせ自体ができない(通信エラー・HTTP 500・トークン違い・設定漏れ)ときも、黙らずにメールで知らせる");

  // 6) 毎月1日(日本時間)だけ「見張りは動いています」を1通。止まっているときは止まっている知らせが優先
  pg.exec(`insert into backup_runs(at, ok) values ('2026-10-31T18:00:00Z', true);`);
  r = await check(D("2026-11-01T00:00:00Z"));   // 日本時間 11/1 9:00
  assert.equal(r.heartbeat, true); assert.equal(mails.length, 1); assert.match(mails[0].subj, /正常に動いています/); assert.match(mails[0].body, /2026-11-01 03:00/);
  r = await check(D("2026-11-01T15:30:00Z")); assert.equal(mails.length, 0);   // 日本時間 11/2
  r = await check(D("2026-10-31T18:00:00Z") + 40 * H); assert.equal(r.status, "stale"); assert.equal(mails.length, 1); assert.doesNotMatch(mails[0].subj, /正常/);
  ok("毎月1日(日本時間)だけ『見張りは動いています』のメールを1通(届かなければ見張り役が止まっているとわかる)。止まっているときはその知らせだけ");

  // 7) 通知先の省略時は所有者。トリガーは所有者だけが設定でき、何度実行しても毎朝9時(日本時間)の1つだけ
  delete wProps.WATCHDOG_NOTIFY; r = await check(D("2026-10-31T18:00:00Z") + 40 * H); assert.equal(r.status, "stale"); assert.equal(mails[0].to, "owner@example.test"); wProps.WATCHDOG_NOTIFY = "makino@example.test";
  vm.runInContext("installWatchdogTrigger()", w); vm.runInContext("installWatchdogTrigger()", w);
  assert.equal(triggers.length, 1); assert.deepEqual([triggers[0].fn, triggers[0].d, triggers[0].h, triggers[0].tz], ["watchdogCheck", 1, 9, "Asia/Tokyo"]);
  who.email = "other@example.test"; assert.throws(() => vm.runInContext("installWatchdogTrigger()", w), /権限がありません/); who.email = "owner@example.test";
  ok("通知先を省略すると所有者へ。トリガーは所有者だけが設定でき、何度実行しても毎朝9時(日本時間)の1つだけ");

  // 8) 見張り役の公開関数は2つだけで、データを変える問い合わせはしない
  const pub = [...wsrc.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]).filter((x) => !x.endsWith("_")).sort();
  assert.deepEqual(pub, ["installWatchdogTrigger", "watchdogCheck", "watchdogSelfTest"]);
  assert.ok(!/action:\s*"(export|record)"/.test(wsrc)); assert.ok(!/getProperty\("CHECKIN_SECRET"\)/.test(wsrc));
  ok("見張り役の公開関数は watchdogCheck・installWatchdogTrigger・watchdogSelfTest の3つだけ。会員データの書き出し・記録は呼ばない。元の秘密(CHECKIN_SECRET)は持たず、用途を限定した認証情報だけを使う");

  // 9) 動作確認(所有者のみ): 本番の成功時刻を問い合わせて試験メールを送る。データは変えない。確認結果は実行ログにも残る
  const runsBefore = pg.exec(`select count(*) from backup_runs;`);
  const logs = []; const origLog = w.console; w.console = { log: (x) => logs.push(String(x)) };
  const call2 = await call({ action: "status" }, wProps.BACKUP_STATUS_TOKEN); prepared = { getResponseCode: () => call2.status, getContentText: () => JSON.stringify(call2.body) };
  mails.length = 0; fetched.length = 0;
  r = JSON.parse(JSON.stringify(vm.runInContext("watchdogSelfTest()", w)));
  assert.equal(r.status, "ok"); assert.equal(mails.length, 1); assert.match(mails[0].subj, /見張り.*試験メール.*異常ではありません/); assert.match(mails[0].body, /2026-11-01 03:00/);
  assert.deepEqual(fetched.map((f) => f.body.action), ["status"]); assert.equal(pg.exec(`select count(*) from backup_runs;`), runsBefore);
  assert.ok(logs.some((x) => /見張り役の動作確認/.test(x)));
  vm.runInContext("watchdogCheck()", w); assert.ok(logs.some((x) => /見張り役の確認結果: .*"status"/.test(x)));
  throwNet = true; mails.length = 0; r = JSON.parse(JSON.stringify(vm.runInContext("watchdogSelfTest()", w))); throwNet = false;
  assert.equal(r.status, "unreachable"); assert.match(mails[0].body, /通信エラー/);
  who.email = "other@example.test"; assert.throws(() => vm.runInContext("watchdogSelfTest()", w), /権限がありません/); who.email = "owner@example.test";
  w.console = origLog;
  ok("動作確認 watchdogSelfTest(所有者のみ): 本番の成功時刻を問い合わせ、結果を書いた試験メールを送る。データは変えない。確認結果は実行ログにも残る");
  console.log(`\n${n} watchdog tests passed`);
} finally { pg.stop(); }
