-- 10ZEN デジタル会員証 フェーズ1(完成形) データ基盤 v2【本番未適用・ローカル検証済みのみ】
-- 方針
--  * 既存の customers / interactions(追客・TOBIRA 連携用)には一切触れない。体質チェック・会話内容は持ち込まない。
--  * 顧客は LINE の ID トークンで本人確認(Edge Function が検証。ここの関数は検証済みの issuer/subject だけを受け取る)。
--  * ポイントは追記専用の台帳。会員行の残高(balance)は同じトランザクション内で更新するキャッシュで、verify_balances() で台帳と照合できる。
--  * 付与・使用・来店・登録はすべて冪等(同じ取引は何度送っても1回)。残高は会員行のロックで直列化する。
--  * スタッフは Supabase Auth。表への直接アクセスは与えず、権限チェック付きの関数(RPC)だけを公開する。
--  * 将来の連携(ブティック・スクール・EC)は member_identities(provider/issuer/subject)と business_unit で受ける。今回は連携しない。
begin;

-- ---------- 設定・制度(値は既存 GAS の確定値。変更は行の更新で済む) ----------
create table public.app_settings (
  key   text primary key,
  value text not null,
  note  text
);
insert into public.app_settings(key, value, note) values
  ('redeem_unit',          '100', 'ポイント使用の単位(pt)。未確定: 既存GASは任意の値を受けていた。単位は業務判断待ち(暫定)'),
  ('redeem_ttl_seconds',   '180', 'ポイント使用リクエストの有効時間(秒)'),
  ('yen_per_100pt',        '10',  '100pt あたりの円(既存GAS: 100pt=10円)'),
  ('expiry_months',        '12',  '有効期限: 最終の来店・利用日からの月数(既存GAS: 1年。表示のみで自動失効は行わない)'),
  ('checkin_grace_slots',  '3',   '店頭QRの有効スロット数(1スロット=30秒)'),
  ('business_unit',        '10zen_aoyama', '事業単位(将来の連携用ラベル)'),
  ('register_counts_as_visit', 'true', '登録した日を来店日として扱い、同じ日の来店ポイントは付与しない(既存GASと同じ。登録ボーナスのみ)。false なら登録日にも来店ポイントを付与'),
  ('mirror_to_customers',  'true', '既存の customers(追客・リピート計測用)へ来店回数・ポイントを引き続き反映する。false で停止');

create table public.point_rules (
  code        text primary key,
  points      integer not null check (points > 0),
  active      boolean not null default true,
  starts_on   date,
  ends_on     date,
  description text not null
);
insert into public.point_rules(code, points, active, starts_on, ends_on, description) values
  ('welcome',          100, true,  null,         null,         '新規会員登録ボーナス(既存GAS: 100pt)'),
  ('visit',            100, true,  null,         null,         '来店ポイント(既存GAS: 1日1回 100pt)'),
  ('referral_referrer',100, true,  null,         null,         'お友達紹介: 紹介者(既存GAS: 100pt)。運用可否は業務判断待ち'),
  ('referral_welcome', 100, true,  null,         null,         'お友達紹介: 紹介された人(既存GAS: 100pt・通常の登録ボーナスの代わり)'),
  ('campaign_welcome', 100, true,  '2026-10-10', '2026-10-31', '本番開始記念キャンペーン(既存GAS: 期間内の新規登録に+100pt)。継続可否は業務判断待ち');

create table public.rank_thresholds (
  rank_code  text primary key,
  min_points integer not null unique check (min_points >= 0),
  label      text not null
);
insert into public.rank_thresholds(rank_code, min_points, label) values
  ('white_opal', 0,      'WHITE OPAL'),
  ('amber',      10000,  'AMBER'),
  ('emerald',    50000,  'EMERALD'),
  ('ruby',       100000, 'RUBY'),
  ('onyx',       200000, 'ONYX');

-- ---------- 会員 ----------
create sequence public.member_no_seq start 1;
create function public.next_member_no() returns text language sql as
  $$ select 'user' || lpad(nextval('public.member_no_seq')::text, 5, '0') $$;

create table public.members (
  id             uuid primary key default gen_random_uuid(),
  member_no      text not null unique,                          -- スタッフに提示できる表示用の会員番号
  display_name   text check (display_name is null or (char_length(display_name) between 1 and 40)),
  status         text not null default 'active' check (status in ('active','suspended','closed')),
  business_unit  text not null default '10zen_aoyama',
  balance        integer not null default 0 check (balance >= 0),   -- 台帳の合計と常に一致(同一トランザクションで更新)
  lifetime_base  integer check (lifetime_base is null or lifetime_base >= 0),  -- 確認済みの開始時の累計。null=未確認
  lifetime_floor integer not null default 0 check (lifetime_floor >= 0),     -- 開始時の累計の下限(= 取り込み時の残高。累計は残高以上であることは事実)。未確認の間の暫定
  lifetime_earned integer not null default 0 check (lifetime_earned >= 0),    -- このシステムで付与された累計
  rank_code      text not null default 'white_opal' references public.rank_thresholds(rank_code),
  last_activity_on date,                                       -- 最終の来店・利用日(JST)。有効期限の起点
  referred_by    uuid references public.members(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.member_identities (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.members(id) on delete restrict,
  provider    text not null check (provider in ('line','ec','store_pos','other')),
  issuer      text not null,
  subject     text not null,
  verified_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (provider, issuer, subject)
);
create index on public.member_identities (member_id);

-- ---------- 台帳(追記専用) ----------
create table public.point_ledger (
  id              bigint generated always as identity primary key,
  member_id       uuid not null references public.members(id) on delete restrict,
  entry_type      text not null check (entry_type in ('opening_balance','earn','redeem','adjust','expire')),
  rule_code       text,
  points          integer not null check (points <> 0 or entry_type = 'opening_balance'),
  balance_after   integer not null check (balance_after >= 0),
  idempotency_key text not null unique,
  source          text not null,
  source_ref      text,
  reason          text,
  business_unit   text not null default '10zen_aoyama',
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  created_by      uuid
);
create index on public.point_ledger (member_id, occurred_at, id);
create unique index point_ledger_one_opening on public.point_ledger (member_id) where entry_type = 'opening_balance';
create function public.point_ledger_immutable() returns trigger language plpgsql set search_path = public as
  $$ begin raise exception 'point_ledger is append-only'; end $$;
create trigger point_ledger_no_update before update or delete on public.point_ledger
  for each row execute function public.point_ledger_immutable();
create trigger point_ledger_no_truncate before truncate on public.point_ledger
  for each statement execute function public.point_ledger_immutable();

-- ---------- 来店 / ポイント使用リクエスト / スタッフ / 監査 / 制限 ----------
create table public.visits (
  id         bigint generated always as identity primary key,
  member_id  uuid not null references public.members(id) on delete restrict,
  visit_on   date not null,                                  -- JST の日付
  source     text not null default 'store_qr',
  token_slot bigint,                                         -- 使用した店頭QRのスロット(不正検知用)
  created_at timestamptz not null default now(),
  unique (member_id, visit_on)                               -- 1日1回を DB で保証
);
create index on public.visits (visit_on, token_slot);

create table public.redeem_requests (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.members(id) on delete restrict,
  points       integer not null check (points > 0),
  code         text not null check (code ~ '^[0-9]{6}$'),
  status       text not null default 'pending' check (status in ('pending','confirmed','cancelled','expired')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  confirmed_at timestamptz,
  confirmed_by uuid,
  ledger_id    bigint references public.point_ledger(id),
  note         text
);
create unique index redeem_pending_code   on public.redeem_requests (code)      where status = 'pending';
create unique index redeem_pending_member on public.redeem_requests (member_id) where status = 'pending';

create table public.staff_users (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role         text not null default 'viewer' check (role in ('viewer','staff','manager')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.audit_log (
  id               bigint generated always as identity primary key,
  staff_user_id    uuid,
  action           text not null,
  target_member_id uuid,
  meta             jsonb not null default '{}'::jsonb,
  at               timestamptz not null default now()
);
create index on public.audit_log (staff_user_id, action, at);

create table public.api_throttle (
  key          text not null,
  window_start timestamptz not null,
  n            integer not null default 0,
  primary key (key, window_start)
);

-- ---------- 内部関数(外部には公開しない) ----------
create function public._setting_int(p_key text, p_default integer) returns integer
language sql stable set search_path = public as
  $$ select coalesce((select value::integer from public.app_settings where key = p_key), p_default) $$;

create function public._jst_date(p_at timestamptz) returns date
language sql immutable as $$ select (p_at at time zone 'Asia/Tokyo')::date $$;

create function public.rank_for(p_points integer) returns text
language sql stable set search_path = public as
  $$ select rank_code from public.rank_thresholds where min_points <= greatest(coalesce(p_points, 0), 0) order by min_points desc limit 1 $$;

-- 有効な累計 = 既存GASと同じく max(累計, 現在残高)。開始時の累計が未確認なら lifetime_base=null: 取り込み時の残高(累計の下限)+その後の付与で暫定算出し、未確認と明示する(使用でランクが下がらない)
create function public._effective_lifetime(m public.members) returns integer
language sql immutable as
  $$ select greatest(coalesce(m.lifetime_base, m.lifetime_floor) + m.lifetime_earned, m.balance) $$;

create function public._throttle(p_key text, p_limit integer, p_window_seconds integer, p_now timestamptz default now()) returns boolean
language plpgsql security definer set search_path = public as $$
declare w timestamptz; c integer;
begin
  w := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
  insert into public.api_throttle(key, window_start, n) values (p_key, w, 1)
    on conflict (key, window_start) do update set n = public.api_throttle.n + 1
    returning n into c;
  if random() < 0.02 then delete from public.api_throttle where window_start < p_now - interval '2 days'; end if;
  return c <= p_limit;
end $$;

create function public._audit(p_staff uuid, p_action text, p_member uuid, p_meta jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public as
  $$ insert into public.audit_log(staff_user_id, action, target_member_id, meta) values (p_staff, left(p_action, 60), p_member, coalesce(p_meta, '{}'::jsonb)) $$;

-- 台帳への追記+残高・累計・ランクの更新(呼び出し側は会員行のロック内で呼ぶ)。同じ idempotency_key は何もしない(null を返す)。
create function public._grant(p_member uuid, p_type text, p_rule text, p_points integer, p_key text,
                              p_source text, p_ref text, p_at timestamptz, p_by uuid default null, p_reason text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare m public.members; lid bigint; nb integer;
begin
  select * into m from public.members where id = p_member for update;
  if not found then raise exception 'member_not_found'; end if;
  nb := m.balance + p_points;
  if nb < 0 then raise exception 'insufficient_balance' using errcode = '22023'; end if;
  insert into public.point_ledger(member_id, entry_type, rule_code, points, balance_after, idempotency_key, source, source_ref, reason, business_unit, occurred_at, created_by)
  values (p_member, p_type, p_rule, p_points, nb, p_key, p_source, p_ref, p_reason, m.business_unit, p_at, p_by)
  on conflict (idempotency_key) do nothing
  returning id into lid;
  if lid is null then return null; end if;
  update public.members set
    balance = nb,
    lifetime_earned = lifetime_earned + case when p_type = 'earn' then p_points else 0 end,
    updated_at = now()
  where id = p_member returning * into m;
  update public.members set rank_code = public.rank_for(public._effective_lifetime(m)) where id = p_member;
  return lid;
end $$;

-- ルール(有効期間内か)
create function public._rule_points(p_code text, p_on date) returns integer
language sql stable set search_path = public as $$
  select points from public.point_rules
  where code = p_code and active and (starts_on is null or starts_on <= p_on) and (ends_on is null or p_on <= ends_on)
$$;


-- 既存の customers(追客・リピート計測。TOBIRA の experiment_summary 等が visit_count を参照)へ反映する。
-- 来店は既存と同じイベントキー(visit:LINE ID:JST日)で record_membership_checkin を呼ぶので、切替日をまたいでも二重に数えない。
-- ポイントのみの変更は sync_membership_points。反映に失敗しても会員証側の処理は成功とし、失敗は監査ログ(mirror_failed)に残す。
create function public._mirror(p_member uuid, p_event_key_date date, p_event_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members; sub text; store uuid; ver bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; eff integer;
begin
  if coalesce((select value from public.app_settings where key = 'mirror_to_customers'), 'false') <> 'true' then return; end if;
  if to_regprocedure('public.record_membership_checkin(uuid,text,text,timestamptz,integer,text,integer,text,bigint)') is null
     or to_regprocedure('public.sync_membership_points(uuid,text,integer,bigint,text,integer,text,timestamptz)') is null then return; end if;
  select * into m from public.members where id = p_member;
  select subject into sub from public.member_identities where member_id = p_member and provider = 'line' order by created_at limit 1;
  if sub is null then return; end if;
  execute 'select id from public.stores where name = $1' into store using '10ZEN';
  if store is null then return; end if;
  eff := public._effective_lifetime(m);
  begin
    if p_event_key_date is not null then
      perform public.record_membership_checkin(store, sub, 'visit:' || sub || ':' || p_event_key_date, p_event_at, m.balance, m.rank_code, eff, m.member_no, ver);
    else
      perform public.sync_membership_points(store, sub, m.balance, ver, m.rank_code, eff, m.member_no, null);
    end if;
  exception when others then
    insert into public.audit_log(action, target_member_id, meta) values ('mirror_failed', p_member, jsonb_build_object('error', left(sqlerrm, 200)));
  end;
end $$;

-- 会員の表示用スナップショット(顧客本人にだけ返す。外部ID・内部IDは含めない)
create function public._snapshot(p_member uuid, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; eff integer; cur_min integer; nxt public.rank_thresholds; cur public.rank_thresholds; pr public.redeem_requests; lr public.redeem_requests;
        unit integer := public._setting_int('redeem_unit', 100); yen integer := public._setting_int('yen_per_100pt', 10);
        today date := public._jst_date(p_now); exp_months integer := public._setting_int('expiry_months', 12);
begin
  select * into m from public.members where id = p_member;
  eff := public._effective_lifetime(m);
  select * into cur from public.rank_thresholds where rank_code = m.rank_code;
  select * into nxt from public.rank_thresholds where min_points > eff order by min_points limit 1;
  select * into pr from public.redeem_requests where member_id = p_member and status = 'pending' and expires_at > p_now;
  select * into lr from public.redeem_requests where member_id = p_member and status <> 'pending' and created_at > now() - interval '1 hour' order by created_at desc limit 1;
  return jsonb_build_object(
    'memberNo', m.member_no,
    'displayName', m.display_name,
    'rank', m.rank_code, 'rankLabel', cur.label,
    'points', m.balance,
    'lifetimePoints', eff, 'lifetimeConfirmed', m.lifetime_base is not null,
    'nextRank', case when nxt.rank_code is null then null else jsonb_build_object(
        'rank', nxt.rank_code, 'label', nxt.label, 'targetPoints', nxt.min_points, 'remainingPoints', nxt.min_points - eff,
        'percent', least(100, floor(100.0 * (eff - cur.min_points) / nullif(nxt.min_points - cur.min_points, 0))::int)) end,
    'expiresOn', case when m.last_activity_on is null then null else ((m.last_activity_on + make_interval(months => exp_months))::date)::text end,
    'visitedToday', exists (select 1 from public.visits v where v.member_id = p_member and v.visit_on = today),
    'yenPer100pt', yen, 'redeemUnit', unit,
    'pendingRedeem', case when pr.id is null then null else jsonb_build_object('points', pr.points, 'yen', pr.points * yen / 100, 'code', pr.code, 'expiresAt', pr.expires_at) end,
    -- 直近1時間の使用申請の結果(確定=スタッフが確定した/取消/期限切れ)。画面が「使用完了」を知らせるために使う
    'lastRedeem', case when lr.id is null then null else jsonb_build_object('status', lr.status, 'points', lr.points, 'yen', lr.points * yen / 100, 'at', coalesce(lr.confirmed_at, lr.created_at)) end
  );
end $$;

-- ---------- 顧客向け関数(Edge Function(service_role)からのみ。検証済みの issuer/subject を受け取る) ----------
create function public.app_register(p_issuer text, p_subject text, p_display_name text, p_referrer_member_no text default null, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; mid uuid; nm text; ref public.members; on_date date := public._jst_date(p_now); pts integer; rp integer; cp integer; created boolean := false;
begin
  if coalesce(p_issuer, '') = '' or coalesce(p_subject, '') = '' then raise exception 'invalid_identity' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('reg:' || p_issuer || ':' || p_subject, 0));
  select * into ident from public.member_identities where provider = 'line' and issuer = p_issuer and subject = p_subject;
  if found then
    return jsonb_build_object('status', 'existing', 'member', public._snapshot(ident.member_id, p_now));
  end if;
  if not public._throttle('reg:' || p_issuer || ':' || p_subject, 5, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  -- 全体の新規登録にも上限(スクリプトによる大量登録の抑止。店舗の規模では1時間100人を超えない前提。超えたら 429 になり、スタッフが気づける)
  if not public._throttle('reg:*', 100, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  nm := nullif(btrim(regexp_replace(coalesce(p_display_name, ''), '[[:cntrl:]]', '', 'g')), '');
  nm := left(nm, 40);
  insert into public.members(member_no, display_name, lifetime_base) values (public.next_member_no(), nm, 0) returning id into mid;   -- 新規会員の累計は 0 から確定(開始時の不明はない)
  insert into public.member_identities(member_id, provider, issuer, subject, verified_at) values (mid, 'line', p_issuer, p_subject, p_now);
  created := true;
  -- 紹介(有効な会員番号のみ。自分自身は不可能: まだ会員番号を持たない)
  if coalesce(btrim(p_referrer_member_no), '') <> '' then
    select * into ref from public.members where lower(member_no) = lower(btrim(p_referrer_member_no)) and status = 'active' and id <> mid;
  end if;
  if ref.id is not null then
    rp := public._rule_points('referral_referrer', on_date);
    pts := public._rule_points('referral_welcome', on_date);
    if rp is not null and pts is not null then
      update public.members set referred_by = ref.id where id = mid;
      perform public._grant(ref.id, 'earn', 'referral_referrer', rp, 'referral:' || ref.id || ':' || mid, 'app', mid::text, p_now);
      perform public._grant(mid, 'earn', 'referral_welcome', pts, 'referral_welcome:' || mid, 'app', ref.id::text, p_now);
      perform public._mirror(ref.id, null, null);
    else ref := null; end if;
  end if;
  if ref.id is null then
    pts := public._rule_points('welcome', on_date);
    if pts is not null then perform public._grant(mid, 'earn', 'welcome', pts, 'welcome:' || mid, 'app', null, p_now); end if;
  end if;
  cp := public._rule_points('campaign_welcome', on_date);
  if cp is not null then perform public._grant(mid, 'earn', 'campaign_welcome', cp, 'campaign:' || mid, 'app', null, p_now); end if;
  update public.members set last_activity_on = on_date where id = mid;
  -- 既存GASと同じく、登録した日は来店日として扱う(同じ日の来店ポイントは付かない)。設定 register_counts_as_visit=false で解除
  if coalesce((select value from public.app_settings where key = 'register_counts_as_visit'), 'true') = 'true' then
    insert into public.visits(member_id, visit_on, source) values (mid, on_date, 'register') on conflict (member_id, visit_on) do nothing;
  end if;
  perform public._mirror(mid, on_date, p_now);
  return jsonb_build_object('status', 'created', 'member', public._snapshot(mid, p_now));
end $$;

create function public.app_me(p_issuer text, p_subject text, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members;
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = p_issuer and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id;
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  update public.redeem_requests set status = 'expired' where member_id = m.id and status = 'pending' and expires_at <= p_now;
  return jsonb_build_object('status', 'ok', 'member', public._snapshot(m.id, p_now));
end $$;

-- 来店記録(店頭QRのトークン検証は Edge Function 側。ここは 1日1回の付与を DB で保証)
create function public.app_checkin(p_issuer text, p_subject text, p_token_slot bigint default null, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; d date := public._jst_date(p_now); pts integer; vid bigint; lid bigint; v public.visits;
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = p_issuer and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;     -- 会員ごとに直列化
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  select * into v from public.visits where member_id = m.id and visit_on = d;
  if found then
    return jsonb_build_object('status', 'already_today', 'reason', case when v.source = 'register' then 'registered_today' else 'visited_today' end,
                              'granted', 0, 'member', public._snapshot(m.id, p_now));
  end if;
  pts := public._rule_points('visit', d);
  insert into public.visits(member_id, visit_on, token_slot) values (m.id, d, p_token_slot) returning id into vid;
  if pts is not null then
    lid := public._grant(m.id, 'earn', 'visit', pts, 'visit:' || m.id || ':' || d, 'store_qr', vid::text, p_now);
  end if;
  update public.members set last_activity_on = d where id = m.id;
  perform public._mirror(m.id, d, p_now);
  return jsonb_build_object('status', 'counted', 'granted', coalesce(pts, 0), 'member', public._snapshot(m.id, p_now));
end $$;

-- ポイント使用の申請(お客様の画面から)。6桁コードを発行し、スタッフが確認・確定する。
create function public.app_redeem_request(p_issuer text, p_subject text, p_points integer, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; unit integer := public._setting_int('redeem_unit', 100); ttl integer := public._setting_int('redeem_ttl_seconds', 180);
        r public.redeem_requests; c text; tries integer := 0;
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = p_issuer and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  if p_points is null or p_points <= 0 or p_points % unit <> 0 then return jsonb_build_object('status', 'invalid_amount', 'unit', unit); end if;
  update public.redeem_requests set status = 'expired' where member_id = m.id and status = 'pending' and expires_at <= p_now;
  select * into r from public.redeem_requests where member_id = m.id and status = 'pending';
  if found then
    if r.points = p_points then return jsonb_build_object('status', 'pending', 'member', public._snapshot(m.id, p_now)); end if;
    return jsonb_build_object('status', 'already_pending', 'member', public._snapshot(m.id, p_now));
  end if;
  if not public._throttle('redeem:' || m.id, 10, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  if m.balance < p_points then return jsonb_build_object('status', 'insufficient_balance', 'points', m.balance); end if;
  loop
    tries := tries + 1;
    c := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into public.redeem_requests(member_id, points, code, expires_at) values (m.id, p_points, c, p_now + make_interval(secs => ttl)) returning * into r;
      exit;
    exception when unique_violation then
      if tries > 20 then raise exception 'code_unavailable'; end if;
    end;
  end loop;
  return jsonb_build_object('status', 'pending', 'member', public._snapshot(m.id, p_now));
end $$;

create function public.app_redeem_cancel(p_issuer text, p_subject text, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; n integer;
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = p_issuer and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;
  update public.redeem_requests set status = 'cancelled', note = 'customer_cancel' where member_id = m.id and status = 'pending';
  get diagnostics n = row_count;
  return jsonb_build_object('status', case when n > 0 then 'cancelled' else 'nothing_pending' end, 'member', public._snapshot(m.id, p_now));
end $$;

-- ---------- 開始残高の取り込み(移行用。service_role/SQL からのみ。冪等) ----------
create function public.import_opening_balance(p_member_no text, p_display_name text, p_issuer text, p_subject text, p_balance integer,
                                              p_lifetime_base integer, p_last_activity_on date, p_source_ref text, p_created_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare mid uuid; ident public.member_identities; existing uuid;
begin
  if p_balance < 0 then raise exception 'invalid_balance' using errcode = '22023'; end if;
  select id into existing from public.members where member_no = p_member_no;
  if existing is not null then
    if exists (select 1 from public.point_ledger where member_id = existing and entry_type = 'opening_balance') then
      return jsonb_build_object('status', 'already_imported', 'member_no', p_member_no);
    end if;
    mid := existing;
  else
    insert into public.members(member_no, display_name, created_at) values (p_member_no, nullif(left(p_display_name, 40), ''), p_created_at) returning id into mid;
  end if;
  if p_subject is not null and p_subject <> '' then
    insert into public.member_identities(member_id, provider, issuer, subject, verified_at)
      values (mid, 'line', p_issuer, p_subject, null) on conflict (provider, issuer, subject) do nothing;
    select * into ident from public.member_identities where provider = 'line' and issuer = p_issuer and subject = p_subject;
    if ident.member_id <> mid then raise exception 'identity_belongs_to_other_member' using errcode = '22023'; end if;
  end if;
  update public.members set lifetime_base = p_lifetime_base, lifetime_floor = p_balance, last_activity_on = p_last_activity_on where id = mid;
  -- 既存システムの『最終来店・利用日』を来店済みとして記録する(切替日に同じ日の来店ポイントを二重に付けないため。既存GASも最終来店日で判定していた)
  if p_last_activity_on is not null then
    insert into public.visits(member_id, visit_on, source) values (mid, p_last_activity_on, 'legacy') on conflict (member_id, visit_on) do nothing;
  end if;
  -- 開始残高: 出所と基準日時を残す(存在しない過去履歴は作らない)
  insert into public.point_ledger(member_id, entry_type, points, balance_after, idempotency_key, source, source_ref, occurred_at)
    values (mid, 'opening_balance', p_balance, p_balance, 'opening:' || p_member_no, 'legacy_sheet', p_source_ref, p_created_at);
  update public.members set balance = p_balance where id = mid;
  update public.members m set rank_code = public.rank_for(public._effective_lifetime(m)) where id = mid;
  -- 連番は取り込んだ会員番号(userNNNNN)より後から
  if p_member_no ~ '^user[0-9]+$' then
    perform setval('public.member_no_seq', greatest((select last_value from public.member_no_seq), substr(p_member_no, 5)::bigint));
  end if;
  return jsonb_build_object('status', 'imported', 'member_no', p_member_no);
end $$;

-- 累計(開始時点)の確定。業務判断で値が決まったときだけ使う(service_role/SQL)。開始残高以上であること、1回だけ(確定済みは変更しない)
create function public.confirm_lifetime_base(p_member_no text, p_value integer, p_source_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; ob integer;
begin
  select * into m from public.members where member_no = p_member_no for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if m.lifetime_base is not null then return jsonb_build_object('status', 'already_confirmed'); end if;
  select points into ob from public.point_ledger where member_id = m.id and entry_type = 'opening_balance';
  if p_value is null or p_value < coalesce(ob, 0) then raise exception 'lifetime_below_opening_balance' using errcode = '22023'; end if;
  update public.members set lifetime_base = p_value where id = m.id returning * into m;
  update public.members set rank_code = public.rank_for(public._effective_lifetime(m)) where id = m.id;
  perform public._audit(null, 'confirm_lifetime', m.id, jsonb_build_object('value', p_value, 'source', left(coalesce(p_source_ref, ''), 100)));
  return jsonb_build_object('status', 'confirmed');
end $$;

-- 残高・累計の整合確認(台帳の合計=会員行の残高)。差があれば行を返す
create function public.verify_balances() returns table(member_no text, cached integer, ledger integer, earned_cached integer, earned_ledger integer)
language sql security definer set search_path = public as $$
  select m.member_no, m.balance, coalesce(s.total, 0)::int, m.lifetime_earned, coalesce(s.earned, 0)::int
  from public.members m
  left join lateral (select sum(points) total, sum(points) filter (where entry_type = 'earn') earned from public.point_ledger l where l.member_id = m.id) s on true
  where m.balance <> coalesce(s.total, 0) or m.lifetime_earned <> coalesce(s.earned, 0)
$$;

-- ---------- スタッフ向け関数(Supabase Auth のログインが必要。権限は関数の中で確認) ----------
create function public._staff_role() returns text
language sql stable security definer set search_path = public as
  $$ select role from public.staff_users where user_id = auth.uid() and active $$;

create function public._require_role(p_min text) returns void
language plpgsql stable security definer set search_path = public as $$
declare r text := public._staff_role(); rank_of jsonb := '{"viewer":1,"staff":2,"manager":3}';
begin
  if r is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if (rank_of ->> r)::int < (rank_of ->> p_min)::int then raise exception 'forbidden' using errcode = '42501'; end if;
end $$;

create function public.staff_whoami() returns jsonb
language sql stable security definer set search_path = public as
  $$ select case when public._staff_role() is null then jsonb_build_object('active', false)
        else (select jsonb_build_object('active', true, 'role', role, 'displayName', display_name) from public.staff_users where user_id = auth.uid()) end $$;

create function public.staff_dashboard() returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := public._jst_date(now()); ms timestamptz := date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
begin
  perform public._require_role('viewer');
  return jsonb_build_object(
    'asOf', now(),
    'membersActive', (select count(*) from public.members where status = 'active'),
    'visitsToday', (select count(*) from public.visits where visit_on = d),
    'pointsIssuedThisMonth', (select coalesce(sum(points), 0) from public.point_ledger where entry_type = 'earn' and occurred_at >= ms),
    'pointsRedeemedThisMonth', (select coalesce(-sum(points), 0) from public.point_ledger where entry_type = 'redeem' and occurred_at >= ms),
    'pendingRedeems', (select count(*) from public.redeem_requests where status = 'pending' and expires_at > now()));
end $$;

create function public.staff_list_members(p_query text default null, p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_query, '')), ''); lim integer := least(greatest(coalesce(p_limit, 50), 1), 100); res jsonb; total integer;
begin
  perform public._require_role('viewer');
  select count(*) into total from public.members m where q is null or m.member_no ilike '%' || q || '%' or m.display_name ilike '%' || q || '%';
  select coalesce(jsonb_agg(x order by x ->> 'memberNo'), '[]'::jsonb) into res from (
    select jsonb_build_object('id', m.id, 'memberNo', m.member_no, 'displayName', m.display_name, 'rank', m.rank_code, 'points', m.balance, 'status', m.status,
                              'lastActivityOn', m.last_activity_on) x
    from public.members m where q is null or m.member_no ilike '%' || q || '%' or m.display_name ilike '%' || q || '%'
    order by m.member_no limit lim offset greatest(coalesce(p_offset, 0), 0)) t;
  perform public._audit(auth.uid(), 'list_members', null, jsonb_build_object('hasQuery', q is not null));
  return jsonb_build_object('total', total, 'items', res);
end $$;

create function public.staff_member_detail(p_member_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; eff integer;
begin
  perform public._require_role('viewer');
  select * into m from public.members where id = p_member_id;
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

create function public.staff_today_visits() returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := public._jst_date(now());
begin
  perform public._require_role('viewer');
  return jsonb_build_object('date', d,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('memberNo', m.member_no, 'displayName', m.display_name, 'at', v.created_at, 'slot', v.token_slot) order by v.created_at desc), '[]'::jsonb)
              from public.visits v join public.members m on m.id = v.member_id where v.visit_on = d),
    -- 不正検知: 同じ30秒スロットに多数が来店記録している(店内に収まらない・QRの写真の拡散の疑い)
    'suspiciousSlots', (select coalesce(jsonb_agg(jsonb_build_object('slot', s.token_slot, 'count', s.c)), '[]'::jsonb)
                        from (select token_slot, count(*) c from public.visits where visit_on = d and token_slot is not null group by token_slot having count(*) >= 6) s));
end $$;

-- ポイント使用: スタッフが6桁コードを入力 → 内容確認 → 確定
create function public.staff_lookup_redeem(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.redeem_requests; m public.members; yen integer := public._setting_int('yen_per_100pt', 10); misses integer;
begin
  perform public._require_role('staff');
  select count(*) into misses from public.audit_log where staff_user_id = auth.uid() and action = 'redeem_lookup_miss' and at > now() - interval '10 minutes';
  if misses >= 10 then raise exception 'too_many_attempts' using errcode = '42501'; end if;
  select * into r from public.redeem_requests where code = btrim(coalesce(p_code, '')) and status = 'pending';
  if not found or r.expires_at <= now() then
    perform public._audit(auth.uid(), 'redeem_lookup_miss', null);
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into m from public.members where id = r.member_id;
  perform public._audit(auth.uid(), 'redeem_lookup', m.id, jsonb_build_object('request', r.id));
  return jsonb_build_object('status', 'ok', 'request', jsonb_build_object('id', r.id, 'points', r.points, 'yen', r.points * yen / 100, 'expiresAt', r.expires_at),
    'member', jsonb_build_object('memberNo', m.member_no, 'displayName', m.display_name, 'rank', m.rank_code, 'points', m.balance));
end $$;

create function public.staff_confirm_redeem(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.redeem_requests; m public.members; lid bigint; yen integer := public._setting_int('yen_per_100pt', 10);
begin
  perform public._require_role('staff');
  select * into r from public.redeem_requests where id = p_request_id for update;          -- 同じ申請の同時確定を直列化
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.status = 'confirmed' then return jsonb_build_object('status', 'already_confirmed', 'points', r.points, 'yen', r.points * yen / 100); end if;
  if r.status <> 'pending' then return jsonb_build_object('status', r.status); end if;
  if r.expires_at <= now() then
    update public.redeem_requests set status = 'expired' where id = r.id;
    return jsonb_build_object('status', 'expired');
  end if;
  select * into m from public.members where id = r.member_id for update;
  if m.balance < r.points then
    return jsonb_build_object('status', 'insufficient_balance', 'points', m.balance);
  end if;
  lid := public._grant(m.id, 'redeem', 'redeem', -r.points, 'redeem:' || r.id, 'staff_confirm', r.id::text, now(), auth.uid());
  update public.redeem_requests set status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid(), ledger_id = lid where id = r.id;
  update public.members set last_activity_on = public._jst_date(now()) where id = m.id;
  perform public._audit(auth.uid(), 'redeem_confirm', m.id, jsonb_build_object('request', r.id, 'points', r.points));
  perform public._mirror(m.id, null, null);
  return jsonb_build_object('status', 'confirmed', 'points', r.points, 'yen', r.points * yen / 100, 'balanceAfter', m.balance - r.points);
end $$;

create function public.staff_cancel_redeem(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.redeem_requests;
begin
  perform public._require_role('staff');
  select * into r from public.redeem_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.status <> 'pending' then return jsonb_build_object('status', r.status); end if;
  update public.redeem_requests set status = 'cancelled', note = 'staff_cancel' where id = r.id;
  perform public._audit(auth.uid(), 'redeem_cancel', r.member_id, jsonb_build_object('request', r.id));
  return jsonb_build_object('status', 'cancelled');
end $$;

-- 店長のみ: 手動調整(理由必須・冪等・残高マイナス不可)と、使用の取消(戻し)
create function public.manager_adjust(p_member_id uuid, p_points integer, p_reason text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; lid bigint;
begin
  perform public._require_role('manager');
  if coalesce(btrim(p_reason), '') = '' or char_length(p_reason) > 200 then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_points is null or p_points = 0 or abs(p_points) > 1000000 then raise exception 'invalid_points' using errcode = '22023'; end if;
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9:_-]{8,100}$' then raise exception 'invalid_key' using errcode = '22023'; end if;
  select * into m from public.members where id = p_member_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if m.balance + p_points < 0 then return jsonb_build_object('status', 'insufficient_balance', 'points', m.balance); end if;
  lid := public._grant(m.id, 'adjust', 'manual', p_points, 'adjust:' || p_idempotency_key, 'manager', null, now(), auth.uid(), btrim(p_reason));
  perform public._audit(auth.uid(), 'adjust', m.id, jsonb_build_object('points', p_points, 'reason', left(btrim(p_reason), 200), 'duplicate', lid is null));
  perform public._mirror(m.id, null, null);
  return jsonb_build_object('status', case when lid is null then 'duplicate' else 'ok' end);
end $$;

create function public.manager_reverse_redeem(p_request_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.redeem_requests; lid bigint;
begin
  perform public._require_role('manager');
  if coalesce(btrim(p_reason), '') = '' or char_length(p_reason) > 200 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into r from public.redeem_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.status <> 'confirmed' then return jsonb_build_object('status', 'not_confirmed'); end if;
  lid := public._grant(r.member_id, 'adjust', 'reverse_redeem', r.points, 'reverse:' || r.id, 'manager', r.id::text, now(), auth.uid(), btrim(p_reason));
  perform public._audit(auth.uid(), 'reverse_redeem', r.member_id, jsonb_build_object('request', r.id, 'points', r.points, 'duplicate', lid is null));
  perform public._mirror(r.member_id, null, null);
  return jsonb_build_object('status', case when lid is null then 'already_reversed' else 'reversed' end);
end $$;

-- ---------- 権限(anon には何も与えない。表への直接アクセスも与えない) ----------
-- 重要: このマイグレーションで作った物だけを対象にする(既存の customers / interactions / 関数などの権限は一切変えない)。
alter table public.app_settings      enable row level security;
alter table public.point_rules       enable row level security;
alter table public.rank_thresholds   enable row level security;
alter table public.members           enable row level security;
alter table public.member_identities enable row level security;
alter table public.point_ledger      enable row level security;
alter table public.visits            enable row level security;
alter table public.redeem_requests   enable row level security;
alter table public.staff_users       enable row level security;
alter table public.audit_log         enable row level security;
alter table public.api_throttle      enable row level security;

do $$
declare r record;
begin
  -- 新しい表・連番: 既定で付く権限を一度外す(service_role を含む)。必要なものだけ後で付与する
  for r in select format('%I.%I', n.nspname, c.relname) as nm, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = any(array['app_settings','point_rules','rank_thresholds','members','member_identities','point_ledger','visits','redeem_requests','staff_users','audit_log','api_throttle', 'member_no_seq', 'point_ledger_id_seq', 'visits_id_seq', 'audit_log_id_seq']) loop
    if r.relkind = 'S' then execute format('revoke all on sequence %s from public, anon, authenticated, service_role', r.nm);
    else execute format('revoke all on table %s from public, anon, authenticated, service_role', r.nm); end if;
  end loop;
  -- 新しい関数: 既定の実行権限を外す(既存の関数には触れない)
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_audit','_effective_lifetime','_grant','_jst_date','_require_role','_rule_points','_setting_int','_snapshot','_staff_role','_throttle','app_checkin','app_me','app_redeem_cancel','app_redeem_request','app_register','confirm_lifetime_base','import_opening_balance','manager_adjust','manager_reverse_redeem','next_member_no','point_ledger_immutable','rank_for','staff_cancel_redeem','staff_confirm_redeem','staff_dashboard','staff_list_members','staff_lookup_redeem','staff_member_detail','staff_today_visits','staff_whoami','verify_balances']) loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- 制度の値の読み取り(スタッフのみ)
grant select on public.app_settings, public.point_rules, public.rank_thresholds to authenticated;
create policy settings_read on public.app_settings    for select to authenticated using (public._staff_role() is not null);
create policy rules_read    on public.point_rules     for select to authenticated using (public._staff_role() is not null);
create policy ranks_read    on public.rank_thresholds for select to authenticated using (public._staff_role() is not null);
-- service_role(Edge Function): 台帳・監査ログは追記のみ。削除・更新・全消去はできない(復旧作業でも)
grant select, insert, update on public.members, public.member_identities, public.visits, public.redeem_requests, public.staff_users, public.api_throttle to service_role;
grant select, insert on public.point_ledger, public.audit_log to service_role;
grant select, insert, update on public.app_settings, public.point_rules, public.rank_thresholds to service_role;
grant usage, select on sequence public.member_no_seq, public.point_ledger_id_seq, public.visits_id_seq, public.audit_log_id_seq to service_role;

-- 顧客向け・移行用・点検用: service_role のみ
grant execute on function public.app_register(text, text, text, text, timestamptz), public.app_me(text, text, timestamptz),
  public.app_checkin(text, text, bigint, timestamptz), public.app_redeem_request(text, text, integer, timestamptz),
  public.app_redeem_cancel(text, text, timestamptz), public.import_opening_balance(text, text, text, text, integer, integer, date, text, timestamptz),
  public.verify_balances(), public.confirm_lifetime_base(text, integer, text), public.rank_for(integer), public.next_member_no() to service_role;
-- スタッフ向け: ログイン済み(authenticated)。関数内でスタッフ権限を確認
grant execute on function public.staff_whoami(), public.staff_dashboard(), public.staff_list_members(text, integer, integer), public.staff_member_detail(uuid),
  public.staff_today_visits(), public.staff_lookup_redeem(text), public.staff_confirm_redeem(uuid), public.staff_cancel_redeem(uuid),
  public.manager_adjust(uuid, integer, text, text), public.manager_reverse_redeem(uuid, text), public._staff_role() to authenticated;

commit;
