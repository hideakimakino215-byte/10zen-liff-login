// 外部レビュー(UI・実装の最終チェック)に渡す資料一式を作る。capture.mjs のあとに実行する。
// 使い方: node tools/uicheck/review_pack.mjs <出力ディレクトリ>
//  → 02_画面集.pdf(全画面。お客様の画面は日本語・英語・中国語を横に並べる)・shots/(1枚ずつ。番号つき)・src/(画面とその部品。テスト・設定・画像は含めない)
//  資料に入るのはテスト用の擬似データだけ(本番に接続していない)。秘密(鍵・パスワード)は含まない。
import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
const HERE = path.dirname(new URL(import.meta.url).pathname), ROOT = path.resolve(HERE, "../.."), OUT = path.resolve(process.argv[2] || "review_pack");
const SHOTS = path.join(HERE, "site/shots");
fs.mkdirSync(OUT, { recursive: true });
const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();

export const SCREENS = [
  ["A", "お客様: 会員証(LINE の中で開く)", true, [
    ["c1_register", "会員登録の前", "登録ボタンと「登録で100pt」の案内"],
    ["c2_card", "来店した直後の会員証", "来店とランクアップのお知らせ・カード(タップで裏返る)・ポイント・体質チェックの入口・ポイントを使う・特典チケット・友だち招待・ランク特典"],
    ["c3_back", "会員証の裏", "店の情報・Web予約・1分体質チェック"],
    ["c4_redeem", "ポイントを使うとき", "スタッフに見せる6桁のコードと残り時間(3分)"],
    ["c5_card_after", "体質チェックのあとの会員証", "体質チェックの欄: 今日の傾向・あなたの体質・今日のおすすめ・今日の五巡茶"]]],
  ["B", "お客様: 1分体質チェック(LINE の中)", true, [
    ["k1_intro", "はじめに(記録への同意)", "初回は同意を兼ねる"],
    ["k2_question", "質問(1問1画面)", "15問。タップで次へ"],
    ["k3_mood", "今日の食事の気分", "16問目"],
    ["k4_result", "結果(1回目・お席の QR から来た人)", "タイプ・五角形・おすすめの一品・注文ボタン・五巡茶・季節・薬日本堂・診断ではない旨"],
    ["k5_result2", "結果(2回目以降)", "あなたの体質(最新3回の平均)・これまでのチェックが加わる"]]],
  ["C", "お客様: Web 版の体質チェック(ログインなし・LINE の外)", true, [
    ["w1_intro", "はじめに", "回答は送らない旨"],
    ["w2_question", "質問", "15問(気分の質問なし)"],
    ["w3_result", "結果", "LINE 会員証への登録の案内"]]],
  ["D", "店頭タブレット: 来店用の QR(お客様が見る)", true, [
    ["q1_kiosk", "QR の画面", "日本語10秒 → 英語5秒 → 中国語5秒で自動で切り替わる。操作できる部品は置かない。QR は30秒ごとに変わる"]]],
  ["E", "印刷物: お席に置く QR カード(日本語のみ)", false, [
    ["t1_tablecard", "お席の QR カード", "体質チェックへ誘う QR。ダイニー(注文)の設定後は、すぐ注文する人向けの小さな QR が並ぶ"]]],
  ["F", "スタッフ画面(日本語のみ。スタッフのスマホ・レジ横の端末)", false, [
    ["s1_login", "ログイン", "店長・スタッフ・閲覧(本部)共通"],
    ["s2_home", "ログイン直後(ポイント使用 + 各機能の入口)", "最もよく使う画面"],
    ["s3_redeem_confirm", "コードを入れて内容を確認", "確定の前"],
    ["s4_redeem_done", "確定したあと", ""],
    ["s5_members", "会員の一覧・検索", "体質のタイプの印(色)"],
    ["s6_member_detail", "会員の詳細", "店長だけ手動の調整がある"],
    ["s7_dash", "集計", "来店・付与・使用など"],
    ["s8_constitution", "体質チェックの集計", ""],
    ["s9_kpi", "目標と KPI(店長・閲覧のみ)", "擬似データのため空欄が多い"],
    ["s10_reset", "パスワードの再設定", "スタッフ・店頭タブレット共通"],
    ["s11_kiosk_login", "店頭タブレットのログイン", "最初に1回だけ"]]],
];
const LANG = { ja: "日本語", en: "English", zh: "中文" };
const img = (id, l) => { const f = path.join(SHOTS, `${id}_${l}.jpg`); if (!fs.existsSync(f)) throw new Error("missing " + f); return "data:image/jpeg;base64," + fs.readFileSync(f).toString("base64"); };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
let pages = "", index = "";
for (const [g, title, tri, list] of SCREENS) {
  index += `<h3>${g}. ${esc(title)}</h3><ol>` + list.map(([id, t, d], i) => `<li><b>${g}-${i + 1}</b> ${esc(t)}${d ? `<span> … ${esc(d)}</span>` : ""}</li>`).join("") + "</ol>";
  list.forEach(([id, t, d], i) => {
    const langs = tri ? ["ja", "en", "zh"] : ["ja"], wide = id.startsWith("q1") || id.startsWith("t1") || id.startsWith("s11");
    const figs = langs.map((l) => `<figure><img src="${img(id, l)}">${tri ? `<figcaption>${LANG[l]}</figcaption>` : ""}</figure>`).join("");
    pages += `<section class="pg"><header><span class="no">${g}-${i + 1}</span><h2>${esc(t)}</h2><p>${esc(title)}${d ? " ・ " + esc(d) : ""}</p></header><div class="row ${wide ? "wide" : ""} n${langs.length}">${figs}</div></section>`;
  });
}
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
@page { size: 1400px 2400px; margin: 0; }
* { box-sizing: border-box; } body { margin: 0; font-family: "Noto Sans CJK JP","Noto Sans JP",sans-serif; color: #2b2926; }
.pg { width: 1400px; height: 2400px; padding: 48px 56px; page-break-after: always; overflow: hidden; display: flex; flex-direction: column; gap: 20px; }
header h2 { margin: 6px 0 0; font-size: 34px; } header p { margin: 6px 0 0; font-size: 22px; color: #6f685e; }
.no { font-size: 22px; font-weight: 700; color: #8a6a3b; background: #f1e8d8; border-radius: 8px; padding: 4px 12px; }
.row { flex: 1; display: flex; gap: 24px; justify-content: center; align-items: flex-start; min-height: 0; }
.row figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; }
.row img { max-height: 2140px; max-width: 420px; border: 1px solid #e3dccf; border-radius: 10px; }
.row.n1 img { max-width: 900px; } .row.wide { flex-direction: column; align-items: center; } .row.wide img { max-width: 1280px; max-height: 680px; }
figcaption { font-size: 22px; font-weight: 600; }
.cover { width: 1400px; height: 2400px; padding: 80px 72px; page-break-after: always; }
.cover h1 { font-size: 48px; margin: 0 0 12px; } .cover .meta { font-size: 22px; color: #6f685e; line-height: 1.7; }
.cover h3 { font-size: 26px; margin: 28px 0 6px; } .cover ol { margin: 0; padding-left: 0; list-style: none; font-size: 21px; line-height: 1.75; } .cover li span { color: #6f685e; }
</style></head><body>
<section class="cover"><h1>10ZEN 会員証・体質チェック 画面集</h1>
<p class="meta">外部レビュー用(UI と実装の最終チェック)。版 ${commit}。テスト用の擬似データで本物のプログラムを動かして撮影(本番には接続していない)。<br>お客様の画面(A〜D)は 日本語・English・中文 を横に並べています。画面は iPhone 相当(幅390px)の縦長の全体。店頭の QR とお席のカードは横長。<br>番号(例: A-2)で指摘してください。</p>
${index}</section>${pages}</body></html>`;
const tmp = path.join(OUT, "_book.html"); fs.writeFileSync(tmp, html);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
try { const p = await browser.newPage(); await p.goto("file://" + tmp); await p.waitForTimeout(500); await p.pdf({ path: path.join(OUT, "02_画面集.pdf"), preferCSSPageSize: true, printBackground: true }); }
finally { await browser.close(); fs.rmSync(tmp); }

// ソースコード(画面と部品)。テスト・生成物・画像・外部ライブラリは含めない
const SRC = path.join(OUT, "src"); fs.rmSync(SRC, { recursive: true, force: true });
const pagesList = ["card.html", "check.html", "web-check.html", "qr.html", "staff.html", "table-qr.html", "reset.html"];
fs.mkdirSync(path.join(SRC, "app-reference"), { recursive: true }); fs.mkdirSync(path.join(SRC, "app-core"), { recursive: true });
for (const f of pagesList) fs.copyFileSync(path.join(ROOT, "app-reference", f), path.join(SRC, "app-reference", f));
for (const f of fs.readdirSync(path.join(ROOT, "app-core"))) if (f.endsWith(".mjs") && !/^test/.test(f)) fs.copyFileSync(path.join(ROOT, "app-core", f), path.join(SRC, "app-core", f));
for (const f of fs.readdirSync(SRC, { recursive: true })) { const p = path.join(SRC, f); if (fs.statSync(p).isFile() && /(service_role|sb_secret|-----BEGIN|password\s*[:=]\s*["'][^"']+["'])/i.test(fs.readFileSync(p, "utf8"))) throw new Error("秘密らしき文字列: " + f); }
// 画面の画像も1枚ずつ置く(Codex などが画像として開けるように)
const SH = path.join(OUT, "shots"); fs.rmSync(SH, { recursive: true, force: true }); fs.mkdirSync(SH);
for (const [g, , tri, list] of SCREENS) list.forEach(([id], i) => { for (const l of tri ? ["ja", "en", "zh"] : ["ja"]) fs.copyFileSync(path.join(SHOTS, `${id}_${l}.jpg`), path.join(SH, `${g}-${i + 1}_${id}_${l}.jpg`)); });
// 依頼文・決定事項・AGENTS.md(Codex などが最初に読む指示)
for (const f of fs.readdirSync(path.join(HERE, "review_docs"))) fs.copyFileSync(path.join(HERE, "review_docs", f), path.join(OUT, f));
console.log("ok", commit, fs.readdirSync(OUT));
