-- 10ZEN 会員証: WHERE のない UPDATE を直す(2026-10-16、本番の予行演習で発見)
-- 前提: 100〜110 が適用済み。取り消しは 111_safeupdate_where_DOWN.sql。
-- 内容
--  * Supabase の API(PostgREST)経由の呼び出しでは、安全装置(pg_safeupdate)が「WHERE のない UPDATE / DELETE」を拒否する(エラー: UPDATE requires a WHERE clause)。
--    1行だけの表(system_state・kpi_settings。主キー id は常に true)を更新する7つの関数に WHERE がなく、スタッフ画面の「手動調整」が失敗した。
--  * 7つの関数の該当の UPDATE に「where id」を足すだけ(id は常に true なので、更新する行は今までと同じ1行)。それ以外は一字も変えない。権限はそのまま引き継がれる。
--    import_opening_balance / reconcile_balances / set_system_state / manager_adjust / manager_reverse_redeem / restore_backup / manager_set_launch_date
--  * 手元の使い捨て DB にはこの安全装置がないため、テスト(patches/test_safeupdate.mjs)で「WHERE のない UPDATE / DELETE が関数に無いこと」を確かめる。
begin;

CREATE OR REPLACE FUNCTION public.import_opening_balance(p_member_no text, p_display_name text, p_issuer text, p_subject text, p_balance integer, p_lifetime_base integer, p_last_activity_on date, p_source_ref text, p_created_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare mid uuid; ident public.member_identities; existing uuid;
begin
  if public._lock_state() <> 'frozen' then raise exception 'import_requires_frozen' using errcode = '55000'; end if;   -- 取込みは凍結中のみ(新旧が同時に書ける区間を作らない)
  if p_balance < 0 then raise exception 'invalid_balance' using errcode = '22023'; end if;
  if p_member_no !~ '^user[0-9]{5,}$' then raise exception 'invalid_member_no' using errcode = '22023'; end if;
  update public.system_state set reconciled = false, reconciled_at = null where id;     -- 取込みのたびに照合をやり直す
  select id into existing from public.members where member_no = p_member_no;
  if existing is not null then
    if exists (select 1 from public.point_ledger where member_id = existing and entry_type = 'opening_balance') then
      return jsonb_build_object('status', 'already_imported', 'member_no', p_member_no);
    end if;
    mid := existing;
  else
    insert into public.members(member_no, display_name, created_at) values (p_member_no, nullif(left(p_display_name, 40), ''), p_created_at) returning id into mid;
  end if;
  if p_subject is not null and p_subject <> '' then
    insert into public.member_identities(member_id, provider, issuer, subject, verified_at)
      values (mid, 'line', p_issuer, p_subject, null) on conflict (provider, issuer, subject) do nothing;
    select * into ident from public.member_identities where provider = 'line' and issuer = p_issuer and subject = p_subject;
    if ident.member_id <> mid then raise exception 'identity_belongs_to_other_member' using errcode = '22023'; end if;
  end if;
  update public.members set lifetime_base = p_lifetime_base, lifetime_floor = p_balance, last_activity_on = p_last_activity_on where id = mid;
  -- 既存システムの『最終来店・利用日』を来店済みとして記録する(切替日に同じ日の来店ポイントを二重に付けないため。既存GASも最終来店日で判定していた)
  if p_last_activity_on is not null then
    insert into public.visits(member_id, visit_on, source) values (mid, p_last_activity_on, 'legacy') on conflict (member_id, visit_on) do nothing;
  end if;
  -- 開始残高: 出所と基準日時を残す(存在しない過去履歴は作らない)
  insert into public.point_ledger(member_id, entry_type, points, balance_after, idempotency_key, source, source_ref, occurred_at)
    values (mid, 'opening_balance', p_balance, p_balance, 'opening:' || p_member_no, 'legacy_sheet', p_source_ref, p_created_at);
  update public.members set balance = p_balance where id = mid;
  update public.members m set rank_code = public.rank_for(public._effective_lifetime(m)) where id = mid;
  -- 連番は取り込んだ会員番号(userNNNNN)より後から
  if p_member_no ~ '^user[0-9]+$' then
    perform setval('public.member_no_seq', greatest((select last_value from public.member_no_seq), substr(p_member_no, 5)::bigint));
  end if;
  return jsonb_build_object('status', 'imported', 'member_no', p_member_no);
end $function$;

CREATE OR REPLACE FUNCTION public.reconcile_balances(p_expected jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare mism jsonb; missing jsonb; extra jsonb; bad integer; ok boolean;
begin
  perform pg_advisory_xact_lock(7105001);                              -- 処理中の書込みが終わってから照合する(照合中に残高が動かない)
  if jsonb_typeof(p_expected) <> 'array' then raise exception 'invalid_expected' using errcode = '22023'; end if;
  with e as (select x ->> 'member_no' as member_no, (x ->> 'balance')::int as balance from jsonb_array_elements(p_expected) x),
       m as (select member_no, balance from public.members where not is_test)
  select
    coalesce((select jsonb_agg(jsonb_build_object('member_no', e.member_no, 'expected', e.balance, 'actual', m.balance)) from e join m using (member_no) where e.balance <> m.balance), '[]'::jsonb),
    coalesce((select jsonb_agg(e.member_no) from e where e.member_no not in (select member_no from m)), '[]'::jsonb),
    coalesce((select jsonb_agg(m.member_no) from m where m.member_no not in (select member_no from e)), '[]'::jsonb)
  into mism, missing, extra;
  select count(*) into bad from public.verify_balances();
  ok := jsonb_array_length(mism) = 0 and jsonb_array_length(missing) = 0 and jsonb_array_length(extra) = 0 and bad = 0;
  update public.system_state set reconciled = ok, reconciled_at = case when ok then now() else null end where id;
  perform public._audit(null, 'reconcile', null, jsonb_build_object('ok', ok, 'mismatch', jsonb_array_length(mism), 'missing', jsonb_array_length(missing), 'extra', jsonb_array_length(extra), 'ledgerMismatch', bad));
  return jsonb_build_object('ok', ok, 'mismatches', mism, 'missingInDb', missing, 'extraInDb', extra, 'ledgerMismatches', bad);
end $function$;

CREATE OR REPLACE FUNCTION public.set_system_state(p_to text, p_attest text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cur text; und text; ss public.system_state;
begin
  perform pg_advisory_xact_lock(7105001);                              -- 処理中の書込み(共有ロック保持)が終わるまで待つ。以後の書込みは新しい状態で判定される
  select state into cur from public.system_state;
  if p_to not in ('frozen','test','open') then raise exception 'invalid_state' using errcode = '22023'; end if;
  if p_to = cur then return jsonb_build_object('status', 'unchanged', 'state', cur); end if;
  if not ((cur = 'frozen' and p_to in ('test','open')) or (cur in ('test','open') and p_to = 'frozen')) then
    raise exception 'transition_not_allowed:% -> %', cur, p_to using errcode = '55000';       -- test↔open は必ず frozen を経由する
  end if;
  if p_to = 'open' then
    select * into ss from public.system_state;
    if not ss.reconciled then raise exception 'not_reconciled' using errcode = '55000'; end if;
    select string_agg(key, ',' order by key) into und from public.policy_decisions where not decided;
    if und is not null then raise exception 'policies_undecided:%', und using errcode = '55000'; end if;
    if p_attest is distinct from 'legacy_writes_stopped' then raise exception 'legacy_stop_not_attested' using errcode = '55000'; end if;
  end if;
  update public.system_state set state = p_to, changed_at = now(),
    reconciled = case when p_to = 'frozen' then false else reconciled end,
    reconciled_at = case when p_to = 'frozen' then null else reconciled_at end where id;
  perform public._audit(null, 'set_state', null, jsonb_build_object('from', cur, 'to', p_to, 'attest', left(coalesce(p_attest, ''), 60)));
  -- 凍結中の復旧(調整など)は既存 customers に反映されていないので、open に戻すとき本番会員の現在値を反映し直す(open でのみ動く _mirror)
  if p_to = 'open' then perform public._mirror(id, null, null) from public.members where not is_test; end if;
  return jsonb_build_object('status', 'ok', 'state', p_to);
end $function$;

CREATE OR REPLACE FUNCTION public.manager_adjust(p_member_id uuid, p_points integer, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m public.members; lid bigint;
begin
  perform public._require_role('manager');
  perform public._lock_state();
  if coalesce(btrim(p_reason), '') = '' or char_length(p_reason) > 200 then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_points is null or p_points = 0 or abs(p_points) > 1000000 then raise exception 'invalid_points' using errcode = '22023'; end if;
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9:_-]{8,100}$' then raise exception 'invalid_key' using errcode = '22023'; end if;
  select * into m from public.members where id = p_member_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  perform public._require_write(m.is_test, true);
  if m.balance + p_points < 0 then return jsonb_build_object('status', 'insufficient_balance', 'points', m.balance); end if;
  lid := public._grant(m.id, 'adjust', 'manual', p_points, 'adjust:' || p_idempotency_key, 'manager', null, now(), auth.uid(), btrim(p_reason));
  if lid is not null then update public.system_state set reconciled = false, reconciled_at = null where id; end if;     -- 残高が変わったので照合済みを無効にする(再照合なしに open へ進めない)
  perform public._audit(auth.uid(), 'adjust', m.id, jsonb_build_object('points', p_points, 'reason', left(btrim(p_reason), 200), 'duplicate', lid is null, 'state', public._state()));
  perform public._mirror(m.id, null, null);
  return jsonb_build_object('status', case when lid is null then 'duplicate' else 'ok' end);
end $function$;

CREATE OR REPLACE FUNCTION public.manager_reverse_redeem(p_request_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.redeem_requests; lid bigint;
begin
  perform public._require_role('manager');
  perform public._lock_state();
  if coalesce(btrim(p_reason), '') = '' or char_length(p_reason) > 200 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into r from public.redeem_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.status <> 'confirmed' then return jsonb_build_object('status', 'not_confirmed'); end if;
  perform public._require_write((select is_test from public.members where id = r.member_id), true);
  lid := public._grant(r.member_id, 'adjust', 'reverse_redeem', r.points, 'reverse:' || r.id, 'manager', r.id::text, now(), auth.uid(), btrim(p_reason));
  if lid is not null then update public.system_state set reconciled = false, reconciled_at = null where id; end if;     -- 残高が変わったので照合済みを無効にする
  perform public._audit(auth.uid(), 'reverse_redeem', r.member_id, jsonb_build_object('request', r.id, 'points', r.points, 'duplicate', lid is null, 'state', public._state()));
  perform public._mirror(r.member_id, null, null);
  return jsonb_build_object('status', case when lid is null then 'already_reversed' else 'reversed' end);
end $function$;

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

CREATE OR REPLACE FUNCTION public.manager_set_launch_date(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare old date;
begin
  perform public._require_role('manager');
  if p_date is not null and p_date not between date '2020-01-01' and date '2100-12-31' then raise exception 'invalid_date' using errcode = '22023'; end if;
  select launch_date into old from public.kpi_settings for update;
  update public.kpi_settings set launch_date = p_date, updated_at = now(), updated_by = auth.uid() where id;
  perform public._audit(auth.uid(), 'kpi_launch_date', null, jsonb_build_object('old', old, 'new', p_date));
  return jsonb_build_object('status', 'ok', 'launchDate', p_date::text);
end $function$;

commit;
