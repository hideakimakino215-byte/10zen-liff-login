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
