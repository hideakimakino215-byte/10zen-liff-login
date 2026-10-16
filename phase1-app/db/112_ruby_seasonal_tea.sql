-- 10ZEN 会員証: RUBY の特典を「季節ごとに、あなたの体質の五巡茶(持ち帰り用)1つ」にする(2026-10-16 牧野さん決定。「席・予約の優先案内」はやめる)
-- 前提: 100〜111 が適用済み。取り消しは 112_ruby_seasonal_tea_DOWN.sql。
-- 内容
--  * 特典チケットの種類 seasonal_tea(季節ごと・RUBY 以上)を追加。季節の豆花(EMERALD 以上)と同じく、会員証を開いたときに今の季節の分を1枚発行し、その季節の終わりまで有効。
--  * チケットの名前に五巡茶の五行を入れる(例「持ち帰り用の五巡茶(金) 1つ(秋)」)。五行は発行したときの「あなたの体質」(最新3回の平均)。未実施・バランス良好は今日の季節の五行。
--    店のスタッフは、確定の画面に出る名前のとおりのお茶を渡せばよい。
--  * 季節のチケットは今まで「会員×季節で1枚」だったので、「会員×種類×季節で1枚」に変える(同じ季節に豆花と五巡茶の2枚を持てるように)。
--  * _issue_perk_tickets は、季節のチケットの名前の付け方だけを変える(102 の定義から seasonal_tea の分岐を足しただけ。それ以外は同じ)。権限はそのまま引き継がれる。
begin;

insert into public.perk_ticket_types(code, kind, rank_code, label, valid_days) values ('seasonal_tea', 'seasonal', 'ruby', '持ち帰り用の五巡茶 1つ', null);

drop index public.perk_tickets_one_season;
create unique index perk_tickets_one_season on public.perk_tickets (member_id, type_code, season_key) where kind = 'seasonal';   -- 季節のチケットは会員×種類×季節で1枚

create or replace function public._issue_perk_tickets(p_member uuid, p_now timestamptz) returns integer
language plpgsql security definer set search_path = public as $$
declare m public.members; cur public.rank_thresholds; top_min integer; ty public.perk_ticket_types; d date := public._jst_date(p_now); s jsonb; k integer; n integer := 0;
        pf jsonb; el text; ttl text;
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
    ttl := ty.label || '(' || (s ->> 'name') || ')';
    if ty.code = 'seasonal_tea' then                                            -- RUBY 以上: あなたの体質の五巡茶(112)。体質は最新3回の平均、未実施・バランス良好は今日の季節の五行
      pf := public._cc_profile(m.id);
      el := case when pf is not null and not coalesce((pf ->> 'balanced')::boolean, false) then pf ->> 'primary' else public._season_element(d) end;
      ttl := '持ち帰り用の五巡茶(' || case el when 'wood' then '木' when 'fire' then '火' when 'earth' then '土' when 'metal' then '金' else '水' end || ') 1つ(' || (s ->> 'name') || ')';
    end if;
    insert into public.perk_tickets(member_id, type_code, kind, season_key, title, issued_at, expires_at)
      values (m.id, ty.code, 'seasonal', s ->> 'key', ttl, p_now,
              (((s ->> 'endsOn')::date)::timestamp at time zone 'Asia/Tokyo'))   -- その季節の終わり(日本時間)まで
      on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end loop;
  return n;
end $$;

commit;
