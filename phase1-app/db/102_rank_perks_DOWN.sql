-- 102_rank_perks.sql の取り消し(戻し)用。102 で作った物を削除し、置き換えた関数(app_me / export_backup / restore_backup)を 100 の内容に戻し、
-- ランクの基準を元の値(0 / 10,000 / 50,000 / 100,000 / 200,000)に戻して、会員のランクを付け直す。
-- 注意: 発行済み・使用済みの特典チケットの記録も消える。必ず先に export_backup() で書き出して保管すること(適用前・チケット0件なら安全)。
--       基準を戻すので、会員のランクは下がることがある(戻しのときだけ。通常の運用ではランクは下がらない)。
begin;
drop trigger if exists redeem_code_not_in_tickets on public.redeem_requests;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_season_of','_issue_perk_tickets','_perk_snapshot','_member_view','_redeem_code_guard','app_ticket_request','app_ticket_cancel',
                                                                 'staff_lookup_code','staff_confirm_ticket','staff_cancel_ticket','staff_ticket_stats']) loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

-- 100 の内容に戻す(本文は 100_phase1_schema.sql と同じ。権限は置き換え前から変わっていない)
create or replace function public.app_me(p_issuer text, p_subject text, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; iss text := public._gate(p_issuer, p_subject);
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id;
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  update public.redeem_requests set status = 'expired' where member_id = m.id and status = 'pending' and expires_at <= p_now;
  return jsonb_build_object('status', 'ok', 'member', public._snapshot(m.id, p_now));
end $$;

create or replace function public.export_backup() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('version', 1, 'exportedAt', now(), 'tables', jsonb_build_object(
    'app_settings',     (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.app_settings t),
    'point_rules',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.point_rules t),
    'rank_thresholds',  (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.rank_thresholds t),
    'policy_decisions', (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.policy_decisions t),
    'system_state',     (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.system_state t),
    'test_allowlist',   (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.test_allowlist t),
    'members',          (select coalesce(jsonb_agg(to_jsonb(t) order by t.member_no), '[]') from public.members t),
    'member_identities',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from public.member_identities t),
    'point_ledger',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.point_ledger t),
    'visits',           (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.visits t),
    'redeem_requests',  (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from public.redeem_requests t),
    'staff_users',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.staff_users t),
    'audit_log',        (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from (select * from public.audit_log order by id desc limit 5000) t)));
end $$;

create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t jsonb := p -> 'tables'; mx bigint; bad integer;
begin
  if (p ->> 'version') is distinct from '1' or t is null then raise exception 'invalid_backup' using errcode = '22023'; end if;
  if exists (select 1 from public.members) or exists (select 1 from public.point_ledger) then raise exception 'target_not_empty' using errcode = '55000'; end if;
  insert into public.rank_thresholds select * from jsonb_populate_recordset(null::public.rank_thresholds, t -> 'rank_thresholds')
    on conflict (rank_code) do update set min_points = excluded.min_points, label = excluded.label;
  insert into public.app_settings select * from jsonb_populate_recordset(null::public.app_settings, t -> 'app_settings')
    on conflict (key) do update set value = excluded.value, note = excluded.note;
  insert into public.point_rules select * from jsonb_populate_recordset(null::public.point_rules, t -> 'point_rules')
    on conflict (code) do update set points = excluded.points, active = excluded.active, starts_on = excluded.starts_on, ends_on = excluded.ends_on, description = excluded.description;
  insert into public.policy_decisions select * from jsonb_populate_recordset(null::public.policy_decisions, t -> 'policy_decisions')
    on conflict (key) do update set decided = excluded.decided, value = excluded.value, note = excluded.note, decided_at = excluded.decided_at, decided_via = excluded.decided_via;
  insert into public.test_allowlist select * from jsonb_populate_recordset(null::public.test_allowlist, t -> 'test_allowlist') on conflict do nothing;
  insert into public.members select * from jsonb_populate_recordset(null::public.members, t -> 'members');
  insert into public.member_identities select * from jsonb_populate_recordset(null::public.member_identities, t -> 'member_identities');
  insert into public.point_ledger overriding system value select * from jsonb_populate_recordset(null::public.point_ledger, t -> 'point_ledger');
  insert into public.visits overriding system value select * from jsonb_populate_recordset(null::public.visits, t -> 'visits');
  insert into public.redeem_requests select * from jsonb_populate_recordset(null::public.redeem_requests, t -> 'redeem_requests');
  insert into public.staff_users select s.* from jsonb_populate_recordset(null::public.staff_users, t -> 'staff_users') s where exists (select 1 from auth.users u where u.id = s.user_id);
  insert into public.audit_log overriding system value select * from jsonb_populate_recordset(null::public.audit_log, t -> 'audit_log');
  select coalesce(max(substr(member_no, 5)::bigint), 0) into mx from public.members where member_no ~ '^user[0-9]+$';
  perform setval('public.member_no_seq', greatest(mx, 1), mx > 0);
  select coalesce(max(substr(member_no, 2)::bigint), 0) into mx from public.members where member_no ~ '^T[0-9]+$';
  perform setval('public.test_member_no_seq', greatest(mx, 1), mx > 0);
  perform setval(pg_get_serial_sequence('public.point_ledger', 'id'), greatest((select coalesce(max(id), 0) from public.point_ledger), 1), (select count(*) > 0 from public.point_ledger));
  perform setval(pg_get_serial_sequence('public.visits', 'id'), greatest((select coalesce(max(id), 0) from public.visits), 1), (select count(*) > 0 from public.visits));
  perform setval(pg_get_serial_sequence('public.audit_log', 'id'), greatest((select coalesce(max(id), 0) from public.audit_log), 1), (select count(*) > 0 from public.audit_log));
  update public.system_state set state = 'frozen', reconciled = false, reconciled_at = null, changed_at = now();
  select count(*) into bad from public.verify_balances();
  return jsonb_build_object('status', 'restored', 'members', (select count(*) from public.members), 'ledger', (select count(*) from public.point_ledger),
                            'balanceMismatches', bad, 'state', 'frozen');
end $$;

drop table if exists public.perk_ticket_requests, public.perk_tickets, public.perk_ticket_types;

-- ランクの基準を元に戻す(min_points は一意。重ならないよう大きい順に戻す)
update public.rank_thresholds set min_points = 200000 where rank_code = 'onyx';
update public.rank_thresholds set min_points = 100000 where rank_code = 'ruby';
update public.rank_thresholds set min_points = 50000  where rank_code = 'emerald';
update public.rank_thresholds set min_points = 10000  where rank_code = 'amber';
do $$
declare r record;
begin
  for r in update public.members m set rank_code = public.rank_for(public._effective_lifetime(m)), updated_at = now()
           where m.rank_code is distinct from public.rank_for(public._effective_lifetime(m)) returning m.id, m.is_test loop
    if not r.is_test then perform public._mirror(r.id, null, null); end if;
  end loop;
end $$;
commit;
