// スタッフ画面用クライアント(見た目に依存しない)。権限は DB の関数側で確認される(画面の出し分けは補助)。
//   supabase: supabase-js のクライアント(anon キー+ログイン済みセッション)。サービスキーは使わない。
export function mapError(err) {
  const msg = String(err?.message || err || "");
  if (/too_many_attempts/.test(msg)) return { kind: "locked" };
  if (/not_staff/.test(msg)) return { kind: "not_staff" };
  if (/forbidden/.test(msg) || /permission denied/.test(msg)) return { kind: "forbidden" };
  if (/reason_required/.test(msg)) return { kind: "invalid", code: "reason_required" };
  if (/invalid_points|invalid_key/.test(msg)) return { kind: "invalid", code: msg.match(/invalid_\w+/)[0] };
  if (/JWT|expired|not authenticated/i.test(msg)) return { kind: "auth_required" };
  return { kind: "error", retryable: true };
}

export function createStaffClient({ supabase, qrEndpoint, fetchFn = (...a) => fetch(...a), uuid = () => crypto.randomUUID() }) {
  const rpc = async (name, args = {}) => {
    try {
      const { data, error } = await supabase.rpc(name, args);
      if (error) return mapError(error);
      return { kind: "ok", data };
    } catch (e) { return { kind: "error", retryable: true }; }
  };
  return {
    signIn: async (email, password) => { const { data, error } = await supabase.auth.signInWithPassword({ email, password }); return error ? { kind: "auth_failed" } : { kind: "ok", data }; },
    signOut: async () => { await supabase.auth.signOut(); return { kind: "ok" }; },
    whoami: () => rpc("staff_whoami"),
    dashboard: () => rpc("staff_dashboard"),
    listMembers: ({ query = null, limit = 50, offset = 0 } = {}) => rpc("staff_list_members", { p_query: query, p_limit: limit, p_offset: offset }),
    memberDetail: (memberId) => rpc("staff_member_detail", { p_member_id: memberId }),
    todayVisits: () => rpc("staff_today_visits"),
    lookupRedeem: (code) => rpc("staff_lookup_redeem", { p_code: String(code || "").replace(/\s/g, "") }),
    confirmRedeem: (requestId) => rpc("staff_confirm_redeem", { p_request_id: requestId }),
    cancelRedeem: (requestId) => rpc("staff_cancel_redeem", { p_request_id: requestId }),
    // 店長のみ。key は1回の操作につき1つ作り、再送時は同じ key を使う(二重実行されない)
    newAdjustKey: () => `adj-${uuid()}`,
    adjust: ({ memberId, points, reason, key }) => rpc("manager_adjust", { p_member_id: memberId, p_points: points, p_reason: reason, p_idempotency_key: key }),
    reverseRedeem: (requestId, reason) => rpc("manager_reverse_redeem", { p_request_id: requestId, p_reason: reason }),
    qrToken: async () => {
      try {
        const { data: s } = await supabase.auth.getSession();
        const tok = s?.session?.access_token; if (!tok) return { kind: "auth_required" };
        const res = await fetchFn(qrEndpoint, { method: "POST", headers: { authorization: `Bearer ${tok}` } });
        if (res.status === 401) return { kind: "auth_required" }; if (res.status === 403) return { kind: "forbidden" };
        if (!res.ok) return { kind: "error", retryable: true };
        return { kind: "ok", data: await res.json() };
      } catch (_e) { return { kind: "error", retryable: true }; }
    },
  };
}

// ポイント使用の確認フロー(画面の状態遷移。UI はこの state を表示するだけ)
//   idle → (入力) → looking_up → confirm(内容を確認して確定を押す) → confirming → done / または not_found・expired・insufficient・locked・error
export const redeemInitial = { step: "idle" };
export function redeemReduce(state, ev) {
  switch (ev.type) {
    case "lookup_start": return { step: "looking_up" };
    case "lookup_result": {
      const r = ev.result;
      if (r.kind === "locked") return { step: "locked" };
      if (r.kind !== "ok") return r.kind === "forbidden" || r.kind === "not_staff" ? { step: "forbidden" } : { step: "error", retry: true };
      return r.data.status === "ok" ? { step: "confirm", request: r.data.request, member: r.data.member } : { step: "not_found" };
    }
    case "confirm_start": return state.step === "confirm" ? { ...state, step: "confirming" } : state;      // 二重押し下げは無視
    case "confirm_result": {
      const r = ev.result;
      if (r.kind !== "ok") return { step: "error", retry: true, request: state.request, member: state.member };   // 結果不明: 同じ申請で再確認(確定は冪等)
      const st = r.data.status;
      if (st === "confirmed" || st === "already_confirmed") return { step: "done", points: r.data.points, yen: r.data.yen, balanceAfter: r.data.balanceAfter ?? null };
      if (st === "expired") return { step: "expired" };
      if (st === "insufficient_balance") return { step: "insufficient", balance: r.data.points };
      return { step: st === "cancelled" ? "cancelled" : "not_found" };
    }
    case "reset": return redeemInitial;
    default: return state;
  }
}

// 店頭QRの表示(タブレット)。トークンは30秒ごとに変わるので、切替の少し前に取得し直す。
// 取得できない状態が続いて期限(約90秒)を過ぎたら QR を隠す(古い QR を表示し続けない)。
export function createQrKiosk({ getToken, onUpdate, onHidden, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, hideAfterMs = 90_000 }) {
  let timer = null, stopped = false, lastOkAt = 0;
  async function tick() {
    if (stopped) return;
    const r = await getToken();
    if (stopped) return;
    if (r.kind === "ok") {
      lastOkAt = now(); onUpdate(r.data);
      const wait = Math.max(1000, r.data.nextChangeAt - now() - 2000);
      timer = setTimer(tick, wait);
    } else {
      if (now() - lastOkAt > hideAfterMs) onHidden(r.kind);
      timer = setTimer(tick, r.kind === "auth_required" || r.kind === "forbidden" ? 30_000 : 5000);
    }
  }
  return { start: () => { stopped = false; tick(); }, stop: () => { stopped = true; if (timer) clearTimer(timer); } };
}
