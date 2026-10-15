-- 10ZEN デジタル会員証 ランク特典(2026-10-15 設計: RANK_PERKS_DESIGN_20261015.md)【本番未適用・ローカル検証のみ】
-- 前提: 100_phase1_schema.sql と 101_search_path_fix.sql が適用済み。取り消しは 102_rank_perks_DOWN.sql。
-- 内容
--  * ランクの基準を引き下げる(0 / 1,000 / 3,000 / 6,000 / 10,000)。会員のランクは累計で付け直す(基準は下がるだけなので、ランクは上がるだけ)。
--  * 特典チケット(1回で終わる特典): 到達のお祝い(AMBER=豆花、EMERALD・RUBY・ONYX=持ち帰り用のお茶。発行から60日)と、
--    EMERALD 以上の季節の豆花(春3〜5月・夏6〜8月・秋9〜11月・冬12〜2月。日本時間。その季節の終わりまで。会員×季節で1枚)。
--  * チケットは定期実行ではなく、会員証を開いたとき(app_me)に発行する。
--  * 使い方はポイント使用と同じコード方式: 会員証で「使う」→6桁のコード(有効時間は redeem_ttl_seconds と同じ)→スタッフ画面の同じ入力欄で確定。
--    ポイントのコードかチケットのコードかは DB(staff_lookup_code)が見分ける。2種類の申請で同じコードが同時に有効にならないようにする。
--  * 既存の customers / interactions / TOBIRA には触れない(ランクの付け直しの反映は既存の _mirror 経由。open かつ本番会員のときだけ)。
-- 置き換える既存の関数(すべて 100 で作ったもの。権限はそのまま引き継がれる): app_me(チケットの発行と表示を追加)、export_backup / restore_backup(新しい表を追加)。
begin;

-- ---------- ランクの基準(引き下げ) ----------
-- min_points は一意。途中で重ならないよう、小さい順に1行ずつ下げる
update public.rank_thresholds set min_points = 1000  where rank_code = 'amber';
update public.rank_thresholds set min_points = 3000  where rank_code = 'emerald';
update public.rank_thresholds set min_points = 6000  where rank_code = 'ruby';
update public.rank_thresholds set min_points = 10000 where rank_code = 'onyx';

-- ---------- 特典チケットの種類(値の変更は行の更新で済む) ----------
create table public.perk_ticket_types (
  code       text primary key,
  kind       text not null check (kind in ('milestone','seasonal')),   -- milestone: ランク到達のお祝い / seasonal: 季節ごと
  rank_code  text not null references public.rank_thresholds(rank_code), -- milestone: 到達したランク / seasonal: 対象になる最低のランク
  label      text not null,                                             -- 画面に出す品物の名前
  valid_days integer check (valid_days is null or valid_days > 0),       -- milestone: 発行日から何日目まで使えるか(日本時間の日付)。seasonal は季節の終わりまでなので null
  active     boolean not null default true,
  check ((kind = 'milestone') = (valid_days is not null))
);
create unique index perk_ticket_types_one_milestone on public.perk_ticket_types (rank_code) where kind = 'milestone';
insert into public.perk_ticket_types(code, kind, rank_code, label, valid_days) values
  ('milestone_amber',   'milestone', 'amber',   '豆花 1つ',             60),
  ('milestone_emerald', 'milestone', 'emerald', '持ち帰り用のお茶 1袋', 60),
  ('milestone_ruby',    'milestone', 'ruby',    '持ち帰り用のお茶 1袋', 60),
  ('milestone_onyx',    'milestone', 'onyx',    '持ち帰り用のお茶 1袋', 60),
  ('seasonal_douhua',   'seasonal',  'emerald', '季節の豆花 1枚',       null);

-- ---------- 特典チケット(1枚=1行。使用済み・期限を DB で管理) ----------
create table public.perk_tickets (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references public.members(id) on delete restrict,
  type_code      text not null references public.perk_ticket_types(code),
  kind           text not null check (kind in ('milestone','seasonal')),
  rank_code      text references public.rank_thresholds(rank_code),   -- milestone: 到達したランク
  season_key     text check (season_key is null or season_key ~ '^[0-9]{4}-(spring|summer|autumn|winter)$'),   -- seasonal: 例 2026-autumn(冬は12月の年)
  title          text not null,
  issued_at      timestamptz not null,
  expires_at     timestamptz not null,                                -- この時刻から使えない
  used_at        timestamptz,                                         -- 使用の確定日時(スタッフが確定)
  used_by        uuid,                                                -- 確定したスタッフ
  use_request_id uuid,                                                -- 確定したコードの申請
  check ((kind = 'milestone') = (rank_code is not null)),
  check ((kind = 'seasonal') = (season_key is not null)),
  check ((used_at is null) = (used_by is null))
);
create unique index perk_tickets_one_milestone on public.perk_tickets (member_id, rank_code)  where kind = 'milestone';   -- 到達のお祝いはランクごとに1枚
create unique index perk_tickets_one_season    on public.perk_tickets (member_id, season_key) where kind = 'seasonal';    -- 季節の豆花は会員×季節で1枚
create index on public.perk_tickets (member_id, expires_at);

-- ---------- チケットの使用申請(6桁コード。ポイント使用の申請と同じ流れ) ----------
create table public.perk_ticket_requests (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.perk_tickets(id) on delete restrict,
  member_id    uuid not null references public.members(id) on delete restrict,
  code         text not null check (code ~ '^[0-9]{6}$'),
  status       text not null default 'pending' check (status in ('pending','confirmed','cancelled','expired')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  confirmed_at timestamptz,
  confirmed_by uuid,
  note         text
);
create unique index perk_req_pending_code   on public.perk_ticket_requests (code)      where status = 'pending';
create unique index perk_req_pending_member on public.perk_ticket_requests (member_id) where status = 'pending';
create unique index perk_req_one_confirmed  on public.perk_ticket_requests (ticket_id) where status = 'confirmed';   -- 1枚のチケットで確定できるのは1回だけ(二重使用の防止の最後の砦)

-- ---------- 内部関数 ----------
-- 日本時間の日付 → 季節。key(会員×季節の一意の鍵)・name(春夏秋冬)・endsOn(その季節の次の日=この日の 0:00 JST から使えない)
create function public._season_of(d date) returns jsonb
language plpgsql immutable set search_path = public as $$
declare y integer := extract(year from d)::int; mo integer := extract(month from d)::int;
begin
  if mo between 3 and 5 then return jsonb_build_object('key', y || '-spring', 'name', '春', 'endsOn', make_date(y, 6, 1)::text); end if;
  if mo between 6 and 8 then return jsonb_build_object('key', y || '-summer', 'name', '夏', 'endsOn', make_date(y, 9, 1)::text); end if;
  if mo between 9 and 11 then return jsonb_build_object('key', y || '-autumn', 'name', '秋', 'endsOn', make_date(y, 12, 1)::text); end if;
  if mo = 12 then return jsonb_build_object('key', y || '-winter', 'name', '冬', 'endsOn', make_date(y + 1, 3, 1)::text); end if;
  return jsonb_build_object('key', (y - 1) || '-winter', 'name', '冬', 'endsOn', make_date(y, 3, 1)::text);      -- 1〜2月は前の年の12月から続く冬
end $$;

-- 特典チケットの発行(会員証を開いたときに app_me から呼ぶ。何度呼んでも同じ。発行した枚数を返す)
--  到達のお祝い: 今のランクが、これまでに受け取ったお祝いのランクより上なら、今のランクの分を1枚だけ発行する。
--    【飛び越しのルール(設計書 7章の案。実装時に確認すること)】一度に複数のランクを飛び越えた場合(移行で累計が多い会員など)は、
--    到達した一番上のランクのお祝いだけを発行し、途中のランクの分は発行しない。
--  季節の豆花: 今のランクが対象(EMERALD 以上)なら、今の季節の分を1枚(会員×季節で1枚。季節の途中で到達したらその季節の分から)。
create function public._issue_perk_tickets(p_member uuid, p_now timestamptz) returns integer
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

-- 会員証に出す特典の情報(顧客本人にだけ返す)。使えるチケット・使用の申請中のコード・直近1時間の使用の結果
create function public._perk_snapshot(p_member uuid, p_now timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tickets', (select coalesce(jsonb_agg(jsonb_build_object('ticketId', t.id, 'kind', t.kind, 'title', t.title, 'rank', t.rank_code, 'season', t.season_key,
                  'expiresAt', t.expires_at, 'validThrough', (((t.expires_at at time zone 'Asia/Tokyo') - interval '1 second')::date)::text) order by t.expires_at, t.issued_at), '[]'::jsonb)
                from public.perk_tickets t where t.member_id = p_member and t.used_at is null and t.expires_at > p_now),
    'pendingTicket', (select jsonb_build_object('ticketId', r.ticket_id, 'title', t.title, 'code', r.code, 'expiresAt', r.expires_at)
                      from public.perk_ticket_requests r join public.perk_tickets t on t.id = r.ticket_id
                      where r.member_id = p_member and r.status = 'pending' and r.expires_at > p_now limit 1),
    'lastTicket', (select jsonb_build_object('status', r.status, 'title', t.title, 'at', coalesce(r.confirmed_at, r.created_at))
                   from public.perk_ticket_requests r join public.perk_tickets t on t.id = r.ticket_id
                   where r.member_id = p_member and r.status <> 'pending' and r.created_at > p_now - interval '1 hour' order by r.created_at desc limit 1))
$$;

create function public._member_view(p_member uuid, p_now timestamptz) returns jsonb
language sql security definer set search_path = public as
  $$ select public._snapshot(p_member, p_now) || public._perk_snapshot(p_member, p_now) $$;

-- ポイント使用のコードと、チケットのコードが同時に同じ値にならないようにする(スタッフの入力欄は1つ)。
-- 両方の発行で同じロック(7105002, コード)を取ってから相手の表を確かめる。重なれば一意制約違反として返し、発行側がコードを作り直す。
create function public._redeem_code_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' then
    perform pg_advisory_xact_lock(7105002, new.code::int);
    if exists (select 1 from public.perk_ticket_requests where code = new.code and status = 'pending') then
      raise exception 'code_in_use' using errcode = 'unique_violation';      -- app_redeem_request は unique_violation で作り直す
    end if;
  end if;
  return new;
end $$;
create trigger redeem_code_not_in_tickets before insert on public.redeem_requests
  for each row execute function public._redeem_code_guard();

-- ---------- 顧客向け関数(Edge Function(service_role)からのみ) ----------
-- 会員証の表示: 100 の app_me に「特典チケットの発行」と「特典の情報」を足したもの(それ以外は同じ)
create or replace function public.app_me(p_issuer text, p_subject text, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; iss text := public._gate(p_issuer, p_subject);
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id;
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  update public.redeem_requests set status = 'expired' where member_id = m.id and status = 'pending' and expires_at <= p_now;
  update public.perk_ticket_requests set status = 'expired' where member_id = m.id and status = 'pending' and expires_at <= p_now;
  perform public._issue_perk_tickets(m.id, p_now);
  return jsonb_build_object('status', 'ok', 'member', public._member_view(m.id, p_now));
end $$;

-- チケットの使用申請(会員証の「使う」)。6桁コードを発行し、スタッフが確認・確定する
create function public.app_ticket_request(p_issuer text, p_subject text, p_ticket_id uuid, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; t public.perk_tickets; r public.perk_ticket_requests; ttl integer := public._setting_int('redeem_ttl_seconds', 180);
        c text; tries integer := 0; iss text := public._gate(p_issuer, p_subject);
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;
  if m.status <> 'active' then return jsonb_build_object('status', 'not_registered'); end if;
  update public.perk_ticket_requests set status = 'expired' where member_id = m.id and status = 'pending' and expires_at <= p_now;
  select * into t from public.perk_tickets where id = p_ticket_id and member_id = m.id;      -- 本人のチケットだけ
  if not found then return jsonb_build_object('status', 'ticket_not_found'); end if;
  if t.used_at is not null then return jsonb_build_object('status', 'ticket_used', 'member', public._member_view(m.id, p_now)); end if;
  if t.expires_at <= p_now then return jsonb_build_object('status', 'ticket_expired', 'member', public._member_view(m.id, p_now)); end if;
  select * into r from public.perk_ticket_requests where member_id = m.id and status = 'pending';
  if found then
    if r.ticket_id = t.id then return jsonb_build_object('status', 'pending', 'member', public._member_view(m.id, p_now)); end if;
    return jsonb_build_object('status', 'already_pending', 'member', public._member_view(m.id, p_now));
  end if;
  if not public._throttle('ticket:' || m.id, 10, 3600, p_now) then raise exception 'rate_limited' using errcode = '22023'; end if;
  loop
    tries := tries + 1;
    c := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      perform pg_advisory_xact_lock(7105002, c::int);
      if exists (select 1 from public.redeem_requests where code = c and status = 'pending') then
        raise exception 'code_in_use' using errcode = 'unique_violation';
      end if;
      insert into public.perk_ticket_requests(ticket_id, member_id, code, expires_at) values (t.id, m.id, c, p_now + make_interval(secs => ttl)) returning * into r;
      exit;
    exception when unique_violation then
      if tries > 20 then raise exception 'code_unavailable'; end if;
    end;
  end loop;
  return jsonb_build_object('status', 'pending', 'member', public._member_view(m.id, p_now));
end $$;

create function public.app_ticket_cancel(p_issuer text, p_subject text, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ident public.member_identities; m public.members; n integer; iss text := public._gate(p_issuer, p_subject);
begin
  select * into ident from public.member_identities where provider = 'line' and issuer = iss and subject = p_subject;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  select * into m from public.members where id = ident.member_id for update;
  update public.perk_ticket_requests set status = 'cancelled', note = 'customer_cancel' where member_id = m.id and status = 'pending';
  get diagnostics n = row_count;
  return jsonb_build_object('status', case when n > 0 then 'cancelled' else 'nothing_pending' end, 'member', public._member_view(m.id, p_now));
end $$;

-- ---------- スタッフ向け関数 ----------
-- コードの確認(スタッフ画面の入力欄は1つ)。チケットのコードならチケットの内容を、そうでなければポイント使用(staff_lookup_redeem)の結果を返す。
-- 入力の間違いの回数はポイント使用と共通(10分に10回でロック)。
create function public.staff_lookup_code(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.perk_ticket_requests; t public.perk_tickets; m public.members; misses integer; res jsonb;
        c text := regexp_replace(coalesce(p_code, ''), '\s', '', 'g');               -- 空白入り(「123 456」)でも通す
begin
  perform public._require_role('staff');
  select count(*) into misses from public.audit_log where staff_user_id = auth.uid() and action = 'redeem_lookup_miss' and at > now() - interval '10 minutes';
  if misses >= 10 then raise exception 'too_many_attempts' using errcode = '42501'; end if;
  select * into r from public.perk_ticket_requests where code = c and status = 'pending';
  if found then
    select * into t from public.perk_tickets where id = r.ticket_id;
    select * into m from public.members where id = r.member_id;
    if r.expires_at > now() and t.used_at is null and t.expires_at > now() and m.is_test = (public._state() = 'test') then
      perform public._audit(auth.uid(), 'ticket_lookup', m.id, jsonb_build_object('request', r.id, 'ticket', t.id));
      return jsonb_build_object('status', 'ok', 'kind', 'ticket',
        'request', jsonb_build_object('id', r.id, 'expiresAt', r.expires_at),
        'ticket', jsonb_build_object('title', t.title, 'kind', t.kind, 'validThrough', (((t.expires_at at time zone 'Asia/Tokyo') - interval '1 second')::date)::text),
        'member', jsonb_build_object('memberNo', m.member_no, 'displayName', m.display_name, 'rank', m.rank_code, 'points', m.balance));
    end if;
  end if;
  res := public.staff_lookup_redeem(c);                               -- ポイント使用のコード(見つからなければ、ここで間違いとして記録される)
  if res ->> 'status' = 'ok' then res := res || jsonb_build_object('kind', 'points'); end if;
  return res;
end $$;

create function public.staff_confirm_ticket(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.perk_ticket_requests; t public.perk_tickets; m public.members;
begin
  perform public._require_role('staff');
  perform public._lock_state();
  select * into r from public.perk_ticket_requests where id = p_request_id for update;   -- 同じ申請の同時確定を直列化
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into t from public.perk_tickets where id = r.ticket_id for update;               -- 同じチケットの別の申請とも直列化
  if r.status = 'confirmed' then return jsonb_build_object('status', 'already_confirmed', 'title', t.title); end if;
  if r.status <> 'pending' then return jsonb_build_object('status', r.status); end if;
  if r.expires_at <= now() then
    update public.perk_ticket_requests set status = 'expired' where id = r.id;
    return jsonb_build_object('status', 'expired');
  end if;
  select * into m from public.members where id = r.member_id;
  perform public._require_write(m.is_test);                                                -- 状態と会員の種別が合わない書込みは拒否
  if t.used_at is not null then
    update public.perk_ticket_requests set status = 'cancelled', note = 'ticket_already_used' where id = r.id;
    return jsonb_build_object('status', 'ticket_used', 'title', t.title);
  end if;
  if t.expires_at <= now() then
    update public.perk_ticket_requests set status = 'cancelled', note = 'ticket_expired' where id = r.id;
    return jsonb_build_object('status', 'ticket_expired', 'title', t.title);
  end if;
  update public.perk_tickets set used_at = now(), used_by = auth.uid(), use_request_id = r.id where id = t.id;
  update public.perk_ticket_requests set status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid() where id = r.id;
  perform public._audit(auth.uid(), 'ticket_confirm', m.id, jsonb_build_object('request', r.id, 'ticket', t.id, 'type', t.type_code));
  return jsonb_build_object('status', 'confirmed', 'title', t.title);
end $$;

create function public.staff_cancel_ticket(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.perk_ticket_requests;
begin
  perform public._require_role('staff');
  perform public._lock_state();
  select * into r from public.perk_ticket_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.status <> 'pending' then return jsonb_build_object('status', r.status); end if;
  perform public._require_write((select is_test from public.members where id = r.member_id));
  update public.perk_ticket_requests set status = 'cancelled', note = 'staff_cancel' where id = r.id;
  perform public._audit(auth.uid(), 'ticket_cancel', r.member_id, jsonb_build_object('request', r.id));
  return jsonb_build_object('status', 'cancelled');
end $$;

-- 集計: チケットの発行数・使用数・使用率(使用数÷発行数)。いまの状態の会員だけ(test のときは試験会員のみ)
create function public.staff_ticket_stats() returns jsonb
language plpgsql security definer set search_path = public as $$
declare tst boolean := (public._state() = 'test'); ms timestamptz := date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo'; res jsonb;
begin
  perform public._require_role('viewer');
  with t as (select pt.* from public.perk_tickets pt join public.members m on m.id = pt.member_id where m.is_test = tst)
  select jsonb_build_object(
    'asOf', now(),
    'issued', (select count(*) from t),
    'used', (select count(*) from t where used_at is not null),
    'active', (select count(*) from t where used_at is null and expires_at > now()),
    'expiredUnused', (select count(*) from t where used_at is null and expires_at <= now()),
    'usageRatePercent', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where used_at is not null) / count(*), 1) end from t),
    'issuedThisMonth', (select count(*) from t where issued_at >= ms),
    'usedThisMonth', (select count(*) from t where used_at >= ms),
    'byKind', jsonb_build_object(
       'milestone', jsonb_build_object('issued', (select count(*) from t where kind = 'milestone'), 'used', (select count(*) from t where kind = 'milestone' and used_at is not null)),
       'seasonal',  jsonb_build_object('issued', (select count(*) from t where kind = 'seasonal'),  'used', (select count(*) from t where kind = 'seasonal' and used_at is not null))),
    'pendingTickets', (select count(*) from public.perk_ticket_requests r join public.members m on m.id = r.member_id where r.status = 'pending' and r.expires_at > now() and m.is_test = tst))
  into res;
  return res;
end $$;

-- ---------- バックアップ/復元: 新しい表を加える(100 の export_backup / restore_backup に追加。他は同じ) ----------
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
    'staff_users',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.staff_users t),
    'audit_log',        (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from (select * from public.audit_log order by id desc limit 5000) t)));
end $$;

-- 102 より前のバックアップ(チケットの表がない)も復元できる(その場合チケットは0件)
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t jsonb := p -> 'tables'; mx bigint; bad integer;
begin
  if (p ->> 'version') is distinct from '1' or t is null then raise exception 'invalid_backup' using errcode = '22023'; end if;
  if exists (select 1 from public.members) or exists (select 1 from public.point_ledger) or exists (select 1 from public.perk_tickets) then raise exception 'target_not_empty' using errcode = '55000'; end if;
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
  insert into public.staff_users select s.* from jsonb_populate_recordset(null::public.staff_users, t -> 'staff_users') s where exists (select 1 from auth.users u where u.id = s.user_id);
  insert into public.audit_log overriding system value select * from jsonb_populate_recordset(null::public.audit_log, t -> 'audit_log');
  select coalesce(max(substr(member_no, 5)::bigint), 0) into mx from public.members where member_no ~ '^user[0-9]+$';
  perform setval('public.member_no_seq', greatest(mx, 1), mx > 0);
  select coalesce(max(substr(member_no, 2)::bigint), 0) into mx from public.members where member_no ~ '^T[0-9]+$';
  perform setval('public.test_member_no_seq', greatest(mx, 1), mx > 0);
  perform setval(pg_get_serial_sequence('public.point_ledger', 'id'), greatest((select coalesce(max(id), 0) from public.point_ledger), 1), (select count(*) > 0 from public.point_ledger));
  perform setval(pg_get_serial_sequence('public.visits', 'id'), greatest((select coalesce(max(id), 0) from public.visits), 1), (select count(*) > 0 from public.visits));
  perform setval(pg_get_serial_sequence('public.audit_log', 'id'), greatest((select coalesce(max(id), 0) from public.audit_log), 1), (select count(*) > 0 from public.audit_log));
  update public.system_state set state = 'frozen', reconciled = false, reconciled_at = null, changed_at = now();
  select count(*) into bad from public.verify_balances();
  return jsonb_build_object('status', 'restored', 'members', (select count(*) from public.members), 'ledger', (select count(*) from public.point_ledger),
                            'balanceMismatches', bad, 'state', 'frozen');
end $$;

-- ---------- 会員のランクを新しい基準で付け直す(基準は下がっただけなので、ランクは上がるか変わらない) ----------
do $$
declare r record;
begin
  for r in update public.members m set rank_code = public.rank_for(public._effective_lifetime(m)), updated_at = now()
           where m.rank_code is distinct from public.rank_for(public._effective_lifetime(m)) returning m.id, m.is_test loop
    if not r.is_test then perform public._mirror(r.id, null, null); end if;   -- 既存 customers のランク表示へ反映(open かつ本番会員のときだけ動く)
  end loop;
end $$;

-- ---------- 権限(anon には何も与えない。表への直接アクセスも与えない) ----------
alter table public.perk_ticket_types    enable row level security;
alter table public.perk_tickets         enable row level security;
alter table public.perk_ticket_requests enable row level security;

do $$
declare r record;
begin
  for r in select format('%I.%I', n.nspname, c.relname) as nm from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = any(array['perk_ticket_types','perk_tickets','perk_ticket_requests']) loop
    execute format('revoke all on table %s from public, anon, authenticated, service_role', r.nm);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(array['_season_of','_issue_perk_tickets','_perk_snapshot','_member_view','_redeem_code_guard','app_ticket_request','app_ticket_cancel',
                                                                 'staff_lookup_code','staff_confirm_ticket','staff_cancel_ticket','staff_ticket_stats']) loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

grant select on public.perk_ticket_types to authenticated;
create policy perk_types_read on public.perk_ticket_types for select to authenticated using (public._staff_role() is not null);
grant select, insert, update on public.perk_ticket_types, public.perk_tickets, public.perk_ticket_requests to service_role;
grant execute on function public.app_ticket_request(text, text, uuid, timestamptz), public.app_ticket_cancel(text, text, timestamptz), public._season_of(date) to service_role;
grant execute on function public.staff_lookup_code(text), public.staff_confirm_ticket(uuid), public.staff_cancel_ticket(uuid), public.staff_ticket_stats() to authenticated;

commit;
