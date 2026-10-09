/**
 * 10ZEN 会員証 GAS の『書込み停止(凍結)』部品。切替日に、旧システムへの書込みを確実に止め、最終の値を確定するために使う。
 * 使い方(切替日の手順は 30_CUTOVER_AND_RUNBOOK.md):
 *   1. このファイルを新しいスクリプトファイル(freeze.gs)として追加し、コード.gs の下記6関数の先頭に1行ずつ追加する(FREEZE_PATCH.md)。→ Web アプリを再デプロイ(この時点ではまだ停止しない: FROZEN が未設定のため従来どおり動く)。
 *   2. 切替日: freezeOn() を実行 → 以後、登録・来店・ポイント利用・管理画面の読み取りはすべて『メンテナンス中』になる(再デプロイ不要・即時)。
 *   3. drainStatus() を実行し、処理中のものが無いことを確認 → snapshotUsers() を2回(1分以上あけて)実行し、ハッシュが同じことを確認(=書込みが止まっている証拠)。
 *   4. 旧GASの再開は abortCutoverUnfreeze()。『新システムを一度も open にしていない中止』専用で、スクリプトプロパティ ALLOW_UNFREEZE=1 を手で設定したときだけ動く。切戻しでは使わない(30_CUTOVER_AND_RUNBOOK.md)。
 * 【呼び出しの安全】末尾が _ でない関数は、公開した画面から google.script.run で誰でも呼べる(Apps Script の仕様)。そのため、このファイルの公開関数
 *   (freezeOn / drainStatus / snapshotUsers / abortCutoverUnfreeze)はすべて先頭で assertOwner_() を呼び、所有者以外(匿名・他のユーザー)を拒否する。内部の関数は末尾 _。
 */
function assertOwner_() {
  var active = Session.getActiveUser().getEmail(), owner = Session.getEffectiveUser().getEmail();
  if (!active || !owner || active !== owner) throw new Error("権限がありません");
}
var FREEZE_KEY_ = "FROZEN";

function isFrozen_() { return PropertiesService.getScriptProperties().getProperty(FREEZE_KEY_) === "1"; }

// 書込み・管理系の関数の先頭で呼ぶ。凍結中は例外を投げる(google.script.run の失敗ハンドラーに渡る)。
function freezeGuard_() { if (isFrozen_()) throw new Error("ただいま会員証は新しい仕組みへ移行中です。しばらくしてからお試しください"); }

// doGet の先頭で呼ぶ。凍結中は JSONP / HTML のどちらにも『メンテナンス中』を返す(戻り値があればそれを return する)。
function freezeGuardGet_(e) {
  if (!isFrozen_()) return null;
  var cb = e && e.parameter && e.parameter.callback;
  if (cb && /^[A-Za-z_$][A-Za-z0-9_$.]{0,60}$/.test(cb)) {
    return ContentService.createTextOutput(cb + "(" + JSON.stringify({ status: "maintenance", message: "ただいま会員証は新しい仕組みへ移行中です" }) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return HtmlService.createHtmlOutput("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><p>ただいま会員証は新しい仕組みへ移行中です。しばらくしてからもう一度お試しください。</p>");
}

function freezeOn() {
  assertOwner_();
  PropertiesService.getScriptProperties().setProperty(FREEZE_KEY_, "1");
  var removed = disableWriteTriggers_();
  console.log("凍結を有効にしました。削除した時間トリガー: " + JSON.stringify(removed) + " / 開始時刻: " + new Date().toISOString());
  return { frozen: true, removedTriggers: removed };
}
// 『新システムを一度も open にしていない中止』専用。ALLOW_UNFREEZE=1 を手で設定していなければ拒否する(誤操作・外部からの呼び出しで書込みが再開しない)。
function abortCutoverUnfreeze() {
  assertOwner_();
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("ALLOW_UNFREEZE") !== "1") throw new Error("ALLOW_UNFREEZE が設定されていないため解除できません");
  props.deleteProperty(FREEZE_KEY_); props.deleteProperty("ALLOW_UNFREEZE");
  console.log("凍結を解除しました(切替の中止)");
}

// 書込みの可能性があるトリガーを止める(バックアップのトリガー dailyBackup は残す)。削除した関数名を返す。
function disableWriteTriggers_() {
  var removed = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() !== "dailyBackup") { removed.push(t.getHandlerFunction()); ScriptApp.deleteTrigger(t); }
  });
  return removed;
}

// 処理中のものが残っていないかの確認(読み取りのみ)。ロックが取れる=Supabase 同期の読取・採番が動いていない。失敗キューの未再送件数も返す。
function drainStatus() {
  assertOwner_();
  var lock = LockService.getScriptLock(), lockFree = false;
  try { lock.waitLock(10000); lockFree = true; } catch (e) { lockFree = false; } finally { if (lockFree) lock.releaseLock(); }
  var pending = 0, sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("NextoFailures");
  if (sh && sh.getLastRow() > 1) { var d = sh.getDataRange().getValues(); for (var i = 1; i < d.length; i++) if (!d[i][8]) pending++; }
  var out = { frozen: isFrozen_(), lockFree: lockFree, pendingFailureQueue: pending, triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }), at: new Date().toISOString() };
  console.log("書込み停止の確認: " + JSON.stringify(out) + (out.frozen && out.lockFree && out.pendingFailureQueue === 0 ? " → OK" : " → まだ完了していません(失敗キューがあれば replayNextoFailures を実行)"));
  return out;
}

// 最終値の確定(読み取りのみ)。Users シートの全行の「値の型と数値」を返し、全体のハッシュを出す。氏名・LINE ID は出さない。
// 凍結後に1分以上あけて2回実行し、ハッシュが同じなら、その間に誰もシートを書き換えていない。
function snapshotUsers() {
  assertOwner_();
  var data = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users").getDataRange().getValues(), rows = [];
  for (var i = 1; i < data.length; i++) {
    var raw = data[i];
    rows.push({ userId: raw[0], rank: String(raw[2] || ""), points: parseCount_(raw[3]), pointsCell: cellKind_(raw[3]), lifetime: parseCount_(raw[4]), lifetimeCell: cellKind_(raw[4]),
                lastVisit: raw[5] instanceof Date ? Utilities.formatDate(raw[5], "Asia/Tokyo", "yyyy-MM-dd") : (raw[5] ? String(raw[5]).slice(0, 10) : null), hasLineId: !!raw[7] });
  }
  var text = JSON.stringify(rows);
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
  console.log("Users スナップショット(" + rows.length + "行) ハッシュ=" + hash + " rows=" + text);
  return { hash: hash, rows: rows };
}
