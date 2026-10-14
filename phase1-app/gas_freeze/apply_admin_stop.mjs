// A-1: 旧GASの管理ページ(?page=admin)と管理ダッシュボードの読み取り関数を停止する(2か所)。
// 理由: Web アプリは『全員(匿名)に公開』のため、オーナーだけを通す判定ができない。URL を知る人が会員情報を読めてしまう状態を止める。
// 前提: apply_edits.mjs の適用後のコード.gs に対して使う。一致箇所がちょうど1つでなければ適用しない。
//   node --experimental-strip-types apply_admin_stop.mjs <入力> [出力]
import fs from "node:fs";
export const DOGET_FROM = "if (e.parameter && e.parameter.page === 'admin') {";
export const DOGET_ADD = "    return HtmlService.createHtmlOutput('<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><p style=\"font-family:sans-serif;padding:24px\">この管理ページは停止しました。</p>'); /* 停止(A-1): 以降の管理画面の処理には到達しない */";
export const DASH_FROM = "function getAdminDashboardData() {\n  freezeGuard_();";
export const DASH_ADD = "\n  throw new Error('管理ダッシュボードは停止しました'); /* 停止(A-1): 画面からの直接呼び出しも拒否する */";
const count = (s, sub) => s.split(sub).length - 1;
export function applyAdminStop(src) {
  let out = src;
  if (count(out, DOGET_FROM) !== 1) throw new Error("doGet の管理ページ分岐が1つではありません: " + count(out, DOGET_FROM));
  out = out.replace(DOGET_FROM, () => DOGET_FROM + "\n" + DOGET_ADD);
  if (count(out, DASH_FROM) !== 1) throw new Error("getAdminDashboardData の先頭(freezeGuard_ の直後)が想定の形ではありません: " + count(out, DASH_FROM));
  out = out.replace(DASH_FROM, () => DASH_FROM + DASH_ADD);
  return out;
}
if (process.argv[1] && process.argv[1].endsWith("apply_admin_stop.mjs") && process.argv[2]) {
  const out = applyAdminStop(fs.readFileSync(process.argv[2], "utf8")); if (process.argv[3]) fs.writeFileSync(process.argv[3], out); console.log("admin stop applied");
}
