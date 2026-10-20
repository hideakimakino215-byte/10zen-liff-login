// 115(旧システムの表から anon / authenticated の権限を外す)の検証。
// 本番の旧システムの表(customers・interactions・stores)を、Supabase の古い既定(anon / authenticated に全部の権限)で再現してから 115 を入れる。
import assert from "node:assert/strict";
import { startPg } from "./pgdb.mjs";

const FILES = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql",
  "106_referral.sql", "107_constitution_each_visit.sql", "108_restore_old_backup_fix.sql", "109_confirm_inactive_member.sql", "110_dinner_tea_mode_partition.sql",
  "111_safeupdate_where.sql", "112_ruby_seasonal_tea.sql", "113_staff_list_cc_audit.sql", "114_suspicious_slot_threshold.sql"];
const STUB = `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.customers(id uuid primary key, line_user_id text);
  create table public.interactions(id uuid primary key, customer_id uuid);
  create table public.stores(id uuid primary key, name text);
  alter table public.customers enable row level security; alter table public.interactions enable row level security; alter table public.stores enable row level security;
  grant all on public.customers, public.interactions, public.stores to anon, authenticated, service_role;`;
const LEGACY = ["customers", "interactions", "stores"];
const privs = (pg, role) => pg.exec(`select string_agg(t || ':' || (has_table_privilege('${role}', 'public.' || t, 'select')::int + has_table_privilege('${role}', 'public.' || t, 'insert')::int
  + has_table_privilege('${role}', 'public.' || t, 'update')::int + has_table_privilege('${role}', 'public.' || t, 'delete')::int + has_table_privilege('${role}', 'public.' || t, 'truncate')::int), ' ' order by t)
  from unnest(array['customers','interactions','stores']) t;`).trim();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const pg = startPg();
try {
  pg.exec(STUB);
  for (const f of FILES) pg.loadFile(f);
  for (const r of ["anon", "authenticated"]) assert.equal(privs(pg, r), LEGACY.map((t) => `${t}:5`).join(" "));      // 本番と同じく、全部の権限が付いている
  const otherBefore = pg.exec(`select string_agg(c.relname || ':' || has_table_privilege('authenticated', c.oid, 'select')::int, ' ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not (c.relname = any(array['customers','interactions','stores']));`);
  pg.loadFile("115_legacy_table_grants.sql");
  for (const r of ["anon", "authenticated"]) assert.equal(privs(pg, r), LEGACY.map((t) => `${t}:0`).join(" "), r);
  ok("115 のあと、旧システムの表3つに anon / authenticated の権限が1つもない(TRUNCATE も)");
  assert.equal(privs(pg, "service_role"), LEGACY.map((t) => `${t}:5`).join(" "));
  const otherAfter = pg.exec(`select string_agg(c.relname || ':' || has_table_privilege('authenticated', c.oid, 'select')::int, ' ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not (c.relname = any(array['customers','interactions','stores']));`);
  assert.equal(otherAfter, otherBefore);
  ok("service_role の権限と、ほかの表の権限は変わらない");
  pg.loadFile("115_legacy_table_grants_DOWN.sql");
  for (const r of ["anon", "authenticated"]) assert.equal(privs(pg, r), LEGACY.map((t) => `${t}:5`).join(" "), r);
  pg.loadFile("115_legacy_table_grants.sql");
  ok("戻し(DOWN)で元の権限に戻り、もう一度入れられる");
  pg.exec(`drop table public.interactions, public.stores;`);
  pg.loadFile("115_legacy_table_grants.sql");
  ok("表がない環境(手元のテスト用 DB など)でも失敗しない");
} finally { pg.stop(); }
console.log(`${n} legacy-grants checks passed`);
