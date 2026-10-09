// フェーズ1(完成形)の DB 関数を、実 PostgreSQL 16 で検証する(並列は別プロセス=別接続)。本番には接続しない。
// 実行: node --experimental-strip-types test_phase1_db.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053";
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3",
                gone: "00000000-0000-0000-0000-0000000000d4", plain: "00000000-0000-0000-0000-0000000000e5" };
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const AS = (uid, sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const ANON = (sql) => pg.exec(`set role anon;\n${sql}`);
const SVCA = (sql) => pg.runAsync(`set role service_role;\n${sql}`);
const ASA = (uid, sql) => pg.runAsync(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const fails = (fn, re) => { try { fn(); } catch (e) { assert.match(String(e.message), re, e.message); return; } assert.fail("expected failure " + re); };
const reg = (s, name = "テスト会員", ref = null, now = "2026-09-01T03:00:00Z") =>
  j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, ${q(ref)}, ${q(now)}::timestamptz);`));
const me = (s, now = "2026-09-01T03:00:00Z") => j(SVC(`select public.app_me(${q(ISS)}, ${q(s)}, ${q(now)}::timestamptz);`));
const chk = (s, now, slot = null) => j(SVC(`select public.app_checkin(${q(ISS)}, ${q(s)}, ${slot === null ? "null" : slot}::bigint, ${q(now)}::timestamptz);`));
const rr = (s, pts, now = "2026-09-01T03:00:00Z") => j(SVC(`select public.app_redeem_request(${q(ISS)}, ${q(s)}, ${pts}, ${q(now)}::timestamptz);`));
const val = (sql) => pg.exec(sql);
const mid = (no) => val(`select id from members where member_no=${q(no)};`);
const ledger = (no) => JSON.parse(val(`select coalesce(json_agg(json_build_object('t',entry_type,'r',rule_code,'p',points,'after',balance_after) order by id),'[]') from point_ledger where member_id=(select id from members where member_no=${q(no)});`));

try {
  // Supabase 相当のスタブと既定の付与(自動で付く権限)を再現してから適用する
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  // 既存の表・関数(本番の customers など)を先に作り、適用の前後で権限が1つも変わらないことを確認する
  pg.exec(`create table public.customers(id uuid primary key, line_user_id text); create view public.legacy_view as select * from public.customers;
    create function public.legacy_fn() returns int language sql as $$ select 1 $$;
    create sequence public.legacy_seq;`);
  const snapPriv = () => val(`select string_agg(r || ':' || o || ':' || p::text, ',' order by r, o) from (
    select r, o, has_table_privilege(r, o, 'select,insert,update,delete,truncate') as p from unnest(array['anon','authenticated','service_role']) r, unnest(array['public.customers','public.legacy_view']) o
    union all select r, 'fn', has_function_privilege(r, 'public.legacy_fn()', 'execute') from unnest(array['anon','authenticated','service_role']) r
    union all select r, 'seq', has_sequence_privilege(r, 'public.legacy_seq', 'usage') from unnest(array['anon','authenticated','service_role']) r) x;`);
  const privBefore = snapPriv(); assert.match(privBefore, /true/);
  pg.loadFile("100_phase1_schema.sql");
  assert.equal(snapPriv(), privBefore);
  // 戻し(DOWN)の確認: 取り消すと、新しい物だけが消えて既存は元のまま。もう一度適用できる
  const objs = () => val(`select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('members','point_ledger','visits','redeem_requests','app_settings','member_no_seq'))
    + (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'app\\_%' or p.proname like 'staff\\_%');`);
  assert.ok(Number(objs()) > 10); pg.loadFile("100_phase1_schema_DOWN.sql"); assert.equal(Number(objs()), 0); assert.equal(snapPriv(), privBefore);
  assert.equal(val(`select count(*) from public.customers;`), "0"); assert.equal(val(`select public.legacy_fn();`), "1");
  pg.loadFile("100_phase1_schema.sql"); assert.equal(snapPriv(), privBefore);
  ok("スキーマ適用: 既定で全権限が付く環境でも、新しい物には必要な権限だけが残り、既存の表・ビュー・関数・連番の権限は1つも変わらない。DOWN(戻し)で新しい物だけが消え、既存は元のまま・再適用もできる");
  pg.exec(`insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role, active) values
      ('${STAFF.mgr}','店長','manager',true),('${STAFF.staff}','スタッフ','staff',true),('${STAFF.viewer}','閲覧','viewer',true),('${STAFF.gone}','退職','staff',false);`);

  // ---- 制度の値 ----
  assert.equal(Number(val(`select count(*) from rank_thresholds;`)), 5);
  assert.deepEqual(JSON.parse(val(`select json_agg(rank_code order by min_points) from rank_thresholds;`)), ["white_opal", "amber", "emerald", "ruby", "onyx"]);
  assert.equal(val(`select public.rank_for(9999);`), "white_opal"); assert.equal(val(`select public.rank_for(10000);`), "amber");
  assert.equal(val(`select public.rank_for(199999);`), "ruby"); assert.equal(val(`select public.rank_for(200000);`), "onyx");
  ok("ランク閾値(既存GASと同じ 0/10000/50000/100000/200000)と境界");

  // ---- 登録 ----
  let r = reg(sub("a"), "牧野　太郎");
  assert.equal(r.status, "created"); assert.equal(r.member.points, 100); assert.equal(r.member.rank, "white_opal"); assert.equal(r.member.memberNo, "user00001");
  assert.equal(r.member.lifetimeConfirmed, true); assert.equal(r.member.visitedToday, true); assert.equal(r.member.nextRank.label, "AMBER"); assert.equal(r.member.nextRank.remainingPoints, 9900);
  assert.deepEqual(ledger("user00001"), [{ t: "earn", r: "welcome", p: 100, after: 100 }]);
  assert.ok(!JSON.stringify(r).includes(sub("a")), "外部IDを返さない");
  ok("新規登録: 登録ボーナス100pt・台帳1件・会員番号 user00001。応答に外部IDを含まない");
  r = reg(sub("a"), "別の名前"); assert.equal(r.status, "existing"); assert.equal(r.member.points, 100); assert.equal(r.member.displayName, "牧野　太郎");
  ok("再ログイン・再登録は既存会員を返し、ポイントも氏名も変わらない");
  const rs = await Promise.all(Array.from({ length: 12 }, () => SVCA(`select public.app_register(${q(ISS)}, ${q(sub("b"))}, 'x', null, '2026-09-01T03:00:00Z');`)));
  assert.ok(rs.every((x) => x.status === 0), rs.map((x) => x.stderr).join("|"));
  assert.equal(Number(val(`select count(*) from member_identities where subject=${q(sub("b"))};`)), 1);
  assert.equal(Number(val(`select count(*) from point_ledger where member_id=(select member_id from member_identities where subject=${q(sub("b"))});`)), 1);
  ok("同じ人の12並列の登録 → 会員1・登録ボーナス1回(重複作成なし)");
  r = reg(sub("c"), "期間内", null, "2026-10-12T03:00:00Z"); assert.equal(r.member.points, 200);
  assert.deepEqual(ledger(r.member.memberNo).map((x) => x.r), ["welcome", "campaign_welcome"]);
  r = reg(sub("d"), "期間外", null, "2026-11-02T03:00:00Z"); assert.equal(r.member.points, 100);
  r = reg(sub("e"), "前日", null, "2026-10-09T14:59:59Z"); assert.equal(r.member.points, 100);   // JST 10/09 23:59:59 は期間前
  r = reg(sub("f"), "初日", null, "2026-10-09T15:00:00Z"); assert.equal(r.member.points, 200);    // JST 10/10 00:00:00 は期間内
  ok("キャンペーン(JST 10/10〜10/31)の境界: 前日23:59は対象外、当日0:00は対象(+100)");
  const ref0 = reg(sub("g"), "紹介者").member;
  r = reg(sub("h"), "紹介された人", ref0.memberNo);
  assert.equal(r.member.points, 100); assert.deepEqual(ledger(r.member.memberNo).map((x) => x.r), ["referral_welcome"]);
  assert.equal(me(sub("g")).member.points, 200); assert.deepEqual(ledger(ref0.memberNo).map((x) => x.r), ["welcome", "referral_referrer"]);
  r = reg(sub("i"), "不正な紹介コード", "user99999"); assert.equal(r.member.points, 100); assert.deepEqual(ledger(r.member.memberNo).map((x) => x.r), ["welcome"]);
  r = reg(sub("j"), "大文字小文字", ref0.memberNo.toUpperCase()); assert.deepEqual(ledger(r.member.memberNo).map((x) => x.r), ["referral_welcome"]);
  ok("紹介: 紹介者+100、紹介された人は登録ボーナスの代わりに紹介ボーナス100。存在しない会員番号は通常登録。大文字小文字は区別しない");
  r = reg(sub("k"), "  \u0007\u001b名前\n改行  "); assert.equal(r.member.displayName, "名前改行");
  r = reg(sub("l"), "あ".repeat(80)); assert.equal([...r.member.displayName].length, 40);
  r = reg(sub("m"), "   "); assert.equal(r.member.displayName, null);
  ok("表示名: 制御文字を除去・40文字に切り詰め・空は null(0文字や空白を保存しない)");
  fails(() => SVC(`select public.app_register('', ${q(sub("z"))}, 'x', null, now());`), /invalid_identity/);
  for (let i = 0; i < 5; i++) { try { SVC(`select public.app_register(${q(ISS)}, 'U${"9".repeat(31)}${i}', 'x', null, '2026-09-01T03:00:00Z');`); } catch (_e) {} }
  ok("登録の入力検証(発行元・ID必須)");

  // ---- 来店 ----
  const A = sub("a");
  let c = chk(A, "2026-09-02T01:00:00Z", 100);
  assert.equal(c.status, "counted"); assert.equal(c.granted, 100); assert.equal(c.member.points, 200); assert.equal(c.member.visitedToday, true);
  c = chk(A, "2026-09-02T10:00:00Z", 101); assert.equal(c.status, "already_today"); assert.equal(c.member.points, 200);
  assert.equal(Number(val(`select count(*) from visits where member_id=${q(mid("user00001"))} and source='store_qr';`)), 1);
  ok("来店: 1回目は+100、同じJST日の2回目は付与なし(already_today)");
  // 登録した日は来店日として扱う(既存GASと同じ): 登録日の来店ポイントは付かない。設定で解除できる
  { const R = sub("8"); reg(R, "登録日の来店", null, "2026-09-20T01:00:00Z");
    let x = chk(R, "2026-09-20T05:00:00Z"); assert.equal(x.status, "already_today"); assert.equal(x.reason, "registered_today"); assert.equal(x.member.points, 100);
    x = chk(R, "2026-09-21T05:00:00Z"); assert.equal(x.status, "counted"); assert.equal(x.member.points, 200);
    x = chk(R, "2026-09-21T06:00:00Z"); assert.equal(x.reason, "visited_today");
    pg.exec(`update app_settings set value='false' where key='register_counts_as_visit';`);
    const R2 = sub("7"); reg(R2, "登録日も来店", null, "2026-09-22T01:00:00Z"); x = chk(R2, "2026-09-22T05:00:00Z"); assert.equal(x.status, "counted"); assert.equal(x.member.points, 200);
    pg.exec(`update app_settings set value='true' where key='register_counts_as_visit';`); }
  ok("登録した日は来店日として扱い、同じ日の来店ポイントは付かない(理由 registered_today)。翌日からは付与。設定を false にすると登録日にも付与");
  c = chk(A, "2026-09-02T14:59:59Z"); assert.equal(c.status, "already_today");   // JST 23:59:59
  c = chk(A, "2026-09-02T15:00:00Z"); assert.equal(c.status, "counted"); assert.equal(c.member.points, 300);               // JST 翌日 0:00
  ok("日付の境界(JST): 23:59:59は同日、0:00:00は翌日として付与");
  const B = sub("b");
  const cs = await Promise.all(Array.from({ length: 12 }, (_, i) => SVCA(`select public.app_checkin(${q(ISS)}, ${q(B)}, ${200 + i}::bigint, '2026-09-03T01:00:00Z');`)));
  assert.ok(cs.every((x) => x.status === 0), cs.map((x) => x.stderr).join("|"));
  assert.equal(cs.filter((x) => JSON.parse(x.stdout).status === "counted").length, 1);
  assert.equal(me(B, "2026-09-03T02:00:00Z").member.points, 200);
  assert.equal(Number(val(`select count(*) from point_ledger where idempotency_key like 'visit:%' and member_id=(select member_id from member_identities where subject=${q(B)});`)), 1);
  ok("同じ会員の12並列の来店 → 付与1回・台帳1件(二重付与なし)");
  assert.equal(chk(sub("zz"), "2026-09-03T01:00:00Z").status, "not_registered");
  pg.exec(`update members set status='suspended' where member_no='user00002';`);
  assert.equal(chk(B, "2026-09-04T01:00:00Z").status, "not_registered"); assert.equal(me(B).status, "not_registered");
  pg.exec(`update members set status='active' where member_no='user00002';`);
  ok("未登録・停止中の会員は付与されない");

  // ---- ランクの更新(開始残高の取り込み経由で閾値付近を再現) ----
  const imp = (no, name, s, bal, life, last = "2026-08-25") =>
    j(SVC(`select public.import_opening_balance(${q(no)}, ${q(name)}, ${q(ISS)}, ${s ? q(s) : "null"}, ${bal}, ${life === null ? "null" : life}::integer, ${q(last)}::date, 'test 基準 2026-10-08', '2026-08-25T00:00:00Z');`));
  // 連番は取り込み後の会員番号より後ろから始まるので、先に既存の会員番号と衝突しない番号で取り込む
  assert.equal(imp("user00101", "移行1", sub("p"), 9950, null).status, "imported");
  assert.equal(imp("user00101", "移行1", sub("p"), 9950, null).status, "already_imported");
  assert.equal(Number(val(`select count(*) from visits where source='legacy' and visit_on='2026-08-25' and member_id=${q(mid("user00101"))};`)), 1);
  assert.equal(chk(sub("p"), "2026-08-25T03:00:00Z").status, "already_today");     // 切替日に、既存システムが付けた来店と二重にならない
  let s = me(sub("p"), "2026-09-05T03:00:00Z").member;
  assert.equal(s.points, 9950); assert.equal(s.rank, "white_opal"); assert.equal(s.lifetimeConfirmed, false);
  c = chk(sub("p"), "2026-09-05T03:00:00Z"); assert.equal(c.member.points, 10050); assert.equal(c.member.rank, "amber");
  assert.equal(c.member.nextRank.label, "EMERALD");
  ok("開始残高の取り込み(冪等・累計未確認はlifetimeConfirmed=false)と、来店で閾値を超えるとランク更新(WHITE OPAL→AMBER)");
  assert.equal(imp("user00102", "移行2", sub("q"), 10000, null).status, "imported");
  assert.equal(me(sub("q")).member.rank, "amber");
  assert.equal(imp("user00103", "移行3", null, 100, 200).status, "imported");
  assert.equal(JSON.parse(val(`select json_build_object('b',balance,'lb',lifetime_base,'r',rank_code) from members where member_no='user00103';`)).lb, 200);
  fails(() => imp("user00104", "衝突", sub("p"), 1, null), /identity_belongs_to_other_member/);
  fails(() => imp("user00105", "負", sub("r"), -1, null), /invalid_balance/);
  assert.equal(Number(val(`select count(*) from members where member_no='user00104' or member_no='user00105';`)), 0, "失敗時は会員が残らない");
  assert.equal(reg(sub("n"), "移行後の新規").member.memberNo, "user00104");
  ok("取り込み: 残高10000→AMBER(現在残高から算出)・累計確認済みの値を保持・他会員のIDとは衝突拒否・失敗時は何も残らない・以降の新規会員番号は連番の続き");

  // ---- ポイント使用(お客様の申請 → スタッフ確認) ----
  const P = sub("p");   // 残高10050
  assert.equal(rr(P, 50).status, "invalid_amount"); assert.equal(rr(P, 0).status, "invalid_amount"); assert.equal(rr(P, -100).status, "invalid_amount");
  assert.equal(rr(P, 150).status, "invalid_amount"); assert.equal(rr(P, 20000).status, "insufficient_balance");
  let q1 = rr(P, 1000, "2026-09-06T03:00:00Z");
  assert.equal(q1.status, "pending"); assert.match(q1.member.pendingRedeem.code, /^[0-9]{6}$/); assert.equal(q1.member.pendingRedeem.yen, 100);
  const code1 = q1.member.pendingRedeem.code;
  assert.equal(rr(P, 1000, "2026-09-06T03:00:30Z").member.pendingRedeem.code, code1);
  assert.equal(rr(P, 2000, "2026-09-06T03:00:30Z").status, "already_pending");
  assert.equal(me(P, "2026-09-06T03:02:00Z").member.pendingRedeem.code, code1);
  assert.equal(me(P, "2026-09-06T03:03:01Z").member.pendingRedeem, null);          // 3分で期限切れ
  assert.equal(Number(val(`select count(*) from point_ledger where entry_type='redeem';`)), 0);
  ok("申請: 単位違い・0・負・残高超過は拒否。同額の再送は同じコード、別額は already_pending。3分で期限切れ。申請だけでは残高は動かない");
  // スタッフが確認・確定。有効期限は現在時刻基準なので、検証用に期限を延ばして確認
  const q1b = rr(P, 1000, "2026-09-06T03:10:00Z"); assert.equal(q1b.status, "pending"); const code1b = q1b.member.pendingRedeem.code;
  pg.exec(`update redeem_requests set expires_at = now() + interval '3 minutes' where status='pending';`);
  let lk = j(AS(STAFF.staff, `select public.staff_lookup_redeem(${q(code1b)});`));
  assert.equal(lk.status, "ok"); assert.equal(lk.request.points, 1000); assert.equal(lk.request.yen, 100); assert.equal(lk.member.points, 10050);
  assert.ok(!JSON.stringify(lk).includes(P), "スタッフ画面に外部IDを出さない");
  const reqId = lk.request.id;
  assert.equal(j(AS(STAFF.staff, `select public.staff_lookup_redeem('000000');`)).status, "not_found");
  let cf = j(AS(STAFF.staff, `select public.staff_confirm_redeem(${q(reqId)}::uuid);`));
  assert.deepEqual([cf.status, cf.points, cf.yen, cf.balanceAfter], ["confirmed", 1000, 100, 9050]);
  assert.equal(me(P, "2026-09-06T03:01:00Z").member.points, 9050);
  assert.deepEqual(ledger("user00101").slice(-1)[0], { t: "redeem", r: "redeem", p: -1000, after: 9050 });
  assert.equal(j(AS(STAFF.staff, `select public.staff_confirm_redeem(${q(reqId)}::uuid);`)).status, "already_confirmed");
  assert.equal(Number(val(`select count(*) from point_ledger where entry_type='redeem';`)), 1);
  ok("スタッフ確認: コード入力→内容(氏名・会員番号・ポイント・円)確認→確定で残高-1000・台帳に使用1件。二度目の確定は already_confirmed(二重引落なし)");
  // 並列確定
  const Q = sub("q");   // 残高10000
  rr(Q, 3000, "2026-09-06T03:00:00Z"); pg.exec(`update redeem_requests set expires_at = now() + interval '3 minutes' where status='pending';`);
  const rid2 = val(`select id from redeem_requests where status='pending';`);
  const pc = await Promise.all(Array.from({ length: 12 }, () => ASA(STAFF.staff, `select public.staff_confirm_redeem(${q(rid2)}::uuid);`)));
  assert.ok(pc.every((x) => x.status === 0), pc.map((x) => x.stderr).join("|"));
  const sts = pc.map((x) => JSON.parse(x.stdout).status).sort();
  assert.equal(sts.filter((x) => x === "confirmed").length, 1); assert.equal(sts.filter((x) => x === "already_confirmed").length, 11);
  assert.equal(me(Q).member.points, 7000);
  assert.equal(Number(val(`select count(*) from point_ledger where source_ref=${q(rid2)};`)), 1);
  ok("同じ申請を12並列で確定 → 引落1回(残高7000)・11件は already_confirmed");
  // 期限切れ・取消・残高不足
  rr(Q, 1000, "2026-09-06T04:00:00Z"); const rid3 = val(`select id from redeem_requests where status='pending';`);
  pg.exec(`update redeem_requests set expires_at = now() - interval '1 second' where id=${q(rid3)};`);
  assert.equal(j(AS(STAFF.staff, `select public.staff_confirm_redeem(${q(rid3)}::uuid);`)).status, "expired");
  assert.equal(j(AS(STAFF.staff, `select public.staff_lookup_redeem(${q(val(`select code from redeem_requests where id=${q(rid3)};`))});`)).status, "not_found");
  assert.equal(me(Q).member.points, 7000);
  rr(Q, 1000, "2026-09-06T05:00:00Z"); const rid4 = val(`select id from redeem_requests where status='pending';`);
  pg.exec(`update redeem_requests set expires_at = now() + interval '3 minutes' where id=${q(rid4)};`);
  assert.equal(j(AS(STAFF.staff, `select public.staff_cancel_redeem(${q(rid4)}::uuid);`)).status, "cancelled");
  assert.equal(j(AS(STAFF.staff, `select public.staff_confirm_redeem(${q(rid4)}::uuid);`)).status, "cancelled");
  rr(Q, 7000, "2026-09-06T06:00:00Z"); const rid5 = val(`select id from redeem_requests where status='pending';`);
  pg.exec(`update redeem_requests set expires_at = now() + interval '3 minutes' where id=${q(rid5)};`);
  j(AS(STAFF.mgr, `select public.manager_adjust(${q(mid("user00102"))}::uuid, -500, '店頭での訂正', 'adj-test-0001');`));
  const ins = j(AS(STAFF.staff, `select public.staff_confirm_redeem(${q(rid5)}::uuid);`));
  assert.deepEqual([ins.status, ins.points], ["insufficient_balance", 6500]);
  assert.equal(me(Q).member.points, 6500);
  ok("期限切れは確定できない/コードも無効。取消後は確定できない。申請後に残高が減った場合は insufficient_balance(残高はマイナスにならない)");
  // 取消と確定の同時実行
  for (let i = 0; i < 8; i++) {
    pg.exec(`update redeem_requests set status='cancelled' where status='pending';`);
    const sP = sub(String.fromCharCode(112 + 0)); // p
    pg.exec(`delete from api_throttle;`);
    rr(sP, 100, "2026-09-07T03:00:00Z"); pg.exec(`update redeem_requests set expires_at = now() + interval '3 minutes' where status='pending';`);
    const rid = val(`select id from redeem_requests where status='pending';`);
    const before = Number(val(`select count(*) from point_ledger where entry_type='redeem';`));
    const [x1, x2] = await Promise.all([ASA(STAFF.staff, `select public.staff_confirm_redeem(${q(rid)}::uuid);`), ASA(STAFF.mgr, `select public.staff_cancel_redeem(${q(rid)}::uuid);`)]);
    assert.ok(x1.status === 0 && x2.status === 0, x1.stderr + x2.stderr);
    const st = val(`select status from redeem_requests where id=${q(rid)};`), after = Number(val(`select count(*) from point_ledger where entry_type='redeem';`));
    assert.equal(st === "confirmed" ? after - before : after - before, st === "confirmed" ? 1 : 0, `${st}`);
  }
  ok("確定と取消の同時実行(8回): 最終状態は confirmed(引落1)か cancelled(引落0)のどちらかで矛盾しない");

  // ---- 権限 ----
  pg.exec(`delete from api_throttle; update redeem_requests set status='cancelled' where status='pending';`);
  rr(sub("q"), 100, "2026-09-08T03:00:00Z"); pg.exec(`update redeem_requests set expires_at = now() + interval '3 minutes' where status='pending';`);
  const pend = JSON.parse(val(`select json_build_object('id',id,'code',code) from redeem_requests where status='pending';`));
  for (const role of ["viewer"]) {
    fails(() => AS(STAFF[role], `select public.staff_lookup_redeem(${q(pend.code)});`), /forbidden/);
    fails(() => AS(STAFF[role], `select public.staff_confirm_redeem(${q(pend.id)}::uuid);`), /forbidden/);
  }
  for (const u of [STAFF.gone, STAFF.plain]) fails(() => AS(u, `select public.staff_confirm_redeem(${q(pend.id)}::uuid);`), /not_staff/);
  fails(() => ANON(`select public.staff_confirm_redeem(${q(pend.id)}::uuid);`), /permission denied/);
  fails(() => AS(STAFF.staff, `select public.manager_adjust(${q(mid("user00001"))}::uuid, 10, 'x', 'adj-test-0002');`), /forbidden/);
  assert.equal(Number(val(`select count(*) from point_ledger where entry_type='redeem' and source_ref=${q(pend.id)};`)), 0);
  ok("権限: 閲覧のみ・退職者・スタッフ以外・未ログインは確認も確定もできない。スタッフは手動調整できない");
  // コード総当たりの制限
  pg.exec(`delete from audit_log;`);
  for (let i = 0; i < 10; i++) assert.equal(j(AS(STAFF.staff, `select public.staff_lookup_redeem('${String(i).repeat(6)}');`)).status, "not_found");
  fails(() => AS(STAFF.staff, `select public.staff_lookup_redeem(${q(pend.code)});`), /too_many_attempts/);
  assert.equal(j(AS(STAFF.mgr, `select public.staff_lookup_redeem(${q(pend.code)});`)).status, "ok");   // 別スタッフは影響を受けない
  ok("コード当て: 同じスタッフが10分間に10回外すと、正しいコードでも一時的に拒否される(他のスタッフは別カウント)");
  // 顧客関数はスタッフ・未ログインからは呼べない / 表への直接アクセス不可
  for (const sql of [`select public.app_me(${q(ISS)}, ${q(sub("a"))}, now());`, `select public.verify_balances();`, `select public.import_opening_balance('x','x','i','s',1,1,null,'x',now());`]) {
    fails(() => AS(STAFF.mgr, sql), /permission denied/); fails(() => ANON(sql), /permission denied/);
  }
  for (const t of ["members", "member_identities", "point_ledger", "visits", "redeem_requests", "staff_users", "audit_log", "api_throttle"]) {
    fails(() => AS(STAFF.mgr, `select count(*) from ${t};`), /permission denied/); fails(() => ANON(`select count(*) from ${t};`), /permission denied/);
  }
  fails(() => AS(STAFF.mgr, `insert into point_ledger(member_id,entry_type,points,balance_after,idempotency_key,source,occurred_at) values (${q(mid("user00001"))},'earn',1,1,'x1','x',now());`), /permission denied/);
  ok("権限: 店長でも表を直接読めず、顧客向け・移行用の関数は呼べない。未ログイン(anon)は何も呼べない");
  // service_role でも台帳は削除・更新・全消去できない / 超ユーザーでも更新不可(トリガー)
  fails(() => SVC(`delete from point_ledger;`), /permission denied/); fails(() => SVC(`update point_ledger set points=1;`), /permission denied/);
  fails(() => SVC(`truncate point_ledger;`), /permission denied/); fails(() => SVC(`delete from audit_log;`), /permission denied/);
  fails(() => pg.exec(`update point_ledger set points=1;`), /append-only/); fails(() => pg.exec(`delete from point_ledger;`), /append-only/); fails(() => pg.exec(`truncate point_ledger;`), /append-only|foreign key/); fails(() => pg.exec(`truncate point_ledger cascade;`), /append-only/);
  ok("台帳・監査ログ: service_role でも削除・更新・全消去できない。管理者権限でもトリガーで拒否(追記専用)");

  // ---- 店長の調整・取消 ----
  const M1 = mid("user00001"); const balM1 = () => Number(val(`select balance from members where id=${q(M1)};`));
  const b0 = balM1();
  assert.equal(j(AS(STAFF.mgr, `select public.manager_adjust(${q(M1)}::uuid, 50, '紙の台帳との差異の訂正', 'adj-test-0003');`)).status, "ok");
  assert.equal(j(AS(STAFF.mgr, `select public.manager_adjust(${q(M1)}::uuid, 50, '紙の台帳との差異の訂正', 'adj-test-0003');`)).status, "duplicate");
  assert.equal(balM1(), b0 + 50);
  fails(() => AS(STAFF.mgr, `select public.manager_adjust(${q(M1)}::uuid, 5, '', 'adj-test-0004');`), /reason_required/);
  fails(() => AS(STAFF.mgr, `select public.manager_adjust(${q(M1)}::uuid, 0, 'x', 'adj-test-0004');`), /invalid_points/);
  fails(() => AS(STAFF.mgr, `select public.manager_adjust(${q(M1)}::uuid, 5, 'x', 'bad key!');`), /invalid_key/);
  assert.equal(j(AS(STAFF.mgr, `select public.manager_adjust(${q(M1)}::uuid, -${b0 + 51}, '過大な減算', 'adj-test-0005');`)).status, "insufficient_balance");
  assert.equal(balM1(), b0 + 50);
  const detail = j(AS(STAFF.viewer, `select public.staff_member_detail(${q(M1)}::uuid);`));
  assert.equal(detail.ledger[0].type, "adjust"); assert.equal(detail.ledger[0].reason, "紙の台帳との差異の訂正");
  ok("店長の手動調整: 理由必須・冪等(同じキーは1回)・残高マイナス不可。履歴に理由が残る");
  assert.equal(j(AS(STAFF.mgr, `select public.manager_reverse_redeem(${q(reqId)}::uuid, '誤って確定したため');`)).status, "reversed");
  assert.equal(j(AS(STAFF.mgr, `select public.manager_reverse_redeem(${q(reqId)}::uuid, '誤って確定したため');`)).status, "already_reversed");
  assert.equal(me(P).member.points, 9050 + 1000 - 100 * Number(val(`select count(*) from point_ledger where member_id=${q(mid("user00101"))} and entry_type='redeem' and points=-100;`)));
  assert.equal(j(AS(STAFF.mgr, `select public.manager_reverse_redeem(${q(pend.id)}::uuid, '未確定');`)).status, "not_confirmed");
  fails(() => AS(STAFF.staff, `select public.manager_reverse_redeem(${q(reqId)}::uuid, 'x');`), /forbidden/);
  ok("使用の取消(戻し): 店長のみ・理由必須・1回だけ(二重戻しなし)。台帳は削除せず調整行を追記");

  // ---- 参照系 ----
  const list = j(AS(STAFF.viewer, `select public.staff_list_members(null, 1000, 0);`));
  assert.equal(list.items.length, Math.min(100, list.total)); assert.ok(list.total > 5);
  assert.equal(j(AS(STAFF.viewer, `select public.staff_list_members('user00101', 50, 0);`)).items.length, 1);
  assert.equal(j(AS(STAFF.viewer, `select public.staff_list_members('牧野', 50, 0);`)).items[0].memberNo, "user00001");
  assert.ok(!JSON.stringify(list).match(/U[0-9a-f]{32}/), "一覧に外部IDを出さない");
  const dash = j(AS(STAFF.viewer, `select public.staff_dashboard();`));
  assert.ok(dash.membersActive > 5 && typeof dash.pointsIssuedThisMonth === "number" && "pendingRedeems" in dash);
  assert.ok(Number(val(`select count(*) from audit_log where action in ('list_members','view_member');`)) >= 3);
  assert.equal(j(AS(STAFF.gone, `select public.staff_whoami();`)).active, false); assert.equal(j(AS(STAFF.mgr, `select public.staff_whoami();`)).role, "manager");
  ok("一覧・検索(会員番号/氏名)・詳細・ダッシュボード: 閲覧のみでも使え、操作が監査ログに残り、外部IDは返らない");
  // 不正検知: 同じスロットに6人以上
  for (let i = 0; i < 7; i++) { const s2 = sub("w").slice(0, 31) + i; reg(s2, "来店" + i, null, "2026-09-10T00:00:00Z"); }
  for (let i = 0; i < 7; i++) SVC(`select public.app_checkin(${q(ISS)}, ${q(sub("w").slice(0, 31) + i)}, 777::bigint, now());`);
  const tv = j(AS(STAFF.viewer, `select public.staff_today_visits();`));
  assert.deepEqual(tv.suspiciousSlots.map((x) => x.slot), [777]); assert.equal(tv.suspiciousSlots[0].count, 7);
  ok("不正検知: 同じ30秒スロットに6人以上が来店記録すると『要確認』として一覧に出る");

  // ---- 整合性(ランダム操作+並列の後に、残高=台帳の合計) ----
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const people = ["a", "b", "c", "d", "e", "g", "h"].map(sub);
  for (let i = 0; i < 60; i++) {
    const who = people[Math.floor(rnd() * people.length)], day = 11 + Math.floor(rnd() * 15), op = rnd();
    const now = `2026-09-${String(day).padStart(2, "0")}T0${Math.floor(rnd() * 9)}:00:00Z`;
    try {
      if (op < 0.5) chk(who, now);
      else if (op < 0.8) { pg.exec(`delete from api_throttle;`); const res = rr(who, 100 * (1 + Math.floor(rnd() * 3)), now);
        if (res.status === "pending") { pg.exec(`update redeem_requests set expires_at = now() + interval '3 minutes' where status='pending';`);
          const id = val(`select id from redeem_requests where status='pending' and member_id=(select member_id from member_identities where subject=${q(who)});`);
          if (id) AS(STAFF.staff, `select public.${rnd() < 0.7 ? "staff_confirm_redeem" : "staff_cancel_redeem"}(${q(id)}::uuid);`); } }
      else reg(sub("rand" + i), "乱数" + i, null, now);
    } catch (e) { assert.match(String(e.message), /rate_limited|insufficient/, e.message); }
  }
  await Promise.all(people.flatMap((p) => [SVCA(`select public.app_checkin(${q(ISS)}, ${q(p)}, null, '2026-09-30T01:00:00Z');`), SVCA(`select public.app_checkin(${q(ISS)}, ${q(p)}, null, '2026-09-30T02:00:00Z');`)]));
  assert.equal(val(`select count(*) from public.verify_balances();`), "0", val(`select coalesce(json_agg(v),'[]') from public.verify_balances() v;`));
  assert.equal(Number(val(`select count(*) from members where balance < 0;`)), 0);
  assert.equal(val(`select count(*) from (select member_id from point_ledger group by member_id having bool_or(balance_after < 0)) x;`), "0");
  ok("整合性: ランダムな操作60回+並列の来店の後でも、全会員で『残高=台帳の合計』『累計=付与の合計』が一致し、マイナス残高なし");
  // 使用中のポイントは来店・登録とは独立: 使用で累計(ランク判定)は減らない
  const lastRank = j(SVC(`select public.app_me(${q(ISS)}, ${q(sub("q"))}, now());`)).member;
  assert.equal(lastRank.rank, "amber"); assert.ok(lastRank.lifetimePoints >= lastRank.points); assert.equal(lastRank.lifetimeConfirmed, false);
  ok("使用してもランクは下がらない(累計未確認でも、取り込み時の残高を累計の下限として暫定算出。既存GASと同じ『累計=max(累計, 現在残高)』)");
  // 累計の確定(業務判断が出たときだけ)。開始残高未満は拒否・1回だけ
  fails(() => SVC(`select public.confirm_lifetime_base('user00102', 5000, 'test');`), /lifetime_below_opening_balance/);
  assert.equal(j(SVC(`select public.confirm_lifetime_base('user00102', 12000, 'test 確認');`)).status, "confirmed");
  assert.equal(j(SVC(`select public.confirm_lifetime_base('user00102', 99999, 'test');`)).status, "already_confirmed");
  const fin = j(SVC(`select public.app_me(${q(ISS)}, ${q(sub("q"))}, now());`)).member; assert.equal(fin.lifetimeConfirmed, true); assert.equal(fin.lifetimePoints, 12000);
  ok("累計の確定: 開始残高未満は拒否・確定は1回だけ・確定後は確認済みとして表示(確定値で算出)");
  // 全体の新規登録の上限(1時間100人)。別の時間帯で検証
  { let limited = 0; const W = "2026-12-01T00:10:00Z";
    for (let i = 0; i < 103; i++) { try { SVC(`select public.app_register(${q(ISS)}, 'U${String(i).padStart(8, "0")}${"a".repeat(24)}', 'bulk', null, ${q(W)}::timestamptz);`); } catch (e) { if (/rate_limited/.test(e.message)) limited++; else throw e; } }
    assert.equal(limited, 3);
    assert.equal(j(SVC(`select public.app_register(${q(ISS)}, ${q(sub("a"))}, 'x', null, ${q(W)}::timestamptz);`)).status, "existing");   // 既存会員のログインは上限の影響を受けない
    assert.equal(reg(sub("9"), "別の時間帯", null, "2026-12-01T02:00:00Z").status, "created"); }
  ok("全体の新規登録は1時間100人まで(超えると rate_limited)。既存会員のログインは影響を受けず、次の時間帯には登録できる");
  console.log(`\n${n} phase1 db tests passed`);
} finally { pg.stop(); }
