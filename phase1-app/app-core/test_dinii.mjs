// ダイニーの注文画面への入口(app-core/dinii.mjs)の判定。実行: node app-core/test_dinii.mjs
import assert from "node:assert/strict";
import { diniiEnabled, diniiOrderUrl, diniiTableUrl, tableFromParam, rememberTable, recallTable, tableQrUrl, parseTableList, TABLE_POP, TABLE_QR_MAX, TABLE_KEY, TABLE_TTL_MS, ORDER_BUTTON, ORDER_BUTTON_TABLE, ORDER_NOT_DINII, ORDER_NO_SCAN, ORDER_NOTE } from "./dinii.mjs";

let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const SHOP = "3fdf5fed-fee4-47df-b541-0cb32e93d14a", TABLE = "7288bb93-b215-4d4a-bd07-0ac76e85f7b0", LIFF = "1653687169-wzDlrXnN";
const cfg = { shopId: SHOP, liffId: LIFF };

assert.equal(diniiEnabled({}), false); assert.equal(diniiEnabled({ diniiShopId: "" }), false); assert.equal(diniiEnabled({ diniiShopId: "x y" }), false);
assert.equal(diniiEnabled({ diniiShopId: SHOP }), true);
ok("店舗IDが設定されるまでボタンを出さない(空・形の違う値は出さない)");

const web = `https://web.self.dinii.jp/gateway?shopId=${SHOP}&tableCode=${TABLE}`;
const line = `https://liff.line.me/${LIFF}/shops/${SHOP}/items?shopId=${SHOP}&tableCode=${TABLE}`;
assert.equal(diniiOrderUrl(web, cfg), web);
assert.equal(diniiOrderUrl(line, cfg), line);
assert.equal(diniiOrderUrl(`${line}&liffClientId=${LIFF}`, cfg), `${line}&liffClientId=${LIFF}`);                    // LINE 連携で末尾に1つ増えても通す
assert.equal(diniiOrderUrl(`  ${web}\n`, cfg), web);
ok("ダイニーの2つの形(通常・LINE 連携あり)で、10ZEN の店舗IDとテーブルがあれば、その URL を開く");

const bad = [
  web.replace(SHOP, "00000000-0000-0000-0000-000000000000").replace(`shopId=00000000-0000-0000-0000-000000000000`, "shopId=00000000-0000-0000-0000-000000000000"),  // 他店
  `https://web.self.dinii.jp/gateway?shopId=${SHOP}`,                                           // テーブルなし
  `http://web.self.dinii.jp/gateway?shopId=${SHOP}&tableCode=${TABLE}`,                       // http
  `https://web.self.dinii.jp.evil.example/gateway?shopId=${SHOP}&tableCode=${TABLE}`,        // 似せた別のサイト
  `https://evil.example/?u=https://web.self.dinii.jp/gateway&shopId=${SHOP}&tableCode=${TABLE}`,
  `https://web.self.dinii.jp/other?shopId=${SHOP}&tableCode=${TABLE}`,                        // 別の場所
  `https://liff.line.me/1234567890-AAAAAAAA/shops/${SHOP}/items?shopId=${SHOP}&tableCode=${TABLE}`, // 別の LIFF
  `https://liff.line.me/${LIFF}/shops/OTHERSHOP1/items?shopId=${SHOP}&tableCode=${TABLE}`,   // パスと店舗IDの食い違い
  `https://user:pw@web.self.dinii.jp/gateway?shopId=${SHOP}&tableCode=${TABLE}`,
  `https://web.self.dinii.jp:8443/gateway?shopId=${SHOP}&tableCode=${TABLE}`,
  `javascript:alert(1)//https://web.self.dinii.jp/gateway?shopId=${SHOP}&tableCode=${TABLE}`,
  `https://web.self.dinii.jp/gateway?shopId=${SHOP}&tableCode=<script>`,
  "10ZEN の会員証", "", null, undefined, 123, web + "&x=" + "a".repeat(600),
];
for (const b of bad) assert.equal(diniiOrderUrl(b, cfg), null, String(b).slice(0, 80));
assert.equal(diniiOrderUrl(web, { shopId: "", liffId: LIFF }), null);                        // 店舗ID未設定なら何も開かない
assert.equal(diniiOrderUrl(line, { shopId: SHOP }), null);                                   // LIFF ID 未設定なら LINE 連携の形は開かない(通常の形は開く)
assert.equal(diniiOrderUrl(web, { shopId: SHOP }), web);
ok("他店・テーブルなし・http・似せたサイト・別の LIFF・パスの食い違い・利用者名やポート付き・スクリプト・長すぎる値・未設定は開かない");

const gw = `https://web.self.dinii.jp/gateway?liffId=${LIFF}&shopId=${SHOP}&tableCode=${TABLE}`;   // ダイニーの回答(2026-10-21)の1つの形
assert.equal(diniiTableUrl(TABLE, cfg), gw);
assert.equal(diniiTableUrl(TABLE, { shopId: SHOP }), web);                                       // LIFF ID がなければ付けない
assert.equal(diniiOrderUrl(diniiTableUrl(TABLE, cfg), cfg), gw);                                  // 作った URL は読み取りの判定も通る
assert.equal(diniiOrderUrl(gw, cfg), gw);                                                         // ダイニーの席の QR(liffId 付き)も開く
assert.equal(diniiOrderUrl(gw.replace(LIFF, "2011158053-N7nKgExB"), cfg), null);                  // 別の LIFF ID が付いた URL は開かない
assert.equal(diniiOrderUrl(gw, { shopId: SHOP }), null);                                          // LIFF ID 未設定なのに付いているときも開かない
for (const t of ["", null, undefined, "a b", "<x>", "../x", "a".repeat(65), 12]) { assert.equal(tableFromParam(t), null); assert.equal(diniiTableUrl(t, cfg), null); }
assert.equal(diniiTableUrl(TABLE, { shopId: "", liffId: LIFF }), null);
ok("お席の QR のテーブルから、読み直さずにそのテーブルの注文画面の URL を作る(形の違うテーブル・店舗ID未設定は作らない)");

{ const m = new Map(), st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }, t0 = 1_800_000_000_000;
  assert.equal(recallTable(st, t0), null);
  rememberTable(st, "<bad>", t0); assert.equal(recallTable(st, t0), null);
  rememberTable(st, "T12", t0); assert.equal(recallTable(st, t0 + 1000), "T12"); assert.equal(recallTable(st, t0 + TABLE_TTL_MS), null);   // 4時間で忘れる
  m.set(TABLE_KEY, "{broken"); assert.equal(recallTable(st, t0), null);
  m.set(TABLE_KEY, JSON.stringify({ t: "<x>", at: t0 })); assert.equal(recallTable(st, t0), null);
  const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  rememberTable(bad, "T12", t0); assert.equal(recallTable(bad, t0), null); assert.equal(recallTable(undefined, t0), null); }
ok("お席の QR から入ったことを端末に4時間だけ覚える(壊れた値・使えない端末では覚えない)");

assert.equal(tableQrUrl("2011158053-fsQb9Hvf", "T07"), "https://liff.line.me/2011158053-fsQb9Hvf/check.html?table=T07");
assert.equal(tableQrUrl("x", "T07"), null); assert.equal(tableQrUrl("2011158053-fsQb9Hvf", "a b"), null);
{ const r = parseTableList("A1,T01\n\n窓側 2,T02\nT03\nB,<x>\nC,T01\n テラス\tT04 ");
  assert.deepEqual(r.rows, [{ label: "A1", table: "T01" }, { label: "窓側 2", table: "T02" }, { label: "T03", table: "T03" }, { label: "テラス", table: "T04" }]);
  assert.deepEqual(r.skipped.map((x) => x.line), [5, 6]);
  const many = parseTableList(Array.from({ length: TABLE_QR_MAX + 3 }, (_, i) => `T${i}`).join("\n"));
  assert.equal(many.rows.length, TABLE_QR_MAX); assert.equal(many.skipped.length, 3); }
ok("お席に置く QR: 中身は体質チェック(?table=)。一覧は「表示名,テーブルコード」で読み、形の違う行・重複・上限を超えた行は行番号つきで飛ばす");

assert.match(ORDER_NOTE, /スタッフ/); assert.doesNotMatch(ORDER_NOTE, /大丈夫/);                                    // アレルギーは「大丈夫」と言わずスタッフへ
for (const s of [ORDER_BUTTON, ORDER_BUTTON_TABLE, ORDER_NOT_DINII, ORDER_NO_SCAN, ORDER_NOTE, ...Object.values(TABLE_POP)]) for (const w of ["治る", "効く", "改善"]) assert.ok(!s.includes(w));
ok("お客様に見せる文に「治る・効く・改善」がない");
console.log(`\n${n} dinii tests passed`);
