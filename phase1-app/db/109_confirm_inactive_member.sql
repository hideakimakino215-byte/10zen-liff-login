-- 停止中の会員のコードは確定しない(監査 AUDIT_20261015.md の L-1)【本番未適用・ローカル検証のみ】
-- 前提: 100〜108 が適用済み。取り消しは 109_confirm_inactive_member_DOWN.sql(2つの関数を 100・102 の内容に戻すだけ。表・データには触れない)。
-- 問題: お客様がコードを出した後(有効時間の 180 秒の間)に店長が会員を停止しても、スタッフ画面で特典チケット(staff_confirm_ticket)や
--   ポイントの使用(staff_confirm_redeem)を確定できた。
-- 直し方: 確定の直前に会員の状態を見る。active でなければ申請を取り消し(status=cancelled、note=member_inactive)、
--   {status:'member_inactive'} を返す(チケットは未使用のまま・ポイントは減らさない)。監査ログに *_refused(reason=member_inactive)を残す。
--   会員の行は確定の間ロックする(停止の操作と同時でも、どちらか一方の順に決まる)。
--   コードの確認(staff_lookup_code / staff_lookup_redeem)は変えない(確認できても確定で止まる)。
-- 置き換える既存の関数(create or replace。署名と権限はそのまま): staff_confirm_ticket(102)、staff_confirm_redeem(100)。
begin;

create or replace function public.staff_confirm_ticket(p_request_id uuid) returns jsonb
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
  select * into m from public.members where id = r.member_id for share;                    -- 停止の操作と直列化
  perform public._require_write(m.is_test);                                                -- 状態と会員の種別が合わない書込みは拒否
  if m.status <> 'active' then                                                             -- コードを出した後に停止された会員(監査 L-1)
    update public.perk_ticket_requests set status = 'cancelled', note = 'member_inactive' where id = r.id;
    perform public._audit(auth.uid(), 'ticket_confirm_refused', m.id, jsonb_build_object('request', r.id, 'ticket', t.id, 'reason', 'member_inactive', 'memberStatus', m.status));
    return jsonb_build_object('status', 'member_inactive', 'title', t.title);
  end if;
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

create or replace function public.staff_confirm_redeem(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.redeem_requests; m public.members; lid bigint; yen integer := public._setting_int('yen_per_100pt', 10);
begin
  perform public._require_role('staff');
  perform public._lock_state();
  select * into r from public.redeem_requests where id = p_request_id for update;          -- 同じ申請の同時確定を直列化
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.status = 'confirmed' then return jsonb_build_object('status', 'already_confirmed', 'points', r.points, 'yen', r.points * yen / 100); end if;
  if r.status <> 'pending' then return jsonb_build_object('status', r.status); end if;
  if r.expires_at <= now() then
    update public.redeem_requests set status = 'expired' where id = r.id;
    return jsonb_build_object('status', 'expired');
  end if;
  select * into m from public.members where id = r.member_id for update;
  perform public._require_write(m.is_test);                                                -- 状態と会員の種別が合わない書込みは拒否
  if m.status <> 'active' then                                                             -- コードを出した後に停止された会員(監査 L-1)。ポイントは減らさない
    update public.redeem_requests set status = 'cancelled', note = 'member_inactive' where id = r.id;
    perform public._audit(auth.uid(), 'redeem_confirm_refused', m.id, jsonb_build_object('request', r.id, 'points', r.points, 'reason', 'member_inactive', 'memberStatus', m.status));
    return jsonb_build_object('status', 'member_inactive', 'points', r.points);
  end if;
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

commit;
