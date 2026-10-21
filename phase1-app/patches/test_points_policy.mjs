// 116(ポイントの値引きをやめる・初回特典・紹介の友だちのチケット・「このまま注文する」の数)を実 PostgreSQL で検証する。本番には接続しない。データはすべて擬似。
// 実行: node --experimental-strip-types test_points_policy.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const ISS = "2011158053";
let seq = 0; const nextSub = () => "U" + (++seq).toString(16).padStart(32, "0");
const MGR = "00000000-0000-0000-0000-0000000000a1", VIEWER = "00000000-0000-0000-0000-0000000000c3", KIOSK = "00000000-0000-0000-0000-0000000000f6";
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
const val = (sql) => pg.exec(sql);
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const AS = (uid, sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
const fails = (fn, re) => { try { fn(); } catch (e) { assert.match(String(e.message), re, e.message); return; } assert.fail("expected failure " + re); };
const reg = (sub, code = null) => j(SVC(`select public.app_register(${q(ISS)}, ${q(sub)}, '試験 会員', null, now(), ${q(code)});`));
const me = (sub) => j(SVC(`select public.app_me(${q(ISS)}, ${q(sub)}, now());`));
const checkin = (sub) => j(SVC(`select public.app_checkin(${q(ISS)}, ${q(sub)}, null, now());`));
const midOf = (sub) => val(`select member_id from member_identities where subject=${q(sub)} limit 1;`);
const titles = (sub) => val(`select coalesce(string_agg(title, ',' order by issued_at, title), '') from perk_tickets where member_id = ${q(midOf(sub))};`);
const STUB = `create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create table public.customers(id uuid primary key, line_user_id text);`;
const FILES = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql",
  "106_referral.sql", "107_constitution_each_visit.sql", "108_restore_old_backup_fix.sql", "109_confirm_inactive_member.sql", "110_dinner_tea_mode_partition.sql",
  "111_safeupdate_where.sql", "112_ruby_seasonal_tea.sql", "113_staff_list_cc_audit.sql", "114_suspicious_slot_threshold.sql", "115_legacy_table_grants.sql"];
const REPLACED = ["app_register", "_referral_reward", "manager_set_dinner_tea_mode", "app_redeem_request", "export_backup", "restore_backup"];
const fnDefs = () => val(`select md5(string_agg(p.oid::regprocedure::text || pg_get_functiondef(p.oid) || coalesce(array_to_string(p.proacl, ','), ''), '|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any(array['${REPLACED.join("','")}']);`);
const conDefs = () => val(`select string_agg(conname || '=' || pg_get_constraintdef(oid), ';' order by conname) from pg_constraint where conrelid in ('perk_tickets'::regclass,'perk_ticket_types'::regclass) and contype='c';`);

try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;\n${STUB}`);
  for (const f of FILES) pg.loadFile(f);
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit';
    insert into auth.users values ('${MGR}'),('${VIEWER}'),('${KIOSK}');
    insert into staff_users(user_id, display_name, role) values ('${MGR}','店長','manager'),('${VIEWER}','本部','viewer'),('${KIOSK}','店頭','kiosk');`);
  const before = { fn: fnDefs(), con: conDefs(), settings: val(`select string_agg(key, ',' order by key) from app_settings;`) };

  // 1 適用と戻し
  pg.loadFile("116_points_policy.sql");
  assert.equal(val(`select value from app_settings where key='points_redeemable';`), "false");
  pg.loadFile("116_points_policy_DOWN.sql");
  assert.equal(fnDefs(), before.fn); assert.equal(conDefs(), before.con);
  assert.equal(val(`select string_agg(key, ',' order by key) from app_settings;`), before.settings);
  assert.equal(val(`select to_regclass('public.order_clicks') is null;`), "t");
  pg.loadFile("116_points_policy.sql");
  ok("116 を入れて、戻し(DOWN)で関数・制約・設定が 115 の状態に戻り、もう一度入れられる");

  // 2 初回特典: 登録でディナーの五巡茶 1杯(無料)(60日)。1人1枚
  const a = nextSub(); const ra = reg(a);
  assert.equal(ra.status, "created"); assert.equal(ra.welcomeTicket, "ご登録の特典・ディナーの五巡茶 1杯(無料)");
  assert.equal(titles(a), "ご登録の特典・ディナーの五巡茶 1杯(無料)");
  assert.equal(val(`select (expires_at at time zone 'Asia/Tokyo')::date - (issued_at at time zone 'Asia/Tokyo')::date from perk_tickets where member_id=${q(midOf(a))};`), "61");
  assert.equal(val(`select string_agg(rule_code || ':' || points, ',') from point_ledger where member_id=${q(midOf(a))};`).split(",")[0], "welcome:100");   // 登録の 100pt は今までどおり
  assert.equal(reg(a).status, "existing"); assert.equal(titles(a), "ご登録の特典・ディナーの五巡茶 1杯(無料)");
  fails(() => val(`insert into perk_tickets(member_id, type_code, kind, title, issued_at, expires_at) values (${q(midOf(a))}, 'welcome_tea', 'welcome', 'x', now(), now() + interval '1 day');`), /perk_tickets_one_welcome/);
  assert.ok(me(a).member.tickets.some((t) => t.title === "ご登録の特典・ディナーの五巡茶 1杯(無料)"), "会員証にチケットが見える");
  ok("登録すると「ご登録の特典・ディナーの五巡茶 1杯(無料)」のチケット(発行日から60日目の終わりまで)。登録の 100pt はそのまま。1人1枚");

  // 3 ポイントの値引きは申請できない(設定を true にすると今までどおり)
  const r3 = j(SVC(`select public.app_redeem_request(${q(ISS)}, ${q(a)}, 100, now());`));
  assert.equal(r3.status, "redeem_disabled"); assert.equal(Number(val(`select count(*) from redeem_requests;`)), 0);
  pg.exec(`update app_settings set value='true' where key='points_redeemable';`);
  assert.equal(j(SVC(`select public.app_redeem_request(${q(ISS)}, ${q(a)}, 100, now());`)).status, "pending");
  pg.exec(`update app_settings set value='false' where key='points_redeemable'; update redeem_requests set status='cancelled';`);
  ok("ポイントの値引きの申請は「redeem_disabled」(設定 points_redeemable が true のときだけ今までどおり)");

  // 4 チケットは今までどおりコードで使える(スタッフが確定)
  const tid = val(`select id from perk_tickets where member_id=${q(midOf(a))};`);
  const tr = j(SVC(`select public.app_ticket_request(${q(ISS)}, ${q(a)}, ${q(tid)}::uuid, now());`));
  const code = me(a).member.pendingTicket.code;
  assert.equal(tr.status, "pending"); assert.match(code, /^\d{6}$/);
  const lk = j(AS(MGR, `select public.staff_lookup_code(${q(code)});`));
  assert.equal(lk.kind, "ticket"); assert.equal(lk.ticket.title, "ご登録の特典・ディナーの五巡茶 1杯(無料)");
  assert.equal(j(AS(MGR, `select public.staff_confirm_ticket(${q(lk.request.id)}::uuid);`)).status, "confirmed");
  ok("初回特典のチケットは、会員証のコードをスタッフ画面で確定して使う(豆花などと同じ流れ)");

  // 5 紹介: 友だちは初回特典だけ。紹介者は AMBER 未満=チケット / AMBER 以上=+100pt
  const ref = nextSub(); reg(ref); const inv = me(ref).member.invite.code;
  const fr = nextSub(); const rf = reg(fr, inv); assert.equal(rf.invite, "linked");
  const c5 = checkin(fr);
  assert.equal(c5.referral?.ticket, undefined);                                           // 友だちに紹介のチケットの案内は出ない
  assert.equal(titles(fr), "ご登録の特典・ディナーの五巡茶 1杯(無料)");
  assert.equal(titles(ref), "ご登録の特典・ディナーの五巡茶 1杯(無料),お友だち紹介・ディナーの五巡茶 1杯(無料)");
  assert.equal(val(`select referred_ticket_id is null and referrer_reward = 'ticket' from member_referrals where referred_member_id=${q(midOf(fr))};`), "t");
  const big = nextSub(); reg(big); val(`select public._grant(m.id, 'earn', 'visit', 1000, 'pp-test', 'test', null, now()) from members m where m.id = ${q(midOf(big))};`);
  val(`update members set rank_code = public.rank_for(public._effective_lifetime(members)) where id = ${q(midOf(big))};`);
  const fr2 = nextSub(); reg(fr2, me(big).member.invite.code); checkin(fr2);
  assert.equal(val(`select referrer_reward from member_referrals where referred_member_id=${q(midOf(fr2))};`), "points");
  assert.match(val(`select string_agg(rule_code, ',') from point_ledger where member_id=${q(midOf(big))};`), /referral_visit/);
  assert.equal(checkin(fr).status, "already_today");                                       // 2回目でも出ない
  assert.equal(titles(fr), "ご登録の特典・ディナーの五巡茶 1杯(無料)");
  ok("紹介された友だちは初回特典だけ(紹介のチケットなし)。紹介者は AMBER 未満=チケット、AMBER 以上=+100pt(今までどおり)");

  // 6 ディナーの五巡茶の出し方で、まだ使っていない初回特典の名前も変わる
  const b = nextSub(); reg(b);
  assert.equal(j(AS(MGR, `select public.manager_set_dinner_tea_mode('free_flow');`)).status, "ok");
  assert.equal(titles(b), "ご登録の特典・ディナーの五巡茶 飲み放題(無料)");
  assert.equal(val(`select title from perk_tickets t join perk_ticket_requests r on r.ticket_id = t.id where t.member_id=${q(midOf(a))} limit 1;`), "ご登録の特典・ディナーの五巡茶 1杯(無料)");   // 使用済みは当時の名前
  assert.ok(titles(ref).includes("お友だち紹介・ディナーの五巡茶 飲み放題(無料)"));
  AS(MGR, `select public.manager_set_dinner_tea_mode('cup');`);
  ok("ディナーの五巡茶の出し方を変えると、まだ使っていない初回特典・紹介のチケットの名前が変わる(使用済みは当時のまま)");

  // 7 「このまま注文する」が押された数
  for (const t of ["T07", "T07", "<x>"]) assert.equal(j(SVC(`select public.app_order_click(${q(ISS)}, ${q(a)}, ${q(t)}, now());`)).recorded, true);
  assert.equal(val(`select string_agg(coalesce(table_code, '-'), ',' order by id) from order_clicks;`), "T07,T07,-");                 // 形の違うテーブルコードは残さない
  assert.equal(j(SVC(`select public.app_order_click(${q(ISS)}, ${q(nextSub())}, null, now());`)).status, "not_registered");
  const st = j(AS(VIEWER, `select public.staff_order_click_stats();`));
  assert.equal(st.total, 3); assert.equal(st.thisMonth, 3); assert.equal(st.membersThisMonth, 1);
  assert.doesNotMatch(JSON.stringify(st), /T07|U[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-/);
  fails(() => AS(KIOSK, `select public.staff_order_click_stats();`), /forbidden|42501/);
  fails(() => pg.exec(`set role anon;\nselect public.app_order_click('a','b',null,now());`), /permission denied/);
  fails(() => AS(MGR, `select public.app_order_click('a','b',null,now());`), /permission denied/);
  fails(() => AS(MGR, `select * from order_clicks;`), /permission denied/);
  ok("「このまま注文する」を押した数を記録(テーブルコードだけ・形の違う値は残さない)。集計は閲覧以上、個人の情報なし。お客様の関数は service_role だけ");

  // 8 バックアップ/復元に押された数と初回特典が入る
  const bk = val(`select public.export_backup()::text;`);
  assert.equal(JSON.parse(bk).tables.order_clicks.length, 3);
  pg.createDb("t2"); pg.execIn("t2", STUB);                                              // 役割(anon など)はクラスタ共通なので作り直さない
  for (const f of [...FILES, "116_points_policy.sql"]) pg.loadFileIn("t2", f);
  const rs = JSON.parse(pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`).split("\n").pop());
  assert.equal(rs.status, "restored"); assert.equal(rs.balanceMismatches, 0);
  assert.equal(pg.execIn("t2", `select count(*) from order_clicks;`), "3");
  assert.equal(pg.execIn("t2", `select count(*) from perk_tickets where type_code = 'welcome_tea';`), val(`select count(*) from perk_tickets where type_code = 'welcome_tea';`));
  fails(() => pg.execIn("t2", `set role service_role; select public.restore_backup(${q(bk)}::jsonb);`), /target_not_empty/);
  ok("バックアップと復元に、押された数と初回特典のチケットが含まれる(残高と台帳の不一致0)");
} finally { pg.stop(); }
console.log(`${n} points-policy checks passed`);
