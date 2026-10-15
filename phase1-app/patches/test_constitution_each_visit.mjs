// 体質チェックを来店のたびに(任意・スキップ可)へ(db/107_constitution_each_visit.sql)を、実 PostgreSQL 16 で検証する。本番には接続しない。データはすべて擬似。
// 対象: 適用/戻し・権限、あなたの体質(最新3回の平均。3回未満・同点と季節・バランス良好)、これまでのチェック(新しい順・6回まで)と今日チェックしたか(日本時間)、
//       スタッフの集計(今週のチェック結果の傾向・スタッフは week だけ・来店時の実施率)、日本時間の境目、目標と KPI の補助の数字、会員の詳細と一覧、月次レポート。
// 実行: node --experimental-strip-types test_constitution_each_visit.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053";
const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3",
                kiosk: "00000000-0000-0000-0000-0000000000f6" };
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
const val = (sql) => pg.exec(sql);
const cnt = (sql) => Number(val(sql));
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const AS = (uid, sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const fails = (fn, re) => { try { fn(); } catch (e) { assert.match(String(e.message), re, e.message); return; } assert.fail("expected failure " + re); };
const ts = (now) => (now === "now" ? "now()" : `${q(now)}::timestamptz`);
let seq = 0; const nextSub = () => "U" + String(++seq).padStart(32, "0");
const reg = (s, name, now = "now") => j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, ${ts(now)});`));
const me = (s, now = "now") => j(SVC(`select public.app_me(${q(ISS)}, ${q(s)}, ${ts(now)});`)).member;
const submit = (s, answers, now = "now", mood = "soup") =>
  j(SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(s)}, array[${answers.join(",")}]::integer[], ${q(mood)}, true, ${ts(now)});`));
const midOf = (s) => val(`select member_id from member_identities where subject=${q(s)} limit 1;`);
const visit = (s, day) => val(`insert into visits(member_id, visit_on, source) values (${q(midOf(s))}, ${day}, 'store_qr');`);
const stats = (uid) => j(AS(uid, `select public.staff_constitution_stats();`));
const detail = (uid, s) => j(AS(uid, `select public.staff_member_detail(${q(midOf(s))}::uuid);`));
const list = (uid) => j(AS(uid, `select public.staff_list_members(null, 100, 0);`));
const itemOf = (res, s) => res.items.find((x) => x.id === midOf(s));
// 五行ごとの点数を [木,火,土,金,水] で指定して回答を作る(各五行の3問に 2→1→0 の順で配る)
const ans = (w, f, e, m, wa) => [w, f, e, m, wa].flatMap((x) => { const out = []; let r = x; for (let i = 0; i < 3; i++) { const a = Math.min(2, r); out.push(a); r -= a; } return out; });
const ZERO = ans(0, 0, 0, 0, 0);
const sc = (wood, fire, earth, metal, water) => ({ wood, fire, earth, metal, water });
const STUB = `create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;
const BEFORE = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql", "106_referral.sql"];
const REPLACED = ["_constitution_snapshot", "app_constitution_submit", "staff_constitution_stats", "staff_list_members", "staff_member_detail", "staff_kpi_overview", "report_monthly"];
const NEW = ["_cc_avg_result(integer[],integer,text)", "_cc_profile(uuid)", "_cc_history(uuid,integer)", "_cc_check_dist(boolean,timestamptz,timestamptz)", "_visit_check_rate(boolean,date,date)", "_kpi_with_visit_check(jsonb,boolean)"];
const arrIn = (xs) => `array['${xs.join("','")}']`;
const fnDefs = () => val(`select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any(${arrIn(REPLACED)});`);
const privs = () => val(`select string_agg(r || ':' || p.proname || ':' || has_function_privilege(r, p.oid, 'execute')::text || ':' || pg_get_function_identity_arguments(p.oid), ',' order by r, p.proname)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join unnest(array['anon','authenticated','service_role']) r where n.nspname='public' and p.proname = any(${arrIn(REPLACED)});`);
const ex = (r, sig) => val(`select has_function_privilege('${r}', 'public.${sig}', 'execute');`);

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;\n${STUB}`);
  for (const f of BEFORE) pg.loadFile(f);
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit';
    insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role, active) values ('${STAFF.mgr}','店長','manager',true),('${STAFF.staff}','スタッフ','staff',true),('${STAFF.viewer}','閲覧','viewer',true),('${STAFF.kiosk}','店頭','kiosk',true);`);

  // ---- 1. 適用・権限・戻し ----
  { const defs106 = fnDefs(), privs106 = privs(), rels = () => cnt(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public';`), rels106 = rels();
    const S0 = nextSub(); reg(S0, "戻しの確認", "2026-10-01T03:00:00Z"); submit(S0, ans(3, 0, 0, 0, 0), "2026-10-01T03:00:00Z");
    const me106 = me(S0, "2026-10-01T04:00:00Z");
    assert.equal("constitutionProfile" in me106, false);
    pg.loadFile("107_constitution_each_visit.sql");
    assert.notEqual(fnDefs(), defs106); assert.equal(privs(), privs106); assert.equal(rels(), rels106);                   // 署名と権限はそのまま・新しい表はない
    for (const sig of NEW) for (const r of ["anon", "authenticated", "service_role"]) assert.equal(ex(r, sig), "f", `${r} ${sig}`);
    assert.equal(ex("service_role", "app_condition_submit(text,text,text,text,text,timestamptz)"), "t");                    // 非推奨だが互換のために残す
    assert.match(val(`select obj_description('public.constitution_daily_conditions'::regclass, 'pg_class');`), /^非推奨/);
    assert.match(val(`select obj_description('public.app_condition_submit(text,text,text,text,text,timestamptz)'::regprocedure, 'pg_proc');`), /^非推奨/);
    pg.loadFile("107_constitution_each_visit_DOWN.sql");
    assert.equal(fnDefs(), defs106); assert.equal(privs(), privs106); assert.equal(rels(), rels106);
    assert.equal(cnt(`select count(*) from pg_proc where proname = any(array['_cc_avg_result','_cc_profile','_cc_history','_cc_check_dist','_visit_check_rate','_kpi_with_visit_check']);`), 0);
    assert.equal(val(`select coalesce(obj_description('public.constitution_daily_conditions'::regclass, 'pg_class'), 'null');`), "null");
    assert.deepEqual(me(S0, "2026-10-01T04:00:00Z"), me106);
    pg.loadFile("107_constitution_each_visit.sql");
    assert.equal(privs(), privs106); }
  ok("107 の適用: 置き換えた7つの関数の署名と権限はそのまま、新しい表はなく、足した内部関数は誰からも直接呼べない。今日の体調の表と関数は非推奨の注記つきで残る(互換)。DOWN で 106 の関数と会員証の応答に戻り、再適用もできる");

  // ---- 2. あなたの体質(最新3回の平均) ----
  const A = nextSub(); reg(A, "平均 一郎", "2026-09-01T03:00:00Z");
  let r = submit(A, ans(5, 0, 0, 1, 0), "2026-10-01T03:00:00Z");                                       // JST 10/1(秋=金)
  assert.deepEqual(r.profile, { count: 1, scores: sc(5, 0, 0, 1, 0), primary: "wood", balanced: false, latestOn: "2026-10-01", oldestOn: "2026-10-01" });
  let m = me(A, "2026-10-01T04:00:00Z");
  assert.deepEqual(m.constitutionProfile, r.profile); assert.equal(m.yourTea, "wood"); assert.equal(m.constitution.primary, "wood");   // 1回なら今日の傾向と同じ
  r = submit(A, ans(0, 0, 0, 4, 0), "2026-10-02T03:00:00Z");                                           // 合計 木5・金5 → 平均 2.5 で同点 → 最新の回の季節(金)
  assert.deepEqual(r.profile.scores, sc(2.5, 0, 0, 2.5, 0)); assert.equal(r.profile.primary, "metal"); assert.equal(r.profile.count, 2);
  assert.equal(me(A, "2026-12-15T03:00:00Z").constitutionProfile.primary, "metal");                    // 見る日が冬(水)でも、同点は平均に入れた最新の回の季節で決める
  r = submit(A, ZERO, "2026-10-25T03:00:00Z");                                                         // JST 10/25 は土用(土)。同点(木・金)に土はない → 木・火…の順で木
  assert.deepEqual(r.profile, { count: 3, scores: sc(1.67, 0, 0, 1.67, 0), primary: "wood", balanced: false, latestOn: "2026-10-25", oldestOn: "2026-10-01" });
  r = submit(A, ZERO, "2026-10-26T03:00:00Z");                                                         // 最新3回 = 10/2・10/25・10/26 → 金 4/3
  assert.deepEqual(r.profile, { count: 3, scores: sc(0, 0, 0, 1.33, 0), primary: "metal", balanced: false, latestOn: "2026-10-26", oldestOn: "2026-10-02" });
  r = submit(A, ZERO, "2026-10-27T03:00:00Z");                                                         // 最新3回が全部0点 → バランス良好。主な五行は全部同点 → 季節(土用=土)
  assert.deepEqual(r.profile, { count: 3, scores: sc(0, 0, 0, 0, 0), primary: "earth", balanced: true, latestOn: "2026-10-27", oldestOn: "2026-10-25" });
  assert.equal(me(A, "2026-10-27T04:00:00Z").yourTea, "earth");
  const B = nextSub(); reg(B, "平均 二郎", "2026-09-01T03:00:00Z");
  assert.equal(submit(B, ans(2, 0, 0, 0, 0), "2026-10-03T03:00:00Z").profile.balanced, false);         // 1回目は木2 → バランス良好ではない
  r = submit(B, ZERO, "2026-10-04T03:00:00Z"); assert.deepEqual(r.profile.scores, sc(1, 0, 0, 0, 0)); assert.equal(r.profile.balanced, true);   // 平均がちょうど1点 → バランス良好(1点以下)
  assert.equal(r.result.balanced, true); assert.equal(r.profile.primary, "wood");
  r = submit(B, ZERO, "2026-10-05T03:00:00Z"); assert.deepEqual(r.profile.scores, sc(0.67, 0, 0, 0, 0)); assert.equal(r.profile.balanced, true);
  assert.equal(me(B, "2026-10-05T04:00:00Z").constitution.balanced, true);
  // 純粋関数の入力の検査
  for (const x of [`array[1,2,3,4,5], 0, 'wood'`, `null, 1, 'wood'`, `array[1,2,3,4], 1, 'wood'`, `array[1,2,null,4,5], 1, 'wood'`, `array[1,2,3,4,5], null, 'wood'`])
    assert.equal(val(`select coalesce(public._cc_avg_result(${x})::text, 'null');`), "null", x);
  assert.equal(j(val(`select public._cc_avg_result(array[3,3,3,3,3], 3, 'fire');`)).primary, "fire");
  assert.equal(val(`select coalesce(public._cc_profile('00000000-0000-0000-0000-000000000000'::uuid)::text, 'null');`), "null");
  ok("あなたの体質: 最新の3回(3回未満ならその回数)の五行ごとの平均(小数2桁)。同点は平均に入れた最新の回の季節の五行(見る日の季節ではない)、季節が同点になければ木・火・土・金・水の順。平均がすべて1点以下(ちょうど1点を含む)はバランス良好。4回目からは古い回が外れる。あなたの五巡茶はあなたの体質の五行。送信の応答にも profile");

  // ---- 3. これまでのチェック(新しい順・6回まで)と、今日チェックしたか(日本時間) ----
  for (const d of ["2026-10-28", "2026-10-29", "2026-10-30"]) submit(A, ans(0, 6, 0, 0, 0), `${d}T03:00:00Z`);
  m = me(A, "2026-10-30T04:00:00Z");
  assert.equal(cnt(`select count(*) from constitution_checks where member_id=${q(midOf(A))};`), 8);
  assert.deepEqual(m.constitutionHistory.map((h) => h.checkedOn), ["2026-10-30", "2026-10-29", "2026-10-28", "2026-10-27", "2026-10-26", "2026-10-25"]);
  assert.deepEqual(m.constitutionHistory.map((h) => h.primary), ["fire", "fire", "fire", "earth", "earth", "earth"]);   // 0点の回は全部同点 → その日の季節(土用=土)
  assert.deepEqual(m.constitutionHistory[0], { checkedAt: m.constitution.checkedAt, checkedOn: "2026-10-30", primary: "fire", balanced: false, scores: sc(0, 6, 0, 0, 0) });
  for (const h of m.constitutionHistory) assert.deepEqual(Object.keys(h).sort(), ["balanced", "checkedAt", "checkedOn", "primary", "scores"]);   // 回答・食事の気分は含めない
  assert.equal(m.constitutionProfile.primary, "fire"); assert.deepEqual(m.constitutionProfile.scores, sc(0, 6, 0, 0, 0));
  assert.equal(m.constitution.checkedToday, true); assert.equal(me(A, "2026-10-31T03:00:00Z").constitution.checkedToday, false);
  const C = nextSub(); reg(C, "日付 三郎", "2026-09-01T03:00:00Z");
  assert.deepEqual(me(C, "2026-10-15T15:00:00Z").constitutionHistory, []); assert.equal(me(C, "2026-10-15T15:00:00Z").constitutionProfile, null);
  submit(C, ans(0, 0, 0, 0, 4), "2026-10-15T15:30:00Z");                                               // JST 10/16 0:30(UTC ではまだ 10/15)
  assert.equal(me(C, "2026-10-15T15:00:00Z").constitution.checkedToday, true);                          // JST 10/16 0:00 → 今日
  assert.equal(me(C, "2026-10-15T14:59:59Z").constitution.checkedToday, false);                         // JST 10/15 23:59:59 → 今日ではない
  assert.equal(me(C, "2026-10-16T14:59:59Z").constitution.checkedToday, true); assert.equal(me(C, "2026-10-16T15:00:00Z").constitution.checkedToday, false);
  assert.equal(me(C, "2026-10-16T03:00:00Z").constitutionHistory[0].checkedOn, "2026-10-16");
  ok("これまでのチェック: 新しい順に6回まで(日付は日本時間・主な五行・バランス良好・点数。回答と気分は含めない)。checkedToday は日本時間のその日にチェックがあるか(UTC の日付ではない)。未実施は空の履歴とあなたの体質 null");

  // ---- 4. スタッフの集計: 今週のチェック結果の傾向(スタッフは week だけ)・来店時の実施率(今月)。今日の体調(非推奨)は数えない ----
  { val(`update system_state set state='test';`);
    const T = [nextSub(), nextSub(), nextSub(), nextSub()];
    for (const s of T) SVC(`select public.allow_test_identity(${q(ISS)}, ${q(s)}, 'test');`);
    T.forEach((s, i) => reg(s, `試験${i + 1}`));
    const daysAgo = (k) => new Date(Date.now() - k * 86400e3).toISOString();
    const zero = stats(STAFF.mgr);
    assert.deepEqual(zero.week.byType, { wood: 0, fire: 0, earth: 0, metal: 0, water: 0, balanced: 0 }); assert.equal(zero.week.checks, 0);
    assert.equal(zero.visitCheckRate.visitDays, 0); assert.equal(zero.visitCheckRate.ratePercent, null);
    submit(T[0], ans(6, 0, 0, 0, 0), "now"); submit(T[0], ans(0, 6, 0, 0, 0), daysAgo(3));              // T1: 今日と3日前
    submit(T[1], ZERO, daysAgo(6));                                                                     // T2: 6日前(今週に入る)・バランス良好
    submit(T[2], ans(0, 0, 0, 0, 6), daysAgo(8));                                                       // T3: 8日前(今週に入らない)
    submit(T[3], ans(0, 0, 3, 0, 0), daysAgo(40));                                                      // T4: 40日前(先月以前)
    assert.equal(j(SVC(`select public.app_condition_submit(${q(ISS)}, ${q(T[0])}, 'cold', 'tired', 'dry', now());`)).status, "ok");   // 非推奨だが互換のため動く
    assert.ok(me(T[0]).todayCondition);
    const today = val(`select public._jst_date(now())::text;`);
    visit(T[0], `${q(today)}::date`); visit(T[1], `${q(today)}::date`); visit(T[2], `${q(today)}::date`);     // 今日の来店: T1 は今日チェック済み・T2 と T3 はしていない
    visit(T[3], `public._jst_date(${ts(daysAgo(40))})`);                                                // T4: 40日前の来店(同じ日にチェック)は今月ではない
    const st = stats(STAFF.mgr), sv = stats(STAFF.viewer), ss = stats(STAFF.staff);
    assert.deepEqual(st.week, { since: val(`select (public._jst_date(now()) - 6)::text;`), until: today, checks: 3, members: 2,
      byType: { wood: 1, fire: 1, earth: 0, metal: 0, water: 0, balanced: 1 } });
    assert.deepEqual(ss.week, st.week); assert.deepEqual(sv.week, st.week);
    assert.equal(ss.scope, "limited"); assert.deepEqual(Object.keys(ss).sort(), ["asOf", "scope", "week"]);
    assert.doesNotMatch(JSON.stringify(st), /"answers"|"temp"|"energy"|"concern"|"focus"/);              // 今日の体調は集計に出さない
    assert.deepEqual(st.visitCheckRate, { month: today.slice(0, 7), from: `${today.slice(0, 7)}-01`, to: today, visitDays: 3, checkedVisitDays: 1, ratePercent: 33.3 });
    assert.deepEqual(sv.visitCheckRate, st.visitCheckRate);
    for (const k of ["visitCheckRate", "byType", "averages", "revisit", "referralClicks", "checkedMembers"]) assert.equal(k in ss, false, k);
    assert.equal(st.checkedMembers, 4); assert.equal(st.membersActive, 4);                             // 103 の数字はそのまま
    fails(() => stats(STAFF.kiosk), /forbidden/); fails(() => SVC(`select public.staff_constitution_stats();`), /permission denied/);
    val(`update system_state set state='open';`);
    const live = stats(STAFF.mgr);                                                                      // 本番の数字に試験会員は混ざらない
    assert.equal(live.week.checks, cnt(`select count(*) from constitution_checks c join members m on m.id=c.member_id where not m.is_test and c.created_at >= ((public._jst_date(now()) - 6)::timestamp at time zone 'Asia/Tokyo')
      and c.created_at < ((public._jst_date(now()) + 1)::timestamp at time zone 'Asia/Tokyo');`));
    assert.equal(live.visitCheckRate.visitDays, cnt(`select count(*) from visits v join members m on m.id=v.member_id where not m.is_test and v.visit_on between date_trunc('month', public._jst_date(now()))::date and public._jst_date(now());`)); }
  ok("スタッフの集計: 今週のチェック結果の傾向=直近7日(日本時間・今日を含む)のチェック1回ずつのタイプの分布と回数・人数。スタッフは week だけで、店長・閲覧と同じ数字。店長・閲覧には今月の来店時の実施率(会員の来店日のうち同じ日にチェックした日)。今日の体調(非推奨。関数は互換のため動く)は集計に出さない。試験運用中は試験会員だけ");

  // ---- 5. 来店時の実施率の日本時間の境目と、目標と KPI の補助の数字 ----
  const D = nextSub(), E = nextSub(), F = nextSub();
  reg(D, "来店 四郎", "2026-08-01T03:00:00Z"); reg(E, "来店 五郎", "2026-08-01T03:00:00Z"); reg(F, "来店 六郎", "2026-08-01T03:00:00Z");
  val(`update members set created_at='2026-08-01T03:00:00Z' where id in (${[D, E, F].map((x) => q(midOf(x))).join(",")});`);   // 登録の日時(擬似。月次レポートの「月末までに登録した会員」に入れる)
  visit(D, `'2026-09-10'`); visit(E, `'2026-09-10'`); visit(F, `'2026-09-12'`);
  submit(D, ans(0, 0, 0, 0, 5), "2026-09-09T15:00:00Z");                                               // JST 9/10 0:00 → 来店日と同じ日
  submit(E, ans(0, 5, 0, 0, 0), "2026-09-10T15:00:00Z");                                               // JST 9/11 0:00 → 来店日の翌日(数えない)
  submit(F, ZERO, "2026-09-12T14:59:59Z");                                                             // JST 9/12 23:59:59 → 同じ日
  submit(D, ans(5, 0, 0, 0, 0), "2026-08-31T15:00:00Z");                                               // JST 9/1(月の初め)
  submit(D, ans(0, 0, 5, 0, 0), "2026-08-31T14:59:59Z"); submit(E, ans(0, 0, 5, 0, 0), "2026-09-30T15:00:00Z");   // JST 8/31・10/1(9月に入らない)
  assert.equal(j(SVC(`select public.app_condition_submit(${q(ISS)}, ${q(D)}, 'hot', 'fine', 'none', '2026-09-10T03:00:00Z'::timestamptz);`)).status, "ok");
  const vr = j(val(`select public._visit_check_rate(false, '2026-09-01', '2026-09-30');`));
  assert.deepEqual(vr, { from: "2026-09-01", to: "2026-09-30", visitDays: 3, checkedVisitDays: 2, ratePercent: 66.7 });
  assert.equal(j(val(`select public._visit_check_rate(false, '2026-09-11', '2026-09-30');`)).ratePercent, 100);
  assert.equal(j(val(`select public._visit_check_rate(true, '2026-09-01', '2026-09-30');`)).visitDays,                  // 試験会員の区分は別(上の試験会員の来店だけ)
    cnt(`select count(*) from visits v join members m on m.id=v.member_id where m.is_test and v.visit_on between '2026-09-01' and '2026-09-30';`));
  const ov = j(val(`select public._kpi_with_visit_check(public._kpi_with_referral(public._kpi_overview(false, 2, '2026-09-30T14:59:59Z'::timestamptz), false), false);`));
  const sep = ov.months[1]; assert.equal(sep.month, "2026-09");
  assert.deepEqual([sep.supporting.visitDays, sep.supporting.checkedVisitDays, sep.supporting.visitCheckRatePercent], [3, 2, 66.7]);
  assert.ok("referralRegistrations" in sep.supporting && "seasonRecheckPercent" in sep.supporting && "activeMembers" in sep.supporting);   // 105・106 の補助の数字はそのまま
  assert.equal(ov.months[0].supporting.visitCheckRatePercent, null); assert.equal(ov.months[0].supporting.visitDays, 0);   // 8月は来店なし → 率は null
  const live = j(AS(STAFF.mgr, `select public.staff_kpi_overview(13);`));
  assert.equal(live.months.length, 13); assert.equal(live.canEdit, true);
  for (const mo of live.months) {
    const ref = j(val(`select public._visit_check_rate(false, ${q(mo.from)}::date, ${q(mo.asOfDate)}::date);`));
    assert.deepEqual([mo.supporting.visitDays, mo.supporting.checkedVisitDays, mo.supporting.visitCheckRatePercent], [ref.visitDays, ref.checkedVisitDays, ref.ratePercent], mo.month);
  }
  assert.deepEqual(j(AS(STAFF.viewer, `select public.staff_kpi_overview(2);`)).months.map((x) => x.supporting.visitDays), live.months.slice(-2).map((x) => x.supporting.visitDays));
  fails(() => AS(STAFF.staff, `select public.staff_kpi_overview(2);`), /forbidden/);
  ok("来店時の実施率: 会員の来店日(1会員1日1行)のうち、日本時間の同じ日にその会員のチェックがある日の割合(JST 0:00 と 23:59:59 は同じ日・翌日 0:00 は数えない)。目標と KPI の各月の補助の数字に visitDays・checkedVisitDays・visitCheckRatePercent(来店なしは null)。105・106 の数字はそのまま。スタッフは従来どおり拒否");

  // ---- 6. 会員の詳細と一覧(店長・スタッフ): 最新の結果・今日チェックしたか・あなたの体質。今日の体調は返さない。閲覧には返さない ----
  { const G = nextSub(), H = nextSub(), N = nextSub();
    reg(G, "詳細 七郎", "2026-09-01T03:00:00Z"); reg(H, "詳細 八郎", "2026-09-01T03:00:00Z"); reg(N, "未実施 九郎", "2026-09-01T03:00:00Z");
    submit(G, ans(0, 0, 0, 6, 0), "2026-10-01T03:00:00Z"); submit(G, ans(0, 0, 0, 6, 0), "2026-10-02T03:00:00Z"); submit(G, ans(6, 0, 0, 0, 0), "2026-10-03T03:00:00Z");
    submit(H, ans(0, 0, 4, 0, 0), "now");
    j(SVC(`select public.app_condition_submit(${q(ISS)}, ${q(H)}, 'cold', 'fine', 'none', now());`));
    for (const uid of [STAFF.mgr, STAFF.staff]) {
      const g = detail(uid, G).constitution;
      assert.deepEqual(Object.keys(g).sort(), ["balanced", "checkedAt", "checkedOn", "checkedToday", "primary", "profile", "scores"]);
      assert.equal(g.primary, "wood"); assert.equal(g.checkedOn, "2026-10-03"); assert.equal(g.checkedToday, false);           // 最新の結果(今日の傾向に使う)
      assert.deepEqual(g.profile, { count: 3, scores: sc(2, 0, 0, 4, 0), primary: "metal", balanced: false, latestOn: "2026-10-03", oldestOn: "2026-10-01" });
      const h = detail(uid, H).constitution; assert.equal(h.checkedToday, true); assert.equal(h.primary, "earth"); assert.equal("today" in h, false);   // 今日の体調は返さない
      assert.equal(detail(uid, N).constitution, null);
      const ls = list(uid);
      assert.deepEqual(itemOf(ls, G).constitution, { primary: "metal", balanced: false });                                       // 一覧の印は「あなたの体質」
      assert.deepEqual(itemOf(ls, B).constitution, { primary: "wood", balanced: true }); assert.equal(itemOf(ls, N).constitution, null);
    }
    assert.equal("constitution" in detail(STAFF.viewer, G), false); assert.ok(list(STAFF.viewer).items.every((x) => !("constitution" in x)));
    assert.doesNotMatch(JSON.stringify(detail(STAFF.mgr, G)), /"answers"|"mood"|"temp"/);
    fails(() => detail(STAFF.kiosk, G), /forbidden/); }
  ok("会員の詳細(店長・スタッフ): 最新の結果(主な五行・点数・日本時間の実施日)と今日チェックしたか(checkedToday)、あなたの体質(最新3回の平均)。今日の体調・回答・気分は返さない。一覧の印はあなたの体質。閲覧(本部)には返さず、店頭タブレットは拒否");

  // ---- 7. 月次レポート: チェック結果の傾向と来店時の実施率(今日の体調は外す) ----
  { val(`update kpi_settings set launch_date='2026-09-01';`);
    const rep = j(SVC(`select public.report_monthly('2026-09', '2026-10-15T00:00:00Z'::timestamptz);`));
    assert.equal(rep.skipped, false); assert.equal("conditions" in rep.constitution, false);
    assert.deepEqual(rep.constitution.checkResults, { checks: 4, members: 3, byType: { wood: 1, fire: 1, earth: 0, metal: 0, water: 1, balanced: 1 } });   // D 9/1 木・D 9/10 水・E 9/11 火・F 9/12 バランス良好
    assert.equal(rep.constitution.checkResults.checks, rep.constitution.checksInMonth);
    assert.deepEqual(rep.constitution.visitCheckRate, { visitDays: 3, checkedVisitDays: 2, ratePercent: 66.7 });
    assert.deepEqual(Object.keys(rep.constitution).sort(), ["byType", "checkRatePercent", "checkResults", "checkedMembers", "checksInMonth", "visitCheckRate"]);
    for (const k of ["kpis", "pos", "members", "tickets"]) assert.ok(k in rep, k);                                            // 106 のほかの項目はそのまま
    assert.doesNotMatch(JSON.stringify(rep), /U0{20}|user\d{5}|来店 四郎/);                                                     // 個人の情報は含めない
    const oct = j(SVC(`select public.report_monthly('2026-10', '2026-11-01T00:00:00Z'::timestamptz);`));
    assert.equal(oct.constitution.checkResults.checks, cnt(`select count(*) from constitution_checks c join members m on m.id=c.member_id where not m.is_test
      and c.created_at >= '2026-09-30T15:00:00Z' and c.created_at < '2026-10-31T15:00:00Z';`));
    fails(() => AS(STAFF.mgr, `select public.report_monthly('2026-09');`), /permission denied/); }
  ok("月次レポート: 今日の体調(conditions)を外し、その月のチェック結果の傾向(チェックの回数・人数・1回ずつのタイプの分布。日本時間の月の境目)と来店時の実施率(目標と KPI と同じ数字)を足す。ほかの項目と権限(service_role だけ)は 106 のまま");
  console.log(`\n${n} constitution-each-visit tests passed`);
} finally { pg.stop(); }
