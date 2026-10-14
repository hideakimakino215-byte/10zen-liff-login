/**
 * 10ZEN 会員DB バックアップの見張り役(Google Apps Script)。毎日のバックアップ(backup.gs)とは「別の Google プロジェクト」に置く。
 *   バックアップの仕組みそのもの(トリガー・権限)が止まっても、こちらは止まらないようにするため。
 * 動作: 毎朝9時(日本時間)に、Supabase の backup-export 関数へ「最後に成功したバックアップの時刻」だけを問い合わせる。
 *   ・36時間以上成功していない、または問い合わせ自体ができない → 通知先へメール
 *   ・毎月1日 → 「見張りは動いています」のメールを1通(これが届かなければ、見張り役が止まっている)
 * 必要なスクリプトプロパティ: BACKUP_URL(backup-export 関数の URL)、BACKUP_STATUS_TOKEN(backup.gs の showWatchdogToken() で表示した値)、
 *   任意: WATCHDOG_NOTIFY(通知先メール。カンマ区切りで複数可。省略時はこのプロジェクトの所有者)
 * このトークンでできるのは時刻の確認だけ(会員データは読めない・書けない)。
 * 初回だけ、所有者が installWatchdogTrigger() を実行する。
 */
var WATCHDOG_STALE_HOURS_ = 36;

// トリガーの入口。何度呼ばれても、読み取りとメール送信だけ(データは変えない)
function watchdogCheck() {
  return watchdogCheck_(Date.now());
}

function watchdogCheck_(nowMs) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("BACKUP_URL"), token = props.getProperty("BACKUP_STATUS_TOKEN");
  var notify = props.getProperty("WATCHDOG_NOTIFY") || Session.getEffectiveUser().getEmail();
  var fix = "\n\n確認のしかた: バックアップ用の Google Apps Script を開き、dailyBackupNow を実行してください。" +
            "\n実行できない・エラーが出る場合は、トリガー(時計のアイコン)に dailyBackup が残っているか確認し、なければ installBackupTrigger を実行してください。" +
            "\n解決しない場合は開発担当へ連絡してください。";
  var last = null, problem = null;
  if (!url || !token) problem = "見張り役の設定(BACKUP_URL / BACKUP_STATUS_TOKEN)が足りません。";
  else {
    try {
      var res = UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", headers: { Authorization: "Bearer " + token },
                                         payload: JSON.stringify({ action: "status" }), muteHttpExceptions: true });
      var code = res.getResponseCode();
      if (code !== 200) problem = "バックアップの状態を確認できませんでした(HTTP " + code + ")。";
      else last = JSON.parse(res.getContentText()).lastSuccessAt || null;
    } catch (e) { problem = "バックアップの状態を確認できませんでした(通信エラー: " + String(e && e.message || e).slice(0, 200) + ")。"; }
  }
  if (problem) {
    MailApp.sendEmail(notify, "【10ZEN】バックアップの見張り: 状態を確認できません", problem + fix);
    return { status: "unreachable", lastSuccessAt: null };
  }
  var lastMs = last ? new Date(last).getTime() : NaN;
  if (!last || !(lastMs > 0) || nowMs - lastMs > WATCHDOG_STALE_HOURS_ * 3600 * 1000) {
    var when = last ? Utilities.formatDate(new Date(lastMs), "Asia/Tokyo", "yyyy-MM-dd HH:mm") : "記録なし";
    MailApp.sendEmail(notify, "【10ZEN】会員DBのバックアップが" + WATCHDOG_STALE_HOURS_ + "時間以上止まっています",
      "最後に成功したバックアップ: " + when + "(日本時間)\n毎日のバックアップが動いていない可能性があります。" + fix);
    return { status: "stale", lastSuccessAt: last };
  }
  if (Utilities.formatDate(new Date(nowMs), "Asia/Tokyo", "d") === "1") {
    MailApp.sendEmail(notify, "【10ZEN】バックアップの見張り: 正常に動いています(毎月1日のお知らせ)",
      "最後に成功したバックアップ: " + Utilities.formatDate(new Date(lastMs), "Asia/Tokyo", "yyyy-MM-dd HH:mm") + "(日本時間)\n" +
      "このメールは毎月1日に届きます。届かない月があれば、見張り役が止まっています。開発担当へ連絡してください。");
    return { status: "ok", lastSuccessAt: last, heartbeat: true };
  }
  return { status: "ok", lastSuccessAt: last };
}

// 毎朝9時のトリガーを設定する(所有者のみ。何度実行しても1つだけになる)
function installWatchdogTrigger() {
  var active = Session.getActiveUser().getEmail(), owner = Session.getEffectiveUser().getEmail();
  if (!active || !owner || active !== owner) throw new Error("権限がありません");
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "watchdogCheck") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("watchdogCheck").timeBased().everyDays(1).atHour(9).inTimezone("Asia/Tokyo").create();
  return "watchdog trigger installed";
}
