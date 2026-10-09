# 10ZEN デジタル会員証 フェーズ1(完成形)— コード(未公開・本番未反映)

このディレクトリは開発用のコードです。**本番(Supabase・LINE・GAS)には反映していません。** 秘密情報は含みません。

| 場所 | 内容 |
|---|---|
| `db/100_phase1_schema.sql` / `_DOWN.sql` | 会員・台帳・来店・ポイント使用申請・スタッフ権限・監査ログ。反映と戻し |
| `functions/member-api` | お客様向け API(LINE の ID トークン検証・店頭QR検証)。`qr.ts` は `staff-qr` と同一内容 |
| `functions/staff-qr` | 店頭タブレット用: ログイン済みスタッフにだけ30秒ごとに変わるQRを返す |
| `app-core` | 見た目に依存しないクライアントと画面の状態(UI はこれを使う) |
| `app-reference` | 参照実装の画面(見た目は最小限。最終UIはここを差し替える) |
| `patches`, `db/000`, `db/003` | テスト用の部品(使い捨て PostgreSQL ハーネス、JWT/LINE のスタブ、既存スキーマの再現) |

実行: `./run_tests.sh`(PostgreSQL 16 が必要。e2e は Chromium)。構成・API・UI 契約の詳細は別の非公開資料にある。
