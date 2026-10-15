-- 106_referral.sql の取り消し(戻し)用。106 で作った物を削除し、置き換えた関数を元に戻す:
--   app_register・app_checkin(100 の内容)、_member_view(103)、staff_kpi_overview・export_backup・restore_backup(105)。
-- 注意: 招待コード・紹介の記録・紹介の特典チケット(使用の申請を含む)も消える。必ず先に export_backup() で書き出して保管すること(適用前・0件なら安全)。
--       紹介者に付けた 100pt(台帳の referral_visit)は台帳に残る(台帳は追記専用。残高もそのまま)。members.referred_by の値も残る(100 からある列)。
--       監査ログ(referral_reward・referral_over_cap・dinner_tea_mode)は残る。
begin;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_dinner_tea_label','_invite_code_for','_invite_snapshot','_referral_reward','_referral_month','_kpi_with_referral',
                                                                 'app_register','app_invite_seen','staff_referral_stats','manager_set_dinner_tea_mode','report_monthly']) loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

-- 100 の内容に戻す(本文は 100_phase1_schema.sql と同じ)。app_register は作り直したので、権限も 100 と同じに付け直す(service_role だけ)
create function public.app_register(p_issuer text, p_subject text, p_display_name text, p_referrer_member_no text default null, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; mid uuid; nm text; ref public.members; on_date date := public._jst_date(p_now); pts integer; rp integer; cp integer; created boolean := false;
        iss text; tst boolean;
begin
  if coalesce(p_issuer, '') = '' or coalesce(p_subject, '') = '' then raise exception 'invalid_identity' using errcode = '22023'; end if;
  iss := public._gate(p_issuer, p_subject); tst := iss <> p_issuer;
  perform pg_advisory_xact_lock(hashtextextended('reg:' || iss || ':' || p_subject, 0));
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if found then
    return jsonb_build_object('status', 'existing', 'member', public._snapshot(ident.member_id, p_now));
  end if;
  if not public._throttle('reg:' || iss || ':' || p_subject, 5, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  -- 全体の新規登録にも上限(スクリプトによる大量登録の抑止。店舗の規模では1時間100人を超えない前提。超えたら 429 になり、スタッフが気づける)
  if not public._throttle('reg:*' || case when tst then 'test' else '' end, 100, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  nm := nullif(btrim(regexp_replace(coalesce(p_display_name, ''), '[[:cntrl:]]', '', 'g')), '');
  nm := left(nm, 40);
  insert into public.members(member_no, display_name, lifetime_base, is_test) values (case when tst then public.next_test_member_no() else public.next_member_no() end, nm, 0, tst) returning id into mid;   -- 新規会員の累計は 0 から確定(開始時の不明はない)
  insert into public.member_identities(member_id, provider, issuer, subject, verified_at) values (mid, 'line', iss, p_subject, p_now);
  created := true;
  -- 紹介(有効な会員番号のみ。自分自身は不可能: まだ会員番号を持たない)
  if coalesce(btrim(p_referrer_member_no), '') <> '' then
    select * into ref from public.members where lower(member_no) = lower(btrim(p_referrer_member_no)) and status = 'active' and id <> mid and is_test = tst;
  end if;
  if ref.id is not null then
    rp := public._rule_points('referral_referrer', on_date);
    pts := public._rule_points('referral_welcome', on_date);
    if rp is not null and pts is not null then
      update public.members set referred_by = ref.id where id = mid;
      perform public._grant(ref.id, 'earn', 'referral_referrer', rp, 'referral:' || ref.id || ':' || mid, 'app', mid::text, p_now);
      perform public._grant(mid, 'earn', 'referral_welcome', pts, 'referral_welcome:' || mid, 'app', ref.id::text, p_now);
      perform public._mirror(ref.id, null, null);
    else ref := null; end if;
  end if;
  if ref.id is null then
    pts := public._rule_points('welcome', on_date);
    if pts is not null then perform public._grant(mid, 'earn', 'welcome', pts, 'welcome:' || mid, 'app', null, p_now); end if;
  end if;
  cp := public._rule_points('campaign_welcome', on_date);
  if cp is not null then perform public._grant(mid, 'earn', 'campaign_welcome', cp, 'campaign:' || mid, 'app', null, p_now); end if;
  update public.members set last_activity_on = on_date where id = mid;
  -- 既存GASと同じく、登録した日は来店日として扱う(同じ日の来店ポイントは付かない)。設定 register_counts_as_visit=false で解除
  if coalesce((select value from public.app_settings where key = 'register_counts_as_visit'), 'true') = 'true' then
    insert into public.visits(member_id, visit_on, source) values (mid, on_date, 'register') on conflict (member_id, visit_on) do nothing;
  end if;
  -- 登録日を来店扱いにしない設定(false)のときは、既存 customers(来店回数・最終来店日)に何も反映しない。最初の実際の来店で customers が作られる
  if coalesce((select value from public.app_settings where key = 'register_counts_as_visit'), 'true') = 'true' then
    perform public._mirror(mid, on_date, p_now);
  end if;
  return jsonb_build_object('status', 'created', 'member', public._snapshot(mid, p_now));
end $$;
revoke execute on function public.app_register(text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.app_register(text, text, text, text, timestamptz) to service_role;

create or replace function public.app_checkin(p_issuer text, p_subject text, p_token_slot bigint default null, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; d date := public._jst_date(p_now); pts integer; vid bigint; lid bigint; v public.visits; iss text := public._gate(p_issuer, p_subject);
        h numeric := extract(hour from p_now at time zone 'Asia/Tokyo') + extract(minute from p_now at time zone 'Asia/Tokyo') / 60;
begin
  if h < public._setting_int('checkin_open_hour', 0) or h >= public._setting_int('checkin_close_hour', 24) then return jsonb_build_object('status', 'outside_hours'); end if;   -- 営業時間外のQR利用を拒否(写真のQRの不正対策)
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;     -- 会員ごとに直列化
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  select * into v from public.visits where member_id = m.id and visit_on = d;
  if found then
    return jsonb_build_object('status', 'already_today', 'reason', case when v.source = 'register' then 'registered_today' else 'visited_today' end,
                              'granted', 0, 'member', public._snapshot(m.id, p_now));
  end if;
  pts := public._rule_points('visit', d);
  insert into public.visits(member_id, visit_on, token_slot) values (m.id, d, p_token_slot) returning id into vid;
  if pts is not null then
    lid := public._grant(m.id, 'earn', 'visit', pts, 'visit:' || m.id || ':' || d, 'store_qr', vid::text, p_now);
  end if;
  update public.members set last_activity_on = d where id = m.id;
  perform public._mirror(m.id, d, p_now);
  return jsonb_build_object('status', 'counted', 'granted', coalesce(pts, 0), 'member', public._snapshot(m.id, p_now));
end $$;

-- 103 の内容に戻す(本文は 103_constitution_check.sql と同じ。権限は置き換え前から変わっていない)
create or replace function public._member_view(p_member uuid, p_now timestamptz) returns jsonb
language sql security definer set search_path = public as
  $$ select public._snapshot(p_member, p_now) || public._perk_snapshot(p_member, p_now) || public._constitution_snapshot(p_member, p_now) $$;

-- 105 の内容に戻す(本文は 105_kpi.sql と同じ。権限は置き換え前から変わっていない)
create or replace function public.staff_kpi_overview(p_months integer default 13) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  perform public._require_role('viewer');                                   -- スタッフ以外・無効・店頭タブレットは拒否
  r := public._staff_role();
  if r not in ('manager', 'viewer') then raise exception 'forbidden' using errcode = '42501'; end if;   -- スタッフ(staff)も拒否
  return public._kpi_overview(public._state() = 'test', p_months, now())
    || jsonb_build_object('state', public._state(), 'canEdit', r = 'manager');
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
    'perk_ticket_types',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.code), '[]') from public.perk_ticket_types t),
    'perk_tickets',         (select coalesce(jsonb_agg(to_jsonb(t) order by t.issued_at, t.id), '[]') from public.perk_tickets t),
    'perk_ticket_requests', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from public.perk_ticket_requests t),
    'constitution_consents',         (select coalesce(jsonb_agg(to_jsonb(t) order by t.consented_at, t.member_id), '[]') from public.constitution_consents t),
    'constitution_checks',           (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from public.constitution_checks t),
    'constitution_daily_conditions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.on_date, t.member_id), '[]') from public.constitution_daily_conditions t),
    'constitution_referral_clicks',  (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.constitution_referral_clicks t),
    'kpi_settings',          (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.kpi_settings t),
    'kpi_targets',           (select coalesce(jsonb_agg(to_jsonb(t) order by t.kpi_code, t.milestone), '[]') from public.kpi_targets t),
    'pos_daily_customers',   (select coalesce(jsonb_agg(to_jsonb(t) order by t.is_test, t.business_date), '[]') from public.pos_daily_customers t),
    'pos_monthly_customers', (select coalesce(jsonb_agg(to_jsonb(t) order by t.is_test, t.month), '[]') from public.pos_monthly_customers t),
    'staff_users',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.staff_users t),
    'audit_log',        (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from (select * from public.audit_log order by id desc limit 5000) t)));
end $$;

create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t jsonb := p -> 'tables'; mx bigint; bad integer;
begin
  if (p ->> 'version') is distinct from '1' or t is null then raise exception 'invalid_backup' using errcode = '22023'; end if;
  if exists (select 1 from public.members) or exists (select 1 from public.point_ledger) or exists (select 1 from public.perk_tickets)
     or exists (select 1 from public.constitution_checks) or exists (select 1 from public.pos_daily_customers) then raise exception 'target_not_empty' using errcode = '55000'; end if;
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
  insert into public.perk_ticket_types select * from jsonb_populate_recordset(null::public.perk_ticket_types, coalesce(t -> 'perk_ticket_types', '[]'::jsonb))
    on conflict (code) do update set kind = excluded.kind, rank_code = excluded.rank_code, label = excluded.label, valid_days = excluded.valid_days, active = excluded.active;
  insert into public.perk_tickets select * from jsonb_populate_recordset(null::public.perk_tickets, coalesce(t -> 'perk_tickets', '[]'::jsonb));
  insert into public.perk_ticket_requests select * from jsonb_populate_recordset(null::public.perk_ticket_requests, coalesce(t -> 'perk_ticket_requests', '[]'::jsonb));
  insert into public.constitution_consents select * from jsonb_populate_recordset(null::public.constitution_consents, coalesce(t -> 'constitution_consents', '[]'::jsonb));
  insert into public.constitution_checks select * from jsonb_populate_recordset(null::public.constitution_checks, coalesce(t -> 'constitution_checks', '[]'::jsonb));
  insert into public.constitution_daily_conditions select * from jsonb_populate_recordset(null::public.constitution_daily_conditions, coalesce(t -> 'constitution_daily_conditions', '[]'::jsonb));
  insert into public.constitution_referral_clicks overriding system value
    select * from jsonb_populate_recordset(null::public.constitution_referral_clicks, coalesce(t -> 'constitution_referral_clicks', '[]'::jsonb));
  insert into public.kpi_settings select * from jsonb_populate_recordset(null::public.kpi_settings, coalesce(t -> 'kpi_settings', '[]'::jsonb))
    on conflict (id) do update set launch_date = excluded.launch_date, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  insert into public.kpi_targets select * from jsonb_populate_recordset(null::public.kpi_targets, coalesce(t -> 'kpi_targets', '[]'::jsonb))
    on conflict (kpi_code, milestone) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  insert into public.pos_daily_customers select * from jsonb_populate_recordset(null::public.pos_daily_customers, coalesce(t -> 'pos_daily_customers', '[]'::jsonb));
  insert into public.pos_monthly_customers select * from jsonb_populate_recordset(null::public.pos_monthly_customers, coalesce(t -> 'pos_monthly_customers', '[]'::jsonb))
    on conflict (is_test, month) do update set customers = excluded.customers, entered_at = excluded.entered_at, entered_by = excluded.entered_by;
  insert into public.staff_users select s.* from jsonb_populate_recordset(null::public.staff_users, t -> 'staff_users') s where exists (select 1 from auth.users u where u.id = s.user_id);
  insert into public.audit_log overriding system value select * from jsonb_populate_recordset(null::public.audit_log, t -> 'audit_log');
  select coalesce(max(substr(member_no, 5)::bigint), 0) into mx from public.members where member_no ~ '^user[0-9]+$';
  perform setval('public.member_no_seq', greatest(mx, 1), mx > 0);
  select coalesce(max(substr(member_no, 2)::bigint), 0) into mx from public.members where member_no ~ '^T[0-9]+$';
  perform setval('public.test_member_no_seq', greatest(mx, 1), mx > 0);
  perform setval(pg_get_serial_sequence('public.point_ledger', 'id'), greatest((select coalesce(max(id), 0) from public.point_ledger), 1), (select count(*) > 0 from public.point_ledger));
  perform setval(pg_get_serial_sequence('public.visits', 'id'), greatest((select coalesce(max(id), 0) from public.visits), 1), (select count(*) > 0 from public.visits));
  perform setval(pg_get_serial_sequence('public.audit_log', 'id'), greatest((select coalesce(max(id), 0) from public.audit_log), 1), (select count(*) > 0 from public.audit_log));
  perform setval(pg_get_serial_sequence('public.constitution_referral_clicks', 'id'), greatest((select coalesce(max(id), 0) from public.constitution_referral_clicks), 1),
                 (select count(*) > 0 from public.constitution_referral_clicks));
  update public.system_state set state = 'frozen', reconciled = false, reconciled_at = null, changed_at = now();
  select count(*) into bad from public.verify_balances();
  return jsonb_build_object('status', 'restored', 'members', (select count(*) from public.members), 'ledger', (select count(*) from public.point_ledger),
                            'balanceMismatches', bad, 'state', 'frozen');
end $$;

drop table if exists public.member_referrals, public.member_invite_codes;
-- 紹介の特典チケット(と、その使用の申請)を消してから、チケットの種類の制約を 102 の形に戻す
delete from public.perk_ticket_requests where ticket_id in (select id from public.perk_tickets where kind = 'referral');
delete from public.perk_tickets where kind = 'referral';
delete from public.perk_ticket_types where kind = 'referral';
alter table public.perk_tickets drop constraint perk_tickets_kind_check;
alter table public.perk_tickets add constraint perk_tickets_kind_check check (kind in ('milestone','seasonal'));
alter table public.perk_ticket_types drop constraint perk_ticket_types_check;
alter table public.perk_ticket_types add constraint perk_ticket_types_check check ((kind = 'milestone') = (valid_days is not null));
alter table public.perk_ticket_types drop constraint perk_ticket_types_kind_check;
alter table public.perk_ticket_types add constraint perk_ticket_types_kind_check check (kind in ('milestone','seasonal'));
delete from public.point_rules where code = 'referral_visit';
delete from public.app_settings where key in ('dinner_tea_mode', 'referral_monthly_cap');
commit;
