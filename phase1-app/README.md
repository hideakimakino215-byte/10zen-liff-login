# 10ZEN デジタル会員証 フェーズ1(完成形)— コード(本番未反映)

このディレクトリは開発用のコードです。**本番(Supabase・LINE・GAS)には反映していません。** 秘密情報(鍵・パスワード・PIN・会員の個人情報)は含みません。

| 場所 | 内容 |
|---|---|
| `db/100_phase1_schema.sql` / `_DOWN.sql` | 会員・台帳・来店・ポイント使用申請・スタッフ権限・監査ログ・システム状態(frozen/test/open)・方針ゲート・バックアップ/復元。反映と戻し |
| `functions/member-api` | お客様向け API(LINE の ID トークン検証・店頭QR検証)。`qr.ts` は `staff-qr` と同一内容 |
| `functions/staff-qr` | 店頭タブレット用: staff/manager/kiosk のログイン済みアカウントにだけ30秒ごとに変わるQRを返す |
| `functions/backup-export` | バックアップの書き出し(合言葉は既存の秘密から計算) |
| `app-core` | 見た目に依存しないクライアントと画面の状態(UI はこれを使う) |
| `app-reference` | 参照実装の画面(`card.html` お客様 / `staff.html` スタッフ / `qr.html` 店頭タブレット専用)。見た目は最小限。最終UIはここを差し替える |
| `gas_backup` | 毎日のバックアップ(Google Apps Script)とそのテスト |
| `gas_freeze` | 切替日に旧GASの書込みを止める部品(所有者のみ実行可)と、公開関数の確認テスト |
| `gas_sync` | GAS から Supabase への同期(v6: `notifyNexto_` に改名、手動実行の関数は所有者のみ) |
| `patches`, `db/000`, `db/003` | テスト用の部品(使い捨て PostgreSQL ハーネス、JWT/LINE のスタブ、既存スキーマの再現)と、DB のテスト |

## 実行
`bash run_tests.sh`(root の Linux。Node 22、PostgreSQL 16、e2e のみ Playwright+Chromium。npm の依存パッケージはなし)。使い捨ての PostgreSQL を起動して実行し、本番には接続しない。
`gas_freeze/test_freeze.mjs` は、GAS ソースの写し(共通PINを含むため同梱しない)が無い環境では SKIP になる。
期待される件数: db 33 / controls 21 / mirror 8 / audit 5 / member-api 19 / app-core 10 / e2e 8 / backup 7 / surface 3(合計114)/ freeze 7(これだけ SKIP 可。他が SKIP・件数不足・失敗なら `run_tests.sh` は終了コード1)。
構成・API・UI 契約・切替/切戻し・運用は別の非公開資料(`audit_docs/`)にある。
