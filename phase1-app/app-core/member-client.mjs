// お客様向け API クライアント(見た目に依存しない。ブラウザ・Node 両方で動く。依存なし)。
// UI はこの結果(kind / data)だけを見て画面を切り替える。通信・再試行・エラー分類はここで完結する。
//   kind: ok / auth_required / not_registered / conflict / bad_request / rate_limited / maintenance / network_error / server_error
export function createMemberClient({ endpoint, getIdToken, fetchFn = (...a) => fetch(...a), timeoutMs = 10000, retries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function call(action, body = {}) {
    let idToken;
    try { idToken = await getIdToken(); } catch (_e) { return { kind: "auth_required" }; }
    if (!idToken) return { kind: "auth_required" };
    let last = { kind: "network_error", retryable: true };
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      try {
        const res = await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-liff-id-token": idToken }, body: JSON.stringify({ action, ...body }), signal: ctl?.signal });
        const data = await res.json().catch(() => ({}));
        const s = res.status;
        if (s === 200 || s === 201) return { kind: "ok", status: data.status, httpStatus: s, data };
        if (s === 503 && data.error === "maintenance") return { kind: "maintenance" };      // 切替作業中・試験中(再試行しても変わらない)
        if (s === 401) return { kind: "auth_required" };
        if (s === 404) return { kind: "not_registered", data };
        if (s === 409) return { kind: "conflict", code: data.status, data };
        if (s === 400) return { kind: "bad_request", code: data.error };
        if (s === 429) return { kind: "rate_limited" };
        last = { kind: "server_error", httpStatus: s, retryable: !!data.retryable || s >= 500 };
        if (!last.retryable) return last;
      } catch (_e) { last = { kind: "network_error", retryable: true }; }
      finally { if (timer) clearTimeout(timer); }
    }
    return last;
  }
  return {
    me: () => call("me"),
    // displayName は ID トークンに氏名(name)が無い場合の予備。サーバーはトークン内の氏名を優先し、予備の値は整形のみで信頼しない
    register: ({ referrerMemberNo, displayName } = {}) => call("register", { ...(referrerMemberNo ? { referrerMemberNo } : {}), ...(displayName ? { displayName: String(displayName).slice(0, 80) } : {}) }),
    checkin: (qrToken) => call("checkin", { token: qrToken }),
    redeemRequest: (points) => call("redeem_request", { points }),
    redeemCancel: () => call("redeem_cancel"),
  };
}

// 店頭QRのURL(?action=visit&t=...)から QR トークンを取り出す
export function qrTokenFromLocation(search) {
  const p = new URLSearchParams(search || "");
  const action = p.get("action"), t = p.get("t");
  return action === "visit" && t && /^[0-9]{1,12}\.[A-Za-z0-9_-]{22}$/.test(t) ? t : null;
}
