#!/usr/bin/env bash
# フェーズ1(完成形)のテストを一括実行(本番・秘密に接続しない)。1つでも失敗・異常終了・期待件数の不足があれば、終了コード 1 で終わる。
# 必要: Linux(root で実行: テスト用の PostgreSQL を postgres ユーザーで起動する)、Node 22(--experimental-strip-types)、PostgreSQL 16(/usr/lib/postgresql/16/bin)。
#       e2e のみ Playwright+Chromium(/opt/node-tools/node_modules/playwright、/opt/pw-browsers/chromium-1294/chrome-linux/chrome)。npm の依存パッケージはなし。
# 使い捨て PostgreSQL は各スイートが <tmp>/pgt-<実行ID>-* に作り、終わると(失敗・中断でも)消す。接続は専用ディレクトリの UNIX ソケットだけで、
# ポートはプロセスごとに変わるので、同時に2つ実行してもぶつからない。最後に、この実行の pgt-* が残っていないことを確かめる(残っていたら消して失敗にする)。
set -u
N="node --experimental-strip-types"
cd "$(dirname "$0")"
export PGT_RUN_ID="run$$-$(date +%s)"
PGT_GLOB="${TMPDIR:-/tmp}/pgt-${PGT_RUN_ID}-"
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
run patches test_pgdb.mjs 3
run patches test_phase1_db.mjs 33
run patches test_phase1_controls.mjs 22
run patches test_phase1_mirror.mjs 8
run patches audit_additive.mjs 6
run patches test_sample_delete_restore.mjs 3
run patches test_rank_perks.mjs 13
run patches test_constitution.mjs 11
run patches test_member_constitution.mjs 5
run patches test_kpi.mjs 10
run patches test_referral.mjs 12
run patches test_constitution_each_visit.mjs 7
run patches test_restore_old_backup.mjs 6
run patches test_audit_fixes.mjs 5
run patches test_safeupdate.mjs 4
run patches test_ruby_tea.mjs 5
run patches test_list_cc_audit.mjs 4
run patches test_suspicious_slot.mjs 4
run functions/member-api test.mjs 19
run app-core test.mjs 10
run app-core test_store_info.mjs 3
run app-core test_perks.mjs 5
run app-core test_constitution.mjs 8
run app-core test_pos_import.mjs 7
run app-core test_referral.mjs 5
run app-core test_dinii.mjs 7
run app-core test_i18n.mjs 7
run app-reference test_e2e.mjs 24
run tools test_build_v2.mjs 5
run tools test_built_e2e.mjs 4
run tools test_kiosk_copy.mjs 4
run gas_backup test_backup.mjs 7
run gas_backup test_watchdog.mjs 9
run gas_backup test_monthly_report.mjs 9
run gas_freeze test_surface.mjs 4
run gas_freeze test_codegs_edits.mjs 6
run gas_freeze test_admin_stop.mjs 5
run gas_freeze test_freeze.mjs 7 skip-ok
echo "合格 ${TOTAL} 件 / 失敗したスイート ${FAILED} 件 / SKIP ${SKIPPED} 件"
# 合格が想定より少ない(全体が SKIP・0件など)場合も失敗。freeze の7件を除く最小は 309(ランク特典で +20、1分体質チェックで +19、体質と会員の紐づけ・五行の色で +8、目標とKPI で +18、友だち紹介と月次レポートで +28、体質チェックを来店のたびに(任意)で +8、102 より前のバックアップの復元(監査 M-1)で +6、停止中の会員のコード(監査 L-1)で +3、五巡茶の出し方の区分と凍結(監査 L-2)で +2、レジの取り込みの上限(監査 L-5)で +1、テスト用 DB の後片付け(監査 L-6)で +3、WHERE のない UPDATE の修正(111)で +4、全部同点の表示で +1、RUBY の季節の五巡茶(112)で +5、ダイニーの注文ボタンで +4、一覧の体質の印の記録(監査 L-3)で +5、お席の QR から注文・Web 版の体質チェック・お席の QR の印刷で +5、ペルソナ実験の直しで +1、英語・中国語で +8、要確認の人数(114)で +4)
if [ "$TOTAL" -lt 309 ]; then echo "!! 合格件数が足りません(${TOTAL} < 309)"; FAILED=$((FAILED + 1)); fi
# 後片付けの確認(監査 L-6): この実行で作った使い捨て DB のディレクトリが残っていたら、止めて消したうえで失敗にする
LEFT=$(ls -d "$PGT_GLOB"* 2>/dev/null | wc -l)
if [ "$LEFT" -ne 0 ]; then
  echo "!! 使い捨て DB のディレクトリが ${LEFT} 個残っていました(${PGT_GLOB}*)。止めて消します"
  for d in "$PGT_GLOB"*; do su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $d/data -m immediate stop" >/dev/null 2>&1; rm -rf "$d"; done
  FAILED=$((FAILED + 1))
else echo "後片付け: この実行の使い捨て DB(${PGT_GLOB}*)は残っていません"; fi
[ "$FAILED" -eq 0 ]
