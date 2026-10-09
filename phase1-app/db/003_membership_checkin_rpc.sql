-- 003 (v2): 来店イベントの「ちょうど1回」処理と、ポイント値の順序保護。本番未適用。追加のみ(既存テーブルの構造・既存行は変更しない)。
-- 追加物(承認範囲): テーブル membership_events 1つ / 関数 record_membership_checkin / 関数 sync_membership_points。初期登録(データ投入)はなし。
-- 方針:
--  * 来店の二重防止は処理日の比較ではなく、イベント固有キー(event_key)の一意制約。日付をまたぐ再送も、同時送信も1回だけ。
--  * イベント登録・顧客更新・来店履歴の追加は1トランザクション。途中失敗は全体が取り消され、再送で全体をやり直せる。
--  * ポイント系の値は「版(p_seq)」で順序保護する。版は GAS が、会員シートの読み取りと同じスクリプトロック内で採番する単調増加の数値。
--    HTTP の遅延・再試行で後から届いた古い読み取りは、版が小さいので上書きできない(時刻の比較ではない)。最終来店日は戻らない。
--    版は同じ表の 'pv:<LINE ID>' 行(seq 列)に保持する。既存顧客で行がない場合は points_updated_at(旧関数が書いた時刻)を下限とする。
--  * 切替の境界: 旧関数が既に数えた来店(同じ JST 日付の来店履歴、または同じ JST 日付の最終来店日=旧関数の「顧客更新後・履歴追加前」の途中状態)は、キーが未登録でも二重に数えない。
--    DB 適用時点ではなく、イベントを処理する時点の実際の履歴で判定するので、DB 初期化〜新関数への切替の間に旧関数が数えた来店も対象。
--  * anon / authenticated は表・関数とも利用不可。service_role は select/insert/update のみ(delete・truncate 不可)。
-- 運用開始後の復旧: 処理済みイベントの表と記録は削除しない。復旧は「関数を限定停止版(503)にする」「修正版を再デプロイする」で行う。
--   (運用開始前=新関数への切替前に限り、この追加物は drop で撤去できる。)

create table if not exists public.membership_events (
  event_key   text primary key check (event_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  store_id    uuid not null,
  customer_id uuid,
  event_at    timestamptz not null,
  seq         bigint,                               -- 'pv:' 行のみ: 最後に反映したポイント値の版
  created_at  timestamptz not null default now()
);
alter table public.membership_events enable row level security;
revoke all on table public.membership_events from public, anon, authenticated;
grant select, insert, update on table public.membership_events to service_role;
revoke delete, truncate on table public.membership_events from service_role;

create or replace function public.record_membership_checkin(
  p_store_id uuid, p_line_user_id text, p_event_key text, p_event_at timestamptz,
  p_points integer default null, p_rank text default null, p_lifetime integer default null,
  p_user_id text default null, p_seq bigint default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
  v_cust public.customers%rowtype;
  v_created boolean := false;
  v_apply boolean := false;
  v_legacy boolean := false;
  v_cur bigint;
  v_pv text := 'pv:' || p_line_user_id;
begin
  if p_points is not null and p_seq is null then
    raise exception 'seq required with points' using errcode = '22023';
  end if;

  -- 一意制約による直列化: 同じキーが同時に来ると、後続は先行のコミットまで待ち、コミット後は何もしない。
  insert into public.membership_events (event_key, store_id, event_at)
  values (p_event_key, p_store_id, p_event_at)
  on conflict (event_key) do nothing;
  get diagnostics v_inserted = row_count;

  select * into v_cust from public.customers where store_id = p_store_id and line_user_id = p_line_user_id for update;

  if v_inserted = 0 then
    -- 処理済みイベントの再送: 来店回数・履歴は変えない。版が新しいポイント値だけは反映してよい。
    if found and p_points is not null then
      v_cur := greatest(coalesce((select seq from public.membership_events where event_key = v_pv), 0),
                        coalesce((extract(epoch from v_cust.points_updated_at) * 1000)::bigint, 0));
      if p_seq > v_cur then
        update public.customers set points = p_points, rank = coalesce(p_rank, rank), lifetime_points = coalesce(p_lifetime, lifetime_points),
          membership_user_id = coalesce(p_user_id, membership_user_id), points_updated_at = to_timestamp(p_seq / 1000.0)
        where id = v_cust.id;
        insert into public.membership_events (event_key, store_id, event_at, seq) values (v_pv, p_store_id, now(), p_seq)
        on conflict (event_key) do update set seq = excluded.seq where public.membership_events.seq is null or public.membership_events.seq < excluded.seq;
        return jsonb_build_object('status', 'duplicate', 'points_applied', true);
      end if;
    end if;
    return jsonb_build_object('status', 'duplicate', 'points_applied', false);
  end if;

  if not found then
    insert into public.customers (store_id, line_user_id, first_visited_at, last_visited_at, visit_count, status,
                                  points, rank, lifetime_points, membership_user_id, points_updated_at)
    values (p_store_id, p_line_user_id, p_event_at, p_event_at, 1, 'active',
            p_points, p_rank, p_lifetime, p_user_id, case when p_points is not null then to_timestamp(p_seq / 1000.0) end)
    on conflict (store_id, line_user_id) do nothing
    returning * into v_cust;
    if found then
      v_created := true;
      if p_points is not null then
        insert into public.membership_events (event_key, store_id, event_at, seq) values (v_pv, p_store_id, now(), p_seq)
        on conflict (event_key) do update set seq = excluded.seq where public.membership_events.seq is null or public.membership_events.seq < excluded.seq;
        v_apply := true;
      end if;
    else
      -- 別トランザクションが先に作成(コミット済み)。行ロックを取って既存顧客として続行する。
      select * into v_cust from public.customers where store_id = p_store_id and line_user_id = p_line_user_id for update;
    end if;
  end if;

  if not v_created then
    -- 旧関数(日付比較)が既に数えた来店か: 次のどちらかなら、数え直さない(来店回数・履歴とも追加しない)。
    --  (a) 同じ JST 日付の来店履歴が既にある
    --  (b) 顧客の最終来店日が同じ JST 日付(旧関数は「顧客更新 → 履歴追加」の順で書くため、更新後・履歴追加前の途中状態もここで検出できる)
    -- 履歴は補わない(旧処理が続いて履歴を書く場合に二重にならないため)。
    v_legacy := (v_cust.last_visited_at is not null
                 and (v_cust.last_visited_at at time zone 'Asia/Tokyo')::date = (p_event_at at time zone 'Asia/Tokyo')::date)
      or exists (
      select 1 from public.interactions i
      where i.customer_id = v_cust.id and i.trigger_type in ('membership_checkin', 'visit_checkin')
        and (i.sent_at at time zone 'Asia/Tokyo')::date = (p_event_at at time zone 'Asia/Tokyo')::date);
    if p_points is not null then
      v_cur := greatest(coalesce((select seq from public.membership_events where event_key = v_pv), 0),
                        coalesce((extract(epoch from v_cust.points_updated_at) * 1000)::bigint, 0));
      v_apply := p_seq > v_cur;
    end if;
    update public.customers set
      visit_count = case when v_legacy then visit_count else coalesce(visit_count, 0) + 1 end,
      last_visited_at = case when v_legacy then last_visited_at else greatest(coalesce(last_visited_at, p_event_at), p_event_at) end,
      status = case when v_legacy then status else 'active' end,
      points = case when v_apply then p_points else points end,
      rank = case when v_apply then coalesce(p_rank, rank) else rank end,
      lifetime_points = case when v_apply then coalesce(p_lifetime, lifetime_points) else lifetime_points end,
      membership_user_id = case when v_apply then coalesce(p_user_id, membership_user_id) else membership_user_id end,
      points_updated_at = case when v_apply then to_timestamp(p_seq / 1000.0) else points_updated_at end
    where id = v_cust.id;
    if v_apply then
      insert into public.membership_events (event_key, store_id, event_at, seq) values (v_pv, p_store_id, now(), p_seq)
      on conflict (event_key) do update set seq = excluded.seq where public.membership_events.seq is null or public.membership_events.seq < excluded.seq;
    end if;
  end if;

  update public.membership_events set customer_id = v_cust.id where event_key = p_event_key;

  if v_legacy then
    return jsonb_build_object('status', 'legacy_counted', 'points_applied', v_apply);
  end if;

  insert into public.interactions (store_id, customer_id, trigger_type, message, reason, sent_at)
  values (p_store_id, v_cust.id, 'membership_checkin',
          case when v_created then '(会員証スキャンによる新規来店記録)' else '(会員証スキャンによる来店記録)' end,
          'デジタル会員証経由の来店検知', p_event_at);   -- 履歴の時刻は来店の発生時刻(再送でも来店日に記録される)

  return jsonb_build_object('status', 'counted', 'created', v_created, 'points_applied', v_apply);
end $$;

create or replace function public.sync_membership_points(
  p_store_id uuid, p_line_user_id text, p_points integer, p_seq bigint,
  p_rank text default null, p_lifetime integer default null, p_user_id text default null,
  p_last_visited_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_cust public.customers%rowtype;
  v_apply boolean;
  v_cur bigint;
  v_pv text := 'pv:' || p_line_user_id;
begin
  select * into v_cust from public.customers where store_id = p_store_id and line_user_id = p_line_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  v_cur := greatest(coalesce((select seq from public.membership_events where event_key = v_pv), 0),
                    coalesce((extract(epoch from v_cust.points_updated_at) * 1000)::bigint, 0));
  v_apply := p_seq > v_cur;
  update public.customers set
    points = case when v_apply then p_points else points end,
    rank = case when v_apply then coalesce(p_rank, rank) else rank end,
    lifetime_points = case when v_apply then coalesce(p_lifetime, lifetime_points) else lifetime_points end,
    membership_user_id = case when v_apply then coalesce(p_user_id, membership_user_id) else membership_user_id end,
    points_updated_at = case when v_apply then to_timestamp(p_seq / 1000.0) else points_updated_at end,
    last_visited_at = case when p_last_visited_at is not null then greatest(coalesce(last_visited_at, p_last_visited_at), p_last_visited_at) else last_visited_at end
  where id = v_cust.id;
  if v_apply then
    insert into public.membership_events (event_key, store_id, event_at, seq) values (v_pv, p_store_id, now(), p_seq)
    on conflict (event_key) do update set seq = excluded.seq where public.membership_events.seq is null or public.membership_events.seq < excluded.seq;
  end if;
  return jsonb_build_object('status', case when v_apply then 'applied' else 'stale' end);
end $$;

revoke all on function public.record_membership_checkin(uuid,text,text,timestamptz,integer,text,integer,text,bigint) from public, anon, authenticated;
revoke all on function public.sync_membership_points(uuid,text,integer,bigint,text,integer,text,timestamptz) from public, anon, authenticated;
grant execute on function public.record_membership_checkin(uuid,text,text,timestamptz,integer,text,integer,text,bigint) to service_role;
grant execute on function public.sync_membership_points(uuid,text,integer,bigint,text,integer,text,timestamptz) to service_role;
