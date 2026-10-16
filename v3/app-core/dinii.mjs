// ダイニーの注文画面への入口(体質チェックの結果画面の「このまま注文する」。2026-10-16 牧野さん承認・ダイニー導入まで出さない)。
//  * お客様がテーブルのQRを LIFF のカメラ(liff.scanCodeV2)で読み取り、10ZEN の店舗のダイニーの注文用のQRのときだけ、その URL を開く。ほかの URL は開かない。
//  * ダイニーの QR の形(ダイニーの回答 2026-10-16):
//      1. https://web.self.dinii.jp/gateway?shopId=<店舗ID>&tableCode=<テーブル>
//      2. LINE 連携あり: https://liff.line.me/<ダイニーの LIFF ID(店舗ごと)>/shops/<店舗ID>/items?shopId=<店舗ID>&tableCode=<テーブル>(末尾に1つ増えることがある)
//  * 店舗ID・LIFF ID は導入時に発行される。config.js の diniiShopId が空の間はボタンを出さない(diniiEnabled)。
//  * (2026-10-16 牧野さん承認)お席に置く10ZEN の QR(体質チェック → そのまま注文)。QR は会員証の LIFF の check.html?table=<テーブル>。
//    結果の「このまま注文する」は、読み直さずにそのテーブルのダイニーの注文画面を開く(diniiTableUrl)。お席の QR から入った人だけに出すので、
//    家でチェックした人には出ない。お席の QR から入っていなくても、店頭の QR で来店した日は、お席の QR を読み取るボタン(diniiOrderUrl)を出す。
const ID_RE = /^[0-9A-Za-z-]{8,64}$/;
const TABLE_RE = /^[0-9A-Za-z_-]{1,64}$/;
const LIFF_RE = /^[0-9]{10}-[A-Za-z0-9]{8}$/;

export function diniiEnabled(cfg) { return typeof cfg?.diniiShopId === "string" && ID_RE.test(cfg.diniiShopId); }

export function diniiOrderUrl(text, { shopId, liffId } = {}) {
  if (typeof text !== "string" || text.length > 512 || typeof shopId !== "string" || !ID_RE.test(shopId)) return null;
  let u; try { u = new URL(text.trim()); } catch (_e) { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const table = u.searchParams.get("tableCode");
  if (u.searchParams.get("shopId") !== shopId || !table || !TABLE_RE.test(table)) return null;
  if (u.hostname === "web.self.dinii.jp" && u.pathname === "/gateway") return u.href;
  if (u.hostname === "liff.line.me" && typeof liffId === "string" && LIFF_RE.test(liffId) && u.pathname === `/${liffId}/shops/${shopId}/items`) return u.href;
  return null;
}

// お席の QR から入ったテーブル(?table=)。形が違えば null
export function tableFromParam(v) { return typeof v === "string" && TABLE_RE.test(v) ? v : null; }
// そのテーブルのダイニーの注文画面。LIFF ID があれば LINE 連携の形(LINE の中で開く)、なければ通常の形
export function diniiTableUrl(table, { shopId, liffId } = {}) {
  if (!tableFromParam(table) || typeof shopId !== "string" || !ID_RE.test(shopId)) return null;
  const q = `shopId=${encodeURIComponent(shopId)}&tableCode=${encodeURIComponent(table)}`;
  return typeof liffId === "string" && LIFF_RE.test(liffId) ? `https://liff.line.me/${liffId}/shops/${shopId}/items?${q}` : `https://web.self.dinii.jp/gateway?${q}`;
}
// お席に置く QR の中身(会員証の LIFF の体質チェック。?table= にテーブル)
export function tableQrUrl(liffId, table) {
  return typeof liffId === "string" && LIFF_RE.test(liffId) && tableFromParam(table) ? `https://liff.line.me/${liffId}/check.html?table=${encodeURIComponent(table)}` : null;
}
// お席の QR の一覧(table-qr.html の入力。1行に「表示名,テーブルコード」。表示名を省くとテーブルコードを表示名にする)→ { rows, skipped }
export const TABLE_QR_MAX = 100;
export function parseTableList(text) {
  const rows = [], skipped = [], seen = new Set();
  String(text ?? "").split(/\r?\n/).slice(0, 1000).forEach((raw, i) => {
    const line = raw.trim(); if (!line) return;
    const parts = line.split(/[,\t、]/).map((x) => x.trim());
    const table = parts.length > 1 ? parts[parts.length - 1] : parts[0], label = (parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0]).slice(0, 20);
    if (!tableFromParam(table)) return skipped.push({ line: i + 1, reason: "テーブルコードの形が違います" });
    if (seen.has(table)) return skipped.push({ line: i + 1, reason: "同じテーブルコードが2回目です" });
    if (rows.length >= TABLE_QR_MAX) return skipped.push({ line: i + 1, reason: `一度に作れるのは${TABLE_QR_MAX}枚までです` });
    seen.add(table); rows.push({ label: label || table, table });
  });
  return { rows, skipped };
}
export const TABLE_POP = Object.freeze({ title: "1分体質チェック", scan: "スマホのカメラで読み取ってください(LINE が開きます)", after: "チェックのあと、このままご注文いただけます" });

// お席の QR から入ったことを、会員登録などで画面を移っても覚えておく(この端末の中だけ・4時間)
export const TABLE_KEY = "10zen_dinii_table";
export const TABLE_TTL_MS = 4 * 3600e3;
export function rememberTable(storage, table, nowMs = Date.now()) {
  const t = tableFromParam(table); if (!t) return;
  try { storage?.setItem(TABLE_KEY, JSON.stringify({ t, at: nowMs })); } catch (_e) { /* 使えない端末では覚えない */ }
}
export function recallTable(storage, nowMs = Date.now()) {
  let v = null; try { v = JSON.parse(storage?.getItem(TABLE_KEY) ?? "null"); } catch (_e) { return null; }
  return v && tableFromParam(v.t) && Number.isFinite(v.at) && nowMs - v.at >= 0 && nowMs - v.at < TABLE_TTL_MS ? v.t : null;
}

export const ORDER_LABEL = "ご注文";
export const ORDER_BUTTON = "このまま注文する(お席のQRを読み取る)";
export const ORDER_BUTTON_TABLE = "このまま注文する";
export const ORDER_NOT_DINII = "10ZEN の注文用のQRではありません。お席のQRを読み取ってください。";
export const ORDER_NO_SCAN = "お席のQRを、スマホのカメラで読み取ってご注文ください。";
