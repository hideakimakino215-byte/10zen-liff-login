-- 104_member_constitution_link.sql の取り消し(戻し)用。staff_list_members / staff_member_detail を 100 の内容に戻す(体質の情報を返さない)。
-- 表・データには触れない(104 は関数の置き換えだけ)。103 を戻すときは、先にこれを適用する。権限は置き換え前から変わっていない。
begin;
create or replace function public.staff_list_members(p_query text default null, p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_query, '')), ''); lim integer := least(greatest(coalesce(p_limit, 50), 1), 100); res jsonb; total integer;
begin
  perform public._require_role('viewer');
  select count(*) into total from public.members m where m.is_test = (public._state() = 'test') and (q is null or m.member_no ilike '%' || q || '%' or m.display_name ilike '%' || q || '%');
  select coalesce(jsonb_agg(x order by x ->> 'memberNo'), '[]'::jsonb) into res from (
    select jsonb_build_object('id', m.id, 'memberNo', m.member_no, 'displayName', m.display_name, 'rank', m.rank_code, 'points', m.balance, 'status', m.status,
                              'lastActivityOn', m.last_activity_on) x
    from public.members m where m.is_test = (public._state() = 'test') and (q is null or m.member_no ilike '%' || q || '%' or m.display_name ilike '%' || q || '%')
    order by m.member_no limit lim offset greatest(coalesce(p_offset, 0), 0)) t;
  perform public._audit(auth.uid(), 'list_members', null, jsonb_build_object('hasQuery', q is not null));
  return jsonb_build_object('total', total, 'items', res);
end $$;

create or replace function public.staff_member_detail(p_member_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; eff integer;
begin
  perform public._require_role('viewer');
  select * into m from public.members where id = p_member_id and is_test = (public._state() = 'test');
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  eff := public._effective_lifetime(m);
  perform public._audit(auth.uid(), 'view_member', m.id);
  return jsonb_build_object('status', 'ok',
    'member', jsonb_build_object('id', m.id, 'memberNo', m.member_no, 'displayName', m.display_name, 'rank', m.rank_code, 'points', m.balance,
        'lifetimePoints', eff, 'lifetimeConfirmed', m.lifetime_base is not null, 'status', m.status, 'lastActivityOn', m.last_activity_on, 'createdAt', m.created_at),
    'ledger', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'type', l.entry_type, 'rule', l.rule_code, 'points', l.points, 'balanceAfter', l.balance_after,
                'reason', l.reason, 'source', l.source, 'at', l.occurred_at) order by l.occurred_at desc, l.id desc), '[]'::jsonb)
               from (select * from public.point_ledger where member_id = m.id order by occurred_at desc, id desc limit 100) l));
end $$;
commit;
