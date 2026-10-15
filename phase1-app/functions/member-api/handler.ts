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
      if (/maintenance/.test(error.message || "")) throw Object.assign(new Error("maintenance"), { status: 503 });   // 凍結中・試験中(許可外)・切替作業中
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
        // 友だち紹介(db/106): 招待のリンクの ?ref= のコード(12文字)。形の違うものは無視して通常の登録。会員番号での紹介(旧 referrerMemberNo)は受け付けない。
        //  コードがあるときだけ p_invite_code を渡す(106 より前の DB でも、コードなしの登録はそのまま動く)
        const code = typeof body.inviteCode === "string" && /^[A-Za-z0-9_-]{12}$/.test(body.inviteCode) ? body.inviteCode : null;
        const r = await rpc("app_register", { p_issuer: issuer, p_subject: subject, p_display_name: nm.slice(0, 200), p_now: now, ...(code ? { p_invite_code: code } : {}) });
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
      // 特典チケットの使用申請(db/102_rank_perks.sql)。チケットが本人のものかどうかは DB の関数が確認する
      case "ticket_request": {
        if (typeof body.ticketId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.ticketId)) return json({ error: "invalid_ticket" }, 400, ch);
        const r = await rpc("app_ticket_request", { p_issuer: issuer, p_subject: subject, p_ticket_id: body.ticketId.toLowerCase(), p_now: now });
        return json(r, r.status === "not_registered" ? 404 : r.status === "pending" ? 200 : 409, ch);
      }
      case "ticket_cancel": {
        const r = await rpc("app_ticket_cancel", { p_issuer: issuer, p_subject: subject, p_now: now });
        return json(r, r.status === "not_registered" ? 404 : 200, ch);
      }
      // 1分体質チェック(db/103_constitution_check.sql)。点数・タイプはクライアントから受け取らない(回答から DB が計算する)
      case "constitution_submit": {
        const a = body.answers;
        if (!Array.isArray(a) || a.length !== 15 || !a.every((x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 2)) return json({ error: "invalid_answers" }, 400, ch);
        if (typeof body.mood !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(body.mood)) return json({ error: "invalid_mood" }, 400, ch);
        if (body.consent !== undefined && typeof body.consent !== "boolean") return json({ error: "bad_request" }, 400, ch);
        const r = await rpc("app_constitution_submit", { p_issuer: issuer, p_subject: subject, p_answers: a, p_mood: body.mood, p_consent: body.consent === true, p_now: now });
        if (r.status === "invalid_answers" || r.status === "invalid_mood") return json({ error: r.status }, 400, ch);
        return json(r, r.status === "not_registered" ? 404 : r.status === "ok" ? 200 : 409, ch);      // 409: consent_required
      }
      // 非推奨(2026-10-15・db/107): 今日の体調(3問)は廃止。今の会員証は送らない。古い画面との互換のためだけに残す
      case "condition_submit": {
        const okv = (v: unknown, list: string[]) => typeof v === "string" && list.includes(v);
        if (!okv(body.temp, ["cold", "hot", "normal"]) || !okv(body.energy, ["tired", "stress", "fine"]) || !okv(body.concern, ["dry", "swelling", "none"])) return json({ error: "invalid_condition" }, 400, ch);
        const r = await rpc("app_condition_submit", { p_issuer: issuer, p_subject: subject, p_temp: body.temp, p_energy: body.energy, p_concern: body.concern, p_now: now });
        if (r.status === "invalid_condition") return json({ error: r.status }, 400, ch);
        return json(r, r.status === "not_registered" ? 404 : r.status === "ok" ? 200 : 409, ch);      // 409: already_answered / no_check
      }
      // 友だち紹介のお知らせ(「お友だちが来店しました」)を会員証が表示した。until(表示したお知らせの時刻)までの分を既読にする
      case "invite_seen": {
        if (typeof body.until !== "string" || body.until.length > 40 || !Number.isFinite(Date.parse(body.until))) return json({ error: "bad_request" }, 400, ch);
        const r = await rpc("app_invite_seen", { p_issuer: issuer, p_subject: subject, p_until: new Date(Date.parse(body.until)).toISOString(), p_now: now });
        return json(r, r.status === "not_registered" ? 404 : 200, ch);
      }
      case "referral_click": {
        const r = await rpc("app_referral_click", { p_issuer: issuer, p_subject: subject, p_now: now });
        return json(r, r.status === "not_registered" ? 404 : 200, ch);
      }
      default: return json({ error: "unknown_action" }, 400, ch);
    }
  } catch (e) {
    const st = (e as any).status || 500;
    if (st === 503 && (e as Error).message === "maintenance") return json({ error: "maintenance", retryable: false }, 503, { ...ch, "Retry-After": "300" });
    return json({ error: st === 429 ? "rate_limited" : "server_error", retryable: st !== 429 }, st, ch);
  }
}
