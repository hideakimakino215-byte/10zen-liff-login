-- 116 の戻し: 関数を 115 までの内容に戻し、order_clicks と初回特典の種類を消し、設定 points_redeemable を消す。
-- 注意: 116 のあとに発行された初回特典のチケット・押された数の記録も消える(戻すのは本番開始の前を想定)。
begin;
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
    'member_invite_codes',   (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.member_id), '[]') from public.member_invite_codes t),
    'member_referrals',      (select coalesce(jsonb_agg(to_jsonb(t) order by t.registered_at, t.referred_member_id), '[]') from public.member_referrals t),
    'staff_users',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.staff_users t),
    'audit_log',        (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from (select * from public.audit_log order by id desc limit 5000) t)));
end $$;

CREATE OR REPLACE FUNCTION public.restore_backup(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t jsonb := p -> 'tables'; mx bigint; bad integer; old_fmt boolean; hi bigint; rr record; reranked integer := 0;
begin
  if (p ->> 'version') is distinct from '1' or t is null then raise exception 'invalid_backup' using errcode = '22023'; end if;
  if exists (select 1 from public.members) or exists (select 1 from public.point_ledger) or exists (select 1 from public.perk_tickets)
     or exists (select 1 from public.constitution_checks) or exists (select 1 from public.pos_daily_customers) or exists (select 1 from public.member_referrals)
     then raise exception 'target_not_empty' using errcode = '55000'; end if;
  -- ランクの基準: 102 より前のバックアップ(perk_ticket_types がない)なら今の基準を残す。102 以降なら、重ならない値へずらしてから置き換える
  old_fmt := not (t ? 'perk_ticket_types');
  if not old_fmt then
    if jsonb_typeof(t -> 'rank_thresholds') is distinct from 'array'
       or exists (select 1 from jsonb_populate_recordset(null::public.rank_thresholds, t -> 'rank_thresholds') x where x.rank_code is null or x.min_points is null or x.label is null)
       then raise exception 'invalid_backup' using errcode = '22023', detail = 'rank_thresholds'; end if;
    select greatest(coalesce((select max(min_points) from public.rank_thresholds), 0),
                    coalesce((select max(x.min_points) from jsonb_populate_recordset(null::public.rank_thresholds, t -> 'rank_thresholds') x), 0)) into hi;
    update public.rank_thresholds rt set min_points = hi + s.rn
      from (select rank_code, row_number() over (order by rank_code) rn from public.rank_thresholds
            where rank_code in (select x.rank_code from jsonb_populate_recordset(null::public.rank_thresholds, t -> 'rank_thresholds') x)) s
      where rt.rank_code = s.rank_code;
    insert into public.rank_thresholds select * from jsonb_populate_recordset(null::public.rank_thresholds, t -> 'rank_thresholds')
      on conflict (rank_code) do update set min_points = excluded.min_points, label = excluded.label;
  end if;
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
  insert into public.member_invite_codes select * from jsonb_populate_recordset(null::public.member_invite_codes, coalesce(t -> 'member_invite_codes', '[]'::jsonb));
  insert into public.member_referrals select * from jsonb_populate_recordset(null::public.member_referrals, coalesce(t -> 'member_referrals', '[]'::jsonb));
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
  update public.system_state set state = 'frozen', reconciled = false, reconciled_at = null, changed_at = now() where id;
  -- 102 より前のバックアップ: 会員のランクを今の基準で付け直す(102 の適用時と同じ処理。frozen の後なので _mirror は何も書かない)
  if old_fmt then
    for rr in update public.members m set rank_code = public.rank_for(public._effective_lifetime(m)), updated_at = now()
              where m.rank_code is distinct from public.rank_for(public._effective_lifetime(m)) returning m.id, m.is_test loop
      reranked := reranked + 1;
      if not rr.is_test then perform public._mirror(rr.id, null, null); end if;
    end loop;
  end if;
  select count(*) into bad from public.verify_balances();
  return jsonb_build_object('status', 'restored', 'members', (select count(*) from public.members), 'ledger', (select count(*) from public.point_ledger),
                            'balanceMismatches', bad, 'state', 'frozen',
                            'rankThresholds', case when old_fmt then 'kept_current' else 'restored' end, 'reranked', reranked);
end $function$;

create or replace function public.app_register(p_issuer text, p_subject text, p_display_name text, p_referrer_member_no text default null, p_now timestamptz default now(),
                                    p_invite_code text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; mid uuid; nm text; ref public.members; on_date date := public._jst_date(p_now); pts integer; cp integer;
        iss text; tst boolean; inv text; ic text := nullif(btrim(coalesce(p_invite_code, '')), ''); used integer; mk text := to_char(public._jst_date(p_now), 'YYYY-MM');
begin
  if coalesce(p_issuer, '') = '' or coalesce(p_subject, '') = '' then raise exception 'invalid_identity' using errcode = '22023'; end if;
  iss := public._gate(p_issuer, p_subject); tst := iss <> p_issuer;
  perform pg_advisory_xact_lock(hashtextextended('reg:' || iss || ':' || p_subject, 0));
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if found then
    return jsonb_build_object('status', 'existing', 'member', public._member_view(ident.member_id, p_now));       -- すでに会員: 招待のリンクから開いても紹介にはならない
  end if;
  if not public._throttle('reg:' || iss || ':' || p_subject, 5, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  if not public._throttle('reg:*' || case when tst then 'test' else '' end, 100, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  nm := nullif(btrim(regexp_replace(coalesce(p_display_name, ''), '[[:cntrl:]]', '', 'g')), '');
  nm := left(nm, 40);
  insert into public.members(member_no, display_name, lifetime_base, is_test) values (case when tst then public.next_test_member_no() else public.next_member_no() end, nm, 0, tst) returning id into mid;
  insert into public.member_identities(member_id, provider, issuer, subject, verified_at) values (mid, 'line', iss, p_subject, p_now);
  -- 招待コード: 有効な会員(停止中でない・試験/本番の区分が同じ・自分以外)のコードだけ。紹介者ごとに日本時間の暦月で上限まで
  if ic is not null then
    if ic ~ '^[A-Za-z0-9_-]{12}$' then
      select r.* into ref from public.member_invite_codes c join public.members r on r.id = c.member_id
        where c.code = ic and r.status = 'active' and r.is_test = tst and r.id <> mid;
    end if;
    if ref.id is null then inv := 'invalid';
    else
      perform 1 from public.members where id = ref.id for update;                                 -- 同じ紹介者への同時の登録を直列化(上限を超えない)
      select count(*) into used from public.member_referrals where referrer_member_id = ref.id and registered_month = mk;
      if used >= public._setting_int('referral_monthly_cap', 5) then
        inv := 'over_cap';
        perform public._audit(null, 'referral_over_cap', ref.id, jsonb_build_object('month', mk));
      else
        insert into public.member_referrals(referred_member_id, referrer_member_id, invite_code, registered_at, registered_month) values (mid, ref.id, ic, p_now, mk);
        update public.members set referred_by = ref.id where id = mid;
        inv := 'linked';
      end if;
    end if;
  end if;
  -- 登録ボーナスは通常どおり(紹介でも増やさない)。旧ルールの referral_referrer / referral_welcome は使わない
  pts := public._rule_points('welcome', on_date);
  if pts is not null then perform public._grant(mid, 'earn', 'welcome', pts, 'welcome:' || mid, 'app', null, p_now); end if;
  cp := public._rule_points('campaign_welcome', on_date);
  if cp is not null then perform public._grant(mid, 'earn', 'campaign_welcome', cp, 'campaign:' || mid, 'app', null, p_now); end if;
  update public.members set last_activity_on = on_date where id = mid;
  if coalesce((select value from public.app_settings where key = 'register_counts_as_visit'), 'true') = 'true' then
    insert into public.visits(member_id, visit_on, source) values (mid, on_date, 'register') on conflict (member_id, visit_on) do nothing;
    perform public._mirror(mid, on_date, p_now);
  end if;
  return jsonb_build_object('status', 'created', 'member', public._member_view(mid, p_now), 'invite', inv);
end $$;

create or replace function public._referral_reward(p_referred uuid, p_now timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare r public.member_referrals; ref public.members; ty public.perk_ticket_types; d date := public._jst_date(p_now); t1 uuid; t2 uuid; pts integer; lid bigint; kind text;
        amber_min integer; ref_min integer; exp timestamptz; ttl text;
begin
  select * into r from public.member_referrals where referred_member_id = p_referred for update;
  if not found or r.rewarded_at is not null then return null; end if;
  select * into ty from public.perk_ticket_types where code = 'referral_tea';
  ttl := 'お友だち紹介・' || public._dinner_tea_label();
  exp := ((d + coalesce(ty.valid_days, 60) + 1)::timestamp at time zone 'Asia/Tokyo');          -- 発行日から60日目の終わり(日本時間)まで(102 のお祝いと同じ)
  insert into public.perk_tickets(member_id, type_code, kind, title, issued_at, expires_at) values (p_referred, 'referral_tea', 'referral', ttl, p_now, exp) returning id into t1;
  select * into ref from public.members where id = r.referrer_member_id for update;
  if ref.status <> 'active' then kind := 'none';
  else
    select min_points into amber_min from public.rank_thresholds where rank_code = 'amber';
    select min_points into ref_min from public.rank_thresholds where rank_code = ref.rank_code;
    if ref_min >= amber_min then                                                                 -- AMBER 以上はディナーの五巡茶がもともと無料なので、チケットの代わりに 100pt
      pts := public._rule_points('referral_visit', d);
      if pts is not null then
        lid := public._grant(ref.id, 'earn', 'referral_visit', pts, 'referral_visit:' || p_referred, 'app', p_referred::text, p_now);
        kind := 'points';
      else kind := 'none'; end if;
    else
      insert into public.perk_tickets(member_id, type_code, kind, title, issued_at, expires_at) values (ref.id, 'referral_tea', 'referral', ttl, p_now, exp) returning id into t2;
      kind := 'ticket';
    end if;
  end if;
  update public.member_referrals set first_visit_on = d, rewarded_at = p_now, referred_ticket_id = t1, referrer_reward = kind, referrer_ticket_id = t2,
    referrer_points = case when kind = 'points' then pts end, referrer_ledger_id = lid
  where referred_member_id = p_referred;
  perform public._audit(null, 'referral_reward', p_referred, jsonb_build_object('referrer', ref.id, 'referrerReward', kind));
  if kind = 'points' then perform public._mirror(ref.id, null, null); end if;
  return jsonb_build_object('ticket', ttl, 'validThrough', (d + coalesce(ty.valid_days, 60))::text);
end $$;

create or replace function public.manager_set_dinner_tea_mode(p_mode text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old text; lbl text; k integer; tst boolean;
begin
  perform public._require_role('manager');
  if p_mode is null or p_mode not in ('cup', 'free_flow') then raise exception 'invalid_mode' using errcode = '22023'; end if;
  tst := (public._lock_state() = 'test');                                   -- 状態のロック(凍結の操作と直列化)
  perform public._require_write(tst);                                       -- frozen は maintenance で拒否(open=本番、test=試験の区分だけを書く)
  select value into old from public.app_settings where key = 'dinner_tea_mode' for update;
  update public.app_settings set value = p_mode where key = 'dinner_tea_mode';
  lbl := public._dinner_tea_label();
  update public.perk_ticket_types set label = lbl where code = 'referral_tea';
  update public.perk_tickets pt set title = 'お友だち紹介・' || lbl
    from public.members m
    where m.id = pt.member_id and m.is_test = tst                           -- いまの状態の区分の会員だけ(監査 L-2)
      and pt.type_code = 'referral_tea' and pt.used_at is null and pt.title <> 'お友だち紹介・' || lbl;
  get diagnostics k = row_count;
  perform public._audit(auth.uid(), 'dinner_tea_mode', null, jsonb_build_object('old', old, 'new', p_mode, 'retitled', k, 'test', tst));
  return jsonb_build_object('status', 'ok', 'mode', p_mode, 'label', lbl, 'retitled', k);
end $$;

create or replace function public.app_redeem_request(p_issuer text, p_subject text, p_points integer, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; unit integer := public._setting_int('redeem_unit', 100); ttl integer := public._setting_int('redeem_ttl_seconds', 180);
        r public.redeem_requests; c text; tries integer := 0; iss text := public._gate(p_issuer, p_subject);
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  if p_points is null or p_points <= 0 or p_points % unit <> 0 then return jsonb_build_object('status', 'invalid_amount', 'unit', unit); end if;
  update public.redeem_requests set status = 'expired' where member_id = m.id and status = 'pending' and expires_at <= p_now;
  select * into r from public.redeem_requests where member_id = m.id and status = 'pending';
  if found then
    if r.points = p_points then return jsonb_build_object('status', 'pending', 'member', public._snapshot(m.id, p_now)); end if;
    return jsonb_build_object('status', 'already_pending', 'member', public._snapshot(m.id, p_now));
  end if;
  if not public._throttle('redeem:' || m.id, 10, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  if m.balance < p_points then return jsonb_build_object('status', 'insufficient_balance', 'points', m.balance); end if;
  loop
    tries := tries + 1;
    c := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into public.redeem_requests(member_id, points, code, expires_at) values (m.id, p_points, c, p_now + make_interval(secs => ttl)) returning * into r;
      exit;
    exception when unique_violation then
      if tries > 20 then raise exception 'code_unavailable'; end if;
    end;
  end loop;
  return jsonb_build_object('status', 'pending', 'member', public._snapshot(m.id, p_now));
end $$;
create or replace function public._dinner_tea_label() returns text
language sql stable security definer set search_path = public as $$
  select case when (select value from public.app_settings where key = 'dinner_tea_mode') = 'free_flow' then 'ディナーの五巡茶 飲み放題' else 'ディナーの五巡茶 1杯' end
$$;
update public.perk_ticket_types set label = public._dinner_tea_label() where code = 'referral_tea';
update public.perk_tickets set title = 'お友だち紹介・' || public._dinner_tea_label() where type_code = 'referral_tea' and used_at is null;
drop function public.app_order_click(text, text, text, timestamptz);
drop function public.staff_order_click_stats();
drop table public.order_clicks;
delete from public.perk_ticket_requests where ticket_id in (select id from public.perk_tickets where type_code = 'welcome_tea');
delete from public.perk_tickets where type_code = 'welcome_tea';
drop index public.perk_tickets_one_welcome;
delete from public.perk_ticket_types where code = 'welcome_tea';
alter table public.perk_tickets drop constraint perk_tickets_kind_check;
alter table public.perk_tickets add constraint perk_tickets_kind_check check (kind in ('milestone','seasonal','referral'));
alter table public.perk_ticket_types drop constraint perk_ticket_types_kind_check;
alter table public.perk_ticket_types add constraint perk_ticket_types_kind_check check (kind in ('milestone','seasonal','referral'));
delete from public.app_settings where key = 'points_redeemable';
commit;
