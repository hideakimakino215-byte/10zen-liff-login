-- 10ZEN デジタル会員証 目標と KPI(2026-10-15 設計: KPI_DESIGN_20261015.md)【本番未適用・ローカル検証のみ】
-- 前提: 100・101・102・103・104 が適用済み。取り消しは 105_kpi_DOWN.sql。
-- 内容
--  * 本番開始日(kpi_settings。1行)と、KPI ごとの目標(kpi_targets。3・6・12か月。値は仮の初期値で、店長が画面で変えられる)。
--  * レジの客数(日別: pos_daily_customers。CSV を画面で読み、日付と客数だけを送る。売上は送らない・保存しない)。
--    同じ日付をもう一度取り込むと上書きし、変わった値は監査ログに残す。CSV がないときの代わりに、月の客数を手で入れられる(pos_monthly_customers)。
--  * 集計(staff_kpi_overview): 月ごとの4つの KPI と補助の数字・レジの客数・目標・達成率。店長(manager)と閲覧(viewer。本部)だけ。スタッフ・店頭タブレットは拒否。
--  * 変更(manager_*): 店長だけ。
--  * 試験運用中(state=test)は、会員の数字は試験会員だけ、レジの客数も試験用の別の行(is_test)を使う(本番の客数に試験の取り込みが混ざらない)。
--    本番開始日と目標は共通(状態によらない)。会員のデータではないので、凍結中も変更できる。
--  * 既存の customers / interactions / TOBIRA には触れない。
-- KPI の決め方(日本時間。月 = その月の1日〜末日。今月は今日まで)
--  1. 会員来店率(member_visit_rate) = 会員の来店数 ÷ レジの客数 × 100。
--     会員の来店数 = visits の行数(1会員1日1行。登録日の来店扱い・移行時の最終来店日の行も含む)。
--     日別の客数があるときは、客数を取り込んだ日の来店だけを数えて割る(月の途中・除外した日があっても率がずれない)。
--     日別がなく月の客数(手入力)だけがあるときは、その月の来店数 ÷ 月の客数。どちらもなければ null(画面は「レジの客数が未取り込み」)。
--     補助: 新規登録数(new_members) = その月に登録した会員の数(移行で取り込んだ会員=開始残高のある会員は除く)。新規登録数も目標を持つ KPI として返す。
--  2. 体質チェック実施率(check_rate) = 月末(今月は今)時点の有効会員のうち、体質チェックを1回以上した会員の割合。
--     補助: 季節の再チェック率 = 実施した会員のうち、最新の結果がその時点の季節(102 の _season_of)のものの割合。
--  3. 再来店率(revisit_rate) = 月末(今月は今日)までの直近60日に来店記録が2日以上ある会員 ÷ 有効会員(月末時点)。
--     103 の staff_constitution_stats の再来店率と同じ決め方(分母は有効会員全員)。補助: 60日に1日以上来た会員のうち2日以上の割合も返す。
--     「有効会員」は今の状態(status=active)で数える(停止の履歴は持っていないため、過去の月も今の状態で判定する)。
--  4. 薬日本堂への送客(referral_clicks) = その月の「薬日本堂の漢方相談へ」の押された数。補助: 押された数 ÷ 体質チェックを実施した会員 × 100。
-- 目標の段階(milestone): 本番開始日の月を1か月目として、1〜3か月目=3か月の目標、4〜6か月目=6か月、7か月目以降=12か月。開始日より前の月・未設定は null。
-- 達成率 = 実績 ÷ 目標 × 100(目標が null・0 のときは null)。数の KPI(新規登録・送客)の今月分は、目標を経過日数で日割りして比べる。
-- 置き換える既存の関数(権限はそのまま引き継がれる): export_backup / restore_backup(新しい表を追加。105 より前のバックアップも復元できる)。
begin;

-- ---------- 本番開始日(1行) ----------
create table public.kpi_settings (
  id          boolean primary key default true check (id),
  launch_date date check (launch_date is null or launch_date between date '2020-01-01' and date '2100-12-31'),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
insert into public.kpi_settings default values;

-- ---------- 目標(KPI × 3・6・12か月。null = 目標なし(基準値を測る)) ----------
create table public.kpi_targets (
  kpi_code   text not null check (kpi_code in ('member_visit_rate','new_members','check_rate','revisit_rate','referral_clicks')),
  milestone  smallint not null check (milestone in (3, 6, 12)),
  value      numeric(10,1) check (value is null or value >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (kpi_code, milestone)
);
-- 仮の初期値(2026-10-15 の決定。店長が画面で変えられる)。率は %、新規登録数と送客は月の件数
insert into public.kpi_targets(kpi_code, milestone, value) values
  ('member_visit_rate', 3, 15), ('member_visit_rate', 6, 25), ('member_visit_rate', 12, 35),
  ('new_members',       3, 300), ('new_members',      6, 250), ('new_members',      12, 200),
  ('check_rate',        3, 40), ('check_rate',        6, 50), ('check_rate',        12, 60),
  ('revisit_rate',      3, null), ('revisit_rate',    6, 30), ('revisit_rate',      12, 40),
  ('referral_clicks',   3, 20), ('referral_clicks',   6, 40), ('referral_clicks',   12, 60);

-- ---------- レジの客数(日別。日付と客数だけ。売上は持たない) ----------
create table public.pos_daily_customers (
  is_test       boolean not null default false,                -- 試験運用中の取り込み(本番の客数と分ける)
  business_date date not null,
  customers     integer not null check (customers between 0 and 100000),
  source        text not null check (char_length(source) between 1 and 200),   -- 取り込んだファイル名
  imported_at   timestamptz not null default now(),
  imported_by   uuid,
  primary key (is_test, business_date)
);

-- ---------- レジの客数(月。CSV がないときの手入力。日別があればそちらを使う) ----------
create table public.pos_monthly_customers (
  is_test     boolean not null default false,
  month       date not null check (extract(day from month) = 1),
  customers   integer not null check (customers between 0 and 1000000),
  entered_at  timestamptz not null default now(),
  entered_by  uuid,
  primary key (is_test, month)
);

-- ---------- 内部関数 ----------
-- KPI の種類(率か数か)と、値の上限
create function public._kpi_is_rate(p_kpi text) returns boolean
language sql immutable set search_path = public as $$ select p_kpi in ('member_visit_rate', 'check_rate', 'revisit_rate') $$;

-- 達成率(%・整数)。実績か目標がない・目標が0以下なら null
create function public._kpi_ach(p_actual numeric, p_target numeric) returns numeric
language sql immutable set search_path = public as $$
  select case when p_actual is null or p_target is null or p_target <= 0 then null else round(100.0 * p_actual / p_target, 0) end
$$;

-- 月ごとの KPI(p_now を基準の時刻にする。staff_kpi_overview は now() で呼ぶ。検証では日時を固定して呼ぶ)
create function public._kpi_overview(p_tst boolean, p_months integer, p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := public._jst_date(p_now); cur date := date_trunc('month', public._jst_date(p_now))::date; k integer := least(greatest(coalesce(p_months, 13), 1), 36);
        st public.kpi_settings; lm date; ms date; me date; ref date; ref_end timestamptz; m_start timestamptz;
        idx integer; mile integer; elapsed integer; dim integer; is_cur boolean;
        pos_days integer; pos_sum bigint; pos_last timestamptz; pos_src text; man integer; pos_customers bigint; pos_source text; v_month integer; v_pos integer; vrate numeric;
        newm integer; act integer; chk integer; chk_season integer; vis1 integer; vis2 integer; clicks integer; sk text;
        tg jsonb; months jsonb := '[]'::jsonb; t_of jsonb; kp jsonb; f numeric;
begin
  select * into st from public.kpi_settings;
  lm := date_trunc('month', st.launch_date)::date;
  select coalesce(jsonb_object_agg(x.kpi_code, x.v), '{}'::jsonb) into tg from (
    select kpi_code, jsonb_object_agg(milestone::text, value) v from public.kpi_targets group by kpi_code) x;
  for i in reverse (k - 1)..0 loop
    ms := (cur - make_interval(months => i))::date; me := (ms + interval '1 month')::date - 1;
    is_cur := ms = cur; ref := least(me, today);
    ref_end := (ref + 1)::timestamp at time zone 'Asia/Tokyo';
    m_start := ms::timestamp at time zone 'Asia/Tokyo';
    elapsed := ref - ms + 1; dim := me - ms + 1;
    idx := case when lm is null then null else (extract(year from ms)::int * 12 + extract(month from ms)::int) - (extract(year from lm)::int * 12 + extract(month from lm)::int) + 1 end;
    mile := case when idx is null or idx < 1 then null when idx <= 3 then 3 when idx <= 6 then 6 else 12 end;
    -- レジの客数: 日別があれば日別の合計、なければ月の手入力
    select count(*), sum(customers), max(imported_at) into pos_days, pos_sum, pos_last from public.pos_daily_customers where is_test = p_tst and business_date between ms and ref;
    select source into pos_src from public.pos_daily_customers where is_test = p_tst and business_date between ms and ref order by imported_at desc, business_date desc limit 1;
    select customers into man from public.pos_monthly_customers where is_test = p_tst and month = ms;
    select count(*) into v_month from public.visits v join public.members m on m.id = v.member_id where m.is_test = p_tst and v.visit_on between ms and ref;
    if pos_days > 0 then
      pos_customers := pos_sum; pos_source := 'daily';
      select count(*) into v_pos from public.visits v join public.members m on m.id = v.member_id
        where m.is_test = p_tst and v.visit_on in (select business_date from public.pos_daily_customers where is_test = p_tst and business_date between ms and ref);
    elsif man is not null then pos_customers := man; pos_source := 'manual'; v_pos := v_month;
    else pos_customers := null; pos_source := null; v_pos := null; end if;
    vrate := case when pos_customers is null or pos_customers = 0 then null else round(100.0 * v_pos / pos_customers, 1) end;
    -- 新規登録(移行で取り込んだ会員は除く)
    select count(*) into newm from public.members m where m.is_test = p_tst and m.created_at >= m_start and m.created_at < ref_end
      and not exists (select 1 from public.point_ledger l where l.member_id = m.id and l.entry_type = 'opening_balance');
    -- 月末(今月は今)時点の有効会員・実施・季節の再チェック・直近60日の来店
    sk := public._season_of(ref) ->> 'key';
    with mem as (select m.id from public.members m where m.is_test = p_tst and m.status = 'active' and m.created_at < ref_end),
         latest as (select distinct on (c.member_id) c.member_id, c.season_key from public.constitution_checks c join mem on mem.id = c.member_id
                    where c.created_at < ref_end order by c.member_id, c.created_at desc, c.id desc),
         vis as (select mem.id, count(v.id) as n from mem left join public.visits v on v.member_id = mem.id and v.visit_on between ref - 59 and ref group by mem.id)
    select (select count(*) from mem), (select count(*) from latest), (select count(*) from latest where season_key = sk),
           (select count(*) from vis where n >= 1), (select count(*) from vis where n >= 2)
      into act, chk, chk_season, vis1, vis2;
    select count(*) into clicks from public.constitution_referral_clicks c join public.members m on m.id = c.member_id
      where m.is_test = p_tst and c.clicked_at >= m_start and c.clicked_at < ref_end;
    -- KPI ごとの実績・目標・達成率(数の KPI の今月分は日割りの目標で比べる)
    f := case when is_cur then elapsed::numeric / dim else 1 end;
    kp := '{}'::jsonb;
    for t_of in select jsonb_build_object('code', c, 'actual', a) from (values
        ('member_visit_rate', vrate),
        ('new_members', newm::numeric),
        ('check_rate', case when act = 0 then null else round(100.0 * chk / act, 1) end),
        ('revisit_rate', case when act = 0 then null else round(100.0 * vis2 / act, 1) end),
        ('referral_clicks', clicks::numeric)) x(c, a) loop
      declare code text := t_of ->> 'code'; a numeric := (t_of ->> 'actual')::numeric; t numeric; basis numeric;
      begin
        t := case when mile is null then null else (tg -> code ->> mile::text)::numeric end;
        basis := case when t is null then null when public._kpi_is_rate(code) then t else round(t * f, 1) end;
        kp := kp || jsonb_build_object(code, jsonb_build_object('actual', a, 'target', t, 'targetCompared', basis,
                 'prorated', (not public._kpi_is_rate(code)) and is_cur and t is not null, 'achievementPercent', public._kpi_ach(a, basis)));
      end;
    end loop;
    months := months || jsonb_build_object(
      'month', to_char(ms, 'YYYY-MM'), 'from', ms::text, 'to', me::text, 'isCurrent', is_cur, 'asOfDate', ref::text,
      'elapsedDays', elapsed, 'daysInMonth', dim, 'monthIndex', idx, 'milestone', mile,
      'pos', jsonb_build_object('customers', pos_customers, 'source', pos_source, 'days', pos_days, 'manualCustomers', man,
                                'lastImportedAt', pos_last, 'lastSource', pos_src, 'missing', pos_customers is null),
      'memberVisits', v_month, 'memberVisitsOnPosDays', v_pos,
      'kpis', kp,
      'supporting', jsonb_build_object(
        'activeMembers', act, 'checkedMembers', chk,
        'seasonRecheckPercent', case when chk = 0 then null else round(100.0 * chk_season / chk, 1) end, 'seasonKey', sk,
        'revisitWindowDays', 60, 'revisitMembers', vis2, 'visitorsInWindow', vis1,
        'revisitAmongVisitorsPercent', case when vis1 = 0 then null else round(100.0 * vis2 / vis1, 1) end,
        'referralPerCheckedPercent', case when chk = 0 then null else round(100.0 * clicks / chk, 1) end));
  end loop;
  return jsonb_build_object('asOf', p_now, 'today', today::text, 'launchDate', st.launch_date::text, 'launchUpdatedAt', st.updated_at,
    'targets', tg, 'months', months);
end $$;

-- ---------- スタッフ向け関数 ----------
-- 目標と KPI の集計: 店長・閲覧(本部)だけ。スタッフ・店頭タブレット・スタッフ以外は拒否。個人の情報は返さない
create function public.staff_kpi_overview(p_months integer default 13) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  perform public._require_role('viewer');                                   -- スタッフ以外・無効・店頭タブレットは拒否
  r := public._staff_role();
  if r not in ('manager', 'viewer') then raise exception 'forbidden' using errcode = '42501'; end if;   -- スタッフ(staff)も拒否
  return public._kpi_overview(public._state() = 'test', p_months, now())
    || jsonb_build_object('state', public._state(), 'canEdit', r = 'manager');
end $$;

-- 本番開始日(null で未設定に戻す)
create function public.manager_set_launch_date(p_date date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old date;
begin
  perform public._require_role('manager');
  if p_date is not null and p_date not between date '2020-01-01' and date '2100-12-31' then raise exception 'invalid_date' using errcode = '22023'; end if;
  select launch_date into old from public.kpi_settings for update;
  update public.kpi_settings set launch_date = p_date, updated_at = now(), updated_by = auth.uid();
  perform public._audit(auth.uid(), 'kpi_launch_date', null, jsonb_build_object('old', old, 'new', p_date));
  return jsonb_build_object('status', 'ok', 'launchDate', p_date::text);
end $$;

-- 目標(KPI × 3・6・12か月)。null = 目標なし。率は 0〜100(%)、数は 0〜100000 の整数
create function public.manager_set_kpi_target(p_kpi text, p_milestone integer, p_value numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old numeric;
begin
  perform public._require_role('manager');
  if p_kpi is null or p_kpi not in ('member_visit_rate','new_members','check_rate','revisit_rate','referral_clicks') then raise exception 'invalid_kpi' using errcode = '22023'; end if;
  if p_milestone is null or p_milestone not in (3, 6, 12) then raise exception 'invalid_milestone' using errcode = '22023'; end if;
  if p_value is not null and (p_value < 0 or (public._kpi_is_rate(p_kpi) and (p_value > 100 or p_value <> round(p_value, 1)))
                               or (not public._kpi_is_rate(p_kpi) and (p_value > 100000 or p_value <> trunc(p_value)))) then
    raise exception 'invalid_target' using errcode = '22023'; end if;
  select value into old from public.kpi_targets where kpi_code = p_kpi and milestone = p_milestone for update;
  insert into public.kpi_targets(kpi_code, milestone, value, updated_at, updated_by) values (p_kpi, p_milestone, p_value, now(), auth.uid())
    on conflict (kpi_code, milestone) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  perform public._audit(auth.uid(), 'kpi_target', null, jsonb_build_object('kpi', p_kpi, 'milestone', p_milestone, 'old', old, 'new', p_value));
  return jsonb_build_object('status', 'ok', 'kpi', p_kpi, 'milestone', p_milestone, 'value', p_value);
end $$;

-- レジの客数(日別)の取り込み。p_rows = [{"date":"YYYY-MM-DD","customers":整数}, …](1〜400行。同じ日付は1回まで。未来の日付は不可)。
-- すべての行を確かめてから書く(1行でも不正なら何も書かない)。同じ日付が既にあれば上書きし、値が変わった日は監査ログに前後の値を残す。
create function public.manager_import_pos_customers(p_rows jsonb, p_source text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tst boolean := (public._state() = 'test'); today date := public._jst_date(now()); n integer; e jsonb; d date; c integer; old public.pos_daily_customers;
        src text := left(nullif(btrim(regexp_replace(coalesce(p_source, ''), '[[:cntrl:]]', '', 'g')), ''), 200);
        ins integer := 0; upd integer := 0; same integer := 0; changed jsonb := '[]'::jsonb; dmin date; dmax date; total bigint := 0;
begin
  perform public._require_role('manager');
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows' using errcode = '22023'; end if;
  n := jsonb_array_length(p_rows);
  if n < 1 or n > 400 then raise exception 'invalid_rows' using errcode = '22023', detail = 'rows must be 1..400'; end if;
  for e in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'date') is distinct from 'string' or (e ->> 'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'invalid_date' using errcode = '22023'; end if;
    begin d := to_date(e ->> 'date', 'YYYY-MM-DD'); exception when others then raise exception 'invalid_date' using errcode = '22023'; end;
    if to_char(d, 'YYYY-MM-DD') <> e ->> 'date' or d < date '2000-01-01' or d > today then raise exception 'invalid_date' using errcode = '22023'; end if;
    if jsonb_typeof(e -> 'customers') is distinct from 'number' or (e ->> 'customers') !~ '^[0-9]{1,6}$' or (e ->> 'customers')::integer > 100000 then
      raise exception 'invalid_customers' using errcode = '22023'; end if;
  end loop;
  if (select count(distinct value ->> 'date') from jsonb_array_elements(p_rows)) <> n then raise exception 'invalid_rows' using errcode = '22023', detail = 'duplicate date'; end if;
  perform pg_advisory_xact_lock(hashtextextended('kpi:pos_import', 0));       -- 同時の取り込みを直列化
  for e in select value from jsonb_array_elements(p_rows) order by value ->> 'date' loop
    d := (e ->> 'date')::date; c := (e ->> 'customers')::integer; total := total + c;
    dmin := least(coalesce(dmin, d), d); dmax := greatest(coalesce(dmax, d), d);
    select * into old from public.pos_daily_customers where is_test = tst and business_date = d for update;
    if not found then
      insert into public.pos_daily_customers(is_test, business_date, customers, source, imported_at, imported_by) values (tst, d, c, coalesce(src, 'csv'), now(), auth.uid());
      ins := ins + 1;
    else
      update public.pos_daily_customers set customers = c, source = coalesce(src, 'csv'), imported_at = now(), imported_by = auth.uid() where is_test = tst and business_date = d;
      if old.customers <> c then upd := upd + 1; changed := changed || jsonb_build_object('date', d, 'old', old.customers, 'new', c, 'oldSource', old.source);
      else same := same + 1; end if;
    end if;
  end loop;
  perform public._audit(auth.uid(), 'pos_import', null, jsonb_build_object('source', coalesce(src, 'csv'), 'rows', n, 'inserted', ins, 'updated', upd, 'unchanged', same,
    'from', dmin, 'to', dmax, 'customers', total, 'changed', changed, 'test', tst));
  return jsonb_build_object('status', 'ok', 'inserted', ins, 'updated', upd, 'unchanged', same, 'from', dmin::text, 'to', dmax::text, 'customers', total);
end $$;

-- レジの客数(月)の手入力。p_month = 'YYYY-MM'(今月まで)。p_customers = null で手入力を消す
create function public.manager_set_pos_monthly(p_month text, p_customers integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tst boolean := (public._state() = 'test'); ms date; old integer;
begin
  perform public._require_role('manager');
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'invalid_month' using errcode = '22023'; end if;
  ms := to_date(p_month || '-01', 'YYYY-MM-DD');
  if ms < date '2000-01-01' or ms > date_trunc('month', public._jst_date(now()))::date then raise exception 'invalid_month' using errcode = '22023'; end if;
  if p_customers is not null and (p_customers < 0 or p_customers > 1000000) then raise exception 'invalid_customers' using errcode = '22023'; end if;
  select customers into old from public.pos_monthly_customers where is_test = tst and month = ms for update;
  if p_customers is null then delete from public.pos_monthly_customers where is_test = tst and month = ms;
  else insert into public.pos_monthly_customers(is_test, month, customers, entered_at, entered_by) values (tst, ms, p_customers, now(), auth.uid())
         on conflict (is_test, month) do update set customers = excluded.customers, entered_at = excluded.entered_at, entered_by = excluded.entered_by; end if;
  perform public._audit(auth.uid(), 'pos_monthly', null, jsonb_build_object('month', p_month, 'old', old, 'new', p_customers, 'test', tst));
  return jsonb_build_object('status', 'ok', 'month', p_month, 'customers', p_customers);
end $$;

-- ---------- バックアップ/復元: 新しい表を加える(103 の export_backup / restore_backup に追加。他は同じ) ----------
create or replace function public.export_backup() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('version', 1, 'exportedAt', now(), 'tables', jsonb_build_object(
    'app_settings',     (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.app_settings t),
    'point_rules',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.point_rules t),
    'rank_thresholds',  (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.rank_thresholds t),
    'policy_decisions', (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.policy_decisions t),
    'system_state',     (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.system_state t),
    'test_allowlist',   (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.test_allowlist t),
    'members',          (select coalesce(jsonb_agg(to_jsonb(t) order by t.member_no), '[]') from public.members t),
    'member_identities',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from public.member_identities t),
    'point_ledger',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.point_ledger t),
    'visits',           (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.visits t),
    'redeem_requests',  (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from public.redeem_requests t),
    'perk_ticket_types',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.code), '[]') from public.perk_ticket_types t),
    'perk_tickets',         (select coalesce(jsonb_agg(to_jsonb(t) order by t.issued_at, t.id), '[]') from public.perk_tickets t),
    'perk_ticket_requests', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from public.perk_ticket_requests t),
    'constitution_consents',         (select coalesce(jsonb_agg(to_jsonb(t) order by t.consented_at, t.member_id), '[]') from public.constitution_consents t),
    'constitution_checks',           (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from public.constitution_checks t),
    'constitution_daily_conditions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.on_date, t.member_id), '[]') from public.constitution_daily_conditions t),
    'constitution_referral_clicks',  (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.constitution_referral_clicks t),
    'kpi_settings',          (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.kpi_settings t),
    'kpi_targets',           (select coalesce(jsonb_agg(to_jsonb(t) order by t.kpi_code, t.milestone), '[]') from public.kpi_targets t),
    'pos_daily_customers',   (select coalesce(jsonb_agg(to_jsonb(t) order by t.is_test, t.business_date), '[]') from public.pos_daily_customers t),
    'pos_monthly_customers', (select coalesce(jsonb_agg(to_jsonb(t) order by t.is_test, t.month), '[]') from public.pos_monthly_customers t),
    'staff_users',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.staff_users t),
    'audit_log',        (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from (select * from public.audit_log order by id desc limit 5000) t)));
end $$;

-- 105 より前のバックアップ(KPI の表がない)も復元できる(その場合、本番開始日は未設定・目標は初期値・客数は0件のまま)
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t jsonb := p -> 'tables'; mx bigint; bad integer;
begin
  if (p ->> 'version') is distinct from '1' or t is null then raise exception 'invalid_backup' using errcode = '22023'; end if;
  if exists (select 1 from public.members) or exists (select 1 from public.point_ledger) or exists (select 1 from public.perk_tickets)
     or exists (select 1 from public.constitution_checks) or exists (select 1 from public.pos_daily_customers) then raise exception 'target_not_empty' using errcode = '55000'; end if;
  insert into public.rank_thresholds select * from jsonb_populate_recordset(null::public.rank_thresholds, t -> 'rank_thresholds')
    on conflict (rank_code) do update set min_points = excluded.min_points, label = excluded.label;
  insert into public.app_settings select * from jsonb_populate_recordset(null::public.app_settings, t -> 'app_settings')
    on conflict (key) do update set value = excluded.value, note = excluded.note;
  insert into public.point_rules select * from jsonb_populate_recordset(null::public.point_rules, t -> 'point_rules')
    on conflict (code) do update set points = excluded.points, active = excluded.active, starts_on = excluded.starts_on, ends_on = excluded.ends_on, description = excluded.description;
  insert into public.policy_decisions select * from jsonb_populate_recordset(null::public.policy_decisions, t -> 'policy_decisions')
    on conflict (key) do update set decided = excluded.decided, value = excluded.value, note = excluded.note, decided_at = excluded.decided_at, decided_via = excluded.decided_via;
  insert into public.test_allowlist select * from jsonb_populate_recordset(null::public.test_allowlist, t -> 'test_allowlist') on conflict do nothing;
  insert into public.members select * from jsonb_populate_recordset(null::public.members, t -> 'members');
  insert into public.member_identities select * from jsonb_populate_recordset(null::public.member_identities, t -> 'member_identities');
  insert into public.point_ledger overriding system value select * from jsonb_populate_recordset(null::public.point_ledger, t -> 'point_ledger');
  insert into public.visits overriding system value select * from jsonb_populate_recordset(null::public.visits, t -> 'visits');
  insert into public.redeem_requests select * from jsonb_populate_recordset(null::public.redeem_requests, t -> 'redeem_requests');
  insert into public.perk_ticket_types select * from jsonb_populate_recordset(null::public.perk_ticket_types, coalesce(t -> 'perk_ticket_types', '[]'::jsonb))
    on conflict (code) do update set kind = excluded.kind, rank_code = excluded.rank_code, label = excluded.label, valid_days = excluded.valid_days, active = excluded.active;
  insert into public.perk_tickets select * from jsonb_populate_recordset(null::public.perk_tickets, coalesce(t -> 'perk_tickets', '[]'::jsonb));
  insert into public.perk_ticket_requests select * from jsonb_populate_recordset(null::public.perk_ticket_requests, coalesce(t -> 'perk_ticket_requests', '[]'::jsonb));
  insert into public.constitution_consents select * from jsonb_populate_recordset(null::public.constitution_consents, coalesce(t -> 'constitution_consents', '[]'::jsonb));
  insert into public.constitution_checks select * from jsonb_populate_recordset(null::public.constitution_checks, coalesce(t -> 'constitution_checks', '[]'::jsonb));
  insert into public.constitution_daily_conditions select * from jsonb_populate_recordset(null::public.constitution_daily_conditions, coalesce(t -> 'constitution_daily_conditions', '[]'::jsonb));
  insert into public.constitution_referral_clicks overriding system value
    select * from jsonb_populate_recordset(null::public.constitution_referral_clicks, coalesce(t -> 'constitution_referral_clicks', '[]'::jsonb));
  insert into public.kpi_settings select * from jsonb_populate_recordset(null::public.kpi_settings, coalesce(t -> 'kpi_settings', '[]'::jsonb))
    on conflict (id) do update set launch_date = excluded.launch_date, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  insert into public.kpi_targets select * from jsonb_populate_recordset(null::public.kpi_targets, coalesce(t -> 'kpi_targets', '[]'::jsonb))
    on conflict (kpi_code, milestone) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  insert into public.pos_daily_customers select * from jsonb_populate_recordset(null::public.pos_daily_customers, coalesce(t -> 'pos_daily_customers', '[]'::jsonb));
  insert into public.pos_monthly_customers select * from jsonb_populate_recordset(null::public.pos_monthly_customers, coalesce(t -> 'pos_monthly_customers', '[]'::jsonb))
    on conflict (is_test, month) do update set customers = excluded.customers, entered_at = excluded.entered_at, entered_by = excluded.entered_by;
  insert into public.staff_users select s.* from jsonb_populate_recordset(null::public.staff_users, t -> 'staff_users') s where exists (select 1 from auth.users u where u.id = s.user_id);
  insert into public.audit_log overriding system value select * from jsonb_populate_recordset(null::public.audit_log, t -> 'audit_log');
  select coalesce(max(substr(member_no, 5)::bigint), 0) into mx from public.members where member_no ~ '^user[0-9]+$';
  perform setval('public.member_no_seq', greatest(mx, 1), mx > 0);
  select coalesce(max(substr(member_no, 2)::bigint), 0) into mx from public.members where member_no ~ '^T[0-9]+$';
  perform setval('public.test_member_no_seq', greatest(mx, 1), mx > 0);
  perform setval(pg_get_serial_sequence('public.point_ledger', 'id'), greatest((select coalesce(max(id), 0) from public.point_ledger), 1), (select count(*) > 0 from public.point_ledger));
  perform setval(pg_get_serial_sequence('public.visits', 'id'), greatest((select coalesce(max(id), 0) from public.visits), 1), (select count(*) > 0 from public.visits));
  perform setval(pg_get_serial_sequence('public.audit_log', 'id'), greatest((select coalesce(max(id), 0) from public.audit_log), 1), (select count(*) > 0 from public.audit_log));
  perform setval(pg_get_serial_sequence('public.constitution_referral_clicks', 'id'), greatest((select coalesce(max(id), 0) from public.constitution_referral_clicks), 1),
                 (select count(*) > 0 from public.constitution_referral_clicks));
  update public.system_state set state = 'frozen', reconciled = false, reconciled_at = null, changed_at = now();
  select count(*) into bad from public.verify_balances();
  return jsonb_build_object('status', 'restored', 'members', (select count(*) from public.members), 'ledger', (select count(*) from public.point_ledger),
                            'balanceMismatches', bad, 'state', 'frozen');
end $$;

-- ---------- 権限(anon には何も与えない。表への直接アクセスも与えない) ----------
alter table public.kpi_settings          enable row level security;
alter table public.kpi_targets           enable row level security;
alter table public.pos_daily_customers   enable row level security;
alter table public.pos_monthly_customers enable row level security;

do $$
declare r record;
begin
  for r in select format('%I.%I', n.nspname, c.relname) as nm from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = any(array['kpi_settings','kpi_targets','pos_daily_customers','pos_monthly_customers']) loop
    execute format('revoke all on table %s from public, anon, authenticated, service_role', r.nm);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_kpi_is_rate','_kpi_ach','_kpi_overview','staff_kpi_overview','manager_set_launch_date','manager_set_kpi_target',
                                                                 'manager_import_pos_customers','manager_set_pos_monthly']) loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- service_role(バックアップの見張りなど): 読み取りだけ
grant select on public.kpi_settings, public.kpi_targets, public.pos_daily_customers, public.pos_monthly_customers to service_role;
-- スタッフ向け: ログイン済み(authenticated)。関数内で権限を確認(集計=店長・閲覧、変更=店長)
grant execute on function public.staff_kpi_overview(integer), public.manager_set_launch_date(date), public.manager_set_kpi_target(text, integer, numeric),
  public.manager_import_pos_customers(jsonb, text), public.manager_set_pos_monthly(text, integer) to authenticated;

commit;
