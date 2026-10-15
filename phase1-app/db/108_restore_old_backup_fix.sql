-- 102 より前に取ったバックアップの復元の修正(監査 AUDIT_20261015.md の M-1)【本番未適用・ローカル検証のみ】
-- 前提: 100〜107 が適用済み。取り消しは 108_restore_old_backup_fix_DOWN.sql(restore_backup を 106 の内容に戻すだけ。表・データには触れない)。
-- 問題: ランクの基準(rank_thresholds)の min_points は一意。102 で基準を 0 / 1,000 / 3,000 / 6,000 / 10,000 に下げたが、
--   102 より前のバックアップ(いま本番で毎日取っているもの)には古い基準(0 / 10,000 / 50,000 / 100,000 / 200,000)が入っている。
--   従来の復元は1行ずつ上書きするので、AMBER を 10,000 に戻した瞬間に ONYX(10,000)とぶつかり、復元全体が失敗していた。
--   順番の都合で通った場合でも、古い基準が新しい基準を黙って上書きしていた。
-- 直し方(restore_backup だけを置き換える。署名と権限はそのまま。102〜106 で足した表の復元はすべて引き継ぐ):
--  * 102 より前のバックアップ(チケットの種類の表 perk_ticket_types が入っていない。102 で export_backup に加わった表)のとき:
--      ランクの基準は今の DB の値(新しい基準)を残し、バックアップの古い基準は使わない(基準は会員のデータではなく設定のため)。
--      復元した会員のランクは、102 の適用時と同じく累計(_effective_lifetime)から今の基準で付け直す(基準は下がっただけなので、上がるか変わらない)。
--      既存の customers への反映(_mirror)も 102 と同じ呼び方だが、復元の後は必ず frozen なので、ここでは何も書かない(open にした後の来店・同期で反映される)。
--      到達のお祝い・季節の豆花のチケットは、102 と同じく会員証を開いたときに発行される。
--  * 102 以降のバックアップのとき: バックアップの基準に置き換える。一意の決まりにぶつからないよう、置き換える行の min_points を
--      今の値・バックアップの値のどれよりも大きい重ならない値へ一度ずらしてから入れ直す(関数の中=1つのトランザクションなので、途中の状態は外から見えない)。
--      会員のランクはバックアップのまま(その基準で付けたものなので付け直さない)。
--  * 応答に rankThresholds('kept_current'=今の基準を残した / 'restored'=バックアップの基準に置き換えた)と reranked(付け直した会員の数)を足す。
begin;

-- 106 の restore_backup に、ランクの基準の扱い(上の説明)を足したもの。ほかは 106 と同じ
-- 106 より前のバックアップ(紹介の表がない)も復元できる(その場合は0件。招待コードは会員証を開いたときに作り直される)
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
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
  update public.system_state set state = 'frozen', reconciled = false, reconciled_at = null, changed_at = now();
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
end $$;

commit;
