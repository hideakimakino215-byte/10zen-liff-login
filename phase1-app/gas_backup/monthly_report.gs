/**
 * 10ZEN 月次レポート(Google Apps Script)。バックアップの見張り役と同じ、別の Google プロジェクト「10ZENバックアップの見張り」に置く(watchdog.gs と同じプロジェクト)。
 * 動作: 毎月1日 9時(日本時間)に、前の月の集計を Supabase の backup-export 関数(action=monthly_report)から受け取り、日本語のメールで送る。
 *   ・集計の数字だけ(氏名・会員番号・LINE ID は DB の report_monthly が返さない)。4つの KPI の実績・目標・達成率・前の月との差、会員(新規登録・紹介からの新規来店・ランク別)、
 *     体質チェック(タイプ別・その月のチェック結果の傾向・来店時の実施率)、特典チケット(発行・使用・使用率)、注意(目標の80%未満・レジの客数が未取り込み)、スタッフ画面のリンク。
 *   ・本番開始日(スタッフ画面の「目標とKPI」で店長が設定)が未設定のとき、または前の月が本番開始日の月より前のときは、DB が skipped を返し、メールは送らない。
 *   ・取得できない(通信エラー・HTTP のエラー・設定漏れ)ときは、黙らずに所有者へ「作れませんでした」のメールを送る。直ったら monthlyReport を実行すれば、その月の分を送る。
 *   ・同じ月の分は1回だけ送る(送った月をスクリプト プロパティ REPORT_LAST_SENT に記録)。
 * 必要なスクリプト プロパティ: REPORT_TOKEN(バックアップ本体の showReportToken() で表示した値。月次レポートの取得にしか使えない)、
 *   REPORT_TO(送り先。カンマ区切りで複数可。当面は所有者だけ。店長を足すときはここに追加)、STAFF_URL(スタッフ画面の URL)、
 *   任意: REPORT_URL(backup-export 関数の URL。省略時は見張り役と同じ BACKUP_URL)。
 * 元の秘密(CHECKIN_SECRET)は持たない。トークンは実行ログにもメールにも出さない。
 * 初回だけ、所有者が installMonthlyReportTrigger() を実行する。動作確認は monthlyReportSelfTest()(所有者だけに試験メール。送った記録は残さない)。
 */
var REPORT_KPIS_ = [
  ["member_visit_rate", "会員来店率", true], ["check_rate", "体質チェック実施率", true], ["revisit_rate", "再来店率", true], ["referral_clicks", "薬日本堂への送客", false, "回"],
];
var REPORT_NEW_MEMBERS_ = ["new_members", "新規登録数", false, "人"];
var REPORT_RANKS_ = [["white_opal", "WHITE OPAL"], ["amber", "AMBER"], ["emerald", "EMERALD"], ["ruby", "RUBY"], ["onyx", "ONYX"]];
// 体質のタイプの表示名(app-core/constitution.mjs と同じ。test_monthly_report.mjs が一致を確かめる)
var REPORT_TYPES_ = [["wood", "木 モヤモヤ渋滞タイプ"], ["fire", "火 カッカ熱こもりタイプ"], ["earth", "土 消化パワー不足タイプ"], ["metal", "金 うるおい不足タイプ"],
  ["water", "水 ぽかぽかパワー不足タイプ"], ["balanced", "バランス良好"]];
var REPORT_SKIP_REASONS_ = { no_launch_date: "本番開始日が未設定", before_launch: "本番開始日の月より前", month_not_finished: "まだ終わっていない月" };
var REPORT_FIX_ = "\n\n直し方: 設定(REPORT_TOKEN・REPORT_URL または BACKUP_URL)と Supabase の backup-export 関数を確かめてください。" +
  "\n直ったら、このプロジェクトで monthlyReport を実行すると、前の月の分を送ります(同じ月の分は1回だけ送ります)。解決しない場合は開発担当へ連絡してください。";

// トリガーの入口(毎月1日 9時)。読み取りとメール送信だけ(データは変えない)
function monthlyReport() {
  var r = monthlyReport_(Date.now());
  console.log("月次レポートの結果: " + JSON.stringify(r));
  return r;
}

function reportConfig_() {
  var p = PropertiesService.getScriptProperties();
  return { url: p.getProperty("REPORT_URL") || p.getProperty("BACKUP_URL"), token: p.getProperty("REPORT_TOKEN"),
           to: p.getProperty("REPORT_TO") || Session.getEffectiveUser().getEmail(), staffUrl: p.getProperty("STAFF_URL") || "" };
}
// 日本時間の「前の月」('YYYY-MM')
function reportPreviousMonth_(nowMs) {
  var y = Number(Utilities.formatDate(new Date(nowMs), "Asia/Tokyo", "yyyy")), m = Number(Utilities.formatDate(new Date(nowMs), "Asia/Tokyo", "MM")) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return y + "-" + ("0" + m).slice(-2);
}
function reportMonthLabel_(month) { return Number(month.slice(0, 4)) + "年" + Number(month.slice(5, 7)) + "月"; }

// 集計を受け取る。{ data } または { problem: 説明 }
function reportFetch_(cfg, month) {
  if (!cfg.url || !cfg.token) return { problem: "月次レポートの設定(REPORT_TOKEN と、REPORT_URL または BACKUP_URL)が足りません。" };
  try {
    var res = UrlFetchApp.fetch(cfg.url, { method: "post", contentType: "application/json", headers: { Authorization: "Bearer " + cfg.token },
                                           payload: JSON.stringify({ action: "monthly_report", month: month }), muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code !== 200) return { problem: "月次レポートの数字を取得できませんでした(HTTP " + code + ")。" };
    var data = JSON.parse(res.getContentText());
    if (!data || data.month !== month) return { problem: "月次レポートの応答の形が想定と違います。" };
    return { data: data };
  } catch (e) { return { problem: "月次レポートの数字を取得できませんでした(通信エラー: " + String(e && e.message || e).slice(0, 200) + ")。" }; }
}

function monthlyReport_(nowMs) {
  var props = PropertiesService.getScriptProperties(), cfg = reportConfig_(), month = reportPreviousMonth_(nowMs), owner = Session.getEffectiveUser().getEmail();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { status: "busy", month: month };                    // 同時に2回動いても、送るのは1回
  try {
    if (props.getProperty("REPORT_LAST_SENT") === month) return { status: "already_sent", month: month };
    var r = reportFetch_(cfg, month);
    if (r.problem) {
      MailApp.sendEmail(owner, "【10ZEN】月次レポートを作れませんでした(" + reportMonthLabel_(month) + ")", r.problem + REPORT_FIX_);
      return { status: "error", month: month };
    }
    if (r.data.skipped) return { status: "skipped", month: month, reason: r.data.reason };   // 本番開始の前などはメールを送らない
    var mail = buildReportMail_(r.data, cfg.staffUrl);
    MailApp.sendEmail(cfg.to, mail.subject, mail.body);
    props.setProperty("REPORT_LAST_SENT", month);
    return { status: "sent", month: month, recipients: String(cfg.to).split(",").filter(function (x) { return x.trim(); }).length, warnings: mail.warnings.length };
  } finally { lock.releaseLock(); }
}

// ---- メールの文面(集計の JSON だけから作る) ----
function reportComma_(v) { var t = String(Math.round(v)); return t.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }   // 3桁ごとのカンマ(実行環境の地域設定によらない)
function reportNum_(v, unit) { return typeof v === "number" && isFinite(v) ? reportComma_(v) + (unit || "") : "—"; }
function reportPct_(v) { return typeof v === "number" && isFinite(v) ? v.toFixed(1) + "%" : "—"; }
function reportKpiValue_(def, v) { return def[2] ? reportPct_(v) : reportNum_(v, def[3]); }
function reportChange_(def, v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  var s = v > 0 ? "+" : v < 0 ? "-" : "±", a = Math.abs(v);
  return s + (def[2] ? (Math.round(a * 10) / 10).toFixed(1) + "pt" : reportComma_(a) + def[3]);
}
// 注意の行: 目標の80%未満の KPI・レジの客数が未取り込み
function reportWarnings_(j) {
  var w = [], k = j.kpis || {};
  REPORT_KPIS_.concat([REPORT_NEW_MEMBERS_]).forEach(function (d) {
    var x = k[d[0]];
    if (x && typeof x.achievementPercent === "number" && x.achievementPercent < 80) w.push(d[1] + "が目標の80%未満です(達成率 " + x.achievementPercent + "%)");
  });
  if (j.pos && j.pos.missing) w.push("レジの客数が未取り込みです(会員来店率を計算できません。スタッフ画面の「目標とKPI」から取り込んでください)");
  return w;
}
function buildReportMail_(j, staffUrl) {
  var month = j.month, y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  var test = j.scope === "test", warnings = reportWarnings_(j), L = [];
  var subject = "10ZEN 月次レポート " + reportMonthLabel_(month) + (test ? "(試験運用のデータ)" : "");
  L.push("10ZEN 青山店 月次レポート " + reportMonthLabel_(month) + "(" + m + "月1日〜" + m + "月" + last + "日・日本時間)");
  if (j.monthIndex) L.push("本番開始から " + j.monthIndex + " か月目(" + j.milestone + "か月の目標で判定)");
  if (test) L.push("※ 試験運用中のため、試験会員と試験用の客数の数字です");
  L.push("", "■ 注意");
  if (warnings.length) warnings.forEach(function (x) { L.push("・" + x); }); else L.push("・特になし");
  L.push("", "■ 4つの KPI(実績 / 目標 / 達成率 / 前の月との差)");
  REPORT_KPIS_.concat([REPORT_NEW_MEMBERS_]).forEach(function (d, i) {
    var x = (j.kpis || {})[d[0]] || {};
    L.push((i === REPORT_KPIS_.length ? "(補助)" : "・") + d[1] + ": " + reportKpiValue_(d, x.actual) + " / " + (x.target == null ? "目標なし" : reportKpiValue_(d, x.target)) +
      " / " + (typeof x.achievementPercent === "number" ? x.achievementPercent + "%" : "—") + " / 前の月との差 " + reportChange_(d, x.change));
  });
  var mem = j.members || {}, br = mem.byRank || {};
  L.push("", "■ 会員");
  L.push("・新規登録: " + reportNum_(mem.newRegistrations, "人"));
  L.push("・紹介からの新規来店: " + reportNum_(mem.referralFirstVisits, "人") + "(紹介からの登録 " + reportNum_(mem.referralRegistrations, "人") + ")");
  L.push("・ランク別(有効会員 " + reportNum_(mem.activeMembers, "人") + "): " + REPORT_RANKS_.map(function (r) { return r[1] + " " + reportNum_(br[r[0]], "人"); }).join(" / "));
  L.push("・会員の来店: " + reportNum_(mem.memberVisits, "回") + " / レジの客数: " + (j.pos && !j.pos.missing ? reportNum_(j.pos.customers, "人") + (j.pos.source === "manual" ? "(手入力)" : "(日別 " + reportNum_(j.pos.days, "日分") + ")") : "未取り込み"));
  var cc = j.constitution || {}, bt = cc.byType || {}, cr = cc.checkResults || {}, crt = cr.byType || {}, vc = cc.visitCheckRate || {};
  L.push("", "■ 体質チェック");
  L.push("・実施した会員: " + reportNum_(cc.checkedMembers, "人") + "(実施率 " + reportPct_(cc.checkRatePercent) + ")・この月のチェック " + reportNum_(cc.checksInMonth, "回"));
  L.push("・タイプ別: " + REPORT_TYPES_.map(function (t) { return t[1] + " " + reportNum_(bt[t[0]], "人"); }).join(" / "));
  // チェック結果の傾向(この月に行われたチェック1回ずつのタイプ)と、来店時の実施率(会員の来店日のうち、同じ日にチェックした日の割合)
  if (cr.checks > 0) L.push("・チェック結果の傾向(この月のチェック " + reportNum_(cr.checks, "回") + "): " + REPORT_TYPES_.map(function (t) { return t[1] + " " + reportNum_(crt[t[0]], "回"); }).join(" / "));
  else L.push("・チェック結果の傾向: この月のチェックはありません");
  L.push("・来店時の実施率: " + reportPct_(vc.ratePercent) + "(会員の来店 " + reportNum_(vc.visitDays, "日") + "のうち、同じ日にチェックした日 " + reportNum_(vc.checkedVisitDays, "日") + ")");
  var tk = j.tickets || {}, bk = tk.issuedByKind || {};
  L.push("", "■ 特典チケット");
  L.push("・この月の発行: " + reportNum_(tk.issued, "枚") + "(到達のお祝い " + reportNum_(bk.milestone) + "・季節の豆花 " + reportNum_(bk.seasonal) + "・お友だち紹介 " + reportNum_(bk.referral) + ")/ この月の使用: " + reportNum_(tk.used, "枚"));
  L.push("・使用率(月末までの累計): " + reportPct_(tk.usageRatePercent) + "(発行 " + reportNum_(tk.cumulativeIssued, "枚") + "・使用 " + reportNum_(tk.cumulativeUsed, "枚") + ")");
  L.push("", "■ スタッフ画面", staffUrl ? staffUrl : "(スタッフ画面の URL が未設定です。スクリプト プロパティ STAFF_URL に設定してください)");
  L.push("", "このメールは毎月1日 9時(日本時間)に自動で送っています。数字は集計だけで、個人の情報は含みません。");
  return { subject: subject, body: L.join("\n"), warnings: warnings };
}

// 動作確認(所有者のみ)。前の月の集計を実際に受け取り、所有者だけに試験メールを送る(送り先の設定 REPORT_TO には送らない)。送った記録は残さない。
function monthlyReportSelfTest() {
  assertReportOwner_();
  var cfg = reportConfig_(), month = reportPreviousMonth_(Date.now()), owner = Session.getEffectiveUser().getEmail(), r = reportFetch_(cfg, month), res;
  if (r.problem) {
    MailApp.sendEmail(owner, "【試験】10ZEN 月次レポート: 取得できませんでした(" + reportMonthLabel_(month) + ")", r.problem + REPORT_FIX_);
    res = { status: "error", month: month };
  } else if (r.data.skipped) {
    MailApp.sendEmail(owner, "【試験】10ZEN 月次レポート: " + reportMonthLabel_(month) + "は送らない月です",
      "動作確認です。" + reportMonthLabel_(month) + "の月次レポートは送りません(理由: " + (REPORT_SKIP_REASONS_[r.data.reason] || r.data.reason) + ")。\n" +
      "本番開始日はスタッフ画面の「目標とKPI」で店長が設定します。開始日の月が終わった次の月の1日から、毎月送ります。");
    res = { status: "skipped", month: month, reason: r.data.reason };
  } else {
    var mail = buildReportMail_(r.data, cfg.staffUrl);
    MailApp.sendEmail(owner, "【試験】" + mail.subject, "これは動作確認の試験メールです(送り先の設定にかかわらず、所有者だけに送っています)。\n\n" + mail.body);
    res = { status: "sent", month: month, warnings: mail.warnings.length };
  }
  console.log("月次レポートの動作確認: " + JSON.stringify(res));
  return res;
}

// 毎月1日 9時(日本時間)のトリガーを設定する(所有者のみ。何度実行しても1つだけになる)
function installMonthlyReportTrigger() {
  assertReportOwner_();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "monthlyReport") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("monthlyReport").timeBased().onMonthDay(1).atHour(9).inTimezone("Asia/Tokyo").create();
  return "monthly report trigger installed";
}

function assertReportOwner_() {
  var active = Session.getActiveUser().getEmail(), owner = Session.getEffectiveUser().getEmail();
  if (!active || !owner || active !== owner) throw new Error("権限がありません");
}
