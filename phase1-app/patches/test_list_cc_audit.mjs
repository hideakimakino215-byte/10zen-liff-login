// 113(会員の一覧の体質の印: 誰の印を見せたかの記録と「全体的にゆらぎやすいタイプ」の判定。監査 L-3)を実 PostgreSQL 16 で検証する。本番には接続しない。データはすべて擬似。
// 実行: node --experimental-strip-types patches/test_list_cc_audit.mjs
import assert from "node:assert/strict";
import { startPg, q } from "./pgdb.mjs";
import { isAllHigh } from "../app-core/constitution.mjs";

const FILES = ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql",
  "106_referral.sql", "107_constitution_each_visit.sql", "108_restore_old_backup_fix.sql", "109_confirm_inactive_member.sql", "110_dinner_tea_mode_partition.sql",
  "111_safeupdate_where.sql", "112_ruby_seasonal_tea.sql"];
const STUB = `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
  create table public.customers(id uuid primary key, line_user_id text);`;
const ISS = "2011158053";
const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3" };
const j = (s) => JSON.parse(s.split("\n").filter(Boolean).pop());
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
let seq = 0; const nextSub = () => "U" + String(++seq).padStart(32, "0");
// 五行ごとの点数を [木,火,土,金,水] で指定して回答を作る(各五行の3問に 2→1→0 の順で配る)
const ans = (w, f, e, m, wa) => [w, f, e, m, wa].flatMap((x) => { const out = []; let r = x; for (let i = 0; i < 3; i++) { const a = Math.min(2, r); out.push(a); r -= a; } return out; });
const pg = startPg();
try {
  pg.exec(STUB);
  for (const f of FILES) pg.loadFile(f);
  pg.exec(`update system_state set state = 'open'; insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role, active) values ('${STAFF.mgr}','店長','manager',true),('${STAFF.staff}','スタッフ','staff',true),('${STAFF.viewer}','閲覧','viewer',true);`);
  const val = (sql) => pg.exec(sql);
  const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
  const AS = (uid, sql) => pg.exec(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\n${sql}`);
  const reg = (s, name) => j(SVC(`select public.app_register(${q(ISS)}, ${q(s)}, ${q(name)}, null, now());`));
  const submit = (s, a, day) => j(SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(s)}, array[${a.join(",")}]::integer[], 'soup', true, ${q(`2026-10-${day}T03:00:00Z`)}::timestamptz);`));
  const midOf = (s) => val(`select member_id from member_identities where subject=${q(s)} limit 1;`);
  const list = (uid) => j(AS(uid, `select public.staff_list_members(null, 100, 0);`));
  const itemOf = (res, s) => res.items.find((x) => x.id === midOf(s));
  const lastMeta = (uid) => JSON.parse(val(`select meta from audit_log where action = 'list_members' and staff_user_id = '${uid}' order by id desc limit 1;`));
  const def = () => val(`select md5(pg_get_functiondef('public.staff_list_members(text,integer,integer)'::regprocedure));`);
  const privs = () => val(`select string_agg(r || ':' || has_function_privilege(r, 'public.staff_list_members(text,integer,integer)', 'execute')::text, ',' order by r) from unnest(array['anon','authenticated','service_role']) r;`);

  // 会員: A=水が多い / H=全部同点で4点以上(3回の平均 4.33) / L=全部同点だが3点 / B=バランス良好 / N=未実施
  const S = { A: nextSub(), H: nextSub(), L: nextSub(), B: nextSub(), N: nextSub() };
  for (const [k, s] of Object.entries(S)) reg(s, "会員" + k);
  submit(S.A, ans(1, 0, 2, 0, 5), 10);
  submit(S.H, ans(4, 4, 4, 4, 4), 10); submit(S.H, ans(5, 5, 5, 5, 5), 11); submit(S.H, ans(4, 4, 4, 4, 4), 12);
  submit(S.L, ans(3, 3, 3, 3, 3), 10);
  submit(S.B, ans(1, 1, 0, 1, 0), 10);

  // 1. 適用と取り消し: 署名と権限はそのまま。取り消すと 107 の定義に戻る
  { const d107 = def(), p107 = privs(), before = list(STAFF.mgr);
    assert.deepEqual(itemOf(before, S.A).constitution, { primary: "water", balanced: false });
    pg.loadFile("113_staff_list_cc_audit.sql");
    assert.notEqual(def(), d107); assert.equal(privs(), p107); assert.match(p107, /anon:false,authenticated:true,service_role:false/);
    pg.loadFile("113_staff_list_cc_audit_DOWN.sql");
    assert.equal(def(), d107); assert.equal(privs(), p107); assert.deepEqual(list(STAFF.mgr), before);
    pg.loadFile("113_staff_list_cc_audit.sql"); }
  ok("113 の適用と取り消し: 一覧の関数だけが変わり、権限はそのまま。取り消すと 107 の定義と同じ結果");

  // 2. 印: allHigh が足され、ほかは同じ。閲覧(本部)には印がない
  { const r = list(STAFF.mgr);
    assert.deepEqual(itemOf(r, S.A).constitution, { primary: "water", balanced: false, allHigh: false });
    assert.equal(itemOf(r, S.H).constitution.allHigh, true);
    assert.deepEqual(itemOf(r, S.L).constitution, { ...itemOf(r, S.L).constitution, balanced: false, allHigh: false });
    assert.deepEqual(itemOf(r, S.B).constitution, { primary: itemOf(r, S.B).constitution.primary, balanced: true, allHigh: false });
    assert.equal(itemOf(r, S.N).constitution, null);
    assert.deepEqual(Object.keys(itemOf(r, S.A)).sort(), ["constitution", "displayName", "id", "lastActivityOn", "memberNo", "points", "rank", "status"]);
    assert.deepEqual(list(STAFF.staff), r);
    assert.ok(list(STAFF.viewer).items.every((x) => !("constitution" in x))); }
  ok("一覧の印に allHigh(全体的にゆらぎやすいタイプ)が足される。店長とスタッフは同じ。閲覧(本部)には印を返さない");

  // 3. 記録: 印を返した会員の id(未実施は含めない。会員番号の順)。閲覧(本部)の記録には足さない。検索で絞ったときはその分だけ
  { list(STAFF.mgr);
    const want = ["A", "H", "L", "B"].map((k) => midOf(S[k]));
    assert.deepEqual(lastMeta(STAFF.mgr), { hasQuery: false, constitutionShown: want });
    list(STAFF.staff); assert.deepEqual(lastMeta(STAFF.staff).constitutionShown, want);
    list(STAFF.viewer); assert.deepEqual(lastMeta(STAFF.viewer), { hasQuery: false });
    AS(STAFF.staff, `select public.staff_list_members('会員N', 100, 0);`); assert.deepEqual(lastMeta(STAFF.staff), { hasQuery: true, constitutionShown: [] });
    AS(STAFF.staff, `select public.staff_list_members('会員H', 100, 0);`); assert.deepEqual(lastMeta(STAFF.staff), { hasQuery: true, constitutionShown: [midOf(S.H)] }); }
  ok("一覧の記録に、体質の印を返した会員の id を残す(未実施・閲覧(本部)は残さない。検索で絞った分だけ)");

  // 4. allHigh の判定は画面の isAllHigh と同じ(詳細の「あなたの体質」の点数で比べる)
  { const r = list(STAFF.mgr);
    for (const k of Object.keys(S)) {
      const d = j(AS(STAFF.mgr, `select public.staff_member_detail(${q(midOf(S[k]))}::uuid);`));
      const pf = d.constitution?.profile;
      if (!pf) { assert.equal(itemOf(r, S[k]).constitution, null); continue; }
      assert.equal(itemOf(r, S[k]).constitution.allHigh, isAllHigh(pf.scores), k);
    }
    assert.equal(isAllHigh(j(AS(STAFF.mgr, `select public.staff_member_detail(${q(midOf(S.H))}::uuid);`)).constitution.profile.scores), true); }
  ok("一覧の allHigh は、画面の判定(isAllHigh)を詳細の点数に当てたものと一致する");
  console.log(`\n${n} list constitution audit checks passed`);
} finally { pg.stop(); }
