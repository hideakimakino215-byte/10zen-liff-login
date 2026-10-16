-- 113_staff_list_cc_audit.sql の取り消し: 会員の一覧(staff_list_members)を 107 の定義に戻す(記録の constitutionShown と印の allHigh をなくす)。すでに残った記録はそのまま
begin;

create or replace function public.staff_list_members(p_query text default null, p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_query, '')), ''); lim integer := least(greatest(coalesce(p_limit, 50), 1), 100); res jsonb; total integer;
        with_cc boolean;
begin
  perform public._require_role('viewer');
  with_cc := public._staff_role() in ('manager', 'staff');                 -- 閲覧(本部)には個人の体質を返さない
  select count(*) into total from public.members m where m.is_test = (public._state() = 'test') and (q is null or m.member_no ilike '%' || q || '%' or m.display_name ilike '%' || q || '%');
  select coalesce(jsonb_agg(x order by x ->> 'memberNo'), '[]'::jsonb) into res from (
    select jsonb_build_object('id', m.id, 'memberNo', m.member_no, 'displayName', m.display_name, 'rank', m.rank_code, 'points', m.balance, 'status', m.status,
                              'lastActivityOn', m.last_activity_on)
           || case when with_cc then jsonb_build_object('constitution', case when cc.p is null then null
                                                          else jsonb_build_object('primary', cc.p ->> 'primary', 'balanced', (cc.p ->> 'balanced')::boolean) end)
                   else '{}'::jsonb end x
    from public.members m
    left join lateral (select public._cc_profile(m.id) as p where with_cc) cc on true
    where m.is_test = (public._state() = 'test') and (q is null or m.member_no ilike '%' || q || '%' or m.display_name ilike '%' || q || '%')
    order by m.member_no limit lim offset greatest(coalesce(p_offset, 0), 0)) t;
  perform public._audit(auth.uid(), 'list_members', null, jsonb_build_object('hasQuery', q is not null));
  return jsonb_build_object('total', total, 'items', res);
end $$;

commit;
