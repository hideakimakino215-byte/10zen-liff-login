# コード.gs への追加(6か所・各1〜2行。既存の処理は変更しない)
凍結が未設定(`FROZEN` プロパティなし)の間は、従来どおり動きます。`freezeOn()` を実行した瞬間から、下の入口がすべて『メンテナンス中』になります(再デプロイ不要)。

| 関数 | 関数の1行目の直後に追加する行 | 理由 |
|---|---|---|
| `doGet(e)` | `var fg_ = freezeGuardGet_(e); if (fg_) return fg_;` | 外部ページ(JSONP)と管理ページ(`?page=admin`)の入口 |
| `lineEntry(...)` | `freezeGuard_();` | 画面(`google.script.run`)からの登録・来店 |
| `registerNewUser(...)` | `freezeGuard_();` | 同上(新規登録・紹介・キャンペーン) |
| `processUser(...)` | `freezeGuard_();` | 来店・ポイント付与の本体(Apps Script では末尾が `_` でない関数は画面から直接呼べるため、本体にも入れる) |
| `usePoints(...)` | `freezeGuard_();` | ポイント利用 |
| `getAdminDashboardData()` | `freezeGuard_();` | 管理ダッシュボードの読み取り |
| `notifyNexto(`(呼び出し2か所:`lineEntry` と `registerNewUser` の中) | `notifyNexto_(` に改名(`gas_sync/notifyNexto.gs` の定義も `notifyNexto_`) | 公開関数だと画面から任意の引数で呼べ、偽の来店イベントを Supabase へ送れてしまうため(現行の配信中の版にもある問題) |

## 公開関数の一覧(末尾が `_` でない関数は、画面から誰でも呼べる)
`gas_freeze/test_surface.mjs` が、追加するファイルの公開関数を機械的に確認する。所有者のみ(`assertOwner_()`)にしたもの: `freezeOn` `drainStatus` `snapshotUsers` `abortCutoverUnfreeze` `dailyBackupNow` `replayNextoFailures` `previewResyncToNexto` `resyncAllToNexto`。入口で6時間に1回までに制限したもの: `dailyBackup`(トリガー用)。
`assertOwner_()` は『実行している人=所有者』を確認する(`Session.getActiveUser()` と `getEffectiveUser()` のメールが一致)。時間トリガーの実行ではどちらが返るかは実機で未確認のため、`replayNextoFailures` を時間トリガーで動かす場合は、トリガーの実行ログで確認すること(切替日は凍結時にトリガーを削除する)。

## GAS 作業の手順(A3。順番どおりに)
1. **配信中の版との差分確認**: Apps Script の左メニュー『プロジェクトの履歴』で、配信中の版(78)と最新の `コード.gs` の違いを確認し、開発担当に伝える。
2. 新規ファイルを追加: `freeze.gs`(`gas_freeze/freeze.gs` の全文)、`backup.gs`(`gas_backup/backup.gs` の全文)。**`freeze.gs` を先に追加する**(他のファイルが `assertOwner_` を使うため)。
3. `nexto.gs` の全文を `gas_sync/nexto_v6_combined.gs` の全文に置き換える。
4. `コード.gs`: 上の表の6関数の先頭に1行ずつ追加し、`notifyNexto(` の呼び出し2か所を `notifyNexto_(` に変える。
5. プロジェクトの設定 → スクリプト プロパティ: `BACKUP_URL` = `https://ynqnhjvrzqdrfmvmudir.supabase.co/functions/v1/backup-export`(`CHECKIN_SECRET` は既存のものを使う)。
6. 関数 `dailyBackupNow` を選んで実行(初回は Drive・メール送信の権限の承認画面が出る)。ログに `ok: true, recorded: true` が出ること。Drive に『10ZEN_backup』フォルダとファイルができる。→ 開発担当に伝える(DB 側の記録を確認する)。
7. 関数 `installBackupTrigger` を実行(毎日午前3時台のトリガー)。トリガー画面で失敗通知を有効にする。
8. 『デプロイ』→『デプロイを管理』→ 鉛筆 → バージョン『新バージョン』→ デプロイ(URL は変わらない)。その後、現行の会員証が従来どおり開くことを確認。
**凍結はこの段階では実行しない**(`freezeOn` は切替日だけ)。
