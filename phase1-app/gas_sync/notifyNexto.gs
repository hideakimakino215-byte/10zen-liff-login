// GAS 側 ②(v4・監査#2 追加条件反映)。事前に Apps Script プロジェクトへ次を追加する:
//   nexto.gs     = patches/gas_nexto.js の全文(キー生成・再試行・失敗キュー整形・再送・再同期。Node でテスト済み)
//   (security.gs = patches/gas_security.js の全文。ポイント利用の本人確認で使う。gas_integration.gs 参照)
// スクリプトプロパティ: CHECKIN_SECRET(Supabase の MEMBERSHIP_CHECKIN_SECRET と同じ値。コードに直書きしない)
// このアダプター部分(UrlFetchApp/Sheet 操作)は GAS 実機でのみ動くため、Node のテストの対象外(実機確認が必要)。

function nextoPost_(payload) {
  var secret = PropertiesService.getScriptProperties().getProperty("CHECKIN_SECRET");
  var headers = {};
  if (secret) headers["x-checkin-secret"] = secret;
  var response = UrlFetchApp.fetch(NEXTO_CHECKIN_URL, {
    method: "post", contentType: "application/json", headers: headers,
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  return { code: response.getResponseCode(), body: response.getContentText() };
}

// 正本(Users シート)から会員の「現在値」を読む。列: 0=userId 2=rank 3=points 4=lifetime 5=lastVisit 7=lineUserId
function readUserRow_(userId, lineUserId) {
  var data = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users").getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if ((userId && data[i][0] === userId) || (!userId && data[i][7] === lineUserId)) return buildUserRow_(data[i]);   // 読めない値は null のまま(0 にしない)
  }
  return null;
}

// 版の採番。会員シートを書き換える処理(登録・来店・利用)はすべて同じスクリプトロックを使うので、
// 「読取」と「採番」を同じロック内で行えば、版の大小=シート上の値の新旧になる。HTTP の遅延・再試行は版を変えない。
// ロックは読取と採番の間だけ(HTTP 送信中は持たない)。取得できなければ null(ポイント値は付けない)。
function withVersion_(fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) { console.error("NEXTO 版採番: ロック取得失敗"); return null; }
  try {
    var result = fn();
    var props = PropertiesService.getScriptProperties();
    var v = nextVersion_(props.getProperty("NEXTO_SEQ"), Date.now());
    props.setProperty("NEXTO_SEQ", String(v));
    return { result: result, version: v };
  } catch (e) { console.error("NEXTO 版採番: " + e.message); return null; }
  finally { lock.releaseLock(); }
}
// 読取+採番。読めない・ロックが取れない場合は null(呼び出し側の古い引数で代用しない)。
function readUserRowVersioned_(userId, lineUserId) {
  var r = withVersion_(function () { return readUserRow_(userId, lineUserId); });
  if (!r || !r.result) return null;
  r.result.version = r.version;
  return r.result;
}

// 来店・登録時に呼ばれる(既存の呼び出し箇所は変更しない)。第3〜5引数(呼び出し時点の値)は使わない: 送信直前に正本を読み直す。
// 読めなかった場合はポイント値を付けず、来店イベントだけを送る(古い値に新しい版を付けて上書きしない)。
// イベントは固有キーなので、再送されても1回だけ処理される。
// v6: 末尾 _ に改名(公開関数だと画面から任意の引数で呼べて、偽の来店イベントを Supabase へ送れるため)。コード.gs の呼び出し2か所も notifyNexto_( に変える。
function notifyNexto_(lineUserId, userId, currentPoints, lifetimePoints, rank, eventAtMs) {
  var at = eventAtMs || Date.now();
  var entry = { lineUserId: lineUserId, userId: userId, eventKey: visitKey_(lineUserId, at), eventAt: new Date(at).toISOString() };
  var payload = buildEventPayload_(entry, readUserRowVersioned_(userId, lineUserId));
  var result = postWithRetry_(nextoPost_, payload, { maxAttempts: 3, baseDelayMs: 500, sleep: Utilities.sleep });
  if (result.ok) { console.log("NEXTO通知 成功: status=" + result.code + " attempts=" + result.attempts); return; }
  console.error("NEXTO通知 失敗: status=" + result.code + " error=" + result.error + " attempts=" + result.attempts);
  recordNextoFailure_(buildQueueEntry_(entry, result, new Date().toISOString()));   // 値・版は保存しない
}

// 失敗キュー(シート NextoFailures)。LINE ID が入るため、既存の会員シートと同じ共有範囲で管理すること。ポイント値は保存しない。
function recordNextoFailure_(q) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName("NextoFailures") || ss.insertSheet("NextoFailures");
    if (sh.getLastRow() === 0) sh.appendRow(["failed_at", "kind", "eventKey", "eventAt", "lineUserId", "userId", "code", "error", "replayed_at"]);
    sh.appendRow([q.failedAt, q.kind, q.eventKey, q.eventAt, q.lineUserId, q.userId, q.code, q.error, ""]);
  } catch (e) { console.error("失敗キューへの記録にも失敗: " + e.message); }
}

// 失敗キューの再送(手動実行 or 時間トリガー)。値は再送時に正本から読み直す。同じキーなので何度実行しても二重にならない。
function replayNextoFailures() {
  assertOwner_();   // 所有者のみ(画面からの呼び出しを拒否)。assertOwner_ は freeze.gs にある
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("NextoFailures"); if (!sh) return "no queue";
  var data = sh.getDataRange().getValues(), entries = [];
  for (var i = 1; i < data.length; i++) {
    entries.push({ eventKey: data[i][2], eventAt: data[i][3], lineUserId: data[i][4], userId: data[i][5] || undefined, replayed: !!data[i][8] });
  }
  var res = replayQueue_(entries, readUserRowVersioned_, nextoPost_, { maxAttempts: 3, baseDelayMs: 500, sleep: Utilities.sleep });
  res.replayed.forEach(function (idx) { sh.getRange(idx + 2, 9).setValue(new Date()); });   // 成功した行だけ「再送済み」にする
  console.log("再送結果: " + JSON.stringify({ replayed: res.replayed.length, failed: res.failed.length }));
  return res;
}

// 障害(限定停止など)の後の全件再同期。Users シートの全会員の「今の値」を、1回のロック内で読み取り+採番して送る(正本=GAS→ミラー=Supabase)。手動で1回実行する。
// Users シート全体を読んで同期用の行にする(LINE ID のある会員だけ)。1回のロック内で読み取り+採番する。
function readAllUserRows_() {
  return withVersion_(function () {
    var data = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users").getDataRange().getValues(), rows = [];
    for (var i = 1; i < data.length; i++) { var r = buildUserRow_(data[i]); if (r && r.lineUserId) rows.push(r); }
    return rows;
  });
}

// 【読み取り専用】再同期を実行した場合の内容を確認する。Supabase には送らない(HTTP なし)。シートも書き換えない。
// ログには userId・セルの型・読み取れた数値だけを出す(氏名・LINE ID は出さない)。最初にこれを実行して確認する。
function previewResyncToNexto() {
  assertOwner_();   // 所有者のみ(画面からの呼び出しを拒否)。assertOwner_ は freeze.gs にある
  var data = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users").getDataRange().getValues(), out = [];
  for (var i = 1; i < data.length; i++) {
    var r = buildUserRow_(data[i]);
    out.push({ userId: data[i][0], hasLineId: !!(r && r.lineUserId), pointsCell: cellKind_(data[i][3]), lifetimeCell: cellKind_(data[i][4]),
               points: r ? r.points : null, lifetime: r ? r.lifetimePoints : null, rank: r ? r.rank : null,
               action: !(r && r.lineUserId) ? "送らない(LINE ID なし)" : !Number.isInteger(r.points) ? "送らない(ポイントが数値として読めない)" : (Number.isInteger(r.lifetimePoints) ? "ポイント・累計を同期" : "ポイントだけ同期(累計は送らない)") });
  }
  console.log("再同期プレビュー(送信なし): " + JSON.stringify(out));
  return out;
}

// 障害後の全件再同期。送るのは「数値として読めた値」だけ。Supabase に顧客がいない会員は作成しない(結果の missing に出る)。手動で、プレビュー確認後に1回実行する。
function resyncAllToNexto() {
  assertOwner_();   // 所有者のみ(画面からの呼び出しを拒否)。assertOwner_ は freeze.gs にある
  var snap = readAllUserRows_();
  if (!snap) { console.error("全件再同期: 読取に失敗(ロック)。何も送っていません"); return null; }
  var res = resyncRows_(snap.result, nextoPost_, { maxAttempts: 3, baseDelayMs: 500, sleep: Utilities.sleep }, snap.version, new Date().toISOString());
  console.log("全件再同期: " + JSON.stringify({ synced: res.synced, created: res.created, skipped: res.skipped, missing: res.missing.length, failed: res.failed }));
  return res;
}
