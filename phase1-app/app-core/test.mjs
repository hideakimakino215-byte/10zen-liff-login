// 画面に依存しない「アプリの核」の通し検証: お客様クライアント → member-api → 実 PostgreSQL ← スタッフクライアント。
// 実行: node --experimental-strip-types test.mjs
import assert from "node:assert/strict";
import { startPg, q } from "../patches/pgdb.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { handle as memberApi } from "../functions/member-api/handler.ts";
import { handle as staffQrApi } from "../functions/staff-qr/handler.ts";
import { createMemberClient, qrTokenFromLocation } from "./member-client.mjs";
import { createStaffClient, mapError, redeemReduce, redeemInitial, createQrKiosk } from "./staff-client.mjs";
import { makeJwt, lineVerify } from "../patches/jwtstub.mjs";
import { cardScreen, checkinScreen, redeemScreen, redeemWatch, memberView } from "./screens.mjs";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const CH = "2011158053", SECRET = "k".repeat(64), UNIT = "10zen_aoyama";
let NOW = Date.parse("2026-11-10T03:00:00Z");
const SUB = "U" + "a".repeat(32);
const STAFF = { staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3", mgr: "00000000-0000-0000-0000-0000000000a1" };
const lineFetch = lineVerify(() => NOW);
const jwt = (sub = SUB, name = "x") => makeJwt({ sub, name, nowMs: NOW });
const deps = () => ({ fetchFn: lineFetch, supabase: rpcOver(pg), lineLoginChannelId: CH, qrSecret: SECRET, businessUnit: UNIT, allowedOrigins: [], nowMs: () => NOW });
// member-client の fetch を member-api ハンドラへ直結
let netFail = 0;
const toApi = async (_url, init) => { if (netFail > 0) { netFail--; throw new Error("offline"); } return memberApi(new Request("https://x.test/member-api", { method: "POST", headers: init.headers, body: init.body }), deps()); };
const mkMember = (sub = SUB, name = "試験 太郎") => createMemberClient({ endpoint: "https://x.test/member-api", getIdToken: async () => jwt(sub, name), fetchFn: toApi, sleep: async () => {} });
// スタッフの supabase: 実 PG に authenticated ロールで rpc を実行
const staffSb = (uid) => ({
  async rpc(name, args) {
    const named = Object.entries(args).map(([k, v]) => `${k} => ${v === null || v === undefined ? "null" : q(v)}`).join(", ");
    const r = await pg.runAsync(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\nselect public.${name}(${named});`);
    return r.status === 0 ? { data: JSON.parse(r.stdout), error: null } : { data: null, error: { message: r.stderr } };
  },
  auth: { getSession: async () => ({ data: { session: { access_token: "valid-" + uid.slice(-2) + "x".repeat(30) } } }), signInWithPassword: async () => ({ data: {}, error: null }), signOut: async () => ({}) },
});
const staffQrFetch = (uid) => async (_u, init) => staffQrApi(new Request("https://x.test/staff-qr", { method: "POST", headers: init.headers }), {
  supabase: { auth: { getUser: async (t) => ({ data: { user: { id: "00000000-0000-0000-0000-0000000000" + t.slice(6, 8) } }, error: null }) },
              from: () => ({ select: () => ({ eq: (_k, v) => ({ maybeSingle: async () => ({ data: JSON.parse(pg.exec(`select coalesce((select row_to_json(s) from (select role, active from staff_users where user_id=${q(v)}) s),'null');`)) }) }) }) }) },
  qrSecret: SECRET, businessUnit: UNIT, liffUrl: "https://liff.line.me/2011158053-N7nKgExB", allowedOrigins: [], nowMs: () => NOW });
const mkStaff = (uid) => createStaffClient({ supabase: staffSb(uid), qrEndpoint: "https://x.test/staff-qr", fetchFn: staffQrFetch(uid), uuid: () => "00000000-1111-2222-3333-444444444444" });

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.loadFile("100_phase1_schema.sql");
  pg.exec(`update system_state set state='open';`);
  pg.exec(`update app_settings set value='false' where key='register_counts_as_visit';`);   // 登録日の扱い(既定=来店日として扱う)は DB テストと下の専用ケースで検証。ここでは来店の流れを見るため解除
  pg.exec(`insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role) values ('${STAFF.staff}','スタッフ','staff'),('${STAFF.viewer}','閲覧','viewer'),('${STAFF.mgr}','店長','manager');`);
  const member = mkMember(), staff = mkStaff(STAFF.staff), viewer = mkStaff(STAFF.viewer), mgr = mkStaff(STAFF.mgr);

  // ---- お客様: ログイン → 登録 → 会員証 ----
  const noAuth = createMemberClient({ endpoint: "x", getIdToken: async () => null, fetchFn: toApi });
  assert.equal(cardScreen(await noAuth.me()).screen, "needs_login");
  assert.equal(cardScreen(await createMemberClient({ endpoint: "x", getIdToken: async () => { throw new Error("liff"); }, fetchFn: toApi }).me()).screen, "needs_login");
  assert.equal(cardScreen(await createMemberClient({ endpoint: "x", getIdToken: async () => "bad", fetchFn: toApi }).me()).screen, "needs_login");
  let s = cardScreen(await member.me()); assert.equal(s.screen, "register"); assert.match(s.message, /100pt/);
  const regRes = await member.register(); s = cardScreen(regRes, NOW);
  assert.equal(s.screen, "card"); assert.equal(s.view.displayName, "試験 太郎"); assert.equal(s.view.pointsText, "100 pt"); assert.equal(s.view.yenText, "10円相当");
  assert.equal(s.view.rankLabel, "WHITE OPAL"); assert.equal(s.view.next.label, "AMBER"); assert.equal(s.view.next.remainingText, "あと 9,900 pt"); assert.equal(s.view.lifetimeNote, null);
  assert.equal(s.view.expiresText, "2027年11月10日"); assert.equal(s.view.canRedeem, true); assert.equal(s.view.pending, null); assert.equal(s.view.visitedToday, false);
  ok("お客様: 未ログイン/不正トークン→ログイン画面、未登録→登録画面(100ptの案内)、登録→会員証(氏名・ポイント・円相当・ランク・次ランク・有効期限)");
  assert.deepEqual(memberView({ memberNo: "u", displayName: null, points: null, yenPer100pt: 10, lifetimePoints: null, lifetimeConfirmed: false, nextRank: null, expiresOn: null, redeemUnit: 100 }, NOW).pointsText, "— pt");
  const top = memberView({ memberNo: "u", displayName: "x", points: 300000, yenPer100pt: 10, lifetimePoints: 300000, lifetimeConfirmed: true, nextRank: null, expiresOn: null, redeemUnit: 100, rankLabel: "ONYX" }, NOW);
  assert.equal(top.next.remainingText, "最上位ランクです"); assert.equal(top.next.percent, 100); assert.equal(top.yenText, "30,000円相当");
  ok("表示用データ: 未取得は『—』(0にしない)・氏名未取得は『会員』・最上位ランクは『次まで』を切り替え");

  // ---- 店頭QR → 来店 ----
  const k = await staff.qrToken(); assert.equal(k.kind, "ok"); assert.ok(k.data.url.includes("action=visit"));
  assert.equal((await viewer.qrToken()).kind, "forbidden");
  const tok = qrTokenFromLocation(new URL(k.data.url).search); assert.ok(tok);
  assert.equal(qrTokenFromLocation("?action=visit&t=bad"), null); assert.equal(qrTokenFromLocation("?t=" + tok), null); assert.equal(qrTokenFromLocation(""), null);
  let c = checkinScreen(await member.checkin(tok), NOW); assert.equal(c.screen, "checkin_success"); assert.equal(c.granted, 100); assert.equal(c.view.pointsText, "200 pt"); assert.match(c.message, /100pt/);
  c = checkinScreen(await member.checkin(tok), NOW); assert.equal(c.screen, "checkin_already"); assert.equal(c.view.pointsText, "200 pt");
  assert.equal(checkinScreen(await member.checkin("1.AAAAAAAAAAAAAAAAAAAAAA")).screen, "qr_invalid");
  const old = NOW; NOW += 10 * 60 * 1000; assert.equal(checkinScreen(await member.checkin(tok)).screen, "qr_expired"); NOW = old;
  assert.equal(checkinScreen(await mkMember("U" + "b".repeat(32), "x").checkin(tok)).screen, "register_then_checkin");
  // 登録した日は来店日として扱う(既存と同じ設定)。登録直後の読み取りは『ご登録ボーナス付与済み』と案内する
  pg.exec(`update app_settings set value='true' where key='register_counts_as_visit';`);
  { const M = mkMember("U" + "c".repeat(32), "新規 花子"); await M.register(); const cs = checkinScreen(await M.checkin(tok), NOW); assert.equal(cs.screen, "checkin_already"); assert.equal(cs.reason, "registered_today"); assert.match(cs.message, /ご登録ボーナス/); assert.equal(cs.view.pointsText, "100 pt"); }
  pg.exec(`update app_settings set value='false' where key='register_counts_as_visit';`);
  ok("来店: スタッフ画面のQR→URLからトークン抽出→読み取りで+100・再読み取りは付与済み表示・不正QR/期限切れQR/未登録はそれぞれの画面。閲覧のみのスタッフにはQRを出さない");

  // ---- ポイント使用: お客様の申請 → スタッフ確認 → お客様に完了表示 ----
  let r1 = redeemScreen(await member.redeemRequest(150), NOW); assert.equal(r1.screen, "redeem_form"); assert.match(r1.error, /100pt 単位/);
  assert.equal(redeemScreen(await member.redeemRequest(100000), NOW).error, "ポイントが足りません");
  const req = redeemScreen(await member.redeemRequest(100), NOW); assert.equal(req.screen, "redeem_pending"); assert.match(req.view.pending.codeText, /^\d{3} \d{3}$/); assert.equal(req.view.pending.yen, 10); assert.equal(req.view.pending.secondsLeft, 180);
  assert.equal(redeemScreen(await member.redeemRequest(200), NOW).screen, "redeem_pending");
  const before = req.view;
  // スタッフ: コード入力 → 確認 → 確定
  let st = redeemInitial; st = redeemReduce(st, { type: "lookup_start" }); assert.equal(st.step, "looking_up");
  st = redeemReduce(st, { type: "lookup_result", result: await staff.lookupRedeem(req.view.pending.codeText) });      // 空白入りの入力でも通る
  assert.equal(st.step, "confirm"); assert.equal(st.member.displayName, "試験 太郎"); assert.equal(st.request.yen, 10); assert.equal(st.member.points, 200);
  st = redeemReduce(st, { type: "confirm_start" }); assert.equal(st.step, "confirming"); assert.equal(redeemReduce(st, { type: "confirm_start" }).step, "confirming");
  const reqId = (await staff.lookupRedeem(before.pending.code)).data.request.id;
  st = redeemReduce(st, { type: "confirm_result", result: await staff.confirmRedeem(reqId) });
  assert.deepEqual([st.step, st.points, st.yen, st.balanceAfter], ["done", 100, 10, 100]);
  st = redeemReduce({ step: "confirming", request: {}, member: {} }, { type: "confirm_result", result: await staff.confirmRedeem(reqId) }); assert.equal(st.step, "done");    // 通信が切れて再確認しても二重引落しない
  let after = cardScreen(await member.me(), NOW).view; assert.equal(after.pointsText, "100 pt"); assert.equal(after.pending, null);
  const w = redeemWatch(before, after); assert.equal(w.change, "confirmed"); assert.match(w.message, /100pt\(10円分\)を使用しました/);
  assert.equal(Number(pg.exec(`select count(*) from point_ledger where entry_type='redeem';`)), 1);
  ok("ポイント使用: お客様が申請(円換算つき6桁コード)→スタッフがコード入力→内容確認→確定→お客様の画面に『使用しました』。通信断後の再確認でも引落は1回");
  // 取消・期限切れ・権限・ロック
  const req2 = redeemScreen(await member.redeemRequest(100), NOW); const id2 = (await staff.lookupRedeem(req2.view.pending.code)).data.request.id;
  assert.equal(redeemWatch(req2.view, cardScreen(await (async () => { await member.redeemCancel(); return member.me(); })(), NOW).view).change, "cancelled");
  st = redeemReduce({ step: "confirming" }, { type: "confirm_result", result: await staff.confirmRedeem(id2) }); assert.equal(st.step, "cancelled");
  const req3 = redeemScreen(await member.redeemRequest(100), NOW); pg.exec(`update redeem_requests set expires_at = now() - interval '1 second' where status='pending';`);
  assert.equal(redeemReduce(redeemInitial, { type: "lookup_result", result: await staff.lookupRedeem(req3.view.pending.code) }).step, "not_found");
  assert.equal(redeemReduce(redeemInitial, { type: "lookup_result", result: await viewer.lookupRedeem("123456") }).step, "forbidden");
  for (let i = 0; i < 10; i++) await staff.lookupRedeem(String(i).repeat(6));
  assert.equal(redeemReduce(redeemInitial, { type: "lookup_result", result: await staff.lookupRedeem("123456") }).step, "locked");
  assert.equal(redeemReduce(redeemInitial, { type: "lookup_result", result: { kind: "error" } }).step, "error");
  ok("使用の例外系: お客様の取消→スタッフ側は『取消済み』・期限切れコードは見つからない・閲覧のみは拒否・当て推量はロック・通信エラーは再試行表示");
  // 店長の操作
  assert.equal((await staff.adjust({ memberId: "00000000-0000-0000-0000-000000000000", points: 10, reason: "x", key: "adj-12345678" })).kind, "forbidden");
  const list = await staff.listMembers({ query: "試験" }); assert.equal(list.kind, "ok"); assert.equal(list.data.items.length, 1);
  const mid = list.data.items[0].id; const key = mgr.newAdjustKey(); assert.match(key, /^adj-/);
  assert.equal((await mgr.adjust({ memberId: mid, points: 50, reason: "訂正", key })).data.status, "ok");
  assert.equal((await mgr.adjust({ memberId: mid, points: 50, reason: "訂正", key })).data.status, "duplicate");
  assert.equal((await mgr.adjust({ memberId: mid, points: 50, reason: "", key: "adj-otherkey1" })).kind, "invalid");
  assert.ok((await viewer.memberDetail(mid)).data.ledger.some((x) => x.type === "adjust" && x.reason === "訂正"));
  assert.equal((await viewer.dashboard()).kind, "ok"); assert.equal((await viewer.todayVisits()).kind, "ok"); assert.equal((await staff.whoami()).data.role, "staff");
  ok("スタッフ画面の操作: 一覧・検索・詳細・ダッシュボード・本日の来店。店長だけが手動調整でき、同じ操作の再送は二重にならない。権限のない操作は forbidden");
  assert.equal(Number(pg.exec(`select count(*) from public.verify_balances();`)), 0);

  // ---- 通信の不安定さ ----
  netFail = 2; assert.equal((await member.me()).kind, "ok");                                    // 2回失敗しても再試行で成功
  netFail = 5; assert.equal(cardScreen(await member.me()).screen, "error"); netFail = 0;      // 3回とも失敗 → 再試行ボタンのある画面
  assert.equal(cardScreen(await member.me()).screen, "card");
  const flaky = createMemberClient({ endpoint: "x", getIdToken: async () => jwt(SUB, "x"), fetchFn: async () => new Response("{}", { status: 503 }), sleep: async () => {} });
  assert.equal((await flaky.me()).kind, "server_error");
  const rl = createMemberClient({ endpoint: "x", getIdToken: async () => jwt(SUB, "x"), fetchFn: async () => new Response("{}", { status: 429 }), sleep: async () => {} });
  assert.equal(cardScreen(await rl.me()).screen, "error");
  ok("通信: 一時的な失敗は自動で再試行(最大2回)・失敗が続けば『再試行』つきのエラー画面・429は即エラー");
  for (const [m, kind] of [["too_many_attempts", "locked"], ["not_staff", "not_staff"], ["forbidden", "forbidden"], ["permission denied for function", "forbidden"], ["JWT expired", "auth_required"], ["boom", "error"]]) assert.equal(mapError({ message: m }).kind, kind, m);
  ok("スタッフ側のエラー分類(ロック・非スタッフ・権限なし・期限切れ・その他)");

  // ---- 店頭QRの自動更新 ----
  const timers = []; let clock = 1_000_000; const updates = [], hidden = [];
  let mode = "ok"; const kiosk = createQrKiosk({ getToken: async () => mode === "ok" ? { kind: "ok", data: { token: "t" + clock, nextChangeAt: clock + 30_000, url: "u" } } : { kind: "error" },
    onUpdate: (d) => updates.push(d.token), onHidden: (k) => hidden.push(k), now: () => clock, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  kiosk.start(); await Promise.resolve(); await Promise.resolve();
  assert.equal(updates.length, 1); assert.equal(timers.at(-1).ms, 28_000);                       // 切替の2秒前に取り直す
  mode = "fail"; clock += 28_000; await timers.at(-1).fn(); assert.equal(hidden.length, 0); assert.equal(timers.at(-1).ms, 5000);
  clock += 100_000; await timers.at(-1).fn(); assert.deepEqual(hidden, ["error"]);                // 取得できないまま期限を過ぎたら QR を隠す
  mode = "ok"; await timers.at(-1).fn(); assert.equal(updates.length, 2);
  kiosk.stop();
  ok("店頭QRの自動更新: 切替の2秒前に取得・取得失敗が続いて約90秒を過ぎたらQRを隠す・復帰したら再表示");
  // ---- メンテナンス中・営業時間外 ----
  pg.exec(`update system_state set state='frozen';`);
  const mres = await member.me(); assert.equal(mres.kind, "maintenance");
  assert.equal(cardScreen(mres).screen, "maintenance"); assert.equal(cardScreen(mres).retry, false); assert.match(cardScreen(mres).message, /メンテナンス/);
  assert.equal(checkinScreen(await member.checkin(k.data.token)).screen, "maintenance"); assert.equal(redeemScreen(await member.redeemRequest(100)).screen, "maintenance");
  pg.exec(`update system_state set state='open';`);
  pg.exec(`update app_settings set value='9' where key='checkin_open_hour'; update app_settings set value='10' where key='checkin_close_hour';`);
  const oh = checkinScreen(await member.checkin((await staff.qrToken()).data.url.split("t=")[1])); assert.equal(oh.screen, "checkin_outside_hours");
  pg.exec(`update app_settings set value='0' where key='checkin_open_hour'; update app_settings set value='24' where key='checkin_close_hour';`);
  ok("切替作業中は『メンテナンス中』画面(再試行なし)、営業時間外のQRは専用の案内画面(ポイントは付与されない)");
  console.log(`\n${n} app-core tests passed`);
} finally { pg.stop(); }
