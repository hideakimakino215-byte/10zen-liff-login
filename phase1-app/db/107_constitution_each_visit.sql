-- 10ZEN デジタル会員証 1分体質チェックを「来店のたびに(任意・スキップ可)」へ(2026-10-15 牧野さんの決定。CONSTITUTION_CHECK_DESIGN_20261015.md の 12章)【本番未適用・ローカル検証のみ】
-- 前提: 100〜106 が適用済み。取り消しは 107_constitution_each_visit_DOWN.sql(関数を 103〜106 の内容に戻すだけ。表・データには触れない)。
-- 内容
--  * 「今日の体調」(3問)はやめる。表 constitution_daily_conditions と関数 app_condition_submit は、古い画面との互換のために残すが使わない(非推奨。集計にも出さない)。
--    季節が変わったときの再チェックの案内もやめる(会員証の応答の seasonChanged は互換のために残すが、画面は使わない)。
--  * 体質チェック(15問+食事の気分)は来店のたびに何度でもできる(任意)。記録の表は 103 のまま(1回=1行)。
--  * 「今日の傾向」= 今回(最新)のチェックの結果。「あなたの体質」= 最新の3回(3回未満ならその回数)の五行ごとの点数の平均。
--      平均にも同じ決め方を使う: 一番高い五行が主なタイプ。同点は「平均に入れた回のうち最新の回の季節の五行」を優先し、それでも決まらなければ 木・火・土・金・水 の順。
--      平均がすべて1点以下なら「バランス良好」。比べるのは合計(回数が同じなので平均と同じ順になり、割り算の端数の誤差が出ない)。平均は小数2桁に丸めて返す。
--      app-core/constitution.mjs の averageResult / profileOf と同じ決め方(app-core/test_constitution.mjs が一致を確かめる)。
--  * 会員証(app_me など _member_view を使う応答): constitution(最新)に checkedToday(日本時間の今日にチェックしたか)を足し、
--      constitutionProfile(あなたの体質: count・scores(平均)・primary・balanced・latestOn・oldestOn)と constitutionHistory(最新から最大6回:
--      checkedAt・checkedOn・primary・balanced・scores)を足す。yourTea(あなたの五巡茶)は「あなたの体質」の五行。今日のおすすめの一品は最新の結果(画面が決める)。
--  * app_constitution_submit の応答に profile(送った後のあなたの体質)を足す。点数・タイプは従来どおり回答から DB が計算する。
--  * スタッフの集計(staff_constitution_stats): 「今週の体調の傾向」を「今週のチェック結果の傾向」に置き換える
--      week = { since, until, checks(直近7日のチェックの回数), members(人数), byType(各回の主な五行の分布。バランス良好は別) }。スタッフは今までどおり week だけ。
--      店長・閲覧には「来店時の実施率」visitCheckRate(今月): 会員の来店日(visits の行。1会員1日1行)のうち、同じ日本時間の日にその会員が体質チェックをした日の割合。
--  * staff_kpi_overview の各月の supporting に visitDays・checkedVisitDays・visitCheckRatePercent(来店時の実施率)を足す。
--  * 会員の詳細(staff_member_detail。店長・スタッフ): constitution から今日の体調(today)を外し、checkedToday と profile(あなたの体質)を足す。
--    会員の一覧(staff_list_members)のタイプの印は「あなたの体質」にする。閲覧(本部)には従来どおり返さない。
--  * 月次レポート(report_monthly): 今日の体調(conditions)を外し、チェック結果の傾向 checkResults(その月のチェックの回数とタイプの分布)と
--    来店時の実施率 visitCheckRate(その月)を足す。
--  * 新しい表はない(バックアップ/復元は 106 のまま)。既存の customers / interactions / TOBIRA には触れない。
-- 置き換える既存の関数(create or replace。署名と権限はそのまま): _constitution_snapshot・app_constitution_submit・staff_constitution_stats(103)、
--   staff_list_members・staff_member_detail(104)、staff_kpi_overview・report_monthly(106)。
begin;

-- ---------- 内部関数(判定。誰からも直接は呼べない) ----------
-- 平均の判定(純粋関数): 五行ごとの合計(木・火・土・金・水の順)と回数 → 平均(小数2桁)・主なタイプ・バランス良好。同点の決め方は _cc_pick と同じ
create function public._cc_avg_result(p_sums integer[], p_n integer, p_season text) returns jsonb
language plpgsql immutable set search_path = public as $$
begin
  if p_n is null or p_n < 1 or p_sums is null or array_ndims(p_sums) is distinct from 1 or array_length(p_sums, 1) <> 5 or array_position(p_sums, null) is not null then return null; end if;
  return jsonb_build_object('count', p_n,
    'scores', jsonb_build_object('wood', round(p_sums[1]::numeric / p_n, 2), 'fire', round(p_sums[2]::numeric / p_n, 2), 'earth', round(p_sums[3]::numeric / p_n, 2),
                                 'metal', round(p_sums[4]::numeric / p_n, 2), 'water', round(p_sums[5]::numeric / p_n, 2)),
    'primary', public._cc_pick(p_sums, p_season),
    'balanced', (select max(x) from unnest(p_sums) x) <= p_n);                                -- 平均がすべて1点以下 = 合計がすべて回数以下
end $$;

-- あなたの体質: 会員の最新の3回(3回未満ならその回数)の平均。同点は平均に入れた回のうち最新の回の季節の五行。未実施は null
create function public._cc_profile(p_member uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when count(*) = 0 then null else
    public._cc_avg_result(array[sum(l.score_wood), sum(l.score_fire), sum(l.score_earth), sum(l.score_metal), sum(l.score_water)]::integer[], count(*)::integer,
                          (array_agg(l.season_element order by l.created_at desc, l.id desc))[1])
    || jsonb_build_object('latestOn', public._jst_date(max(l.created_at))::text, 'oldestOn', public._jst_date(min(l.created_at))::text) end
  from (select * from public.constitution_checks where member_id = p_member order by created_at desc, id desc limit 3) l
$$;

-- これまでのチェック(最新から最大 p_limit 回)。回答と食事の気分は含めない
create function public._cc_history(p_member uuid, p_limit integer default 6) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('checkedAt', l.created_at, 'checkedOn', public._jst_date(l.created_at)::text, 'primary', l.primary_element, 'balanced', l.balanced,
           'scores', jsonb_build_object('wood', l.score_wood, 'fire', l.score_fire, 'earth', l.score_earth, 'metal', l.score_metal, 'water', l.score_water))
         order by l.created_at desc, l.id desc), '[]'::jsonb)
  from (select * from public.constitution_checks where member_id = p_member order by created_at desc, id desc limit least(greatest(coalesce(p_limit, 6), 1), 20)) l
$$;

-- チェック結果の傾向: 期間 [p_from, p_to) のチェックの回数・人数・各回の主な五行の分布(バランス良好は別)。いまの区分(本番/試験)の会員だけ
create function public._cc_check_dist(p_tst boolean, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('checks', count(*), 'members', count(distinct c.member_id),
    'byType', jsonb_build_object(
       'wood',  count(*) filter (where not c.balanced and c.primary_element = 'wood'),  'fire',  count(*) filter (where not c.balanced and c.primary_element = 'fire'),
       'earth', count(*) filter (where not c.balanced and c.primary_element = 'earth'), 'metal', count(*) filter (where not c.balanced and c.primary_element = 'metal'),
       'water', count(*) filter (where not c.balanced and c.primary_element = 'water'), 'balanced', count(*) filter (where c.balanced)))
  from public.constitution_checks c join public.members m on m.id = c.member_id
  where m.is_test = p_tst and c.created_at >= p_from and c.created_at < p_to
$$;

-- 来店時の実施率: 期間(日本時間の日付 p_from〜p_to。両端を含む)の会員の来店日(visits の行)のうち、同じ日本時間の日にその会員がチェックした日の割合
create function public._visit_check_rate(p_tst boolean, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('from', p_from::text, 'to', p_to::text, 'visitDays', count(*), 'checkedVisitDays', count(*) filter (where x.checked),
    'ratePercent', case when count(*) = 0 then null else round(100.0 * count(*) filter (where x.checked) / count(*), 1) end)
  from (select exists (select 1 from public.constitution_checks c where c.member_id = v.member_id
                         and c.created_at >= (v.visit_on::timestamp at time zone 'Asia/Tokyo') and c.created_at < ((v.visit_on + 1)::timestamp at time zone 'Asia/Tokyo')) as checked
        from public.visits v join public.members m on m.id = v.member_id
        where m.is_test = p_tst and v.visit_on between p_from and p_to) x
$$;

-- 105/106 の KPI の各月の supporting に、来店時の実施率を足す
create function public._kpi_with_visit_check(o jsonb, p_tst boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select o || jsonb_build_object('months', coalesce((
    select jsonb_agg(x.m || jsonb_build_object('supporting', coalesce(x.m -> 'supporting', '{}'::jsonb)
                       || jsonb_build_object('visitDays', v.r -> 'visitDays', 'checkedVisitDays', v.r -> 'checkedVisitDays', 'visitCheckRatePercent', v.r -> 'ratePercent')) order by x.i)
    from jsonb_array_elements(o -> 'months') with ordinality x(m, i)
    cross join lateral (select public._visit_check_rate(p_tst, (x.m ->> 'from')::date, (x.m ->> 'asOfDate')::date) r) v), '[]'::jsonb))
$$;

-- ---------- 会員証に出す情報(103 の置き換え) ----------
-- 最新の結果の要約(checkedToday を足す)・あなたの体質(最新3回の平均)・これまでのチェック(最新6回)・同意・今日のお茶・あなたのお茶(あなたの体質の五行)・季節。
-- todayCondition(今日の体調)と seasonChanged は古い画面との互換のために残す(非推奨。今の画面は使わない)
create or replace function public._constitution_snapshot(p_member uuid, p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.constitution_checks; dc public.constitution_daily_conditions; d date := public._jst_date(p_now); sk text := public._season_of(public._jst_date(p_now)) ->> 'key';
        pf jsonb := public._cc_profile(p_member); today_done boolean;
begin
  select * into c from public.constitution_checks where member_id = p_member order by created_at desc, id desc limit 1;
  select * into dc from public.constitution_daily_conditions where member_id = p_member and on_date = d;
  today_done := exists (select 1 from public.constitution_checks where member_id = p_member
                          and created_at >= (d::timestamp at time zone 'Asia/Tokyo') and created_at < ((d + 1)::timestamp at time zone 'Asia/Tokyo'));
  return jsonb_build_object(
    'constitution', case when c.id is null then null else jsonb_build_object(
        'checkedAt', c.created_at, 'checkedOn', public._jst_date(c.created_at)::text, 'seasonKey', c.season_key,
        'primary', c.primary_element, 'balanced', c.balanced, 'mood', c.mood,
        'scores', jsonb_build_object('wood', c.score_wood, 'fire', c.score_fire, 'earth', c.score_earth, 'metal', c.score_metal, 'water', c.score_water),
        'seasonChanged', c.season_key <> sk, 'checkedToday', today_done) end,
    'constitutionProfile', pf,
    'constitutionHistory', public._cc_history(p_member, 6),
    'constitutionConsent', exists (select 1 from public.constitution_consents where member_id = p_member and version = 'constitution_v1'),
    'todayCondition', case when dc.member_id is null then null else jsonb_build_object('temp', dc.temp, 'energy', dc.energy, 'concern', dc.concern, 'focus', dc.focus_element) end,
    'todayTea', public._tea_of_day(d),
    'yourTea', pf ->> 'primary',
    'season', jsonb_build_object('key', sk, 'element', public._season_element(d)));
end $$;

-- ---------- 顧客向け関数(103 の置き換え。応答に profile を足すだけ。ほかは同じ) ----------
create or replace function public.app_constitution_submit(p_issuer text, p_subject text, p_answers integer[], p_mood text, p_consent boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; iss text := public._gate(p_issuer, p_subject); d date := public._jst_date(p_now); r jsonb;
        moods text[] := array(select btrim(x) from unnest(string_to_array(coalesce((select value from public.app_settings where key = 'constitution_moods'), ''), ',')) x where btrim(x) <> '');
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;          -- 会員ごとに直列化
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  r := public._cc_result(p_answers, d);
  if r is null then return jsonb_build_object('status', 'invalid_answers'); end if;
  if p_mood is null or not (p_mood = any(moods)) then return jsonb_build_object('status', 'invalid_mood'); end if;
  if not exists (select 1 from public.constitution_consents where member_id = m.id and version = 'constitution_v1') then
    if p_consent is distinct from true then return jsonb_build_object('status', 'consent_required'); end if;
    insert into public.constitution_consents(member_id, version, consented_at) values (m.id, 'constitution_v1', p_now);
  end if;
  if not public._throttle('cc:' || m.id, 20, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  insert into public.constitution_checks(member_id, answers, mood, score_wood, score_fire, score_earth, score_metal, score_water, primary_element, balanced, season_key, season_element, created_at)
  values (m.id, p_answers::smallint[], p_mood, (r #>> '{scores,wood}')::int, (r #>> '{scores,fire}')::int, (r #>> '{scores,earth}')::int, (r #>> '{scores,metal}')::int,
          (r #>> '{scores,water}')::int, r ->> 'primary', (r ->> 'balanced')::boolean, public._season_of(d) ->> 'key', r ->> 'seasonElement', p_now);
  return jsonb_build_object('status', 'ok', 'result', r, 'profile', public._cc_profile(m.id), 'member', public._member_view(m.id, p_now));
end $$;

-- ---------- スタッフ向け関数 ----------
-- 体質チェックの集計(103 の置き換え)。いまの状態の会員だけ(test のときは試験会員のみ)。個人の結果は返さない。
--  全員(閲覧以上・店頭タブレットは不可): 今週(直近7日・日本時間・今日を含む)のチェック結果の傾向(week)。
--  店長・閲覧(本部)だけ: 103 の数字(実施人数・実施率・タイプ別・平均・再来店率と来店頻度・相談ボタン)と、今月の来店時の実施率(visitCheckRate)。スタッフには返さない。
create or replace function public.staff_constitution_stats() returns jsonb
language plpgsql security definer set search_path = public as $$
declare tst boolean := (public._state() = 'test'); d date := public._jst_date(now()); since date := public._jst_date(now()) - 6; full_scope boolean; res jsonb;
        ms timestamptz := date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo'; md date := date_trunc('month', public._jst_date(now()))::date;
begin
  perform public._require_role('viewer');                                   -- スタッフ以外・無効・店頭タブレットは拒否
  full_scope := public._staff_role() in ('manager', 'viewer');
  res := jsonb_build_object('asOf', now(), 'scope', case when full_scope then 'full' else 'limited' end,
    'week', jsonb_build_object('since', since::text, 'until', d::text)
            || public._cc_check_dist(tst, since::timestamp at time zone 'Asia/Tokyo', (d + 1)::timestamp at time zone 'Asia/Tokyo'));
  if not full_scope then return res; end if;
  with mem as (select m.id from public.members m where m.status = 'active' and m.is_test = tst),
       latest as (select distinct on (c.member_id) c.* from public.constitution_checks c join mem on mem.id = c.member_id order by c.member_id, c.created_at desc, c.id desc),
       vis as (select mem.id, count(v.id) as n, exists (select 1 from latest l where l.member_id = mem.id) as checked
               from mem left join public.visits v on v.member_id = mem.id and v.visit_on between d - 59 and d group by mem.id)
  select res || jsonb_build_object(
    'membersActive', (select count(*) from mem),
    'checkedMembers', (select count(*) from latest),
    'checkRatePercent', (select case when count(*) = 0 then null else round(100.0 * (select count(*) from latest) / count(*), 1) end from mem),
    'byType', jsonb_build_object(
       'wood',  (select count(*) from latest where not balanced and primary_element = 'wood'),
       'fire',  (select count(*) from latest where not balanced and primary_element = 'fire'),
       'earth', (select count(*) from latest where not balanced and primary_element = 'earth'),
       'metal', (select count(*) from latest where not balanced and primary_element = 'metal'),
       'water', (select count(*) from latest where not balanced and primary_element = 'water'),
       'balanced', (select count(*) from latest where balanced)),
    'averages', (select case when count(*) = 0 then null else jsonb_build_object('wood', round(avg(score_wood), 2), 'fire', round(avg(score_fire), 2),
                   'earth', round(avg(score_earth), 2), 'metal', round(avg(score_metal), 2), 'water', round(avg(score_water), 2)) end from latest),
    'revisit', jsonb_build_object('windowDays', 60,
       'checked',   (select jsonb_build_object('members', count(*), 'revisitRatePercent', case when count(*) = 0 then null else round(100.0 * count(*) filter (where n >= 2) / count(*), 1) end,
                       'avgVisits', case when count(*) = 0 then null else round(avg(n), 2) end) from vis where checked),
       'unchecked', (select jsonb_build_object('members', count(*), 'revisitRatePercent', case when count(*) = 0 then null else round(100.0 * count(*) filter (where n >= 2) / count(*), 1) end,
                       'avgVisits', case when count(*) = 0 then null else round(avg(n), 2) end) from vis where not checked)),
    'referralClicks', jsonb_build_object(
       'total', (select count(*) from public.constitution_referral_clicks k join public.members m on m.id = k.member_id where m.is_test = tst),
       'thisMonth', (select count(*) from public.constitution_referral_clicks k join public.members m on m.id = k.member_id where m.is_test = tst and k.clicked_at >= ms)),
    'visitCheckRate', jsonb_build_object('month', to_char(md, 'YYYY-MM')) || public._visit_check_rate(tst, md, d))
  into res;
  return res;
end $$;

-- 会員の一覧(104 の置き換え): タイプの印を「あなたの体質」(最新3回の平均)にする。ほかは同じ
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

-- 会員の詳細(104 の置き換え): constitution = 最新の結果(今日の傾向に使う)+ checkedToday(日本時間の今日か)+ profile(あなたの体質)。今日の体調(today)は返さない
create or replace function public.staff_member_detail(p_member_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; eff integer; c public.constitution_checks; res jsonb;
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
  -- 最新の体質チェックの要約と、あなたの体質(最新3回の平均)。15問の回答と食事の気分は返さない
  select * into c from public.constitution_checks where member_id = m.id order by created_at desc, id desc limit 1;
  return res || jsonb_build_object('constitution', case when c.id is null then null else jsonb_build_object(
      'checkedAt', c.created_at, 'checkedOn', public._jst_date(c.created_at)::text, 'primary', c.primary_element, 'balanced', c.balanced,
      'scores', jsonb_build_object('wood', c.score_wood, 'fire', c.score_fire, 'earth', c.score_earth, 'metal', c.score_metal, 'water', c.score_water),
      'checkedToday', public._jst_date(c.created_at) = public._jst_date(now()),
      'profile', public._cc_profile(m.id)) end);
end $$;

-- 目標と KPI(106 の置き換え): 各月の supporting に来店時の実施率を足す。ほかは同じ
create or replace function public.staff_kpi_overview(p_months integer default 13) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text; tst boolean;
begin
  perform public._require_role('viewer');                                   -- スタッフ以外・無効・店頭タブレットは拒否
  r := public._staff_role();
  if r not in ('manager', 'viewer') then raise exception 'forbidden' using errcode = '42501'; end if;   -- スタッフ(staff)も拒否
  tst := public._state() = 'test';
  return public._kpi_with_visit_check(public._kpi_with_referral(public._kpi_overview(tst, p_months, now()), tst), tst)
    || jsonb_build_object('state', public._state(), 'canEdit', r = 'manager');
end $$;

-- ---------- 月次レポート(106 の置き換え) ----------
-- 体質チェックの「今日の体調」(conditions)を外し、チェック結果の傾向(checkResults: その月のチェックの回数とタイプの分布)と
-- 来店時の実施率(visitCheckRate: その月の会員の来店日のうち、同じ日にチェックした日の割合)を足す。ほかは 106 と同じ
create or replace function public.report_monthly(p_month text, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tst boolean := (public._state() = 'test'); ms date; me date; st public.kpi_settings; lm date; ref_now timestamptz; m_start timestamptz; m_end timestamptz;
        o jsonb; cur jsonb; prev jsonb; kp jsonb := '{}'::jsonb; code text; a numeric; p numeric; ranks jsonb; cc jsonb; tk jsonb;
begin
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'invalid_month' using errcode = '22023'; end if;
  ms := to_date(p_month || '-01', 'YYYY-MM-DD'); me := (ms + interval '1 month')::date - 1;
  select * into st from public.kpi_settings;
  if st.launch_date is null then return jsonb_build_object('month', p_month, 'skipped', true, 'reason', 'no_launch_date'); end if;
  lm := date_trunc('month', st.launch_date)::date;
  if ms < lm then return jsonb_build_object('month', p_month, 'skipped', true, 'reason', 'before_launch', 'launchDate', st.launch_date::text); end if;
  if me >= public._jst_date(p_now) then return jsonb_build_object('month', p_month, 'skipped', true, 'reason', 'month_not_finished'); end if;
  m_start := ms::timestamp at time zone 'Asia/Tokyo'; m_end := (me + 1)::timestamp at time zone 'Asia/Tokyo';
  ref_now := m_end - interval '1 second';                                                       -- その月の最後の時刻(日本時間)を「今」として 105 の集計を使う
  o := public._kpi_with_visit_check(public._kpi_with_referral(public._kpi_overview(tst, 2, ref_now), tst), tst);
  prev := o -> 'months' -> 0; cur := o -> 'months' -> 1;
  -- 4つの KPI(+新規登録数): 実績・目標・達成率・前の月の実績・差(率は % の差、数は件数の差)
  foreach code in array array['member_visit_rate', 'new_members', 'check_rate', 'revisit_rate', 'referral_clicks'] loop
    a := (cur -> 'kpis' -> code ->> 'actual')::numeric; p := (prev -> 'kpis' -> code ->> 'actual')::numeric;
    kp := kp || jsonb_build_object(code, jsonb_build_object('actual', a, 'target', (cur -> 'kpis' -> code ->> 'target')::numeric,
            'achievementPercent', (cur -> 'kpis' -> code ->> 'achievementPercent')::numeric, 'previous', p, 'change', a - p));
  end loop;
  -- ランク別の人数(月末の時点で登録済みの有効会員。ランクは今のランク。ランクの履歴は持っていない)
  select jsonb_object_agg(rt.rank_code, coalesce(x.n, 0)) into ranks from public.rank_thresholds rt
    left join (select rank_code, count(*) n from public.members where is_test = tst and status = 'active' and created_at < m_end group by rank_code) x on x.rank_code = rt.rank_code;
  -- 体質チェック: 会員ごとの最新の結果(月末まで)でタイプ別の人数
  with mem as (select id from public.members where is_test = tst and status = 'active' and created_at < m_end),
       latest as (select distinct on (c.member_id) c.* from public.constitution_checks c join mem on mem.id = c.member_id where c.created_at < m_end order by c.member_id, c.created_at desc, c.id desc)
  select jsonb_build_object('checkedMembers', (select count(*) from latest), 'checksInMonth',
           (select count(*) from public.constitution_checks c join mem on mem.id = c.member_id where c.created_at >= m_start and c.created_at < m_end),
         'byType', jsonb_build_object('wood', count(*) filter (where not balanced and primary_element = 'wood'), 'fire', count(*) filter (where not balanced and primary_element = 'fire'),
           'earth', count(*) filter (where not balanced and primary_element = 'earth'), 'metal', count(*) filter (where not balanced and primary_element = 'metal'),
           'water', count(*) filter (where not balanced and primary_element = 'water'), 'balanced', count(*) filter (where balanced)))
    into cc from latest;
  -- 特典チケット: その月の発行・使用、月末までの累計の使用率
  with t as (select pt.* from public.perk_tickets pt join public.members m on m.id = pt.member_id where m.is_test = tst)
  select jsonb_build_object(
    'issued', (select count(*) from t where issued_at >= m_start and issued_at < m_end),
    'used', (select count(*) from t where used_at >= m_start and used_at < m_end),
    'issuedByKind', jsonb_build_object('milestone', (select count(*) from t where kind = 'milestone' and issued_at >= m_start and issued_at < m_end),
                                       'seasonal', (select count(*) from t where kind = 'seasonal' and issued_at >= m_start and issued_at < m_end),
                                       'referral', (select count(*) from t where kind = 'referral' and issued_at >= m_start and issued_at < m_end)),
    'cumulativeIssued', (select count(*) from t where issued_at < m_end),
    'cumulativeUsed', (select count(*) from t where used_at < m_end),
    'usageRatePercent', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where used_at < m_end) / count(*), 1) end from t where issued_at < m_end))
    into tk;
  return jsonb_build_object('month', p_month, 'skipped', false, 'scope', case when tst then 'test' else 'production' end, 'state', public._state(),
    'generatedAt', p_now, 'launchDate', st.launch_date::text, 'monthIndex', cur -> 'monthIndex', 'milestone', cur -> 'milestone', 'previousMonth', prev ->> 'month',
    'kpis', kp,
    'pos', jsonb_build_object('customers', cur -> 'pos' -> 'customers', 'source', cur -> 'pos' -> 'source', 'days', cur -> 'pos' -> 'days', 'missing', (cur -> 'pos' ->> 'missing')::boolean),
    'members', jsonb_build_object('newRegistrations', (cur -> 'kpis' -> 'new_members' ->> 'actual')::numeric,
      'referralRegistrations', cur -> 'supporting' -> 'referralRegistrations', 'referralFirstVisits', cur -> 'supporting' -> 'referralFirstVisits',
      'activeMembers', cur -> 'supporting' -> 'activeMembers', 'memberVisits', cur -> 'memberVisits', 'byRank', ranks),
    'constitution', cc || jsonb_build_object('checkRatePercent', (cur -> 'kpis' -> 'check_rate' ->> 'actual')::numeric,
      'checkResults', public._cc_check_dist(tst, m_start, m_end),
      'visitCheckRate', jsonb_build_object('visitDays', cur -> 'supporting' -> 'visitDays', 'checkedVisitDays', cur -> 'supporting' -> 'checkedVisitDays',
                                           'ratePercent', cur -> 'supporting' -> 'visitCheckRatePercent')),
    'tickets', tk);
end $$;

-- ---------- 非推奨の印(古い画面との互換のために残す。使わない) ----------
comment on table public.constitution_daily_conditions is '非推奨(2026-10-15・db/107): 今日の体調(3問)は廃止。古い画面との互換のために残す。集計・画面では使わない';
comment on function public.app_condition_submit(text, text, text, text, text, timestamptz) is '非推奨(2026-10-15・db/107): 今日の体調(3問)は廃止。古い画面との互換のために残す';

-- ---------- 権限: 新しい内部関数は誰からも直接は呼べない(置き換えた関数は権限を引き継ぐ) ----------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_cc_avg_result','_cc_profile','_cc_history','_cc_check_dist','_visit_check_rate','_kpi_with_visit_check']) loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

commit;
