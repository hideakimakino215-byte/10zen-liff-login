// GAS 用(純粋関数のみ。UrlFetchApp・シート読取等は呼び出し側から注入)。Node のテストでも同じファイルを読み込んで検証する。
// v3(監査#2 反映):
//  * 来店イベントは固有キー eventKey = 'visit:' + LINE ID + ':' + 来店日(JST)。Supabase 側がキーの一意制約で「ちょうど1回」処理する。
//    処理日・再送日には依存しない。同じイベントを何度送っても(日付をまたいでも)1回だけ。
//  * ポイント値は常に「送信直前に正本(Users シート)から読み直した現在値」と「版」を付けて送る。版は読取と同じスクリプトロック内で採番する単調増加の整数。
//    HTTP が遅れて後から届いた古い読取結果は、版が小さいので Supabase 側で反映されない(時刻の比較ではない)。
//    失敗キューには値・版を保存しない。読めなかった場合は、ポイント値を付けずイベントだけを送る(古い引数に新しい版を付けない)。

function jstDate_(ms) {                                   // 'YYYY-MM-DD'(JST)
  var d = new Date(ms + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function visitKey_(lineUserId, eventAtMs) { return 'visit:' + lineUserId + ':' + jstDate_(eventAtMs); }
function registerKey_(lineUserId) { return 'register:' + lineUserId; }

// v5: シートのセルを「確実に読めた整数」だけ数値にする。読めない値(日付書式で Date になったセル・空・文字)は null を返し、0 などに置き換えない。
//  * number: 0 以上の有限な整数のみ。 * string: 前後の空白と桁区切りカンマを除いた全桁が数字のときだけ。 * Date・その他: null(日付書式のセルは値を推測しない)
function parseCount_(v) {
  if (typeof v === 'number') return (isFinite(v) && v >= 0 && Math.floor(v) === v) ? v : null;
  if (typeof v === 'string') { var t = v.replace(/[\s,，]/g, ''); return /^[0-9]{1,9}$/.test(t) ? parseInt(t, 10) : null; }
  return null;
}
function cellKind_(v) { return v instanceof Date ? 'date' : (v === null || v === undefined || v === '') ? 'empty' : typeof v; }
// Users シートの1行(配列)→同期用の行。列: 0=userId 2=rank 3=points 4=lifetime 5=lastVisit 7=lineUserId。
// points / lifetimePoints は読めなければ null。issues に読めなかった項目を残す(値は含めない)。LINE ID が無い行は lineUserId が空(呼び出し側で除外)。
function buildUserRow_(raw) {
  if (!raw) return null;
  var points = parseCount_(raw[3]), life = parseCount_(raw[4]), issues = [];
  if (points === null) issues.push('points:' + cellKind_(raw[3]));
  if (life === null) issues.push('lifetime:' + cellKind_(raw[4]));
  var lv = null; if (raw[5]) { var d = raw[5] instanceof Date ? raw[5] : new Date(raw[5]); if (!isNaN(d.getTime())) lv = d.toISOString(); }
  return { lineUserId: raw[7] || '', userId: raw[0], points: points, lifetimePoints: life,
           rank: String(raw[2] || 'white_opal').toLowerCase().replace(/ /g, '_'), lastVisit: lv, issues: issues };
}

// 版の採番(GAS では会員シートの読取と同じスクリプトロック内で呼ぶ)。単調増加: 前回の版+1 と現在時刻(ms)の大きい方。
// プロパティが失われて prev=0 に戻っても、時刻が下限になるので巻き戻らない。
function nextVersion_(prev, nowMs) { return Math.max((parseInt(prev, 10) || 0) + 1, nowMs); }

// userRow = 正本の現在値 {userId, points, lifetimePoints, rank, version}(version はロック内で読取と同時に採番したもの)または null。
// 版のない値・読めなかった場合は、ポイント値を一切付けない(呼び出し引数などの古い値に新しい版を付けて送ることはしない)。
function buildEventPayload_(entry, userRow) {
  var p = { lineUserId: entry.lineUserId, eventKey: entry.eventKey, eventAt: entry.eventAt };
  // v5: 現在値が読めた(points が整数)場合だけポイント系を付ける。lifetimePoints が読めなければそれだけ省く(サーバー側は「送らない=変更しない」)。
  if (userRow && typeof userRow.version === 'number' && Number.isInteger(userRow.points)) {
    p.userId = userRow.userId; p.points = userRow.points; p.rank = userRow.rank; p.version = userRow.version;
    if (Number.isInteger(userRow.lifetimePoints)) p.lifetimePoints = userRow.lifetimePoints;
  }
  return p;
}
function buildSyncPayload_(row, version) {
  var p = { lineUserId: row.lineUserId, syncOnly: true, userId: row.userId, points: row.points, rank: row.rank, version: version };
  if (Number.isInteger(row.lifetimePoints)) p.lifetimePoints = row.lifetimePoints;   // 読めなかった累計は送らない(0 にしない)
  if (row.lastVisit) p.lastVisitedAt = row.lastVisit;
  return p;
}
// 失敗キューに残す内容。ポイント等の値・版は含めない(再送時に正本から読み直して新しく採番する)。
function buildQueueEntry_(entry, result, nowIso) {
  return { failedAt: nowIso, kind: 'visit', eventKey: entry.eventKey, eventAt: entry.eventAt, lineUserId: entry.lineUserId, userId: entry.userId || '', code: result.code, error: result.error };
}

// post(payload) => {code:number, body:string}(通信エラーは例外)。sleep(ms) は注入(GAS では Utilities.sleep)。
// 2xx=成功。4xx は設定・入力の誤りなので再試行しない(401=秘密の不一致、400=検証エラー)。5xx と通信エラーは再試行する。
function postWithRetry_(post, payload, opts) {
  opts = opts || {};
  var max = opts.maxAttempts || 3, base = opts.baseDelayMs || 500, sleep = opts.sleep || function () {};
  var last = null;
  for (var attempt = 1; attempt <= max; attempt++) {
    try {
      var res = post(payload);
      if (res.code >= 200 && res.code < 300) return { ok: true, code: res.code, attempts: attempt };
      last = { ok: false, code: res.code, attempts: attempt, error: 'http_' + res.code };
      if (res.code < 500) return last;                         // 再試行しても直らない
    } catch (e) {
      last = { ok: false, code: 0, attempts: attempt, error: 'network: ' + String(e && e.message || e).slice(0, 100) };
    }
    if (attempt < max) sleep(base * Math.pow(2, attempt - 1));
  }
  return last;
}

// 失敗キューの再送。entries=[{eventKey,eventAt,lineUserId,userId,replayed}]。readUser(userId, lineUserId) は正本の現在値 or null。
// 値は再送の時点で正本から読み直し(readUser がロック内で版も採番)、失敗時点の値は使わない。イベント自体は同じ eventKey で送る(未処理なら1回だけ処理、処理済みなら重複として無害)。
function replayQueue_(entries, readUser, post, opts) {
  var res = { replayed: [], failed: [] };
  entries.forEach(function (e, i) {
    if (e.replayed) return;
    var row = readUser(e.userId, e.lineUserId);
    var payload = buildEventPayload_(e, row);
    var r = postWithRetry_(post, payload, opts);
    if (r.ok) res.replayed.push(i); else res.failed.push({ index: i, userId: e.userId, code: r.code, error: r.error });
  });
  return res;
}

// 全件再同期(障害後)。rows は buildUserRow_ の結果([{lineUserId,userId,points,lifetimePoints,rank,lastVisit,issues}])。version はその読取と同じロック内で採番した値。
// v5(来店回数を意図せず増やさない・値を壊さない):
//  * points が読めなかった行は送らない(skipped に理由だけ記録)。累計が読めなければ累計だけ送らない。
//  * syncOnly で更新する。Supabase に顧客がいない(404)場合は、既定では何も作らず missing に記録する(来店回数 1 の新規顧客と来店履歴を作らないため)。
//    作成したい場合だけ opts.allowCreate=true(来店日のキーなので二重にはならない)。1件の失敗で全体を止めない。
function resyncRows_(rows, post, opts, version, nowIso) {
  opts = opts || {};
  var results = { synced: 0, created: 0, skipped: [], missing: [], failed: [] };
  rows.forEach(function (r) {
    if (!Number.isInteger(r.points)) { results.skipped.push({ userId: r.userId, reason: (r.issues || []).join(',') || 'points unreadable' }); return; }
    var a = postWithRetry_(post, buildSyncPayload_(r, version), opts);
    if (a.ok) { results.synced++; return; }
    if (a.code === 404) {
      if (!opts.allowCreate) { results.missing.push({ userId: r.userId }); return; }
      var at = r.lastVisit || nowIso;
      var key = r.lastVisit ? visitKey_(r.lineUserId, Date.parse(r.lastVisit)) : registerKey_(r.lineUserId);
      var b = postWithRetry_(post, buildEventPayload_({ lineUserId: r.lineUserId, eventKey: key, eventAt: at }, { userId: r.userId, points: r.points, lifetimePoints: r.lifetimePoints, rank: r.rank, version: version }), opts);
      if (b.ok) { results.created++; return; }
      results.failed.push({ userId: r.userId, code: b.code, error: b.error }); return;
    }
    results.failed.push({ userId: r.userId, code: a.code, error: a.error });
  });
  return results;
}
