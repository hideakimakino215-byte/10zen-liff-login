-- 10ZEN 会員証: 会員の一覧の体質のタイプの印を残し、誰の印を見せたかを記録に残す(監査 L-3。2026-10-16 牧野さん決定「スタッフに見せる」)
-- 前提: 100〜112 が適用済み。取り消しは 113_staff_list_cc_audit_DOWN.sql。
-- 内容
--  * staff_list_members(107 の定義)の記録(list_members)に、体質のタイプの印を返した会員の id の一覧 constitutionShown を足す
--    (詳細を開いたときの view_member と同じく、誰の体質がスタッフに見えたかを後から追えるように)。印を返さない閲覧(本部)では足さない。
--  * 印に allHigh(5つの平均を小数1桁にしてすべて同じで4点以上=「全体的にゆらぎやすいタイプ」。app-core/constitution.mjs の isAllHigh と同じ判定)を足す。
--    一覧には点数を返さないので、画面が詳細と同じタイプ名を出せるようにする。
--  * それ以外(返す項目・権限・件数の上限・閲覧(本部)には返さないこと)は 107 と同じ。署名と権限はそのまま引き継がれる。
--  * 同意の文に「店舗のスタッフがおすすめのご案内に使う」ことを書く(画面の文言。app-core/constitution-content.mjs の CONSENT_TEXT)。
begin;

create or replace function public.staff_list_members(p_query text default null, p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_query, '')), ''); lim integer := least(greatest(coalesce(p_limit, 50), 1), 100); res jsonb; total integer;
        with_cc boolean; shown jsonb; meta jsonb;
begin
  perform public._require_role('viewer');
  with_cc := public._staff_role() in ('manager', 'staff');                 -- 閲覧(本部)には個人の体質を返さない
  select count(*) into total from public.members m where m.is_test = (public._state() = 'test') and (q is null or m.member_no ilike '%' || q || '%' or m.display_name ilike '%' || q || '%');
  select coalesce(jsonb_agg(x order by x ->> 'memberNo'), '[]'::jsonb) into res from (
    select jsonb_build_object('id', m.id, 'memberNo', m.member_no, 'displayName', m.display_name, 'rank', m.rank_code, 'points', m.balance, 'status', m.status,
                              'lastActivityOn', m.last_activity_on)
           || case when with_cc then jsonb_build_object('constitution', case when cc.p is null then null
                                                          else jsonb_build_object('primary', cc.p ->> 'primary', 'balanced', (cc.p ->> 'balanced')::boolean,
                                                                                  'allHigh', (select count(distinct round(v.value::numeric, 1)) = 1 and min(round(v.value::numeric, 1)) >= 4
                                                                                              from jsonb_each_text(cc.p -> 'scores') v)) end)
                   else '{}'::jsonb end x
    from public.members m
    left join lateral (select public._cc_profile(m.id) as p where with_cc) cc on true
    where m.is_test = (public._state() = 'test') and (q is null or m.member_no ilike '%' || q || '%' or m.display_name ilike '%' || q || '%')
    order by m.member_no limit lim offset greatest(coalesce(p_offset, 0), 0)) t;
  meta := jsonb_build_object('hasQuery', q is not null);
  if with_cc then
    select coalesce(jsonb_agg(i -> 'id' order by i ->> 'memberNo'), '[]'::jsonb) into shown from jsonb_array_elements(res) i where jsonb_typeof(i -> 'constitution') = 'object';
    meta := meta || jsonb_build_object('constitutionShown', shown);
  end if;
  perform public._audit(auth.uid(), 'list_members', null, meta);
  return jsonb_build_object('total', total, 'items', res);
end $$;

commit;
