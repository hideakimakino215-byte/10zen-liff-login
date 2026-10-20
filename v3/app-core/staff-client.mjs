// スタッフ画面用クライアント(見た目に依存しない)。権限は DB の関数側で確認される(画面の出し分けは補助)。
//   supabase: supabase-js のクライアント(anon キー+ログイン済みセッション)。サービスキーは使わない。
import { MAX_ROWS_PER_CALL, invalidImportRows } from "./pos-import.mjs";

export function mapError(err) {
  const msg = String(err?.message || err || "");
  if (/too_many_attempts/.test(msg)) return { kind: "locked" };
  if (/not_staff/.test(msg)) return { kind: "not_staff" };
  if (/forbidden/.test(msg) || /permission denied/.test(msg)) return { kind: "forbidden" };
  if (/\bmaintenance\b/.test(msg)) return { kind: "maintenance" };                         // 凍結中など、いまの状態では書き込めない(再試行しても変わらない)
  if (/reason_required/.test(msg)) return { kind: "invalid", code: "reason_required" };
  if (/invalid_points|invalid_key/.test(msg)) return { kind: "invalid", code: msg.match(/invalid_\w+/)[0] };
  // 目標と KPI(db/105)の入力の誤り: 取り込みの行・日付・客数・月・目標・KPI・段階
  // 友だち紹介(db/106)のディナーの五巡茶の出し方: invalid_mode
  if (/invalid_(rows|date|customers|month|target|kpi|milestone|mode)\b/.test(msg)) return { kind: "invalid", code: msg.match(/invalid_(rows|date|customers|month|target|kpi|milestone|mode)\b/)[0] };
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
    // 入力欄は1つ: ポイント使用のコードか特典チケットのコードかは DB が見分ける(結果の data.kind が "points" / "ticket")
    lookupCode: (code) => rpc("staff_lookup_code", { p_code: normalizeCode(code) }),
    confirmTicket: (requestId) => rpc("staff_confirm_ticket", { p_request_id: requestId }),
    cancelTicket: (requestId) => rpc("staff_cancel_ticket", { p_request_id: requestId }),
    ticketStats: () => rpc("staff_ticket_stats"),
    // 1分体質チェックの集計(db/103)。data.scope が "full"(店長・閲覧)なら全項目、"limited"(スタッフ)なら今週の体調の傾向(data.week)だけ
    constitutionStats: () => rpc("staff_constitution_stats"),
    // 友だち紹介の集計(db/106)。閲覧以上(店頭タブレットは forbidden)。個人の情報は返らない。data.canEdit が true なのは店長だけ
    referralStats: () => rpc("staff_referral_stats"),
    // 店長のみ: ディナーの五巡茶の出し方 "cup"(1杯)/ "free_flow"(飲み放題)。まだ使っていない紹介のチケットの名前も変わる
    setDinnerTeaMode: (mode) => rpc("manager_set_dinner_tea_mode", { p_mode: mode }),
    // 目標と KPI(db/105)。集計は店長・閲覧(本部)だけ(スタッフ・店頭タブレットは forbidden)。data.canEdit が true なのは店長だけ
    kpiOverview: (months = 13) => rpc("staff_kpi_overview", { p_months: months }),
    // 以下は店長のみ。日付は 'YYYY-MM-DD'(null で未設定)、月は 'YYYY-MM'、目標は null で「目標なし」
    setLaunchDate: (date) => rpc("manager_set_launch_date", { p_date: date || null }),
    setKpiTarget: (kpi, milestone, value) => rpc("manager_set_kpi_target", { p_kpi: kpi, p_milestone: milestone, p_value: value }),
    setPosMonthly: (month, customers) => rpc("manager_set_pos_monthly", { p_month: month, p_customers: customers }),
    // レジの客数(日別)の取り込み。rows = [{ date, customers }]。DB の1回の上限(400行)ごとに分けて順に送る(同じ日付は上書きなので、途中で失敗しても送り直せる)。
    //  送る前に全行を確かめ(日付の形・客数が 0〜100,000 の整数。DB と同じ決まり)、1行でも違えば何も送らない: { kind:"invalid", code, sent:0, saved:0, bad:[…] }
    //  戻り値: { kind:"ok", data:{ inserted, updated, unchanged, calls } }
    //  途中の回で失敗したら、その応答に sent / saved(保存できた行数。前の回までの合計)・failedChunk(失敗した回。1から)・chunks(全部の回数)・
    //  failedRange(失敗した回の最初と最後の日付)を付けて返す。失敗した回の行は1行も保存されない(DB が回ごとにまとめて拒否する)
    importPosCustomers: async (rows, source, size = MAX_ROWS_PER_CALL) => {
      const chunks = Math.ceil(rows.length / size);
      const bad = invalidImportRows(rows);
      if (bad.length) return { kind: "invalid", code: bad[0].reason, sent: 0, saved: 0, failedChunk: null, chunks, bad };
      const tot = { inserted: 0, updated: 0, unchanged: 0, calls: 0 };
      for (let i = 0; i < rows.length; i += size) {
        const part = rows.slice(i, i + size);
        const r = await rpc("manager_import_pos_customers", { p_rows: part, p_source: source ?? null });
        if (r.kind !== "ok") return { ...r, sent: i, saved: i, failedChunk: i / size + 1, chunks, failedRange: { from: part[0].date, to: part[part.length - 1].date } };
        tot.inserted += r.data.inserted; tot.updated += r.data.updated; tot.unchanged += r.data.unchanged; tot.calls++;
      }
      return { kind: "ok", data: tot };
    },
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
//   特典チケットのコード(lookupCode の結果が kind="ticket")のときは state に kind:"ticket" と ticket(title など)が付き、
//   確定の結果は done(title)/ expired(コードの期限)/ ticket_used(使用済み)/ ticket_expired(チケットの期限)/ cancelled / not_found
//   ポイント・チケットとも、コードを出した後に会員が停止されたときは member_inactive(DB が申請を取り消す。db/109)
export const redeemInitial = { step: "idle" };
// お客様のコード: 全角の数字(iPad の日本語キーボード)や空白を半角の数字だけにする(ペルソナ実験 2026-10-17)
export const normalizeCode = (code) => String(code ?? "").normalize("NFKC").replace(/[\s-]/g, "");
export const isCodeShape = (code) => /^\d{6}$/.test(normalizeCode(code));

export function redeemReduce(state, ev) {
  switch (ev.type) {
    case "lookup_start": return { step: "looking_up" };
    case "lookup_result": {
      const r = ev.result;
      if (r.kind === "locked") return { step: "locked" };
      if (r.kind !== "ok") return r.kind === "forbidden" || r.kind === "not_staff" ? { step: "forbidden" } : { step: "error", retry: true };
      if (r.data.status === "ok" && r.data.kind === "ticket") return { step: "confirm", kind: "ticket", request: r.data.request, member: r.data.member, ticket: r.data.ticket };
      return r.data.status === "ok" ? { step: "confirm", request: r.data.request, member: r.data.member } : { step: "not_found" };
    }
    case "confirm_start": return state.step === "confirm" ? { ...state, step: "confirming" } : state;      // 二重押し下げは無視
    case "confirm_result": {
      const r = ev.result, ticket = state.kind === "ticket";
      if (r.kind !== "ok") return { step: "error", retry: true, request: state.request, member: state.member, ...(ticket ? { kind: "ticket", ticket: state.ticket } : {}) };   // 結果不明: 同じ申請で再確認(確定は冪等)
      const st = r.data.status;
      if (ticket) {
        if (st === "confirmed" || st === "already_confirmed") return { step: "done", kind: "ticket", title: r.data.title ?? state.ticket?.title ?? null };
        if (st === "expired" || st === "ticket_used" || st === "ticket_expired" || st === "member_inactive") return { step: st };
        return { step: st === "cancelled" ? "cancelled" : "not_found" };
      }
      if (st === "confirmed" || st === "already_confirmed") return { step: "done", points: r.data.points, yen: r.data.yen, balanceAfter: r.data.balanceAfter ?? null };
      if (st === "expired") return { step: "expired" };
      if (st === "insufficient_balance") return { step: "insufficient", balance: r.data.points };
      if (st === "member_inactive") return { step: "member_inactive" };
      return { step: st === "cancelled" ? "cancelled" : "not_found" };
    }
    case "reset": return redeemInitial;
    default: return state;
  }
}

// 店頭QRの表示(タブレット)。トークンは30秒ごとに変わるので、切替の少し前に取得し直す。
// 取得できない状態が続いて期限(約90秒)を過ぎたら QR を隠す(古い QR を表示し続けない)。
export function createQrKiosk({ getToken, onUpdate, onHidden, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, hideAfterMs = 90_000, fetchTimeoutMs = 10_000 }) {
  let timer = null, stopped = false, lastOkAt = 0;
  // 応答が返ってこないときも先へ進む(10秒で打ち切って失敗として扱い、5秒後にやり直す。約90秒で古い QR を隠す。外部レビュー 2026-10-20)
  const fetchToken = () => new Promise((resolve) => {
    const t = setTimer(() => resolve({ kind: "error", timeout: true }), fetchTimeoutMs);
    Promise.resolve().then(getToken).then((r) => { clearTimer(t); resolve(r); }, () => { clearTimer(t); resolve({ kind: "error" }); });
  });
  async function tick() {
    if (stopped) return;
    const r = await fetchToken();
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
