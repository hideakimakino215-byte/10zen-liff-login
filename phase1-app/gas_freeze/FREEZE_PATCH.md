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
