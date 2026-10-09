// gas_backup/backup.gs のロジックを、Google のサービスの代替(スタブ)の上で検証する。Edge Function は実物(handler.ts)+実 PostgreSQL。本番には接続しない。
// 実行: node --experimental-strip-types test_backup.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { startPg, q } from "../patches/pgdb.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { handle } from "../functions/backup-export/handler.ts";

const pg = startPg(); let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const SECRET = "k".repeat(64);
try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant select on auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.loadFile("100_phase1_schema.sql");
  pg.exec(`update system_state set state='frozen'; select public.import_opening_balance('user00001','試験','2011158053','U${"1".repeat(32)}',10000,null,null,'t','2026-10-09T00:00:00Z');`);

  const files = []; const mails = []; let corrupt = false, down = false;
  const props = { CHECKIN_SECRET: SECRET, BACKUP_URL: "https://edge.test/backup-export", BACKUP_NOTIFY: "owner@example.test" };
  const sb = rpcOver(pg);
  const ctx = {
    console, JSON, String, Date, Error,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "me@example.test" }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA256" }, Charset: { UTF_8: "utf8" },
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac("sha256", k).update(v).digest()].map((x) => (x > 127 ? x - 256 : x)),
      computeDigest: (_a, t) => [...crypto.createHash("sha256").update(t, "utf8").digest()].map((x) => (x > 127 ? x - 256 : x)),
      formatDate: () => "20261209_0300",
    },
    DriveApp: { getFoldersByName: () => ({ hasNext: () => false }), createFolder: () => ({ createFile: (name, content) => { const f = { name, content, getName: () => name, getSize: () => content.length }; files.push(f); return f; } }) },
    MailApp: { sendEmail: (to, subj, body) => mails.push({ to, subj, body }) },
    UrlFetchApp: { fetch: () => { throw new Error("replaced below"); } },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ inTimezone: () => ({ create() {} }) }) }) }) }) },
  };
  const cache = new Map();   // GAS の fetch は同期。ハンドラー(非同期)の実応答を先に作って渡す
  const run = vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL("./backup.gs", import.meta.url), "utf8"), run);
  // ハンドラー(実物)を呼ぶブリッジ
  const bridge = async (body, auth) => {
    const res = await handle(new Request("https://edge.test/backup-export", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) }), { supabase: sb, secret: SECRET, nowMs: () => Date.now() });
    const text = await res.text(); return { getResponseCode: () => res.status, getContentText: () => (corrupt && body.action === "export" ? text.replace("試験", "牧埜") : text) };
  };
  const token = vm.runInContext(`backupToken_(${JSON.stringify(SECRET)})`, run);
  ctx.UrlFetchApp.fetch = (url, o) => {
    if (down) throw new Error("network down");
    const body = JSON.parse(o.payload);
    const r = cache.get(body.action) ; if (!r) throw new Error("unprepared " + body.action); return r(body, o.headers.Authorization);
  };
  const doRun = async () => {
    // 事前に export/record の実応答を作る(handler は実物)。順番どおりに dailyBackup が消費する
    const exportRes = await bridge({ action: "export" }, "Bearer " + token);
    const pending = [];
    cache.set("export", () => exportRes);
    cache.set("record", (b, a) => { pending.push([b, a]); return { getResponseCode: () => 200, getContentText: () => '{"status":"recorded"}' }; });
    const out = vm.runInContext("dailyBackup()", run);
    for (const [b, a] of pending) await bridge(b, a);
    return out;
  };

  // 1) 正常: 保存・SHA照合・記録
  let r = await doRun();
  assert.equal(r.ok, true); assert.equal(files.length, 1); assert.match(files[0].name, /^10zen_backup_.*\.json$/); assert.equal(mails.length, 0);
  const saved = JSON.parse(files[0].content); assert.equal(saved.tables.members.length, 1); assert.equal(saved.tables.point_ledger.length, 1);
  assert.equal(pg.exec(`select count(*) from backup_runs where ok;`), "1");
  ok("毎日のバックアップ(GAS→backup-export→DB): 全データ+設定をJSONで取得し、SHA-256を再計算して照合、ドライブに保存、DBに成功を記録。通知メールは出ない");

  // 2) 通信途中の破損 → 保存せず、失敗を記録しメール通知
  corrupt = true; r = await doRun(); corrupt = false;
  assert.equal(r.ok, false); assert.match(r.error, /SHA-256/); assert.equal(files.length, 1); assert.equal(mails.length, 1);
  assert.equal(mails[0].to, "owner@example.test"); assert.match(mails[0].subj, /失敗/); assert.equal(pg.exec(`select count(*) from backup_runs where not ok;`), "1");
  ok("内容が途中で壊れた場合: SHA-256 不一致を検知して保存せず、失敗をDBに記録し、メールで通知する");

  // 3) 設定漏れ・認証違い・通信不可 → 通知
  const keep = props.CHECKIN_SECRET; props.CHECKIN_SECRET = "x".repeat(64);
  const exportBad = { getResponseCode: () => 401, getContentText: () => '{"error":"unauthorized"}' };
  cache.set("export", () => exportBad); cache.set("record", () => ({ getResponseCode: () => 401, getContentText: () => "{}" }));
  r = vm.runInContext("dailyBackup()", run); assert.equal(r.ok, false); assert.match(r.error, /HTTP 401/); assert.equal(mails.length, 2);
  props.CHECKIN_SECRET = keep; delete props.BACKUP_URL; r = vm.runInContext("dailyBackup()", run); assert.equal(r.ok, false); assert.match(r.error, /未設定/); assert.equal(mails.length, 3);
  props.BACKUP_URL = "https://edge.test/backup-export"; down = true; r = vm.runInContext("dailyBackup()", run); down = false; assert.equal(r.ok, false); assert.equal(mails.length, 4);
  ok("認証の不一致(401)・設定漏れ・通信不可のいずれでも、保存せずメールで通知する(黙って失敗しない)");
  assert.equal(files.length, 1);
  // 4) 保存したバックアップから復元できる(空のDBへ)
  pg.createDb("t2");
  pg.execIn("t2", `create role dummy nologin; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role; grant select on auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.loadFileIn("t2", "100_phase1_schema.sql");
  const rs = pg.execIn("t2", `set role service_role;\nselect public.restore_backup(${q(files[0].content)}::jsonb);`);
  assert.match(rs, /"balanceMismatches": 0/); assert.equal(pg.execIn("t2", `select balance from public.members where member_no='user00001';`), "10000");
  ok("ドライブに保存されたバックアップのファイルそのものから、空のDBへ復元でき、残高(10,000)と台帳が一致する(復元訓練)");
  console.log(`\n${n} backup tests passed`);
} finally { pg.stop(); }
