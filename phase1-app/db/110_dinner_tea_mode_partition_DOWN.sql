-- 110_dinner_tea_mode_partition.sql の取り消し(戻し)用。manager_set_dinner_tea_mode を 106 の内容に戻す(本文は 106_referral.sql と同じ)。表・データには触れない。
-- 権限は置き換え前から変わっていない(create or replace のため)。戻すと、状態や区分を見ずに全部のチケットの名前を書き換える動き(監査 L-2)に戻る。
begin;
-- ディナーの五巡茶の出し方(cup / free_flow)。店長だけ。まだ使っていない紹介のチケットの名前も変える(使用済みは当時の名前のまま)
create or replace function public.manager_set_dinner_tea_mode(p_mode text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old text; lbl text; k integer;
begin
  perform public._require_role('manager');
  if p_mode is null or p_mode not in ('cup', 'free_flow') then raise exception 'invalid_mode' using errcode = '22023'; end if;
  select value into old from public.app_settings where key = 'dinner_tea_mode' for update;
  update public.app_settings set value = p_mode where key = 'dinner_tea_mode';
  lbl := public._dinner_tea_label();
  update public.perk_ticket_types set label = lbl where code = 'referral_tea';
  update public.perk_tickets set title = 'お友だち紹介・' || lbl where type_code = 'referral_tea' and used_at is null and title <> 'お友だち紹介・' || lbl;
  get diagnostics k = row_count;
  perform public._audit(auth.uid(), 'dinner_tea_mode', null, jsonb_build_object('old', old, 'new', p_mode, 'retitled', k));
  return jsonb_build_object('status', 'ok', 'mode', p_mode, 'label', lbl, 'retitled', k);
end $$;

commit;
