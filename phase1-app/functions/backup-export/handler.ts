// バックアップの書き出し(Google Apps Script の毎日のトリガーから呼ぶ)。会員・台帳・設定の全体を JSON で返す。個人情報を含む。
//  認証: Authorization: Bearer <トークン>。トークン = HMAC-SHA256(MEMBERSHIP_CHECKIN_SECRET, "backup-export-v1") の hex。
//        秘密そのものは送らない・新しい秘密を増やさない(GAS 側は同じ秘密から計算できる)。
//  action=export: { sha256, payload(JSON文字列), counts }  → 受け取った側が sha256 を再計算して照合する
//  action=record: { ok, sha256, counts, note } を backup_runs に記録(失敗の記録も可)
export interface Deps { supabase: any; secret: string; nowMs: () => number }

const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function backupToken(secret: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("backup-export-v1")));
}
export async function sha256Hex(text: string): Promise<string> { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))); }
const safeEq = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const m = /^Bearer\s+([0-9a-f]{64})$/.exec(req.headers.get("authorization") || "");
  if (!m || !d.secret || !safeEq(m[1], await backupToken(d.secret))) return json({ error: "unauthorized" }, 401);
  let body: any; try { body = JSON.parse((await req.text()) || "{}"); } catch (_e) { return json({ error: "bad_request" }, 400); }
  if (body === null || typeof body !== "object") return json({ error: "bad_request" }, 400);
  if (body.action === "export") {
    const { data, error } = await d.supabase.rpc("export_backup", {});
    if (error) { console.error(`backup-export failed: ${String(error.message).slice(0, 200)}`); return json({ error: "server_error" }, 500); }
    const payload = JSON.stringify(data);
    const counts: Record<string, number> = {}; for (const [k, v] of Object.entries((data as any).tables)) counts[k] = (v as unknown[]).length;
    return json({ sha256: await sha256Hex(payload), payload, counts });
  }
  if (body.action === "record") {
    const ok = body.ok === true;
    const { error } = await d.supabase.rpc("record_backup", { p_ok: ok, p_sha256: ok && typeof body.sha256 === "string" ? body.sha256 : null, p_rows: ok && body.counts && typeof body.counts === "object" ? body.counts : null, p_note: typeof body.note === "string" ? body.note.slice(0, 300) : null });
    if (error) return json({ error: "server_error" }, 500);
    return json({ status: "recorded" });
  }
  return json({ error: "unknown_action" }, 400);
}
