-- 10ZEN デジタル会員証 1分体質チェック(2026-10-15 設計: CONSTITUTION_CHECK_DESIGN_20261015.md)【本番未適用・ローカル検証のみ】
-- 前提: 100_phase1_schema.sql・101_search_path_fix.sql・102_rank_perks.sql が適用済み。取り消しは 103_constitution_check_DOWN.sql。
-- 内容
--  * 15問(五行ごとに3問。よくある=2・ときどき=1・あまりない=0)+食事の気分(16問目)。点数とタイプは DB が計算する(画面から送られた点数は受け取らない)。
--    五行ごとの合計(0〜6)の一番高い五行が主なタイプ。同点は今の季節の五行を優先し、それでも決まらなければ 木・火・土・金・水 の順。全部1点以下は「バランス良好」。
--    季節(日本時間): 春 3〜5月=木・夏 6〜8月=火・秋 9〜11月=金・冬 12〜2月=水。土用=土は、立春・立夏・立秋・立冬の前の約18日を
--    年によらない固定の日付で近似する(1/17〜2/3・4/17〜5/4・7/20〜8/6・10/20〜11/6。両端を含む)。実際の土用の入りは年により1日ほど前後する。
--  * 初回は同意(版 constitution_v1)が必要。同意の行がなく、同意なしで送られたら記録しない。
--  * 今日の体調(1日1回・任意): 選んだ五行に2点を足して、今日のおすすめの五行(focus)を決める(同点の決め方は同じ)。
--  * 五巡茶の日替わり(日本時間の曜日): 火=火・水=水・木=木・金=金・土=土。月・日=今の季節の五行(土用は土)。
--  * 薬日本堂の漢方相談への案内のボタンが押された回数を記録する(個人の結果は送らない)。
--  * スタッフの集計(staff_constitution_stats): 店長・閲覧(本部)はすべて、スタッフは「今週(直近7日)の体調の傾向」だけ。店頭タブレットは不可。
--  * 既存の customers / interactions / TOBIRA には触れない。
-- 置き換える既存の関数(権限はそのまま引き継がれる): _member_view(102。体質チェックの情報を足す)、export_backup / restore_backup(新しい表を追加)。
begin;

-- 16問目(食事の気分)の選択肢のコード。表示名は app-core/constitution-content.mjs。仮: メニューが決まったら、この行と表示名を差し替える
insert into public.app_settings(key, value, note) values
  ('constitution_moods', 'okayu,soup,nabe_solo,noodle,nabe_share',
   '1分体質チェックの16問目(食事の気分)の選択肢のコード(カンマ区切り)。仮: メニューが決まったら差し替える。表示名は app-core/constitution-content.mjs')
on conflict (key) do nothing;

-- ---------- 同意(版ごとに1行) ----------
create table public.constitution_consents (
  member_id    uuid not null references public.members(id) on delete restrict,
  version      text not null check (version ~ '^[a-z0-9_]{1,40}$'),
  consented_at timestamptz not null,
  primary key (member_id, version)
);

-- ---------- 体質チェックの結果(1回=1行。判定を直しても計算し直せるよう、回答も残す) ----------
create table public.constitution_checks (
  id              uuid primary key default gen_random_uuid(),
  member_id       uuid not null references public.members(id) on delete restrict,
  answers         smallint[] not null check (array_ndims(answers) = 1 and array_lower(answers, 1) = 1 and array_length(answers, 1) = 15
                                             and array_position(answers, null) is null and 0 <= all(answers) and 2 >= all(answers)),
  mood            text not null check (mood ~ '^[a-z][a-z0-9_]{0,31}$'),
  score_wood      smallint not null check (score_wood  between 0 and 6),
  score_fire      smallint not null check (score_fire  between 0 and 6),
  score_earth     smallint not null check (score_earth between 0 and 6),
  score_metal     smallint not null check (score_metal between 0 and 6),
  score_water     smallint not null check (score_water between 0 and 6),
  primary_element text not null check (primary_element in ('wood','fire','earth','metal','water')),   -- バランス良好でも、同じ決め方で選んだ五行(「あなたのお茶」に使う)
  balanced        boolean not null,                                                                     -- 全部1点以下
  season_key      text not null check (season_key ~ '^[0-9]{4}-(spring|summer|autumn|winter)$'),       -- 実施した季節(102 の _season_of。冬は12月の年)。季節が変わったら案内を出す
  season_element  text not null check (season_element in ('wood','fire','earth','metal','water')),    -- 実施した日の季節の五行(土用を含む。同点の決め方に使った)
  created_at      timestamptz not null
);
create index on public.constitution_checks (member_id, created_at desc);

-- ---------- 今日の体調(会員×日本時間の日付で1行) ----------
create table public.constitution_daily_conditions (
  member_id     uuid not null references public.members(id) on delete restrict,
  on_date       date not null,
  check_id      uuid not null references public.constitution_checks(id) on delete restrict,   -- 足し算のもとにした結果
  temp          text not null check (temp in ('cold','hot','normal')),          -- A. 冷えている(水)/ほてっている(火)/ふつう
  energy        text not null check (energy in ('tired','stress','fine')),      -- B. 疲れ・胃が重い(土)/ストレス・張り(木)/元気
  concern       text not null check (concern in ('dry','swelling','none')),     -- C. 乾燥・のど(金)/むくみ・だるさ(土)/特になし
  focus_element text not null check (focus_element in ('wood','fire','earth','metal','water')),
  created_at    timestamptz not null,
  primary key (member_id, on_date)
);
create index on public.constitution_daily_conditions (on_date);

-- ---------- 薬日本堂の漢方相談への案内のクリック ----------
create table public.constitution_referral_clicks (
  id         bigint generated always as identity primary key,
  member_id  uuid not null references public.members(id) on delete restrict,
  check_id   uuid references public.constitution_checks(id) on delete restrict,
  target     text not null default 'nihondo_consult' check (target ~ '^[a-z_]{1,40}$'),
  clicked_at timestamptz not null
);
create index on public.constitution_referral_clicks (clicked_at);

-- ---------- 内部関数(判定。app-core/constitution.mjs と同じ決め方。test_constitution.mjs が一致を確かめる) ----------
-- 日本時間の日付 → 季節の五行。土用(土)は固定の日付で近似(上の説明)
create function public._season_element(d date) returns text
language plpgsql immutable set search_path = public as $$
declare md integer := extract(month from d)::int * 100 + extract(day from d)::int;
begin
  if md between 117 and 203 or md between 417 and 504 or md between 720 and 806 or md between 1020 and 1106 then return 'earth'; end if;
  if md between 301 and 531 then return 'wood'; end if;
  if md between 601 and 831 then return 'fire'; end if;
  if md between 901 and 1130 then return 'metal'; end if;
  return 'water';
end $$;

-- 点数(木・火・土・金・水の順の5つ)の一番高い五行。同点は季節の五行を優先し、それでも決まらなければ 木・火・土・金・水 の順で先のもの
create function public._cc_pick(s integer[], p_season text) returns text
language plpgsql immutable set search_path = public as $$
declare els text[] := array['wood','fire','earth','metal','water']; mx integer; first_el text;
begin
  select max(x) into mx from unnest(s) x;
  for i in 1..5 loop
    if s[i] = mx then
      if els[i] = p_season then return els[i]; end if;
      if first_el is null then first_el := els[i]; end if;
    end if;
  end loop;
  return first_el;
end $$;

-- 15問の回答(0〜2)→ 五行ごとの点数・主なタイプ・バランス良好・季節の五行。回答の形が違えば null
create function public._cc_result(p_answers integer[], p_on date) returns jsonb
language plpgsql immutable set search_path = public as $$
declare s integer[] := array[0,0,0,0,0]; se text := public._season_element(p_on); k integer;
begin
  if p_answers is null or array_ndims(p_answers) is distinct from 1 or array_lower(p_answers, 1) <> 1 or array_length(p_answers, 1) <> 15
     or array_position(p_answers, null) is not null then return null; end if;
  for i in 1..15 loop
    if p_answers[i] not between 0 and 2 then return null; end if;
    k := (i - 1) / 3 + 1;                                     -- 1〜3問=木、4〜6問=火、7〜9問=土、10〜12問=金、13〜15問=水
    s[k] := s[k] + p_answers[i];
  end loop;
  return jsonb_build_object('scores', jsonb_build_object('wood', s[1], 'fire', s[2], 'earth', s[3], 'metal', s[4], 'water', s[5]),
    'primary', public._cc_pick(s, se), 'balanced', (select max(x) from unnest(s) x) <= 1, 'seasonElement', se);
end $$;

-- 今日の体調: 体質の点数に、選んだ五行の2点を足して、今日のおすすめの五行を決める
create function public._cc_focus(s integer[], p_temp text, p_energy text, p_concern text, p_on date) returns text
language plpgsql immutable set search_path = public as $$
declare t integer[] := s;
begin
  if p_temp = 'cold' then t[5] := t[5] + 2; elsif p_temp = 'hot' then t[2] := t[2] + 2; end if;
  if p_energy = 'tired' then t[3] := t[3] + 2; elsif p_energy = 'stress' then t[1] := t[1] + 2; end if;
  if p_concern = 'dry' then t[4] := t[4] + 2; elsif p_concern = 'swelling' then t[3] := t[3] + 2; end if;
  return public._cc_pick(t, public._season_element(p_on));
end $$;

-- 五巡茶の日替わり(日本時間の日付の曜日)。月曜・日曜は季節の五行
create function public._tea_of_day(d date) returns text
language sql immutable set search_path = public as $$
  select case extract(isodow from d)::int when 2 then 'fire' when 3 then 'water' when 4 then 'wood' when 5 then 'metal' when 6 then 'earth'
              else public._season_element(d) end
$$;

-- 会員証に出す体質チェックの情報(顧客本人にだけ返す)。最新の結果の要約・同意の有無・今日の体調・今日のお茶・あなたのお茶・季節
create function public._constitution_snapshot(p_member uuid, p_now timestamptz) returns jsonb
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

-- 102 の _member_view に体質チェックの情報を足す(app_me・チケットの関数の応答に入る)
create or replace function public._member_view(p_member uuid, p_now timestamptz) returns jsonb
language sql security definer set search_path = public as
  $$ select public._snapshot(p_member, p_now) || public._perk_snapshot(p_member, p_now) || public._constitution_snapshot(p_member, p_now) $$;

-- ---------- 顧客向け関数(Edge Function(service_role)からのみ) ----------
-- 体質チェックの送信。点数は受け取らず、回答から DB が計算する。初回は同意が必要
create function public.app_constitution_submit(p_issuer text, p_subject text, p_answers integer[], p_mood text, p_consent boolean default false, p_now timestamptz default now())
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

-- 今日の体調(日本時間の1日に1回)。体質チェックの結果がまだなければ記録しない
create function public.app_condition_submit(p_issuer text, p_subject text, p_temp text, p_energy text, p_concern text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; c public.constitution_checks; iss text := public._gate(p_issuer, p_subject); d date := public._jst_date(p_now); f text; k integer;
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  if p_temp is null or p_temp not in ('cold','hot','normal') or p_energy is null or p_energy not in ('tired','stress','fine')
     or p_concern is null or p_concern not in ('dry','swelling','none') then return jsonb_build_object('status', 'invalid_condition'); end if;
  select * into c from public.constitution_checks where member_id = m.id order by created_at desc, id desc limit 1;
  if not found then return jsonb_build_object('status', 'no_check', 'member', public._member_view(m.id, p_now)); end if;
  f := public._cc_focus(array[c.score_wood, c.score_fire, c.score_earth, c.score_metal, c.score_water], p_temp, p_energy, p_concern, d);
  insert into public.constitution_daily_conditions(member_id, on_date, check_id, temp, energy, concern, focus_element, created_at)
    values (m.id, d, c.id, p_temp, p_energy, p_concern, f, p_now) on conflict (member_id, on_date) do nothing;
  get diagnostics k = row_count;
  if k = 0 then return jsonb_build_object('status', 'already_answered', 'member', public._member_view(m.id, p_now)); end if;
  return jsonb_build_object('status', 'ok', 'focus', f, 'member', public._member_view(m.id, p_now));
end $$;

-- 薬日本堂の漢方相談への案内が押された(数えるだけ。1時間に30回を超えた分は数えない)
create function public.app_referral_click(p_issuer text, p_subject text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; iss text := public._gate(p_issuer, p_subject);
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id;
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  if not public._throttle('ccref:' || m.id, 30, 3600, p_now) then return jsonb_build_object('status', 'ok', 'recorded', false); end if;
  insert into public.constitution_referral_clicks(member_id, check_id, clicked_at)
    values (m.id, (select id from public.constitution_checks where member_id = m.id order by created_at desc, id desc limit 1), p_now);
  return jsonb_build_object('status', 'ok', 'recorded', true);
end $$;

-- ---------- スタッフ向け関数 ----------
-- 体質チェックの集計。いまの状態の会員だけ(test のときは試験会員のみ)。個人の結果は返さない。
--  全員(閲覧以上・店頭タブレットは不可): 今週(直近7日・日本時間・今日を含む)の体調の傾向。
--  店長・閲覧(本部)だけ: 実施人数・実施率・タイプ別人数・五行ごとの平均・再来店率と来店頻度・相談ボタンのクリック数。スタッフには返さない。
--  再来店率: 直近60日(日本時間・今日を含む)に来店記録が2日以上ある会員の割合(登録日の来店扱いも1日と数える)。来店頻度: 直近60日の来店記録の日数の平均。
--  タイプ別・平均・実施/未実施の区別は、会員ごとの最新の結果で数える。
create function public.staff_constitution_stats() returns jsonb
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

-- ---------- バックアップ/復元: 新しい表を加える(102 の export_backup / restore_backup に追加。他は同じ) ----------
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
    'staff_users',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.staff_users t),
    'audit_log',        (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from (select * from public.audit_log order by id desc limit 5000) t)));
end $$;

-- 103 より前のバックアップ(体質チェックの表がない)・102 より前のバックアップ(チケットの表もない)も復元できる(その場合は0件)
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t jsonb := p -> 'tables'; mx bigint; bad integer;
begin
  if (p ->> 'version') is distinct from '1' or t is null then raise exception 'invalid_backup' using errcode = '22023'; end if;
  if exists (select 1 from public.members) or exists (select 1 from public.point_ledger) or exists (select 1 from public.perk_tickets)
     or exists (select 1 from public.constitution_checks) then raise exception 'target_not_empty' using errcode = '55000'; end if;
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
alter table public.constitution_consents         enable row level security;
alter table public.constitution_checks           enable row level security;
alter table public.constitution_daily_conditions enable row level security;
alter table public.constitution_referral_clicks  enable row level security;

do $$
declare r record;
begin
  for r in select format('%I.%I', n.nspname, c.relname) as nm, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = any(array['constitution_consents','constitution_checks','constitution_daily_conditions','constitution_referral_clicks',
                                                                 'constitution_referral_clicks_id_seq']) loop
    if r.relkind = 'S' then execute format('revoke all on sequence %s from public, anon, authenticated, service_role', r.nm);
    else execute format('revoke all on table %s from public, anon, authenticated, service_role', r.nm); end if;
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_season_element','_cc_pick','_cc_result','_cc_focus','_tea_of_day','_constitution_snapshot',
                                                                 'app_constitution_submit','app_condition_submit','app_referral_click','staff_constitution_stats']) loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- service_role(Edge Function): 読み取りと追記だけ(更新・削除はしない)
grant select, insert on public.constitution_consents, public.constitution_checks, public.constitution_daily_conditions, public.constitution_referral_clicks to service_role;
grant usage, select on sequence public.constitution_referral_clicks_id_seq to service_role;
grant execute on function public.app_constitution_submit(text, text, integer[], text, boolean, timestamptz), public.app_condition_submit(text, text, text, text, text, timestamptz),
  public.app_referral_click(text, text, timestamptz) to service_role;
grant execute on function public.staff_constitution_stats() to authenticated;

commit;
