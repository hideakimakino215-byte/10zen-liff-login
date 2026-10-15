-- 10ZEN デジタル会員証 友だち紹介と月次レポート(2026-10-15 設計: REFERRAL_AND_REPORT_DESIGN_20261015.md)【本番未適用・ローカル検証のみ】
-- 前提: 100・101・102・103・104・105 が適用済み。取り消しは 106_referral_DOWN.sql。
-- 内容
--  * 招待コード(member_invite_codes): 会員ごとに1つ、推測できない12文字(英数字と - _)。会員番号は含めない。会員証を開いたときに作る。
--  * 紹介の記録(member_referrals): 招待のリンク(LIFF の URL に ?ref=コード)から登録した友だち1人=1行。登録の時点で、紹介者ごとに日本時間の暦月で
--    5人まで(app_settings の referral_monthly_cap)。6人目からは通常の登録(登録ボーナス 100pt のみ)で、紹介としては記録しない(監査ログに referral_over_cap)。
--    自分自身・停止中の会員・試験/本番の区分が違う会員のコードは無効(通常の登録)。
--  * 特典は友だちの「初来店」のとき(登録のときではない): 店頭QRでの来店記録(app_checkin。QR の検証を通ったもの)の最初の1回。
--    登録した日に店頭QRを読んだ場合(登録日の来店扱いで「付与済み」になる場合)も、店にいたことが確かめられるので初来店とする。
--    友だち: 特典チケット「お友だち紹介・ディナーの五巡茶 1杯」(発行から60日。102 のチケットと同じコードの使い方)。
--    紹介者: 同じチケット。ただし、そのときの紹介者のランクが AMBER 以上なら、チケットの代わりに 100pt(point_rules の referral_visit)。
--    特典は友だち1人につき1回だけ(member_referrals の行のロックと rewarded_at で保証)。
--  * チケットの名前は app_settings の dinner_tea_mode で変わる: cup=「ディナーの五巡茶 1杯」(運営変更の前・既定)/ free_flow=「ディナーの五巡茶 飲み放題」。
--    店長が manager_set_dinner_tea_mode で切り替えると、まだ使っていない紹介のチケットの名前も変わる(使用済みは当時の名前のまま)。
--  * お知らせ: LINE のプッシュはしない。紹介者が次に会員証を開いたとき、1回だけ「お友だちが来店しました。…」を出す
--    (app_me の inviteNotice。会員証が表示したあと app_invite_seen で既読にする。既読はサーバーに記録)。
--  * 旧ルールの廃止: 登録のときに紹介者・友だちの両方へ 100pt(point_rules の referral_referrer / referral_welcome)は、新しい登録では付けない。
--    過去の台帳は変えない。友だちの登録ボーナスは通常の 100pt(welcome)。
--  * 集計: staff_kpi_overview の各月の supporting に referralRegistrations(その月に紹介として登録した人数)と referralFirstVisits(初来店がその月の人数)を足す。
--    スタッフ画面の集計タブ用に staff_referral_stats。
--  * 月次レポート: report_monthly(p_month 'YYYY-MM')。service_role だけ。集計の数字だけ(氏名・会員番号・LINE ID は含めない)。
--  * 既存の customers / interactions / TOBIRA には触れない(紹介者の 100pt は既存の _mirror 経由。open かつ本番会員のときだけ)。
-- 置き換える既存の関数: app_register(100。引数 p_invite_code を足すため作り直し。権限は service_role だけを付け直す)、
--   app_checkin(100)・_member_view(103)・staff_kpi_overview(105)・export_backup / restore_backup(105)。create or replace のものは権限を引き継ぐ。
begin;

-- ---------- 設定・ルール ----------
insert into public.app_settings(key, value, note) values
  ('dinner_tea_mode', 'cup', 'ディナーの五巡茶の出し方(お友だち紹介のチケットの名前に使う)。cup=1杯(運営変更の前)/ free_flow=飲み放題(運営変更の後)。店長がスタッフ画面で切り替える'),
  ('referral_monthly_cap', '5', 'お友だち紹介: 紹介者1人が日本時間の暦月に紹介として受け付けられる登録の人数。超えた友だちは通常の登録(紹介の特典なし)')
on conflict (key) do nothing;
insert into public.point_rules(code, points, active, starts_on, ends_on, description) values
  ('referral_visit', 100, true, null, null, 'お友だち紹介(2026-10-15): 紹介した友だちの初来店のとき、紹介者が AMBER 以上ならチケットの代わりに付与')
on conflict (code) do nothing;

-- ---------- 特典チケットの種類に「紹介」を足す(102 の表の制約を広げる) ----------
alter table public.perk_ticket_types drop constraint perk_ticket_types_kind_check;
alter table public.perk_ticket_types add constraint perk_ticket_types_kind_check check (kind in ('milestone','seasonal','referral'));
alter table public.perk_ticket_types drop constraint perk_ticket_types_check;
alter table public.perk_ticket_types add constraint perk_ticket_types_check check ((kind = 'seasonal') = (valid_days is null));   -- 季節の豆花だけ有効日数なし(季節の終わりまで)
alter table public.perk_tickets drop constraint perk_tickets_kind_check;
alter table public.perk_tickets add constraint perk_tickets_kind_check check (kind in ('milestone','seasonal','referral'));
insert into public.perk_ticket_types(code, kind, rank_code, label, valid_days) values
  ('referral_tea', 'referral', 'white_opal', 'ディナーの五巡茶 1杯', 60);

-- ---------- 招待コード(会員ごとに1つ) ----------
create table public.member_invite_codes (
  member_id  uuid primary key references public.members(id) on delete restrict,
  code       text not null unique check (code ~ '^[A-Za-z0-9_-]{12}$'),
  created_at timestamptz not null default now()
);

-- ---------- 紹介の記録(友だち1人=1行) ----------
create table public.member_referrals (
  referred_member_id uuid primary key references public.members(id) on delete restrict,       -- 紹介された友だち(1人1回)
  referrer_member_id uuid not null references public.members(id) on delete restrict,           -- 紹介者
  invite_code        text not null,                                                            -- 使われたコード
  registered_at      timestamptz not null,
  registered_month   text not null check (registered_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),      -- 登録した月(日本時間)。上限の数え方に使う
  first_visit_on     date,                                                                     -- 初来店の日(日本時間)。特典を出した日
  rewarded_at        timestamptz,
  referred_ticket_id uuid unique references public.perk_tickets(id) on delete restrict,
  referrer_reward    text check (referrer_reward in ('ticket','points','none')),                -- none: 紹介者が停止中など
  referrer_ticket_id uuid unique references public.perk_tickets(id) on delete restrict,
  referrer_points    integer check (referrer_points is null or referrer_points > 0),
  referrer_ledger_id bigint unique references public.point_ledger(id),
  referrer_seen_at   timestamptz,                                                              -- 紹介者が会員証でお知らせを見た日時
  check (referred_member_id <> referrer_member_id),
  check ((rewarded_at is null) = (first_visit_on is null)),
  check ((rewarded_at is null) = (referrer_reward is null)),
  check (referrer_seen_at is null or rewarded_at is not null)
);
create index on public.member_referrals (referrer_member_id, registered_month);
create index on public.member_referrals (first_visit_on);

-- ---------- 内部関数 ----------
-- チケットに出す名前(dinner_tea_mode)
create function public._dinner_tea_label() returns text
language sql stable security definer set search_path = public as $$
  select case when (select value from public.app_settings where key = 'dinner_tea_mode') = 'free_flow' then 'ディナーの五巡茶 飲み放題' else 'ディナーの五巡茶 1杯' end
$$;

-- 招待コード(なければ作る)。乱数は gen_random_uuid(強い乱数)の先頭の完全にランダムな部分から 9バイト=72ビット
create function public._invite_code_for(p_member uuid) returns text
language plpgsql volatile security definer set search_path = public as $$
declare c text; tries integer := 0;
begin
  select code into c from public.member_invite_codes where member_id = p_member;
  if found then return c; end if;
  loop
    tries := tries + 1;
    c := translate(encode(substring(decode(replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for 6)
                       || substring(decode(replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for 3), 'base64'), '+/', '-_');
    begin
      insert into public.member_invite_codes(member_id, code, created_at) values (p_member, c, now()) on conflict (member_id) do nothing;
      select code into c from public.member_invite_codes where member_id = p_member;
      return c;
    exception when unique_violation then
      if tries > 10 then raise; end if;                                             -- コードの重なり(ほぼ起きない)は作り直す
    end;
  end loop;
end $$;

-- 会員証に出す紹介の情報(本人にだけ返す)。紹介者の情報(氏名・会員番号)は友だちに返さない
create function public._invite_snapshot(p_member uuid, p_now timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare m public.members; mk text := to_char(public._jst_date(p_now), 'YYYY-MM'); used integer; amber_min integer; my_min integer; r public.member_referrals; nt jsonb;
begin
  select * into m from public.members where id = p_member;
  if not found or m.status <> 'active' then return '{}'::jsonb; end if;
  select count(*) into used from public.member_referrals where referrer_member_id = m.id and registered_month = mk;
  select min_points into amber_min from public.rank_thresholds where rank_code = 'amber';
  select min_points into my_min from public.rank_thresholds where rank_code = m.rank_code;
  select * into r from public.member_referrals where referred_member_id = m.id;
  select case when count(*) = 0 then null else jsonb_build_object('friends', count(*), 'tickets', count(*) filter (where referrer_reward = 'ticket'),
           'points', coalesce(sum(referrer_points) filter (where referrer_reward = 'points'), 0), 'until', max(rewarded_at)) end
    into nt from public.member_referrals where referrer_member_id = m.id and rewarded_at is not null and referrer_seen_at is null and referrer_reward <> 'none';
  return jsonb_build_object(
    'invite', jsonb_build_object('code', public._invite_code_for(m.id), 'month', mk, 'monthCount', used, 'monthlyCap', public._setting_int('referral_monthly_cap', 5),
       'teaLabel', public._dinner_tea_label(), 'referrerReward', case when my_min >= amber_min then 'points' else 'ticket' end,
       'rewardPoints', coalesce(public._rule_points('referral_visit', public._jst_date(p_now)), 0),
       'referred', case when r.referred_member_id is null then null else jsonb_build_object('status', case when r.rewarded_at is null then 'waiting_first_visit' else 'rewarded' end) end),
    'inviteNotice', nt);
end $$;

-- 102・103 の _member_view に紹介の情報を足す(app_me・チケット・体質チェックの関数の応答に入る)
create or replace function public._member_view(p_member uuid, p_now timestamptz) returns jsonb
language sql security definer set search_path = public as
  $$ select public._snapshot(p_member, p_now) || public._perk_snapshot(p_member, p_now) || public._constitution_snapshot(p_member, p_now) || public._invite_snapshot(p_member, p_now) $$;

-- 初来店の特典(app_checkin から、来店する友だちの会員行のロックの内側で呼ぶ)。紹介の記録がない・特典を出し済みなら何もしない(null)。
-- ロックの順は「友だち → 紹介の行 → 紹介者」。紹介者は必ず友だちより先に登録しているので、逆向きの順は起きない(デッドロックしない)。
create function public._referral_reward(p_referred uuid, p_now timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare r public.member_referrals; ref public.members; ty public.perk_ticket_types; d date := public._jst_date(p_now); t1 uuid; t2 uuid; pts integer; lid bigint; kind text;
        amber_min integer; ref_min integer; exp timestamptz; ttl text;
begin
  select * into r from public.member_referrals where referred_member_id = p_referred for update;
  if not found or r.rewarded_at is not null then return null; end if;
  select * into ty from public.perk_ticket_types where code = 'referral_tea';
  ttl := 'お友だち紹介・' || public._dinner_tea_label();
  exp := ((d + coalesce(ty.valid_days, 60) + 1)::timestamp at time zone 'Asia/Tokyo');          -- 発行日から60日目の終わり(日本時間)まで(102 のお祝いと同じ)
  insert into public.perk_tickets(member_id, type_code, kind, title, issued_at, expires_at) values (p_referred, 'referral_tea', 'referral', ttl, p_now, exp) returning id into t1;
  select * into ref from public.members where id = r.referrer_member_id for update;
  if ref.status <> 'active' then kind := 'none';
  else
    select min_points into amber_min from public.rank_thresholds where rank_code = 'amber';
    select min_points into ref_min from public.rank_thresholds where rank_code = ref.rank_code;
    if ref_min >= amber_min then                                                                 -- AMBER 以上はディナーの五巡茶がもともと無料なので、チケットの代わりに 100pt
      pts := public._rule_points('referral_visit', d);
      if pts is not null then
        lid := public._grant(ref.id, 'earn', 'referral_visit', pts, 'referral_visit:' || p_referred, 'app', p_referred::text, p_now);
        kind := 'points';
      else kind := 'none'; end if;
    else
      insert into public.perk_tickets(member_id, type_code, kind, title, issued_at, expires_at) values (ref.id, 'referral_tea', 'referral', ttl, p_now, exp) returning id into t2;
      kind := 'ticket';
    end if;
  end if;
  update public.member_referrals set first_visit_on = d, rewarded_at = p_now, referred_ticket_id = t1, referrer_reward = kind, referrer_ticket_id = t2,
    referrer_points = case when kind = 'points' then pts end, referrer_ledger_id = lid
  where referred_member_id = p_referred;
  perform public._audit(null, 'referral_reward', p_referred, jsonb_build_object('referrer', ref.id, 'referrerReward', kind));
  if kind = 'points' then perform public._mirror(ref.id, null, null); end if;
  return jsonb_build_object('ticket', ttl, 'validThrough', (d + coalesce(ty.valid_days, 60))::text);
end $$;

-- 月の紹介の数(いまの状態の会員の区分。p_from〜p_to は日本時間の日付。両端を含む)
create function public._referral_month(p_tst boolean, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'referralRegistrations', (select count(*) from public.member_referrals r join public.members m on m.id = r.referred_member_id
                              where m.is_test = p_tst and public._jst_date(r.registered_at) between p_from and p_to),
    'referralFirstVisits',   (select count(*) from public.member_referrals r join public.members m on m.id = r.referred_member_id
                              where m.is_test = p_tst and r.first_visit_on between p_from and p_to))
$$;

-- 105 の _kpi_overview の結果の各月の supporting に、紹介の数を足す
create function public._kpi_with_referral(o jsonb, p_tst boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select o || jsonb_build_object('months', coalesce((
    select jsonb_agg(x.m || jsonb_build_object('supporting', coalesce(x.m -> 'supporting', '{}'::jsonb)
                       || public._referral_month(p_tst, (x.m ->> 'from')::date, (x.m ->> 'asOfDate')::date)) order by x.i)
    from jsonb_array_elements(o -> 'months') with ordinality x(m, i)), '[]'::jsonb))
$$;

-- ---------- 顧客向け関数(Edge Function(service_role)からのみ) ----------
-- 登録: 100 の app_register に招待コード(p_invite_code)を足し、旧ルール(登録のときに紹介者・友だちへ各 100pt)をやめる。
--  p_referrer_member_no は古い member-api との互換のために残すが、使わない(会員番号での紹介は受け付けない)。
drop function public.app_register(text, text, text, text, timestamptz);
create function public.app_register(p_issuer text, p_subject text, p_display_name text, p_referrer_member_no text default null, p_now timestamptz default now(),
                                    p_invite_code text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; mid uuid; nm text; ref public.members; on_date date := public._jst_date(p_now); pts integer; cp integer;
        iss text; tst boolean; inv text; ic text := nullif(btrim(coalesce(p_invite_code, '')), ''); used integer; mk text := to_char(public._jst_date(p_now), 'YYYY-MM');
begin
  if coalesce(p_issuer, '') = '' or coalesce(p_subject, '') = '' then raise exception 'invalid_identity' using errcode = '22023'; end if;
  iss := public._gate(p_issuer, p_subject); tst := iss <> p_issuer;
  perform pg_advisory_xact_lock(hashtextextended('reg:' || iss || ':' || p_subject, 0));
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if found then
    return jsonb_build_object('status', 'existing', 'member', public._member_view(ident.member_id, p_now));       -- すでに会員: 招待のリンクから開いても紹介にはならない
  end if;
  if not public._throttle('reg:' || iss || ':' || p_subject, 5, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  if not public._throttle('reg:*' || case when tst then 'test' else '' end, 100, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  nm := nullif(btrim(regexp_replace(coalesce(p_display_name, ''), '[[:cntrl:]]', '', 'g')), '');
  nm := left(nm, 40);
  insert into public.members(member_no, display_name, lifetime_base, is_test) values (case when tst then public.next_test_member_no() else public.next_member_no() end, nm, 0, tst) returning id into mid;
  insert into public.member_identities(member_id, provider, issuer, subject, verified_at) values (mid, 'line', iss, p_subject, p_now);
  -- 招待コード: 有効な会員(停止中でない・試験/本番の区分が同じ・自分以外)のコードだけ。紹介者ごとに日本時間の暦月で上限まで
  if ic is not null then
    if ic ~ '^[A-Za-z0-9_-]{12}$' then
      select r.* into ref from public.member_invite_codes c join public.members r on r.id = c.member_id
        where c.code = ic and r.status = 'active' and r.is_test = tst and r.id <> mid;
    end if;
    if ref.id is null then inv := 'invalid';
    else
      perform 1 from public.members where id = ref.id for update;                                 -- 同じ紹介者への同時の登録を直列化(上限を超えない)
      select count(*) into used from public.member_referrals where referrer_member_id = ref.id and registered_month = mk;
      if used >= public._setting_int('referral_monthly_cap', 5) then
        inv := 'over_cap';
        perform public._audit(null, 'referral_over_cap', ref.id, jsonb_build_object('month', mk));
      else
        insert into public.member_referrals(referred_member_id, referrer_member_id, invite_code, registered_at, registered_month) values (mid, ref.id, ic, p_now, mk);
        update public.members set referred_by = ref.id where id = mid;
        inv := 'linked';
      end if;
    end if;
  end if;
  -- 登録ボーナスは通常どおり(紹介でも増やさない)。旧ルールの referral_referrer / referral_welcome は使わない
  pts := public._rule_points('welcome', on_date);
  if pts is not null then perform public._grant(mid, 'earn', 'welcome', pts, 'welcome:' || mid, 'app', null, p_now); end if;
  cp := public._rule_points('campaign_welcome', on_date);
  if cp is not null then perform public._grant(mid, 'earn', 'campaign_welcome', cp, 'campaign:' || mid, 'app', null, p_now); end if;
  update public.members set last_activity_on = on_date where id = mid;
  if coalesce((select value from public.app_settings where key = 'register_counts_as_visit'), 'true') = 'true' then
    insert into public.visits(member_id, visit_on, source) values (mid, on_date, 'register') on conflict (member_id, visit_on) do nothing;
    perform public._mirror(mid, on_date, p_now);
  end if;
  return jsonb_build_object('status', 'created', 'member', public._member_view(mid, p_now), 'invite', inv);
end $$;

-- 来店記録: 100 の app_checkin に「紹介の初来店の特典」を足したもの(それ以外は同じ)。
--  店頭QRの検証を通った来店記録の最初の1回で特典を出す。登録した日の「付与済み」(registered_today)でも、QR を読んで店にいたことが確かめられるので出す。
create or replace function public.app_checkin(p_issuer text, p_subject text, p_token_slot bigint default null, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; d date := public._jst_date(p_now); pts integer; vid bigint; lid bigint; v public.visits; iss text := public._gate(p_issuer, p_subject);
        h numeric := extract(hour from p_now at time zone 'Asia/Tokyo') + extract(minute from p_now at time zone 'Asia/Tokyo') / 60; rw jsonb;
begin
  if h < public._setting_int('checkin_open_hour', 0) or h >= public._setting_int('checkin_close_hour', 24) then return jsonb_build_object('status', 'outside_hours'); end if;
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;     -- 会員ごとに直列化
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  select * into v from public.visits where member_id = m.id and visit_on = d;
  if found then
    rw := public._referral_reward(m.id, p_now);
    return jsonb_build_object('status', 'already_today', 'reason', case when v.source = 'register' then 'registered_today' else 'visited_today' end,
                              'granted', 0, 'referral', rw, 'member', public._snapshot(m.id, p_now));
  end if;
  pts := public._rule_points('visit', d);
  insert into public.visits(member_id, visit_on, token_slot) values (m.id, d, p_token_slot) returning id into vid;
  if pts is not null then
    lid := public._grant(m.id, 'earn', 'visit', pts, 'visit:' || m.id || ':' || d, 'store_qr', vid::text, p_now);
  end if;
  update public.members set last_activity_on = d where id = m.id;
  rw := public._referral_reward(m.id, p_now);
  perform public._mirror(m.id, d, p_now);
  return jsonb_build_object('status', 'counted', 'granted', coalesce(pts, 0), 'referral', rw, 'member', public._snapshot(m.id, p_now));
end $$;

-- 紹介のお知らせを見た(会員証が「お友だちが来店しました」を表示したあとに呼ぶ)。p_until までに特典を出した分を既読にする
create function public.app_invite_seen(p_issuer text, p_subject text, p_until timestamptz, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; iss text := public._gate(p_issuer, p_subject); k integer;
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id;
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  update public.member_referrals set referrer_seen_at = p_now
    where referrer_member_id = m.id and rewarded_at is not null and referrer_seen_at is null and rewarded_at <= coalesce(p_until, p_now);
  get diagnostics k = row_count;
  return jsonb_build_object('status', 'ok', 'marked', k);
end $$;

-- ---------- スタッフ向け関数 ----------
-- 紹介の集計(閲覧以上。店頭タブレットは拒否)。いまの状態の会員だけ(test のときは試験会員のみ)。個人の情報は返さない
create function public.staff_referral_stats() returns jsonb
language plpgsql security definer set search_path = public as $$
declare tst boolean := (public._state() = 'test'); d date := public._jst_date(now()); ms date := date_trunc('month', public._jst_date(now()))::date; res jsonb;
begin
  perform public._require_role('viewer');
  select jsonb_build_object('asOf', now(), 'month', to_char(ms, 'YYYY-MM'),
    'registrationsTotal', (select count(*) from public.member_referrals r join public.members m on m.id = r.referred_member_id where m.is_test = tst),
    'firstVisitsTotal',   (select count(*) from public.member_referrals r join public.members m on m.id = r.referred_member_id where m.is_test = tst and r.first_visit_on is not null),
    'waitingFirstVisit',  (select count(*) from public.member_referrals r join public.members m on m.id = r.referred_member_id where m.is_test = tst and r.first_visit_on is null),
    'overCapThisMonth',   (select count(*) from public.audit_log a join public.members m on m.id = a.target_member_id
                           where a.action = 'referral_over_cap' and m.is_test = tst and a.at >= (ms::timestamp at time zone 'Asia/Tokyo')),
    'dinnerTeaMode', coalesce((select value from public.app_settings where key = 'dinner_tea_mode'), 'cup'), 'ticketLabel', public._dinner_tea_label(),
    'monthlyCap', public._setting_int('referral_monthly_cap', 5), 'canEdit', public._staff_role() = 'manager')
    || public._referral_month(tst, ms, d) into res;
  return res;
end $$;

-- ディナーの五巡茶の出し方(cup / free_flow)。店長だけ。まだ使っていない紹介のチケットの名前も変える(使用済みは当時の名前のまま)
create function public.manager_set_dinner_tea_mode(p_mode text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old text; lbl text; k integer;
begin
  perform public._require_role('manager');
  if p_mode is null or p_mode not in ('cup', 'free_flow') then raise exception 'invalid_mode' using errcode = '22023'; end if;
  select value into old from public.app_settings where key = 'dinner_tea_mode' for update;
  update public.app_settings set value = p_mode where key = 'dinner_tea_mode';
  lbl := public._dinner_tea_label();
  update public.perk_ticket_types set label = lbl where code = 'referral_tea';
  update public.perk_tickets set title = 'お友だち紹介・' || lbl where type_code = 'referral_tea' and used_at is null and title <> 'お友だち紹介・' || lbl;
  get diagnostics k = row_count;
  perform public._audit(auth.uid(), 'dinner_tea_mode', null, jsonb_build_object('old', old, 'new', p_mode, 'retitled', k));
  return jsonb_build_object('status', 'ok', 'mode', p_mode, 'label', lbl, 'retitled', k);
end $$;

-- 106 より前の staff_kpi_overview(105)に、各月の紹介の数(supporting.referralRegistrations / referralFirstVisits)を足す
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

-- ---------- 月次レポート(service_role だけ。backup-export 関数の monthly_report から呼ぶ) ----------
-- p_month = 'YYYY-MM'(日本時間の暦月。終わった月だけ)。集計の数字だけを返す(氏名・会員番号・LINE ID・会員の ID は含めない)。
-- 本番開始日(kpi_settings)が未設定、または p_month が本番開始日の月より前なら skipped=true(メールを送らない)。
-- 会員の区分は staff の集計と同じ: いまの状態が test なら試験会員と試験用の客数、それ以外は本番(scope で示す)。
create function public.report_monthly(p_month text, p_now timestamptz default now()) returns jsonb
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

-- ---------- バックアップ/復元: 新しい表を加える(105 の export_backup / restore_backup に追加。他は同じ) ----------
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
    'member_invite_codes',   (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.member_id), '[]') from public.member_invite_codes t),
    'member_referrals',      (select coalesce(jsonb_agg(to_jsonb(t) order by t.registered_at, t.referred_member_id), '[]') from public.member_referrals t),
    'staff_users',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.staff_users t),
    'audit_log',        (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from (select * from public.audit_log order by id desc limit 5000) t)));
end $$;

-- 106 より前のバックアップ(紹介の表がない)も復元できる(その場合は0件。招待コードは会員証を開いたときに作り直される)
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t jsonb := p -> 'tables'; mx bigint; bad integer;
begin
  if (p ->> 'version') is distinct from '1' or t is null then raise exception 'invalid_backup' using errcode = '22023'; end if;
  if exists (select 1 from public.members) or exists (select 1 from public.point_ledger) or exists (select 1 from public.perk_tickets)
     or exists (select 1 from public.constitution_checks) or exists (select 1 from public.pos_daily_customers) or exists (select 1 from public.member_referrals)
     then raise exception 'target_not_empty' using errcode = '55000'; end if;
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
  insert into public.member_invite_codes select * from jsonb_populate_recordset(null::public.member_invite_codes, coalesce(t -> 'member_invite_codes', '[]'::jsonb));
  insert into public.member_referrals select * from jsonb_populate_recordset(null::public.member_referrals, coalesce(t -> 'member_referrals', '[]'::jsonb));
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
alter table public.member_invite_codes enable row level security;
alter table public.member_referrals    enable row level security;

do $$
declare r record;
begin
  for r in select format('%I.%I', n.nspname, c.relname) as nm from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = any(array['member_invite_codes','member_referrals']) loop
    execute format('revoke all on table %s from public, anon, authenticated, service_role', r.nm);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_dinner_tea_label','_invite_code_for','_invite_snapshot','_referral_reward','_referral_month','_kpi_with_referral',
                                                                 'app_register','app_invite_seen','staff_referral_stats','manager_set_dinner_tea_mode','report_monthly']) loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- service_role(Edge Function): 読み取りと追記・更新(削除はしない)
grant select, insert, update on public.member_invite_codes, public.member_referrals to service_role;
grant execute on function public.app_register(text, text, text, text, timestamptz, text), public.app_invite_seen(text, text, timestamptz, timestamptz),
  public.report_monthly(text, timestamptz) to service_role;
-- スタッフ向け: ログイン済み(authenticated)。関数内で権限を確認(集計=閲覧以上、変更=店長)
grant execute on function public.staff_referral_stats(), public.manager_set_dinner_tea_mode(text) to authenticated;

commit;
