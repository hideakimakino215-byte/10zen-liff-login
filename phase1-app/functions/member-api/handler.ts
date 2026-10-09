// お客様向け API(1つの関数・POST のみ)。クライアントが送る lineUserId 等は一切信頼しない。
//  認証: LIFF の ID トークン(ヘッダー x-liff-id-token)を LINE の検証 API で確認し、検証済みの sub だけを使う。
//  来店: 店頭QRの回転トークンを検証してから、DB の関数で「1日1回」を保証して付与する。
//  すべて冪等。再送しても二重にならない。応答に外部ID(LINE の sub 等)や内部IDは含めない。
import { verifyToken } from "./qr.ts";

export interface Deps {
  fetchFn: typeof fetch;
  supabase: any;                    // service_role クライアント(サーバ側のみ)
  lineLoginChannelId: string;       // LINE ログインのチャネルID(LIFF ID の先頭の数字。秘密ではない)
  qrSecret: string;                 // MEMBERSHIP_CHECKIN_SECRET(Supabase Secrets)。店頭QRの署名鍵の元
  businessUnit: string;
  allowedOrigins: string[];         // 会員証画面の配信元(CORS)。空なら CORS ヘッダーを付けない
  nowMs: () => number;
  graceSlots?: number;
}

const MAX_BODY = 4096;
function peekJwt(t: string): any | null {
  const parts = t.split(".");
  if (parts.length !== 3 || !parts.every((x) => /^[A-Za-z0-9_-]+$/.test(x))) return null;
  try {
    const b = parts[1].replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch (_e) { return null; }
}
const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });

function cors(req: Request, d: Deps): Record<string, string> {
  const o = req.headers.get("origin");
  if (o && d.allowedOrigins.includes(o)) {
    return { "Access-Control-Allow-Origin": o, "Vary": "Origin", "Access-Control-Allow-Headers": "content-type, x-liff-id-token", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "600" };
  }
  return {};
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  const ch = cors(req, d);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ch });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, ch);

  const idToken = req.headers.get("x-liff-id-token") || "";
  if (!idToken || idToken.length > 4096 || !d.lineLoginChannelId) return json({ error: "unauthorized" }, 401, ch);
  // 形式と有効期限を先に確認(ここでは信頼しない。明らかに不正・期限切れのものは LINE の検証 API を呼ばずに拒否する)
  const pre = peekJwt(idToken);
  if (!pre || pre.aud !== d.lineLoginChannelId || typeof pre.exp !== "number" || pre.exp <= Math.floor(d.nowMs() / 1000)) return json({ error: "unauthorized" }, 401, ch);

  let raw = "";
  try { raw = await req.text(); } catch (_e) { return json({ error: "bad_request" }, 400, ch); }
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413, ch);
  let body: any;
  try { body = raw ? JSON.parse(raw) : {}; } catch (_e) { return json({ error: "bad_request" }, 400, ch); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_request" }, 400, ch);

  // 1) ID トークンの検証(署名・期限・client_id は LINE 側。こちらでも多重に確認)
  let claims: any;
  try {
    const res = await d.fetchFn("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: d.lineLoginChannelId }).toString(),
    });
    if (!res.ok) return json({ error: "unauthorized" }, 401, ch);
    claims = await res.json();
  } catch (_e) { return json({ error: "upstream_unavailable", retryable: true }, 503, ch); }
  if (!claims || typeof claims.sub !== "string" || !/^U[0-9a-f]{32}$/.test(claims.sub) || claims.aud !== d.lineLoginChannelId ||
      typeof claims.exp !== "number" || claims.exp <= Math.floor(d.nowMs() / 1000)) return json({ error: "unauthorized" }, 401, ch);
  const issuer = d.lineLoginChannelId, subject = claims.sub as string;
  const now = new Date(d.nowMs()).toISOString();
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await d.supabase.rpc(name, args);
    if (error) {
      if (/rate_limited/.test(error.message || "")) throw Object.assign(new Error("rate_limited"), { status: 429 });
      console.error(`member-api rpc ${name} failed: ${String(error.message).slice(0, 200)}`);
      throw Object.assign(new Error("server_error"), { status: 500 });
    }
    return data;
  };

  try {
    switch (body.action) {
      case "me": {
        const r = await rpc("app_me", { p_issuer: issuer, p_subject: subject, p_now: now });
        return json(r.status === "ok" ? { status: "ok", member: r.member } : { status: "not_registered" }, r.status === "ok" ? 200 : 404, ch);
      }
      case "register": {
        // 表示名は検証済みの ID トークン(name)を優先。無ければクライアント値(整形のみ・信頼しない)
        const nm = typeof claims.name === "string" && claims.name ? claims.name : (typeof body.displayName === "string" ? body.displayName : "");
        const ref = typeof body.referrerMemberNo === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(body.referrerMemberNo) ? body.referrerMemberNo : null;
        const r = await rpc("app_register", { p_issuer: issuer, p_subject: subject, p_display_name: nm.slice(0, 200), p_referrer_member_no: ref, p_now: now });
        return json(r, r.status === "created" ? 201 : 200, ch);
      }
      case "checkin": {
        const v = await verifyToken(d.qrSecret, d.businessUnit, body.token, d.nowMs(), d.graceSlots ?? 3);
        if (!v.ok) return json({ error: v.reason === "expired" ? "qr_expired" : "invalid_qr" }, 400, ch);
        const r = await rpc("app_checkin", { p_issuer: issuer, p_subject: subject, p_token_slot: v.slot, p_now: now });
        return json(r, r.status === "not_registered" ? 404 : 200, ch);
      }
      case "redeem_request": {
        if (!Number.isInteger(body.points) || body.points <= 0 || body.points > 10_000_000) return json({ error: "invalid_amount" }, 400, ch);
        const r = await rpc("app_redeem_request", { p_issuer: issuer, p_subject: subject, p_points: body.points, p_now: now });
        const st = r.status === "not_registered" ? 404 : (r.status === "invalid_amount" || r.status === "insufficient_balance" || r.status === "already_pending") ? 409 : 200;
        return json(r, st, ch);
      }
      case "redeem_cancel": {
        const r = await rpc("app_redeem_cancel", { p_issuer: issuer, p_subject: subject, p_now: now });
        return json(r, r.status === "not_registered" ? 404 : 200, ch);
      }
      default: return json({ error: "unknown_action" }, 400, ch);
    }
  } catch (e) {
    const st = (e as any).status || 500;
    return json({ error: st === 429 ? "rate_limited" : "server_error", retryable: st !== 429 }, st, ch);
  }
}
