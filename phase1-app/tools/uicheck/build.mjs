// 最終UIチェックのページ(site/index.html)を作る。撮影(capture.mjs)のあとに実行する。
// 使い方: node tools/uicheck/build.mjs <リポジトリ>(capture.mjs のあと)。site/index.html と site/shots/*.jpg を Artifact として同じリンクに公開し直す
import fs from "node:fs"; import { execSync } from "node:child_process";
const DIR = new URL(".", import.meta.url).pathname, repo = process.argv[2];
const items = JSON.parse(fs.readFileSync(DIR + "site/items.json", "utf8"));
const commit = execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim();
const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

const GROUPS = [
  { id: "card", name: "会員証", screens: [
    ["c1_register", "会員登録の前", "「登録すると100ptプレゼント」の案内と登録ボタン"],
    ["c2_card", "来店した直後の会員証", "来店のお知らせ・ランクアップのお知らせ・ポイント・特典チケット・友だち招待・ランク特典"],
    ["c3_back", "会員証の裏", "営業時間・電話・住所・Web予約・1分体質チェックへのボタン"],
    ["c4_redeem", "ポイントを使うとき", "スタッフに見せる6桁のコードと残り時間・取り消し"],
    ["c5_card_after", "体質チェックをしたあとの会員証", "今日の傾向・あなたの体質・今日のおすすめ・今日の五巡茶(画面は体質チェックの欄から)"] ] },
  { id: "check", name: "体質チェック", screens: [
    ["k1_intro", "はじめに(記録への同意)", "説明文・同意の文・診断ではない旨・はじめるボタン"],
    ["k2_question", "質問(1問1画面)", "質問文・3つの答え・進み具合・戻る"],
    ["k3_mood", "今日の食事の気分", "最後の質問(5つの気分)"],
    ["k4_result", "結果(1回目・お席のQRから)", "タイプ名・五角形・おすすめの一品・「このまま注文する」・あなたにおすすめの五巡茶・季節・薬日本堂"],
    ["k5_result2", "結果(2回目から)", "あなたの体質(平均)・これまでのチェックが加わる"] ] },
  { id: "web", name: "Web版", screens: [
    ["w1_intro", "はじめに", "ログインなし・回答は送らない旨"],
    ["w2_question", "質問", "15問(気分の質問はなし)"],
    ["w3_result", "結果", "LINE の会員証への登録の案内"] ] },
  { id: "kiosk", name: "店頭QR", wide: true, screens: [
    ["q1_kiosk", "店頭タブレットの QR 画面", "日本語10秒 → 英語5秒 → 中国語5秒で自動で切り替わる(下の3枚はそれぞれの言語のとき)"] ] },
  { id: "table", name: "お席のQR", wide: true, jaOnly: true, screens: [
    ["t1_tablecard", "お席のQRカード(印刷用)", "体質チェックの QR と、すぐに注文する方向けの小さな QR(日本語のみ)"] ] },
];
const have = new Set(items.map((i) => `${i.id}_${i.lang}`));
for (const g of GROUPS) for (const [id] of g.screens) for (const l of g.jaOnly ? ["ja"] : ["ja", "en", "zh"]) if (!have.has(`${id}_${l}`)) throw new Error(`missing ${id}_${l}`);
const data = { commit, stamp, groups: GROUPS };

const html = `<title>10ZEN 最終UIチェック</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* お客様の画面(会員証・体質チェック・Web版・店頭QR)を3か国語で見比べる。会員証と同じ墨・金茶・和紙の色。1列(スマホ)〜広い画面は2列 */
:root {
  --paper:#f7f4ee; --card:#fffefb; --ink:#2b2926; --sub:#6f685e; --line:#e3dccf; --accent:#8a6a3b; --accent-soft:#f1e8d8; --ok:#2f6b4f; --ok-soft:#e3efe7;
  --serif:"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif; --sans:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Noto Sans JP",system-ui,sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --paper:#1d1b18; --card:#262320; --ink:#efe9df; --sub:#b3aa9c; --line:#3a352e; --accent:#d2ac72; --accent-soft:#3a3024; --ok:#7cc29d; --ok-soft:#203229; color-scheme:dark; } }
:root[data-theme="dark"] { --paper:#1d1b18; --card:#262320; --ink:#efe9df; --sub:#b3aa9c; --line:#3a352e; --accent:#d2ac72; --accent-soft:#3a3024; --ok:#7cc29d; --ok-soft:#203229; color-scheme:dark; }
* { box-sizing:border-box; }
body { background:var(--paper); color:var(--ink); font-family:var(--sans); -webkit-text-size-adjust:100%; }
body::before { content:""; position:fixed; inset:0 0 auto; height:env(safe-area-inset-top, 0px); z-index:10; background:var(--paper); }
.wrap { max-width:1080px; margin:0 auto; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); padding-block:20px 48px; }
header h1 { font-family:var(--serif); font-size:24px; letter-spacing:.06em; margin:0; text-wrap:balance; }
.meta { color:var(--sub); font-size:13px; line-height:1.7; margin:6px 0 0; }
.meta b { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
.bar { position:sticky; top:env(safe-area-inset-top, 0px); z-index:5; background:var(--paper); padding-block:12px; margin-top:12px; border-bottom:1px solid var(--line); display:flex; flex-direction:column; gap:10px; }
.seg { display:flex; gap:6px; flex-wrap:wrap; }
.seg button { min-height:38px; padding:0 14px; border-radius:19px; border:1px solid var(--line); background:var(--card); color:var(--sub); font:inherit; font-size:14px; cursor:pointer; }
.seg button[aria-pressed="true"] { border-color:var(--ink); color:var(--ink); font-weight:600; }
.jump { display:flex; gap:14px; flex-wrap:wrap; font-size:13px; }
.jump a { color:var(--accent); text-decoration:none; } .jump a:focus-visible, button:focus-visible, label:focus-within { outline:2px solid var(--accent); outline-offset:2px; }
.progress { font-size:13px; color:var(--sub); font-variant-numeric:tabular-nums; }
section.group { margin-top:28px; }
section.group > h2 { font-family:var(--serif); font-size:19px; letter-spacing:.08em; margin:0 0 12px; display:flex; align-items:baseline; gap:10px; }
section.group > h2 small { font-family:var(--sans); font-size:12px; color:var(--sub); letter-spacing:0; font-weight:400; }
.screens { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap:16px; align-items:start; }
.group.wide .screens, .all .screens { grid-template-columns:1fr; }
.screen { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; display:flex; flex-direction:column; gap:10px; min-width:0; }
.screen.done { border-color:var(--ok); }
.head { display:flex; gap:10px; align-items:flex-start; }
.no { font-variant-numeric:tabular-nums; font-size:12px; font-weight:600; color:var(--accent); background:var(--accent-soft); border-radius:6px; padding:2px 7px; flex:none; margin-top:2px; }
.head h3 { font-size:15px; margin:0; line-height:1.5; }
.head p { font-size:12.5px; color:var(--sub); margin:2px 0 0; line-height:1.6; }
.shots { display:flex; gap:12px; overflow-x:auto; padding-bottom:4px; }
.shot { margin:0; flex:1 1 0; min-width:0; display:flex; flex-direction:column; gap:6px; }
.all .shot { flex:0 0 min(260px, 78%); }
.wide .shot, .all .wide .shot { flex:1 1 0; min-width:min(100%, 300px); }
.shot figcaption { font-size:12px; color:var(--sub); }
.shot button { padding:0; border:1px solid var(--line); border-radius:10px; background:var(--paper); cursor:zoom-in; overflow:hidden; display:block; width:100%; }
.shot img { display:block; width:100%; height:auto; max-height:560px; object-fit:cover; object-position:top; }
.wide .shot img { max-height:none; }
.tick { display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer; align-self:flex-start; padding:6px 10px; border-radius:8px; border:1px solid var(--line); }
.tick input { width:18px; height:18px; accent-color:var(--ok); margin:0; }
.screen.done .tick { background:var(--ok-soft); border-color:var(--ok); color:var(--ok); font-weight:600; }
.note { margin-top:28px; font-size:13px; color:var(--sub); line-height:1.8; border-top:1px solid var(--line); padding-top:14px; }
dialog { border:0; padding:0; max-width:none; max-height:none; width:100%; height:100%; background:rgba(20,18,15,.92); }
dialog::backdrop { background:rgba(20,18,15,.92); }
.lb { height:100%; overflow:auto; display:flex; flex-direction:column; align-items:center; padding:max(12px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) 24px max(12px, env(safe-area-inset-left, 0px)); gap:10px; }
.lb .top { position:sticky; top:0; display:flex; justify-content:space-between; align-items:center; width:100%; max-width:820px; color:#f3ede3; font-size:14px; gap:10px; }
.lb .top button { min-height:40px; padding:0 16px; border-radius:20px; border:1px solid #6d655a; background:#2b2722; color:#f3ede3; font:inherit; cursor:pointer; }
.lb img { width:100%; max-width:820px; height:auto; border-radius:8px; }
@media (prefers-reduced-motion: no-preference) { .screen { transition:border-color .2s; } }
</style>
<div class="wrap">
  <header>
    <h1>10ZEN 最終UIチェック</h1>
    <p class="meta">お客様の画面を、実際のプログラムとテスト用の擬似データで撮影したものです(本番には接続していません)。<br>撮影 <b id="stamp"></b> ・ 版 <b id="commit"></b>。内容を直したら、このページを同じリンクのまま更新します。</p>
  </header>
  <div class="bar">
    <div class="seg" role="group" aria-label="表示する言語" id="langs"></div>
    <div class="jump" id="jump"></div>
    <div class="progress" id="progress" role="status"></div>
  </div>
  <main id="groups"></main>
  <p class="note">画像をタップすると大きく表示します。見終わった画面は「確認した」にチェック(この端末だけに残ります。版が変わると外れます)。気になる点は、チャットで番号(例: 2-4 英語)と内容を送ってください。スタッフ画面は別のプレビューで確認済みのため、ここには入れていません。</p>
</div>
<dialog id="lb" aria-label="拡大表示"><div class="lb"><div class="top"><span id="lbCap"></span><button type="button" id="lbClose">閉じる</button></div><img id="lbImg" alt=""></div></dialog>
<script>
const DATA = ${JSON.stringify(data)};
const LANGS = [["ja", "日本語"], ["en", "English"], ["zh", "中文"], ["all", "3言語を並べる"]];
const store = (() => { try { return window.localStorage; } catch (e) { return null; } })();
const get = (k) => { try { return store ? store.getItem(k) : null; } catch (e) { return null; } };
const set = (k, v) => { try { if (store) store.setItem(k, v); } catch (e) {} };
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === "text") e.textContent = v; else e.setAttribute(k, v); } for (const c of kids) if (c) e.append(c); return e; };
document.getElementById("stamp").textContent = DATA.stamp; document.getElementById("commit").textContent = DATA.commit;
let lang = get("uic_lang") || "ja"; if (!LANGS.some(([l]) => l === lang)) lang = "ja";
const doneKey = (id) => "uic_done:" + DATA.commit + ":" + id;
const lb = document.getElementById("lb");
document.getElementById("lbClose").onclick = () => lb.close();
lb.addEventListener("click", (e) => { if (e.target === lb) lb.close(); });
function openShot(src, cap) { document.getElementById("lbImg").src = src; document.getElementById("lbImg").alt = cap; document.getElementById("lbCap").textContent = cap; if (lb.showModal) lb.showModal(); else lb.setAttribute("open", ""); }
const LABEL = { ja: "日本語", en: "English", zh: "中文" };
function render() {
  const langs = document.getElementById("langs"); langs.replaceChildren();
  for (const [l, name] of LANGS) { const b = el("button", { type: "button", "aria-pressed": String(l === lang), text: name }); b.onclick = () => { lang = l; set("uic_lang", l); render(); }; langs.append(b); }
  const jump = document.getElementById("jump"); jump.replaceChildren(...DATA.groups.map((g) => el("a", { href: "#" + g.id, text: g.name })));
  const root = document.getElementById("groups"); root.className = lang === "all" ? "all" : ""; root.replaceChildren();
  let total = 0, done = 0;
  DATA.groups.forEach((g, gi) => {
    const sec = el("section", { class: "group" + (g.wide ? " wide" : ""), id: g.id });
    sec.append(el("h2", {}, document.createTextNode(g.name), g.jaOnly ? el("small", { text: "日本語のみ" }) : null));
    const grid = el("div", { class: "screens" });
    g.screens.forEach(([id, title, check], si) => {
      const no = (gi + 1) + "-" + (si + 1); total++;
      const shown = g.jaOnly ? ["ja"] : g.id === "kiosk" || lang === "all" ? ["ja", "en", "zh"] : [lang];
      const isDone = get(doneKey(id)) === "1"; if (isDone) done++;
      const box = el("article", { class: "screen" + (isDone ? " done" : "") });
      box.append(el("div", { class: "head" }, el("span", { class: "no", text: no }), el("div", {}, el("h3", { text: title }), el("p", { text: check }))));
      const row = el("div", { class: "shots" });
      for (const l of shown) {
        const src = "shots/" + id + "_" + l + ".jpg", cap = no + " " + title + "(" + LABEL[l] + ")";
        const btn = el("button", { type: "button", "aria-label": cap + "を拡大" }, el("img", { src, alt: cap, loading: "lazy", decoding: "async" }));
        btn.onclick = () => openShot(src, cap);
        row.append(el("figure", { class: "shot" }, btn, shown.length > 1 ? el("figcaption", { text: LABEL[l] }) : null));
      }
      const cb = el("input", { type: "checkbox", id: "done-" + id }); cb.checked = isDone;
      cb.onchange = () => { set(doneKey(id), cb.checked ? "1" : "0"); box.classList.toggle("done", cb.checked); progress(); };
      box.append(row, el("label", { class: "tick", for: "done-" + id }, cb, document.createTextNode("確認した")));
      grid.append(box);
    });
    sec.append(grid); root.append(sec);
  });
  progress();
}
function progress() { const all = document.querySelectorAll(".screen").length, done = document.querySelectorAll(".screen.done").length; document.getElementById("progress").textContent = "確認済み " + done + " / " + all + " 画面"; }
render();
</script>
`;
fs.writeFileSync(DIR + "site/index.html", html);
console.log("ok", commit, stamp, items.length);
