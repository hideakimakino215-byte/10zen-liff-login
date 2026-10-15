// 会員証の裏面・店舗情報(旧 index.html の裏面から引き継ぐ): 営業時間・電話(タップで発信)・住所(Google マップ)・WEB予約・30秒体質チェック(Tally)。
// 値は旧 index.html の記載のまま。変更はこのファイルだけで済む。UI(最終デザイン)はここの値と関数をそのまま使うこと。
export const STORE = Object.freeze({
  name: "10ZEN 青山店",
  hoursText: "営業時間: 11:00〜21:00 (L.O 20:30)",
  telText: "03-6450-5834",
  telHref: "tel:0364505834",
  addressText: "東京都港区南青山5-10-19 青山真洋ビルB1F",
  mapUrl: "https://maps.google.com/?q=東京都港区南青山5丁目10-19+青山真洋ビル地下1階",
  bookingUrl: "https://booking.ebica.jp/webrsv/search/e014032801/23809",
  quizBaseUrl: "https://tally.so/r/440keB",
});
// 1分体質チェックの結果画面の「薬日本堂の漢方相談へ」の行き先。
// TODO: 仮の行き先(薬日本堂のトップページ)。漢方相談の正式な案内先・10ZEN 経由の案内コードは、薬日本堂との相談で決めてから差し替える
export const NIHONDO_CONSULT_URL = "https://www.nihondo.co.jp/";
// 30秒体質チェックの URL。Tally は line_user_id を隠しフィールドで受け取り、回答を顧客に紐づける(tally-webhook)。LINE ID が未取得なら付けない。
export function quizUrl(lineUserId) {
  return lineUserId ? `${STORE.quizBaseUrl}?line_user_id=${encodeURIComponent(lineUserId)}` : STORE.quizBaseUrl;
}
// 旧仕様の flow=quiz: 来店/登録の処理が終わったあと、そのまま体質チェックへ移動する。LIFF 経由で liff.state に入っていても拾う。
export function flowFromLocation(search) {
  let p = new URLSearchParams(search || "");
  const st = p.get("liff.state");
  if (st && !p.get("flow")) { try { p = new URLSearchParams(st.startsWith("?") ? st.slice(1) : st.replace(/^\/?\??/, "")); } catch (_e) { /* 無視 */ } }
  return p.get("flow") === "quiz" ? "quiz" : null;
}
