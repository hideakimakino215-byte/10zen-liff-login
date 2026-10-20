// 目標と KPI の画面用の定義(見た目に依存しない)。数字は DB の staff_kpi_overview(db/105_kpi.sql)が計算する。ここは名前・単位・色の判定だけ。
// コードの並びは画面の並び(カードと表)。isRate=true は %(目標は 0〜100)、false は月の件数(目標は整数)。
export const KPI_DEFS = [
  { code: "member_visit_rate", label: "会員来店率", unit: "%", isRate: true, main: true,
    help: "会員の来店数 ÷ レジの客数。客数を取り込んだ日の来店で割ります" },
  { code: "new_members", label: "新規登録数", unit: "人", isRate: false,
    help: "その月に登録した会員(移行で取り込んだ会員は除く)。今月は経過日数で日割りした目標と比べます" },
  { code: "check_rate", label: "体質チェック実施率", unit: "%", isRate: true,
    help: "月末(今月は今)の有効会員のうち、体質チェックをした会員の割合" },
  { code: "revisit_rate", label: "再来店率", unit: "%", isRate: true,
    help: "有効会員のうち、直近60日に2日以上来店した会員の割合(体質チェックの集計と同じ決め方)" },
  { code: "referral_clicks", label: "薬日本堂への送客", unit: "回", isRate: false,
    help: "体質チェックの結果の「薬日本堂の漢方相談へ」が押された回数(実際の相談の件数ではありません)。今月は経過日数で日割りした目標と比べます" },
];
export const KPI_BY_CODE = Object.fromEntries(KPI_DEFS.map((d) => [d.code, d]));
export const MILESTONES = [3, 6, 12];

// 達成率 → 色の区分: 100% 以上=ok(緑)・80〜99%=warn(オレンジ)・80% 未満=bad(赤)・目標なし/実績なし=none(灰色)
export function statusOf(achievementPercent) {
  if (typeof achievementPercent !== "number" || !Number.isFinite(achievementPercent)) return "none";
  return achievementPercent >= 100 ? "ok" : achievementPercent >= 80 ? "warn" : "bad";
}
export const STATUS_LABELS = { ok: "達成", warn: "あと少し", bad: "未達", none: "目標なし" };

// 目標の入力値の確認(DB と同じ決まり)。空欄は null(目標なし)。戻り値 { ok, value } / { ok:false, reason }
export function parseTargetInput(code, text) {
  const s = String(text ?? "").trim().replace(/[０-９．]/g, (c) => (c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0))).replace(/[%％,人回]/g, "");
  if (s === "") return { ok: true, value: null };
  const d = KPI_BY_CODE[code]; if (!d) return { ok: false, reason: "invalid_kpi" };
  if (d.isRate ? !/^\d{1,3}(\.\d)?$/.test(s) : !/^\d{1,6}$/.test(s)) return { ok: false, reason: "invalid_target" };
  const v = Number(s);
  if (d.isRate ? v > 100 : v > 100000) return { ok: false, reason: "invalid_target" };
  return { ok: true, value: v };
}

// 表示用: 実績(率は小数1桁の %、数は件数)。null は「—」
export function fmtValue(code, v, dash = "—") {
  if (typeof v !== "number" || !Number.isFinite(v)) return dash;
  const d = KPI_BY_CODE[code];
  return d?.isRate ? `${v.toFixed(1)}%` : `${v.toLocaleString("ja-JP")}${d?.unit ?? ""}`;
}
// 段階の名前(本番開始日の月=1か月目)
export const milestoneLabel = (m) => (m === 3 || m === 6 || m === 12 ? `${m}か月の目標` : "目標なし(本番前・開始日が未設定)");
