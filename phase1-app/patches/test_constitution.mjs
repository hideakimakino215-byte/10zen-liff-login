// 1分体質チェック(db/103_constitution_check.sql)を、実 PostgreSQL 16 で検証する。本番には接続しない。
// 対象: 適用/戻し・権限、採点(DB が計算)・バランス良好、同点と季節・土用の境目(日本時間)、同意、会員証の情報(今日のお茶・あなたのお茶・季節の変化)、
//       今日の体調(1日1回)、薬日本堂の案内のクリック、集計の権限(スタッフは体調の傾向だけ)と値、状態(凍結・試験)、バックアップ/復元。
// 実行: node --experimental-strip-types test_constitution.mjs
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
const arr = (a) => (a === null ? "null" : `array[${a.map((x) => (x === null ? "null" : x)).join(",")}]::integer[]`);
const reg = (s, name = "会員", now = "now") => j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, ${ts(now)});`));
const me = (s, now = "now") => j(SVC(`select public.app_me(${q(ISS)}, ${q(s)}, ${ts(now)});`));
const submit = (s, answers, mood = "soup", consent = true, now = "now") =>
  j(SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(s)}, ${arr(answers)}, ${q(mood)}, ${consent === null ? "null" : consent}, ${ts(now)});`));
const cond = (s, t, e, c, now = "now") => j(SVC(`select public.app_condition_submit(${q(ISS)}, ${q(s)}, ${q(t)}, ${q(e)}, ${q(c)}, ${ts(now)});`));
const click = (s, now = "now") => j(SVC(`select public.app_referral_click(${q(ISS)}, ${q(s)}, ${ts(now)});`));
const stats = (uid) => j(AS(uid, `select public.staff_constitution_stats();`));
const midOf = (s) => val(`select member_id from member_identities where subject=${q(s)} limit 1;`);
const cnt = (sql) => Number(val(sql));
// 五行ごとの点数を [木,火,土,金,水] で指定して回答を作る(各五行の3問に 2→1→0 の順で配る)
const ans = (w, f, e, m, wa) => [w, f, e, m, wa].flatMap((x) => { const out = []; let r = x; for (let i = 0; i < 3; i++) { const a = Math.min(2, r); out.push(a); r -= a; } return out; });
const fnDefs = () => val(`select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('app_me','_member_view','export_backup','restore_backup');`);
const STUB = `create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;
const TABLES = ["constitution_consents", "constitution_checks", "constitution_daily_conditions", "constitution_referral_clicks"];

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;\n${STUB}`);
  pg.exec(`create table public.customers(id uuid primary key, line_user_id text); create function public.legacy_fn() returns int language sql as $$ select 1 $$;`);
  const snapPriv = () => val(`select string_agg(r || ':' || p::text, ',' order by r) from (
    select r, has_table_privilege(r, 'public.customers', 'select,insert,update,delete') and has_function_privilege(r, 'public.legacy_fn()', 'execute') as p from unnest(array['anon','authenticated','service_role']) r) x;`);
  const privBefore = snapPriv();
  pg.loadFile("100_phase1_schema.sql"); pg.loadFile("101_search_path_fix.sql"); pg.loadFile("102_rank_perks.sql");
  pg.exec(`update system_state set state='open';
    insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role, active) values ('${STAFF.mgr}','店長','manager',true),('${STAFF.staff}','スタッフ','staff',true),('${STAFF.viewer}','閲覧','viewer',true),
      ('${STAFF.gone}','退職','staff',false),('${STAFF.kiosk}','店頭','kiosk',true);`);

  // ---- 1. 適用・権限・戻し ----
  const A = sub("a"); reg(A, "会員A", "2026-10-15T03:00:00Z");
  const defs102 = fnDefs(), me102 = me(A, "2026-10-15T03:00:00Z").member;
  assert.equal("constitution" in me102, false);
  pg.loadFile("103_constitution_check.sql");
  assert.equal(snapPriv(), privBefore);
  for (const t of TABLES) {
    for (const r of ["anon", "authenticated"]) assert.equal(val(`select has_table_privilege('${r}', 'public.${t}', 'select,insert,update,delete');`), "f", `${r} ${t}`);
    assert.equal(val(`select has_table_privilege('service_role', 'public.${t}', 'update') or has_table_privilege('service_role', 'public.${t}', 'delete');`), "f", t);   // 追記と読み取りだけ
    assert.equal(val(`select relrowsecurity from pg_class where relname='${t}';`), "t", t);
  }
  const ex = (r, sig) => val(`select has_function_privilege('${r}', '${sig}', 'execute');`);
  for (const sig of ["public.app_constitution_submit(text,text,integer[],text,boolean,timestamptz)", "public.app_condition_submit(text,text,text,text,text,timestamptz)", "public.app_referral_click(text,text,timestamptz)"]) {
    assert.equal(ex("service_role", sig), "t", sig); assert.equal(ex("authenticated", sig), "f", sig); assert.equal(ex("anon", sig), "f", sig); }
  assert.equal(ex("authenticated", "public.staff_constitution_stats()"), "t"); assert.equal(ex("anon", "public.staff_constitution_stats()"), "f"); assert.equal(ex("service_role", "public.staff_constitution_stats()"), "f");
  for (const sig of ["public._season_element(date)", "public._cc_pick(integer[],text)", "public._cc_result(integer[],date)", "public._cc_focus(integer[],text,text,text,date)", "public._tea_of_day(date)",
                     "public._constitution_snapshot(uuid,timestamptz)", "public._member_view(uuid,timestamptz)"])
    for (const r of ["anon", "authenticated", "service_role"]) assert.equal(ex(r, sig), "f", `${r} ${sig}`);
  // 画面から点数・タイプを渡す引数はない(回答だけ)
  assert.equal(val(`select pg_get_function_identity_arguments('public.app_constitution_submit'::regproc);`), "p_issuer text, p_subject text, p_answers integer[], p_mood text, p_consent boolean, p_now timestamp with time zone");
  assert.equal(val(`select value from app_settings where key='constitution_moods';`), "okayu,soup,nabe_solo,noodle,nabe_share");
  pg.loadFile("103_constitution_check_DOWN.sql");
  assert.equal(fnDefs(), defs102); assert.deepEqual(me(A, "2026-10-15T03:00:00Z").member, me102);
  assert.equal(cnt(`select count(*) from pg_class where relname like 'constitution%';`), 0);
  assert.equal(cnt(`select count(*) from pg_proc where proname in ('_cc_result','app_constitution_submit','staff_constitution_stats','_season_element');`), 0);
  assert.equal(cnt(`select count(*) from app_settings where key='constitution_moods';`), 0); assert.equal(snapPriv(), privBefore);
  pg.loadFile("103_constitution_check.sql");
  assert.equal(snapPriv(), privBefore);
  ok("103 の適用: 新しい表は行レベルセキュリティつきで anon/authenticated から触れず、service_role も更新・削除できない。お客様向け関数は service_role だけ、集計はログイン済みだけ、判定の関数は誰からも直接呼べない。送信の引数は回答だけ(点数なし)。DOWN で 102 の関数(_member_view・バックアップ)と会員証の応答に戻り、再適用もできる");

  // ---- 2. 採点(DB が計算)・バランス良好・不正な回答 ----
  const NOW = "2026-10-15T03:00:00Z";                       // JST 10/15(木)12:00・秋(金)
  let r = submit(A, [2, 2, 2, 1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 1, 0], "okayu", true, NOW);
  assert.equal(r.status, "ok"); assert.deepEqual(r.result.scores, { wood: 6, fire: 1, earth: 1, metal: 1, water: 3 }); assert.equal(r.result.primary, "wood"); assert.equal(r.result.balanced, false);
  assert.equal(r.result.seasonElement, "metal");
  const row = JSON.parse(val(`select row_to_json(c) from constitution_checks c where member_id=${q(midOf(A))} order by created_at desc limit 1;`));
  assert.deepEqual(row.answers, [2, 2, 2, 1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 1, 0]); assert.equal(row.mood, "okayu");
  assert.deepEqual([row.score_wood, row.score_fire, row.score_earth, row.score_metal, row.score_water], [6, 1, 1, 1, 3]);
  assert.equal(row.primary_element, "wood"); assert.equal(row.balanced, false); assert.equal(row.season_key, "2026-autumn"); assert.equal(row.season_element, "metal");
  assert.equal(Date.parse(row.created_at), Date.parse(NOW));
  r = submit(A, [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0], "soup", true, "2026-10-15T03:00:01Z");                // 全部1点以下 → バランス良好(主な五行は同じ決め方: 同点で季節の金)
  assert.equal(r.result.balanced, true); assert.equal(r.result.primary, "metal"); assert.equal(r.member.constitution.balanced, true);
  r = submit(A, Array(15).fill(0), "soup", true, NOW); assert.equal(r.result.balanced, true); assert.equal(r.result.primary, "metal");
  r = submit(A, ans(2, 0, 0, 0, 0), "soup", true, NOW); assert.equal(r.result.balanced, false); assert.equal(r.result.primary, "wood");   // 2点あればバランス良好ではない
  const before = cnt(`select count(*) from constitution_checks;`);
  for (const bad of [Array(14).fill(0), Array(16).fill(0), [3, ...Array(14).fill(0)], [-1, ...Array(14).fill(0)], [null, ...Array(14).fill(0)], null])
    assert.equal(submit(A, bad, "soup", true, NOW).status, "invalid_answers", JSON.stringify(bad));
  assert.equal(j(SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(A)}, '[0:14]={0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}'::integer[], 'soup', true, ${ts(NOW)});`)).status, "invalid_answers");
  assert.equal(j(SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(A)}, '{{0,0,0},{0,0,0},{0,0,0},{0,0,0},{0,0,0}}'::integer[], 'soup', true, ${ts(NOW)});`)).status, "invalid_answers");
  for (const m of ["", "ramen", "SOUP", null]) assert.equal(submit(A, ans(1, 1, 1, 1, 1), m, true, NOW).status, "invalid_mood");
  assert.equal(cnt(`select count(*) from constitution_checks;`), before);
  fails(() => val(`insert into constitution_checks(member_id, answers, mood, score_wood, score_fire, score_earth, score_metal, score_water, primary_element, balanced, season_key, season_element, created_at)
    values (${q(midOf(A))}, '{0,0,0,0,0,0,0,0,0,0,0,0,0,0,null}', 'soup', 0,0,0,0,0, 'wood', true, '2026-autumn', 'metal', now());`), /constitution_checks_answers_check/);
  // 食事の気分の選択肢は設定の行で差し替えられる
  val(`update app_settings set value='okayu, soup ,ramen' where key='constitution_moods';`); assert.equal(submit(A, ans(1, 1, 1, 1, 1), "ramen", true, NOW).status, "ok");
  assert.equal(submit(A, ans(1, 1, 1, 1, 1), "noodle", true, NOW).status, "invalid_mood");
  val(`update app_settings set value='okayu,soup,nabe_solo,noodle,nabe_share' where key='constitution_moods';`);
  ok("採点: 五行ごとに3問の合計(0〜6)を DB が計算して保存(15問の回答・気分・点数・タイプ・季節・日時)。全部1点以下はバランス良好。15問でない・0〜2 以外・空・多次元・添字のずれた回答と、設定にない気分は記録しない(表の制約でも拒否)。気分の選択肢は設定の行で差し替えられる");

  // ---- 3. 同点・季節・土用の境目(日本時間) ----
  const se = (d) => val(`select public._season_element(${q(d)}::date);`);
  const exp = { "01-16": "water", "01-17": "earth", "02-03": "earth", "02-04": "water", "02-28": "water", "03-01": "wood", "04-16": "wood", "04-17": "earth", "05-04": "earth",
    "05-05": "wood", "05-31": "wood", "06-01": "fire", "07-19": "fire", "07-20": "earth", "08-06": "earth", "08-07": "fire", "08-31": "fire", "09-01": "metal", "10-19": "metal",
    "10-20": "earth", "11-06": "earth", "11-07": "metal", "11-30": "metal", "12-01": "water", "12-31": "water" };
  for (const [d, e] of Object.entries(exp)) assert.equal(se(`2026-${d}`), e, d);
  assert.equal(se("2028-02-29"), "water");
  const tie = ans(2, 2, 2, 2, 2);                                                                   // 全部同点
  const at = (now) => submit(A, tie, "soup", true, now).result;
  assert.equal(at("2026-10-19T14:59:59Z").primary, "metal");                                       // JST 10/19 23:59:59(秋)
  assert.equal(at("2026-10-19T15:00:00Z").primary, "earth");                                       // JST 10/20 0:00(土用の入り)。UTC ではまだ 10/19
  assert.equal(at("2026-11-06T14:59:59Z").primary, "earth"); assert.equal(at("2026-11-06T15:00:00Z").primary, "metal");
  assert.equal(at("2026-11-30T15:00:00Z").primary, "water"); assert.equal(at("2027-02-28T15:00:00Z").primary, "wood");
  assert.equal(at("2027-02-03T14:59:59Z").primary, "earth"); assert.equal(at("2027-02-03T15:00:00Z").primary, "water");
  assert.equal(at("2027-07-19T15:00:00Z").primary, "earth"); assert.equal(at("2027-06-15T03:00:00Z").primary, "fire");
  assert.equal(submit(A, ans(4, 4, 0, 0, 0), "soup", true, NOW).result.primary, "wood");          // 季節(金)が同点に入っていない → 木・火…の順で先の木
  assert.equal(submit(A, ans(0, 4, 0, 0, 4), "soup", true, NOW).result.primary, "fire");
  assert.equal(submit(A, ans(4, 0, 0, 0, 4), "soup", true, "2026-12-15T03:00:00Z").result.primary, "water");   // 冬は水を優先
  assert.equal(submit(A, ans(0, 0, 3, 3, 0), "soup", true, "2026-10-25T03:00:00Z").result.primary, "earth");   // 土用は土を優先
  assert.equal(submit(A, ans(0, 0, 3, 3, 0), "soup", true, NOW).result.primary, "metal");
  assert.equal(submit(A, ans(5, 6, 0, 0, 0), "soup", true, NOW).result.primary, "fire");          // 同点でなければ一番高い五行
  ok("同点と季節(日本時間): 春=木・夏=火・秋=金・冬=水・土用=土(1/17〜2/3・4/17〜5/4・7/20〜8/6・10/20〜11/6、両端を含む)。同点は季節の五行を優先し、季節が同点に入っていなければ木・火・土・金・水の順。UTC と日本時間で日付が違う境目も日本時間で判定");

  // ---- 4. 同意 ----
  const B = sub("b"); reg(B, "会員B", NOW);
  assert.equal(me(B, NOW).member.constitutionConsent, false); assert.equal(me(B, NOW).member.constitution, null);
  for (const c of [false, null]) assert.equal(submit(B, ans(3, 0, 0, 0, 0), "soup", c, NOW).status, "consent_required");
  assert.equal(cnt(`select count(*) from constitution_checks where member_id=${q(midOf(B))};`), 0); assert.equal(cnt(`select count(*) from constitution_consents where member_id=${q(midOf(B))};`), 0);
  assert.equal(submit(B, ans(3, 0, 0, 0, 0), "soup", true, NOW).status, "ok");
  assert.equal(val(`select version || '|' || (consented_at = ${ts(NOW)}) from constitution_consents where member_id=${q(midOf(B))};`), "constitution_v1|true");
  assert.equal(submit(B, ans(0, 3, 0, 0, 0), "soup", false, NOW).status, "ok");                   // 2回目以降は同意済み
  assert.equal(cnt(`select count(*) from constitution_consents where member_id=${q(midOf(B))};`), 1); assert.equal(me(B, NOW).member.constitutionConsent, true);
  ok("同意: 初回は同意なし(false・未指定)だと記録せず consent_required。同意つきで送ると版 constitution_v1 と日時を記録し、2回目以降は同意を求めない");

  // ---- 5. 会員証の情報(今日の五巡茶・あなたのお茶・季節の変化) ----
  const tea = (d) => val(`select public._tea_of_day(${q(d)}::date);`);
  assert.deepEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-25", "2026-12-07", "2027-04-04", "2027-07-25"].map(tea),
    ["metal", "fire", "water", "wood", "metal", "earth", "metal", "earth", "water", "wood", "earth"]);   // 月・日は季節の五行(土用は土)
  const C = sub("c"); reg(C, "会員C", NOW);
  let mc = me(C, NOW).member; assert.equal(mc.todayTea, "wood"); assert.equal(mc.yourTea, null); assert.deepEqual(mc.season, { key: "2026-autumn", element: "metal" });
  assert.equal(mc.todayCondition, null);
  submit(C, ans(0, 0, 0, 5, 1), "noodle", true, "2026-11-30T14:59:59Z");                          // JST 11/30(秋)
  mc = me(C, "2026-11-30T14:59:59Z").member;
  assert.deepEqual(mc.constitution.scores, { wood: 0, fire: 0, earth: 0, metal: 5, water: 1 }); assert.equal(mc.constitution.primary, "metal"); assert.equal(mc.constitution.mood, "noodle");
  assert.equal(mc.constitution.checkedOn, "2026-11-30"); assert.equal(mc.constitution.seasonKey, "2026-autumn"); assert.equal(mc.constitution.seasonChanged, false); assert.equal(mc.yourTea, "metal");
  assert.equal(me(C, "2026-11-30T15:00:00Z").member.constitution.seasonChanged, true);           // JST 12/1(冬)になったら案内
  assert.equal(me(C, "2027-02-28T14:00:00Z").member.constitution.seasonChanged, true);
  submit(C, ans(0, 0, 0, 5, 1), "noodle", true, "2026-10-15T03:00:00Z");
  assert.equal(me(C, "2026-10-25T03:00:00Z").member.constitution.seasonChanged, false);           // 土用は季節の変わり目の案内に数えない(秋のまま)
  assert.equal(me(C, "2026-11-30T15:00:00Z").member.constitution.checkedOn, "2026-11-30");          // 最新の結果を出す
  assert.equal(j(SVC(`select public.app_ticket_cancel(${q(ISS)}, ${q(C)}, now());`)).member.constitution.primary, "metal");   // _member_view を使う他の関数の応答にも入る
  ok("会員証の情報(app_me): 最新の結果の要約(点数・タイプ・気分・実施日)、今日の五巡茶(火=火・水=水・木=木・金=金・土=土、月日=季節。土用は土)、あなたのお茶(タイプの五行)、季節。実施した季節と今の季節が違えば seasonChanged(日本時間。土用では出さない)");

  // ---- 6. 今日の体調(1日1回) ----
  const D = sub("d"); reg(D, "会員D", NOW);
  assert.equal(cond(D, "cold", "tired", "dry", NOW).status, "no_check");
  submit(D, ans(3, 1, 2, 2, 2), "soup", true, NOW);                                                 // 木3・火1・土2・金2・水2
  for (const [t, e, c] of [["warm", "tired", "dry"], ["cold", "ok", "dry"], ["cold", "tired", "wet"], [null, "tired", "dry"]]) assert.equal(cond(D, t, e, c, NOW).status, "invalid_condition");
  let rc = cond(D, "cold", "fine", "none", NOW); assert.equal(rc.status, "ok"); assert.equal(rc.focus, "water");          // 水 2+2=4 が一番
  assert.deepEqual(rc.member.todayCondition, { temp: "cold", energy: "fine", concern: "none", focus: "water" });
  assert.equal(cond(D, "hot", "stress", "dry", NOW).status, "already_answered");
  assert.equal(cond(D, "hot", "stress", "dry", "2026-10-15T14:59:59Z").status, "already_answered");                    // JST ではまだ同じ日
  assert.equal(cnt(`select count(*) from constitution_daily_conditions where member_id=${q(midOf(D))};`), 1);
  rc = cond(D, "normal", "fine", "none", "2026-10-15T15:00:00Z"); assert.equal(rc.status, "ok"); assert.equal(rc.focus, "wood");   // JST 10/16。足し算なし → 木3
  assert.equal(me(D, "2026-10-15T15:00:00Z").member.todayCondition.focus, "wood"); assert.equal(me(D, "2026-10-16T15:00:00Z").member.todayCondition, null);
  rc = cond(D, "normal", "tired", "swelling", "2026-10-17T03:00:00Z"); assert.equal(rc.focus, "earth");                     // 土 2+2+2=6
  rc = cond(D, "hot", "fine", "dry", "2026-10-18T03:00:00Z"); assert.equal(rc.focus, "metal");                             // 火3・金4・木3 → 金
  rc = cond(D, "normal", "stress", "none", "2026-10-19T03:00:00Z"); assert.equal(rc.focus, "wood");                        // 木5
  rc = cond(D, "hot", "fine", "none", "2026-10-20T03:00:00Z"); assert.equal(rc.focus, "wood");                             // 火3・木3 の同点。季節(土用=土)は同点に入らない → 先の木
  ok("今日の体調: 体質チェックの前は記録しない(no_check)。選択肢以外は拒否。日本時間の1日に1回(同じ日の2回目は already_answered・UTC の日付ではなく日本時間)。選んだ五行に2点を足して今日のおすすめの五行を決める(同点の決め方は体質と同じ)");

  // ---- 7. 薬日本堂の漢方相談への案内のクリック ----
  { const E = sub("e"); reg(E, "会員E", NOW);
    assert.deepEqual(click(E, NOW), { status: "ok", recorded: true });                                  // 結果がなくても数える(check_id は空)
    submit(E, ans(0, 0, 4, 0, 0), "soup", true, NOW); assert.equal(click(E, NOW).recorded, true);
    const rows = JSON.parse(val(`select json_agg(json_build_object('c', check_id is not null, 't', target, 'at', clicked_at = ${ts(NOW)}) order by id) from constitution_referral_clicks where member_id=${q(midOf(E))};`));
    assert.deepEqual(rows, [{ c: false, t: "nihondo_consult", at: true }, { c: true, t: "nihondo_consult", at: true }]);
    for (let i = 0; i < 28; i++) click(E, NOW);
    assert.equal(click(E, NOW).recorded, false);                                                         // 1時間に30回を超えた分は数えない
    assert.equal(cnt(`select count(*) from constitution_referral_clicks where member_id=${q(midOf(E))};`), 30);
    assert.equal(click(sub("z"), NOW).status, "not_registered");
    fails(() => ANON(`select public.app_referral_click(${q(ISS)}, ${q(E)}, now());`), /permission denied/);
    fails(() => AS(STAFF.mgr, `select public.app_referral_click(${q(ISS)}, ${q(E)}, now());`), /permission denied/);
    fails(() => AS(STAFF.mgr, `select * from public.constitution_checks;`), /permission denied/);
    fails(() => ANON(`select * from public.constitution_referral_clicks;`), /permission denied/); }
  ok("薬日本堂の案内: 押されたら会員・最新の結果・日時を記録(個人の結果は送らない)。1時間に30回を超えた分は数えない。未登録は記録しない。スタッフ・未ログインからは呼べず、表も直接読めない");

  // ---- 8. 集計の権限(スタッフは今週の体調の傾向だけ) ----
  { const sm = stats(STAFF.staff), sv = stats(STAFF.viewer), sg = stats(STAFF.mgr);
    assert.equal(sm.scope, "limited"); assert.deepEqual(Object.keys(sm).sort(), ["asOf", "scope", "week"]);
    for (const k of ["membersActive", "checkedMembers", "checkRatePercent", "byType", "averages", "revisit", "referralClicks"]) { assert.equal(k in sm, false, k); assert.equal(k in sv, true, k); assert.equal(k in sg, true, k); }
    assert.equal(sv.scope, "full"); assert.equal(sg.scope, "full"); assert.deepEqual(sm.week, sv.week);
    assert.deepEqual(Object.keys(sm.week).sort(), ["answers", "concern", "energy", "focus", "since", "temp", "until"]);
    fails(() => stats(STAFF.kiosk), /forbidden/); fails(() => stats(STAFF.plain), /not_staff/); fails(() => stats(STAFF.gone), /not_staff/);
    fails(() => ANON(`select public.staff_constitution_stats();`), /permission denied/);
    fails(() => SVC(`select public.staff_constitution_stats();`), /permission denied/); }
  ok("集計の権限: 店長・閲覧(本部)はすべて、スタッフは今週の体調の傾向(week)だけで、実施人数・タイプ・平均・再来店率・相談の数は応答に含まれない。店頭タブレット・スタッフ以外・無効のアカウント・未ログインは拒否");

  // ---- 9. 集計の値(試験運用中は試験会員だけ。数を決めたデータで確かめる) ----
  { val(`update system_state set state='test';`);
    const T = [sub("1"), sub("2"), sub("3"), sub("4")];
    for (const s of T) SVC(`select public.allow_test_identity(${q(ISS)}, ${q(s)}, 'test');`);
    const zero = stats(STAFF.mgr);
    assert.equal(zero.membersActive, 0); assert.equal(zero.checkRatePercent, null); assert.equal(zero.averages, null); assert.equal(zero.week.answers, 0);
    assert.deepEqual(zero.revisit.checked, { members: 0, revisitRatePercent: null, avgVisits: null });
    T.forEach((s, i) => reg(s, `試験${i + 1}`));                                                    // 登録した日(今日)は来店扱い(1日)
    const today = val(`select public._jst_date(now());`), vis = (s, days) => val(`insert into visits(member_id, visit_on, source) values (${q(midOf(s))}, ${q(today)}::date - ${days}, 'store_qr');`);
    vis(T[0], 10); vis(T[2], 30); vis(T[2], 70); vis(T[3], 5); vis(T[3], 59); vis(T[3], 60);     // 直近60日 = 今日〜59日前
    submit(T[0], ans(6, 0, 0, 0, 0)); submit(T[0], ans(6, 2, 0, 0, 0));                            // 最新の結果だけを数える(木6・火2)
    submit(T[1], Array(15).fill(0));                                                              // バランス良好
    assert.equal(cond(T[0], "cold", "tired", "dry").status, "ok");
    assert.equal(cond(T[1], "hot", "stress", "none", new Date(Date.now() - 8 * 86400e3).toISOString()).status, "ok");   // 8日前(今週に入らない)
    assert.equal(cond(T[1], "normal", "fine", "swelling", new Date(Date.now() - 6 * 86400e3).toISOString()).status, "ok");  // 6日前(今週に入る)
    click(T[0]); click(T[1], new Date(Date.now() - 70 * 86400e3).toISOString());                 // 70日前=前の月以前
    const st = stats(STAFF.mgr);
    assert.equal(st.membersActive, 4); assert.equal(st.checkedMembers, 2); assert.equal(st.checkRatePercent, 50);
    assert.deepEqual(st.byType, { wood: 1, fire: 0, earth: 0, metal: 0, water: 0, balanced: 1 });
    assert.deepEqual(st.averages, { wood: 3, fire: 1, earth: 0, metal: 0, water: 0 });
    assert.deepEqual(st.revisit, { windowDays: 60, checked: { members: 2, revisitRatePercent: 50, avgVisits: 1.5 }, unchecked: { members: 2, revisitRatePercent: 100, avgVisits: 2.5 } });
    assert.deepEqual(st.referralClicks, { total: 2, thisMonth: 1 });
    assert.equal(st.week.answers, 2); assert.equal(st.week.until, today);
    assert.deepEqual(st.week.temp, { cold: 1, hot: 0, normal: 1 }); assert.deepEqual(st.week.energy, { tired: 1, stress: 0, fine: 1 }); assert.deepEqual(st.week.concern, { dry: 1, swelling: 1, none: 0 });
    assert.equal(Object.values(st.week.focus).reduce((a, b) => a + b, 0), 2);
    assert.equal(stats(STAFF.staff).week.answers, 2); assert.equal("checkedMembers" in stats(STAFF.staff), false);
    // 本番会員の数は混ざらない(open に戻すと本番会員だけ)
    val(`update system_state set state='open';`);
    const live = stats(STAFF.viewer);
    assert.equal(live.membersActive, cnt(`select count(*) from members where not is_test and status='active';`));
    assert.equal(live.checkedMembers, cnt(`select count(distinct c.member_id) from constitution_checks c join members m on m.id=c.member_id where not m.is_test;`));
    assert.equal(live.referralClicks.total, cnt(`select count(*) from constitution_referral_clicks k join members m on m.id=k.member_id where not m.is_test;`)); }
  ok("集計の値: 実施人数・実施率(有効会員のうち)・タイプ別(会員ごとの最新の結果。バランス良好は別)・五行ごとの平均・再来店率(直近60日に来店2日以上)と来店頻度の比較・相談ボタンの数(累計・今月)・今週(直近7日)の体調の傾向。いまの状態の会員だけを数える(試験運用中は試験会員だけ)。0件のときは率と平均を空(null)にする");

  // ---- 10. 凍結中は止まる ----
  SVC(`select public.set_system_state('frozen');`);
  fails(() => submit(A, ans(1, 1, 1, 1, 1)), /maintenance/); fails(() => cond(A, "cold", "tired", "dry"), /maintenance/); fails(() => click(A), /maintenance/);
  assert.equal(stats(STAFF.viewer).scope, "full");                                                   // 集計は見られる(読み取りだけ)
  val(`update system_state set state='open';`);
  ok("凍結中は体質チェック・今日の体調・案内のクリックの記録が止まる(maintenance)。集計は読み取りだけなので見られる");

  // ---- 11. バックアップ/復元 ----
  { const bk = val(`set role service_role; select public.export_backup();`).split("\n").pop(); const b = JSON.parse(bk);
    for (const t of TABLES) assert.equal(b.tables[t].length, cnt(`select count(*) from ${t};`), t);
    assert.ok(b.tables.constitution_checks.length > 20); assert.ok(b.tables.app_settings.some((x) => x.key === "constitution_moods"));
    const fresh = (db) => { pg.createDb(db); pg.execIn(db, STUB); for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql"]) pg.loadFileIn(db, f);
      pg.execIn(db, `insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};`); };
    fresh("t2");
    const rs = JSON.parse(pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`).split("\n").pop()); assert.equal(rs.status, "restored"); assert.equal(rs.balanceMismatches, 0);
    for (const t of TABLES) assert.equal(pg.execIn("t2", `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from ${t} x;`), val(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from ${t} x;`), t);
    pg.execIn("t2", `update system_state set state='open';`);
    const m2 = JSON.parse(pg.execIn("t2", `set role service_role; select public.app_me(${q(ISS)}, ${q(C)}, '2026-11-30T15:00:00Z');`).split("\n").pop()).member;
    assert.deepEqual(m2.constitution, me(C, "2026-11-30T15:00:00Z").member.constitution);
    const E = sub("e"); pg.execIn("t2", `set role service_role; select public.app_referral_click(${q(ISS)}, ${q(E)}, '2030-01-01T00:00:00Z');`);   // 復元後もクリックの連番が続く(重複しない)
    assert.equal(pg.execIn("t2", `select count(distinct id) = count(*) from constitution_referral_clicks;`), "t");
    fails(() => pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`), /target_not_empty/);
    // 103 より前(体質チェックの表がない)のバックアップも復元できる
    const old = { ...b, tables: { ...b.tables } }; for (const t of TABLES) delete old.tables[t];
    old.tables.app_settings = old.tables.app_settings.filter((x) => x.key !== "constitution_moods");
    fresh("t3");
    const r3 = JSON.parse(pg.execIn("t3", `set role service_role; select public.restore_backup(${q(JSON.stringify(old))}::jsonb);`).split("\n").pop());
    assert.equal(r3.status, "restored"); for (const t of TABLES) assert.equal(pg.execIn("t3", `select count(*) from ${t};`), "0");
    assert.equal(pg.execIn("t3", `select value from app_settings where key='constitution_moods';`), "okayu,soup,nabe_solo,noodle,nabe_share");
    // 体質チェックの結果だけがある DB には復元しない(上書きしない)
    fresh("t4"); pg.execIn("t4", `insert into members(member_no) values ('user99999');`);
    pg.execIn("t4", `insert into constitution_checks(member_id, answers, mood, score_wood, score_fire, score_earth, score_metal, score_water, primary_element, balanced, season_key, season_element, created_at)
      select id, '{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}', 'soup', 0,0,0,0,0, 'metal', true, '2026-autumn', 'metal', now() from members;`);
    fails(() => pg.execIn("t4", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`), /target_not_empty/); }
  ok("バックアップ/復元: 同意・結果・今日の体調・案内のクリックもバックアップに入り、空の DB に同じ内容で復元できる(会員証の表示も同じ・クリックの連番も続く)。103 より前のバックアップも復元できる。空でない DB には復元しない");
  console.log(`\n${n} constitution tests passed`);
} finally { pg.stop(); }
