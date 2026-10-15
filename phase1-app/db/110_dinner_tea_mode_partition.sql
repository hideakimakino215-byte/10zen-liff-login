-- ディナーの五巡茶の出し方の切り替えを、いまの状態の区分の会員だけに効かせ、凍結中は止める(監査 AUDIT_20261015.md の L-2)【本番未適用・ローカル検証のみ】
-- 前提: 100〜109 が適用済み。取り消しは 110_dinner_tea_mode_partition_DOWN.sql(関数を 106 の内容に戻すだけ。表・データには触れない)。
-- 問題: manager_set_dinner_tea_mode は状態(test・frozen)や会員の区分(試験/本番)を見ずに、すべてのまだ使っていない紹介のチケットの名前を書き換えていた。
--   試験運用(test)の中で店長が切り替えを試すと本番の会員のチケット名も変わり、凍結(frozen)中でも切り替えられた。
-- 直し方(ほかの書き込みの関数と同じ決まり: 状態のロック _lock_state → _require_write):
--  * frozen では maintenance で拒否する(設定もチケットも変えない)。
--  * チケットの名前の書き換えは、いまの状態の区分の会員だけ(test=試験会員だけ / open=本番会員だけ)。
--  * 設定(app_settings の dinner_tea_mode)と新しく出すチケットの名前(perk_ticket_types)は従来どおり全体で1つ。
--    試験運用中に切り替えた場合、本番の会員のまだ使っていないチケットの名前はそのまま。本番開始(open)の後に同じ出し方でもう一度保存すると揃う。
--  * 監査ログ(dinner_tea_mode)に test(どちらの区分を書き換えたか)を足す。応答は従来と同じ形(status・mode・label・retitled)。
-- 置き換える既存の関数(create or replace。署名と権限はそのまま): manager_set_dinner_tea_mode(106)。
begin;

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

commit;
