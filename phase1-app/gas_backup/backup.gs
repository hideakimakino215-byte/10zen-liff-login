/**
 * 10ZEN 会員DB の毎日バックアップ(Google Apps Script)。新しい秘密は増やさない: 既存のスクリプトプロパティ CHECKIN_SECRET から合言葉を計算する。
 * 必要なスクリプトプロパティ: CHECKIN_SECRET(既存)、BACKUP_URL(Supabase の backup-export 関数の URL)、任意: BACKUP_NOTIFY(失敗の通知先メール。省略時は実行ユーザー)
 * 動作: DB の全データ+設定を JSON で取得 → SHA-256 を再計算して照合 → 自分の Google ドライブ「10ZEN_backup」フォルダへ保存 → 結果を DB に記録。
 *       失敗したら、記録(失敗)とメール通知。トリガー自体が動かない場合は、店長画面の集計に『バックアップが古い』と出る(36時間以上更新なし)。
 * 注意: 保存先には個人情報(LINE ID・氏名・ポイント)が入る。フォルダは共有しない。古いバックアップの削除は自動では行わない(手動で整理)。
 */
function backupFolder_() {
  var it = DriveApp.getFoldersByName("10ZEN_backup");
  return it.hasNext() ? it.next() : DriveApp.createFolder("10ZEN_backup");
}
function toHex_(bytes) {
  return bytes.map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
}
function backupToken_(secret) {
  return toHex_(Utilities.computeHmacSha256Signature("backup-export-v1", secret));
}
function sha256Hex_(text) {
  return toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}
function postBackup_(url, token, body) {
  var res = UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", headers: { Authorization: "Bearer " + token }, payload: JSON.stringify(body), muteHttpExceptions: true });
  return { code: res.getResponseCode(), text: res.getContentText() };
}
// トリガーが呼ぶ入口。末尾が _ でない関数は誰でも画面から呼べるため、実行は6時間に1回までに制限する(呼ばれても Drive に1ファイル増える程度)。所有者が確認用に今すぐ実行するときは dailyBackupNow()。
function dailyBackup() {
  var props = PropertiesService.getScriptProperties(), last = Number(props.getProperty("BACKUP_LAST_ATTEMPT") || 0);
  if (Date.now() - last < 6 * 3600 * 1000) return { ok: true, skipped: true };
  props.setProperty("BACKUP_LAST_ATTEMPT", String(Date.now()));
  return dailyBackup_();
}
function dailyBackupNow() { assertOwner_(); return dailyBackup_(); }
function dailyBackup_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("CHECKIN_SECRET"), url = props.getProperty("BACKUP_URL");
  var notify = props.getProperty("BACKUP_NOTIFY") || Session.getEffectiveUser().getEmail();
  var token = null;
  try {
    if (!secret || !url) throw new Error("CHECKIN_SECRET または BACKUP_URL が未設定です");
    token = backupToken_(secret);
    var r = postBackup_(url, token, { action: "export" });
    if (r.code !== 200) throw new Error("書き出しに失敗しました(HTTP " + r.code + ")");
    var data = JSON.parse(r.text);
    if (!data.payload || !data.sha256) throw new Error("応答の形式が不正です");
    if (sha256Hex_(data.payload) !== data.sha256) throw new Error("SHA-256 が一致しません(通信途中の破損の疑い)");
    var parsed = JSON.parse(data.payload);
    if (!parsed.tables || !parsed.tables.members || !parsed.tables.point_ledger) throw new Error("バックアップの内容が不完全です");
    var stamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd_HHmm");
    var file = backupFolder_().createFile("10zen_backup_" + stamp + ".json", data.payload, "application/json");
    if (file.getSize() < data.payload.length) throw new Error("保存したファイルのサイズが不足しています");
    var rec = postBackup_(url, token, { action: "record", ok: true, sha256: data.sha256, counts: data.counts, note: file.getName() });
    var recorded = false; try { recorded = rec.code === 200 && JSON.parse(rec.text).status === "recorded"; } catch (_e) {}
    if (!recorded) {   // 保存はできたが DB に成功を記録できなかった。店長画面は『バックアップが古い』のままになるので、区別して通知する
      MailApp.sendEmail(notify, "【10ZEN】バックアップは保存しましたが、記録に失敗しました", "ファイル " + file.getName() + " は保存済みです。DB への記録がHTTP " + rec.code + " で失敗しました。店長画面の『バックアップ』表示が古いままになります。dailyBackupNow を実行して確認してください。");
      return { ok: true, recorded: false, file: file.getName(), recordCode: rec.code };
    }
    return { ok: true, recorded: true, file: file.getName(), counts: data.counts };
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    var failRecorded = false;
    try { if (token) { var fr = postBackup_(url, token, { action: "record", ok: false, note: msg.slice(0, 200) }); failRecorded = fr.code === 200; } } catch (_e) {}
    MailApp.sendEmail(notify, "【10ZEN】会員DBのバックアップに失敗しました", msg + (failRecorded ? "" : "\n(失敗の記録もDBに残せませんでした)") + "\n\ndailyBackupNow を手動で実行して確認してください。解決しない場合は開発担当へ連絡してください。");
    return { ok: false, error: msg };
  }
}
// 1回だけ実行: 毎日 午前3時台に dailyBackup を動かすトリガーを作る(失敗の通知はトリガー画面の『失敗通知設定』でも有効にする)
function installBackupTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "dailyBackup") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("dailyBackup").timeBased().everyDays(1).atHour(3).inTimezone("Asia/Tokyo").create();
}
