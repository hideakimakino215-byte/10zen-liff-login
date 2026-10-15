// ランク特典(db/102_rank_perks.sql)を、実 PostgreSQL 16 で検証する(並列は別プロセス=別接続)。本番には接続しない。
// 対象: 新しいランクの基準・到達のお祝い(飛び越しのルール)・季節の豆花(日本時間・季節の境目)・コードの申請と確定・二重使用の防止・期限・権限・
//       ポイント使用のコードとの共存(同じ入力欄)・集計・バックアップ/復元・戻し(DOWN)。
// 実行: node --experimental-strip-types test_rank_perks.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053";
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3",
                gone: "00000000-0000-0000-0000-0000000000d4", plain: "00000000-0000-0000-0000-0000000000e5", kiosk: "00000000-0000-0000-0000-0000000000f6",
                staff2: "00000000-0000-0000-0000-0000000000b7" };
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
const val = (sql) => pg.exec(sql);
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const AS = (uid, sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const ASA = (uid, sql) => pg.runAsync(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const ANON = (sql) => pg.exec(`set role anon;\n${sql}`);
const fails = (fn, re) => { try { fn(); } catch (e) { assert.match(String(e.message), re, e.message); return; } assert.fail("expected failure " + re); };
const ts = (now) => (now === "now" ? "now()" : `${q(now)}::timestamptz`);
const reg = (s, name = "会員", now = "now") => j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, ${ts(now)});`));
const me = (s, now = "now") => j(SVC(`select public.app_me(${q(ISS)}, ${q(s)}, ${ts(now)});`));
const treq = (s, tid, now = "now") => j(SVC(`select public.app_ticket_request(${q(ISS)}, ${q(s)}, ${q(tid)}::uuid, ${ts(now)});`));
const tcancel = (s, now = "now") => j(SVC(`select public.app_ticket_cancel(${q(ISS)}, ${q(s)}, ${ts(now)});`));
const rr = (s, pts, now = "now") => j(SVC(`select public.app_redeem_request(${q(ISS)}, ${q(s)}, ${pts}, ${ts(now)});`));
const life = (no) => Number(val(`select public._effective_lifetime(m) from members m where member_no=${q(no)};`));
// 累計を target にする(台帳に『来店』として付与。残高=台帳の合計は保たれる)
const setLife = (no, target) => { const d = target - life(no); assert.ok(d > 0); val(`select public._grant((select id from members where member_no=${q(no)}), 'earn', 'visit', ${d}, 'test:' || gen_random_uuid(), 'test', null, now());`); };
const lookup = (uid, code) => j(AS(uid, `select public.staff_lookup_code(${q(code)});`));
const confirmT = (uid, id) => j(AS(uid, `select public.staff_confirm_ticket(${q(id)}::uuid);`));
const tickets = (no) => JSON.parse(val(`select coalesce(json_agg(json_build_object('kind',kind,'rank',rank_code,'season',season_key,'type',type_code,'used',used_at is not null) order by issued_at, kind, rank_code),'[]') from perk_tickets where member_id=(select id from members where member_no=${q(no)});`));
const fnDefs = () => val(`select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('app_me','export_backup','restore_backup');`);
const thresholds = () => JSON.parse(val(`select json_agg(min_points order by min_points) from rank_thresholds;`));
const STUB = `create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;

try {
  // Supabase 相当のスタブと既定の付与(自動で付く権限)を再現。既存の表・関数(本番の customers など)を先に作り、適用の前後で権限が変わらないことを確認する
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;\n${STUB}`);
  pg.exec(`create table public.customers(id uuid primary key, line_user_id text); create function public.legacy_fn() returns int language sql as $$ select 1 $$;`);
  const snapPriv = () => val(`select string_agg(r || ':' || p::text, ',' order by r) from (
    select r, has_table_privilege(r, 'public.customers', 'select,insert,update,delete') and has_function_privilege(r, 'public.legacy_fn()', 'execute') as p from unnest(array['anon','authenticated','service_role']) r) x;`);
  const privBefore = snapPriv();
  pg.loadFile("100_phase1_schema.sql"); pg.loadFile("101_search_path_fix.sql");
  pg.exec(`update system_state set state='open';
    insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role, active) values ('${STAFF.mgr}','店長','manager',true),('${STAFF.staff}','スタッフ','staff',true),('${STAFF.viewer}','閲覧','viewer',true),
      ('${STAFF.gone}','退職','staff',false),('${STAFF.kiosk}','店頭','kiosk',true),('${STAFF.staff2}','スタッフ2','staff',true);`);

  // ---- 1. 適用・権限・戻し ----
  const A = reg(sub("a"), "既存 会員A", "2026-09-01T03:00:00Z").member.memberNo; setLife(A, 2999);
  const B = reg(sub("b"), "既存 会員B", "2026-09-01T03:00:00Z").member.memberNo; setLife(B, 999);
  assert.equal(val(`select rank_code from members where member_no=${q(A)};`), "white_opal");          // 旧基準(AMBER=10,000)
  const defs100 = fnDefs();
  const realOldBk = val(`set role service_role; select public.export_backup();`).split("\n").pop();   // 本物の 102 より前のバックアップ(旧基準。13 で復元する)
  pg.loadFile("102_rank_perks.sql");
  assert.deepEqual(thresholds(), [0, 1000, 3000, 6000, 10000]);
  assert.equal(val(`select rank_code from members where member_no=${q(A)};`), "amber"); assert.equal(val(`select rank_code from members where member_no=${q(B)};`), "white_opal");
  assert.equal(snapPriv(), privBefore);
  for (const t of ["perk_tickets", "perk_ticket_requests", "perk_ticket_types"]) for (const r of ["anon", "authenticated"])
    assert.equal(val(`select has_table_privilege('${r}', 'public.${t}', '${t === "perk_ticket_types" && r === "authenticated" ? "insert,update,delete" : "select,insert,update,delete"}');`), "f", `${r} ${t}`);
  // 種類の表だけは、スタッフが読める(rank_thresholds と同じ。行レベルセキュリティでスタッフ以外は0行)
  for (const t of ["perk_tickets", "perk_ticket_requests"]) assert.equal(val(`select has_table_privilege('service_role', 'public.${t}', 'delete');`), "f");
  const ex = (r, sig) => val(`select has_function_privilege('${r}', '${sig}', 'execute');`);
  for (const sig of ["public.app_ticket_request(text,text,uuid,timestamptz)", "public.app_ticket_cancel(text,text,timestamptz)", "public.app_me(text,text,timestamptz)", "public.export_backup()"]) {
    assert.equal(ex("service_role", sig), "t", sig); assert.equal(ex("authenticated", sig), "f", sig); assert.equal(ex("anon", sig), "f", sig); }
  for (const sig of ["public.staff_lookup_code(text)", "public.staff_confirm_ticket(uuid)", "public.staff_cancel_ticket(uuid)", "public.staff_ticket_stats()"]) {
    assert.equal(ex("authenticated", sig), "t", sig); assert.equal(ex("anon", sig), "f", sig); }
  for (const sig of ["public._issue_perk_tickets(uuid,timestamptz)", "public._perk_snapshot(uuid,timestamptz)", "public._member_view(uuid,timestamptz)"])
    for (const r of ["anon", "authenticated", "service_role"]) assert.equal(ex(r, sig), "f", `${r} ${sig}`);
  pg.loadFile("102_rank_perks_DOWN.sql");
  assert.equal(fnDefs(), defs100); assert.deepEqual(thresholds(), [0, 10000, 50000, 100000, 200000]);
  assert.equal(val(`select rank_code from members where member_no=${q(A)};`), "white_opal");
  assert.equal(val(`select count(*) from pg_class where relname like 'perk%';`), "0"); assert.equal(val(`select count(*) from pg_trigger where tgname='redeem_code_not_in_tickets';`), "0");
  assert.equal(snapPriv(), privBefore);
  pg.loadFile("102_rank_perks.sql");
  assert.equal(val(`select rank_code from members where member_no=${q(A)};`), "amber"); assert.equal(Number(val(`select count(*) from public.verify_balances();`)), 0);
  ok("102 の適用: 既定で全権限が付く環境でも、新しい表は anon/authenticated から触れず、お客様向け関数は service_role だけ・スタッフ向け関数はログイン済みだけ。置き換えた app_me 等の権限はそのまま。既存の会員のランクは新しい基準で付け直す。DOWN で元の関数・基準・ランクに戻り、再適用もできる");

  // ---- 2. 新しいランクの基準 ----
  const rf = (p) => val(`select public.rank_for(${p});`);
  assert.deepEqual([0, 999, 1000, 2999, 3000, 5999, 6000, 9999, 10000, 250000].map(rf),
    ["white_opal", "white_opal", "amber", "amber", "emerald", "emerald", "ruby", "ruby", "onyx", "onyx"]);
  const mb = me(sub("b"), "2026-10-15T03:00:00Z").member; assert.equal(mb.nextRank.label, "AMBER"); assert.equal(mb.nextRank.targetPoints, 1000); assert.equal(mb.nextRank.remainingPoints, 1);
  assert.deepEqual(mb.tickets, []); assert.equal(mb.pendingTicket, null);
  ok("ランクの基準: 0 / 1,000 / 3,000 / 6,000 / 10,000(境目の前後)。会員証の『次のランクまで』も新しい基準。WHITE OPAL にはチケットなし");

  // ---- 3. 到達のお祝い ----
  let ma = me(sub("a"), "2026-10-15T03:00:00Z").member;            // JST 10/15 12:00
  assert.equal(ma.rank, "amber"); assert.equal(ma.tickets.length, 1);
  assert.equal(ma.tickets[0].title, "AMBER 到達のお祝い・豆花 1つ"); assert.equal(ma.tickets[0].kind, "milestone"); assert.equal(ma.tickets[0].rank, "amber");
  assert.equal(ma.tickets[0].validThrough, "2026-12-14"); assert.equal(Date.parse(ma.tickets[0].expiresAt), Date.parse("2026-12-15T00:00:00+09:00"));   // 発行から60日目の終わり(日本時間)まで
  ma = me(sub("a"), "2026-10-20T03:00:00Z").member; assert.equal(ma.tickets.length, 1); assert.equal(ma.tickets[0].validThrough, "2026-12-14");
  assert.deepEqual(tickets(A), [{ kind: "milestone", rank: "amber", season: null, type: "milestone_amber", used: false }]);
  ok("到達のお祝い(AMBER=豆花1つ): 会員証を開いたときに1枚だけ発行。何度開いても増えない。期限は発行日から60日目の終わり(日本時間)。AMBER に季節の豆花はない");

  // ---- 4. 飛び越しのルール ----
  const C = reg(sub("c"), "会員C", "2026-09-01T03:00:00Z").member.memberNo; setLife(C, 6500);
  let mc = me(sub("c"), "2026-10-15T03:00:00Z").member; assert.equal(mc.rank, "ruby");
  assert.deepEqual(tickets(C).map((t) => [t.kind, t.rank ?? t.season]).sort(), [["milestone", "ruby"], ["seasonal", "2026-autumn"]]);
  assert.ok(mc.tickets.some((t) => t.title === "RUBY 到達のお祝い・持ち帰り用のお茶 1袋"));
  setLife(C, 10000); mc = me(sub("c"), "2026-10-16T03:00:00Z").member; assert.equal(mc.rank, "onyx");
  assert.deepEqual(tickets(C).filter((t) => t.kind === "milestone").map((t) => t.rank).sort(), ["onyx", "ruby"]);
  assert.ok(mc.tickets.some((t) => t.title === "ONYX 到達のお祝い・持ち帰り用のお茶 1袋")); assert.equal(tickets(C).filter((t) => t.kind === "seasonal").length, 1);
  // 移行など『最初から高いランク』の会員(EMERALD)も、そのランクのお祝いだけ
  const E0 = reg(sub("e"), "会員E0", "2026-09-01T03:00:00Z").member.memberNo; setLife(E0, 3000); me(sub("e"), "2026-10-15T03:00:00Z");
  assert.deepEqual(tickets(E0).filter((t) => t.kind === "milestone").map((t) => t.type), ["milestone_emerald"]);
  ok("飛び越しのルール(案): WHITE OPAL から一度に RUBY に上がった会員には RUBY のお祝い(お茶)だけを発行し、AMBER・EMERALD の分は出さない。その後 ONYX に上がれば ONYX の分を発行");

  // ---- 5. 季節の豆花(日本時間・季節の境目) ----
  const so = (d) => j(val(`select public._season_of(${q(d)}::date);`));
  assert.deepEqual(["2026-03-01", "2026-05-31", "2026-06-01", "2026-08-31", "2026-09-01", "2026-11-30", "2026-12-01", "2027-01-15", "2027-02-28", "2027-03-01", "2028-02-29"].map((d) => so(d).key),
    ["2026-spring", "2026-spring", "2026-summer", "2026-summer", "2026-autumn", "2026-autumn", "2026-winter", "2026-winter", "2026-winter", "2027-spring", "2027-winter"]);
  assert.deepEqual([so("2027-01-15").endsOn, so("2026-12-01").endsOn, so("2028-02-29").endsOn, so("2026-04-10").endsOn], ["2027-03-01", "2027-03-01", "2028-03-01", "2026-06-01"]);
  const D = reg(sub("d"), "会員D", "2026-09-01T03:00:00Z").member.memberNo; setLife(D, 3000);
  let md = me(sub("d"), "2027-02-28T14:59:59Z").member;            // JST 2/28 23:59:59(冬の最後の1秒)
  const win = md.tickets.find((t) => t.kind === "seasonal");
  assert.equal(win.season, "2026-winter"); assert.equal(win.title, "季節の豆花 1枚(冬)"); assert.equal(win.validThrough, "2027-02-28"); assert.equal(Date.parse(win.expiresAt), Date.parse("2027-03-01T00:00:00+09:00"));
  md = me(sub("d"), "2027-02-28T15:00:00Z").member;                 // JST 3/1 0:00(春になった瞬間)
  assert.deepEqual(md.tickets.filter((t) => t.kind === "seasonal").map((t) => [t.season, t.title, t.validThrough]), [["2027-spring", "季節の豆花 1枚(春)", "2027-05-31"]]);
  me(sub("d"), "2027-05-31T14:59:59Z"); me(sub("d"), "2027-04-01T00:00:00Z");
  assert.deepEqual(tickets(D).filter((t) => t.kind === "seasonal").map((t) => t.season), ["2026-winter", "2027-spring"]);
  md = me(sub("d"), "2027-05-31T15:00:00Z").member; assert.deepEqual(md.tickets.filter((t) => t.kind === "seasonal").map((t) => t.season), ["2027-summer"]);
  // UTC ではなく日本時間で区切る: UTC では 11/30 だが JST では 12/1(冬)
  const F0 = reg(sub("f"), "会員F0", "2026-09-01T03:00:00Z").member.memberNo; setLife(F0, 3000);
  assert.deepEqual(me(sub("f"), "2026-11-30T15:00:00Z").member.tickets.filter((t) => t.kind === "seasonal").map((t) => t.season), ["2026-winter"]);
  ok("季節の豆花(EMERALD 以上): 季節ごとに1枚・会員×季節で重複なし。季節は日本時間で区切り(冬=12〜2月・閏年も)、期限はその季節の終わり。2/28 23:59:59 は冬の分、3/1 0:00 には冬の分が消えて春の分が出る");

  // ---- 6. コードの申請と確定(以降はスタッフの確定が実時刻なので、会員証も実時刻) ----
  const E = reg(sub("1"), "会員E").member.memberNo; setLife(E, 1000);
  let me1 = me(sub("1")).member; assert.equal(me1.tickets.length, 1); const t1 = me1.tickets[0].ticketId;
  let tr = treq(sub("1"), t1); assert.equal(tr.status, "pending");
  const code1 = tr.member.pendingTicket.code; assert.match(code1, /^\d{6}$/); assert.equal(tr.member.pendingTicket.title, "AMBER 到達のお祝い・豆花 1つ");
  assert.ok(Date.parse(tr.member.pendingTicket.expiresAt) - Date.now() > 170e3);
  assert.equal(treq(sub("1"), t1).member.pendingTicket.code, code1);                                    // 同じチケットで押し直しても同じコード
  assert.equal(treq(sub("a"), t1).status, "ticket_not_found");                                          // 他人のチケットは使えない
  let lk = lookup(STAFF.staff, code1.slice(0, 3) + " " + code1.slice(3) + " ");
  assert.equal(lk.status, "ok"); assert.equal(lk.kind, "ticket"); assert.equal(lk.member.memberNo, E); assert.equal(lk.member.displayName, "会員E"); assert.equal(lk.ticket.title, "AMBER 到達のお祝い・豆花 1つ");
  let cf = confirmT(STAFF.staff, lk.request.id); assert.deepEqual(cf, { status: "confirmed", title: "AMBER 到達のお祝い・豆花 1つ" });
  assert.equal(val(`select used_by from perk_tickets where id=${q(t1)};`), STAFF.staff); assert.equal(val(`select used_at is not null and use_request_id=${q(lk.request.id)} from perk_tickets where id=${q(t1)};`), "t");
  assert.equal(val(`select status || ':' || (confirmed_by=${q(STAFF.staff)}) || ':' || (confirmed_at is not null) from perk_ticket_requests where id=${q(lk.request.id)};`), "confirmed:true:true");
  assert.equal(Number(val(`select count(*) from audit_log where action in ('ticket_lookup','ticket_confirm') and staff_user_id=${q(STAFF.staff)};`)), 2);
  me1 = me(sub("1")).member; assert.deepEqual(me1.tickets, []); assert.equal(me1.pendingTicket, null); assert.equal(me1.lastTicket.status, "confirmed"); assert.equal(me1.lastTicket.title, "AMBER 到達のお祝い・豆花 1つ");
  assert.equal(me1.points, 1000);                                                                       // チケットはポイントを使わない
  ok("チケットの使用: 会員証で『使う』→6桁コード(約3分)→スタッフ画面の入力欄(空白入りでも可)でチケットと判定→会員と特典を確認→確定。確定日時・スタッフを記録し、会員証からチケットが消えて『使用済み』の結果が出る。他人のチケットは申請できない");

  // ---- 7. 二重使用の防止 ----
  assert.equal(confirmT(STAFF.mgr, lk.request.id).status, "already_confirmed");
  assert.equal(lookup(STAFF.mgr, code1).status, "not_found");
  assert.equal(treq(sub("1"), t1).status, "ticket_used");
  { const G = reg(sub("2"), "会員G").member.memberNo; setLife(G, 1000); const tg = me(sub("2")).member.tickets[0].ticketId;
    const c1 = treq(sub("2"), tg).member.pendingTicket.code; const id1 = lookup(STAFF.mgr, c1).request.id;
    assert.equal(tcancel(sub("2")).status, "cancelled"); assert.equal(lookup(STAFF.mgr, c1).status, "not_found");
    const c2 = treq(sub("2"), tg).member.pendingTicket.code; const id2 = lookup(STAFF.mgr, c2).request.id;
    const rs = await Promise.all(Array.from({ length: 6 }, () => ASA(STAFF.staff, `select public.staff_confirm_ticket(${q(id2)}::uuid);`)));
    const sts = rs.map((x) => j(x.stdout).status).sort(); assert.equal(sts.filter((s) => s === "confirmed").length, 1); assert.equal(sts.filter((s) => s === "already_confirmed").length, 5);
    assert.equal(confirmT(STAFF.staff, id1).status, "cancelled");
    fails(() => val(`update perk_ticket_requests set status='confirmed' where id=${q(id1)};`), /perk_req_one_confirmed/);                // 同じチケットの2回目の確定は DB の一意制約でも防ぐ
    assert.equal(Number(val(`select count(*) from perk_tickets where id=${q(tg)} and used_at is not null;`)), 1); }
  ok("二重使用の防止: 確定済みのコードは再確定しても『確定済み』・再入力しても見つからない・使用済みのチケットは申請できない。同じ申請の同時確定(6並列)でも確定は1回。取り消した古いコードでは確定できず、2回目の確定は DB の一意制約でも拒否");

  // ---- 8. 期限 ----
  { const H = reg(sub("3"), "会員H").member.memberNo; setLife(H, 1000); const th = me(sub("3")).member.tickets[0].ticketId;
    const c = treq(sub("3"), th).member.pendingTicket.code; const id = lookup(STAFF.mgr, c).request.id;
    val(`update perk_ticket_requests set expires_at = now() - interval '1 second' where id=${q(id)};`);
    assert.equal(lookup(STAFF.mgr, c).status, "not_found"); assert.equal(confirmT(STAFF.mgr, id).status, "expired");
    assert.equal(me(sub("3")).member.pendingTicket, null); assert.equal(me(sub("3")).member.lastTicket.status, "expired");
    const c2 = treq(sub("3"), th).member.pendingTicket.code; const id2 = lookup(STAFF.mgr, c2).request.id;
    val(`update perk_tickets set expires_at = now() - interval '1 second' where id=${q(th)};`);         // コードの表示中にチケットの期限が過ぎた
    assert.equal(lookup(STAFF.mgr, c2).status, "not_found"); assert.equal(confirmT(STAFF.mgr, id2).status, "ticket_expired");
    assert.equal(val(`select status || ':' || note from perk_ticket_requests where id=${q(id2)};`), "cancelled:ticket_expired");
    assert.deepEqual(me(sub("3")).member.tickets, []); assert.equal(treq(sub("3"), th).status, "ticket_expired");
    assert.equal(val(`select used_at is null from perk_tickets where id=${q(th)};`), "t"); }
  ok("期限: コードの有効時間を過ぎると見つからず確定もできない(期限切れ)。チケットの期限を過ぎると会員証から消え、申請も確定もできない(表示中のコードも無効)");

  // ---- 9. 権限・状態 ----
  { const I = reg(sub("4"), "会員I").member.memberNo; setLife(I, 1000); const ti = me(sub("4")).member.tickets[0].ticketId;
    const c = treq(sub("4"), ti).member.pendingTicket.code; const id = lookup(STAFF.mgr, c).request.id;
    for (const [uid, re] of [[STAFF.viewer, /forbidden/], [STAFF.kiosk, /forbidden/], [STAFF.plain, /not_staff/], [STAFF.gone, /not_staff/]]) {
      fails(() => lookup(uid, c), re); fails(() => confirmT(uid, id), re); fails(() => AS(uid, `select public.staff_cancel_ticket(${q(id)}::uuid);`), re); }
    for (const sql of [`select public.staff_lookup_code('123456');`, `select public.staff_confirm_ticket(${q(id)}::uuid);`, `select public.staff_ticket_stats();`,
                       `select public.app_ticket_request(${q(ISS)}, ${q(sub("4"))}, ${q(ti)}::uuid, now());`, `select * from public.perk_tickets;`]) fails(() => ANON(sql), /permission denied/);
    fails(() => AS(STAFF.mgr, `select public.app_ticket_request(${q(ISS)}, ${q(sub("4"))}, ${q(ti)}::uuid, now());`), /permission denied/);
    fails(() => AS(STAFF.mgr, `select * from public.perk_tickets;`), /permission denied/);
    fails(() => AS(STAFF.kiosk, `select public.staff_ticket_stats();`), /forbidden/);
    assert.equal(j(AS(STAFF.viewer, `select public.staff_ticket_stats();`)).issued > 0, true);
    assert.equal(val(`select used_at is null from perk_tickets where id=${q(ti)};`), "t");
    // 凍結中は申請も確定もできない。試験運用中は本番会員のコードを見つけられない
    SVC(`select public.set_system_state('frozen');`);
    fails(() => treq(sub("4"), ti), /maintenance/); fails(() => confirmT(STAFF.mgr, id), /maintenance/); fails(() => me(sub("4")), /maintenance/);
    SVC(`select public.set_system_state('test');`); assert.equal(lookup(STAFF.mgr, c).status, "not_found"); fails(() => confirmT(STAFF.mgr, id), /maintenance/);
    assert.equal(j(AS(STAFF.viewer, `select public.staff_ticket_stats();`)).issued, 0);
    val(`update system_state set state='open';`);
    assert.equal(confirmT(STAFF.mgr, id).status, "confirmed"); assert.equal(val(`select used_by from perk_tickets where id=${q(ti)};`), STAFF.mgr); }
  ok("権限: 確定・取消・コード確認はスタッフと店長だけ(閲覧のみ・店頭タブレット・スタッフ以外・無効のアカウントは拒否)。お客様向けの申請はスタッフや未ログインからは呼べず、表も直接読めない。集計は閲覧のみでも見られ、店頭タブレットは不可。凍結中は申請・確定とも止まり、試験運用中は本番会員のコードを扱えない");

  // ---- 10. ポイント使用のコードも同じ入力欄で ----
  { const J = reg(sub("5"), "会員J").member.memberNo; setLife(J, 1000); const tj = me(sub("5")).member.tickets[0].ticketId;
    const pc = rr(sub("5"), 100).member.pendingRedeem.code, tc = treq(sub("5"), tj).member.pendingTicket.code; assert.notEqual(pc, tc);
    const m5 = me(sub("5")).member; assert.equal(m5.pendingRedeem.code, pc); assert.equal(m5.pendingTicket.code, tc);         // ポイントとチケットのコードは同時に出せる
    const lp = lookup(STAFF.staff, pc); assert.equal(lp.status, "ok"); assert.equal(lp.kind, "points"); assert.equal(lp.request.points, 100); assert.equal(lp.request.yen, 10); assert.equal(lp.member.memberNo, J);
    const lt = lookup(STAFF.staff, tc); assert.equal(lt.kind, "ticket");
    const before = Number(val(`select balance from members where member_no=${q(J)};`));
    assert.equal(j(AS(STAFF.staff, `select public.staff_confirm_redeem(${q(lp.request.id)}::uuid);`)).status, "confirmed");
    assert.equal(Number(val(`select balance from members where member_no=${q(J)};`)), before - 100);
    assert.equal(confirmT(STAFF.staff, lt.request.id).status, "confirmed");
    assert.equal(Number(val(`select count(*) from public.verify_balances();`)), 0); }
  ok("同じ入力欄: ポイント使用のコードは『ポイント』と判定され、これまでどおり確定でき残高が減る。同じ会員がポイントとチケットのコードを同時に出しても、それぞれ正しく判定・確定できる。残高=台帳");

  // ---- 11. 2種類のコードが重ならない・入力の間違いのロックは共通 ----
  //  乱数の種を固定して、申請の関数が最初に作るコードを先に知る(_throttle が乱数を1つ使うので、コードは2つ目・作り直しは3つ目)
  { const K = reg(sub("6"), "会員K").member.memberNo; setLife(K, 1000); const tk = me(sub("6")).member.tickets[0].ticketId;
    const draws = (seed) => val(`select setseed(${seed}); select random(); select lpad((floor(random() * 1000000))::int::text, 6, '0'); select lpad((floor(random() * 1000000))::int::text, 6, '0');`).split("\n").slice(-2);
    const [x1, x2] = draws(0.42);
    val(`insert into redeem_requests(member_id, points, code, expires_at) values ((select id from members where member_no=${q(B)}), 100, ${q(x1)}, now() + interval '3 minutes');`);
    const got = j(val(`select setseed(0.42); set role service_role; select public.app_ticket_request(${q(ISS)}, ${q(sub("6"))}, ${q(tk)}::uuid, now());`)).member.pendingTicket.code;
    assert.equal(got, x2);                                                                               // 表示中のポイントのコード(x1)と重なったので作り直した
    fails(() => val(`insert into redeem_requests(member_id, points, code, expires_at) values ((select id from members where member_no=${q(B)}), 100, ${q(got)}, now() + interval '3 minutes');`), /code_in_use/);
    val(`insert into redeem_requests(member_id, points, code, expires_at, status) values ((select id from members where member_no=${q(B)}), 100, ${q(got)}, now(), 'cancelled');`);   // 有効でない申請は対象外
    val(`update redeem_requests set status='cancelled' where member_id=(select id from members where member_no=${q(B)}) and status='pending';`);
    const [y1, y2] = draws(0.77);
    val(`update perk_ticket_requests set code=${q(y1)} where member_id=(select id from members where member_no=${q(K)}) and status='pending';`);
    const pr = j(val(`select setseed(0.77); set role service_role; select public.app_redeem_request(${q(ISS)}, ${q(sub("b"))}, 100, now());`));
    assert.equal(pr.status, "pending"); assert.equal(pr.member.pendingRedeem.code, y2);                // 逆向き: ポイントの申請も、表示中のチケットのコード(y1)を避けて作り直す
    for (let i = 0; i < 10; i++) assert.equal(lookup(STAFF.staff2, "abc" + i).status, "not_found");
    fails(() => lookup(STAFF.staff2, "abc"), /too_many_attempts/); fails(() => AS(STAFF.staff2, `select public.staff_lookup_redeem('abc');`), /too_many_attempts/); }
  ok("コードの重なりの防止: チケットのコードは表示中のポイントのコードを避け、ポイントのコードも表示中のチケットのコードを避けて作り直す(DB でも同じ値の同時発行を拒否)。入力の間違いのロック(10分に10回)はポイントとチケットで共通");

  // ---- 12. 集計 ----
  { const st = j(AS(STAFF.viewer, `select public.staff_ticket_stats();`));
    const exp = j(val(`select json_build_object('issued', count(*), 'used', count(*) filter (where used_at is not null), 'm', count(*) filter (where kind='milestone'), 's', count(*) filter (where kind='seasonal'))
      from perk_tickets t join members m on m.id=t.member_id where not m.is_test;`));
    assert.equal(st.issued, exp.issued); assert.equal(st.used, exp.used); assert.equal(st.used, 4);          // 6〜10 で確定した4枚
    assert.equal(st.usageRatePercent, Math.round(1000 * exp.used / exp.issued) / 10);
    assert.equal(st.byKind.milestone.issued, exp.m); assert.equal(st.byKind.seasonal.issued, exp.s); assert.equal(st.active + st.expiredUnused + st.used, st.issued);
    assert.equal(typeof st.pendingTickets, "number"); }
  ok("集計(staff_ticket_stats): チケットの発行数・使用数・使用率(使用数÷発行数)・種類別。いまの状態の会員だけを数える(試験運用中は試験会員だけ)");

  // ---- 13. バックアップ/復元 ----
  { const bk = val(`set role service_role; select public.export_backup();`).split("\n").pop(); const b = JSON.parse(bk);
    assert.ok(b.tables.perk_tickets.length > 5); assert.ok(b.tables.perk_ticket_requests.length > 5); assert.equal(b.tables.perk_ticket_types.length, 5);
    pg.createDb("t2"); pg.execIn("t2", STUB); pg.loadFileIn("t2", "100_phase1_schema.sql"); pg.loadFileIn("t2", "101_search_path_fix.sql"); pg.loadFileIn("t2", "102_rank_perks.sql");
    pg.execIn("t2", `insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};`);
    const rs = JSON.parse(pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`).split("\n").pop()); assert.equal(rs.status, "restored"); assert.equal(rs.balanceMismatches, 0);
    const cnt = (db, sql) => (db ? pg.execIn(db, sql) : val(sql));
    for (const t of ["perk_tickets", "perk_ticket_requests"]) assert.equal(cnt("t2", `select count(*) from ${t};`), cnt(null, `select count(*) from ${t};`));
    pg.execIn("t2", `update system_state set state='open';`);
    const before = cnt("t2", `select count(*) from perk_tickets;`);
    const m1 = JSON.parse(pg.execIn("t2", `set role service_role; select public.app_me(${q(ISS)}, ${q(sub("1"))}, now());`).split("\n").pop()).member;
    assert.deepEqual(m1.tickets, []); assert.equal(cnt("t2", `select count(*) from perk_tickets;`), before);         // 使用済みのお祝いを復元後に出し直さない
    fails(() => pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`), /target_not_empty/);
    // 102 より前のバックアップ: 表を消した作り物ではなく、1 で 100・101 だけの DB から書き出した本物(旧基準 0/10,000/50,000/…)を、100〜108 の DB に復元する(監査 M-1)
    const ro = JSON.parse(realOldBk); assert.deepEqual(ro.tables.rank_thresholds.map((x) => x.min_points).sort((x, y) => x - y), [0, 10000, 50000, 100000, 200000]);
    assert.equal("perk_tickets" in ro.tables, false); assert.equal("perk_ticket_types" in ro.tables, false);
    pg.createDb("t3"); pg.execIn("t3", STUB);
    for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql", "106_referral.sql",
                     "107_constitution_each_visit.sql", "108_restore_old_backup_fix.sql"]) pg.loadFileIn("t3", f);
    const r3 = JSON.parse(pg.execIn("t3", `set role service_role; select public.restore_backup(${q(realOldBk)}::jsonb);`).split("\n").pop());
    assert.equal(r3.status, "restored"); assert.equal(r3.balanceMismatches, 0); assert.equal(r3.rankThresholds, "kept_current"); assert.equal(r3.reranked, 1);
    assert.deepEqual(JSON.parse(pg.execIn("t3", `select json_agg(min_points order by min_points) from rank_thresholds;`)), [0, 1000, 3000, 6000, 10000]);
    assert.equal(pg.execIn("t3", `select rank_code from members where member_no=${q(A)};`), "amber"); assert.equal(pg.execIn("t3", `select rank_code from members where member_no=${q(B)};`), "white_opal");
    assert.equal(pg.execIn("t3", `select count(*) from perk_tickets;`), "0"); assert.equal(pg.execIn("t3", `select count(*) from perk_ticket_types where kind <> 'referral';`), "5"); }
  ok("バックアップ/復元: チケット・使用の申請・種類もバックアップに入り、空の DB に復元できる(使用済みは使用済みのまま・お祝いを出し直さない)。本物の 102 より前のバックアップ(旧基準)も 108 の後の DB に復元でき、基準は新しいまま・ランクは累計から付け直す");
  console.log(`\n${n} rank perk tests passed`);
} finally { pg.stop(); }
