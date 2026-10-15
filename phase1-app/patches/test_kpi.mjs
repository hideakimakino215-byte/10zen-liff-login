// 目標と KPI(db/105_kpi.sql)を、実 PostgreSQL 16 で検証する。本番には接続しない。データはすべて擬似(実在の売上・客数・会員ではない)。
// 対象: 適用/戻し・権限、4つの KPI の計算(会員来店率・新規登録・体質チェック実施率と季節の再チェック・再来店率・送客)と日本時間の月の境目、
//       レジの客数(日別の合計・取り込んだ日の来店だけで割る・月の手入力・未取り込み)、目標の段階(3・6・12か月)と達成率(数の今月分は日割り)、
//       権限(店長は変更と閲覧・閲覧は見るだけ・スタッフと店頭タブレットは拒否)、取り込みの検証・上書き・監査ログ、試験運用中の分離、バックアップ/復元。
// 実行: node --experimental-strip-types test_kpi.mjs
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
// 登録(app_register は登録日時を created_at = now() で記録するので、擬似データでは登録の日時に合わせて書き換える)
const reg = (s, name, now) => { const r = j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, ${ts(now)});`));
  val(`update members set created_at = ${ts(now)} where id = (select member_id from member_identities where subject=${q(s)});`); return r; };
const submit = (s, answers, now) => j(SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(s)}, array[${answers.join(",")}]::integer[], 'soup', true, ${ts(now)});`));
const click = (s, now) => j(SVC(`select public.app_referral_click(${q(ISS)}, ${q(s)}, ${ts(now)});`));
const midOf = (s) => val(`select member_id from member_identities where subject=${q(s)} limit 1;`);
const visit = (s, d) => val(`insert into visits(member_id, visit_on, source) values (${q(midOf(s))}, ${q(d)}, 'store_qr');`);
const cnt = (sql) => Number(val(sql));
const ans = (w, f, e, m, wa) => [w, f, e, m, wa].flatMap((x) => { const out = []; let r = x; for (let i = 0; i < 3; i++) { const a = Math.min(2, r); out.push(a); r -= a; } return out; });
// 基準の時刻を固定して月ごとの KPI を取る(内部関数。staff_kpi_overview は now() で同じものを返す)
const NOW = "2026-09-20T03:00:00Z";                                                            // 日本時間 2026-09-20 12:00
const ov = (months = 3, now = NOW, tst = false, db = null) => { const sql = `select public._kpi_overview(${tst}, ${months}, ${q(now)}::timestamptz);`; return j(db ? pg.execIn(db, sql) : val(sql)); };
const month = (o, m) => o.months.find((x) => x.month === m);
const overview = (uid, months = 13) => j(AS(uid, `select public.staff_kpi_overview(${months});`));
const imp = (uid, rows, source = "pos.csv") => j(AS(uid, `select public.manager_import_pos_customers(${q(JSON.stringify(rows))}::jsonb, ${q(source)});`));
const STUB = `create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;
const TABLES = ["kpi_settings", "kpi_targets", "pos_daily_customers", "pos_monthly_customers"];
const FNS = ["staff_kpi_overview(integer)", "manager_set_launch_date(date)", "manager_set_kpi_target(text,integer,numeric)", "manager_import_pos_customers(jsonb,text)", "manager_set_pos_monthly(text,integer)"];
const fnDefs = () => val(`select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('export_backup','restore_backup');`);
const ex = (r, sig) => val(`select has_function_privilege('${r}', 'public.${sig}', 'execute');`);

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;\n${STUB}`);
  for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql"]) pg.loadFile(f);
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit';
    insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role, active) values ('${STAFF.mgr}','店長','manager',true),('${STAFF.staff}','スタッフ','staff',true),('${STAFF.viewer}','閲覧','viewer',true),
      ('${STAFF.gone}','退職','manager',false),('${STAFF.kiosk}','店頭','kiosk',true);`);

  // ---- 1. 適用・権限・戻し ----
  const defs104 = fnDefs();
  pg.loadFile("105_kpi.sql");
  for (const t of TABLES) {
    for (const r of ["anon", "authenticated"]) assert.equal(val(`select has_table_privilege('${r}', 'public.${t}', 'select,insert,update,delete');`), "f", `${r} ${t}`);
    assert.equal(val(`select has_table_privilege('service_role', 'public.${t}', 'select');`), "t", t);
    assert.equal(val(`select has_table_privilege('service_role', 'public.${t}', 'insert,update,delete');`), "f", t);       // service_role は読み取りだけ
    assert.equal(val(`select relrowsecurity from pg_class where relname='${t}';`), "t", t);
  }
  for (const sig of FNS) { assert.equal(ex("authenticated", sig), "t", sig); assert.equal(ex("anon", sig), "f", sig); assert.equal(ex("service_role", sig), "f", sig); }
  for (const sig of ["_kpi_overview(boolean,integer,timestamptz)", "_kpi_ach(numeric,numeric)", "_kpi_is_rate(text)"])
    for (const r of ["anon", "authenticated", "service_role"]) assert.equal(ex(r, sig), "f", `${r} ${sig}`);
  assert.notEqual(fnDefs(), defs104);
  // 仮の初期値(2026-10-15 の決定)
  const targets = j(val(`select jsonb_object_agg(kpi_code || ':' || milestone, value) from kpi_targets;`));
  assert.deepEqual(targets, { "member_visit_rate:3": 15, "member_visit_rate:6": 25, "member_visit_rate:12": 35, "new_members:3": 300, "new_members:6": 250, "new_members:12": 200,
    "check_rate:3": 40, "check_rate:6": 50, "check_rate:12": 60, "revisit_rate:3": null, "revisit_rate:6": 30, "revisit_rate:12": 40,
    "referral_clicks:3": 20, "referral_clicks:6": 40, "referral_clicks:12": 60 });
  assert.equal(val(`select coalesce(launch_date::text, 'null') from kpi_settings;`), "null");
  pg.loadFile("105_kpi_DOWN.sql");
  assert.equal(fnDefs(), defs104);
  assert.equal(cnt(`select count(*) from pg_class where relname = any(array['${TABLES.join("','")}']);`), 0);
  assert.equal(cnt(`select count(*) from pg_proc where proname in ('staff_kpi_overview','_kpi_overview','manager_import_pos_customers','manager_set_kpi_target','manager_set_launch_date','manager_set_pos_monthly','_kpi_ach','_kpi_is_rate');`), 0);
  pg.loadFile("105_kpi.sql");
  for (const sig of FNS) assert.equal(ex("authenticated", sig), "t", sig);
  ok("105 の適用: 新しい表は行レベルセキュリティつきで anon/authenticated から触れず、service_role は読み取りだけ。集計と変更の関数はログイン済みだけが呼べ(権限は関数の中で確認)、内部関数は誰からも呼べない。目標は仮の初期値(再来店率の3か月は null)・本番開始日は未設定。DOWN で 104 の状態に戻り、再適用もできる");

  // ---- 擬似データ(日本時間 2026-09-20 を「今日」として、7〜9月) ----
  const A = sub("a"), B = sub("b"), C = sub("c"), D = sub("d"), M = sub("m");
  reg(A, "会員A", "2026-07-10T03:00:00Z");
  reg(B, "会員B", "2026-08-31T14:59:59Z");                                                      // 日本時間 8/31 23:59:59 → 8月の登録
  reg(C, "会員C", "2026-08-31T15:00:00Z");                                                      // 日本時間 9/1 0:00 → 9月の登録
  reg(D, "会員D", "2026-09-05T03:00:00Z"); val(`update members set status='suspended' where id=${q(midOf(D))};`);   // 9月の登録・いまは停止中
  val(`update system_state set state='frozen';`);
  SVC(`select public.import_opening_balance('user09001', '移行M', ${q(ISS)}, ${q(M)}, 500, null, null, 'kpi-test', '2026-09-03T03:00:00Z'::timestamptz);`);   // 移行で取り込んだ会員(新規登録に数えない)
  val(`update system_state set state='open';`);
  for (const [s, ds] of [[A, ["2026-07-10", "2026-08-01", "2026-08-31", "2026-09-01", "2026-09-10"]], [B, ["2026-08-15", "2026-08-31", "2026-09-10"]], [C, ["2026-09-01"]],
                          [M, ["2026-09-10"]], [D, ["2026-09-05"]]]) for (const d of ds) visit(s, d);
  submit(A, ans(0, 6, 0, 0, 0), "2026-08-31T14:00:00Z");                                         // 日本時間 8/31 23:00(夏)
  submit(B, ans(0, 0, 0, 6, 0), "2026-08-31T15:30:00Z");                                         // 日本時間 9/1 0:30(秋)
  submit(A, ans(6, 0, 0, 0, 0), "2026-09-25T03:00:00Z");                                         // 基準日(9/20)より後: 9月の時点の値には入らない
  click(A, "2026-08-31T14:59:59Z"); click(A, "2026-08-31T15:00:00Z"); click(B, "2026-09-12T03:00:00Z"); click(B, "2026-09-13T03:00:00Z"); click(B, "2026-09-25T03:00:00Z");

  // ---- 2. 新規登録・会員来店数・レジの客数と会員来店率 ----
  { val(`insert into pos_daily_customers(is_test, business_date, customers, source) values (false, '2026-08-01', 40, 'aug.csv'), (false, '2026-08-31', 60, 'aug.csv');
         insert into pos_monthly_customers(is_test, month, customers) values (false, '2026-09-01', 300);`);
    let o = ov();
    assert.deepEqual(o.months.map((x) => x.month), ["2026-07", "2026-08", "2026-09"]);
    const [jul, aug, sep] = o.months;
    assert.deepEqual([jul.kpis.new_members.actual, aug.kpis.new_members.actual, sep.kpis.new_members.actual], [1, 1, 2]);   // B は8月・C は9月(日本時間)。移行の M は数えない・停止中の D は数える
    assert.deepEqual([jul.memberVisits, aug.memberVisits, sep.memberVisits], [1, 4, 6]);
    assert.equal(jul.pos.missing, true); assert.equal(jul.pos.customers, null); assert.equal(jul.kpis.member_visit_rate.actual, null);   // 未取り込み
    assert.deepEqual(aug.pos, { customers: 100, source: "daily", days: 2, manualCustomers: null, lastImportedAt: aug.pos.lastImportedAt, lastSource: "aug.csv", missing: false });
    assert.equal(aug.memberVisitsOnPosDays, 3); assert.equal(aug.kpis.member_visit_rate.actual, 3);                    // 客数を取り込んだ日(8/1・8/31)の来店 3 ÷ 100(8/15 の来店は数えない)
    assert.equal(sep.pos.source, "manual"); assert.equal(sep.pos.customers, 300); assert.equal(sep.kpis.member_visit_rate.actual, 2);   // 手入力: 9月の来店 6 ÷ 300
    assert.equal(sep.isCurrent, true); assert.equal(sep.asOfDate, "2026-09-20"); assert.equal(sep.elapsedDays, 20); assert.equal(sep.daysInMonth, 30); assert.equal(aug.asOfDate, "2026-08-31");
    // 日別があれば手入力より優先(その日の来店だけで割る)。0人だけなら率は出さない
    val(`insert into pos_daily_customers(is_test, business_date, customers, source) values (false, '2026-09-10', 50, 'sep.csv'), (false, '2026-07-31', 0, 'jul.csv');`);
    o = ov(); const s2 = month(o, "2026-09"), j2 = month(o, "2026-07");
    assert.equal(s2.pos.source, "daily"); assert.equal(s2.pos.customers, 50); assert.equal(s2.pos.manualCustomers, 300); assert.equal(s2.memberVisitsOnPosDays, 3); assert.equal(s2.kpis.member_visit_rate.actual, 6);
    assert.equal(j2.pos.missing, false); assert.equal(j2.pos.customers, 0); assert.equal(j2.kpis.member_visit_rate.actual, null);
    // 試験会員の来店は本番の集計に入らない
    val(`insert into members(member_no, is_test, created_at) values ('T09999', true, '2026-09-02T03:00:00Z'); insert into visits(member_id, visit_on) select id, '2026-09-10' from members where member_no='T09999';`);
    assert.equal(month(ov(), "2026-09").memberVisits, 6); assert.equal(month(ov(), "2026-09").kpis.new_members.actual, 2);
    assert.equal(month(ov(3, NOW, true), "2026-09").memberVisits, 1); assert.equal(month(ov(3, NOW, true), "2026-09").pos.missing, true); }
  ok("会員来店率と新規登録: 月は日本時間(UTC 8/31 14:59:59 の登録は8月・15:00 は9月)。来店数は visits の行数(試験会員は別)。新規登録に移行の会員は入れない。日別の客数があれば合計し、客数を取り込んだ日の来店だけで割る(手入力より優先)。日別がなければ月の手入力で割る。どちらもなければ未取り込み(率は null)。客数0なら率は出さない");

  // ---- 3. 体質チェック実施率・季節の再チェック率(月末/今の時点) ----
  { const o = ov(); const [jul, aug, sep] = o.months;
    assert.deepEqual([jul.supporting.activeMembers, aug.supporting.activeMembers, sep.supporting.activeMembers], [1, 2, 4]);   // 8月末: C(9/1 0:00 の登録)はまだ。9月: 停止中の D は除く・移行の M は含む
    assert.deepEqual([jul.kpis.check_rate.actual, aug.kpis.check_rate.actual, sep.kpis.check_rate.actual], [0, 50, 50]);     // 8月: A(8/31 23:00)だけ。B(9/1 0:30)は9月
    assert.equal(aug.supporting.seasonKey, "2026-summer"); assert.equal(aug.supporting.seasonRecheckPercent, 100);
    assert.equal(sep.supporting.seasonKey, "2026-autumn"); assert.equal(sep.supporting.checkedMembers, 2);
    assert.equal(sep.supporting.seasonRecheckPercent, 50);                                                                    // A の最新(9/20 時点)は夏・B は秋。9/25 の A の再チェックはまだ数えない
    assert.equal(jul.supporting.seasonRecheckPercent, null);
    assert.equal(month(ov(3, "2026-09-26T03:00:00Z"), "2026-09").supporting.seasonRecheckPercent, 100); }                   // 9/26 時点なら A も秋
  ok("体質チェック実施率: 月末(今月は今)時点の有効会員のうち実施した会員の割合(日本時間の境目・停止中は除く・移行の会員は含む)。季節の再チェック率: 実施した会員のうち、その時点の最新の結果がその時点の季節(夏=6〜8月・秋=9〜11月)の割合");

  // ---- 4. 再来店率(直近60日・103 の集計と同じ決め方) ----
  { const o = ov(); const [jul, aug, sep] = o.months;
    assert.deepEqual([jul.kpis.revisit_rate.actual, aug.kpis.revisit_rate.actual, sep.kpis.revisit_rate.actual], [0, 100, 50]);
    assert.deepEqual([sep.supporting.revisitMembers, sep.supporting.visitorsInWindow, sep.supporting.revisitAmongVisitorsPercent], [2, 4, 50]);
    assert.deepEqual([jul.supporting.revisitMembers, jul.supporting.visitorsInWindow, jul.supporting.revisitAmongVisitorsPercent], [0, 1, 0]);
    assert.equal(sep.supporting.revisitWindowDays, 60);
    // 60日の窓: 9/20 から59日前(7/23)まで。7/22 の来店は入らない
    visit(C, "2026-07-22"); assert.equal(month(ov(), "2026-09").kpis.revisit_rate.actual, 50);
    visit(C, "2026-07-23"); assert.equal(month(ov(), "2026-09").kpis.revisit_rate.actual, 75);
    // 今月の値は 103 の staff_constitution_stats の再来店率と同じ(分母は有効会員全員。実施した人・していない人の合計)
    const st = j(AS(STAFF.mgr, `select public.staff_constitution_stats();`)), live = j(val(`select public._kpi_overview(false, 1, now());`)).months[0];
    const back = (g) => Math.round(((g.revisitRatePercent ?? 0) * g.members) / 100);
    const n2 = back(st.revisit.checked) + back(st.revisit.unchecked), all = st.revisit.checked.members + st.revisit.unchecked.members;
    assert.equal(live.supporting.activeMembers, all); assert.equal(live.supporting.revisitMembers, n2);
    assert.equal(live.kpis.revisit_rate.actual, all ? Math.round((1000 * n2) / all) / 10 : null); }
  ok("再来店率: 月末(今月は今日)までの直近60日(日本時間・その日を含む)に来店が2日以上ある会員 ÷ 有効会員。60日の窓の端の扱い。補助に、窓の中で来店した会員のうち2日以上の割合。今月の値は体質チェックの集計(103)の再来店率と同じ決め方で一致する");

  // ---- 5. 薬日本堂への送客 ----
  { const o = ov(); const [, aug, sep] = o.months;
    assert.equal(aug.kpis.referral_clicks.actual, 1); assert.equal(sep.kpis.referral_clicks.actual, 3);                  // 8/31 23:59:59 は8月・9/1 0:00 は9月。9/25 は基準日より後
    assert.equal(aug.supporting.referralPerCheckedPercent, 100); assert.equal(sep.supporting.referralPerCheckedPercent, 150); }
  ok("薬日本堂への送客: その月(日本時間)の「漢方相談へ」の押された数。補助に、押された数 ÷ 体質チェックを実施した会員");

  // ---- 6. 目標の段階と達成率 ----
  { let o = ov();
    for (const m of o.months) { assert.equal(m.milestone, null); for (const k of Object.values(m.kpis)) { assert.equal(k.target, null); assert.equal(k.achievementPercent, null); } }
    AS(STAFF.mgr, `select public.manager_set_launch_date('2026-08-10');`);
    o = ov(); const [jul, aug, sep] = o.months;
    assert.equal(o.launchDate, "2026-08-10"); assert.deepEqual([jul.monthIndex, aug.monthIndex, sep.monthIndex], [0, 1, 2]); assert.deepEqual([jul.milestone, aug.milestone, sep.milestone], [null, 3, 3]);
    assert.deepEqual(aug.kpis.member_visit_rate, { actual: 3, target: 15, targetCompared: 15, prorated: false, achievementPercent: 20 });
    assert.deepEqual(aug.kpis.check_rate, { actual: 50, target: 40, targetCompared: 40, prorated: false, achievementPercent: 125 });
    assert.deepEqual(aug.kpis.revisit_rate, { actual: 100, target: null, targetCompared: null, prorated: false, achievementPercent: null });   // 3か月は基準値を測る
    assert.deepEqual(aug.kpis.new_members, { actual: 1, target: 300, targetCompared: 300, prorated: false, achievementPercent: 0 });
    // 今月の数の KPI は日割り(20日 / 30日)。率は日割りしない
    assert.deepEqual(sep.kpis.new_members, { actual: 2, target: 300, targetCompared: 200, prorated: true, achievementPercent: 1 });
    assert.deepEqual(sep.kpis.referral_clicks, { actual: 3, target: 20, targetCompared: 13.3, prorated: true, achievementPercent: 23 });
    assert.equal(sep.kpis.member_visit_rate.prorated, false); assert.equal(sep.kpis.member_visit_rate.targetCompared, 15);
    // 1〜3か月目=3か月・4〜6=6か月・7か月目以降=12か月。開始前は null
    AS(STAFF.mgr, `select public.manager_set_launch_date('2026-02-15');`);
    o = ov(9); assert.deepEqual(o.months.map((x) => [x.month, x.milestone]),
      [["2026-01", null], ["2026-02", 3], ["2026-03", 3], ["2026-04", 3], ["2026-05", 6], ["2026-06", 6], ["2026-07", 6], ["2026-08", 12], ["2026-09", 12]]);
    assert.equal(month(o, "2026-09").kpis.revisit_rate.target, 40); assert.equal(month(o, "2026-09").kpis.revisit_rate.achievementPercent, 188);   // 75% ÷ 40%
    assert.equal(month(o, "2026-06").kpis.check_rate.target, 50);
    assert.equal(ov(40).months.length, 36); assert.equal(ov(0).months.length, 1);                                           // 1〜36か月
    AS(STAFF.mgr, `select public.manager_set_kpi_target('member_visit_rate', 3, null);`);
    AS(STAFF.mgr, `select public.manager_set_launch_date('2026-08-10');`);
    assert.equal(month(ov(), "2026-08").kpis.member_visit_rate.achievementPercent, null);
    AS(STAFF.mgr, `select public.manager_set_kpi_target('member_visit_rate', 3, 15);`); }
  ok("目標の段階: 本番開始日の月を1か月目として、1〜3か月目は3か月・4〜6は6か月・7か月目以降は12か月の目標(開始前・未設定は目標なし)。達成率=実績÷目標(目標なしは null)。新規登録と送客の今月分は経過日数で日割りした目標と比べる");

  // ---- 7. 権限 ----
  { const m = overview(STAFF.mgr), v = overview(STAFF.viewer);
    assert.equal(m.canEdit, true); assert.equal(v.canEdit, false); assert.equal(m.state, "open"); assert.equal(m.months.length, 13);
    const strip = (x) => JSON.stringify({ ...x, asOf: null, canEdit: null });
    assert.equal(strip(m), strip(v));                                                                                      // 閲覧も同じ数字を見られる
    assert.doesNotMatch(JSON.stringify(m), /会員A|会員B|U[a-z]{32}|user09001/);                                              // 個人の情報は返さない
    for (const [uid, re] of [[STAFF.staff, /forbidden/], [STAFF.kiosk, /forbidden/], [STAFF.plain, /not_staff/], [STAFF.gone, /not_staff/]]) {
      fails(() => overview(uid), re);
      fails(() => AS(uid, `select public.manager_set_launch_date('2026-10-01');`), re);
      fails(() => AS(uid, `select public.manager_set_kpi_target('check_rate', 3, 10);`), re);
      fails(() => imp(uid, [{ date: "2026-09-01", customers: 1 }]), re);
      fails(() => AS(uid, `select public.manager_set_pos_monthly('2026-09', 10);`), re);
    }
    for (const sql of [`select public.manager_set_launch_date('2026-10-01');`, `select public.manager_set_kpi_target('check_rate', 3, 10);`,
                       `select public.manager_import_pos_customers('[{"date":"2026-09-01","customers":1}]'::jsonb, 'x');`, `select public.manager_set_pos_monthly('2026-09', 10);`])
      fails(() => AS(STAFF.viewer, sql), /forbidden/);                                                                     // 閲覧(本部)は見るだけ
    fails(() => ANON(`select public.staff_kpi_overview(13);`), /permission denied/);
    fails(() => SVC(`select public.staff_kpi_overview(13);`), /permission denied/);
    fails(() => SVC(`select public.manager_import_pos_customers('[]'::jsonb, 'x');`), /permission denied/);
    fails(() => AS(STAFF.mgr, `select public._kpi_overview(false, 3, now());`), /permission denied/);
    fails(() => AS(STAFF.mgr, `select * from public.pos_daily_customers;`), /permission denied/);
    assert.equal(val(`select launch_date::text from kpi_settings;`), "2026-08-10"); assert.equal(val(`select value from kpi_targets where kpi_code='check_rate' and milestone=3;`), "40.0"); }
  ok("権限: 店長は見る・変える、閲覧(本部)は同じ数字を見るだけ(変更はすべて拒否)。スタッフ・店頭タブレットは集計も変更も拒否、スタッフ以外・無効のアカウント・未ログイン・service_role も拒否。内部関数と表は直接触れない。個人の情報は返さない");

  // ---- 8. 取り込み: 検証・上書き・監査ログ ----
  { const before = val(`select string_agg(business_date || ':' || customers, ',' order by business_date) from pos_daily_customers;`);
    const bad = [
      ['{"date":"2026-09-01","customers":1}', /invalid_rows/], ["[]", /invalid_rows/], [JSON.stringify(Array.from({ length: 401 }, (_, i) => ({ date: "2026-01-01", customers: i }))), /invalid_rows/],
      ['[{"date":"2026-09-01","customers":1},{"date":"2026-09-01","customers":2}]', /invalid_rows/],
      ['[{"date":"2026-02-30","customers":1}]', /invalid_date/], ['[{"date":"2026/09/01","customers":1}]', /invalid_date/], ['[{"date":"2099-01-01","customers":1}]', /invalid_date/],
      ['[{"date":"1999-12-31","customers":1}]', /invalid_date/], ['[{"customers":1}]', /invalid_date/], ['[["2026-09-01",1]]', /invalid_date/],
      ['[{"date":"2026-09-01","customers":-1}]', /invalid_customers/], ['[{"date":"2026-09-01","customers":1.5}]', /invalid_customers/], ['[{"date":"2026-09-01","customers":"12"}]', /invalid_customers/],
      ['[{"date":"2026-09-01","customers":100001}]', /invalid_customers/], ['[{"date":"2026-09-01"}]', /invalid_customers/],
      ['[{"date":"2026-09-02","customers":5},{"date":"2026-09-03","customers":-5}]', /invalid_customers/]];                    // 1行でも不正なら何も書かない
    for (const [rows, re] of bad) fails(() => AS(STAFF.mgr, `select public.manager_import_pos_customers(${q(rows)}::jsonb, 'x.csv');`), re);
    fails(() => AS(STAFF.mgr, `select public.manager_import_pos_customers(null, 'x.csv');`), /invalid_rows/);
    assert.equal(val(`select string_agg(business_date || ':' || customers, ',' order by business_date) from pos_daily_customers;`), before);
    // 400行は受け付ける
    const many = Array.from({ length: 400 }, (_, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 86400e3).toISOString().slice(0, 10), customers: 10 + (i % 7) }));
    let r = imp(STAFF.mgr, many, "big.csv"); assert.deepEqual([r.inserted, r.updated, r.unchanged, r.from, r.to], [400, 0, 0, "2024-01-01", "2025-02-03"]);
    // 上書き(同じ日付をもう一度): 値が変わった日だけ監査ログに前後の値
    const a0 = cnt(`select count(*) from audit_log where action='pos_import';`);
    r = imp(STAFF.mgr, [{ date: "2026-08-01", customers: 45 }, { date: "2026-08-31", customers: 60 }, { date: "2026-08-02", customers: 30 }], "aug_v2.csv\u0007");
    assert.deepEqual([r.status, r.inserted, r.updated, r.unchanged, r.from, r.to, r.customers], ["ok", 1, 1, 1, "2026-08-01", "2026-08-31", 135]);
    assert.equal(val(`select customers || ':' || source from pos_daily_customers where business_date='2026-08-01' and not is_test;`), "45:aug_v2.csv");   // 制御文字は除く
    assert.equal(val(`select imported_by from pos_daily_customers where business_date='2026-08-02';`), STAFF.mgr);
    assert.equal(cnt(`select count(*) from audit_log where action='pos_import';`), a0 + 1);
    const log = j(val(`select meta from audit_log where action='pos_import' order by id desc limit 1;`));
    assert.deepEqual([log.source, log.rows, log.inserted, log.updated, log.unchanged, log.from, log.to, log.test], ["aug_v2.csv", 3, 1, 1, 1, "2026-08-01", "2026-08-31", false]);
    assert.deepEqual(log.changed, [{ date: "2026-08-01", old: 40, new: 45, oldSource: "aug.csv" }]);
    assert.equal(val(`select staff_user_id from audit_log where action='pos_import' order by id desc limit 1;`), STAFF.mgr);
    assert.equal(month(ov(), "2026-08").pos.customers, 135); assert.equal(month(ov(), "2026-08").pos.lastSource, "aug_v2.csv");
    // 月の手入力: 監査ログ・null で消す・不正な月
    r = j(AS(STAFF.mgr, `select public.manager_set_pos_monthly('2026-07', 250);`)); assert.equal(r.status, "ok");
    assert.equal(month(ov(), "2026-07").pos.source, "daily");                                                                   // 7/31 の日別(0人)があるので日別が優先
    val(`delete from pos_daily_customers where business_date='2026-07-31';`);
    assert.equal(month(ov(), "2026-07").pos.source, "manual"); assert.equal(month(ov(), "2026-07").kpis.member_visit_rate.actual, 1.2);   // 7月の来店 3(A 7/10・C 7/22・7/23)÷ 250
    AS(STAFF.mgr, `select public.manager_set_pos_monthly('2026-07', null);`); assert.equal(month(ov(), "2026-07").pos.missing, true);
    assert.deepEqual(j(val(`select meta from audit_log where action='pos_monthly' order by id desc limit 1;`)), { month: "2026-07", old: 250, new: null, test: false });
    for (const [m, c, re] of [["2026-13", 1, /invalid_month/], ["2026-9", 1, /invalid_month/], ["2099-01", 1, /invalid_month/], [null, 1, /invalid_month/], ["2026-08", -1, /invalid_customers/]])
      fails(() => AS(STAFF.mgr, `select public.manager_set_pos_monthly(${q(m)}, ${c});`), re);
    // 目標・本番開始日の検証と監査ログ
    for (const [k, m, v, re] of [["nope", 3, 1, /invalid_kpi/], ["check_rate", 4, 1, /invalid_milestone/], ["check_rate", 3, 100.5, /invalid_target/], ["check_rate", 3, -1, /invalid_target/],
                                 ["check_rate", 3, 10.25, /invalid_target/], ["new_members", 3, 10.5, /invalid_target/], ["referral_clicks", 6, 100001, /invalid_target/]])
      fails(() => AS(STAFF.mgr, `select public.manager_set_kpi_target(${q(k)}, ${m}, ${v});`), re);
    AS(STAFF.mgr, `select public.manager_set_kpi_target('check_rate', 6, 55.5);`);
    assert.deepEqual(j(val(`select meta from audit_log where action='kpi_target' order by id desc limit 1;`)), { kpi: "check_rate", milestone: 6, old: 50.0, new: 55.5 });
    assert.equal(j(AS(STAFF.viewer, `select public.staff_kpi_overview(1);`)).targets.check_rate["6"], 55.5);
    fails(() => AS(STAFF.mgr, `select public.manager_set_launch_date('1999-01-01');`), /invalid_date/);
    assert.deepEqual(j(val(`select meta from audit_log where action='kpi_launch_date' order by id desc limit 1;`)), { old: "2026-02-15", new: "2026-08-10" });
    assert.equal(val(`select updated_by from kpi_settings;`), STAFF.mgr); }
  ok("取り込み: 配列でない・0行・401行以上・同じ日付の重複・存在しない日付・形の違う日付・未来・2000年より前・客数が負/小数/文字/上限超え/空は拒否し、1行でも不正なら何も書かない。400行は受け付ける。同じ日付は上書きし、値の変わった日の前後の値・ファイル名・件数を監査ログに残す。月の手入力(日別が優先・null で消す)。目標と本番開始日の検証と監査ログ");

  // ---- 9. 試験運用中: 客数は試験用の別の行 ----
  { val(`update system_state set state='test';`);
    const r = imp(STAFF.mgr, [{ date: "2026-08-01", customers: 7 }], "test.csv"); assert.equal(r.inserted, 1);
    assert.equal(val(`select customers from pos_daily_customers where is_test and business_date='2026-08-01';`), "7");
    assert.equal(val(`select customers from pos_daily_customers where not is_test and business_date='2026-08-01';`), "45");     // 本番の客数は変わらない
    const t = overview(STAFF.mgr); assert.equal(t.state, "test"); assert.equal(t.months.find((x) => x.month === "2026-08").pos.customers, 7);
    assert.equal(t.months.find((x) => x.month === "2026-08").memberVisits, 0);                                                   // 試験会員の来店だけ
    val(`update system_state set state='open';`);
    assert.equal(overview(STAFF.mgr).months.find((x) => x.month === "2026-08").pos.customers, 135);
    // 凍結中も、店長は客数・目標を変えられる(会員のデータではない)。集計も見られる
    val(`update system_state set state='frozen';`);
    assert.equal(imp(STAFF.mgr, [{ date: "2026-08-03", customers: 9 }], "f.csv").inserted, 1); assert.equal(overview(STAFF.viewer).state, "frozen");
    val(`update system_state set state='open';`); }
  ok("試験運用中は、取り込んだ客数を試験用の別の行に入れ、集計も試験会員と試験用の客数だけ(本番の客数は変わらない)。凍結中も客数と目標は変えられ、集計も見られる");

  // ---- 10. バックアップ/復元 ----
  { const bk = val(`set role service_role; select public.export_backup();`).split("\n").pop(); const b = JSON.parse(bk);
    for (const t of TABLES) assert.ok(Array.isArray(b.tables[t]), t);
    assert.equal(b.tables.kpi_settings[0].launch_date, "2026-08-10"); assert.equal(b.tables.kpi_targets.length, 15); assert.ok(b.tables.pos_daily_customers.length > 400);
    assert.ok(b.tables.pos_daily_customers.some((x) => x.is_test)); assert.doesNotMatch(bk, /sales|売上/);                      // 売上は持たない
    const base = JSON.stringify(ov(13)), baseT = JSON.stringify(ov(13, NOW, true));
    const fresh = (db) => { pg.createDb(db); pg.execIn(db, STUB);
      for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql"]) pg.loadFileIn(db, f);
      pg.execIn(db, `insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};`); };
    fresh("t2");
    const rs = JSON.parse(pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`).split("\n").pop());
    assert.equal(rs.status, "restored"); assert.equal(rs.balanceMismatches, 0);
    assert.equal(JSON.stringify(ov(13, NOW, false, "t2")), base); assert.equal(JSON.stringify(ov(13, NOW, true, "t2")), baseT);   // 同じ数字・目標・本番開始日
    fails(() => pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`), /target_not_empty/);
    // 105 より前のバックアップ(KPI の表がない): 復元でき、本番開始日は未設定・目標は初期値・客数は0件
    const old = JSON.parse(bk); for (const t of TABLES) delete old.tables[t];
    fresh("t3");
    const r3 = JSON.parse(pg.execIn("t3", `set role service_role; select public.restore_backup(${q(JSON.stringify(old))}::jsonb);`).split("\n").pop());
    assert.equal(r3.status, "restored"); assert.equal(pg.execIn("t3", `select count(*) from pos_daily_customers;`), "0");
    assert.equal(pg.execIn("t3", `select coalesce(launch_date::text, 'null') from kpi_settings;`), "null"); assert.equal(pg.execIn("t3", `select count(*) from kpi_targets;`), "15");
    assert.equal(ov(3, NOW, false, "t3").months[1].memberVisits, 4);
    // 客数の行がある DB には復元しない
    fresh("t4");
    pg.execIn("t4", `insert into pos_daily_customers(business_date, customers, source) values ('2026-01-01', 1, 'x');`);
    fails(() => pg.execIn("t4", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`), /target_not_empty/); }
  ok("バックアップ/復元: 本番開始日・目標・客数(日別・月・試験用も)がバックアップに入り、空の DB に同じ KPI の数字で復元できる。105 より前のバックアップも復元でき(開始日は未設定・目標は初期値・客数0件)、客数の行がある DB には復元しない");
  console.log(`\n${n} kpi tests passed`);
} finally { pg.stop(); }
