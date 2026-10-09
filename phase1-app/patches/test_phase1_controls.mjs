// フェーズ1: 切替・試験分離・方針ゲート・kiosk・バックアップ/復元訓練を、本番相当スキーマ(000+003)の上の実 PostgreSQL 16 で検証する。本番には接続しない。
// 実行: node --experimental-strip-types test_phase1_controls.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053";
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
const U = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2", kiosk: "00000000-0000-0000-0000-0000000000f6" };
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const AS = (uid, sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const fails = (fn, re) => { try { fn(); } catch (e) { assert.match(String(e.message), re, e.message); return; } assert.fail("expected failure " + re); };
const val = (sql) => pg.exec(sql);
const reg = (s, name = "会員", now = "2026-12-01T03:00:00Z") => j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, ${q(now)}::timestamptz);`));
const me = (s, now = "2026-12-01T03:00:00Z") => j(SVC(`select public.app_me(${q(ISS)}, ${q(s)}, ${q(now)}::timestamptz);`));
const chk = (s, now) => j(SVC(`select public.app_checkin(${q(ISS)}, ${q(s)}, null::bigint, ${q(now)}::timestamptz);`));
const rr = (s, pts, now = "2026-12-01T03:00:00Z") => j(SVC(`select public.app_redeem_request(${q(ISS)}, ${q(s)}, ${pts}, ${q(now)}::timestamptz);`));
const state = () => val(`select state from system_state;`);
const setState = (to, att = "null") => j(SVC(`select public.set_system_state(${q(to)}, ${att});`));
const imp = (no, s, bal, life = "null") => j(SVC(`select public.import_opening_balance(${q(no)}, '移行', ${q(ISS)}, ${s ? q(s) : "null"}, ${bal}, ${life}::integer, '2026-09-30'::date, 'sheet 2026-10-09', '2026-10-09T00:00:00Z');`));
const dp = (k, v) => j(SVC(`select public.decide_policy(${q(k)}, ${q(v)}, '事業責任者の返信(試験用の仮)');`));
const exp = (arr) => q(JSON.stringify(arr)) + "::jsonb";
const recon = (arr) => j(SVC(`select public.reconcile_balances(${exp(arr)});`));

try {
  pg.loadFile("000_prodlike_schema.sql");
  pg.exec(`create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role; grant select on auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.exec(`insert into stores(name) values('10ZEN');`);
  pg.loadFile("003_membership_checkin_rpc.sql");
  pg.loadFile("100_phase1_schema.sql");
  pg.exec(`insert into auth.users(id) values ${Object.values(U).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role) values ('${U.mgr}','店長','manager'),('${U.staff}','スタッフ','staff'),('${U.kiosk}','店頭タブレット','kiosk');`);
  const custSnap = () => val(`select md5(coalesce((select string_agg(t::text, '|' order by t::text) from customers t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from interactions t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from membership_events t), ''));`);

  // ---- 1. 既定は frozen ----
  assert.equal(state(), "frozen");
  for (const sql of [`select public.app_register(${q(ISS)}, ${q(sub("a"))}, 'x', null, now());`, `select public.app_me(${q(ISS)}, ${q(sub("a"))}, now());`,
                     `select public.app_checkin(${q(ISS)}, ${q(sub("a"))}, null::bigint, now());`, `select public.app_redeem_request(${q(ISS)}, ${q(sub("a"))}, 100, now());`,
                     `select public.app_redeem_cancel(${q(ISS)}, ${q(sub("a"))}, now());`])
    fails(() => SVC(sql), /maintenance/);
  assert.equal(Number(val(`select count(*) from members;`)), 0);
  ok("既定は frozen: 登録・照会・来店・使用申請・取消はすべて maintenance で拒否され、会員は1件も作られない");

  // ---- 2. 取込み → 照合 → open の順序ゲート ----
  assert.equal(imp("user00001", sub("1"), 10000, "10000").status, "imported");
  assert.equal(imp("user00002", sub("2"), 100).status, "imported");
  assert.equal(imp("user00003", sub("3"), 100).status, "imported");
  fails(() => imp("userXX", null, 1), /invalid_member_no/);
  const good = [{ member_no: "user00001", balance: 10000 }, { member_no: "user00002", balance: 100 }, { member_no: "user00003", balance: 100 }];
  fails(() => setState("open", q("legacy_writes_stopped")), /not_reconciled/);
  let r = recon([{ member_no: "user00001", balance: 9999 }, ...good.slice(1)]);
  assert.equal(r.ok, false); assert.deepEqual(r.mismatches, [{ member_no: "user00001", expected: 9999, actual: 10000 }]);
  r = recon(good.slice(0, 2)); assert.equal(r.ok, false); assert.deepEqual(r.extraInDb, ["user00003"]);
  r = recon([...good, { member_no: "user00009", balance: 5 }]); assert.equal(r.ok, false); assert.deepEqual(r.missingInDb, ["user00009"]);
  fails(() => setState("open", q("legacy_writes_stopped")), /not_reconciled/);
  assert.equal(recon(good).ok, true);
  ok("照合: 残高の不一致・DBに無い会員・期待値に無い会員のどれでも不一致になり open へ進めない。全件一致のときだけ reconciled");
  assert.equal(imp("user00003", sub("3"), 100).status, "already_imported");
  assert.equal(val(`select reconciled from system_state;`), "f");
  ok("取込みをやり直すと reconciled が外れる(照合し直すまで open に進めない)");

  recon(good);
  fails(() => setState("open", q("legacy_writes_stopped")), /policies_undecided:campaign,lifetime,migration_scope,redeem_unit,referral,register_counts_as_visit/);
  ok("未決定の方針が1つでも残っていると open へ進めない(事業責任者の回答なしに制度を確定しない)");
  fails(() => dp("redeem_unit", "abc"), /invalid_value/); fails(() => dp("nope", "1"), /unknown_policy/);
  fails(() => SVC(`select public.decide_policy('campaign', 'on', '');`), /via_required/);
  assert.equal(dp("redeem_unit", "50").status, "ok"); assert.equal(val(`select value from app_settings where key='redeem_unit';`), "50");
  dp("referral", "off"); assert.equal(Number(val(`select count(*) from point_rules where code like 'referral%' and active;`)), 0);
  dp("register_counts_as_visit", "false"); assert.equal(val(`select value from app_settings where key='register_counts_as_visit';`), "false");
  dp("campaign", "off"); assert.equal(val(`select active from point_rules where code='campaign_welcome';`), "f");
  dp("lifetime", "use_floor_estimate"); dp("migration_scope", "LINE連携済みの3名");
  assert.equal(val(`select count(*) from policy_decisions where not decided;`), "0");
  ok("方針の回答は設定へ反映される(使用単位・紹介・登録日の来店扱い・キャンペーン)。値の検証・回答の出所の必須あり");
  fails(() => setState("open"), /legacy_stop_not_attested/); fails(() => setState("open", q("yes")), /legacy_stop_not_attested/);
  ok("open へは『旧システムの書込み停止の確認』が必須(確認なしは拒否)");

  // ---- 3. 試験(test)の分離: 既存 customers / interactions / membership_events に一切触れない ----
  assert.equal(setState("test").state, "test");
  fails(() => imp("user00010", null, 1), /import_requires_frozen/);
  const before = val(`select md5(coalesce((select string_agg(t::text, '|' order by t::text) from customers t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from interactions t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from membership_events t), ''));`);
  const TESTER = sub("t");
  fails(() => reg(TESTER), /maintenance/);
  SVC(`select public.allow_test_identity(${q(ISS)}, ${q(TESTER)}, '店長の端末');`);
  const t1 = reg(TESTER, "試験者"); assert.equal(t1.status, "created"); assert.match(t1.member.memberNo, /^T\d{5}$/);
  fails(() => me(sub("1")), /maintenance/);                                  // 許可外(本番の会員 user00001 の LINE ID でも)は拒否
  SVC(`select public.allow_test_identity(${q(ISS)}, ${q(sub("1"))}, '店長が本番会員でもある場合の試験');`);
  const t2 = reg(sub("1"), "店長(試験)"); assert.equal(t2.status, "created"); assert.match(t2.member.memberNo, /^T\d{5}$/);
  assert.equal(val(`select balance from members where member_no='user00001';`), "10000");                 // 同じ LINE ID でも本番会員とは別の人格。本番の残高は不変
  assert.equal(chk(TESTER, "2026-12-01T03:00:00Z").status, "counted");                                    // 登録日の扱い=false → 来店pt付与
  assert.equal(chk(TESTER, "2026-12-01T05:00:00Z").status, "already_today");
  const rq = rr(TESTER, 50); assert.equal(rq.status, "pending");
  const code = rq.member.pendingRedeem.code;
  // スタッフ画面: test のときは試験会員だけが見え、本番会員は見えない・触れない
  const lst = j(AS(U.staff, `select public.staff_list_members(null, 50, 0);`)); assert.deepEqual(lst.items.map((x) => x.memberNo).sort(), ["T00001", "T00002"]);
  const realId = val(`select id from members where member_no='user00001';`);
  assert.equal(j(AS(U.staff, `select public.staff_member_detail('${realId}');`)).status, "not_found");
  fails(() => AS(U.mgr, `select public.manager_adjust('${realId}', 100, '試験中の誤操作', 'adjust-test-0001');`), /maintenance/);
  const lk = j(AS(U.staff, `select public.staff_lookup_redeem('${code}');`)); assert.equal(lk.status, "ok");
  assert.equal(j(AS(U.staff, `select public.staff_confirm_redeem('${lk.request.id}');`)).status, "confirmed");
  const dash = j(AS(U.staff, `select public.staff_dashboard();`)); assert.equal(dash.membersActive, 2); assert.equal(dash.state, "test");
  // 本番データへの影響なし: 既存 customers / interactions / membership_events は1文字も変わらない。本番会員の残高・台帳も変わらない
  const after = val(`select md5(coalesce((select string_agg(t::text, '|' order by t::text) from customers t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from interactions t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from membership_events t), ''));`);
  assert.equal(after, before);
  assert.equal(Number(val(`select count(*) from customers where line_user_id in (${q(TESTER)}, ${q(sub("1"))});`)), 0);
  assert.equal(Number(val(`select count(*) from members where not is_test;`)), 3);
  assert.equal(val(`select count(*) from point_ledger l join members m on m.id=l.member_id where not m.is_test;`), "3");
  ok("試験(test): 許可リストのLINE IDだけが別名前空間の試験会員(T番号)として登録・来店・使用でき、スタッフ画面も試験会員だけが対象。既存 customers/interactions/membership_events と本番会員の残高・台帳は1件も変わらない(同じLINE IDが本番会員でも別人格)");

  // 試験を終えて frozen に戻す: 本番の照合は試験データを含まず一致する
  assert.equal(setState("frozen").state, "frozen");
  assert.equal(recon(good).ok, true);
  assert.equal(Number(val(`select count(*) from members where is_test;`)), 2);
  ok("試験後の扱い: 試験会員・台帳は削除せず『試験』印のまま保持(集計・照合・既存顧客データからは除外)。本番の残高照合は試験データと無関係に一致");

  // ---- 4. open の後 ----
  const pendingTest = (() => { setState("test"); const x = rr(TESTER, 50, "2026-12-01T06:00:00Z"); setState("frozen"); recon(good); return x.member.pendingRedeem.code; })();
  assert.equal(setState("open", q("legacy_writes_stopped")).state, "open");
  fails(() => setState("test"), /transition_not_allowed/);
  assert.equal(me(TESTER).status, "not_registered");                          // open では試験会員に誰も到達できない
  assert.equal(j(AS(U.staff, `select public.staff_lookup_redeem('${pendingTest}');`)).status, "not_found");
  const tid = val(`select id from redeem_requests where code='${pendingTest}';`);
  fails(() => AS(U.staff, `select public.staff_confirm_redeem('${tid}');`), /maintenance/);
  const lst2 = j(AS(U.staff, `select public.staff_list_members(null, 50, 0);`)); assert.equal(lst2.total, 3);
  const nb = reg(sub("n"), "新規の本番会員", "2026-12-02T03:00:00Z"); assert.equal(nb.status, "created"); assert.match(nb.member.memberNo, /^user\d{5}$/);
  // 登録日を来店扱いにしない(方針 register_counts_as_visit=false)ので、自宅での登録は既存 customers(来店回数・最終来店日)を作らない・変えない
  assert.equal(Number(val(`select count(*) from customers where line_user_id=${q(sub("n"))};`)), 0);
  assert.equal(Number(val(`select count(*) from audit_log where action='mirror_failed';`)), 0);
  ok("open: 試験会員には誰も到達できず(照会は未登録扱い・スタッフの確認も不可)、本番会員の登録は(登録日を来店扱いにしない方針のとき)customers を作らない");
  assert.equal(setState("frozen").state, "frozen"); assert.equal(val(`select reconciled from system_state;`), "f");
  fails(() => reg(sub("z")), /maintenance/);
  fails(() => setState("open", q("legacy_writes_stopped")), /not_reconciled/);
  ok("切戻し(open→frozen): 新側の書込みが即座に止まり、再開(open)には照合のやり直しが必須");
  recon([...good, { member_no: "user00004", balance: 100 }]);   // 切替後に増えた会員 user00004(新規登録) を含む期待値
  setState("open", q("legacy_writes_stopped"));

  { // 切戻し用の増減レポート: 開始残高との差が、切替後の操作(登録・来店・使用)と一致する
    const rep = j(SVC(`select public.cutover_report();`)); const byNo = Object.fromEntries(rep.members.map((x) => [x.memberNo, x]));
    assert.equal(rep.state, "open"); assert.deepEqual([byNo.user00001.opening, byNo.user00001.delta, byNo.user00001.entriesAfterOpening], [10000, 0, 0]);
    assert.deepEqual([byNo.user00004.opening, byNo.user00004.balance, byNo.user00004.delta], [null, 100, 100]);   // 切替後に新規登録した会員(開始残高なし)
    assert.ok(!JSON.stringify(rep).includes("T0000")); }   // 試験会員は含まない
  ok("切戻し用レポート(cutover_report): 本番会員ごとに開始残高・現在残高・切替後の増減を返す(試験会員は含まない)");

  // ---- 5. 営業時間外のQR ----
  SVC(`update app_settings set value='9' where key='checkin_open_hour'; update app_settings set value='21' where key='checkin_close_hour';`);
  const B = sub("n");
  assert.equal(chk(B, "2026-12-02T23:59:00Z").status, "outside_hours");        // JST 08:59
  assert.equal(chk(B, "2026-12-03T12:00:00Z").status, "outside_hours");        // JST 21:00
  assert.equal(chk(B, "2026-12-03T03:00:00Z").status, "counted");              // JST 12:00
  SVC(`update app_settings set value='0' where key='checkin_open_hour'; update app_settings set value='24' where key='checkin_close_hour';`);
  ok("営業時間外(設定した時間帯の外)のQRは来店として扱わない(境界: 08:59 / 21:00 は拒否、12:00 は付与)");

  assert.equal(Number(val(`select visit_count from customers where line_user_id=${q(B)};`)), 1);   // 実際の店頭QRの来店で初めて customers が作られ、来店回数は1
  ok("登録日を来店扱いにしない設定: 登録だけでは customers に来店回数・最終来店日が作られず、最初の店頭QRの来店で1になる");

  // 照合済みの後で残高を変えると、照合済みは無効になる(調整・使用の取り消しの両方)。再照合なしに open へ進めない
  const rq5 = rr(B, 100, "2026-12-01T06:00:00Z"); const code5 = rq5.member.pendingRedeem.code;
  const lk5 = j(AS(U.staff, `select public.staff_lookup_redeem('${code5}');`)); assert.equal(j(AS(U.staff, `select public.staff_confirm_redeem('${lk5.request.id}');`)).status, "confirmed");
  setState("frozen");
  const all = () => JSON.parse(val(`select json_agg(json_build_object('member_no', member_no, 'balance', balance)) from members where not is_test;`));
  const m4a = val(`select id from members where member_no='user00004';`);
  assert.equal(recon(all()).ok, true); assert.equal(val(`select reconciled from system_state;`), "t");
  assert.equal(j(AS(U.mgr, `select public.manager_adjust('${m4a}', 10, '照合後の調整', 'repair-key-0000');`)).status, "ok");
  assert.equal(val(`select reconciled from system_state;`), "f"); fails(() => setState("open", q("legacy_writes_stopped")), /not_reconciled/);
  assert.equal(recon(all()).ok, true);
  assert.equal(j(AS(U.mgr, `select public.manager_adjust('${m4a}', 10, '照合後の調整', 'repair-key-0000');`)).status, "duplicate");   // 重複(変化なし)は無効にしない
  assert.equal(val(`select reconciled from system_state;`), "t");
  assert.equal(j(AS(U.mgr, `select public.manager_reverse_redeem('${lk5.request.id}', '照合後の取り消し');`)).status, "reversed");
  assert.equal(val(`select reconciled from system_state;`), "f"); fails(() => setState("open", q("legacy_writes_stopped")), /not_reconciled/);
  ok("照合の後に店長が残高を変える(調整・使用の取り消し)と照合済みが無効になり、再照合するまで open に戻せない。変化のない重複の再送は無効にしない");
  // ---- 5b. 凍結中の復旧: 店長の調整だけが通り(理由必須・監査記録つき)、顧客の操作は通らない。open に戻すと customers も追従 ----
  const m4 = val(`select id from members where member_no='user00004';`);
  fails(() => AS(U.staff, `select public.manager_adjust('${m4}', 50, '凍結中の訂正', 'repair-key-0001');`), /forbidden/);
  fails(() => reg(sub("z")), /maintenance/); fails(() => me(B), /maintenance/);
  fails(() => AS(U.mgr, `select public.manager_adjust('${m4}', 50, '', 'repair-key-0002');`), /reason_required/);
  const cpt0 = Number(val(`select points from customers where line_user_id=${q(B)};`));
  assert.equal(j(AS(U.mgr, `select public.manager_adjust('${m4}', 50, '集計ミスの訂正(復旧作業)', 'repair-key-0003');`)).status, "ok");
  assert.equal(j(AS(U.mgr, `select public.manager_adjust('${m4}', 50, '集計ミスの訂正(復旧作業)', 'repair-key-0003');`)).status, "duplicate");
  const au = JSON.parse(val(`select meta from audit_log where action='adjust' order by id desc limit 1;`)); assert.equal(au.state, "frozen"); assert.match(au.reason, /復旧/);
  const bal4 = Number(val(`select balance from members where member_no='user00004';`));
  assert.equal(Number(val(`select points from customers where line_user_id=${q(B)};`)), cpt0);   // 凍結中は customers に反映されない(変わらない)
  fails(() => setState("open", q("legacy_writes_stopped")), /not_reconciled/);
  const cur = JSON.parse(val(`select json_agg(json_build_object('member_no', member_no, 'balance', balance)) from members where not is_test;`));
  assert.equal(recon(cur).ok, true);
  setState("open", q("legacy_writes_stopped"));
  assert.equal(Number(val(`select points from customers where line_user_id=${q(B)};`)), bal4);         // open に戻すと customers も追従
  ok("凍結中の復旧: 店長の理由つき調整だけが通り(スタッフ・顧客は拒否・冪等・監査記録に state=frozen)、照合してから open に戻すと customers のポイントも追従する");

  // ---- 6. kiosk(店頭QR表示専用) ----
  assert.deepEqual(j(AS(U.kiosk, `select public.staff_whoami();`)), { active: true, role: "kiosk", displayName: "店頭タブレット" });
  for (const sql of [`select public.staff_dashboard();`, `select public.staff_list_members(null, 5, 0);`, `select public.staff_today_visits();`, `select public.staff_lookup_redeem('000000');`,
                     `select public.staff_confirm_redeem(gen_random_uuid());`, `select public.staff_cancel_redeem(gen_random_uuid());`, `select public.staff_member_detail(gen_random_uuid());`,
                     `select public.manager_adjust(gen_random_uuid(), 1, 'x', 'adjust-kiosk-0001');`, `select public.manager_reverse_redeem(gen_random_uuid(), 'x');`])
    fails(() => AS(U.kiosk, sql), /forbidden/);
  fails(() => AS(U.kiosk, `select * from members;`), /permission denied/);
  ok("kiosk: 店頭QRの表示以外は何もできない(会員情報・来店一覧・ポイント使用・調整の全RPCが forbidden。表への直接参照も不可)");

  // ---- 7. バックアップ → 空のDBへ復元(復元訓練) ----
  assert.equal(j(AS(U.staff, `select public.staff_dashboard();`)).backupStale, true);
  const payload = val(`select public.export_backup();`);
  SVC(`select public.record_backup(false, null, null, 'テスト: 失敗した実行');`);
  assert.equal(j(AS(U.staff, `select public.staff_dashboard();`)).backupStale, true);        // 失敗した実行は『最後の成功』にならない
  SVC(`select public.record_backup(true, 'abc', '{"members": 5}'::jsonb, 'ok');`);
  const dsh = j(AS(U.staff, `select public.staff_dashboard();`)); assert.equal(dsh.backupStale, false); assert.ok(dsh.lastBackupAt);
  assert.deepEqual(dsh.undecidedPolicies, []);
  pg.createDb("t2");
  pg.execIn("t2", `create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role; grant select on auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users(id) values ('${U.mgr}');`);
  pg.loadFileIn("t2", "100_phase1_schema.sql");
  const rs = JSON.parse(pg.execIn("t2", `set role service_role;\nselect public.restore_backup(${q(payload)}::jsonb);`).split("\n").filter(Boolean).pop());
  assert.deepEqual([rs.status, rs.balanceMismatches, rs.state], ["restored", 0, "frozen"]);
  const T = (db, t) => (db === "t1" ? val : (x) => pg.execIn("t2", x))(`select coalesce(jsonb_agg(to_jsonb(t)), '[]') from (select * from public.${t} order by 1) t;`);
  for (const t of ["members", "member_identities", "visits", "redeem_requests", "app_settings", "point_rules", "rank_thresholds", "policy_decisions"])
    assert.equal(JSON.stringify(JSON.parse(T("t1", t))), JSON.stringify(JSON.parse(T("t2", t))), t + " が一致");
  assert.equal(JSON.stringify(JSON.parse(T("t1", "point_ledger"))), JSON.stringify(JSON.parse(T("t2", "point_ledger"))));
  assert.equal(pg.execIn("t2", `select count(*) from public.verify_balances();`), "0");
  assert.equal(pg.execIn("t2", `select count(*) from public.staff_users;`), "1");           // Auth に存在するユーザーのみ復元(店長)
  assert.equal(pg.execIn("t2", `select state from public.system_state;`), "frozen");
  fails(() => pg.execIn("t2", `set role service_role;\nselect public.restore_backup(${q(payload)}::jsonb);`), /target_not_empty/);
  fails(() => pg.execIn("t2", `update public.point_ledger set points = 1 where id = (select min(id) from public.point_ledger);`), /append-only/);
  // 連番が続く: 復元後の新規会員番号・台帳IDが重複しない
  assert.equal(pg.execIn("t2", `select public.next_member_no();`), "user00005");
  assert.equal(pg.execIn("t2", `select public.next_test_member_no();`), "T00003");
  pg.execIn("t2", `insert into public.point_ledger(member_id, entry_type, rule_code, points, balance_after, idempotency_key, source, occurred_at) select id, 'adjust', 'manual', 1, balance + 1, 'post-restore-1', 'manager', now() from public.members where member_no='user00001';`);
  ok("復元訓練: 全データ+設定(会員・本人確認・台帳・来店・使用申請・制度の値・方針・試験会員)を空のDBへ復元でき、件数と全行が一致。残高=台帳、復元直後は frozen、台帳は追記専用のまま、連番も続き、既に会員がいるDBへの復元は拒否");

  // ---- 10. 会員 0 名で開始する場合(サンプルを移行しない): 取込みなしで、照合→方針の回答→open まで進める ----
  { fails(() => dp("lifetime", "not_applicable"), /lifetime_needed_for_imported_members/);   // 取込み済みの会員がいるDBでは使えない
    pg.createDb("t3");
    pg.execIn("t3", `create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      grant usage on schema auth to anon, authenticated, service_role; grant select on auth.users to service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
    pg.loadFileIn("t3", "100_phase1_schema.sql");
    const X = (sql) => pg.execIn("t3", `set role service_role;\n${sql}`);
    const lastJ = (t) => JSON.parse(t.split("\n").filter(Boolean).pop());
    assert.throws(() => X(`select public.set_system_state('open','legacy_writes_stopped');`), /not_reconciled/);
    assert.equal(lastJ(X(`select public.reconcile_balances('[]'::jsonb);`)).ok, true);                  // 期待値も DB も空 → 一致
    assert.throws(() => X(`select public.set_system_state('open','legacy_writes_stopped');`), /policies_undecided:campaign,lifetime,migration_scope,redeem_unit,referral,register_counts_as_visit/);
    for (const [k, v] of [["redeem_unit", "100"], ["referral", "off"], ["register_counts_as_visit", "false"], ["campaign", "off"], ["lifetime", "not_applicable"], ["migration_scope", "なし(会員0名で開始。サンプルは削除)"]])
      assert.equal(lastJ(X(`select public.decide_policy(${q(k)}, ${q(v)}, '事業責任者の返信');`)).status, "ok");
    assert.equal(lastJ(X(`select public.set_system_state('open','legacy_writes_stopped');`)).state, "open");
    assert.equal(X(`select value from public.app_settings where key='register_counts_as_visit';`).split("\n").pop(), "false");
    assert.equal(X(`select count(*) from public.point_rules where active and code in ('campaign_welcome','referral_referrer','referral_welcome');`).split("\n").pop(), "0");
    // 開始後は登録でき、登録ボーナスのみ(来店ポイントは店頭QRの日から)
    const r0 = lastJ(X(`select public.app_register('2011158053', ${q(sub("v"))}, '初回', null, '2026-12-01T03:00:00Z'::timestamptz);`));
    assert.equal(r0.member.points, 100); assert.equal(r0.member.memberNo, "user00001"); }
  ok("会員 0 名で開始(取込みなし): 照合(空=空)→方針6件の回答(lifetime=not_applicable)→open まで進め、制度の値(使用単位100・紹介/キャンペーン停止・登録日は来店扱いなし)が反映され、最初の会員は user00001 で登録ボーナス100のみ");

  // ---- 8. 権限: 管理系の関数は service_role 専用 ----
  for (const f of ["set_system_state('open','legacy_writes_stopped')", "reconcile_balances('[]'::jsonb)", "decide_policy('campaign','on','x')", "allow_test_identity('a','b','c')", "export_backup()", "restore_backup('{}'::jsonb)", "record_backup(true,'x',null,'x')", "cutover_report()"]) {
    fails(() => AS(U.mgr, `select public.${f};`), /permission denied/);
    fails(() => pg.exec(`set role anon;\nselect public.${f};`), /permission denied/);
  }
  fails(() => AS(U.mgr, `select * from public.system_state;`), /permission denied/);
  fails(() => AS(U.mgr, `select * from public.backup_runs;`), /permission denied/);
  ok("切替・照合・方針・許可リスト・バックアップ/復元は service_role 専用(店長でも匿名でも呼べない。状態・バックアップ履歴の表も直接は読めない)");
  // ---- 9. 凍結と処理中の書込みの同期(別接続の並列) ----
  { assert.equal(state(), "open");
    const mem = []; for (let i = 0; i < 12; i++) { const sj = sub(String.fromCharCode(97 + i) + "q"); reg(sj, "並列" + i, "2026-12-08T03:00:00Z"); mem.push(sj); }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D1 = "2026-12-10T03:00:00Z";   // 登録の翌々日(来店が付く日)
    const t0 = Date.now();
    // A: 状態を確認して書込み中(2秒保持)。F: その最中に凍結を要求。D: F が待っている間に来た新しい書込み
    const A = pg.runAsync(`set role service_role;\nbegin;\nselect public.app_checkin(${q(ISS)}, ${q(mem[0])}, null::bigint, ${q(D1)}::timestamptz);\nselect pg_sleep(2);\ncommit;`);
    await sleep(700);
    const F = pg.runAsync(`set role service_role;\nselect public.set_system_state('frozen');`).then((r) => ({ ...r, at: Date.now() - t0 }));
    await sleep(500);
    const Dr = pg.runAsync(`set role service_role;\nselect public.app_checkin(${q(ISS)}, ${q(mem[1])}, null::bigint, ${q(D1)}::timestamptz);`).then((r) => ({ ...r, at: Date.now() - t0 }));
    const [ra, rf, rd] = await Promise.all([A, F, Dr]);
    assert.equal(ra.status, 0, ra.stderr); assert.equal(rf.status, 0, rf.stderr);
    assert.ok(rf.at >= 1800, "凍結は先行する書込みの完了を待つ: " + rf.at + "ms");        // A は約2.7秒で終わる
    assert.notEqual(rd.status, 0); assert.match(rd.stderr, /maintenance/);                     // 凍結を待っていた間に来た書込みは、凍結後の状態で拒否
    assert.equal(val(`select count(*) from point_ledger l join members m on m.id=l.member_id join member_identities i on i.member_id=m.id where i.subject=${q(mem[0])} and l.rule_code='visit';`), "1");   // 先行した書込みは完了している
    assert.equal(val(`select count(*) from point_ledger l join member_identities i on i.member_id=l.member_id where i.subject=${q(mem[1])} and l.rule_code='visit';`), "0");   // 凍結後の書込みは1件もない
    assert.equal(state(), "frozen");
    // 凍結後にスタッフの書込み(店長の調整)と顧客の書込みを同時に投げても、顧客側は通らない
    // 同時多発: 開き直して、10件の来店と凍結・再開を同時に投げる。デッドロックや不整合が出ない(各結果は成功か maintenance のどちらか)
    recon(JSON.parse(val(`select json_agg(json_build_object('member_no', member_no, 'balance', balance)) from members where not is_test;`)));
    setState("open", q("legacy_writes_stopped"));
    const D2 = "2026-12-11T03:00:00Z";
    const jobs = mem.slice(2).map((sj) => pg.runAsync(`set role service_role;\nselect public.app_checkin(${q(ISS)}, ${q(sj)}, null::bigint, ${q(D2)}::timestamptz);`));
    jobs.push(pg.runAsync(`set role service_role;\nselect public.set_system_state('frozen');`));
    const rs = await Promise.all(jobs);
    for (const r of rs) assert.ok(r.status === 0 || /maintenance/.test(r.stderr), "deadlock などの想定外の失敗: " + r.stderr);
    assert.ok(!rs.some((r) => /deadlock/i.test(r.stderr)));
    assert.equal(state(), "frozen");
    const done = Number(val(`select count(*) from visits where visit_on='2026-12-11' and source='store_qr';`)), refused = rs.slice(0, -1).filter((r) => r.status !== 0).length;
    assert.equal(done + refused, mem.length - 2);                                              // 成功した分だけ記録され、拒否された分は記録がない
    assert.equal(Number(val(`select count(*) from public.verify_balances();`)), 0);
    // 凍結が完了した後に始まる書込みは、1件も記録されない
    const after = await pg.runAsync(`set role service_role;\nselect public.app_checkin(${q(ISS)}, ${q(mem[11])}, null::bigint, '2026-12-12T03:00:00Z'::timestamptz);`);
    assert.match(after.stderr, /maintenance/);
    recon(JSON.parse(val(`select json_agg(json_build_object('member_no', member_no, 'balance', balance)) from members where not is_test;`)));
    setState("open", q("legacy_writes_stopped")); }
  ok("凍結と処理中の書込みの同期(別接続): 凍結操作は先行して処理中の書込みの完了を待ち、待っている間に来た書込みと凍結後の書込みは1件も記録されない。来店10件と凍結の同時投入でもデッドロックなし・残高=台帳");

  { // 全関数の実行権限の総点検: 新しい関数すべてについて、匿名は実行不可。ログイン済み(authenticated)が実行できるのはスタッフ向けの関数だけ
    const rows = JSON.parse(val(`select json_agg(json_build_object('f', p.proname, 'anon', has_function_privilege('anon', p.oid, 'execute'), 'auth', has_function_privilege('authenticated', p.oid, 'execute'), 'svc', has_function_privilege('service_role', p.oid, 'execute'))) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.proname not in ('assign_experiment_group','maybe_fail','record_membership_checkin','sync_membership_points') and p.proname not like '%membership%' and p.proname not in ('legacy_fn');`));
    assert.ok(rows.length >= 44, "new functions found: " + rows.length);
    for (const r of rows) {
      assert.equal(r.anon, false, `anon が実行できる: ${r.f}`);
      const staffSide = /^(staff_|manager_)/.test(r.f) || r.f === "_staff_role";
      assert.equal(r.auth, staffSide, `authenticated の実行可否が想定と違う: ${r.f}`);
    } }
  ok("全関数の実行権限の総点検: 新しい関数すべてで匿名は実行不可、ログイン済みが実行できるのはスタッフ向け(staff_* / manager_* / _staff_role)だけ");
  console.log(`\n${n} phase1 controls tests passed`);
} finally { pg.stop(); }
