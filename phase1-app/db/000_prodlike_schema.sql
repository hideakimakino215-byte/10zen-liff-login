-- 本番の主要テーブルを模したテスト用スキーマ(ローカル検証専用。本番の列から必要分を再現)
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create table stores (id uuid primary key default gen_random_uuid(), name text not null);
create table customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  line_user_id text not null,
  first_visited_at timestamptz, last_visited_at timestamptz,
  visit_count integer default 0, status text default 'active',
  experiment_group text,
  points integer, rank text, lifetime_points integer, membership_user_id text, points_updated_at timestamptz,
  created_at timestamptz default now(),
  unique (store_id, line_user_id));
create table interactions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid, customer_id uuid references customers(id),
  trigger_type text, message text, reason text, sent_at timestamptz default now());
create function assign_experiment_group() returns trigger language plpgsql as $$
begin if new.experiment_group is null then new.experiment_group := case when random() < 0.2 then 'control' else 'treatment' end; end if; return new; end $$;
create trigger trg_assign_experiment_group before insert on customers for each row execute function assign_experiment_group();
alter table stores enable row level security; alter table customers enable row level security; alter table interactions enable row level security;
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
create table fail_flag (on_ boolean not null);
insert into fail_flag values (false);
create function maybe_fail() returns trigger language plpgsql as $$
begin if (select on_ from fail_flag) then raise exception 'injected failure' using errcode = 'XX000'; end if; return new; end $$;
create trigger trg_fail_interactions before insert on interactions for each row execute function maybe_fail();
