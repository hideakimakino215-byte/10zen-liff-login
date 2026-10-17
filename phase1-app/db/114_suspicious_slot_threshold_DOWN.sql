-- 114 の取り消し: staff_today_visits を 100 の定義(6人で「要確認」)に戻し、設定 suspicious_slot_min を消す
begin;

create or replace function public.staff_today_visits() returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := public._jst_date(now());
begin
  perform public._require_role('viewer');
  return jsonb_build_object('date', d,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('memberNo', m.member_no, 'displayName', m.display_name, 'at', v.created_at, 'slot', v.token_slot) order by v.created_at desc), '[]'::jsonb)
              from public.visits v join public.members m on m.id = v.member_id where v.visit_on = d and m.is_test = (public._state() = 'test')),
    -- 不正検知: 同じ30秒スロットに多数が来店記録している(店内に収まらない・QRの写真の拡散の疑い)
    'suspiciousSlots', (select coalesce(jsonb_agg(jsonb_build_object('slot', s.token_slot, 'count', s.c)), '[]'::jsonb)
                        from (select v.token_slot, count(*) c from public.visits v join public.members m on m.id = v.member_id where v.visit_on = d and v.token_slot is not null and m.is_test = (public._state() = 'test') group by v.token_slot having count(*) >= 6) s));
end $$;

delete from public.app_settings where key = 'suspicious_slot_min';

commit;
