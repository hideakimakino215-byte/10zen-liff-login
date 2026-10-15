// 体質チェックと会員の紐づけ(db/104_member_constitution_link.sql)を、実 PostgreSQL 16 で検証する。本番には接続しない。
// 対象: 適用/戻し・権限(関数の署名と実行権限は変わらない)、会員の詳細の体質の要約(最新の結果・日本時間の実施日・点数・今日の体調。回答と気分は返さない)、
//       会員の一覧のタイプの印、閲覧(本部)には個人の体質を返さない(キーごと)、店頭タブレット・スタッフ以外は拒否、試験運用中の絞り込み。
// 実行: node --experimental-strip-types test_member_constitution.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053";
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3",
                gone: "00000000-0000-0000-0000-0000000000d4", plain: "00000000-0000-0000-0000-0000000000e5", kiosk: "00000000-0000-0000-0000-0000000000f6" };
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
const val = (sql) => pg.exec(sql);
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const AS = (uid, sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const ANON = (sql) => pg.exec(`set role anon;\n${sql}`);
const fails = (fn, re) => { try { fn(); } catch (e) { assert.match(String(e.message), re, e.message); return; } assert.fail("expected failure " + re); };
const ts = (now) => (now === "now" ? "now()" : `${q(now)}::timestamptz`);
const reg = (s, name = "会員", now = "now") => j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, ${ts(now)});`));
const submit = (s, answers, mood = "soup", now = "now") =>
  j(SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(s)}, array[${answers.join(",")}]::integer[], ${q(mood)}, true, ${ts(now)});`));
const cond = (s, t, e, c, now = "now") => j(SVC(`select public.app_condition_submit(${q(ISS)}, ${q(s)}, ${q(t)}, ${q(e)}, ${q(c)}, ${ts(now)});`));
const midOf = (s) => val(`select member_id from member_identities where subject=${q(s)} limit 1;`);
const detail = (uid, s) => j(AS(uid, `select public.staff_member_detail(${q(midOf(s))}::uuid);`));
const list = (uid, query = null) => j(AS(uid, `select public.staff_list_members(${q(query)}, 100, 0);`));
const itemOf = (res, s) => res.items.find((x) => x.id === midOf(s));
// 五行ごとの点数を [木,火,土,金,水] で指定して回答を作る(各五行の3問に 2→1→0 の順で配る)
const ans = (w, f, e, m, wa) => [w, f, e, m, wa].flatMap((x) => { const out = []; let r = x; for (let i = 0; i < 3; i++) { const a = Math.min(2, r); out.push(a); r -= a; } return out; });
const FNS = ["staff_list_members", "staff_member_detail"];
const fnDefs = () => val(`select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any(array['${FNS.join("','")}']);`);
const privs = () => val(`select string_agg(r || ':' || p.proname || ':' || has_function_privilege(r, p.oid, 'execute')::text || ':' || pg_get_function_identity_arguments(p.oid), ',' order by r, p.proname)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join unnest(array['anon','authenticated','service_role']) r where n.nspname='public' and p.proname = any(array['${FNS.join("','")}']);`);
const STUB = `create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;
const today = () => val(`select public._jst_date(now())::text;`);
const daysAgo = (k) => new Date(Date.now() - k * 86400e3).toISOString();

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;\n${STUB}`);
  for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql"]) pg.loadFile(f);
  pg.exec(`update system_state set state='open';
    insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role, active) values ('${STAFF.mgr}','店長','manager',true),('${STAFF.staff}','スタッフ','staff',true),('${STAFF.viewer}','閲覧','viewer',true),
      ('${STAFF.gone}','退職','staff',false),('${STAFF.kiosk}','店頭','kiosk',true);`);
  const A = sub("a"), B = sub("b"), C = sub("c");
  reg(A, "会員A"); reg(B, "会員B"); reg(C, "会員C");
  submit(A, ans(1, 0, 0, 5, 2), "okayu", daysAgo(3));                                   // 金5 → うるおい不足タイプ

  // ---- 1. 適用・権限・戻し ----
  const defs103 = fnDefs(), privs103 = privs();
  const before = { mgr: detail(STAFF.mgr, A), viewer: detail(STAFF.viewer, A), list: list(STAFF.mgr) };
  assert.equal("constitution" in before.mgr, false); assert.equal("constitution" in itemOf(before.list, A), false);
  pg.loadFile("104_member_constitution_link.sql");
  assert.equal(privs(), privs103);                                                      // 署名と実行権限(authenticated だけ)は同じ
  assert.match(privs(), /authenticated:staff_member_detail:true:p_member_id uuid/); assert.match(privs(), /anon:staff_member_detail:false/); assert.match(privs(), /service_role:staff_list_members:false/);
  assert.notEqual(fnDefs(), defs103);
  // 体質以外の項目は 100 と同じ
  const after = detail(STAFF.mgr, A); const { constitution: _c, ...rest } = after;
  assert.deepEqual(rest, before.mgr); assert.ok(after.constitution);
  assert.deepEqual(detail(STAFF.viewer, A), before.viewer);                             // 閲覧は 100 と完全に同じ応答
  pg.loadFile("104_member_constitution_link_DOWN.sql");
  assert.equal(fnDefs(), defs103); assert.equal(privs(), privs103); assert.deepEqual(detail(STAFF.mgr, A), before.mgr);
  pg.loadFile("104_member_constitution_link.sql");
  assert.equal(privs(), privs103);
  ok("104 の適用: 関数の署名と実行権限は変わらない(authenticated だけ)。体質以外の応答は 100 と同じで、閲覧(本部)の応答は 100 と完全に同じ。DOWN で 100 の関数に戻り、再適用もできる");

  // ---- 2. 会員の詳細: 最新の結果の要約・日本時間の実施日・点数・今日の体調 ----
  { let d = detail(STAFF.mgr, A).constitution;
    assert.deepEqual(Object.keys(d).sort(), ["balanced", "checkedAt", "checkedOn", "primary", "scores", "today"]);
    assert.equal(d.primary, "metal"); assert.equal(d.balanced, false); assert.deepEqual(d.scores, { wood: 1, fire: 0, earth: 0, metal: 5, water: 2 }); assert.equal(d.today, null);
    const s = JSON.stringify(detail(STAFF.mgr, A)); assert.doesNotMatch(s, /answers|mood|okayu/);   // 15問の回答と食事の気分は返さない
    // 実施日は日本時間(UTC 15:00 = 日本時間の翌日 0:00)
    const D = sub("d"); reg(D, "会員D"); submit(D, ans(0, 6, 0, 0, 0), "soup", "2026-09-30T15:00:00Z");
    const dd = detail(STAFF.mgr, D).constitution;
    assert.equal(dd.checkedOn, "2026-10-01"); assert.equal(Date.parse(dd.checkedAt), Date.parse("2026-09-30T15:00:00Z")); assert.equal(dd.primary, "fire");
    submit(A, ans(0, 6, 0, 0, 0), "soup", "2026-09-30T15:00:00Z");
    assert.equal(detail(STAFF.mgr, A).constitution.primary, "metal");                      // 最新は日時の新しいもの(3日前の金)。古い日時の結果は最新にならない
    submit(A, ans(0, 0, 0, 0, 1), "soup", daysAgo(2));                                      // 全部1点以下 → バランス良好(主な五行も返す)
    d = detail(STAFF.mgr, A).constitution; assert.equal(d.balanced, true); assert.ok(["wood", "fire", "earth", "metal", "water"].includes(d.primary));
    submit(A, ans(0, 0, 0, 0, 4), "soup", daysAgo(1));                                      // 水4
    // 昨日の今日の体調は出さない・今日の分だけ出す
    assert.equal(cond(A, "hot", "fine", "none", daysAgo(1)).status, "ok");
    d = detail(STAFF.mgr, A).constitution; assert.equal(d.primary, "water"); assert.equal(d.today, null);
    assert.equal(cond(A, "cold", "tired", "dry").status, "ok");
    d = detail(STAFF.staff, A).constitution;
    assert.deepEqual(d.today, { temp: "cold", energy: "tired", concern: "dry", focus: "water" });   // 水4+2=6 > 土2・金2
    assert.equal(d.checkedOn, val(`select public._jst_date(${q(daysAgo(1))}::timestamptz)::text;`));
    assert.deepEqual(detail(STAFF.mgr, A).constitution, d);                                 // 店長とスタッフは同じ
    // 未実施は null
    assert.equal(detail(STAFF.mgr, B).constitution, null); assert.equal("constitution" in detail(STAFF.mgr, B), true);
    assert.equal(detail(STAFF.staff, B).constitution, null); }
  ok("会員の詳細(店長・スタッフ): 最新の体質チェックの要約(主な五行・バランス良好・五行ごとの点数・日時と日本時間の実施日)と、日本時間の今日の「今日の体調」(からだ・調子・気になること・今日のおすすめの五行。昨日の分は出さない)。未実施は null。15問の回答と食事の気分は返さない");

  // ---- 3. 会員の一覧: タイプの印 ----
  { submit(C, ans(0, 0, 0, 0, 0), "soup");
    for (const uid of [STAFF.mgr, STAFF.staff]) {
      const r = list(uid);
      assert.deepEqual(itemOf(r, A).constitution, { primary: "water", balanced: false });
      assert.equal(itemOf(r, B).constitution, null); assert.equal("constitution" in itemOf(r, B), true);
      assert.equal(itemOf(r, C).constitution.balanced, true);
      assert.doesNotMatch(JSON.stringify(r), /answers|mood|scores|today/);                  // 一覧はタイプだけ
      assert.deepEqual(Object.keys(itemOf(r, A)).sort(), ["constitution", "displayName", "id", "lastActivityOn", "memberNo", "points", "rank", "status"]);
    }
    const r = list(STAFF.mgr, "会員A"); assert.equal(r.total, 1); assert.equal(r.items[0].constitution.primary, "water"); }
  ok("会員の一覧(店長・スタッフ): 各行にタイプの印(主な五行・バランス良好)。未実施は null。点数・回答・気分・今日の体調は一覧に含めない。検索・件数は従来どおり");

  // ---- 4. 閲覧(本部)には個人の体質を返さない・店頭タブレットとスタッフ以外は拒否 ----
  { const v = detail(STAFF.viewer, A);
    assert.equal(v.status, "ok"); assert.equal("constitution" in v, false); assert.deepEqual(Object.keys(v).sort(), ["ledger", "member", "status"]);
    assert.doesNotMatch(JSON.stringify(v), /constitution|primary|balanced|scores|today|water/);
    const vl = list(STAFF.viewer);
    assert.ok(vl.items.length >= 3); for (const it of vl.items) assert.equal("constitution" in it, false);
    assert.doesNotMatch(JSON.stringify(vl), /constitution|primary|balanced/);
    assert.equal(j(AS(STAFF.viewer, `select public.staff_constitution_stats();`)).scope, "full");     // 集計は 103 のまま見られる
    for (const [uid, re] of [[STAFF.kiosk, /forbidden/], [STAFF.plain, /not_staff/], [STAFF.gone, /not_staff/]]) {
      fails(() => detail(uid, A), re); fails(() => list(uid), re); }
    fails(() => ANON(`select public.staff_member_detail(${q(midOf(A))}::uuid);`), /permission denied/);
    fails(() => SVC(`select public.staff_list_members(null, 10, 0);`), /permission denied/);
    // 監査ログ(閲覧の記録)は従来どおり
    const k = Number(val(`select count(*) from audit_log where action='view_member' and target_member_id=${q(midOf(A))};`)); detail(STAFF.staff, A);
    assert.equal(Number(val(`select count(*) from audit_log where action='view_member' and target_member_id=${q(midOf(A))};`)), k + 1); }
  ok("閲覧(本部)には、会員の詳細・一覧とも個人の体質の情報をキーごと返さない(集計は従来どおり見られる)。店頭タブレット・スタッフ以外・無効のアカウント・未ログイン・service_role は拒否。閲覧の記録(監査ログ)は従来どおり");

  // ---- 5. 試験運用中: 試験会員だけ(体質も試験会員の分だけ) ----
  { val(`update system_state set state='test';`);
    const T = sub("t"); SVC(`select public.allow_test_identity(${q(ISS)}, ${q(T)}, 'test');`); reg(T, "試験T"); submit(T, ans(0, 0, 6, 0, 0), "soup");
    const r = list(STAFF.mgr); assert.equal(r.total, 1); assert.deepEqual(r.items[0].constitution, { primary: "earth", balanced: false });
    assert.equal(detail(STAFF.mgr, A).status, "not_found");                                 // 本番会員は試験運用中は見えない(従来どおり)
    assert.equal(detail(STAFF.mgr, T).constitution.primary, "earth"); assert.equal("constitution" in detail(STAFF.viewer, T), false);
    val(`update system_state set state='open';`);
    assert.equal(list(STAFF.mgr).items.some((x) => x.id === midOf(T)), false); }
  ok("試験運用中は試験会員だけを一覧・詳細に出す(従来どおり)。体質の情報も同じ範囲で、閲覧には返さない");
  console.log(`\n${n} member-constitution tests passed`);
} finally { pg.stop(); }
