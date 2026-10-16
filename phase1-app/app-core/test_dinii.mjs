// ダイニーの注文画面への入口(app-core/dinii.mjs)の判定。実行: node app-core/test_dinii.mjs
import assert from "node:assert/strict";
import { diniiEnabled, diniiOrderUrl, ORDER_BUTTON, ORDER_NOT_DINII, ORDER_NO_SCAN } from "./dinii.mjs";

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

for (const s of [ORDER_BUTTON, ORDER_NOT_DINII, ORDER_NO_SCAN]) for (const w of ["治る", "効く", "改善"]) assert.ok(!s.includes(w));
ok("お客様に見せる文に「治る・効く・改善」がない");
console.log(`\n${n} dinii tests passed`);
