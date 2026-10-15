-- 10ZEN デジタル会員証 体質チェックと会員の紐づけ(スタッフ画面。2026-10-15 牧野さんの依頼)【本番未適用・ローカル検証のみ】
-- 前提: 100・101・102・103_constitution_check.sql が適用済み。取り消しは 104_member_constitution_link_DOWN.sql(103 を戻す前に、先にこちらを戻す)。
-- 内容(店内でのおすすめに使うため)
--  * staff_member_detail: 会員の最新の体質チェックの要約 constitution を足す。
--      { checkedAt, checkedOn(日本時間の日付), primary, balanced, scores{wood..water}, today }(未実施は null)。
--      today は日本時間の今日の「今日の体調」(答えていなければ null): { temp, energy, concern, focus }。
--      15問の回答(answers)と食事の気分(mood)は返さない。
--  * staff_list_members: 各行に constitution { primary, balanced }(未実施は null)を足す(タイプの小さな印に使う)。
--  * 権限: 店長(manager)・スタッフ(staff)だけに返す。閲覧(viewer。本部)には個人の体質の情報を返さない(キーごと含めない)。
--          集計(staff_constitution_stats)は 103 のまま。店頭タブレット(kiosk)は従来どおり拒否(_require_role('viewer'))。
--  * それ以外(引数・戻り値の形・監査ログ・試験運用中の絞り込み)は 100 と同じ。create or replace なので権限(authenticated だけが実行できる)は引き継がれる。
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
           || case when with_cc then jsonb_build_object('constitution', case when cc.primary_element is null then null
                                                          else jsonb_build_object('primary', cc.primary_element, 'balanced', cc.balanced) end)
                   else '{}'::jsonb end x
    from public.members m
    left join lateral (select c.primary_element, c.balanced from public.constitution_checks c where with_cc and c.member_id = m.id
                       order by c.created_at desc, c.id desc limit 1) cc on true
    where m.is_test = (public._state() = 'test') and (q is null or m.member_no ilike '%' || q || '%' or m.display_name ilike '%' || q || '%')
    order by m.member_no limit lim offset greatest(coalesce(p_offset, 0), 0)) t;
  perform public._audit(auth.uid(), 'list_members', null, jsonb_build_object('hasQuery', q is not null));
  return jsonb_build_object('total', total, 'items', res);
end $$;

create or replace function public.staff_member_detail(p_member_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; eff integer; c public.constitution_checks; dc public.constitution_daily_conditions; res jsonb;
begin
  perform public._require_role('viewer');
  select * into m from public.members where id = p_member_id and is_test = (public._state() = 'test');
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  eff := public._effective_lifetime(m);
  perform public._audit(auth.uid(), 'view_member', m.id);
  res := jsonb_build_object('status', 'ok',
    'member', jsonb_build_object('id', m.id, 'memberNo', m.member_no, 'displayName', m.display_name, 'rank', m.rank_code, 'points', m.balance,
        'lifetimePoints', eff, 'lifetimeConfirmed', m.lifetime_base is not null, 'status', m.status, 'lastActivityOn', m.last_activity_on, 'createdAt', m.created_at),
    'ledger', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'type', l.entry_type, 'rule', l.rule_code, 'points', l.points, 'balanceAfter', l.balance_after,
                'reason', l.reason, 'source', l.source, 'at', l.occurred_at) order by l.occurred_at desc, l.id desc), '[]'::jsonb)
               from (select * from public.point_ledger where member_id = m.id order by occurred_at desc, id desc limit 100) l));
  if public._staff_role() not in ('manager', 'staff') then return res; end if;   -- 閲覧(本部)には個人の体質を返さない(キーごと含めない)
  -- 最新の体質チェックの要約と、日本時間の今日の「今日の体調」。15問の回答と食事の気分は返さない
  select * into c from public.constitution_checks where member_id = m.id order by created_at desc, id desc limit 1;
  select * into dc from public.constitution_daily_conditions where member_id = m.id and on_date = public._jst_date(now());
  return res || jsonb_build_object('constitution', case when c.id is null then null else jsonb_build_object(
      'checkedAt', c.created_at, 'checkedOn', public._jst_date(c.created_at)::text, 'primary', c.primary_element, 'balanced', c.balanced,
      'scores', jsonb_build_object('wood', c.score_wood, 'fire', c.score_fire, 'earth', c.score_earth, 'metal', c.score_metal, 'water', c.score_water),
      'today', case when dc.member_id is null then null
                    else jsonb_build_object('temp', dc.temp, 'energy', dc.energy, 'concern', dc.concern, 'focus', dc.focus_element) end) end);
end $$;

commit;
