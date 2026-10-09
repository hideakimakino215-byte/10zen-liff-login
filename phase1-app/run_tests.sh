#!/usr/bin/env bash
# フェーズ1(完成形)のテストを一括実行(本番・秘密に接続しない)。1つでも失敗・異常終了・期待件数の不足があれば、終了コード 1 で終わる。
# 必要: Linux(root で実行: テスト用の PostgreSQL を postgres ユーザーで起動する)、Node 22(--experimental-strip-types)、PostgreSQL 16(/usr/lib/postgresql/16/bin)。
#       e2e のみ Playwright+Chromium(/opt/node-tools/node_modules/playwright、/opt/pw-browsers/chromium-1294/chrome-linux/chrome)。npm の依存パッケージはなし。
# 使い捨て PostgreSQL はポート 55433 を使う(同時に2つ実行しないこと)。
set -u
N="node --experimental-strip-types"
cd "$(dirname "$0")"
FAILED=0; TOTAL=0; SKIPPED=0
# run <ディレクトリ> <ファイル> <期待する合格件数> [skip-ok]
#   SKIP を許すのは、非公開の GAS ソースの写しが必要な gas_freeze/test_freeze.mjs だけ(第4引数 skip-ok)。他のスイートが SKIP したら失敗。
run() {
  local out rc passed
  out=$( cd "$1" && $N "$2" 2>&1 ); rc=$?
  echo "$out" | grep -v -i experimental | grep -E "ok -|passed|FAIL|Error|SKIP"
  passed=$(echo "$out" | grep -oE '^[0-9]+ [a-z0-9 -]*(passed|checks passed)' | head -1 | grep -oE '^[0-9]+')
  if [ "$rc" -ne 0 ]; then echo "!! 失敗: $1/$2 (終了コード $rc)"; FAILED=$((FAILED + 1));
  elif echo "$out" | grep -q '^SKIP'; then
    if [ "${4:-}" = "skip-ok" ]; then echo "-- SKIP: $1/$2 (許可: 非公開ソースが必要)"; SKIPPED=$((SKIPPED + 1));
    else echo "!! SKIP は許可されていない: $1/$2"; FAILED=$((FAILED + 1)); fi
  elif [ "${passed:-0}" -ne "$3" ]; then echo "!! 件数が想定と違う: $1/$2 (合格 ${passed:-0} / 想定 $3)"; FAILED=$((FAILED + 1));
  else TOTAL=$((TOTAL + passed)); fi
}
run patches test_phase1_db.mjs 33
run patches test_phase1_controls.mjs 22
run patches test_phase1_mirror.mjs 8
run patches audit_additive.mjs 6
run patches test_sample_delete_restore.mjs 3
run functions/member-api test.mjs 19
run app-core test.mjs 10
run app-reference test_e2e.mjs 8
run tools test_build_v2.mjs 5
run tools test_built_e2e.mjs 4
run gas_backup test_backup.mjs 7
run gas_freeze test_surface.mjs 4
run gas_freeze test_freeze.mjs 7 skip-ok
echo "合格 ${TOTAL} 件 / 失敗したスイート ${FAILED} 件 / SKIP ${SKIPPED} 件"
# 合格が想定より少ない(全体が SKIP・0件など)場合も失敗。freeze の7件を除く最小は 129
if [ "$TOTAL" -lt 129 ]; then echo "!! 合格件数が足りません(${TOTAL} < 129)"; FAILED=$((FAILED + 1)); fi
[ "$FAILED" -eq 0 ]
