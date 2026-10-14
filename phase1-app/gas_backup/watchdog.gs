/**
 * 10ZEN 会員DB バックアップの見張り役(Google Apps Script)。毎日のバックアップ(backup.gs)とは「別の Google プロジェクト」に置く。
 *   バックアップの仕組みそのもの(トリガー・権限)が止まっても、こちらは止まらないようにするため。
 * 動作: 毎朝9時(日本時間)に、Supabase の backup-export 関数へ「最後に成功したバックアップの時刻」だけを問い合わせる。
 *   ・最後の成功から24時間を超えている、または問い合わせ自体ができない → 通知先へメール
 *     (バックアップは毎日3〜4時。正常なら9時の時点で5〜6時間前。1回失敗すると約29〜30時間前になり、その朝のうちに気づける)
 *   ・毎月1日 → 「見張りは動いています」のメールを1通(これが届かなければ、見張り役が止まっている)
 *   ・確認の結果は毎回、実行ログに1行残す(メールが来ない日も、動いたことを後から確かめられる)
 * 必要なスクリプトプロパティ: BACKUP_URL(backup-export 関数の URL)、BACKUP_STATUS_TOKEN(backup.gs の showWatchdogToken() で表示した値)、
 *   任意: WATCHDOG_NOTIFY(通知先メール。カンマ区切りで複数可。省略時はこのプロジェクトの所有者)
 * 元の秘密(CHECKIN_SECRET)は持たない。持つのは、時刻の確認にしか使えない認証情報(BACKUP_STATUS_TOKEN)だけ。会員データは読めない・書けない。
 * 初回だけ、所有者が installWatchdogTrigger() を実行する。動作確認は watchdogSelfTest()(データを変えずに、確認と試験メールを行う)。
 */
var WATCHDOG_STALE_HOURS_ = 24;

// トリガーの入口。何度呼ばれても、読み取りとメール送信だけ(データは変えない)
function watchdogCheck() {
  var r = watchdogCheck_(Date.now());
  console.log("見張り役の確認結果: " + JSON.stringify(r));
  return r;
}

var WATCHDOG_FIX_ = "\n\n確認のしかた: バックアップ用の Google Apps Script を開き、dailyBackupNow を実行してください。" +
  "\n実行できない・エラーが出る場合は、トリガー(時計のアイコン)に dailyBackup が残っているか確認し、なければ installBackupTrigger を実行してください。" +
  "\n解決しない場合は開発担当へ連絡してください。";

// 最後に成功したバックアップの時刻を問い合わせる。{ last: ISO文字列 または null, problem: 問題の説明 または null }
function fetchBackupStatus_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("BACKUP_URL"), token = props.getProperty("BACKUP_STATUS_TOKEN");
  if (!url || !token) return { last: null, problem: "見張り役の設定(BACKUP_URL / BACKUP_STATUS_TOKEN)が足りません。" };
  try {
    var res = UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", headers: { Authorization: "Bearer " + token },
                                       payload: JSON.stringify({ action: "status" }), muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code !== 200) return { last: null, problem: "バックアップの状態を確認できませんでした(HTTP " + code + ")。" };
    return { last: JSON.parse(res.getContentText()).lastSuccessAt || null, problem: null };
  } catch (e) { return { last: null, problem: "バックアップの状態を確認できませんでした(通信エラー: " + String(e && e.message || e).slice(0, 200) + ")。" }; }
}
function notifyTo_() { return PropertiesService.getScriptProperties().getProperty("WATCHDOG_NOTIFY") || Session.getEffectiveUser().getEmail(); }
function jstText_(ms) { return Utilities.formatDate(new Date(ms), "Asia/Tokyo", "yyyy-MM-dd HH:mm"); }

function watchdogCheck_(nowMs) {
  var notify = notifyTo_(), s = fetchBackupStatus_(), last = s.last;
  if (s.problem) {
    MailApp.sendEmail(notify, "【10ZEN】バックアップの見張り: 状態を確認できません", s.problem + WATCHDOG_FIX_);
    return { status: "unreachable", lastSuccessAt: null };
  }
  var lastMs = last ? new Date(last).getTime() : NaN;
  if (!last || !(lastMs > 0) || nowMs - lastMs > WATCHDOG_STALE_HOURS_ * 3600 * 1000) {
    var when = last && lastMs > 0 ? jstText_(lastMs) : "記録なし";
    MailApp.sendEmail(notify, "【10ZEN】会員DBのバックアップが" + WATCHDOG_STALE_HOURS_ + "時間以上止まっています",
      "最後に成功したバックアップ: " + when + "(日本時間)\n毎日のバックアップが動いていない可能性があります。" + WATCHDOG_FIX_);
    return { status: "stale", lastSuccessAt: last };
  }
  if (Utilities.formatDate(new Date(nowMs), "Asia/Tokyo", "d") === "1") {
    MailApp.sendEmail(notify, "【10ZEN】バックアップの見張り: 正常に動いています(毎月1日のお知らせ)",
      "最後に成功したバックアップ: " + jstText_(lastMs) + "(日本時間)\n" +
      "このメールは毎月1日に届きます。届かない月があれば、見張り役が止まっています。開発担当へ連絡してください。");
    return { status: "ok", lastSuccessAt: last, heartbeat: true };
  }
  return { status: "ok", lastSuccessAt: last };
}

// 動作確認(所有者のみ)。本番の成功時刻を実際に問い合わせ、その結果を書いた試験メールを通知先へ送る。データは変えない。
//   メールが届き、Gmail で目立つ(ラベル・スター)ことまで確かめられる。異常時の通知と同じ件名の付け方。
function watchdogSelfTest() {
  assertWatchdogOwner_();
  var s = fetchBackupStatus_(), lastMs = s.last ? new Date(s.last).getTime() : NaN;
  var result = s.problem ? s.problem : "最後に成功したバックアップ: " + (lastMs > 0 ? jstText_(lastMs) + "(日本時間)" : "記録なし");
  MailApp.sendEmail(notifyTo_(), "【10ZEN】バックアップの見張り: 動作確認の試験メール(異常ではありません)",
    "見張り役の動作確認です。実際の異常の知らせではありません。\n\n問い合わせの結果: " + result +
    "\n\nこのメールが届き、Gmail でラベル「10ZEN要対応」が付いていれば、異常時の通知も同じように届きます。");
  var r = { status: s.problem ? "unreachable" : "ok", lastSuccessAt: s.last, mailedTo: notifyTo_() };
  console.log("見張り役の動作確認: " + JSON.stringify(r));
  return r;
}

// 毎朝9時のトリガーを設定する(所有者のみ。何度実行しても1つだけになる)
function installWatchdogTrigger() {
  assertWatchdogOwner_();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "watchdogCheck") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("watchdogCheck").timeBased().everyDays(1).atHour(9).inTimezone("Asia/Tokyo").create();
  return "watchdog trigger installed";
}

function assertWatchdogOwner_() {
  var active = Session.getActiveUser().getEmail(), owner = Session.getEffectiveUser().getEmail();
  if (!active || !owner || active !== owner) throw new Error("権限がありません");
}
