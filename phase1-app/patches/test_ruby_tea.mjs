// 112(RUBY の特典「季節ごとに、あなたの体質の五巡茶(持ち帰り用)」)を実 PostgreSQL 16 で検証する。本番には接続しない。
// 実行: node --experimental-strip-types patches/test_ruby_tea.mjs
import assert from "node:assert/strict";
import { startPg, q } from "./pgdb.mjs";

const FILES = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql",
  "106_referral.sql", "107_constitution_each_visit.sql", "108_restore_old_backup_fix.sql", "109_confirm_inactive_member.sql", "110_dinner_tea_mode_partition.sql", "111_safeupdate_where.sql"];
const STUB = `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
  create table public.customers(id uuid primary key, line_user_id text);`;
const ISS = "2011158053";
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const pg = startPg();
try {
  pg.exec(STUB);
  for (const f of FILES) pg.loadFile(f);
  pg.exec(`update system_state set state = 'open';`);
  const val = (sql) => pg.exec(sql);
  const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
  const reg = (s, name) => j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, now());`)).member.memberNo;
  const me = (s, now) => j(SVC(`select public.app_me(${q(ISS)}, ${q(s)}, ${q(now)}::timestamptz);`));
  const life = (no) => Number(val(`select public._effective_lifetime(m) from members m where member_no=${q(no)};`));
  const setLife = (no, target) => { const d = target - life(no); if (d > 0) val(`select public._grant((select id from members where member_no=${q(no)}), 'earn', 'visit', ${d}, 'test:' || gen_random_uuid(), 'test', null, now());`); };
  const tickets = (no) => JSON.parse(val(`select coalesce(json_agg(json_build_object('type', type_code, 'title', title, 'season', season_key) order by type_code, season_key), '[]') from perk_tickets where member_id = (select id from members where member_no = ${q(no)});`));
  const defs = () => val(`select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';`);
  const idx = () => val(`select indexdef from pg_indexes where indexname = 'perk_tickets_one_season';`);

  // 112 の前に、EMERALD の会員に季節の豆花が出ている状態を作る(既存のチケットは残る)
  const E = reg(sub("e"), "会員E"); setLife(E, 3000); me(sub("e"), "2026-10-16T03:00:00Z");
  const before = defs(), idxBefore = idx(), ticketsE = tickets(E);
  pg.loadFile("112_ruby_seasonal_tea.sql");
  assert.match(idx(), /\(member_id, type_code, season_key\)/);
  assert.deepEqual(tickets(E), ticketsE);
  ok("112 の適用: 季節のチケットの一意が『会員×種類×季節』になり、既存のチケットはそのまま");

  // RUBY・未実施: 季節の豆花と、今日の季節の五行(10/16 は秋=金)の五巡茶。EMERALD には五巡茶は出ない
  const R = reg(sub("r"), "会員R"); setLife(R, 6000); me(sub("r"), "2026-10-16T03:00:00Z");
  const tr = tickets(R);
  assert.deepEqual(tr.map((t) => t.type), ["milestone_ruby", "seasonal_douhua", "seasonal_tea"]);
  assert.equal(tr.find((t) => t.type === "seasonal_tea").title, "持ち帰り用の五巡茶(金) 1つ(秋)");
  me(sub("e"), "2026-10-16T05:00:00Z"); assert.ok(!tickets(E).some((t) => t.type === "seasonal_tea"));
  me(sub("r"), "2026-10-16T06:00:00Z"); assert.equal(tickets(R).length, 3);                                     // 何度開いても同じ季節は1枚
  ok("RUBY は季節の豆花と五巡茶の2枚(未実施は季節の五行=秋は金)。EMERALD には五巡茶は出ない。同じ季節に二重に出ない");

  // 体質チェック済み(木が一番): 次の季節の五巡茶は木。ONYX も受け取れる
  const O = reg(sub("o"), "会員O"); setLife(O, 10000);
  const wood = [2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(sub("o"))}, array[${wood}]::integer[], 'soup', true, '2026-12-02T03:00:00Z'::timestamptz);`);
  me(sub("o"), "2026-12-02T04:00:00Z");
  const tea = tickets(O).find((t) => t.type === "seasonal_tea");
  assert.equal(tea.title, "持ち帰り用の五巡茶(木) 1つ(冬)"); assert.equal(tea.season, "2026-winter");
  me(sub("r"), "2026-12-02T04:00:00Z");
  assert.deepEqual(tickets(R).filter((t) => t.type === "seasonal_tea").map((t) => t.title), ["持ち帰り用の五巡茶(金) 1つ(秋)", "持ち帰り用の五巡茶(水) 1つ(冬)"]);
  ok("体質チェック済みはあなたの体質の五行(木)。ONYX も受け取れる。季節が変わると新しい季節の分(冬・未実施は冬の五行=水)");

  // 会員証の応答にチケットとして出て、コードで使える(既存の流れのまま)
  const v = me(sub("o"), "2026-12-02T05:00:00Z");
  const t = v.member.tickets.find((x) => x.title.startsWith("持ち帰り用の五巡茶"));
  assert.ok(t); assert.equal(t.validThrough, "2027-02-28");
  ok("会員証の応答に出る(有効期限はその季節の終わり=冬は2月末)");

  // DOWN → 102 の定義・一意に戻り、五巡茶のチケットと種類が消える。もう一度適用すると同じ
  const after = defs();
  pg.loadFile("112_ruby_seasonal_tea_DOWN.sql");
  assert.equal(defs(), before); assert.equal(idx(), idxBefore);
  assert.equal(val(`select count(*) from perk_tickets where type_code = 'seasonal_tea';`), "0"); assert.equal(val(`select count(*) from perk_ticket_types where code = 'seasonal_tea';`), "0");
  pg.loadFile("112_ruby_seasonal_tea.sql"); assert.equal(defs(), after);
  ok("DOWN で 111 の状態(関数・一意)に戻り、五巡茶のチケットと種類が消える。もう一度適用すると同じ定義");
  console.log(`\n${n} ruby tea checks passed`);
} finally { pg.stop(); }
