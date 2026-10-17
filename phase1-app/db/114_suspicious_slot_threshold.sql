-- 10ZEN 会員証: 同じ30秒の店頭QRで多数が来店記録したときの「要確認」の人数を 6人 → 15人にする(2026-10-17 牧野さん決定)
-- 前提: 100〜113 が適用済み。取り消しは 114_suspicious_slot_threshold_DOWN.sql。
-- 内容
--  * 42席が満席の店では6人組が一緒に読み取ることがあり、6人では不正でなくても警告が出てしまうため。
--  * 人数は app_settings の suspicious_slot_min(既定 15)で変えられるようにする。staff_today_visits はこの値を読むだけで、それ以外(返す項目・権限)は 100 と同じ。
begin;

insert into public.app_settings(key, value, note) values
  ('suspicious_slot_min', '15', '不正検知: 同じ30秒の店頭QRでこの人数以上が来店記録したらスタッフ画面に「要確認」(2026-10-17 牧野さん決定: 6→15。満席時の団体で誤検知しないため)')
on conflict (key) do nothing;

create or replace function public.staff_today_visits() returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := public._jst_date(now()); lim integer := greatest(public._setting_int('suspicious_slot_min', 15), 2);
begin
  perform public._require_role('viewer');
  return jsonb_build_object('date', d,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('memberNo', m.member_no, 'displayName', m.display_name, 'at', v.created_at, 'slot', v.token_slot) order by v.created_at desc), '[]'::jsonb)
              from public.visits v join public.members m on m.id = v.member_id where v.visit_on = d and m.is_test = (public._state() = 'test')),
    -- 不正検知: 同じ30秒スロットに多数が来店記録している(店内に収まらない・QRの写真の拡散の疑い)。人数は suspicious_slot_min
    'suspiciousSlots', (select coalesce(jsonb_agg(jsonb_build_object('slot', s.token_slot, 'count', s.c)), '[]'::jsonb)
                        from (select v.token_slot, count(*) c from public.visits v join public.members m on m.id = v.member_id where v.visit_on = d and v.token_slot is not null and m.is_test = (public._state() = 'test') group by v.token_slot having count(*) >= lim) s));
end $$;

commit;
