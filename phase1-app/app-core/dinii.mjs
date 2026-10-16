// ダイニーの注文画面への入口(体質チェックの結果画面の「このまま注文する」。2026-10-16 牧野さん承認・ダイニー導入まで出さない)。
//  * お客様がテーブルのQRを LIFF のカメラ(liff.scanCodeV2)で読み取り、10ZEN の店舗のダイニーの注文用のQRのときだけ、その URL を開く。ほかの URL は開かない。
//  * ダイニーの QR の形(ダイニーの回答 2026-10-16):
//      1. https://web.self.dinii.jp/gateway?shopId=<店舗ID>&tableCode=<テーブル>
//      2. LINE 連携あり: https://liff.line.me/<ダイニーの LIFF ID(店舗ごと)>/shops/<店舗ID>/items?shopId=<店舗ID>&tableCode=<テーブル>(末尾に1つ増えることがある)
//  * 店舗ID・LIFF ID は導入時に発行される。config.js の diniiShopId が空の間はボタンを出さない(diniiEnabled)。
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

export const ORDER_LABEL = "ご注文";
export const ORDER_BUTTON = "このまま注文する(お席のQRを読み取る)";
export const ORDER_NOT_DINII = "10ZEN の注文用のQRではありません。お席のQRを読み取ってください。";
export const ORDER_NO_SCAN = "お席のQRを、スマホのカメラで読み取ってご注文ください。";
