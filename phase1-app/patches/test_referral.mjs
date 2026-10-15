// 友だち紹介と月次レポート(db/106_referral.sql)を、実 PostgreSQL 16 で検証する。本番には接続しない。データはすべて擬似(実在の会員・売上・客数ではない)。
// 対象: 適用/戻し・権限、招待コード、紹介の記録(暦月5人まで・日本時間の月の境目・同時の登録)、自分自身・停止中・試験/本番の区分の違うコードの拒否、
//       旧ルール(登録時に双方へ 100pt)の廃止、初来店のときだけの特典(友だち=チケット・紹介者=チケット/AMBER 以上は 100pt)、特典の冪等(同時の来店記録)、
//       お知らせの既読、ディナーの五巡茶の出し方の切り替え、集計(staff_referral_stats・staff_kpi_overview)、月次レポート(本番開始日による省略・集計だけ・個人情報なし)、バックアップ/復元。
// 実行: node --experimental-strip-types test_referral.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053";
let seq = 0; const nextSub = () => "U" + (++seq).toString(16).padStart(32, "0");
const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3", kiosk: "00000000-0000-0000-0000-0000000000f6" };
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
const val = (sql) => pg.exec(sql);
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const AS = (uid, sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const fails = (fn, re) => { try { fn(); } catch (e) { assert.match(String(e.message), re, e.message); return; } assert.fail("expected failure " + re); };
const ts = (now) => (now === "now" ? "now()" : `${q(now)}::timestamptz`);
const cnt = (sql) => Number(val(sql));
// 登録(登録日時 created_at は now() で記録されるので、擬似データでは登録の日時に合わせて書き換える)
const reg = (sub, name, { code = null, now = "now", memberNo = null } = {}) => {
  const r = j(SVC(`select public.app_register(${q(ISS)}, ${q(sub)}, ${q(name)}, ${q(memberNo)}, ${ts(now)}, ${q(code)});`));
  if (r.status === "created") val(`update members set created_at = ${ts(now)} where id = (select member_id from member_identities where subject=${q(sub)} and issuer like '%${ISS}');`);
  return r;
};
const me = (sub, now = "now") => j(SVC(`select public.app_me(${q(ISS)}, ${q(sub)}, ${ts(now)});`));
const checkin = (sub, now = "now") => j(SVC(`select public.app_checkin(${q(ISS)}, ${q(sub)}, null, ${ts(now)});`));
const seen = (sub, until, now = "now") => j(SVC(`select public.app_invite_seen(${q(ISS)}, ${q(sub)}, ${until === null ? "null" : q(until) + "::timestamptz"}, ${ts(now)});`));
const midOf = (sub) => val(`select member_id from member_identities where subject=${q(sub)} limit 1;`);
const codeOf = (sub) => me(sub).member.invite.code;
const ledger = (sub) => val(`select coalesce(string_agg(rule_code || ':' || points, ',' order by id), '') from point_ledger where member_id = ${q(midOf(sub))};`);
const tickets = (sub) => val(`select coalesce(string_agg(title, ',' order by issued_at, id), '') from perk_tickets where member_id = ${q(midOf(sub))} and kind = 'referral';`);
const setLife = (sub, target) => val(`select public._grant(m.id, 'earn', 'visit', ${target} - public._effective_lifetime(m), 'ref-test:' || gen_random_uuid(), 'test', null, now()) from members m where m.id = ${q(midOf(sub))};`);
const STUB = `create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;
const BEFORE = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql"];
const TABLES = ["member_invite_codes", "member_referrals"];
const REPLACED = ["app_register", "app_checkin", "_member_view", "staff_kpi_overview", "export_backup", "restore_backup"];
const fnDefs = () => val(`select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any(array['${REPLACED.join("','")}']);`);
const conDefs = () => val(`select string_agg(conname || '=' || pg_get_constraintdef(oid), ';' order by conname) from pg_constraint where conrelid in ('perk_tickets'::regclass,'perk_ticket_types'::regclass) and contype='c';`);
const ex = (r, sig) => val(`select has_function_privilege('${r}', 'public.${sig}', 'execute');`);
// 集計の値に個人の情報(会員番号・氏名・LINE の ID・会員の内部 ID)が含まれないこと
const assertNoPii = (obj, names) => {
  const keys = []; const walk = (x) => { if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { keys.push(k); walk(v); } }; walk(obj);
  for (const k of keys) assert.doesNotMatch(k, /member_?no|display_?name|subject|line_?user|lineUserId|member_?id|^id$|^code$/i, k);
  const s = JSON.stringify(obj);
  assert.doesNotMatch(s, /user\d{5}|T\d{5}|U[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  for (const nm of names) assert.ok(!s.includes(nm), nm);
};

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;\n${STUB}`);
  for (const f of BEFORE) pg.loadFile(f);
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit';
    insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role, active) values ('${STAFF.mgr}','店長','manager',true),('${STAFF.staff}','スタッフ','staff',true),('${STAFF.viewer}','閲覧','viewer',true),('${STAFF.kiosk}','店頭','kiosk',true);`);

  // ---- 1. 適用・権限・戻し ----
  const defs105 = fnDefs(), cons105 = conDefs();
  pg.loadFile("106_referral.sql");
  for (const t of TABLES) {
    for (const r of ["anon", "authenticated"]) assert.equal(val(`select has_table_privilege('${r}', 'public.${t}', 'select,insert,update,delete');`), "f", `${r} ${t}`);
    assert.equal(val(`select has_table_privilege('service_role', 'public.${t}', 'select,insert,update');`), "t", t);
    assert.equal(val(`select has_table_privilege('service_role', 'public.${t}', 'delete');`), "f", t);
    assert.equal(val(`select relrowsecurity from pg_class where relname='${t}';`), "t", t);
  }
  for (const sig of ["app_register(text,text,text,text,timestamptz,text)", "app_invite_seen(text,text,timestamptz,timestamptz)", "report_monthly(text,timestamptz)"]) {
    assert.equal(ex("service_role", sig), "t", sig); assert.equal(ex("authenticated", sig), "f", sig); assert.equal(ex("anon", sig), "f", sig); }
  for (const sig of ["staff_referral_stats()", "manager_set_dinner_tea_mode(text)"]) { assert.equal(ex("authenticated", sig), "t", sig); assert.equal(ex("anon", sig), "f", sig); assert.equal(ex("service_role", sig), "f", sig); }
  for (const sig of ["_invite_code_for(uuid)", "_invite_snapshot(uuid,timestamptz)", "_referral_reward(uuid,timestamptz)", "_referral_month(boolean,date,date)", "_kpi_with_referral(jsonb,boolean)", "_dinner_tea_label()"])
    for (const r of ["anon", "authenticated", "service_role"]) assert.equal(ex(r, sig), "f", `${r} ${sig}`);
  assert.equal(cnt(`select count(*) from pg_proc where proname = 'app_register';`), 1);                                    // 古い形(5つの引数)は残らない
  assert.notEqual(fnDefs(), defs105); assert.notEqual(conDefs(), cons105);
  assert.equal(val(`select value from app_settings where key='dinner_tea_mode';`), "cup"); assert.equal(val(`select value from app_settings where key='referral_monthly_cap';`), "5");
  pg.loadFile("106_referral_DOWN.sql");
  assert.equal(fnDefs(), defs105); assert.equal(conDefs(), cons105);
  assert.equal(ex("service_role", "app_register(text,text,text,text,timestamptz)"), "t"); assert.equal(ex("authenticated", "app_register(text,text,text,text,timestamptz)"), "f");
  assert.equal(cnt(`select count(*) from pg_class where relname = any(array['${TABLES.join("','")}']);`), 0);
  assert.equal(cnt(`select count(*) from app_settings where key in ('dinner_tea_mode','referral_monthly_cap');`), 0);
  assert.equal(cnt(`select count(*) from perk_ticket_types where kind='referral';`), 0);
  pg.loadFile("106_referral.sql");
  ok("適用・権限・戻し: 新しい表は anon/authenticated から触れず service_role も削除不可。登録・既読・月次レポートは service_role だけ、集計・切り替えはログイン済みだけ、内部関数は誰も直接呼べない。戻しで置き換えた6関数・チケットの制約・設定が 105 の状態に戻り、もう一度適用できる");

  // ---- 2. 招待コードと登録(旧ルールの廃止) ----
  const A = nextSub(); reg(A, "紹介 一郎", { now: "2026-09-01T03:00:00Z" });
  const codeA = codeOf(A);
  assert.match(codeA, /^[A-Za-z0-9_-]{12}$/); assert.equal(codeOf(A), codeA);                                              // 開くたびに同じ
  const mnoA = me(A).member.memberNo; assert.ok(!codeA.includes(mnoA.replace(/^user0*/, "")) || codeA.length === 12); assert.doesNotMatch(codeA, /user/);
  const B = nextSub(); const rB = reg(B, "友だち 二郎", { code: codeA, now: "2026-09-05T03:00:00Z" });
  assert.equal(rB.status, "created"); assert.equal(rB.invite, "linked"); assert.equal(rB.member.points, 100);
  assert.notEqual(rB.member.invite.code, codeA); assert.equal(rB.member.invite.referred.status, "waiting_first_visit");
  assert.equal(ledger(B), "welcome:100"); assert.equal(ledger(A), "welcome:100");                                           // 旧ルール(referral_referrer / referral_welcome)は付かない
  assert.equal(val(`select referred_by from members where id=${q(midOf(B))};`), midOf(A));
  assert.equal(me(A, "2026-09-30T03:00:00Z").member.invite.monthCount, 1); assert.equal(me(A, "2026-10-01T03:00:00Z").member.invite.monthCount, 0);
  assert.equal(me(A).member.invite.monthlyCap, 5); assert.equal(me(A).member.invite.teaLabel, "ディナーの五巡茶 1杯"); assert.equal(me(A).member.invite.referrerReward, "ticket");
  // 間違ったコード・旧ルールの会員番号での紹介・自分のコード(すでに会員)
  const C = nextSub(); const rC = reg(C, "通常 三郎", { code: "AAAAAAAAAAAA", now: "2026-09-06T03:00:00Z" }); assert.equal(rC.invite, "invalid"); assert.equal(ledger(C), "welcome:100");
  const D = nextSub(); const rD = reg(D, "旧式 四郎", { memberNo: mnoA, now: "2026-09-06T03:00:00Z" }); assert.equal(rD.invite, null); assert.equal(ledger(A), "welcome:100");
  const rBad = reg(nextSub(), "記号", { code: "x'; drop table members; --", now: "2026-09-06T03:00:00Z" }); assert.equal(rBad.invite, "invalid");
  const rSelf = reg(A, "紹介 一郎", { code: codeA }); assert.equal(rSelf.status, "existing"); assert.equal(rSelf.invite, undefined);
  assert.equal(cnt(`select count(*) from member_referrals;`), 1); assert.equal(cnt(`select count(*) from point_ledger where rule_code like 'referral%';`), 0);
  ok("招待コード: 会員ごとに推測できない12文字(会員番号を含まない・開くたびに同じ)。コードつきの登録は紹介として記録され、友だちは通常の登録ボーナス 100pt だけ・紹介者にも登録時には何も付かない(旧ルール廃止)。間違ったコード・会員番号での紹介・すでに会員の人(自分のコード)は紹介にならない");

  // ---- 3. 停止中・試験/本番の区分の違うコードは無効 ----
  const S = nextSub(); reg(S, "停止 五郎", { now: "2026-09-01T03:00:00Z" }); const codeS = codeOf(S);
  val(`update members set status='suspended' where id=${q(midOf(S))};`);
  assert.equal(reg(nextSub(), "友だち", { code: codeS, now: "2026-09-07T03:00:00Z" }).invite, "invalid");
  val(`update members set status='active' where id=${q(midOf(S))};`);
  const TS = nextSub(); val(`insert into test_allowlist(issuer, subject, note) values (${q(ISS)}, ${q(TS)}, 'test');`);
  val(`update system_state set state='frozen'; update system_state set state='test';`);
  const rT = reg(TS, "試験 会員", { code: codeA, now: "2026-09-07T03:00:00Z" }); assert.equal(rT.status, "created"); assert.equal(rT.invite, "invalid"); assert.match(rT.member.memberNo, /^T/);
  const codeT = rT.member.invite.code;
  val(`update system_state set state='frozen'; update system_state set state='open';`);
  assert.equal(reg(nextSub(), "本番の友だち", { code: codeT, now: "2026-09-07T03:00:00Z" }).invite, "invalid");
  assert.equal(cnt(`select count(*) from member_referrals;`), 1);
  ok("停止中の会員のコード・試験会員と本番会員をまたぐコードは無効(紹介にならず、通常の登録)");

  // ---- 4. 上限: 紹介者ごとに日本時間の暦月で5人。6人目は通常の登録。月の境目は日本時間 ----
  const R = nextSub(); reg(R, "上限 六郎", { now: "2026-09-01T03:00:00Z" }); const codeR = codeOf(R);
  for (let i = 0; i < 5; i++) assert.equal(reg(nextSub(), `友だち${i}`, { code: codeR, now: `2026-12-0${i + 1}T03:00:00Z` }).invite, "linked");
  const six = nextSub(); const r6 = reg(six, "六人目", { code: codeR, now: "2026-12-31T14:59:00Z" });                   // 日本時間 12/31 23:59 = まだ12月
  assert.equal(r6.status, "created"); assert.equal(r6.invite, "over_cap"); assert.equal(r6.member.points, 100); assert.equal(ledger(six), "welcome:100");
  assert.equal(val(`select coalesce(referred_by::text, 'null') from members where id=${q(midOf(six))};`), "null"); assert.equal(r6.member.invite.referred, null);
  assert.equal(cnt(`select count(*) from audit_log where action='referral_over_cap' and target_member_id=${q(midOf(R))};`), 1);
  assert.equal(me(R, "2026-12-20T03:00:00Z").member.invite.monthCount, 5);
  assert.equal(reg(nextSub(), "一月", { code: codeR, now: "2026-12-31T15:30:00Z" }).invite, "linked");                  // 日本時間 1/1 0:30 = 翌年1月の1人目
  // 同時の登録(別の接続で並列): 新しい紹介者に7人が同時に登録しても、紹介として記録されるのは5人だけ
  const P = nextSub(); reg(P, "並列 七郎", { now: "2026-09-01T03:00:00Z" }); const codeP = codeOf(P);
  const subs = Array.from({ length: 7 }, nextSub);
  const res = await Promise.all(subs.map((s) => pg.runAsync(`set role service_role;\nselect public.app_register(${q(ISS)}, ${q(s)}, '並列', null, '2026-10-10T03:00:00Z'::timestamptz, ${q(codeP)});`)));
  assert.ok(res.every((x) => x.status === 0), res.map((x) => x.stderr).join("|"));
  const invs = res.map((x) => j(x.stdout).invite).sort(); assert.deepEqual(invs, ["linked", "linked", "linked", "linked", "linked", "over_cap", "over_cap"]);
  assert.equal(cnt(`select count(*) from member_referrals where referrer_member_id=${q(midOf(P))};`), 5);
  ok("上限: 紹介者ごとに日本時間の暦月で5人まで。6人目は通常の登録(100pt・紹介の記録なし・監査ログに上限超え)。月は日本時間で数える(12/31 23:59 は12月、1/1 0:30 は翌年1月)。7人が同時に登録しても紹介は5人だけ");

  // ---- 5. 特典は初来店のときだけ(友だち・紹介者にチケット)。チケットは 102 と同じコードの流れで使える ----
  assert.equal(tickets(A), ""); assert.equal(tickets(B), "");
  const c1 = checkin(B, "2026-09-10T03:00:00Z");                                                                         // 日本時間 9/10 12:00
  assert.equal(c1.status, "counted"); assert.equal(c1.granted, 100); assert.equal(c1.referral.ticket, "お友だち紹介・ディナーの五巡茶 1杯"); assert.equal(c1.referral.validThrough, "2026-11-09");
  assert.equal(tickets(B), "お友だち紹介・ディナーの五巡茶 1杯"); assert.equal(tickets(A), "お友だち紹介・ディナーの五巡茶 1杯");
  assert.equal(val(`select (expires_at at time zone 'Asia/Tokyo')::text from perk_tickets where member_id=${q(midOf(B))} and kind='referral';`), "2026-11-10 00:00:00");   // 発行から60日目の終わり(102 のお祝いと同じ数え方)
  assert.equal(val(`select first_visit_on || ',' || referrer_reward from member_referrals where referred_member_id=${q(midOf(B))};`), "2026-09-10,ticket");
  assert.equal(ledger(A), "welcome:100");
  const c2 = checkin(B, "2026-09-11T03:00:00Z"); assert.equal(c2.status, "counted"); assert.equal(c2.referral, null);            // 2回目の来店では出ない
  assert.equal(cnt(`select count(*) from perk_tickets where kind='referral';`), 2);
  assert.equal(me(B, "2026-09-11T03:00:00Z").member.invite.referred.status, "rewarded");
  const tA = me(A, "2026-09-12T03:00:00Z").member.tickets.find((t) => t.kind === "referral"); assert.equal(tA.title, "お友だち紹介・ディナーの五巡茶 1杯"); assert.equal(tA.validThrough, "2026-11-09");
  // 登録した日に店頭QRを読む(登録日を来店日として扱う設定): 「付与済み」でも店にいたことは確かなので、その日に特典を出す
  val(`update app_settings set value='true' where key='register_counts_as_visit';`);
  const Ra = nextSub(); reg(Ra, "当日 八郎", { code: codeOf(C), now: "2026-09-20T03:00:00Z" });
  const c3 = checkin(Ra, "2026-09-20T04:00:00Z"); assert.equal(c3.status, "already_today"); assert.equal(c3.reason, "registered_today"); assert.match(c3.referral.ticket, /五巡茶 1杯/);
  assert.equal(tickets(C), "お友だち紹介・ディナーの五巡茶 1杯");
  val(`update app_settings set value='false' where key='register_counts_as_visit';`);
  // 登録日の来店扱いの行(source=register)だけでは特典は出ない(QR を読んでいない)
  val(`update app_settings set value='true' where key='register_counts_as_visit';`);
  const Rb = nextSub(); reg(Rb, "未来店 九郎", { code: codeOf(C), now: "2026-09-21T03:00:00Z" });
  val(`update app_settings set value='false' where key='register_counts_as_visit';`);
  assert.equal(val(`select source from visits where member_id=${q(midOf(Rb))};`), "register"); assert.equal(tickets(Rb), "");
  assert.equal(val(`select coalesce(first_visit_on::text, 'null') from member_referrals where referred_member_id=${q(midOf(Rb))};`), "null");
  // チケットはコードで使える(102 と同じ): 友だちが「使う」→ スタッフが確定
  val(`update perk_tickets set expires_at = now() + interval '30 days' where member_id=${q(midOf(B))} and kind='referral';`);   // 確定は実時刻で動くので、期限を実時刻に合わせる(いつ実行しても同じ結果)
  const tB = me(B, "now").member.tickets.find((t) => t.kind === "referral");
  const tr = j(SVC(`select public.app_ticket_request(${q(ISS)}, ${q(B)}, ${q(tB.ticketId)}, now());`)); assert.equal(tr.status, "pending");
  const lk = j(AS(STAFF.staff, `select public.staff_lookup_code(${q(tr.member.pendingTicket.code)});`)); assert.equal(lk.kind, "ticket"); assert.equal(lk.ticket.title, "お友だち紹介・ディナーの五巡茶 1杯");
  assert.equal(j(AS(STAFF.staff, `select public.staff_confirm_ticket(${q(lk.request.id)});`)).status, "confirmed");
  ok("特典は登録ではなく初来店(店頭QRの来店記録の最初の1回)のとき: 友だちと紹介者に「お友だち紹介・ディナーの五巡茶 1杯」(発行から60日)。2回目の来店では出ない。登録した日に QR を読んだ場合(付与済み)も出し、QR を読まない登録日の来店扱いだけでは出ない。チケットは 102 と同じコードの流れで使える");

  // ---- 6. 紹介者が AMBER 以上なら、チケットの代わりに 100pt(そのときのランク) ----
  const Am = nextSub(); reg(Am, "琥珀 十郎", { now: "2026-09-01T03:00:00Z" });
  const F1 = nextSub(); reg(F1, "友だち 甲", { code: codeOf(Am), now: "2026-09-02T03:00:00Z" });
  assert.equal(me(Am).member.invite.referrerReward, "ticket");
  setLife(Am, 1000); assert.equal(me(Am).member.rank, "amber"); assert.equal(me(Am).member.invite.referrerReward, "points"); assert.equal(me(Am).member.invite.rewardPoints, 100);
  const balBefore = me(Am).member.points;
  const c4 = checkin(F1, "2026-09-12T03:00:00Z"); assert.match(c4.referral.ticket, /五巡茶/);
  assert.equal(tickets(F1), "お友だち紹介・ディナーの五巡茶 1杯"); assert.equal(tickets(Am), "");
  assert.equal(me(Am).member.points, balBefore + 100); assert.match(ledger(Am), /referral_visit:100$/);
  assert.equal(val(`select referrer_reward || ',' || referrer_points from member_referrals where referred_member_id=${q(midOf(F1))};`), "points,100");
  // 停止中の紹介者には何も付かない(友だちのチケットは出る)
  const Sx = nextSub(); reg(Sx, "停止予定", { now: "2026-09-01T03:00:00Z" }); const F2 = nextSub(); reg(F2, "友だち 乙", { code: codeOf(Sx), now: "2026-09-02T03:00:00Z" });
  val(`update members set status='suspended' where id=${q(midOf(Sx))};`);
  checkin(F2, "2026-09-12T03:00:00Z"); assert.equal(tickets(F2), "お友だち紹介・ディナーの五巡茶 1杯"); assert.equal(tickets(Sx), ""); assert.equal(ledger(Sx), "welcome:100");
  assert.equal(val(`select referrer_reward from member_referrals where referred_member_id=${q(midOf(F2))};`), "none");
  val(`update members set status='active' where id=${q(midOf(Sx))};`);
  assert.equal(cnt(`select count(*) from public.verify_balances();`), 0);
  ok("紹介者のランクが友だちの初来店のときに AMBER 以上なら、チケットの代わりに 100pt(台帳 referral_visit。登録の後に AMBER へ上がった場合も、そのときのランクで判定)。停止中の紹介者には何も付かない。残高は台帳と一致");

  // ---- 7. 冪等: 同じ友だちの来店記録が同時に来ても、特典は1回だけ ----
  const Q = nextSub(); reg(Q, "同時 紹介者", { now: "2026-09-01T03:00:00Z" }); const Fq = nextSub(); reg(Fq, "同時 友だち", { code: codeOf(Q), now: "2026-09-02T03:00:00Z" });
  const par = await Promise.all(Array.from({ length: 6 }, () => pg.runAsync(`set role service_role;\nselect public.app_checkin(${q(ISS)}, ${q(Fq)}, null, '2026-09-15T03:00:00Z'::timestamptz);`)));
  assert.ok(par.every((x) => x.status === 0), par.map((x) => x.stderr).join("|"));
  assert.equal(par.map((x) => j(x.stdout)).filter((x) => x.referral).length, 1);
  assert.equal(cnt(`select count(*) from perk_tickets where kind='referral' and member_id in (${q(midOf(Q))}, ${q(midOf(Fq))});`), 2);
  assert.equal(val(`set role postgres; select coalesce(public._referral_reward(${q(midOf(Fq))}, now())::text, 'null');`), "null");
  fails(() => val(`insert into member_referrals(referred_member_id, referrer_member_id, invite_code, registered_at, registered_month) values (${q(midOf(Fq))}, ${q(midOf(A))}, 'x', now(), '2026-09');`), /duplicate key/);
  fails(() => val(`insert into member_referrals(referred_member_id, referrer_member_id, invite_code, registered_at, registered_month) values (${q(midOf(C))}, ${q(midOf(C))}, 'x', now(), '2026-09');`), /check constraint/);
  ok("冪等: 同じ友だちの来店記録が6本同時に来ても特典は1回(チケットは2枚だけ)。出し済みの紹介にもう一度呼んでも何もしない。友だち1人に紹介は1つ・自分自身は紹介者になれない(DB の制約)");

  // ---- 8. お知らせ(1回だけ。既読はサーバーに記録) ----
  let nt = me(A).member.inviteNotice; assert.deepEqual({ ...nt, until: undefined }, { friends: 1, tickets: 1, points: 0, until: undefined });
  assert.deepEqual(me(A).member.inviteNotice.friends, 1);                                                                 // 表示して既読にするまでは出続ける(別の画面が開いても消えない)
  assert.equal(seen(A, nt.until).marked, 1); assert.equal(me(A).member.inviteNotice, null); assert.equal(seen(A, nt.until).marked, 0);
  nt = me(Am).member.inviteNotice; assert.equal(nt.points, 100); assert.equal(nt.tickets, 0);
  // 既読にする時刻より後に出た特典は既読にしない
  const F3 = nextSub(); reg(F3, "友だち 丙", { code: codeOf(Am), now: "2026-09-03T03:00:00Z" }); checkin(F3, "2026-09-20T03:00:00Z");
  assert.equal(me(Am).member.inviteNotice.friends, 2); assert.equal(seen(Am, nt.until).marked, 1); assert.equal(me(Am).member.inviteNotice.friends, 1);
  assert.equal(seen(Am, null).marked, 1); assert.equal(me(Am).member.inviteNotice, null);
  assert.equal(seen(nextSub(), null).status, "not_registered");
  assert.equal(val(`select count(*) from member_referrals where referrer_seen_at is not null;`), "3");
  ok("お知らせ: 紹介者の会員証に、友だちの初来店の数(チケット/付けたポイント)を出し、会員証が表示して既読にするまで出し続ける。既読は表示した時点までの分だけで、その後の分は次に出る");

  // ---- 9. ディナーの五巡茶の出し方の切り替え(店長だけ) ----
  const usedTitle = val(`select title from perk_tickets where member_id=${q(midOf(B))} and kind='referral';`);
  fails(() => AS(STAFF.staff, `select public.manager_set_dinner_tea_mode('free_flow');`), /forbidden/);
  fails(() => AS(STAFF.viewer, `select public.manager_set_dinner_tea_mode('free_flow');`), /forbidden/);
  fails(() => AS(STAFF.mgr, `select public.manager_set_dinner_tea_mode('bottle');`), /invalid_mode/);
  const sw = j(AS(STAFF.mgr, `select public.manager_set_dinner_tea_mode('free_flow');`)); assert.equal(sw.label, "ディナーの五巡茶 飲み放題"); assert.ok(sw.retitled >= 1);
  assert.equal(val(`select title from perk_tickets where member_id=${q(midOf(B))} and kind='referral';`), usedTitle);         // 使用済みは当時の名前のまま
  assert.equal(tickets(A), "お友だち紹介・ディナーの五巡茶 飲み放題"); assert.equal(me(A).member.invite.teaLabel, "ディナーの五巡茶 飲み放題");
  const F4 = nextSub(); reg(F4, "友だち 丁", { code: codeOf(D), now: "2026-09-04T03:00:00Z" }); checkin(F4, "2026-09-21T03:00:00Z");
  assert.equal(tickets(F4), "お友だち紹介・ディナーの五巡茶 飲み放題");
  assert.equal(j(val(`select meta from audit_log where action='dinner_tea_mode' order by id desc limit 1;`)).new, "free_flow");
  j(AS(STAFF.mgr, `select public.manager_set_dinner_tea_mode('cup');`)); assert.equal(tickets(F4), "お友だち紹介・ディナーの五巡茶 1杯");
  ok("ディナーの五巡茶の出し方: 店長だけが cup(1杯)/ free_flow(飲み放題)を切り替えられ、まだ使っていない紹介のチケットと会員証の文言が変わる(使用済みは当時の名前のまま)。スタッフ・閲覧は拒否、変更は監査ログに残る");

  // ---- 10. 集計(staff_referral_stats・staff_kpi_overview) ----
  { const st = j(AS(STAFF.viewer, `select public.staff_referral_stats();`));
    assert.equal(st.registrationsTotal, cnt(`select count(*) from member_referrals r join members m on m.id=r.referred_member_id where not m.is_test;`));
    assert.equal(st.firstVisitsTotal, cnt(`select count(*) from member_referrals where first_visit_on is not null;`));
    assert.equal(st.waitingFirstVisit, st.registrationsTotal - st.firstVisitsTotal); assert.equal(st.dinnerTeaMode, "cup"); assert.equal(st.canEdit, false); assert.equal(st.monthlyCap, 5);
    assert.equal(j(AS(STAFF.mgr, `select public.staff_referral_stats();`)).canEdit, true); assert.ok(j(AS(STAFF.staff, `select public.staff_referral_stats();`)).registrationsTotal >= 1);
    fails(() => AS(STAFF.kiosk, `select public.staff_referral_stats();`), /forbidden/); fails(() => pg.exec(`set role anon; select public.staff_referral_stats();`), /permission denied/);
    assertNoPii(st, ["紹介 一郎", "友だち 二郎"]);
    // KPI: 各月の supporting に紹介の数
    val(`update kpi_settings set launch_date='2026-08-10';`);
    const live = j(AS(STAFF.mgr, `select public.staff_kpi_overview(13);`));                                                    // 実時刻の集計: どの月にも紹介の数がある
    assert.ok(live.months.length === 13 && live.months.every((x) => Number.isInteger(x.supporting.referralRegistrations) && Number.isInteger(x.supporting.referralFirstVisits) && Number.isInteger(x.supporting.activeMembers)));
    const ko = j(val(`select public._kpi_with_referral(public._kpi_overview(false, 3, '2026-10-15T03:00:00Z'::timestamptz), false);`));   // 日時を固定した同じ計算(管理者で内部関数を呼ぶ)
    const sep = ko.months.find((x) => x.month === "2026-09"), oct = ko.months.find((x) => x.month === "2026-10");
    assert.equal(sep.supporting.referralRegistrations, cnt(`select count(*) from member_referrals where registered_month='2026-09';`));
    assert.equal(sep.supporting.referralFirstVisits, cnt(`select count(*) from member_referrals where first_visit_on between '2026-09-01' and '2026-09-30';`));
    assert.equal(oct.supporting.referralRegistrations, 5); assert.equal(oct.supporting.referralFirstVisits, 0);
    assert.equal(sep.supporting.activeMembers >= 1, true);                                                                     // 105 の数字はそのまま
    fails(() => AS(STAFF.staff, `select public.staff_kpi_overview(13);`), /forbidden/);
    fails(() => AS(STAFF.mgr, `select public._referral_month(false, '2026-09-01', '2026-09-30');`), /permission denied/);      // 内部関数はログイン済みでも直接は呼べない
    // 試験運用中は試験会員だけ
    val(`update system_state set state='frozen'; update system_state set state='test';`);
    assert.equal(j(AS(STAFF.viewer, `select public.staff_referral_stats();`)).registrationsTotal, 0);
    assert.equal(j(AS(STAFF.mgr, `select public.staff_kpi_overview(3);`)).months.every((x) => x.supporting.referralRegistrations === 0), true);
    val(`update system_state set state='frozen'; update system_state set state='open';`); }
  ok("集計: staff_referral_stats(閲覧以上。店頭タブレット・未ログインは拒否)は紹介の登録数・初来店の数・待ち・今月の数と五巡茶の出し方だけ(個人の情報なし)。staff_kpi_overview の各月の supporting に紹介からの登録数と新規来店数(初来店の月)。試験運用中は試験会員だけ");

  // ---- 11. 月次レポート(service_role だけ・集計だけ・本番開始日で省略) ----
  { const rep = (m, now = "2026-10-15T00:00:00Z") => j(SVC(`select public.report_monthly(${q(m)}, ${ts(now)});`));
    fails(() => AS(STAFF.mgr, `select public.report_monthly('2026-09');`), /permission denied/); fails(() => pg.exec(`set role anon; select public.report_monthly('2026-09');`), /permission denied/);
    fails(() => SVC(`select public.report_monthly('2026-13');`), /invalid_month/); fails(() => SVC(`select public.report_monthly('202609');`), /invalid_month/);
    val(`update kpi_settings set launch_date=null;`);
    assert.deepEqual(rep("2026-09"), { month: "2026-09", skipped: true, reason: "no_launch_date" });
    val(`update kpi_settings set launch_date='2026-09-20';`);
    assert.equal(rep("2026-08").reason, "before_launch"); assert.equal(rep("2026-08").skipped, true);
    assert.equal(rep("2026-10").reason, "month_not_finished"); assert.equal(rep("2026-10", "2026-10-31T14:59:00Z").reason, "month_not_finished");   // 10/31 23:59(日本時間)はまだ10月
    assert.equal(rep("2026-10", "2026-10-31T15:00:00Z").skipped, false);                                                       // 11/1 0:00(日本時間)から
    // 擬似データ: 体質チェック・今日の体調・レジの客数(9月の日別)
    const ccSubmit = (s, answers, now) => j(SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(s)}, array[${answers.join(",")}]::integer[], 'soup', true, ${ts(now)});`));
    const woodHeavy = [2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], waterHeavy = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2];
    assert.equal(ccSubmit(A, woodHeavy, "2026-09-10T05:00:00Z").status, "ok"); assert.equal(ccSubmit(B, woodHeavy, "2026-09-10T05:00:00Z").status, "ok"); assert.equal(ccSubmit(C, waterHeavy, "2026-09-10T05:00:00Z").status, "ok");
    for (const [s, t, e, c] of [[A, "cold", "tired", "dry"], [B, "cold", "fine", "none"], [C, "hot", "fine", "none"]])
      assert.equal(j(SVC(`select public.app_condition_submit(${q(ISS)}, ${q(s)}, '${t}', '${e}', '${c}', '2026-09-11T05:00:00Z'::timestamptz);`)).status, "ok");
    const rows = Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, customers: 20 }));
    j(AS(STAFF.mgr, `select public.manager_import_pos_customers(${q(JSON.stringify(rows))}::jsonb, 'synthetic.csv');`));
    const r9 = rep("2026-09");
    assert.equal(r9.skipped, false); assert.equal(r9.scope, "production"); assert.equal(r9.month, "2026-09"); assert.equal(r9.previousMonth, "2026-08"); assert.equal(r9.monthIndex, 1); assert.equal(r9.milestone, 3);
    fails(() => SVC(`select public._kpi_with_referral('{}'::jsonb, false);`), /permission denied/);                          // 内部関数は service_role でも直接は呼べない(下は管理者で確認)
    const ref9 = j(val(`select public._kpi_with_referral(public._kpi_overview(false, 2, '2026-09-30T14:59:59Z'::timestamptz), false);`)).months[1];
    for (const code of ["member_visit_rate", "new_members", "check_rate", "revisit_rate", "referral_clicks"]) {
      assert.equal(r9.kpis[code].actual, ref9.kpis[code].actual, code); assert.equal(r9.kpis[code].target, ref9.kpis[code].target, code);
      assert.equal(r9.kpis[code].achievementPercent, ref9.kpis[code].achievementPercent, code); }
    assert.equal(r9.kpis.member_visit_rate.target, 15); assert.equal(r9.pos.customers, 600); assert.equal(r9.pos.missing, false);
    assert.equal(r9.kpis.member_visit_rate.actual, Math.round(1000 * ref9.memberVisitsOnPosDays / 600) / 10);
    const visits9 = cnt(`select count(*) from visits v join members m on m.id=v.member_id where not m.is_test and v.visit_on between '2026-09-01' and '2026-09-30';`);
    assert.equal(r9.members.memberVisits, visits9);
    const r8 = j(val(`select public._kpi_overview(false, 1, '2026-08-31T14:59:59Z'::timestamptz);`)).months[0];
    assert.equal(r9.kpis.new_members.previous, r8.kpis.new_members.actual); assert.equal(r9.kpis.new_members.change, r9.kpis.new_members.actual - r8.kpis.new_members.actual);
    assert.equal(r9.members.newRegistrations, cnt(`select count(*) from members where not is_test and created_at >= '2026-08-31T15:00:00Z' and created_at < '2026-09-30T15:00:00Z';`));
    assert.equal(r9.members.referralRegistrations, cnt(`select count(*) from member_referrals r join members m on m.id=r.referred_member_id where not m.is_test and registered_month='2026-09';`));
    assert.equal(r9.members.referralFirstVisits, cnt(`select count(*) from member_referrals where first_visit_on between '2026-09-01' and '2026-09-30';`));
    assert.equal(Object.values(r9.members.byRank).reduce((a, b) => a + b, 0), r9.members.activeMembers); assert.ok(r9.members.byRank.amber >= 1);
    assert.deepEqual(r9.constitution.byType, { wood: 2, fire: 0, earth: 0, metal: 0, water: 1, balanced: 0 }); assert.equal(r9.constitution.checkedMembers, 3); assert.equal(r9.constitution.checksInMonth, 3);
    assert.equal(r9.constitution.conditions.answers, 3); assert.deepEqual(r9.constitution.conditions.top, { temp: "cold", energy: "fine", concern: "none" });
    assert.deepEqual(r9.constitution.conditions.counts.temp, { cold: 2, hot: 1, normal: 0 });
    assert.equal(r9.tickets.issued, cnt(`select count(*) from perk_tickets t join members m on m.id=t.member_id where not m.is_test and issued_at >= '2026-08-31T15:00:00Z' and issued_at < '2026-09-30T15:00:00Z';`));
    assert.equal(r9.tickets.issuedByKind.referral, cnt(`select count(*) from perk_tickets where kind='referral' and issued_at < '2026-09-30T15:00:00Z';`));
    assert.equal(r9.tickets.used, 0);
    const usedIn = (a, b) => cnt(`select count(*) from perk_tickets where used_at >= '${a}' and used_at < '${b}';`);                // 使用の確定は実時刻(上の 5.)
    assert.equal(usedIn("2026-08-31T15:00:00Z", "2026-09-30T15:00:00Z"), 0); assert.equal(rep("2026-10", "2026-11-01T00:00:00Z").tickets.used, usedIn("2026-09-30T15:00:00Z", "2026-10-31T15:00:00Z"));
    assertNoPii(r9, ["紹介 一郎", "友だち 二郎", "通常 三郎", "琥珀 十郎"]);
    // 試験運用中は試験会員と試験用の客数(scope=test)
    val(`update system_state set state='frozen'; update system_state set state='test';`);
    const rt = rep("2026-09"); assert.equal(rt.scope, "test"); assert.equal(rt.pos.missing, true); assert.equal(rt.members.activeMembers, 1); assert.equal(rt.members.referralRegistrations, 0);
    val(`update system_state set state='frozen'; update system_state set state='open';`); }
  ok("月次レポート report_monthly: service_role だけ。本番開始日が未設定・開始の月より前・まだ終わっていない月(日本時間)は skipped。4つの KPI と新規登録の実績・目標・達成率・前の月との差(105 の集計と同じ値)、紹介の数、ランク別、体質のタイプ別・今日の体調のいちばん多い答え、チケットの発行・使用・使用率、レジの客数。氏名・会員番号・LINE ID・内部 ID は含まない。試験運用中は試験の区分(scope=test)");

  // ---- 12. バックアップ/復元 ----
  { const bk = val(`set role service_role; select public.export_backup();`).split("\n").pop(); const b = JSON.parse(bk);
    for (const t of TABLES) assert.ok(Array.isArray(b.tables[t]) && b.tables[t].length > 0, t);
    assert.ok(b.tables.perk_ticket_types.some((x) => x.kind === "referral")); assert.ok(b.tables.app_settings.some((x) => x.key === "dinner_tea_mode"));
    const statsOf = (db) => JSON.stringify({ ...j(pg.execIn(db, `set role authenticated; set request.jwt.claim.sub='${STAFF.mgr}'; select public.staff_referral_stats();`)), asOf: null });
    const repOf = (db) => JSON.stringify({ ...j(pg.execIn(db, `set role service_role; select public.report_monthly('2026-09', '2026-10-15T00:00:00Z');`)), state: null });
    const base = { stats: statsOf("t"), rep: repOf("t") };
    const fresh = (db) => { pg.createDb(db); pg.execIn(db, STUB); for (const f of [...BEFORE, "106_referral.sql"]) pg.loadFileIn(db, f);
      pg.execIn(db, `insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};`); };
    fresh("t2");
    const rs = JSON.parse(pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`).split("\n").pop());
    assert.equal(rs.status, "restored"); assert.equal(rs.balanceMismatches, 0);
    pg.execIn("t2", `update system_state set state='open';`);
    assert.equal(statsOf("t2"), base.stats); assert.equal(repOf("t2"), base.rep);
    assert.equal(pg.execIn("t2", `select code from member_invite_codes where member_id=${q(midOf(A))};`), codeA);              // 招待コードも同じ(送ったリンクが使える)
    fails(() => pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`), /target_not_empty/);
    // 106 より前のバックアップ(紹介の表・設定・チケットの種類がない): 復元でき、紹介は0件・設定は既定値
    const old = JSON.parse(bk); for (const t of TABLES) delete old.tables[t];
    old.tables.app_settings = old.tables.app_settings.filter((x) => !["dinner_tea_mode", "referral_monthly_cap"].includes(x.key));
    old.tables.perk_ticket_types = old.tables.perk_ticket_types.filter((x) => x.kind !== "referral"); old.tables.perk_tickets = old.tables.perk_tickets.filter((x) => x.kind !== "referral");
    old.tables.perk_ticket_requests = old.tables.perk_ticket_requests.filter((x) => old.tables.perk_tickets.some((t) => t.id === x.ticket_id));
    fresh("t3");
    const r3 = JSON.parse(pg.execIn("t3", `set role service_role; select public.restore_backup(${q(JSON.stringify(old))}::jsonb);`).split("\n").pop());
    assert.equal(r3.status, "restored"); assert.equal(pg.execIn("t3", `select count(*) from member_referrals;`), "0"); assert.equal(pg.execIn("t3", `select value from app_settings where key='dinner_tea_mode';`), "cup");
    pg.execIn("t3", `update system_state set state='open';`);
    assert.match(j(pg.execIn("t3", `set role service_role; select public.app_me(${q(ISS)}, ${q(A)}, now());`)).member.invite.code, /^[A-Za-z0-9_-]{12}$/);   // コードは開いたときに作り直す
    // 紹介の行がある DB には復元しない
    fresh("t4");
    pg.execIn("t4", `insert into members(member_no) values ('user09001'), ('user09002');
      insert into member_referrals(referred_member_id, referrer_member_id, invite_code, registered_at, registered_month) select (select id from members where member_no='user09002'), (select id from members where member_no='user09001'), 'x', now(), '2026-10';
      delete from members where false;`);
    fails(() => pg.execIn("t4", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`), /target_not_empty/); }
  ok("バックアップ/復元: 招待コード・紹介の記録・紹介のチケットと設定がバックアップに入り、空の DB に同じ集計・同じ月次レポート・同じ招待コードで復元できる。106 より前のバックアップも復元でき(紹介0件・設定は既定値・コードは開いたときに作る)、データのある DB には復元しない");
  console.log(`\n${n} referral tests passed`);
} finally { pg.stop(); }
