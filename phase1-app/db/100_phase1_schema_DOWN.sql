-- 100_phase1_schema.sql の取り消し(戻し)用。新しく作った物だけを削除する(既存の customers / interactions / membership_events / 関数には触れない)。
-- 注意: 切替日に開始残高を取り込んだ後に実行すると、台帳・会員のデータも消える。必ず先に台帳を書き出して保管すること(取り込み前なら空なので安全)。
begin;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_audit','_effective_lifetime','_grant','_jst_date','_mirror','_require_role','_rule_points','_setting_int','_snapshot','_staff_role','_throttle','app_checkin','app_me','app_redeem_cancel','app_redeem_request','app_register','confirm_lifetime_base','import_opening_balance','manager_adjust','manager_reverse_redeem','next_member_no','point_ledger_immutable','rank_for','staff_cancel_redeem','staff_confirm_redeem','staff_dashboard','staff_list_members','staff_lookup_redeem','staff_member_detail','staff_today_visits','staff_whoami','verify_balances']) loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;
drop table if exists public.api_throttle, public.audit_log, public.redeem_requests, public.visits, public.point_ledger,
  public.member_identities, public.members, public.staff_users, public.rank_thresholds, public.point_rules, public.app_settings cascade;
drop sequence if exists public.member_no_seq;
commit;
