// 102 より前に取ったバックアップの復元(db/108_restore_old_backup_fix.sql。監査 AUDIT_20261015.md の M-1)を、実 PostgreSQL 16 で検証する。本番には接続しない。データはすべて擬似。
// 「古いバックアップ」は作り物ではなく、100・101 だけの DB で実際に export_backup() したもの(古い基準 0/10,000/50,000/100,000/200,000 が入っている)を使う。
// 実行: node --experimental-strip-types test_restore_old_backup.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053";
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2" };
const last = (s) => s.split("\n").filter(Boolean).pop();
const j = (s) => JSON.parse(last(s));
const fails = (fn, re) => { try { fn(); } catch (e) { assert.match(String(e.message), re, e.message); return; } assert.fail("expected failure " + re); };
const STUB = `create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;
const UPTO107 = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql",
                 "106_referral.sql", "107_constitution_each_visit.sql"];
const ALL = [...UPTO107, "108_restore_old_backup_fix.sql"];
// 別の DB(同じサーバの中)を作り、移行を順に入れる
const fresh = (db, files) => { pg.createDb(db); pg.execIn(db, STUB); for (const f of files) pg.loadFileIn(db, f);
  pg.execIn(db, `insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};`); };
const restore = (db, bk) => j(pg.execIn(db, `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`));
const thresholds = (db) => JSON.parse(db ? pg.execIn(db, `select json_object_agg(rank_code, min_points order by min_points) from rank_thresholds;`)
                                          : pg.exec(`select json_object_agg(rank_code, min_points order by min_points) from rank_thresholds;`));
const members = (db) => JSON.parse(pg.execIn(db, `select json_object_agg(member_no, json_build_object('rank', rank_code, 'balance', balance, 'life', public._effective_lifetime(m), 'test', is_test) order by member_no) from members m;`));
const NEW = { white_opal: 0, amber: 1000, emerald: 3000, ruby: 6000, onyx: 10000 };
const OLD = { white_opal: 0, amber: 10000, emerald: 50000, ruby: 100000, onyx: 200000 };

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;\n${STUB}`);

  // ---- 1. 本物の古いバックアップ(100・101 だけの DB で書き出す) ----
  pg.loadFile("100_phase1_schema.sql"); pg.loadFile("101_search_path_fix.sql");
  pg.exec(`update system_state set state='open'; insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role) values ('${STAFF.mgr}','店長','manager'),('${STAFF.staff}','スタッフ','staff');`);
  const reg = (s, name) => j(pg.exec(`set role service_role; select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, '2026-09-01T03:00:00Z');`)).member.memberNo;
  const grant = (no, pts, key) => pg.exec(`select public._grant((select id from members where member_no=${q(no)}), 'earn', 'visit', ${pts}, ${q(key)}, 'test', null, now());`);
  // 累計(登録の 100pt を含む): 500 / 2,999 / 3,000 / 12,000(旧基準で AMBER)/ 60,000(旧基準で EMERALD)
  const plan = [["a", 500], ["b", 2999], ["c", 3000], ["d", 12000], ["e", 60000]];
  const no = {};
  for (const [k, life] of plan) { no[k] = reg(sub(k), `旧会員${k}`); const base = Number(pg.exec(`select public._effective_lifetime(m) from members m where member_no=${q(no[k])};`)); if (life > base) grant(no[k], life - base, `old:${k}`); }
  // ポイントの使用(残高 < 累計)と来店の記録も入れておく
  const rq = j(pg.exec(`set role service_role; select public.app_redeem_request(${q(ISS)}, ${q(sub("d"))}, 2000, now());`));
  const lk = j(pg.exec(`set role authenticated; set request.jwt.claim.sub='${STAFF.staff}'; select public.staff_lookup_redeem(${q(rq.member.pendingRedeem.code)});`));
  assert.equal(j(pg.exec(`set role authenticated; set request.jwt.claim.sub='${STAFF.staff}'; select public.staff_confirm_redeem(${q(lk.request.id)}::uuid);`)).status, "confirmed");
  pg.exec(`insert into visits(member_id, visit_on, source) select id, current_date - 3, 'store_qr' from members;`);
  const src = JSON.parse(pg.exec(`select json_object_agg(member_no, json_build_object('rank', rank_code, 'balance', balance, 'life', public._effective_lifetime(m)) order by member_no) from members m;`));
  assert.deepEqual(Object.values(src).map((x) => x.rank), ["white_opal", "white_opal", "white_opal", "amber", "emerald"]);   // 旧基準でのランク
  assert.equal(src[no.d].balance, 10000); assert.equal(src[no.d].life, 12000);
  const oldBk = last(pg.exec(`set role service_role; select public.export_backup()::text;`));
  const ob = JSON.parse(oldBk);
  assert.deepEqual(Object.fromEntries(ob.tables.rank_thresholds.map((r) => [r.rank_code, r.min_points])), OLD);
  for (const k of ["perk_ticket_types", "perk_tickets", "constitution_checks", "kpi_settings", "member_referrals"]) assert.equal(k in ob.tables, false, k);   // 102 以降の表はない
  ok("本物の古いバックアップ: 100・101 だけの DB(旧基準)で会員5人・付与・ポイント使用・来店を作り export_backup()。旧基準 0/10,000/50,000/100,000/200,000 が入り、102 以降の表はない");

  // ---- 2. 修正前(100〜107)では失敗する(監査の再現)→ 108 を入れると同じ DB に復元できる ----
  fresh("t107", UPTO107);
  fails(() => restore("t107", oldBk), /rank_thresholds_min_points_key/);
  assert.deepEqual(thresholds("t107"), NEW); assert.equal(pg.execIn("t107", `select count(*) from members;`), "0");          // 失敗した復元は何も残さない
  pg.loadFileIn("t107", "108_restore_old_backup_fix.sql");
  const r107 = restore("t107", oldBk);
  assert.equal(r107.status, "restored"); assert.equal(r107.rankThresholds, "kept_current"); assert.equal(r107.balanceMismatches, 0);
  ok("修正前(100〜107)の復元は一意の決まり(rank_thresholds_min_points_key)で失敗し、何も残らない(監査 M-1 の再現)。同じ DB に 108 を入れると復元できる");

  // ---- 3. 100〜108 の新しい DB に復元: 基準は新しいまま・ランクは累計から付け直す・残高は一致 ----
  fresh("t2", ALL);
  const rs = restore("t2", oldBk);
  assert.equal(rs.status, "restored"); assert.equal(rs.state, "frozen"); assert.equal(rs.balanceMismatches, 0); assert.equal(rs.members, 5);
  assert.equal(rs.ledger, ob.tables.point_ledger.length); assert.equal(rs.rankThresholds, "kept_current");
  assert.deepEqual(thresholds("t2"), NEW);                                                                                      // 古い基準で上書きしない
  assert.deepEqual(JSON.parse(pg.execIn("t2", `select json_agg(label order by min_points) from rank_thresholds;`)), ["WHITE OPAL", "AMBER", "EMERALD", "RUBY", "ONYX"]);
  const got = members("t2");
  const want = { a: "white_opal", b: "amber", c: "emerald", d: "onyx", e: "onyx" };                                             // 102 の付け直しと同じ(新しい基準)
  for (const [k, rank] of Object.entries(want)) {
    assert.equal(got[no[k]].rank, rank, k); assert.equal(got[no[k]].rank, pg.execIn("t2", `select public.rank_for(${got[no[k]].life});`), k);
    assert.equal(got[no[k]].balance, src[no[k]].balance, k); assert.equal(got[no[k]].life, src[no[k]].life, k); }
  assert.equal(rs.reranked, 4);                                                                                                 // a は WHITE OPAL のまま
  assert.equal(pg.execIn("t2", `select count(*) from public.verify_balances();`), "0");
  assert.equal(Number(pg.execIn("t2", `select count(*) from visits;`)), ob.tables.visits.length); assert.ok(ob.tables.visits.length >= 5); assert.equal(pg.execIn("t2", `select count(*) from redeem_requests where status='confirmed';`), "1");
  assert.equal(pg.execIn("t2", `select count(*) from perk_ticket_types;`), "6");                                                // 102・106 の種類は今の DB のまま
  ok("100〜108 の新しい DB に本物の古いバックアップを復元: 成功(frozen・残高の不一致0)。基準は新しい 0/1,000/3,000/6,000/10,000 のまま(古い基準で上書きしない)。会員のランクは累計から新しい基準で付け直し(2,999→AMBER・3,000→EMERALD・12,000→ONYX)、残高・累計は元の DB と一致");

  // ---- 4. 復元の後に開くと、102 と同じくチケットが出る。もう一度の復元は拒否 ----
  pg.execIn("t2", `update system_state set state='open';`);
  const md = j(pg.execIn("t2", `set role service_role; select public.app_me(${q(ISS)}, ${q(sub("d"))}, now());`)).member;
  assert.equal(md.rank, "onyx"); assert.equal(md.points, 10000);
  assert.ok(md.tickets.some((t) => t.kind === "milestone" && t.rank === "onyx")); assert.equal(md.tickets.filter((t) => t.kind === "milestone").length, 1);
  fails(() => restore("t2", oldBk), /target_not_empty/);
  ok("復元の後に会員証を開くと、102 と同じく到達のお祝いが今のランクの分だけ出る(飛び越しのルール)。空でない DB への復元は従来どおり拒否");

  // ---- 5. 102 以降のバックアップ: 基準が重なっても置き換えられる(ランクはバックアップのまま) ----
  // 元の DB(t2)の基準を 0 / 3,000 / 6,000 / 10,000 / 20,000 にする(AMBER の 3,000 は新しい DB の EMERALD と同じ値)
  pg.execIn("t2", `update rank_thresholds set min_points = 20000 where rank_code='onyx'; update rank_thresholds set min_points = 10000 where rank_code='ruby';
                   update rank_thresholds set min_points = 6000 where rank_code='emerald'; update rank_thresholds set min_points = 3000 where rank_code='amber';
                   update rank_thresholds set label = 'AMBER*' where rank_code='amber';`);
  const custom = { white_opal: 0, amber: 3000, emerald: 6000, ruby: 10000, onyx: 20000 };
  // 行の順番によっては1行ずつの上書きでも通ってしまうので、いちばん厳しい順(必要なポイントの小さい順: AMBER=3,000 が今の EMERALD=3,000 と先にぶつかる)に並べる
  const nb = JSON.parse(last(pg.execIn("t2", `set role service_role; select public.export_backup()::text;`)));
  nb.tables.rank_thresholds.sort((x, y) => x.min_points - y.min_points); const newBk = JSON.stringify(nb);
  const srcRanks = members("t2");
  fresh("t106", UPTO107); fails(() => restore("t106", newBk), /rank_thresholds_min_points_key/);                                // 修正前は 102 以降のバックアップでも重なると失敗
  fresh("t3", ALL);
  const r3 = restore("t3", newBk);
  assert.equal(r3.status, "restored"); assert.equal(r3.rankThresholds, "restored"); assert.equal(r3.reranked, 0); assert.equal(r3.balanceMismatches, 0);
  assert.deepEqual(thresholds("t3"), custom); assert.equal(pg.execIn("t3", `select label from rank_thresholds where rank_code='amber';`), "AMBER*");
  assert.deepEqual(members("t3"), srcRanks);                                                                                    // ランク・残高はバックアップのまま
  assert.equal(pg.execIn("t3", `select count(*) from perk_tickets;`), pg.execIn("t2", `select count(*) from perk_tickets;`));
  // 壊れた基準(必要なポイントが空)の 102 以降のバックアップは拒否し、何も書かない
  const broken = JSON.parse(newBk); broken.tables.rank_thresholds[0].min_points = null;
  fresh("t4", ALL); fails(() => restore("t4", JSON.stringify(broken)), /invalid_backup/); assert.deepEqual(thresholds("t4"), NEW);
  ok("102 以降のバックアップ: 基準の値が今の DB と重なっても(AMBER=3,000 と EMERALD=3,000)、まとめて置き換えられる(修正前は失敗)。ランク・残高・チケットはバックアップのまま。壊れた基準は invalid_backup で拒否し、基準は変わらない");

  // ---- 6. 権限と戻し(DOWN) ----
  const ex = (db, r) => pg.execIn(db, `select has_function_privilege('${r}', 'public.restore_backup(jsonb)', 'execute');`);
  assert.deepEqual(["anon", "authenticated", "service_role"].map((r) => ex("t4", r)), ["f", "f", "t"]);
  const def = (db) => pg.execIn(db, `select md5(pg_get_functiondef('public.restore_backup(jsonb)'::regprocedure));`);
  const def107 = def("t106");
  assert.notEqual(def("t4"), def107);
  pg.loadFileIn("t4", "108_restore_old_backup_fix_DOWN.sql");
  assert.equal(def("t4"), def107); assert.deepEqual(["anon", "authenticated", "service_role"].map((r) => ex("t4", r)), ["f", "f", "t"]);
  fails(() => restore("t4", oldBk), /rank_thresholds_min_points_key/);
  pg.loadFileIn("t4", "108_restore_old_backup_fix.sql");
  assert.equal(restore("t4", oldBk).rankThresholds, "kept_current");
  ok("権限: restore_backup は service_role だけ(anon・authenticated は不可)のまま。DOWN で 106 の内容と権限に正確に戻り(古いバックアップは再び失敗)、再適用もできる");

  console.log(`\n${n} restore old backup tests passed`);
} finally { pg.stop(); }
