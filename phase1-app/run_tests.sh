#!/usr/bin/env bash
# フェーズ1(完成形)のテストを一括実行(本番・秘密に接続しない)。
# 必要: Linux(root で実行: テスト用の PostgreSQL を postgres ユーザーで起動する)、Node 22(--experimental-strip-types)、PostgreSQL 16(/usr/lib/postgresql/16/bin)。
#       e2e のみ Playwright+Chromium(/opt/node-tools/node_modules/playwright、/opt/pw-browsers/chromium-1194/chrome-linux/chrome)。npm の依存パッケージはなし。
# 使い捨て PostgreSQL はポート 55433 を使う(同時に2つ実行しないこと)。
set -e
N="node --experimental-strip-types"
cd "$(dirname "$0")"
run() { ( cd "$1" && $N "$2" ) 2>&1 | grep -v -i experimental | grep -E "ok -|passed|FAIL|Error|SKIP"; }
run patches test_phase1_db.mjs
run patches test_phase1_controls.mjs
run patches test_phase1_mirror.mjs
run patches audit_additive.mjs
run functions/member-api test.mjs
run app-core test.mjs
run app-reference test_e2e.mjs
run gas_backup test_backup.mjs
run gas_freeze test_freeze.mjs
