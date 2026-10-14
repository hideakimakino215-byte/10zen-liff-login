// 本番につながる画面(HTML)を、擬似データで動く1枚の HTML にする。本番には接続しない。
// 使い方:
//   node make_preview.mjs --page <画面.html> --mock <擬似データ.js> --out <出力.html>
//        [--module <importしているmjs>]... [--logo <画像>] [--banner "<上部の帯の文言>"] [--title "<タイトル>"] [--logo-target <置き換える画像のパス。既定 assets/logo.png>] [--replace <擬似データにする vendor の名前。既定 supabase>]
// 出力:
//   <出力.html>      … ブラウザで直接開ける版(画面写真・動作確認用)
//   <出力>-pub.html  … claude.ai のアーティファクトとして公開する版(文書の骨組みを外し、
//                      ファイル保存と confirm() の代わりに、CSV の中身を画面に表示する)
// 前提: 画面は <script src="config.js"> と <script src="vendor/...js"> で設定とライブラリを読み、
//       <script type="module"> の中で import { ... } from "....mjs" している形(10ZEN の staff.html と同じ)。
import fs from "node:fs";

const args = process.argv.slice(2), opt = { module: [] };
for (let i = 0; i < args.length; i += 2) { const k = args[i].replace(/^--/, ""); if (k === "module") opt.module.push(args[i + 1]); else opt[k] = args[i + 1]; }
for (const k of ["page", "mock", "out"]) if (!opt[k]) { console.error(`--${k} が必要です`); process.exit(2); }

let html = fs.readFileSync(opt.page, "utf8");
const mock = fs.readFileSync(opt.mock, "utf8");

// 1) 設定とライブラリの読み込みを置き換える。config.js は消す。--replace(既定 supabase)を名前に含む vendor/*.js は擬似データに、
//    それ以外の vendor/*.js(QR コードのライブラリなど)は、画面と同じフォルダから読んで中に埋め込む
const pageDir = opt.page.replace(/[^/]*$/, "") || "./", replaceKey = opt.replace || "supabase";
html = html.replace(/<script src="config\.js"><\/script>\s*/g, "");
let replaced = false;
html = html.replace(/<script src="(vendor\/[^"]+\.js)"><\/script>/g, (_m, src) => {
  if (!replaced && src.includes(replaceKey)) { replaced = true; return `<script>${mock}</script>`; }
  return `<script>${fs.readFileSync(pageDir + src, "utf8").replace(/<\/script/gi, "<\\/script")}</script>`;
});
if (!replaced) html = html.replace(/<script type="module">/, `<script>${mock}</script>\n<script type="module">`);

// 2) import しているモジュールを中に埋め込む(export を外す)
for (const m of opt.module) {
  const code = fs.readFileSync(m, "utf8").replace(/^export /gm, "");
  const base = m.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`import \\{[^}]*\\} from "[^"]*${base}";`);
  if (!re.test(html)) { console.error(`import が見つかりません: ${base}`); process.exit(1); }
  html = html.replace(re, code);
}
if (/^\s*import .* from "/m.test(html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] || "")) console.warn("注意: 埋め込んでいない import が残っています(--module で渡す)");

// 3) ロゴの画像を埋め込む(--logo を渡したときだけ)。HTML の属性にも、JS の文字列(src: "assets/logo.png")にも効くように、
//    "<--logo-target。既定 assets/logo.png>" という文字列をすべて data URI に置き換える
if (opt.logo) {
  const ext = opt.logo.split(".").pop().toLowerCase(), type = ext === "jpg" ? "jpeg" : ext, target = opt["logo-target"] || "assets/logo.png";
  const data = `data:image/${type};base64,${fs.readFileSync(opt.logo).toString("base64")}`;
  const before = html.split(`"${target}"`).length - 1;
  html = html.split(`"${target}"`).join(`"${data}"`);
  if (!before) console.warn(`注意: "${target}" が見つかりません(--logo-target で指定する)`);
}

// 4) プレビューであることを示す帯
const banner = opt.banner || "プレビュー(擬似データ・本番に接続しません)";
html = html.replace("<body>", `<body><div style="background:#1c2430;color:#fff;font-size:13px;padding:8px 16px;line-height:1.5">${banner.replace(/</g, "&lt;")}</div>`);
if (opt.title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${opt.title}</title>`);
fs.writeFileSync(opt.out, html);

// 5) 公開版: 骨組み(doctype/html/head/body)を外し、ダウンロードと confirm を置き換える
const style = (html.match(/<style>[\s\S]*?<\/style>/g) || []).join("\n");
const title = html.match(/<title>[^<]*<\/title>/)?.[0] || "<title>Preview</title>";
let body = html.match(/<body>([\s\S]*)<\/body>/)[1];
body = body.replace(/window\.confirm\(/g, "(() => true)(");   // 公開版のビューアーでは confirm() が常に false を返すため
const shim = `<script>
// 公開版のビューアーではファイル保存が働かないため、ダウンロードの代わりに中身を画面の下に表示する
(function(){const o=URL.createObjectURL;URL.createObjectURL=function(b){if(b&&b.type&&/csv|text/.test(b.type)){b.text().then(function(t){var p=document.getElementById("__preview_out")||document.body.appendChild(Object.assign(document.createElement("pre"),{id:"__preview_out"}));p.style.cssText="white-space:pre;overflow-x:auto;font-size:11px;background:#f5f7fa;padding:12px;margin:16px;border-radius:10px";p.textContent="プレビューではファイル保存の代わりに内容を表示します\\n\\n"+t.replace(/^\\uFEFF/,"");});}return o.call(URL,b);};})();
</script>`;
fs.writeFileSync(opt.out.replace(/\.html$/, "-pub.html"), `${title}\n${style}\n${shim}\n${body}`);
console.log(`書き出しました: ${opt.out} と ${opt.out.replace(/\.html$/, "-pub.html")}`);
