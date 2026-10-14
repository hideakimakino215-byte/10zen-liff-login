// 画面をスマホ幅(375px)とタブレット幅(1024px)で開き、横スクロール・ブラウザのエラーを調べ、画面写真を撮る。
// 使い方:
//   node check_layout.mjs <開くHTML> <写真の出力先フォルダ> [--login メール パスワード] [--tabs "redeem,members,dash"]
//   ・--login: #email・#password・#login がある画面で、ログインしてから調べる
//   ・--tabs:  [data-tab=...] のボタンを順に押して、それぞれの画面を調べる
// はみ出しがあれば、はみ出している要素の上位8件を出す(原因探し用)。
// 依存: Playwright と Chromium(Claude のクラウド環境では /opt/node-tools と /opt/pw-browsers にある)。
import fs from "node:fs";
const PW = process.env.PW_MODULE || "/opt/node-tools/node_modules/playwright/index.mjs";
const CHROME = process.env.CHROME_PATH || (fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((d) => /^chromium-\d+$/.test(d)).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`)[0] : undefined);
const { chromium } = await import(PW);

const [file, outDir, ...rest] = process.argv.slice(2);
if (!file || !outDir) { console.error("使い方: node check_layout.mjs <HTML> <出力先> [--login メール パスワード] [--tabs a,b,c]"); process.exit(2); }
let login = null, tabs = [];
for (let i = 0; i < rest.length; i++) { if (rest[i] === "--login") { login = [rest[i + 1], rest[i + 2]]; i += 2; } else if (rest[i] === "--tabs") { tabs = rest[++i].split(","); } }
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
let problems = 0;
for (const [label, vp] of [["phone", { width: 375, height: 812 }], ["tablet", { width: 1024, height: 768 }]]) {
  const page = await (await browser.newContext({ viewport: vp, deviceScaleFactor: 2 })).newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message)); page.on("console", (m) => m.type() === "error" && errs.push(m.text())); page.on("dialog", (d) => d.accept());
  await page.goto(file.startsWith("http") ? file : "file://" + fs.realpathSync(file));
  const check = async (name) => {
    await page.waitForTimeout(400);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.screenshot({ path: `${outDir}/${label}-${name}.png`, fullPage: true });
    if (over > 0) {
      problems++;
      const culprits = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).slice(0, 8).map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className && typeof e.className === "string" ? "." + e.className.trim().replace(/\s+/g, ".") : ""} (右端 ${Math.round(e.getBoundingClientRect().right)}px)`));
      console.log(`!! ${label}/${name}: 横に ${over}px はみ出し → ${culprits.join(" / ")}`);
    } else console.log(`ok ${label}/${name}: はみ出しなし`);
  };
  await check("0-start");
  if (login && (await page.$("#email"))) { await page.fill("#email", login[0]); await page.fill("#password", login[1]); await page.click("#login"); await page.waitForTimeout(800); await check("1-after-login"); }
  for (const t of tabs) { const b = await page.$(`[data-tab=${t}]`); if (!b) { console.log(`-- ${label}: [data-tab=${t}] がありません`); continue; } await b.click(); await check(`tab-${t}`); }
  if (errs.length) { problems++; console.log(`!! ${label}: ブラウザのエラー ${JSON.stringify(errs)}`); } else console.log(`ok ${label}: ブラウザのエラーなし`);
}
await browser.close();
console.log(problems ? `問題 ${problems} 件` : "問題なし");
process.exit(problems ? 1 : 0);
