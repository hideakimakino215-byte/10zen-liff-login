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
// 薬日本堂の公式「漢方相談」の案内ページ(相談の流れ・オンライン相談の予約・店舗検索へ進める)。2026-10-20 牧野さん決定(1A)。
// 10ZEN 経由の案内コードが決まったら付け足す
export const NIHONDO_CONSULT_URL = "https://www.nihondo.co.jp/kampo/consultation/";
// 英語・中国語の方の行き先: 同じビル(1・2階)の薬日本堂 青山本店のページ。薬日本堂に英語・中国語のサイトがなく、
// 青山本店のページに「対応言語: 英語・中国語」とあるため(要予約・相談員の不在あり)。2026-10-20 牧野さん決定(A)
export const NIHONDO_AOYAMA = Object.freeze({
  url: "https://www.nihondo.co.jp/shop/boutique/aoyama/",
  telHref: "tel:0357744193",
});
export function nihondoConsultUrl(lang) {
  return lang === "en" || lang === "zh" ? NIHONDO_AOYAMA.url : NIHONDO_CONSULT_URL;
}
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
