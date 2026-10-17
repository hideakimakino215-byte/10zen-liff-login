// 114(同じ30秒の店頭QRで「要確認」にする人数を 6 → 15。設定 suspicious_slot_min)を実 PostgreSQL 16 で検証する。本番には接続しない。
// 実行: node --experimental-strip-types patches/test_suspicious_slot.mjs
import assert from "node:assert/strict";
import { startPg, q } from "./pgdb.mjs";

const FILES = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql",
  "106_referral.sql", "107_constitution_each_visit.sql", "108_restore_old_backup_fix.sql", "109_confirm_inactive_member.sql", "110_dinner_tea_mode_partition.sql",
  "111_safeupdate_where.sql", "112_ruby_seasonal_tea.sql", "113_staff_list_cc_audit.sql"];
const STUB = `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
  create table public.customers(id uuid primary key, line_user_id text);`;
const ISS = "2011158053", VIEWER = "00000000-0000-0000-0000-0000000000c3";
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
let seq = 0; const nextSub = () => "U" + String(++seq).padStart(32, "0");
const pg = startPg();
try {
  pg.exec(STUB);
  for (const f of FILES) pg.loadFile(f);
  pg.exec(`update system_state set state = 'open'; insert into auth.users(id) values ('${VIEWER}'); insert into staff_users(user_id, display_name, role, active) values ('${VIEWER}','閲覧','viewer',true);`);
  const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
  const visit = (slot) => { const s = nextSub(); SVC(`select public.app_register(${q(ISS)}, ${q(s)}, '来店', null, '2026-09-10T00:00:00Z');`); SVC(`select public.app_checkin(${q(ISS)}, ${q(s)}, ${slot}::bigint, now());`); };
  const slots = () => j(pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${VIEWER}';\nselect public.staff_today_visits();`)).suspiciousSlots.map((x) => `${x.slot}:${x.count}`).sort();
  const def = () => pg.exec(`select md5(pg_get_functiondef('public.staff_today_visits()'::regprocedure));`);
  const privs = () => pg.exec(`select string_agg(r || ':' || has_function_privilege(r, 'public.staff_today_visits()', 'execute')::text, ',' order by r) from unnest(array['anon','authenticated','service_role']) r;`);
  for (let i = 0; i < 14; i++) visit(777);                  // 満席時の団体(14人が同じ30秒)
  for (let i = 0; i < 6; i++) visit(888);                   // 6人組
  const d100 = def(), p100 = privs();
  assert.deepEqual(slots(), ["777:14", "888:6"]);            // 100 の定義: 6人で「要確認」
  ok("114 の前: 同じ30秒に6人以上で「要確認」(6人組でも出る)");

  pg.loadFile("114_suspicious_slot_threshold.sql");
  assert.deepEqual(slots(), []); assert.equal(privs(), p100); assert.match(p100, /anon:false/);
  assert.equal(pg.exec(`select value from app_settings where key = 'suspicious_slot_min';`), "15");
  visit(777); assert.deepEqual(slots(), ["777:15"]);
  ok("114: 15人未満は出ない(14人・6人)。15人目で「要確認」。権限は同じ");

  pg.exec(`update app_settings set value = '6' where key = 'suspicious_slot_min';`); assert.deepEqual(slots(), ["777:15", "888:6"]);
  pg.exec(`update app_settings set value = '1' where key = 'suspicious_slot_min';`); assert.deepEqual(slots(), ["777:15", "888:6"]);   // 2未満にはならない(1人ずつの来店を警告しない)
  pg.exec(`update app_settings set value = '15' where key = 'suspicious_slot_min';`);
  ok("人数は設定 suspicious_slot_min で変えられる(2人未満にはならない)");

  pg.loadFile("114_suspicious_slot_threshold.sql");          // 2回適用しても同じ
  assert.deepEqual(slots(), ["777:15"]);
  pg.loadFile("114_suspicious_slot_threshold_DOWN.sql");
  assert.equal(def(), d100); assert.equal(privs(), p100); assert.equal(pg.exec(`select count(*) from app_settings where key = 'suspicious_slot_min';`), "0");
  assert.deepEqual(slots(), ["777:15", "888:6"]);
  ok("114 は2回適用しても同じ。取り消すと 100 の定義(6人)に戻り、設定も消える");
  console.log(`\n${n} suspicious slot checks passed`);
} finally { pg.stop(); }
