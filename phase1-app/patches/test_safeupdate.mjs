// 111(WHERE のない UPDATE の修正)の検証。本番の API(PostgREST)には pg_safeupdate があり「WHERE のない UPDATE / DELETE」を拒否するが、
// 手元の使い捨て DB には無いので、関数の定義を読んで「WHERE のない UPDATE / DELETE が1つも無いこと」を確かめる(今後の追加も含めて見張る)。
import assert from "node:assert/strict";
import { startPg } from "./pgdb.mjs";

const FILES = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql",
  "106_referral.sql", "107_constitution_each_visit.sql", "108_restore_old_backup_fix.sql", "109_confirm_inactive_member.sql", "110_dinner_tea_mode_partition.sql"];
const STUB = `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table public.customers(id uuid primary key, line_user_id text);`;
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const pg = startPg();
try {
  pg.exec(STUB);
  for (const f of FILES) pg.loadFile(f);
  const defs = () => JSON.parse(pg.exec(`select json_agg(json_build_object('sig', p.oid::regprocedure::text, 'd', pg_get_functiondef(p.oid)) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';`));
  // 関数の中の UPDATE / DELETE で WHERE の無いもの(注釈は除いて読む)
  const unsafe = (rows) => rows.flatMap((r) => [...r.d.replace(/--[^\n]*/g, "").matchAll(/\b(?:update\s+(?:only\s+)?public\.\w+(?:\s+\w+)?\s+set\b|delete\s+from\s+public\.\w+)[^;]*;/gis)]
    .filter((m) => !/\bwhere\b/i.test(m[0])).map((m) => `${r.sig}: ${m[0].replace(/\s+/g, " ").slice(0, 80)}`));
  const before = defs();
  assert.equal(unsafe(before).length, 7, unsafe(before).join("\n"));                     // 110 までは7か所(本番で手動調整が失敗した原因)
  pg.loadFile("111_safeupdate_where.sql");
  const after = defs();
  assert.deepEqual(unsafe(after), []);
  ok("111 のあと、関数の中に WHERE のない UPDATE / DELETE が無い(本番の API の安全装置で拒否されない)");
  // 変わったのは7つの関数だけで、足したのは「 where id」だけ
  const changed = after.filter((a) => before.find((b) => b.sig === a.sig).d !== a.d);
  assert.deepEqual(changed.map((c) => c.sig.split("(")[0]).sort(), ["import_opening_balance", "manager_adjust", "manager_reverse_redeem", "manager_set_launch_date", "reconcile_balances", "restore_backup", "set_system_state"]);
  for (const c of changed) assert.equal(c.d.replace(/ where id;/g, ";"), before.find((b) => b.sig === c.sig).d, c.sig);
  ok("変わったのは7つの関数だけで、違いは「 where id」だけ");
  // 1行だけの表が今までどおり更新される(手動調整で照合済みが外れる・開始日が設定できる)
  pg.exec(`update system_state set state = 'test', reconciled = true; insert into auth.users values ('00000000-0000-0000-0000-0000000000a1'); insert into staff_users(user_id, display_name, role) values ('00000000-0000-0000-0000-0000000000a1', '店長', 'manager');`);
  const SUB = "U" + "1".repeat(32);
  pg.exec(`set role service_role; select public.allow_test_identity('2011158053', '${SUB}', '試験');`);
  pg.exec(`set role service_role; select public.app_register('2011158053', '${SUB}', '試験 会員', null, now());`);
  const AS = (sql) => pg.exec(`set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';\n${sql}`);
  const tid = pg.exec(`select id from members order by created_at limit 1;`);
  const r = JSON.parse(AS(`select public.manager_adjust('${tid}'::uuid, 800, '予行演習', 'adj-test-00000001');`));
  assert.equal(r.status, "ok"); assert.equal(pg.exec(`select reconciled from system_state;`), "f");
  const d = JSON.parse(AS(`select public.manager_set_launch_date('2026-11-01');`));
  assert.equal(pg.exec(`select launch_date from kpi_settings;`), "2026-11-01", JSON.stringify(d));
  ok("1行だけの表は今までどおり更新される(手動調整で照合済みが外れる・本番開始日が設定できる)");
  pg.loadFile("111_safeupdate_where_DOWN.sql");
  assert.deepEqual(defs(), before);
  pg.loadFile("111_safeupdate_where.sql");
  assert.deepEqual(defs(), after);
  ok("DOWN で 110 の定義に完全に戻り、もう一度適用すると同じ定義になる");
  console.log(`\n${n} safeupdate checks passed`);
} finally { pg.stop(); }
