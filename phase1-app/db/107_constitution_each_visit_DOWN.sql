-- 107_constitution_each_visit.sql の取り消し(戻し)用。置き換えた関数を 103〜106 の内容に戻し、107 で足した内部関数と非推奨の注記を消す。
-- 表・データには触れない(107 は関数の置き換えと注記だけ)。戻すと会員証の応答は 106 と同じ(今日の体調・季節の案内のある形)に戻るので、画面も 107 より前に戻すこと。
-- 権限は置き換え前から変わっていない(create or replace のため)。
begin;
-- 103 の内容に戻す(本文は 103_constitution_check.sql と同じ)
create or replace function public._constitution_snapshot(p_member uuid, p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.constitution_checks; dc public.constitution_daily_conditions; d date := public._jst_date(p_now); sk text := public._season_of(public._jst_date(p_now)) ->> 'key';
begin
  select * into c from public.constitution_checks where member_id = p_member order by created_at desc, id desc limit 1;
  select * into dc from public.constitution_daily_conditions where member_id = p_member and on_date = d;
  return jsonb_build_object(
    'constitution', case when c.id is null then null else jsonb_build_object(
        'checkedAt', c.created_at, 'checkedOn', public._jst_date(c.created_at)::text, 'seasonKey', c.season_key,
        'primary', c.primary_element, 'balanced', c.balanced, 'mood', c.mood,
        'scores', jsonb_build_object('wood', c.score_wood, 'fire', c.score_fire, 'earth', c.score_earth, 'metal', c.score_metal, 'water', c.score_water),
        'seasonChanged', c.season_key <> sk) end,
    'constitutionConsent', exists (select 1 from public.constitution_consents where member_id = p_member and version = 'constitution_v1'),
    'todayCondition', case when dc.member_id is null then null else jsonb_build_object('temp', dc.temp, 'energy', dc.energy, 'concern', dc.concern, 'focus', dc.focus_element) end,
    'todayTea', public._tea_of_day(d),
    'yourTea', c.primary_element,
    'season', jsonb_build_object('key', sk, 'element', public._season_element(d)));
end $$;

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
  return jsonb_build_object('status', 'ok', 'result', r, 'member', public._member_view(m.id, p_now));
end $$;

create or replace function public.staff_constitution_stats() returns jsonb
language plpgsql security definer set search_path = public as $$
declare tst boolean := (public._state() = 'test'); d date := public._jst_date(now()); since date := public._jst_date(now()) - 6; full_scope boolean; res jsonb; wk jsonb;
        ms timestamptz := date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
begin
  perform public._require_role('viewer');                                   -- スタッフ以外・無効・店頭タブレットは拒否
  full_scope := public._staff_role() in ('manager', 'viewer');
  select jsonb_build_object('since', since::text, 'until', d::text, 'answers', count(*),
      'temp',    jsonb_build_object('cold', count(*) filter (where c.temp = 'cold'), 'hot', count(*) filter (where c.temp = 'hot'), 'normal', count(*) filter (where c.temp = 'normal')),
      'energy',  jsonb_build_object('tired', count(*) filter (where c.energy = 'tired'), 'stress', count(*) filter (where c.energy = 'stress'), 'fine', count(*) filter (where c.energy = 'fine')),
      'concern', jsonb_build_object('dry', count(*) filter (where c.concern = 'dry'), 'swelling', count(*) filter (where c.concern = 'swelling'), 'none', count(*) filter (where c.concern = 'none')),
      'focus',   jsonb_build_object('wood', count(*) filter (where c.focus_element = 'wood'), 'fire', count(*) filter (where c.focus_element = 'fire'),
                                    'earth', count(*) filter (where c.focus_element = 'earth'), 'metal', count(*) filter (where c.focus_element = 'metal'),
                                    'water', count(*) filter (where c.focus_element = 'water')))
    into wk
    from public.constitution_daily_conditions c join public.members m on m.id = c.member_id
    where m.is_test = tst and c.on_date between since and d;
  res := jsonb_build_object('asOf', now(), 'scope', case when full_scope then 'full' else 'limited' end, 'week', wk);
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
       'thisMonth', (select count(*) from public.constitution_referral_clicks k join public.members m on m.id = k.member_id where m.is_test = tst and k.clicked_at >= ms)))
  into res;
  return res;
end $$;

-- 104 の内容に戻す(本文は 104_member_constitution_link.sql と同じ)
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

-- 106 の内容に戻す(本文は 106_referral.sql と同じ)
create or replace function public.staff_kpi_overview(p_months integer default 13) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text; tst boolean;
begin
  perform public._require_role('viewer');                                   -- スタッフ以外・無効・店頭タブレットは拒否
  r := public._staff_role();
  if r not in ('manager', 'viewer') then raise exception 'forbidden' using errcode = '42501'; end if;   -- スタッフ(staff)も拒否
  tst := public._state() = 'test';
  return public._kpi_with_referral(public._kpi_overview(tst, p_months, now()), tst)
    || jsonb_build_object('state', public._state(), 'canEdit', r = 'manager');
end $$;

create or replace function public.report_monthly(p_month text, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tst boolean := (public._state() = 'test'); ms date; me date; st public.kpi_settings; lm date; ref_now timestamptz; m_start timestamptz; m_end timestamptz;
        o jsonb; cur jsonb; prev jsonb; kp jsonb := '{}'::jsonb; code text; a numeric; p numeric; ranks jsonb; cc jsonb; cond jsonb; tk jsonb;
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
  o := public._kpi_with_referral(public._kpi_overview(tst, 2, ref_now), tst);
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
  -- 今日の体調(その月の回答): 選択肢ごとの数と、いちばん多かった答え(同数は選択肢の並びの先)
  with c as (select x.* from public.constitution_daily_conditions x join public.members m on m.id = x.member_id where m.is_test = tst and x.on_date between ms and me),
       cnt as (select 'temp' q, temp v, count(*) n from c group by temp union all select 'energy', energy, count(*) from c group by energy union all select 'concern', concern, count(*) from c group by concern),
       ord(q, v, o) as (values ('temp','cold',1),('temp','hot',2),('temp','normal',3),('energy','tired',1),('energy','stress',2),('energy','fine',3),('concern','dry',1),('concern','swelling',2),('concern','none',3))
  select jsonb_build_object('answers', (select count(*) from c),
    'counts', (select jsonb_object_agg(q, vals) from (select ord.q, jsonb_object_agg(ord.v, coalesce(cnt.n, 0)) vals from ord left join cnt using (q, v) group by ord.q) z),
    'top', (select jsonb_object_agg(q, v) from (select distinct on (ord.q) ord.q, ord.v from ord join cnt using (q, v) order by ord.q, cnt.n desc, ord.o) z))
    into cond;
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
    'constitution', cc || jsonb_build_object('checkRatePercent', (cur -> 'kpis' -> 'check_rate' ->> 'actual')::numeric, 'conditions', cond),
    'tickets', tk);
end $$;

comment on table public.constitution_daily_conditions is null;
comment on function public.app_condition_submit(text, text, text, text, text, timestamptz) is null;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_cc_avg_result','_cc_profile','_cc_history','_cc_check_dist','_visit_check_rate','_kpi_with_visit_check']) loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;
commit;
