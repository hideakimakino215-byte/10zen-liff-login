# 同梱している外部ライブラリ(改変なし。公開リポジトリから配信するため、CDN の差し替えに依存しない)
| ファイル | 由来 | 版 | ライセンス |
|---|---|---|---|
| `supabase.js` | npm `@supabase/supabase-js` の `dist/umd/supabase.js`(グローバル `supabase`) | 2.116.0 | MIT(Copyright (c) 2020 Supabase) |
| `qrcode.js` | npm `qrcode-generator` の `dist/qrcode.js`(グローバル `qrcode`) | 2.0.4 | MIT(Copyright (c) 2009 Kazuhiko Arase。『QR Code』は株式会社デンソーウェーブの登録商標) |
LINE の LIFF SDK は同梱できない(LINE が配信元の利用を指定)ため、配信用の `vendor/liff.js` が公式の配信元から読み込む(`tools/build_v2.mjs` が生成)。
SHA-256: `shasum -a 256 vendor/*.js` を `tools/build_v2.mjs` の出力(MANIFEST)に記録する。
