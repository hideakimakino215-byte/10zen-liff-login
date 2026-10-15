// 監査 AUDIT_20261015.md の低の指摘への修正(db/109・db/110)を、実 PostgreSQL 16 で検証する。本番には接続しない。データはすべて擬似。
//   L-1(109): コードを出した後に停止された会員の特典チケット・ポイント使用は、スタッフが確定できない(member_inactive・申請は取り消し)
//   L-2(110): ディナーの五巡茶の出し方の切り替えは、いまの状態の区分の会員のチケットだけ名前を変え、凍結中は止まる
// 実行: node --experimental-strip-types test_audit_fixes.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";
import { redeemReduce, mapError } from "../app-core/staff-client.mjs";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053";
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3" };
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
const val = (sql) => pg.exec(sql);
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const AS = (uid, sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const fails = (fn, re) => { try { fn(); } catch (e) { assert.match(String(e.message), re, e.message); return; } assert.fail("expected failure " + re); };
const reg = (s, name) => j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, now());`)).member.memberNo;
const me = (s) => j(SVC(`select public.app_me(${q(ISS)}, ${q(s)}, now());`)).member;
const idOf = (no) => val(`select id from members where member_no=${q(no)};`);
const setLife = (no, target) => val(`select public._grant(m.id, 'earn', 'visit', ${target} - public._effective_lifetime(m), 'fix-test:' || gen_random_uuid(), 'test', null, now()) from members m where member_no=${q(no)};`);
const ex = (r, sig) => val(`select has_function_privilege('${r}', '${sig}', 'execute');`);
const defs = (names) => val(`select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${names.map(q).join(",")});`);
const ok3 = { kind: "ok" };
const ALL = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql",
             "106_referral.sql", "107_constitution_each_visit.sql", "108_restore_old_backup_fix.sql"];

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  for (const f of ALL) pg.loadFile(f);
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit';
    insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role) values ('${STAFF.mgr}','店長','manager'),('${STAFF.staff}','スタッフ','staff'),('${STAFF.viewer}','閲覧','viewer');`);

  // ---- L-1. 109: 停止中の会員のコードは確定しない ----
  const CONFIRM = ["staff_confirm_ticket", "staff_confirm_redeem"], SIGS = ["public.staff_confirm_ticket(uuid)", "public.staff_confirm_redeem(uuid)"];
  const before109 = defs(CONFIRM);
  pg.loadFile("109_confirm_inactive_member.sql");
  for (const sig of SIGS) assert.deepEqual(["anon", "authenticated", "service_role"].map((r) => ex(r, sig)), ["f", "t", "f"], sig);
  const after109 = defs(CONFIRM); assert.notEqual(after109, before109);
  pg.loadFile("109_confirm_inactive_member_DOWN.sql"); assert.equal(defs(CONFIRM), before109);
  for (const sig of SIGS) assert.deepEqual(["anon", "authenticated", "service_role"].map((r) => ex(r, sig)), ["f", "t", "f"], sig);
  pg.loadFile("109_confirm_inactive_member.sql"); assert.equal(defs(CONFIRM), after109);
  ok("109 の適用: 確定の2つの関数だけを置き換え、権限はそのまま(スタッフ=ログイン済みだけ。anon・service_role は不可)。DOWN で 100・102 の内容と権限に正確に戻り、再適用もできる");

  { const A = reg(sub("a"), "停止 太郎"); setLife(A, 1500);
    const t = me(sub("a")).tickets.find((x) => x.kind === "milestone"); assert.ok(t);
    const code = j(SVC(`select public.app_ticket_request(${q(ISS)}, ${q(sub("a"))}, ${q(t.ticketId)}::uuid, now());`)).member.pendingTicket.code;
    val(`update members set status='suspended' where member_no=${q(A)};`);                                           // コードを出した後に店長が停止
    const lk = j(AS(STAFF.staff, `select public.staff_lookup_code(${q(code)});`)); assert.equal(lk.kind, "ticket");    // 確認はできる(確定で止まる)
    const r = j(AS(STAFF.staff, `select public.staff_confirm_ticket(${q(lk.request.id)}::uuid);`));
    assert.equal(r.status, "member_inactive"); assert.equal(r.title, t.title);
    assert.equal(val(`select status || '/' || note from perk_ticket_requests where id=${q(lk.request.id)};`), "cancelled/member_inactive");
    assert.equal(val(`select used_at is null from perk_tickets where id=${q(t.ticketId)};`), "t");                     // チケットは未使用のまま
    assert.equal(val(`select meta->>'reason' from audit_log where action='ticket_confirm_refused' and target_member_id=${q(idOf(A))};`), "member_inactive");
    assert.equal(j(AS(STAFF.staff, `select public.staff_confirm_ticket(${q(lk.request.id)}::uuid);`)).status, "cancelled");   // 押し直しても確定しない
    assert.equal(redeemReduce({ step: "confirming", kind: "ticket", request: lk.request }, { type: "confirm_result", result: { ...ok3, data: r } }).step, "member_inactive");
    // 停止を解くと、同じチケットを改めて使える
    val(`update members set status='active' where member_no=${q(A)};`);
    const code2 = j(SVC(`select public.app_ticket_request(${q(ISS)}, ${q(sub("a"))}, ${q(t.ticketId)}::uuid, now());`)).member.pendingTicket.code;
    const lk2 = j(AS(STAFF.staff, `select public.staff_lookup_code(${q(code2)});`));
    assert.equal(j(AS(STAFF.staff, `select public.staff_confirm_ticket(${q(lk2.request.id)}::uuid);`)).status, "confirmed"); }
  ok("特典チケット: コードを出した後に会員が停止されたら、スタッフが確定しても member_inactive(申請は取り消し・チケットは未使用のまま・監査ログに理由)。押し直しても確定しない。画面の状態は member_inactive。停止を解けば改めて使える");

  { const B = reg(sub("b"), "停止 花子"); setLife(B, 800); const bal0 = Number(val(`select balance from members where member_no=${q(B)};`));
    const ledger0 = val(`select count(*) from point_ledger where member_id=${q(idOf(B))};`);
    const rq = j(SVC(`select public.app_redeem_request(${q(ISS)}, ${q(sub("b"))}, 300, now());`)).member.pendingRedeem;
    for (const st of ["suspended", "closed"]) {
      const code = st === "suspended" ? rq.code : j(SVC(`select public.app_redeem_request(${q(ISS)}, ${q(sub("b"))}, 300, now());`)).member.pendingRedeem.code;
      const lk = j(AS(STAFF.staff, `select public.staff_lookup_code(${q(code)});`)); assert.equal(lk.kind, "points");
      val(`update members set status=${q(st)} where member_no=${q(B)};`);
      const r = j(AS(STAFF.staff, `select public.staff_confirm_redeem(${q(lk.request.id)}::uuid);`));
      assert.deepEqual([r.status, r.points], ["member_inactive", 300], st);
      assert.equal(val(`select status || '/' || note from redeem_requests where id=${q(lk.request.id)};`), "cancelled/member_inactive");
      assert.equal(redeemReduce({ step: "confirming", request: lk.request }, { type: "confirm_result", result: { ...ok3, data: r } }).step, "member_inactive");
      val(`update members set status='active' where member_no=${q(B)};`);
    }
    assert.equal(Number(val(`select balance from members where member_no=${q(B)};`)), bal0); assert.equal(val(`select count(*) from point_ledger where member_id=${q(idOf(B))};`), ledger0);
    assert.equal(val(`select count(*) from audit_log where action='redeem_confirm_refused' and target_member_id=${q(idOf(B))};`), "2");
    // 有効な会員は従来どおり確定できる
    const code = j(SVC(`select public.app_redeem_request(${q(ISS)}, ${q(sub("b"))}, 300, now());`)).member.pendingRedeem.code;
    const lk = j(AS(STAFF.staff, `select public.staff_lookup_code(${q(code)});`));
    assert.equal(j(AS(STAFF.staff, `select public.staff_confirm_redeem(${q(lk.request.id)}::uuid);`)).status, "confirmed");
    assert.equal(Number(val(`select balance from members where member_no=${q(B)};`)), bal0 - 300);
    assert.equal(Number(val(`select count(*) from public.verify_balances();`)), 0); }
  ok("ポイント使用も同じ: 停止中・退会の会員のコードは member_inactive(申請は取り消し・残高と台帳は変わらない・監査ログに理由)。有効な会員は従来どおり確定でき、残高=台帳");

  // ---- L-2. 110: 五巡茶の出し方は、いまの状態の区分だけ・凍結中は止める ----
  const before110 = defs(["manager_set_dinner_tea_mode"]), TEA = "public.manager_set_dinner_tea_mode(text)";
  pg.loadFile("110_dinner_tea_mode_partition.sql");
  const after110 = defs(["manager_set_dinner_tea_mode"]); assert.notEqual(after110, before110);
  assert.deepEqual(["anon", "authenticated", "service_role"].map((r) => ex(r, TEA)), ["f", "t", "f"]);
  pg.loadFile("110_dinner_tea_mode_partition_DOWN.sql"); assert.equal(defs(["manager_set_dinner_tea_mode"]), before110);
  assert.deepEqual(["anon", "authenticated", "service_role"].map((r) => ex(r, TEA)), ["f", "t", "f"]);
  pg.loadFile("110_dinner_tea_mode_partition.sql"); assert.equal(defs(["manager_set_dinner_tea_mode"]), after110);
  ok("110 の適用: 五巡茶の出し方の関数だけを置き換え、権限はそのまま(ログイン済みだけ。関数の中で店長を確認)。DOWN で 106 の内容と権限に正確に戻り、再適用もできる");

  { // 本番の会員 P と試験会員 T に、紹介のチケット(まだ使っていないもの・使用済み)を用意する
    val(`update system_state set state='open';`); const P = reg(sub("p"), "本番 会員");
    SVC(`select public.allow_test_identity(${q(ISS)}, ${q(sub("t"))}, '試験');`); val(`update system_state set state='test';`); const T = reg(sub("t"), "試験 会員");
    assert.equal(val(`select is_test from members where member_no=${q(T)};`), "t"); assert.equal(val(`select is_test from members where member_no=${q(P)};`), "f");
    const CUP = "お友だち紹介・ディナーの五巡茶 1杯", FREE = "お友だち紹介・ディナーの五巡茶 飲み放題";
    const add = (no, used) => val(`insert into perk_tickets(member_id, type_code, kind, title, issued_at, expires_at, used_at, used_by)
      values (${q(idOf(no))}, 'referral_tea', 'referral', ${q(CUP)}, now(), now() + interval '60 days', ${used ? "now()" : "null"}, ${used ? q(STAFF.staff) : "null"}) returning id;`);
    const tk = { p: add(P, false), pUsed: add(P, true), t: add(T, false), tUsed: add(T, true) };
    const titles = () => Object.fromEntries(Object.entries(tk).map(([k, id]) => [k, val(`select title from perk_tickets where id=${q(id)};`)]));
    const setTea = (mode) => j(AS(STAFF.mgr, `select public.manager_set_dinner_tea_mode(${q(mode)});`));
    const setting = () => val(`select value from app_settings where key='dinner_tea_mode';`);

    // 試験運用中: 試験会員のまだ使っていないチケットだけ。本番の会員のチケットは変わらない
    let r = setTea("free_flow"); assert.deepEqual([r.status, r.mode, r.retitled], ["ok", "free_flow", 1]);
    assert.deepEqual(titles(), { p: CUP, pUsed: CUP, t: FREE, tUsed: CUP }); assert.equal(setting(), "free_flow");
    assert.equal(val(`select meta->>'test' from audit_log where action='dinner_tea_mode' order by id desc limit 1;`), "true");
    // 凍結中: 止める(設定もチケットも変えない)。画面には maintenance として伝わる
    val(`update system_state set state='frozen';`);
    fails(() => setTea("cup"), /maintenance/); assert.equal(setting(), "free_flow"); assert.deepEqual(titles(), { p: CUP, pUsed: CUP, t: FREE, tUsed: CUP });
    try { setTea("cup"); } catch (e) { assert.deepEqual(mapError({ message: e.message }), { kind: "maintenance" }); }
    // 本番開始の後: 同じ出し方でもう一度保存すると本番の会員のチケットが揃う。試験会員のチケットには触れない
    val(`update system_state set state='open';`);
    r = setTea("free_flow"); assert.equal(r.retitled, 1); assert.deepEqual(titles(), { p: FREE, pUsed: CUP, t: FREE, tUsed: CUP });
    r = setTea("cup"); assert.equal(r.retitled, 1); assert.deepEqual(titles(), { p: CUP, pUsed: CUP, t: FREE, tUsed: CUP });
    assert.equal(val(`select meta->>'test' from audit_log where action='dinner_tea_mode' order by id desc limit 1;`), "false");
    assert.equal(val(`select label from perk_ticket_types where code='referral_tea';`), "ディナーの五巡茶 1杯");
    // 権限は従来どおり: 店長だけ。不正な値は invalid_mode
    fails(() => AS(STAFF.staff, `select public.manager_set_dinner_tea_mode('cup');`), /forbidden/);
    fails(() => AS(STAFF.viewer, `select public.manager_set_dinner_tea_mode('cup');`), /forbidden/);
    fails(() => setTea("bottle"), /invalid_mode/); }
  ok("五巡茶の出し方: 試験運用中は試験会員のまだ使っていないチケットだけ名前を変え、本番の会員のチケットは変えない(監査ログに区分)。凍結中は maintenance で止まり、設定もチケットも変わらない(画面には maintenance)。本番開始の後にもう一度保存すると本番の会員のチケットが揃う。使用済みは当時の名前のまま。店長以外は従来どおり拒否");

  console.log(`\n${n} audit fix tests passed`);
} finally { pg.stop(); }
