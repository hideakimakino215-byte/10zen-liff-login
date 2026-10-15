// 友だち紹介(db/106_referral.sql)の「アプリの核」の通し検証: お客様クライアント → member-api(register の inviteCode・checkin・invite_seen)→ 実 PostgreSQL ← スタッフクライアント。
// 画面に依存しない部分(招待のリンクからのコードの取り出し・inviteView・registerNotice・checkinScreen の初来店の文言・staff の集計と切り替え)を確かめる。本番には接続しない。
// 実行: node --experimental-strip-types test_referral.mjs
import assert from "node:assert/strict";
import { startPg, q } from "../patches/pgdb.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { handle as memberApi } from "../functions/member-api/handler.ts";
import { makeToken } from "../functions/member-api/qr.ts";
import { createMemberClient, inviteCodeFromLocation, isInviteCode, inviteUrl } from "./member-client.mjs";
import { createStaffClient } from "./staff-client.mjs";
import { makeJwt, lineVerify } from "../patches/jwtstub.mjs";
import { cardScreen, checkinScreen, inviteView, lineShareUrl, registerNotice, memberView } from "./screens.mjs";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const CH = "2011158053", SECRET = "r".repeat(64), UNIT = "10zen_aoyama";
const NOW = () => Date.now();
const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3", kiosk: "00000000-0000-0000-0000-0000000000f6" };
const deps = () => ({ fetchFn: lineVerify(NOW), supabase: rpcOver(pg), lineLoginChannelId: CH, qrSecret: SECRET, businessUnit: UNIT, allowedOrigins: [], nowMs: NOW });
const toApi = async (_url, init) => memberApi(new Request("https://x.test/member-api", { method: "POST", headers: init.headers, body: init.body }), deps());
const mkMember = (sub, name) => createMemberClient({ endpoint: "https://x.test/member-api", getIdToken: async () => makeJwt({ sub, name, nowMs: NOW() }), fetchFn: toApi, sleep: async () => {} });
const raw = async (sub, body) => { const r = await toApi("", { headers: { "content-type": "application/json", "x-liff-id-token": makeJwt({ sub, name: "x", nowMs: NOW() }) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const staffSb = (uid) => ({
  async rpc(name, args) {
    const named = Object.entries(args).map(([k, v]) => `${k} => ${v === null || v === undefined ? "null" : q(v)}`).join(", ");
    const r = await pg.runAsync(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\nselect public.${name}(${named});`);
    return r.status === 0 ? { data: JSON.parse(r.stdout), error: null } : { data: null, error: { message: r.stderr } };
  },
  auth: { getSession: async () => ({ data: { session: null } }), signInWithPassword: async () => ({ data: {}, error: null }), signOut: async () => ({}) },
});
const mkStaff = (uid) => createStaffClient({ supabase: staffSb(uid), qrEndpoint: "https://x.test/staff-qr", fetchFn: async () => new Response("{}", { status: 500 }) });
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
const midOf = (s) => pg.exec(`select member_id from member_identities where subject=${q(s)} limit 1;`);

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql", "106_referral.sql"]) pg.loadFile(f);
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit'; update point_rules set active=false where code='campaign_welcome';`);
  pg.exec(`insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role) values ('${STAFF.mgr}','店長','manager'),('${STAFF.staff}','スタッフ','staff'),('${STAFF.viewer}','閲覧','viewer'),('${STAFF.kiosk}','店頭','kiosk');`);

  // ---- 1. 招待のリンク: コードの取り出し(LIFF の liff.state の形も)・リンクと LINE の「送る」画面の URL ----
  const C = "Ab3_-xYz09Qq", enc = encodeURIComponent;
  assert.equal(inviteCodeFromLocation(`?ref=${C}`), C); assert.equal(inviteCodeFromLocation(`?foo=1&ref=${C}`), C);
  assert.equal(inviteCodeFromLocation("?liff.state=" + enc(`?ref=${C}`)), C); assert.equal(inviteCodeFromLocation("?liff.state=" + enc(`/?ref=${C}`)), C);
  assert.equal(inviteCodeFromLocation("?liff.state=" + enc(`?ref=${C}`) + `&ref=${C}`), C);
  for (const bad of ["", "?ref=", "?ref=short", `?ref=${C}x`, "?ref=user00001", "?ref=" + enc("Ab3_-xYz09Q'"), "?liff.state=%E0%A4%A", "?liff.state=" + enc("?action=visit&t=1.AAAAAAAAAAAAAAAAAAAAAA")])
    assert.equal(inviteCodeFromLocation(bad), null, bad);
  assert.equal(isInviteCode(C), true); assert.equal(isInviteCode(null), false); assert.equal(isInviteCode("x".repeat(13)), false);
  assert.equal(inviteUrl("2011158053-N7nKgExB", C), `https://liff.line.me/2011158053-N7nKgExB?ref=${C}`);
  const share = lineShareUrl("招待\nhttps://liff.line.me/x?ref=" + C); assert.match(share, /^https:\/\/line\.me\/R\/share\?text=/);
  assert.equal(decodeURIComponent(share.split("text=")[1]), "招待\nhttps://liff.line.me/x?ref=" + C);
  // 106 が未適用の応答(invite がない)なら、招待の欄は出さない
  assert.equal(memberView({ memberNo: "u", displayName: "x", rank: "white_opal", points: 0, yenPer100pt: 10, lifetimePoints: 0, lifetimeConfirmed: true, nextRank: null, expiresOn: null, redeemUnit: 100 }, NOW()).invite, null);
  ok("招待のリンク: ?ref= と LIFF の ?liff.state= のどちらの形からも12文字のコードを取り出し、形の違うもの(会員番号・短い/長い・記号)は無視する。リンクは LIFF の URL に ?ref=、LINE の「送る」画面の URL は文面を符号化。106 より前の応答では招待の欄を出さない");

  // ---- 2. 紹介者の会員証 → 友だちがリンクから登録(何も入力しない)→ 紹介として記録 ----
  const A = sub("a"), F = sub("f"), referrer = mkMember(A, "紹介 太郎"), friend = mkMember(F, "友だち 花子");
  let s = cardScreen(await referrer.register(), NOW()); assert.equal(s.screen, "card");
  let iv = s.view.invite; assert.ok(isInviteCode(iv.code)); assert.equal(iv.countText, "今月の招待 0/5人"); assert.equal(iv.full, false);
  assert.equal(iv.rewardText, "お友だちが初めてご来店されると、お二人に「ディナーの五巡茶 1杯」のチケットをお届けします"); assert.equal(iv.referredText, null); assert.equal(iv.notice, null);
  assert.match(iv.shareText(inviteUrl("x", iv.code)), /ディナーの五巡茶 1杯[\s\S]*https:\/\/liff\.line\.me\/x\?ref=/);
  assert.doesNotMatch(iv.shareText(inviteUrl("x", iv.code)), /user\d{5}/);                                                     // 会員番号はリンクにも文面にも出ない
  const code = iv.code;
  assert.equal(cardScreen(await friend.me(), NOW()).screen, "register");
  const fr = await friend.register({ inviteCode: inviteCodeFromLocation("?liff.state=" + enc(`?ref=${code}`)), displayName: "x" });
  assert.equal(fr.kind, "ok"); assert.equal(fr.data.invite, "linked"); assert.equal(registerNotice(fr), "招待を受け付けました。初めてのご来店で特典チケットをお届けします");
  s = cardScreen(fr, NOW()); assert.equal(s.view.pointsText, "100 pt"); assert.equal(s.view.invite.referredText, "お友だちの招待で登録されました。初めてのご来店で「ディナーの五巡茶 1杯」のチケットをお届けします");
  assert.equal(cardScreen(await referrer.me(), NOW()).view.invite.countText, "今月の招待 1/5人"); assert.equal(cardScreen(await referrer.me(), NOW()).view.pointsText, "100 pt");
  // 形の違うコードはクライアントが送らない・サーバーも無視する。すでに会員なら紹介にならない
  const G = sub("c"), g = mkMember(G, "通常"); const gr = await g.register({ inviteCode: "user00001" }); assert.equal(gr.data.invite, null); assert.equal(registerNotice(gr), null);
  assert.equal((await raw(sub("d"), { action: "register", inviteCode: "AAAAAAAAAAAA" })).body.invite, "invalid");
  assert.equal((await referrer.register({ inviteCode: code })).data.status, "existing");
  assert.equal(pg.exec(`select count(*) from member_referrals;`), "1");
  ok("紹介: 紹介者の会員証に招待コード・『今月の招待 0/5人』・特典の説明(文面に会員番号なし)。友だちは招待のリンク(liff.state の形でも)から登録するだけで紹介として記録され(通常の 100pt)、『初めてのご来店で…』と出る。紹介者は『1/5人』。形の違うコード・すでに会員の人は紹介にならない");

  // ---- 3. 初来店(店頭QR)→ 友だちに特典 → 紹介者の会員証に1回だけお知らせ ----
  const tok = (await makeToken(SECRET, UNIT, NOW())).token;
  const c1 = checkinScreen(await friend.checkin(tok), NOW()); assert.equal(c1.screen, "checkin_success");
  assert.equal(c1.message, "ご来店ありがとうございます。100pt を付与しました。お友だち紹介の特典チケット「お友だち紹介・ディナーの五巡茶 1杯」をお届けしました");
  assert.ok(c1.view.tickets.some((t) => t.title === "お友だち紹介・ディナーの五巡茶 1杯"));
  const c2 = checkinScreen(await friend.checkin(tok), NOW()); assert.equal(c2.screen, "checkin_already"); assert.equal(c2.message, "本日の来店ポイントは付与済みです");
  let rv = cardScreen(await referrer.me(), NOW()).view;
  assert.deepEqual(rv.invite.notice.text, "お友だちが来店しました。チケットが届いています"); assert.ok(rv.tickets.some((t) => t.title === "お友だち紹介・ディナーの五巡茶 1杯"));
  assert.equal(cardScreen(await referrer.me(), NOW()).view.invite.notice.text, "お友だちが来店しました。チケットが届いています");     // 既読にするまでは出る(体質チェックの画面などが先に開いても消えない)
  assert.equal((await referrer.inviteSeen(rv.invite.notice.until)).data.marked, 1);
  assert.equal(cardScreen(await referrer.me(), NOW()).view.invite.notice, null);
  assert.equal((await raw(A, { action: "invite_seen", until: "not a date" })).status, 400); assert.equal((await raw(A, { action: "invite_seen" })).status, 400);
  assert.equal((await raw(sub("9"), { action: "invite_seen", until: new Date().toISOString() })).status, 404);
  ok("初来店: 友だちが店頭QRを読むと +100pt と『お友だち紹介の特典チケット…をお届けしました』、会員証にチケット。2回目は付与済みだけ。紹介者の会員証に『お友だちが来店しました。チケットが届いています』が既読にするまで出て、既読(invite_seen)の後は出ない。invite_seen の不正な値は 400・未登録は 404");

  // ---- 4. AMBER 以上の紹介者は 100pt(お知らせも『100ptを付けました』) ----
  const B = sub("b"), F2 = sub("e"), amber = mkMember(B, "琥珀 次郎"), friend2 = mkMember(F2, "友だち 三郎");
  await amber.register();
  pg.exec(`select public._grant(m.id, 'earn', 'visit', 1000 - public._effective_lifetime(m), 'ref-app-test', 'test', null, now()) from members m where m.id = ${q(midOf(B))};`);
  let av = cardScreen(await amber.me(), NOW()).view; assert.equal(av.rank, "amber");
  assert.equal(av.invite.rewardText, "お友だちが初めてご来店されると、お友だちに「ディナーの五巡茶 1杯」のチケット、あなたに 100pt をお届けします");
  await friend2.register({ inviteCode: av.invite.code });
  await friend2.checkin(tok);
  av = cardScreen(await amber.me(), NOW()).view;
  assert.equal(av.invite.notice.text, "お友だちが来店しました。100ptを付けました"); assert.equal(av.points, 1100); assert.equal(av.tickets.filter((t) => t.kind === "referral").length, 0);
  assert.equal(inviteView({ invite: { code: "x".repeat(12), monthCount: 5, monthlyCap: 5, teaLabel: "ディナーの五巡茶 飲み放題" }, inviteNotice: { friends: 2, tickets: 1, points: 100, until: "t" } }).notice.text,
    "お友だちが来店しました。チケットが届いています。100ptを付けました");
  const fullV = inviteView({ invite: { code: "x".repeat(12), monthCount: 5, monthlyCap: 5, teaLabel: "ディナーの五巡茶 飲み放題" } });
  assert.equal(fullV.full, true); assert.equal(fullV.countText, "今月の招待 5/5人"); assert.equal(fullV.fullText, "今月の招待は上限(5人)に達しました。来月また招待できます");
  ok("AMBER 以上の紹介者: 説明は『あなたに 100pt』、友だちの初来店で +100pt(チケットなし)と『お友だちが来店しました。100ptを付けました』。上限に達したら『5/5人』と上限の案内");

  // ---- 5. スタッフ: 集計(閲覧以上)・五巡茶の出し方(店長だけ)・KPI の補助の数字 ----
  const mgr = mkStaff(STAFF.mgr), staff = mkStaff(STAFF.staff), viewer = mkStaff(STAFF.viewer), kiosk = mkStaff(STAFF.kiosk);
  const st = await viewer.referralStats(); assert.equal(st.kind, "ok");
  assert.equal(st.data.referralRegistrations, 2); assert.equal(st.data.referralFirstVisits, 2); assert.equal(st.data.waitingFirstVisit, 0); assert.equal(st.data.canEdit, false);
  assert.equal((await staff.referralStats()).kind, "ok"); assert.equal((await kiosk.referralStats()).kind, "forbidden"); assert.equal((await mgr.referralStats()).data.canEdit, true);
  assert.equal((await staff.setDinnerTeaMode("free_flow")).kind, "forbidden"); assert.equal((await viewer.setDinnerTeaMode("free_flow")).kind, "forbidden");
  const bad = await mgr.setDinnerTeaMode("bottle"); assert.equal(bad.kind, "invalid"); assert.equal(bad.code, "invalid_mode");
  const sw = await mgr.setDinnerTeaMode("free_flow"); assert.equal(sw.kind, "ok"); assert.equal(sw.data.label, "ディナーの五巡茶 飲み放題");
  rv = cardScreen(await referrer.me(), NOW()).view;
  assert.equal(rv.invite.teaLabel, "ディナーの五巡茶 飲み放題"); assert.ok(rv.tickets.some((t) => t.title === "お友だち紹介・ディナーの五巡茶 飲み放題"));
  await mgr.setDinnerTeaMode("cup");
  const ko = await viewer.kpiOverview(2); assert.equal(ko.kind, "ok"); const cur = ko.data.months.at(-1);
  assert.equal(cur.supporting.referralFirstVisits, 2); assert.equal(cur.supporting.referralRegistrations, 2);
  ok("スタッフ: 紹介の集計(今月の紹介からの登録・新規来店・初来店待ち)は閲覧・スタッフ・店長が見られ、店頭タブレットは拒否。五巡茶の出し方は店長だけが切り替えられ(不正な値は invalid)、会員証の文言とまだ使っていないチケットの名前が変わる。KPI の今月の補助の数字に紹介からの新規来店と登録");
  console.log(`\n${n} referral app tests passed`);
} finally { pg.stop(); }
