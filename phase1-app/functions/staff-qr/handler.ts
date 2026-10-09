// 店頭タブレット用: ログイン済みスタッフにだけ、現在の店頭QRトークン(30秒で変わる)を返す。
import { makeToken } from "./qr.ts";

export interface Deps {
  supabase: any;                 // service_role クライアント
  qrSecret: string;
  businessUnit: string;
  liffUrl: string;               // 例: https://liff.line.me/2011158053-N7nKgExB
  allowedOrigins: string[];
  nowMs: () => number;
}
const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });

export async function handle(req: Request, d: Deps): Promise<Response> {
  const o = req.headers.get("origin");
  const ch: Record<string, string> = o && d.allowedOrigins.includes(o)
    ? { "Access-Control-Allow-Origin": o, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" } : {};
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ch });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, ch);
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(req.headers.get("authorization") || "");
  if (!m || !d.qrSecret) return json({ error: "unauthorized" }, 401, ch);
  const { data: u, error } = await d.supabase.auth.getUser(m[1]);
  if (error || !u?.user?.id) return json({ error: "unauthorized" }, 401, ch);
  const { data: st } = await d.supabase.from("staff_users").select("role, active").eq("user_id", u.user.id).maybeSingle();
  if (!st || !st.active || (st.role !== "staff" && st.role !== "manager" && st.role !== "kiosk")) return json({ error: "forbidden" }, 403, ch);   // 閲覧のみのスタッフには出さない。kiosk(店頭タブレット専用アカウント)は QR の取得だけができる
  const t = await makeToken(d.qrSecret, d.businessUnit, d.nowMs());
  return json({ token: t.token, slot: t.slot, nextChangeAt: t.nextChangeAt, url: `${d.liffUrl}?action=visit&t=${encodeURIComponent(t.token)}` }, 200, ch);
}
