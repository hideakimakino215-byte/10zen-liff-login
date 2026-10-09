// 店頭QRの回転トークン(30秒ごとに変わる)。QRに載せるのは「現在のスロット番号+署名」だけで、個人情報は含まない。
// 署名鍵は共有秘密(MEMBERSHIP_CHECKIN_SECRET)から用途ラベル付きで派生させるので、新しい秘密を増やさない。
// 有効なのは「現在のスロットから grace 個前まで〜1個先」。QRの写真を店外へ送っても、数分以内に無効になる。
export const SLOT_SEC = 30;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(keyBytes: Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function qrKey(secret: string): Promise<Uint8Array> { return await hmac(enc.encode(secret), "10zen-store-qr-v1"); }

export function slotOf(nowMs: number): number { return Math.floor(nowMs / 1000 / SLOT_SEC); }

export async function makeToken(secret: string, unit: string, nowMs: number): Promise<{ token: string; slot: number; nextChangeAt: number }> {
  const slot = slotOf(nowMs);
  const sig = b64url(await hmac(await qrKey(secret), `checkin|${unit}|${slot}`)).slice(0, 22);
  return { token: `${slot}.${sig}`, slot, nextChangeAt: (slot + 1) * SLOT_SEC * 1000 };
}

export type QrCheck = { ok: true; slot: number } | { ok: false; reason: "malformed" | "forged" | "expired" | "future" };
export async function verifyToken(secret: string, unit: string, token: unknown, nowMs: number, graceSlots = 3): Promise<QrCheck> {
  if (typeof token !== "string" || token.length > 64 || !/^[0-9]{1,12}\.[A-Za-z0-9_-]{22}$/.test(token)) return { ok: false, reason: "malformed" };
  const [s, sig] = token.split(".");
  const slot = Number(s);
  const expect = b64url(await hmac(await qrKey(secret), `checkin|${unit}|${slot}`)).slice(0, 22);
  let diff = sig.length ^ expect.length;                       // 定数時間比較
  for (let i = 0; i < expect.length; i++) diff |= (sig.charCodeAt(i) || 0) ^ expect.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: "forged" };
  const cur = slotOf(nowMs);
  if (slot > cur + 1) return { ok: false, reason: "future" };
  if (slot < cur - graceSlots) return { ok: false, reason: "expired" };
  return { ok: true, slot };
}
