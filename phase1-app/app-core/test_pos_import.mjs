// レジの CSV の読み取り(pos-import.mjs)と KPI の画面用の定義(kpi.mjs)・スタッフのクライアント → 実 PostgreSQL の取り込みの検証。本番には接続しない。
// 擬似データ: fixtures/pos/(数字はすべて作り物。実在の売上・客数・店舗ではない)
//   uriage_jisseki_synthetic_utf16le_tab.csv   売上実績の形(UTF-16 LE・BOM・タブ・"…" で囲む)。日別の当年客数・前年客数・合計/週計の行。8/12 は0人・8/20 は外れ値
//   chumon_kyakusu_synthetic_utf16le_tab.csv   注文客数推移の形(同じ文字コード)。「集計対象」が注文金額と客数の縦持ち。合計・曜日平均の行
//   generic_synthetic_utf8bom_comma.csv        UTF-8(BOM)・カンマ・CRLF。囲みの中のカンマ・空の客数・「1,020」・合計の行
//   generic_synthetic_sjis_comma.csv           Shift_JIS・カンマ。見出しが「営業日」「来店人数」。同じ日付の2回目・存在しない日付・「35人」
// 実行: node --experimental-strip-types test_pos_import.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBytes, detectDelimiter, parseDelimited, parseDate, parseCount, detectColumns, analyzePosFile, summarize, rowsForImport, chunk, MAX_ROWS_PER_CALL, ERRORS, SKIP_REASONS } from "./pos-import.mjs";
import { KPI_DEFS, statusOf, parseTargetInput, fmtValue, milestoneLabel } from "./kpi.mjs";
import { createStaffClient, mapError } from "./staff-client.mjs";
import { startPg, q } from "../patches/pgdb.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => fs.readFileSync(path.join(HERE, "fixtures", "pos", f));
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const utf16be = (s) => { const le = Buffer.from(s, "utf16le"); const be = Buffer.alloc(le.length); for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; } return Buffer.concat([Buffer.from([0xfe, 0xff]), be]); };
const reasons = (r) => r.skipped.reduce((a, s) => ((a[s.reason] = (a[s.reason] || 0) + 1), a), {});

// ---- 1. 売上実績の形(UTF-16 LE・BOM・タブ) ----
{ const r = analyzePosFile(fx("uriage_jisseki_synthetic_utf16le_tab.csv"));
  assert.equal(r.ok, true); assert.equal(r.encoding, "utf-16le"); assert.equal(r.delimiter, "\t");
  assert.equal(r.header[r.mapping.dateCol], "当年日付"); assert.equal(r.header[r.mapping.customersCol], "当年客数");          // 前年日付・前年客数・前年差客・当年客単は選ばない
  assert.equal(r.days.length, 31); assert.equal(r.days[0].date, "2026-08-01"); assert.equal(r.days[30].date, "2026-08-31");
  assert.deepEqual(reasons(r), { not_a_date: 7 });                                                                         // TOTAL と MD週(6週)
  assert.ok(r.skipped.every((s) => /^(TOTAL|MD\d\d週)$/.test(s.value)));
  assert.equal(r.median, 69);
  assert.deepEqual(r.days.filter((d) => d.flag).map((d) => [d.date, d.customers, d.flag]), [["2026-08-12", 0, "zero"], ["2026-08-20", 420, "high"]]);
  const total = r.days.reduce((a, d) => a + d.customers, 0);
  assert.deepEqual(r.months, [{ month: "2026-08", days: 29, customers: total - 420, flagged: 2, excluded: 2 }]);              // 既定は外れ値を含めない
  assert.deepEqual(summarize(r.days, new Set(["2026-08-20"])), [{ month: "2026-08", days: 30, customers: total, flagged: 2, excluded: 1 }]);
  const rows = rowsForImport(r.days); assert.equal(rows.length, 29); assert.deepEqual(Object.keys(rows[0]), ["date", "customers"]);   // 日付と客数だけ(売上は送らない)
  assert.ok(!rows.some((x) => x.date === "2026-08-12" || x.date === "2026-08-20"));
  assert.equal(rowsForImport(r.days, new Set(["2026-08-12", "2026-08-20"])).length, 31); }
ok("売上実績の形(UTF-16 LE・BOM・タブ・囲み): 見出しから当年日付・当年客数を選ぶ(前年・差・客単は選ばない)。TOTAL・週計の行は理由つきで飛ばす。0人の日と中央値の3倍を超える日に印を付け、既定では取り込まない(含めることもできる)。送るのは日付と客数だけ");

// ---- 2. 注文客数推移の形(縦持ち: 集計対象=客数 の行の「合計」) ----
{ const r = analyzePosFile(fx("chumon_kyakusu_synthetic_utf16le_tab.csv"));
  assert.equal(r.ok, true); assert.equal(r.mapping.layout, "long"); assert.equal(r.header[r.mapping.dateCol], "営業日"); assert.equal(r.header[r.mapping.customersCol], "合計");
  assert.deepEqual(r.days.map((d) => d.customers), [43, 46, 49, 52, 55, 58, 61, 64, 67, 70]); assert.equal(r.days[0].date, "2026-07-01");   // 「2026/07/01(水)」
  assert.deepEqual(reasons(r), { not_customers_row: 10, not_a_date: 2 });                                                  // 注文金額の行・【合計】【水曜日 平均】
  assert.ok(r.days.every((d) => d.flag === null));
  // 注文金額だけのファイル(今の出力の形): 客数の行がないことを伝える
  const head = ["店舗コード", "店舗", "営業日", "集計対象", ...Array.from({ length: 12 }, (_, i) => `${i + 11}時`), "合計"].map((x) => `"${x}"`).join("\t");
  const line = (d) => ["000000", "試験店舗", d, "注文金額", ...Array(12).fill("￥1,000"), "￥12,000"].map((x) => `"${x}"`).join("\t");
  const only = analyzePosFile(utf16le([head, line("2026/07/01(水)"), line("2026/07/02(木)"), line("【合計】")].join("\n") + "\n"));
  assert.equal(only.ok, false); assert.equal(only.error, "no_customer_rows"); assert.deepEqual(only.kinds, ["注文金額"]); assert.match(ERRORS.no_customer_rows, /客数の行がありません/); }
ok("注文客数推移の形(縦持ち): 「集計対象」が客数の行の「合計」を、その日の客数として読む(注文金額の行・合計・曜日平均は理由つきで飛ばす)。注文金額だけのファイルは「客数の行がありません」");

// ---- 3. UTF-8(BOM)・カンマ・CRLF / Shift_JIS ----
{ const u = analyzePosFile(fx("generic_synthetic_utf8bom_comma.csv"));
  assert.equal(u.ok, true); assert.equal(u.encoding, "utf-8"); assert.equal(u.delimiter, ","); assert.equal(u.header[u.mapping.customersCol], "客数");
  assert.deepEqual(u.days.map((d) => [d.date, d.customers, d.flag]), [["2026-09-01", 55, null], ["2026-09-02", 61, null], ["2026-09-04", 1020, "high"], ["2026-09-05", 48, null]]);   // "1,020" も読める
  assert.deepEqual(reasons(u), { bad_customers: 1, not_a_date: 1 });                                                       // 9/3 は客数が空・合計の行
  assert.equal(u.skipped.find((s) => s.reason === "bad_customers").date, "2026-09-03");
  const s = analyzePosFile(fx("generic_synthetic_sjis_comma.csv"));
  assert.equal(s.ok, true); assert.equal(s.encoding, "shift_jis"); assert.equal(s.header[s.mapping.dateCol], "営業日"); assert.equal(s.header[s.mapping.customersCol], "来店人数");
  assert.deepEqual(s.days.map((d) => [d.date, d.customers]), [["2026-06-01", 30], ["2026-06-02", 32], ["2026-06-03", 28], ["2026-06-04", 35]]);   // 「35人」も読める
  assert.deepEqual(reasons(s), { duplicate_date: 1, not_a_date: 1 });                                                      // 6/2 の2回目・6/31(存在しない日付)
  // BOM なしの UTF-8・UTF-16 BE・BOM なしの UTF-16 LE
  assert.equal(decodeBytes(Buffer.from("日付,客数\n2026-01-01,5\n")).encoding, "utf-8");
  const be = analyzePosFile(utf16be("日付\t客数\n2026/01/02\t7\n")); assert.equal(be.encoding, "utf-16be"); assert.deepEqual(be.days.map((d) => d.customers), [7]);
  const le = decodeBytes(Buffer.from("日付\t客数\n2026/01/02\t7\n", "utf16le")); assert.equal(le.encoding, "utf-16le"); assert.match(le.text, /^日付\t客数/); }
ok("文字コードと区切り: UTF-8(BOM あり/なし)・カンマ・CRLF・囲みの中のカンマ、Shift_JIS、UTF-16(BE・BOM なしの LE も)を読める。見出しの「客数」「来店人数」「営業日」を自動で選ぶ。空の客数・同じ日付の2回目・存在しない日付は理由つきで飛ばす");

// ---- 4. 見出しの自動選択・列の選び直し・値の読み方 ----
{ assert.deepEqual(detectColumns(["Date", "Customers", "Sales"]), { layout: "wide", dateCol: 0, customersCol: 1, kindCol: -1 });
  assert.deepEqual(detectColumns(["前年日付", "当年日付", "前年客数", "当年客数", "当年客単"]), { layout: "wide", dateCol: 1, customersCol: 3, kindCol: -1 });
  assert.equal(detectColumns(["日", "売上", "組数"]).dateCol, null);
  // 見出しの言葉で選べないファイル: 列を選び直すと読める。見出しの前に説明の行があっても、日付の言葉を含む行を見出しにする
  const text = "書き出し: 試験\n日付,A列,B列\n2026-05-01,12,999\n2026-05-02,14,999\n";
  const a = analyzePosFile(Buffer.from(text)); assert.equal(a.ok, false); assert.equal(a.error, "no_customers_column"); assert.equal(a.headerRow, 1); assert.deepEqual(a.header, ["日付", "A列", "B列"]);
  const b = analyzePosFile(Buffer.from(text), { mapping: { customersCol: 1 } }); assert.equal(b.ok, true); assert.deepEqual(b.days.map((d) => d.customers), [12, 14]);
  assert.equal(analyzePosFile(Buffer.from(text), { mapping: { customersCol: 9 } }).error, "no_customers_column");
  assert.equal(analyzePosFile(Buffer.from("")).error, "empty");
  assert.equal(analyzePosFile(Buffer.from("名前,値\nあ,1\n")).error, "no_date_column");
  assert.equal(analyzePosFile(Buffer.from("日付,客数\n合計,5\n")).error, "no_days");
  for (const [v, d] of [["20260801", "2026-08-01"], ["2026/08/01(土)", "2026-08-01"], ["2026-8-1", "2026-08-01"], ["2026年8月1日", "2026-08-01"], ["２０２６／０８／０１", "2026-08-01"],
                        ["2026/08/01 10:00", "2026-08-01"], ["2026-02-30", null], ["1999-12-31", null], ["MD01週", null], ["TOTAL", null], ["", null]]) assert.equal(parseDate(v), d, v);
  for (const [v, c] of [["12", 12], ["1,234", 1234], ["1,234人", 1234], [" ７ ", 7], ["0", 0], ["-3", null], ["1.5", null], ["‐", null], ["", null], ["約10", null]]) assert.equal(parseCount(v), c, v);
  assert.equal(detectDelimiter("a\tb,c\td"), "\t"); assert.equal(detectDelimiter("a,b,c"), ",");
  assert.deepEqual(parseDelimited('"a ""q""",b\r\n"1,2",3\n\n', ","), [['a "q"', "b"], ["1,2", "3"]]);
  const fut = analyzePosFile(Buffer.from("日付,客数\n2026-05-01,3\n2026-05-03,4\n"), { today: "2026-05-02" });
  assert.deepEqual(fut.days.map((d) => d.date), ["2026-05-01"]); assert.deepEqual(fut.skipped.map((x) => [x.reason, x.date]), [["future_date", "2026-05-03"]]);
  assert.ok(Object.keys(SKIP_REASONS).length === 5); }
ok("列の選び方: 日付・客数の見出しの言葉(英語も)で自動で選び、前年などは選ばない。選べないときはエラーを返し、列を選び直すと読める。説明の行の後の見出しも見つける。日付(YYYYMMDD・曜日つき・年月日・全角)と客数(カンマ・人・全角)の読み方。今日より後の日付は飛ばす");

// ---- 5. KPI の画面用の定義 ----
{ assert.deepEqual(KPI_DEFS.map((d) => d.code), ["member_visit_rate", "new_members", "check_rate", "revisit_rate", "referral_clicks"]);
  assert.deepEqual([statusOf(100), statusOf(130), statusOf(99), statusOf(80), statusOf(79), statusOf(0), statusOf(null), statusOf(undefined)], ["ok", "ok", "warn", "warn", "bad", "bad", "none", "none"]);
  assert.deepEqual(parseTargetInput("member_visit_rate", "15"), { ok: true, value: 15 }); assert.deepEqual(parseTargetInput("check_rate", "55.5%"), { ok: true, value: 55.5 });
  assert.deepEqual(parseTargetInput("new_members", "1,200"), { ok: true, value: 1200 }); assert.deepEqual(parseTargetInput("revisit_rate", ""), { ok: true, value: null });
  for (const [c, v] of [["check_rate", "100.5"], ["check_rate", "10.25"], ["new_members", "10.5"], ["referral_clicks", "-1"], ["new_members", "100001"], ["nope", "1"]]) assert.equal(parseTargetInput(c, v).ok, false, `${c} ${v}`);
  assert.equal(fmtValue("member_visit_rate", 3), "3.0%"); assert.equal(fmtValue("new_members", 1200), "1,200人"); assert.equal(fmtValue("referral_clicks", null), "—");
  assert.equal(milestoneLabel(6), "6か月の目標"); assert.match(milestoneLabel(null), /目標なし/);
  assert.deepEqual(chunk(Array.from({ length: 401 }, (_, i) => i)).map((c) => c.length), [400, 1]); assert.equal(MAX_ROWS_PER_CALL, 400);
  for (const code of ["invalid_rows", "invalid_date", "invalid_customers", "invalid_month", "invalid_target", "invalid_kpi", "invalid_milestone"])
    assert.deepEqual(mapError({ message: `ERROR:  ${code}` }), { kind: "invalid", code }); }
ok("KPI の画面用: 並び(会員来店率・新規登録・実施率・再来店率・送客)、達成率の色の区分(100%以上=緑・80〜99%=オレンジ・80%未満=赤・目標なし=灰色)、目標の入力の確認(DB と同じ決まり)、表示の形、400行ごとの分割、入力の誤りの区別");

// ---- 6. スタッフのクライアント → 実 PostgreSQL(取り込みを400行ごとに分けて送る・権限) ----
const pg = startPg();
try {
  const STAFF = { mgr: "00000000-0000-0000-0000-0000000000a1", viewer: "00000000-0000-0000-0000-0000000000c3", staff: "00000000-0000-0000-0000-0000000000b2" };
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql"]) pg.loadFile(f);
  pg.exec(`update system_state set state='open'; insert into auth.users(id) values ${Object.values(STAFF).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role) values ('${STAFF.mgr}','店長','manager'),('${STAFF.viewer}','閲覧','viewer'),('${STAFF.staff}','スタッフ','staff');`);
  // supabase-js の rpc と同じく、配列・オブジェクトは JSON で渡す
  const sb = (uid) => ({ calls: [], async rpc(name, args) {
    this.calls.push(name);
    const named = Object.entries(args).map(([k, v]) => `${k} => ${v === null || v === undefined ? "null" : q(typeof v === "object" ? JSON.stringify(v) : v)}`).join(", ");
    const r = await pg.runAsync(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\nselect public.${name}(${named});`);
    return r.status === 0 ? { data: JSON.parse(r.stdout), error: null } : { data: null, error: { message: r.stderr } }; } });
  const mk = (uid) => { const s = sb(uid); return { s, c: createStaffClient({ supabase: s, qrEndpoint: "https://x.test/staff-qr" }) }; };
  const { s: ms, c: mgr } = mk(STAFF.mgr), { c: viewer } = mk(STAFF.viewer), { c: staff } = mk(STAFF.staff);
  const a = analyzePosFile(fx("uriage_jisseki_synthetic_utf16le_tab.csv"));
  const many = [...Array.from({ length: 420 }, (_, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 86400e3).toISOString().slice(0, 10), customers: 20 + (i % 9) })), ...rowsForImport(a.days)];
  let r = await mgr.importPosCustomers(many, "synthetic.csv");
  assert.deepEqual(r, { kind: "ok", data: { inserted: 449, updated: 0, unchanged: 0, calls: 2 } }); assert.equal(ms.calls.filter((x) => x === "manager_import_pos_customers").length, 2);
  r = await mgr.importPosCustomers(rowsForImport(a.days, new Set(["2026-08-20"])), "synthetic.csv");                      // 外れ値を含めて取り込み直す(上書き)
  assert.deepEqual(r.data, { inserted: 1, updated: 0, unchanged: 29, calls: 1 });
  const o = await viewer.kpiOverview(3); assert.equal(o.kind, "ok"); assert.equal(o.data.canEdit, false);
  const aug = o.data.months.find((x) => x.month === "2026-08"); assert.equal(aug.pos.customers, a.days.reduce((s, d) => s + d.customers, 0)); assert.equal(aug.pos.days, 30);   // 8/12(0人)は含めていない
  assert.equal(o.data.months.at(-1).isCurrent, true);
  r = await mgr.importPosCustomers([{ date: "2026-08-01", customers: 1 }, { date: "2099-01-01", customers: 1 }], "bad.csv"); assert.deepEqual([r.kind, r.code, r.sent], ["invalid", "invalid_date", 0]);
  assert.equal((await viewer.importPosCustomers([{ date: "2026-08-01", customers: 1 }], "v.csv")).kind, "forbidden");
  assert.equal((await staff.kpiOverview()).kind, "forbidden");
  assert.equal((await mgr.setLaunchDate("2026-10-10")).kind, "ok"); assert.equal((await mgr.kpiOverview(1)).data.launchDate, "2026-10-10");
  assert.equal((await mgr.setKpiTarget("check_rate", 3, 45)).kind, "ok"); assert.equal((await mgr.kpiOverview(1)).data.targets.check_rate["3"], 45);
  assert.deepEqual(await mgr.setKpiTarget("check_rate", 3, 101), { kind: "invalid", code: "invalid_target" });
  assert.equal((await mgr.setPosMonthly("2026-07", 1234)).kind, "ok"); assert.equal((await mgr.kpiOverview(4)).data.months.find((x) => x.month === "2026-07").pos.customers, 1234);
  assert.deepEqual(await mgr.setPosMonthly("2026-13", 1), { kind: "invalid", code: "invalid_month" });
  assert.equal((await viewer.setLaunchDate(null)).kind, "forbidden"); assert.equal((await mgr.kpiOverview(1)).data.launchDate, "2026-10-10");
  ok("クライアント → DB: 400行を超える取り込みは400行ごとに分けて送り(449行=2回)、取り込み直しは上書き。不正な行は取り込まない(送れた行数を返す)。閲覧は見るだけ・スタッフは集計も拒否。本番開始日・目標・月の客数を店長が変えられる");
} finally { pg.stop(); }
console.log(`\n${n} pos-import tests passed`);
