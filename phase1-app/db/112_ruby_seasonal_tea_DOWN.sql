-- 112_ruby_seasonal_tea.sql の取り消し: 五巡茶のチケット(使用の申請も)と種類を消し、季節のチケットの一意を「会員×季節」に戻し、発行の関数を 102 の定義に戻す
begin;

delete from public.perk_ticket_requests where ticket_id in (select id from public.perk_tickets where type_code = 'seasonal_tea');
delete from public.perk_tickets where type_code = 'seasonal_tea';
delete from public.perk_ticket_types where code = 'seasonal_tea';

drop index public.perk_tickets_one_season;
create unique index perk_tickets_one_season on public.perk_tickets (member_id, season_key) where kind = 'seasonal';

create or replace function public._issue_perk_tickets(p_member uuid, p_now timestamptz) returns integer
language plpgsql security definer set search_path = public as $$
declare m public.members; cur public.rank_thresholds; top_min integer; ty public.perk_ticket_types; d date := public._jst_date(p_now); s jsonb; k integer; n integer := 0;
begin
  select * into m from public.members where id = p_member for update;          -- 会員ごとに直列化(同時に開いても二重に発行しない。一意の索引でも防ぐ)
  if not found or m.status <> 'active' then return 0; end if;
  select * into cur from public.rank_thresholds where rank_code = m.rank_code;
  select max(rt.min_points) into top_min from public.perk_tickets t join public.rank_thresholds rt on rt.rank_code = t.rank_code
    where t.member_id = m.id and t.kind = 'milestone';
  if cur.min_points > coalesce(top_min, 0) then                               -- WHITE OPAL(0pt)は対象外
    select * into ty from public.perk_ticket_types where kind = 'milestone' and rank_code = m.rank_code and active;
    if found then
      insert into public.perk_tickets(member_id, type_code, kind, rank_code, title, issued_at, expires_at)
        values (m.id, ty.code, 'milestone', m.rank_code, cur.label || ' 到達のお祝い・' || ty.label, p_now,
                ((d + ty.valid_days + 1)::timestamp at time zone 'Asia/Tokyo'))     -- 発行日から60日目の終わり(日本時間)まで
        on conflict do nothing;
      get diagnostics k = row_count; n := n + k;
    end if;
  end if;
  for ty in select t.* from public.perk_ticket_types t join public.rank_thresholds rt on rt.rank_code = t.rank_code
            where t.kind = 'seasonal' and t.active and rt.min_points <= cur.min_points loop
    s := public._season_of(d);
    insert into public.perk_tickets(member_id, type_code, kind, season_key, title, issued_at, expires_at)
      values (m.id, ty.code, 'seasonal', s ->> 'key', ty.label || '(' || (s ->> 'name') || ')', p_now,
              (((s ->> 'endsOn')::date)::timestamp at time zone 'Asia/Tokyo'))   -- その季節の終わり(日本時間)まで
      on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end loop;
  return n;
end $$;

commit;
