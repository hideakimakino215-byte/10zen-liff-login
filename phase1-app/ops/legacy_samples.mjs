// サンプル削除(退避→削除→復元)で使う SQL を作る。本番で実行する SQL と、テストで実行する SQL は同じこの関数が作る。
//  * exportSql(ids): 読み取りだけ。対象の customers / interactions / membership_events(pv:<LINE ID>)を全列 JSON で返す
//  * deleteSql(ids, expect): 1つの DO で原子的に実行。対象の件数が expect と1件でも違えば何も削除せずに中止。一覧にない行は消さない
//  * restoreSql(dump): 退避した JSON から、元の id のまま customers → interactions → membership_events の順に戻す(1つの DO)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const list = (ids) => { if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => UUID.test(i))) throw new Error("customers の id(UUID)の一覧が必要です"); return ids.map((i) => `'${i}'`).join(","); };
const evKeys = (l) => `select 'pv:' || line_user_id from public.customers where id in (${l})`;
export function exportSql(ids) {
  const l = list(ids);
  return `select jsonb_build_object(
  'customers',    (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]'::jsonb) from public.customers c where c.id in (${l})),
  'interactions', (select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb) from public.interactions i where i.customer_id in (${l})),
  'events',       (select coalesce(jsonb_agg(to_jsonb(e) order by e.event_key), '[]'::jsonb) from public.membership_events e where e.event_key in (${evKeys(l)}))) as dump;`;
}
export function deleteSql(ids, expect) {
  const l = list(ids);
  for (const k of ["customers", "interactions", "events"]) if (!Number.isInteger(expect?.[k]) || expect[k] < 0) throw new Error("想定件数 expect.customers / interactions / events が必要です");
  return `do $del$
declare nc int; ni int; ne int;
begin
  select count(*) into nc from public.customers where id in (${l});
  select count(*) into ni from public.interactions where customer_id in (${l});
  select count(*) into ne from public.membership_events where event_key in (${evKeys(l)});
  if nc <> ${expect.customers} or ni <> ${expect.interactions} or ne <> ${expect.events} then
    raise exception 'DELETE_ABORTED count mismatch: customers=% interactions=% events=%', nc, ni, ne;
  end if;
  delete from public.membership_events where event_key in (${evKeys(l)});
  delete from public.customers where id in (${l});
  if (select count(*) from public.customers where id in (${l})) <> 0 or (select count(*) from public.interactions where customer_id in (${l})) <> 0 then
    raise exception 'DELETE_ABORTED rows remain';
  end if;
end
$del$;`;
}
export function restoreSql(dump) {
  if (!dump || !Array.isArray(dump.customers) || !Array.isArray(dump.interactions) || !Array.isArray(dump.events)) throw new Error("退避ファイルの形式が不正です");
  const lit = (o) => `$j$${JSON.stringify(o)}$j$::jsonb`;
  if (JSON.stringify(dump).includes("$j$")) throw new Error("退避ファイルに区切り文字が含まれています");
  // customers の挿入前トリガー(実験グループの自動割り当て)は、元の値(null を含む)をそのまま戻すため、この取引の中だけ止める(原子的。失敗すれば元に戻る)
  return `do $res$
begin
  alter table public.customers disable trigger trg_assign_experiment_group;
  insert into public.customers select * from jsonb_populate_recordset(null::public.customers, ${lit(dump.customers)});
  insert into public.interactions select * from jsonb_populate_recordset(null::public.interactions, ${lit(dump.interactions)});
  insert into public.membership_events select * from jsonb_populate_recordset(null::public.membership_events, ${lit(dump.events)});
  alter table public.customers enable trigger trg_assign_experiment_group;
end
$res$;`;
}
