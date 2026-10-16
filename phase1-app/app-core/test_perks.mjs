// ランク特典(db/102_rank_perks.sql)の「アプリの核」の通し検証: お客様クライアント → member-api(ticket_request / ticket_cancel)→ 実 PostgreSQL ← スタッフクライアント(lookupCode)。
// 画面に依存しない部分(memberView の特典・チケット、ticketScreen / ticketWatch、redeemReduce のチケットの分岐)を確かめる。本番には接続しない。
// 実行: node --experimental-strip-types test_perks.mjs
import assert from "node:assert/strict";
import { startPg, q } from "../patches/pgdb.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { handle as memberApi } from "../functions/member-api/handler.ts";
import { createMemberClient } from "./member-client.mjs";
import { createStaffClient, redeemReduce, redeemInitial } from "./staff-client.mjs";
import { makeJwt, lineVerify } from "../patches/jwtstub.mjs";
import { cardScreen, redeemScreen, redeemWatch, ticketScreen, ticketWatch, memberView, rankPerks } from "./screens.mjs";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const CH = "2011158053", SECRET = "k".repeat(64), UNIT = "10zen_aoyama";
const NOW = () => Date.now();                                 // スタッフの確定は DB の実時刻なので、お客様側も実時刻
const SUB = "U" + "e".repeat(32);
const STAFF = { staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3", kiosk: "00000000-0000-0000-0000-0000000000f6" };
const lineFetch = lineVerify(NOW);
const deps = () => ({ fetchFn: lineFetch, supabase: rpcOver(pg), lineLoginChannelId: CH, qrSecret: SECRET, businessUnit: UNIT, allowedOrigins: [], nowMs: NOW });
const toApi = async (_url, init) => memberApi(new Request("https://x.test/member-api", { method: "POST", headers: init.headers, body: init.body }), deps());
const mkMember = (sub, name) => createMemberClient({ endpoint: "https://x.test/member-api", getIdToken: async () => makeJwt({ sub, name, nowMs: NOW() }), fetchFn: toApi, sleep: async () => {} });
const staffSb = (uid) => ({
  async rpc(name, args) {
    const named = Object.entries(args).map(([k, v]) => `${k} => ${v === null || v === undefined ? "null" : q(v)}`).join(", ");
    const r = await pg.runAsync(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\nselect public.${name}(${named});`);
    return r.status === 0 ? { data: JSON.parse(r.stdout), error: null } : { data: null, error: { message: r.stderr } };
  },
  auth: { getSession: async () => ({ data: { session: null } }), signInWithPassword: async () => ({ data: {}, error: null }), signOut: async () => ({}) },
});
const mkStaff = (uid) => createStaffClient({ supabase: staffSb(uid), qrEndpoint: "https://x.test/staff-qr", fetchFn: async () => new Response("{}", { status: 500 }) });
const raw = async (sub, body) => { const r = await toApi("", { headers: { "content-type": "application/json", "x-liff-id-token": makeJwt({ sub, name: "x", nowMs: NOW() }) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const setLife = (sub, target) => pg.exec(`select public._grant(m.id, 'earn', 'visit', ${target} - public._effective_lifetime(m), 'perk-test:' || gen_random_uuid(), 'test', null, now())
  from members m join member_identities i on i.member_id = m.id where i.subject = ${q(sub)};`);

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.loadFile("100_phase1_schema.sql"); pg.loadFile("101_search_path_fix.sql"); pg.loadFile("102_rank_perks.sql");
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit';`);
  pg.exec(`insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role) values ('${STAFF.staff}','スタッフ','staff'),('${STAFF.viewer}','閲覧','viewer'),('${STAFF.kiosk}','店頭','kiosk');`);
  const member = mkMember(SUB, "特典 太郎"), staff = mkStaff(STAFF.staff), viewer = mkStaff(STAFF.viewer), kiosk = mkStaff(STAFF.kiosk);

  // ---- 1. ランクごとの『来るたびに使える特典』(文字だけ) ----
  assert.deepEqual(rankPerks("white_opal"), []);
  assert.deepEqual(rankPerks("amber").map((p) => p.text), ["ディナーの五巡茶 無料"]);
  assert.deepEqual(rankPerks("emerald").map((p) => p.text), ["ディナーの五巡茶 無料", "季節の豆花チケット(季節ごとに1枚)", "薬日本堂のご優待(準備中)"]);
  assert.deepEqual(rankPerks("ruby").map((p) => p.text), ["ディナーの五巡茶 無料", "季節の豆花チケット(季節ごとに1枚)", "あなたの体質の五巡茶(持ち帰り用)チケット(季節ごとに1枚)", "薬日本堂のご優待(準備中)"]);
  assert.deepEqual(rankPerks("onyx").map((p) => p.text), ["ディナーの五巡茶 無料", "季節の豆花チケット(季節ごとに1枚)", "あなたの体質の五巡茶(持ち帰り用)チケット(季節ごとに1枚)", "新メニュー試食会へご招待", "薬日本堂のご優待(準備中)"]);
  assert.equal(rankPerks("onyx").find((p) => p.text.includes("薬日本堂")).small, true); assert.deepEqual(rankPerks("unknown"), []);
  for (const r of ["white_opal", "amber", "emerald", "ruby", "onyx"]) assert.ok(!rankPerks(r).some((p) => /5%|OFF/.test(p.text)));
  // 102 が未適用の応答(tickets などがない)でも表示用データは成立する
  const v0 = memberView({ memberNo: "u", displayName: "x", rank: "amber", points: 0, yenPer100pt: 10, lifetimePoints: 1000, lifetimeConfirmed: true, nextRank: null, expiresOn: null, redeemUnit: 100 }, NOW());
  assert.deepEqual(v0.tickets, []); assert.equal(v0.pendingTicket, null); assert.equal(v0.lastTicket, null); assert.equal(v0.perks.length, 1);
  ok("ランクの特典(文字だけ): AMBER=ディナーの五巡茶 無料、RUBY=あなたの体質の五巡茶(季節ごと。2026-10-16 優先案内から変更)、ONYX=試食会。上のランクは下の分も続けて出る。EMERALD 以上に『薬日本堂のご優待(準備中)』を小さく添える。5%OFF はどこにもない。チケットの項目がない応答でも画面は成立");

  // ---- 2. お客様: AMBER 到達 → 会員証にチケット → 「使う」で6桁コード ----
  let s = cardScreen(await member.register(), NOW()); assert.equal(s.screen, "card"); assert.deepEqual(s.view.tickets, []); assert.equal(s.view.next.target, 1000);
  setLife(SUB, 1000);
  s = cardScreen(await member.me(), NOW()); assert.equal(s.view.rank, "amber"); assert.equal(s.view.tickets.length, 1);
  const t = s.view.tickets[0]; assert.equal(t.title, "AMBER 到達のお祝い・豆花 1つ"); assert.match(t.validThroughText, /^\d{4}年\d{2}月\d{2}日まで$/); assert.equal(s.view.next.target, 3000);
  const before = s.view;
  assert.equal((await raw(SUB, { action: "ticket_request", ticketId: "not-a-uuid" })).status, 400);
  assert.equal((await raw(SUB, { action: "ticket_request" })).status, 400);
  assert.equal(ticketScreen(await member.ticketRequest("x"), NOW()).error, "このチケットは使えません");
  { const other = await raw(SUB, { action: "ticket_request", ticketId: "00000000-0000-4000-8000-000000000000" }); assert.equal(other.status, 409); assert.equal(other.body.status, "ticket_not_found"); }
  const tr = ticketScreen(await member.ticketRequest(t.id.toUpperCase()), NOW());             // 大文字の UUID でも同じチケット
  assert.equal(tr.screen, "ticket_pending"); assert.match(tr.view.pendingTicket.codeText, /^\d{3} \d{3}$/); assert.equal(tr.view.pendingTicket.title, t.title);
  assert.ok(tr.view.pendingTicket.secondsLeft > 170 && tr.view.pendingTicket.secondsLeft <= 180); assert.equal(tr.view.pending, null);   // ポイント使用の申請とは別
  assert.equal(ticketWatch(before, tr.view).change, "none"); assert.equal(ticketWatch(tr.view, tr.view).change, "none");
  ok("お客様: AMBER に上がると会員証にお祝いのチケット(期限つき)→『使う』で6桁コード(約3分)。不正なチケットID は 400、本人のものでないチケットは『使えません』");

  // ---- 3. スタッフ: 同じ入力欄(lookupCode)でチケットと判定 → 確定 → お客様に完了 ----
  let st = redeemReduce(redeemInitial, { type: "lookup_start" });
  st = redeemReduce(st, { type: "lookup_result", result: await staff.lookupCode(tr.view.pendingTicket.codeText) });   // 空白入りでも通る
  assert.equal(st.step, "confirm"); assert.equal(st.kind, "ticket"); assert.equal(st.ticket.title, t.title); assert.equal(st.member.displayName, "特典 太郎"); assert.match(st.ticket.validThrough, /^\d{4}-\d{2}-\d{2}$/);
  const reqId = st.request.id;
  st = redeemReduce(st, { type: "confirm_start" }); assert.equal(st.step, "confirming"); assert.equal(st.kind, "ticket");
  const lost = redeemReduce(st, { type: "confirm_result", result: { kind: "error" } }); assert.equal(lost.step, "error"); assert.equal(lost.kind, "ticket"); assert.equal(lost.request.id, reqId);   // 結果不明でもチケットのまま再確認できる
  st = redeemReduce(st, { type: "confirm_result", result: await staff.confirmTicket(reqId) }); assert.deepEqual(st, { step: "done", kind: "ticket", title: t.title });
  assert.deepEqual(redeemReduce({ ...lost, step: "confirming" }, { type: "confirm_result", result: await staff.confirmTicket(reqId) }), { step: "done", kind: "ticket", title: t.title });   // 再確認しても二重にならない
  const after = cardScreen(await member.me(), NOW()).view; assert.deepEqual(after.tickets, []); assert.equal(after.pendingTicket, null); assert.equal(after.points, 1000);   // チケットはポイントを使わない
  const w = ticketWatch(tr.view, after); assert.equal(w.change, "confirmed"); assert.equal(w.message, "AMBER 到達のお祝い・豆花 1つ をご利用いただきました");
  assert.equal(redeemWatch(tr.view, after).change, "none");                                       // ポイントの見張りは反応しない
  assert.equal(redeemReduce(redeemInitial, { type: "lookup_result", result: await staff.lookupCode(tr.view.pendingTicket.code) }).step, "not_found");
  { const again = await raw(SUB, { action: "ticket_request", ticketId: t.id }); assert.equal(again.status, 409); assert.equal(again.body.status, "ticket_used"); }
  assert.equal(ticketScreen(await member.ticketRequest(t.id), NOW()).error, "このチケットは使用済みです");
  assert.equal(Number(pg.exec(`select count(*) from perk_tickets where used_at is not null;`)), 1);
  ok("スタッフ: ポイントと同じ入力欄でチケットと判定→特典名と期限を確認→確定(通信が切れて再確認しても1回)→お客様の画面に『ご利用いただきました』。使い終えたコードは見つからず、同じチケットは『使用済み』");

  // ---- 4. 取り消し・期限切れ・ほかのチケットの表示中・権限 ----
  setLife(SUB, 3000);
  let v = cardScreen(await member.me(), NOW()).view; assert.equal(v.rank, "emerald");
  assert.deepEqual(v.tickets.map((x) => x.kind).sort(), ["milestone", "seasonal"]);                 // EMERALD のお祝い(お茶)と、今の季節の豆花
  const [ta, tb] = v.tickets;
  const p1 = ticketScreen(await member.ticketRequest(ta.id), NOW()); assert.equal(p1.screen, "ticket_pending");
  const busy = ticketScreen(await member.ticketRequest(tb.id), NOW()); assert.equal(busy.screen, "card"); assert.match(busy.error, /ほかのチケット/); assert.equal(busy.view.pendingTicket.ticketId, ta.id);
  const c1 = p1.view.pendingTicket.code;
  assert.equal((await member.ticketCancel()).data.status, "cancelled");
  v = cardScreen(await member.me(), NOW()).view; assert.equal(ticketWatch(p1.view, v).change, "cancelled"); assert.equal(ticketWatch(p1.view, v).message, "チケットの使用を取り消しました");
  assert.equal(v.tickets.length, 2);                                                              // 取り消してもチケットは残る
  assert.equal(redeemReduce(redeemInitial, { type: "lookup_result", result: await staff.lookupCode(c1) }).step, "not_found");
  const p2 = ticketScreen(await member.ticketRequest(tb.id), NOW());
  pg.exec(`update perk_ticket_requests set expires_at = now() - interval '1 second' where status = 'pending';`);
  v = cardScreen(await member.me(), NOW()).view; assert.equal(ticketWatch(p2.view, v).change, "expired"); assert.match(ticketWatch(p2.view, v).message, /有効時間が過ぎました/);
  const p3 = ticketScreen(await member.ticketRequest(tb.id), NOW()); const c3 = p3.view.pendingTicket.code;
  assert.equal(redeemReduce(redeemInitial, { type: "lookup_result", result: await viewer.lookupCode(c3) }).step, "forbidden");
  assert.equal(redeemReduce(redeemInitial, { type: "lookup_result", result: await kiosk.lookupCode(c3) }).step, "forbidden");
  const id3 = (await staff.lookupCode(c3)).data.request.id;
  assert.equal((await viewer.confirmTicket(id3)).kind, "forbidden"); assert.equal((await kiosk.confirmTicket(id3)).kind, "forbidden"); assert.equal((await kiosk.ticketStats()).kind, "forbidden");
  pg.exec(`update perk_tickets set expires_at = now() - interval '1 second' where id = ${q(tb.id)};`);   // コードの表示中にチケットの期限が過ぎた
  assert.equal(redeemReduce({ step: "confirming", kind: "ticket", request: { id: id3 } }, { type: "confirm_result", result: await staff.confirmTicket(id3) }).step, "ticket_expired");
  assert.equal(ticketScreen(await member.ticketRequest(tb.id), NOW()).error, "このチケットは有効期限が切れています");
  const ss = await viewer.ticketStats(); assert.equal(ss.kind, "ok"); assert.equal(ss.data.issued, 3); assert.equal(ss.data.used, 1); assert.equal(ss.data.usageRatePercent, 33.3);
  ok("例外: お客様の取り消し(チケットは残る・古いコードは無効)・コードの期限切れ・ほかのチケットのコードを表示中・チケットの期限切れをそれぞれの文言で表示。閲覧のみ・店頭タブレットはコード確認も確定もできない。集計は発行・使用・使用率");

  // ---- 5. ポイント使用のコードも同じ入力欄で(これまでどおり) ----
  const rq = redeemScreen(await member.redeemRequest(100), NOW()); assert.equal(rq.screen, "redeem_pending");
  let ps = redeemReduce(redeemInitial, { type: "lookup_result", result: await staff.lookupCode(rq.view.pending.codeText) });
  assert.equal(ps.step, "confirm"); assert.equal(ps.kind, undefined); assert.equal(ps.request.points, 100); assert.equal(ps.request.yen, 10);
  ps = redeemReduce({ ...ps, step: "confirming" }, { type: "confirm_result", result: await staff.confirmRedeem(ps.request.id) });
  assert.deepEqual([ps.step, ps.points, ps.yen, ps.balanceAfter], ["done", 100, 10, 2900]);
  const fin = cardScreen(await member.me(), NOW()).view; assert.equal(redeemWatch(rq.view, fin).change, "confirmed"); assert.equal(fin.points, 2900);
  assert.equal(ticketWatch(rq.view, fin).change, "none");
  assert.equal(Number(pg.exec(`select count(*) from public.verify_balances();`)), 0);
  ok("ポイント使用のコードは同じ入力欄(lookupCode)で従来どおり『ポイント』として確認・確定でき、残高が減る。チケットの見張りは反応しない。残高=台帳");
  console.log(`\n${n} perk client tests passed`);
} finally { pg.stop(); }
