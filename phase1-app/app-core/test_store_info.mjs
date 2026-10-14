// 店舗情報(裏面の引き継ぎ)の検証。実行: node --experimental-strip-types test_store_info.mjs
import assert from "node:assert/strict";
import { STORE, quizUrl, flowFromLocation } from "./store-info.mjs";
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
assert.equal(STORE.telHref, "tel:0364505834"); assert.ok(STORE.mapUrl.startsWith("https://maps.google.com/?q=")); assert.ok(STORE.bookingUrl.startsWith("https://booking.ebica.jp/"));
assert.throws(() => { "use strict"; STORE.telHref = "x"; });
ok("電話・地図・WEB予約の値が旧 index.html のとおり。値は変更できない(凍結)");
assert.equal(quizUrl("U123"), "https://tally.so/r/440keB?line_user_id=U123"); assert.equal(quizUrl(null), "https://tally.so/r/440keB");
assert.equal(quizUrl("U a&b"), "https://tally.so/r/440keB?line_user_id=U%20a%26b");
ok("30秒体質チェックの URL は line_user_id を付ける(特殊文字は符号化、未取得なら付けない)");
assert.equal(flowFromLocation("?flow=quiz"), "quiz"); assert.equal(flowFromLocation("?action=visit&flow=quiz&t=1"), "quiz");
assert.equal(flowFromLocation("?liff.state=%3Fflow%3Dquiz"), "quiz"); assert.equal(flowFromLocation("?flow=other"), null); assert.equal(flowFromLocation(""), null);
ok("旧仕様の flow=quiz を拾う(LIFF 経由の liff.state も)。他の値・無指定は何もしない");
console.log(`${n} store-info checks passed`);
