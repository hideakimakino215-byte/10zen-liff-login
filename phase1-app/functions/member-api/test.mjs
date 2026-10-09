// member-api(お客様向け API)+ 店頭QRトークンの検証。DB は実 PostgreSQL 16、LINE の検証 API は注入したスタブ。
// 実行: node --experimental-strip-types test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { startPg, q } from "../../patches/pgdb.mjs";
import { rpcOver } from "../../patches/pgrpc.mjs";
import { handle } from "./handler.ts";
import { makeToken, verifyToken, SLOT_SEC } from "./qr.ts";
import { handle as staffQr } from "../staff-qr/handler.ts";
import { makeJwt, lineVerify } from "../../patches/jwtstub.mjs";
import { handle as backupHandle, backupToken, sha256Hex } from "../backup-export/handler.ts";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const CH = "2011158053", SECRET = "s".repeat(64), UNIT = "10zen_aoyama";
const T0 = Date.parse("2026-11-10T03:00:00Z");   // JST 12:00(キャンペーン期間外)
let NOW = T0;
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
// LINE の検証 API のスタブ(JWT 形のトークン。署名部 BAD は拒否)。LINE 障害は fetchMode.down で再現
const counter = { n: 0 };
const lineFetch = (mode = {}) => async (url, init) => { if (mode.down) throw new Error("network down"); return lineVerify(() => NOW, counter)(url, init); };
let fetchMode = {};
const mk = (opts = {}) => ({ fetchFn: (u, i) => lineFetch(fetchMode)(u, i), supabase: rpcOver(pg, opts), lineLoginChannelId: CH, qrSecret: SECRET, businessUnit: UNIT,
  allowedOrigins: ["https://card.example.test"], nowMs: () => NOW });
const call = async (action, body = {}, { token, origin, method = "POST", deps } = {}) => {
  const headers = { "content-type": "application/json" }; if (token !== null) { headers["x-liff-id-token"] = toJwt(token ?? `tok:${sub("a")}:試験`); } if (origin) headers.origin = origin;
  const res = await handle(new Request("https://x.test/member-api", { method, headers, body: method === "POST" ? JSON.stringify({ action, ...body }) : undefined }), deps ?? mk());
  const text = await res.text(); return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, text };
};
const toJwt = (tk0) => {
  if (!tk0.startsWith("tok:") && !["bad", "expired", "wrongaud"].includes(tk0)) return tk0;
  if (tk0 === "bad") return makeJwt({ sub: sub("a"), nowMs: NOW, bad: true });
  if (tk0 === "expired") return makeJwt({ sub: sub("a"), exp: Math.floor(NOW / 1000) - 10, nowMs: NOW });
  if (tk0 === "wrongaud") return makeJwt({ sub: sub("a"), aud: "999", nowMs: NOW });
  const ps = tk0.split(":"); return makeJwt({ sub: ps[1], name: ps.slice(2).join(":"), nowMs: NOW });
};
const tokenAt = async (ms) => (await makeToken(SECRET, UNIT, ms)).token;

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.loadFile("100_phase1_schema.sql");
  pg.exec(`update system_state set state='open';`);
  pg.exec(`update app_settings set value='false' where key='register_counts_as_visit';`);   // 登録日の扱い(既定=来店日として扱う)は DB テストと下の専用ケースで検証。ここでは来店の流れを見るため解除
  assert.equal(fs.readFileSync(new URL("./qr.ts", import.meta.url), "utf8"), fs.readFileSync(new URL("../staff-qr/qr.ts", import.meta.url), "utf8"));
  ok("スキーマ適用。member-api と staff-qr の qr.ts は同一内容(デプロイ時に両方へ同梱)");

  // ---- 店頭QRトークン ----
  const a = await makeToken(SECRET, UNIT, T0), b = await makeToken(SECRET, UNIT, T0 + 1000), c2 = await makeToken(SECRET, UNIT, T0 + SLOT_SEC * 1000);
  assert.equal(a.token, b.token); assert.notEqual(a.token, c2.token); assert.equal(c2.slot, a.slot + 1);
  assert.ok(!a.token.includes(SECRET)); assert.match(a.token, /^[0-9]+\.[A-Za-z0-9_-]{22}$/);
  assert.notEqual((await makeToken(SECRET, "other_unit", T0)).token.split(".")[1], a.token.split(".")[1]);
  assert.notEqual((await makeToken("t".repeat(64), UNIT, T0)).token.split(".")[1], a.token.split(".")[1]);
  ok("QRトークン: 30秒ごとに変わる・同じスロット内は同じ・秘密/事業単位が違えば署名が違う・秘密を含まない");
  const cur = a.slot; const mkSlot = async (s) => (await makeToken(SECRET, UNIT, s * SLOT_SEC * 1000)).token;
  const V = async (tok, now = T0) => verifyToken(SECRET, UNIT, tok, now, 3);
  assert.equal((await V(await mkSlot(cur))).ok, true); assert.equal((await V(await mkSlot(cur - 3))).ok, true); assert.equal((await V(await mkSlot(cur + 1))).ok, true);
  assert.deepEqual(await V(await mkSlot(cur - 4)), { ok: false, reason: "expired" }); assert.deepEqual(await V(await mkSlot(cur + 2)), { ok: false, reason: "future" });
  const forged = a.token.slice(0, -1) + (a.token.slice(-1) === "A" ? "B" : "A");
  assert.deepEqual(await V(forged), { ok: false, reason: "forged" });
  for (const bad of [null, undefined, 123, "", "abc", "1.2", a.token + "x", "x".repeat(100), `${cur}.${"A".repeat(22)}`, "-5." + a.token.split(".")[1]]) assert.equal((await V(bad)).ok, false, String(bad));
  assert.deepEqual(await verifyToken(SECRET, UNIT, a.token, T0 + 5 * 60 * 1000, 3), { ok: false, reason: "expired" });
  ok("QR検証: 現在〜3スロット前(約2分)と1つ先は有効。4つ前は期限切れ・2つ先は未来・改ざん/形式不正/型違いは拒否。5分後の写真は無効");

  // ---- 認証・入力・CORS ----
  assert.equal((await call("me", {}, { token: null })).status, 401);
  assert.equal((await call("me", {}, { token: "bad" })).status, 401);
  assert.equal((await call("me", {}, { token: "expired" })).status, 401);
  assert.equal((await call("me", {}, { token: "wrongaud" })).status, 401);
  assert.equal((await call("me", {}, { token: "tok:notaline:x" })).status, 401);
  assert.equal((await call("me", {}, { token: "t".repeat(5000) })).status, 401);
  const calls0 = counter.n;
  for (const t of ["abc", "a.b", "a.b.c.d", "e30.!!!.x", "e30.bm90anNvbg.x"]) assert.equal((await call("me", {}, { token: t })).status, 401, t);
  assert.equal((await call("me", {}, { token: "expired" })).status, 401); assert.equal((await call("me", {}, { token: "wrongaud" })).status, 401);
  assert.equal(counter.n, calls0, "形式不正・期限切れ・別チャネルのトークンは LINE の検証 API を呼ばずに拒否する");
  fetchMode = { down: true }; let r = await call("me"); assert.equal(r.status, 503); assert.equal(r.body.retryable, true); fetchMode = {};
  assert.equal((await call("me", {}, { method: "GET" })).status, 405);
  const big = await handle(new Request("https://x.test", { method: "POST", headers: { "x-liff-id-token": toJwt(`tok:${sub("a")}:x`) }, body: JSON.stringify({ action: "me", pad: "x".repeat(5000) }) }), mk());
  assert.equal(big.status, 413);
  const badJson = await handle(new Request("https://x.test", { method: "POST", headers: { "x-liff-id-token": toJwt(`tok:${sub("a")}:x`) }, body: "{" }), mk()); assert.equal(badJson.status, 400);
  assert.equal((await call("nope")).status, 400);
  ok("認証・入力: トークンなし/不正/期限切れ/別チャネル/sub不正/巨大は401、LINE障害は503(再試行可)、GETは405、巨大本文413、不正JSON・不明な操作は400");
  r = await call("me", {}, { origin: "https://card.example.test" }); assert.equal(r.headers.get("access-control-allow-origin"), "https://card.example.test");
  r = await call("me", {}, { origin: "https://evil.example.test" }); assert.equal(r.headers.get("access-control-allow-origin"), null);
  const pre = await handle(new Request("https://x.test", { method: "OPTIONS", headers: { origin: "https://card.example.test" } }), mk()); assert.equal(pre.status, 204);
  ok("CORS: 許可した配信元のみ(それ以外には許可ヘッダーを付けない)。プリフライトは204");

  // ---- 登録・表示 ----
  assert.equal((await call("me")).status, 404);
  r = await call("register", { displayName: "偽名(クライアント値)" }); assert.equal(r.status, 201);
  assert.equal(r.body.member.displayName, "試験"); assert.equal(r.body.member.points, 100); assert.equal(r.body.member.memberNo, "user00001");
  r = await call("register", { displayName: "別" }); assert.equal(r.status, 200); assert.equal(r.body.status, "existing"); assert.equal(r.body.member.points, 100);
  r = await call("me"); assert.equal(r.status, 200); assert.equal(r.body.member.points, 100);
  r = await call("me", {}, { token: `tok:${sub("b")}:花子` }); assert.equal(r.status, 404);
  ok("登録・表示: 氏名は検証済みトークンの値を優先(クライアントの偽名は使わない)・初回201/再登録200・他人のIDでは見えない");
  r = await call("register", { referrerMemberNo: "user00001" }, { token: `tok:${sub("b")}:花子` }); assert.equal(r.status, 201); assert.equal(r.body.member.points, 100);
  assert.equal((await call("me")).body.member.points, 200);
  r = await call("register", { referrerMemberNo: "x; drop table members" }, { token: `tok:${sub("c")}:太郎` }); assert.equal(r.body.member.points, 100);
  ok("紹介コード: 紹介者+100。不正な文字を含むコードは無視して通常登録");

  // ---- 来店(店頭QR) ----
  r = await call("checkin", {}); assert.equal(r.status, 400); assert.equal(r.body.error, "invalid_qr");
  r = await call("checkin", { token: forged }); assert.equal(r.body.error, "invalid_qr");
  r = await call("checkin", { token: await mkSlot(cur - 4) }); assert.equal(r.status, 400); assert.equal(r.body.error, "qr_expired");
  r = await call("checkin", { token: await mkSlot(cur + 2) }); assert.equal(r.body.error, "invalid_qr");
  assert.equal((await call("me")).body.member.points, 200);
  ok("来店: QRなし・改ざん・期限切れ・未来のQRは付与されない(ポイント不変)");
  r = await call("checkin", { token: a.token }); assert.equal(r.status, 200); assert.equal(r.body.status, "counted"); assert.equal(r.body.granted, 100); assert.equal(r.body.member.points, 300); assert.equal(r.body.member.visitedToday, true);
  r = await call("checkin", { token: a.token }); assert.equal(r.body.status, "already_today"); assert.equal(r.body.member.points, 300);
  NOW = T0 + 60_000; r = await call("checkin", { token: await tokenAt(NOW) }); assert.equal(r.body.status, "already_today");
  r = await call("checkin", { token: a.token }, { token: `tok:${sub("f")}:未登録` }); assert.equal(r.status, 404);
  assert.equal(Number(pg.exec(`select count(*) from visits;`)), 1);
  ok("来店: 有効なQRで+100・同じ日の再読み取りや再送は付与なし(already_today)・未登録は404");
  // 翌日(JST)は再度付与。QR の写真は日をまたいで使えない
  NOW = T0 + 24 * 3600 * 1000; r = await call("checkin", { token: a.token }); assert.equal(r.body.error, "qr_expired");
  r = await call("checkin", { token: await tokenAt(NOW) }); assert.equal(r.body.status, "counted"); assert.equal(r.body.member.points, 400);
  ok("翌日: 前日のQRは使えず(期限切れ)、翌日のQRで再び+100");
  // 並列(同じ人が2端末で同時に読み取る)
  NOW = T0 + 48 * 3600 * 1000; const tk = await tokenAt(NOW);
  const rs = await Promise.all(Array.from({ length: 10 }, () => call("checkin", { token: tk })));
  assert.equal(rs.filter((x) => x.body.status === "counted").length, 1); assert.equal(rs.filter((x) => x.body.status === "already_today").length, 9);
  ok("同じ人が10回同時に読み取っても付与は1回");

  // ---- ポイント使用の申請 ----
  for (const bad of ["100", 100.5, -100, 0, null, {}, 1e9, true]) assert.equal((await call("redeem_request", { points: bad })).status, 400, String(bad));
  r = await call("redeem_request", { points: 150 }); assert.equal(r.status, 409); assert.equal(r.body.status, "invalid_amount");
  r = await call("redeem_request", { points: 100000 }); assert.equal(r.status, 409); assert.equal(r.body.status, "insufficient_balance");
  const ptsBefore = (await call("me")).body.member.points;
  r = await call("redeem_request", { points: 200 }); assert.equal(r.status, 200); assert.equal(r.body.status, "pending"); assert.match(r.body.member.pendingRedeem.code, /^\d{6}$/); assert.equal(r.body.member.pendingRedeem.yen, 20);
  const code = r.body.member.pendingRedeem.code;
  r = await call("redeem_request", { points: 200 }); assert.equal(r.body.member.pendingRedeem.code, code);
  r = await call("redeem_request", { points: 300 }); assert.equal(r.status, 409); assert.equal(r.body.status, "already_pending");
  assert.equal((await call("me")).body.member.points, ptsBefore);
  r = await call("redeem_cancel"); assert.equal(r.body.status, "cancelled"); assert.equal(r.body.member.pendingRedeem, null);
  r = await call("redeem_cancel"); assert.equal(r.body.status, "nothing_pending");
  ok("ポイント使用の申請: 不正な型・単位違い・残高超過は拒否。有効な申請は6桁コード(円換算つき)・同額の再送は同じコード・取消できる。申請だけでは残高は減らない");
  let last429 = null;
  for (let i = 0; i < 12; i++) { const x = await call("redeem_request", { points: 100 }); if (x.status === 429) { last429 = x; break; } await call("redeem_cancel"); }
  assert.ok(last429 && last429.body.error === "rate_limited" && last429.body.retryable === false);
  ok("申請の連打には回数制限(1時間に10回まで)がかかり 429 を返す");

  // ---- 失敗と情報漏えい ----
  r = await call("me", {}, { deps: mk({ failRpc: () => true }) }); assert.equal(r.status, 500); assert.equal(r.body.retryable, true); assert.ok(!r.text.includes("injected"));
  const every = [];
  for (const [act, body] of [["me", {}], ["register", {}], ["checkin", { token: await tokenAt(NOW) }], ["redeem_cancel", {}]]) every.push((await call(act, body)).text);
  for (const t of every) { assert.ok(!/U[0-9a-f]{32}/.test(t), "LINE の ID を返さない"); assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(t), "内部IDを返さない"); assert.ok(!t.includes(SECRET)); }
  ok("DB障害は詳細を隠して500(再試行可)。応答に LINE の ID・内部ID・秘密は含まれない");
  assert.equal(Number(pg.exec(`select count(*) from public.verify_balances();`)), 0);
  ok("一連の操作の後も、全会員で残高=台帳の合計");

  // ---- staff-qr ----
  const staffRows = { s1: { role: "staff", active: true }, m1: { role: "manager", active: true }, v1: { role: "viewer", active: true }, g1: { role: "staff", active: false }, k1: { role: "kiosk", active: true } };
  const sdeps = (over = {}) => ({ supabase: { auth: { getUser: async (t) => t.startsWith("valid-") ? { data: { user: { id: t.slice(6, 8) } }, error: null } : { data: null, error: { message: "bad" } } },
    from: () => ({ select: () => ({ eq: (_k, v) => ({ maybeSingle: async () => ({ data: staffRows[v] ?? null }) }) }) }) },
    qrSecret: SECRET, businessUnit: UNIT, liffUrl: "https://liff.line.me/2011158053-N7nKgExB", allowedOrigins: ["https://admin.example.test"], nowMs: () => NOW, ...over });
  const sq = async (auth, o = {}) => { const res = await staffQr(new Request("https://x.test", { method: o.method ?? "POST", headers: auth ? { authorization: auth, origin: o.origin ?? "" } : {} }), sdeps(o.deps)); const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null, headers: res.headers }; };
  let s = await sq("Bearer valid-s1" + "x".repeat(20)); assert.equal(s.status, 200); assert.equal((await verifyToken(SECRET, UNIT, s.body.token, NOW, 3)).ok, true);
  assert.ok(s.body.url.startsWith("https://liff.line.me/2011158053-N7nKgExB?action=visit&t=")); assert.ok(s.body.nextChangeAt > NOW);
  assert.equal((await sq("Bearer valid-m1" + "x".repeat(20))).status, 200);
  assert.equal((await sq("Bearer valid-v1" + "x".repeat(20))).status, 403); assert.equal((await sq("Bearer valid-g1" + "x".repeat(20))).status, 403);
  assert.equal((await sq("Bearer valid-zz" + "x".repeat(20))).status, 403); assert.equal((await sq("Bearer nope" + "x".repeat(20))).status, 401);
  assert.equal((await sq(null)).status, 401); assert.equal((await sq("Basic abc")).status, 401); assert.equal((await sq("Bearer valid-s1" + "x".repeat(20), { method: "GET" })).status, 405);
  assert.equal((await sq("Bearer valid-s1" + "x".repeat(20), { deps: { qrSecret: "" } })).status, 401);
  ok("店頭QRの発行(staff-qr): スタッフ/店長のみ。閲覧のみ・退職者・スタッフ以外・不正トークン・秘密未設定は拒否。発行したQRは member-api で有効");
  assert.equal((await sq("Bearer valid-k1" + "x".repeat(20))).status, 200);
  ok("店頭タブレット専用アカウント(kiosk)も店頭QRを取得できる");

  // ---- 凍結中(maintenance)・営業時間外 ----
  pg.exec(`update system_state set state='frozen';`);
  for (const act of ["me", "register", "redeem_cancel"]) { r = await call(act); assert.equal(r.status, 503, act); assert.equal(r.body.error, "maintenance"); assert.equal(r.body.retryable, false); assert.equal(r.headers.get("retry-after"), "300"); }
  r = await call("checkin", { token: await tokenAt(NOW) }); assert.equal(r.status, 503); assert.equal(r.body.error, "maintenance");
  pg.exec(`update system_state set state='open';`);
  pg.exec(`update app_settings set value='9' where key='checkin_open_hour'; update app_settings set value='10' where key='checkin_close_hour';`);   // T0 は JST 12:00 の日 → 時間外
  r = await call("checkin", { token: await tokenAt(NOW) }); assert.equal(r.status, 200); assert.equal(r.body.status, "outside_hours");
  pg.exec(`update app_settings set value='0' where key='checkin_open_hour'; update app_settings set value='24' where key='checkin_close_hour';`);
  ok("凍結中は全操作が 503 maintenance(再試行不可・Retry-After)、営業時間外のQRは outside_hours を返し付与しない");

  // ---- backup-export ----
  const bdeps = { supabase: rpcOver(pg), secret: SECRET, nowMs: () => NOW };
  const tok = await backupToken(SECRET); assert.match(tok, /^[0-9a-f]{64}$/); assert.notEqual(tok, await backupToken("x".repeat(64))); assert.ok(!tok.includes(SECRET));
  const bcall = async (auth, body, d = bdeps, method = "POST") => { const res = await backupHandle(new Request("https://x.test", { method, headers: auth ? { authorization: auth } : {}, body: method === "POST" ? JSON.stringify(body) : undefined }), d); return { status: res.status, body: await res.json() }; };
  assert.equal((await bcall(null, { action: "export" })).status, 401); assert.equal((await bcall("Bearer " + "0".repeat(64), { action: "export" })).status, 401);
  assert.equal((await bcall("Bearer " + SECRET, { action: "export" })).status, 401);   // 秘密そのものでは通らない
  assert.equal((await bcall("Bearer " + tok, { action: "export" }, { ...bdeps, secret: "" })).status, 401);
  assert.equal((await bcall("Bearer " + tok, { action: "export" }, bdeps, "GET")).status, 405);
  assert.equal((await bcall("Bearer " + tok, { action: "nope" })).status, 400);
  const ex = await bcall("Bearer " + tok, { action: "export" }); assert.equal(ex.status, 200);
  assert.equal(await sha256Hex(ex.body.payload), ex.body.sha256);                      // 受け取り側が再計算して照合できる
  assert.equal(ex.body.counts.members, Number(pg.exec(`select count(*) from members;`))); assert.ok(!ex.body.payload.includes(SECRET));
  assert.equal((await bcall("Bearer " + tok, { action: "record", ok: true, sha256: ex.body.sha256, counts: ex.body.counts, note: "ok" })).body.status, "recorded");
  assert.equal((await bcall("Bearer " + tok, { action: "record", ok: false, note: "Drive 容量不足" })).body.status, "recorded");
  assert.equal(pg.exec(`select count(*) from backup_runs where ok;`), "1"); assert.equal(pg.exec(`select count(*) from backup_runs where not ok;`), "1");
  fails500: { const e = await bcall("Bearer " + tok, { action: "export" }, { ...bdeps, supabase: rpcOver(pg, { failRpc: () => true }) }); assert.equal(e.status, 500); assert.ok(!JSON.stringify(e.body).includes("injected")); }
  ok("バックアップ書き出し(backup-export): 秘密から計算したトークンのみ受け付け(秘密そのもの・未設定・GETは拒否)、JSON全体+SHA-256を返し受け取り側で再計算して照合でき、成功/失敗を記録できる。DB障害は詳細を隠して500");
  console.log(`\n${n} member-api tests passed`);
} finally { pg.stop(); }
