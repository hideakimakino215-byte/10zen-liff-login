// サンプル削除の『退避 → 削除 → 復元』の訓練(使い捨て PostgreSQL。本番には接続しない)。
// 本番相当: interactions → customers は ON DELETE CASCADE(本番で確認済み)、customers に実験グループの割り当てトリガーがある。
// 実行: node --experimental-strip-types test_sample_delete_restore.mjs
import { startPg, q } from "./pgdb.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const pg = startPg(); let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const val = (sql) => pg.exec(sql);
try {
  pg.loadFile("000_prodlike_schema.sql");
  pg.exec(`create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into stores(name) values('10ZEN');`);
  pg.loadFile("003_membership_checkin_rpc.sql");
  // 本番と同じ外部キー(interactions -> customers は連動削除)にそろえる
  pg.exec(`do $$ declare c text; begin select conname into c from pg_constraint where conrelid='public.interactions'::regclass and confrelid='public.customers'::regclass and contype='f';
    execute format('alter table public.interactions drop constraint %I', c);
    alter table public.interactions add constraint interactions_customer_id_fkey foreign key (customer_id) references public.customers(id) on delete cascade; end $$;`);
  // 本番相当の規模のサンプル: 顧客4・履歴81・来店イベント3 + 削除対象ではない顧客1(巻き込まれないことの確認)
  const ids = ["a", "b", "c", "d"].map((k, i) => `00000000-0000-0000-0000-00000000010${i}`); const keep = "00000000-0000-0000-0000-000000000199";
  pg.exec(`insert into customers(id, store_id, line_user_id, visit_count, points, experiment_group, first_visited_at, last_visited_at)
    select v.id::uuid, (select id from stores limit 1), 'U' || repeat(v.k, 32), v.n, v.p, v.g, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z' from (values ${ids.map((id, i) => `('${id}', '${"abcd"[i]}', ${i + 1}, ${i * 100}, '${i % 2 ? "control" : "treatment"}')`).join(",")}) v(id, k, n, p, g);
    insert into customers(id, store_id, line_user_id, visit_count, points, experiment_group) values ('${keep}', (select id from stores limit 1), 'U' || repeat('z', 32), 1, 0, 'control');
    insert into interactions(store_id, customer_id, trigger_type, message, reason, sent_at)
      select (select id from stores limit 1), (case when g % 20 = 0 then '${keep}' else (array['${ids.join("','")}'])[1 + g % 4] end)::uuid, 'followup', 'm' || g, 'r' || g, '2026-09-01T00:00:00Z'::timestamptz + g * interval '1 hour' from generate_series(1, 81) g;
    insert into membership_events(store_id, event_key, event_at, seq) values ${[0, 1, 2].map((i) => `((select id from stores limit 1), 'pv:U' || repeat('${"abc"[i]}', 32), '2026-10-01T00:00:00Z', 1790000000000 + ${i})`).join(",")};`);   // 本番の実態: pv:<LINE ID>(ポイント値の版の記録)3件
  const cnt = () => val(`select (select count(*) from customers) || '/' || (select count(*) from interactions) || '/' || (select count(*) from membership_events);`);
  const before = cnt();
  const idList = ids.map((i) => `'${i}'`).join(",");
  // G-1: 退避(対象の行だけを全列で書き出し、件数と SHA-256 を記録)
  const dump = (sql) => val(sql);
  const exportAll = () => ({
    customers: JSON.parse(dump(`select coalesce(json_agg(c order by c.id), '[]') from customers c where id in (${idList});`)),
    interactions: JSON.parse(dump(`select coalesce(json_agg(i order by i.id), '[]') from interactions i where customer_id in (${idList});`)),
    events: JSON.parse(dump(`select coalesce(json_agg(e order by e.event_key), '[]') from membership_events e where event_key in (select 'pv:' || line_user_id from customers where id in (${idList}));`)) });
  const ex = exportAll(); const sha = crypto.createHash("sha256").update(JSON.stringify(ex)).digest("hex");
  assert.equal(ex.customers.length, 4); assert.ok(ex.interactions.length > 0 && ex.interactions.length < 81); assert.equal(ex.events.length, 3);
  const nInter = ex.interactions.length;
  // 削除: 一覧の id だけを1回の取引で。連動削除で履歴も消えることを確認(件数で検知できる)
  val(`begin; delete from membership_events where event_key in (select 'pv:' || line_user_id from customers where id in (${idList})); delete from customers where id in (${idList}); commit;`);
  assert.equal(val(`select count(*) from customers;`), "1"); assert.equal(val(`select count(*) from interactions;`), String(81 - nInter)); assert.equal(val(`select count(*) from membership_events;`), "0");
  assert.equal(val(`select count(*) from customers where id='${keep}';`), "1");                      // 一覧外の顧客は残る
  ok(`削除: 一覧の顧客4件を消すと、履歴 ${nInter} 件が連動して消える(ON DELETE CASCADE)。一覧外の顧客と履歴は残り、来店イベントも対象分だけ消える`);
  // G-3: 復元(customers → interactions → membership_events。元の id のまま)
  const j = (o) => q(JSON.stringify(o));
  val(`begin;
    insert into customers select * from jsonb_populate_recordset(null::customers, ${j(ex.customers)}::jsonb);
    insert into interactions select * from jsonb_populate_recordset(null::interactions, ${j(ex.interactions)}::jsonb);
    insert into membership_events select * from jsonb_populate_recordset(null::membership_events, ${j(ex.events)}::jsonb); commit;`);
  assert.equal(cnt(), before);
  const after = exportAll(); assert.equal(crypto.createHash("sha256").update(JSON.stringify(after)).digest("hex"), sha);
  assert.equal(JSON.stringify(after.customers.map((c) => c.experiment_group)), JSON.stringify(ex.customers.map((c) => c.experiment_group)));   // 実験グループは元の値のまま(トリガーで再割り当てされない)
  ok("復元: 退避ファイルから元の id のまま戻し、件数(顧客/履歴/来店イベント)と全列の SHA-256 が退避時と一致。実験グループも元の値のまま");
  // 再実行しても二重にならない(復元済みに再度挿入すると主キー重複で止まる=黙って重複しない)
  assert.throws(() => val(`insert into customers select * from jsonb_populate_recordset(null::customers, ${j(ex.customers)}::jsonb);`), /duplicate key/);
  ok("復元の二重実行は主キー重複で止まる(データが重複しない)");
  console.log(`\n${n} sample restore tests passed`);
} finally { pg.stop(); }
