#!/usr/bin/env bash
# フェーズ1(完成形)のテストを一括実行(本番・秘密に接続しない)。必要: Node 22、PostgreSQL 16(/usr/lib/postgresql/16/bin)、e2e のみ Playwright+Chromium。
set -e
N="node --experimental-strip-types"
cd "$(dirname "$0")"
( cd patches && $N test_phase1_db.mjs && $N test_phase1_mirror.mjs ) 2>&1 | grep -v -i experimental | grep -E "ok -|passed|FAIL|Error"
( cd functions/member-api && $N test.mjs ) 2>&1 | grep -v -i experimental | grep -E "ok -|passed|FAIL|Error"
( cd app-core && $N test.mjs ) 2>&1 | grep -v -i experimental | grep -E "ok -|passed|FAIL|Error"
( cd app-reference && $N test_e2e.mjs ) 2>&1 | grep -v -i experimental | grep -E "ok -|passed|FAIL|Error"
