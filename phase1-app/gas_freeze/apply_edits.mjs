// コード.gs への最終編集(A3 手順4)を機械的に適用・検証する。ChatGPT/担当者が画面で行う編集と同一の内容を、ここで定義する。
//   node --experimental-strip-types apply_edits.mjs <入力テキスト> [出力ファイル]
// 各編集は『一致箇所がちょうど1つ』であることを確認してから適用する(0個・複数個ならエラー。推測で適用しない)。秘密値は読まない・出力しない。
import fs from "node:fs";
export const GUARDS = [
  ["function doGet(e) {", "var fg_ = freezeGuardGet_(e); if (fg_) return fg_;"],
  ["function lineEntry(lineUserId, displayName, refCode, action) {", "freezeGuard_();"],
  ["function registerNewUser(displayName, refCode) {", "freezeGuard_();"],
  ["function processUser(userId, action) {", "freezeGuard_();"],
  ["function usePoints(userId, useAmount, inputPin) {", "freezeGuard_();"],
  ["function getAdminDashboardData() {", "freezeGuard_();"],
];
// notifyNexto( の呼び出し2か所(どちらも lineEntry の中)。定義は notifyNextoLegacyUnused_ に改名済みなので、この形に一致するのは呼び出しだけ
export const RENAME_RE = /(?<![A-Za-z0-9_])notifyNexto\(/g;
// キャンペーン停止: 期間の終了日だけを過去に変える。条件 if (now >= CAMPAIGN_START && now <= CAMPAIGN_END) が常に偽になり、
// 0pt の履歴行も案内文も作られない(登録処理の本体は一切変更しない)。ボーナス額・開始日・他の記述は変更しない。
export const CAMPAIGN_FROM = 'const CAMPAIGN_END = new Date("2026-10-31T23:59:59+09:00");';
export const CAMPAIGN_TO = 'const CAMPAIGN_END = new Date("2000-01-01T00:00:00+09:00"); // 旧GASのキャンペーンは停止(2026-10-09 決定)。開始日より前の日付にして、期間条件を常に偽にする';
const count = (s, sub) => s.split(sub).length - 1;
export function applyEdits(src) {
  let out = src; const log = [];
  for (const [sig, add] of GUARDS) {
    if (count(out, sig) !== 1) throw new Error(`入口の宣言行が1つではありません(${count(out, sig)}個): ${sig}`);
    out = out.replace(sig, () => sig + "\n  " + add); log.push("guard: " + sig.split("(")[0].replace("function ", ""));
  }
  const m = out.match(RENAME_RE) || [];
  if (m.length !== 2) throw new Error(`notifyNexto( の呼び出しが2か所ではありません(${m.length}か所)`);
  out = out.replace(RENAME_RE, "notifyNexto_("); log.push("rename: notifyNexto( -> notifyNexto_( x2");
  if (count(out, CAMPAIGN_FROM) !== 1) throw new Error("CAMPAIGN_END の行が想定の形で1つ見つかりません");
  out = out.replace(CAMPAIGN_FROM, () => CAMPAIGN_TO); log.push("campaign: CAMPAIGN_END -> 2000-01-01");
  return { out, log };
}
if (process.argv[1] && process.argv[1].endsWith("apply_edits.mjs") && process.argv[2]) {
  const r = applyEdits(fs.readFileSync(process.argv[2], "utf8"));
  console.log(r.log.join("\n")); if (process.argv[3]) fs.writeFileSync(process.argv[3], r.out);
}
