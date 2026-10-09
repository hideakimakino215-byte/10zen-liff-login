// 新しい会員基盤 → 既存 customers(追客・リピート計測用)への反映を、本番相当のスキーマ(000)+既存の来店関数(003)の上で検証する。
// 実行: node --experimental-strip-types test_phase1_mirror.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053", sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
const STAFF = "00000000-0000-0000-0000-0000000000b2";
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const AS = (sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${STAFF}';\n${sql}`);
const reg = (s, name, now) => j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, ${q(now)}::timestamptz);`));
const chk = (s, now) => j(SVC(`select public.app_checkin(${q(ISS)}, ${q(s)}, null, ${q(now)}::timestamptz);`));
const cust = (s) => JSON.parse(pg.exec(`select coalesce((select row_to_json(c) from (select visit_count, points, rank, lifetime_points, membership_user_id, status from customers where line_user_id=${q(s)}) c),'null');`));
const nInter = (s) => Number(pg.exec(`select count(*) from interactions i join customers c on c.id=i.customer_id where c.line_user_id=${q(s)};`));
try {
  pg.loadFile("000_prodlike_schema.sql");
  pg.exec(`create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.exec(`insert into stores(name) values('10ZEN');`);
  pg.loadFile("003_membership_checkin_rpc.sql");
  pg.loadFile("100_phase1_schema.sql");
  pg.exec(`update system_state set state='open';`);
  pg.exec(`insert into auth.users(id) values ('${STAFF}'); insert into staff_users(user_id, display_name, role) values ('${STAFF}','店長','manager');`);
  ok("既存スキーマ(customers・来店関数)の上に新しい会員基盤を適用");

  // 1) 新規登録 → customers にも反映(来店回数1・履歴1・ポイント・会員番号)
  const A = sub("a"); reg(A, "試験", "2026-09-01T03:00:00Z");
  let c = cust(A); assert.deepEqual([c.visit_count, c.points, c.rank, c.membership_user_id], [1, 100, "white_opal", "user00001"]); assert.equal(nInter(A), 1);
  assert.equal(Number(pg.exec(`select count(*) from membership_events where event_key = ${q("visit:" + A + ":2026-09-01")};`)), 1);
  ok("登録: customers に会員が作られ、来店回数1・履歴1・ポイント100・会員番号が入る(既存と同じイベントキー visit:LINE ID:JST日)");
  // 2) 翌日の来店 → 回数2・ポイント200。同じ操作を繰り返しても増えない
  chk(A, "2026-09-02T01:00:00Z"); chk(A, "2026-09-02T05:00:00Z");
  c = cust(A); assert.deepEqual([c.visit_count, c.points], [2, 200]); assert.equal(nInter(A), 2);
  ok("来店: 翌日の来店で来店回数2・ポイント200。同じ日の再読み取りでは増えない");
  // 3) 切替日の境界: 既存システムが今日すでに数えた会員は二重に数えない
  const B = sub("b");
  pg.exec(`insert into customers(store_id,line_user_id,first_visited_at,last_visited_at,visit_count,points,points_updated_at) select id, ${q(B)}, '2026-08-01T01:00:00Z','2026-09-05T00:30:00Z',5,300,'2026-09-05T00:30:00Z' from stores where name='10ZEN';
           insert into interactions(store_id,customer_id,trigger_type,sent_at) select store_id, id, 'membership_checkin','2026-09-05T00:30:00Z' from customers where line_user_id=${q(B)};`);
  SVC(`update system_state set state='frozen'; select public.import_opening_balance('user00002','既存会員',${q(ISS)},${q(B)},300,null,'2026-09-05','test','2026-09-05T00:00:00Z'); update system_state set state='open';`);
  chk(B, "2026-09-05T03:00:00Z");
  c = cust(B); assert.equal(c.visit_count, 5); assert.equal(nInter(B), 1);
  chk(B, "2026-09-06T03:00:00Z"); c = cust(B); assert.equal(c.visit_count, 6); assert.equal(c.points, 400);
  ok("切替日の境界: 既存システムが同じ日に数えた来店は二重に数えない(5のまま)。翌日からは+1で、ポイントも反映");
  // 4) ポイント使用・手動調整も customers のポイントに反映
  SVC(`select public.app_redeem_request(${q(ISS)}, ${q(A)}, 100, '2026-09-07T03:00:00Z'::timestamptz);`);
  pg.exec(`update redeem_requests set expires_at = now() + interval '3 minutes' where status='pending';`);
  const rid = pg.exec(`select id from redeem_requests where status='pending';`);
  assert.equal(j(AS(`select public.staff_confirm_redeem(${q(rid)}::uuid);`)).status, "confirmed");
  assert.equal(cust(A).points, 100);
  const aid = pg.exec(`select id from members where member_no='user00001';`);
  assert.equal(j(AS(`select public.manager_adjust(${q(aid)}::uuid, 50, '訂正', 'adj-mirror-0001');`)).status, "ok");
  assert.equal(cust(A).points, 150);
  assert.equal(j(AS(`select public.manager_reverse_redeem(${q(rid)}::uuid, '誤確定');`)).status, "reversed");
  assert.equal(cust(A).points, 250); assert.equal(cust(A).visit_count, 2);
  ok("ポイント使用・手動調整・使用の取消でも customers のポイントが追従(来店回数は変わらない)");
  // 5) 反映に失敗しても会員証側(ポイント・来店)は成功し、失敗は監査ログに残る。customers は中途半端に更新されない
  pg.exec(`update fail_flag set on_ = true;`);
  const C = sub("c"); const rr = reg(C, "失敗時", "2026-09-10T03:00:00Z");
  assert.equal(rr.member.points, 100); assert.equal(cust(C), null);
  pg.exec(`update fail_flag set on_ = false;`);
  chk(A, "2026-09-11T03:00:00Z"); pg.exec(`update fail_flag set on_ = true;`);
  const before = cust(A); assert.equal(j(SVC(`select public.app_checkin(${q(ISS)}, ${q(A)}, null, '2026-09-12T03:00:00Z'::timestamptz);`)).status, "counted");
  assert.deepEqual(cust(A), before);
  assert.equal(Number(pg.exec(`select count(*) from audit_log where action='mirror_failed';`)), 2);
  pg.exec(`update fail_flag set on_ = false;`);
  assert.equal(Number(pg.exec(`select count(*) from public.verify_balances();`)), 0);
  ok("反映の失敗: 会員証側のポイント付与・来店は成功し、customers は中途半端に更新されず、失敗は監査ログ(mirror_failed)に記録される");
  // 6) 反映の停止設定
  pg.exec(`update app_settings set value='false' where key='mirror_to_customers';`);
  const D = sub("d"); reg(D, "停止中", "2026-09-13T03:00:00Z"); assert.equal(cust(D), null);
  const v0 = cust(A).visit_count; chk(A, "2026-09-13T03:00:00Z"); assert.equal(cust(A).visit_count, v0);
  pg.exec(`update app_settings set value='true' where key='mirror_to_customers';`);
  ok("設定 mirror_to_customers=false で customers への反映を止められる");
  // 登録日を来店扱いにしない設定(方針で決定): 自宅での登録は customers の来店回数・最終来店日を作らない・変えない。最初の実際の来店で作られる
  pg.exec(`update app_settings set value='false' where key='register_counts_as_visit';`);
  const mf0 = Number(pg.exec(`select count(*) from audit_log where action='mirror_failed';`));
  const E = sub("e"); reg(E, "自宅で登録", "2026-09-20T03:00:00Z");
  assert.equal(cust(E), null); assert.equal(Number(pg.exec(`select count(*) from customers c where c.line_user_id=${q(E)};`)), 0);
  assert.equal(Number(pg.exec(`select count(*) from audit_log where action='mirror_failed';`)), mf0);   // 失敗の記録も増えない
  // 既存会員(来店済み)の登録関連は影響しない。登録だけでは last_visited_at も動かない
  const lv = pg.exec(`select last_visited_at from customers c where c.line_user_id=${q(A)};`);
  reg(sub("f"), "別の人", "2026-09-20T04:00:00Z"); assert.equal(pg.exec(`select last_visited_at from customers c where c.line_user_id=${q(A)};`), lv);
  chk(E, "2026-09-21T03:00:00Z"); c = cust(E); assert.deepEqual([c.visit_count, c.points], [1, 200]);   // 登録ボーナス100+来店100。来店回数は店頭での1回目から
  ok("登録日を来店扱いにしない設定: 自宅での登録は customers を作らず来店回数・最終来店日を変えない。最初の店頭QRの来店で来店回数1・ポイント(登録100+来店100)が反映される");
  console.log(`\n${n} mirror tests passed`);
} finally { pg.stop(); }
