// 配信用の v2/ を組み立てる(リポジトリの公開サイトの /v2/ に置く)。実行: node tools/build_v2.mjs --liff-id <LIFF ID> --supabase-key <公開キー> [--out <出力先>]
//  * app-core と app-reference(card.html / staff.html / qr.html)をそのままコピーし、config.js と vendor/liff.js を生成する。
//  * 秘密は入れない(公開キー sb_publishable_… と、秘密ではない値だけ)。service_role や秘密鍵らしい文字列があれば中止する。
//  * 出力先に MANIFEST.txt(ファイル一覧と SHA-256)を書く。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
export function build({ liffId, supabaseKey, out, supabaseUrl = "https://ynqnhjvrzqdrfmvmudir.supabase.co" }) {
  if (!/^[0-9]{10}-[A-Za-z0-9]{8}$/.test(liffId || "")) throw new Error("LIFF ID の形式が不正です(例 2011158053-N7nKgExB)");
  if (!/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(supabaseKey || "")) throw new Error("公開キー(sb_publishable_…)を指定してください。service_role / secret キーは使わない");
  fs.rmSync(out, { recursive: true, force: true });
  const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
  for (const f of fs.readdirSync(path.join(ROOT, "app-core"))) if (/\.mjs$/.test(f) && !/^test/.test(f)) copy(path.join(ROOT, "app-core", f), path.join(out, "app-core", f));
  for (const f of ["card.html", "staff.html", "qr.html", "whoami.html"]) copy(path.join(ROOT, "app-reference", f), path.join(out, "app-reference", f));
  for (const f of ["supabase.js", "qrcode.js", "README.md"]) copy(path.join(ROOT, "app-reference", "vendor", f), path.join(out, "app-reference", "vendor", f));
  const v = path.join(out, "app-reference");
  fs.copyFileSync(path.join(v, "card.html"), path.join(v, "index.html"));   // LIFF の入口 URL(…/app-reference/)用。/{LIFF ID}/whoami.html のように、入口の後ろにファイル名を付けて開けるようにする
  fs.writeFileSync(path.join(v, "config.js"), `// 配信時の設定(公開してよい値のみ)\nwindow.APP_CONFIG = {\n  liffId: ${JSON.stringify(liffId)},\n  memberApi: ${JSON.stringify(supabaseUrl + "/functions/v1/member-api")},\n  staffQrApi: ${JSON.stringify(supabaseUrl + "/functions/v1/staff-qr")},\n  supabaseUrl: ${JSON.stringify(supabaseUrl)},\n  supabaseKey: ${JSON.stringify(supabaseKey)},\n};\n`);
  // LIFF SDK は LINE の配信元から読み込む(同梱不可)。card.html の <script src="vendor/liff.js"> がこのファイルを読む
  fs.writeFileSync(path.join(v, "vendor", "liff.js"), `// LINE 公式の LIFF SDK を読み込む(配信元は LINE が指定)\ndocument.write('<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"><\\/script>');\n`);
  fs.writeFileSync(path.join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
  // 秘密らしい文字列が混ざっていないこと
  const all = walk(out);
  for (const f of all) { const t = fs.readFileSync(f, "utf8"); if (/service_role|sb_secret_|BEGIN (RSA |EC )?PRIVATE KEY|MEMBERSHIP_CHECKIN_SECRET\s*=|CHANNEL_SECRET\s*=/.test(t) && !/vendor\/(supabase|qrcode)\.js$/.test(f.replaceAll("\\", "/")) && !/README\.md$/.test(f)) throw new Error("秘密らしい文字列: " + f); }
  const lines = walk(out).sort().map((f) => `${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}  ${path.relative(out, f).replaceAll("\\", "/")}`);
  fs.writeFileSync(path.join(out, "MANIFEST.txt"), lines.join("\n") + "\n");
  return lines;
}
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])).filter((f) => !f.endsWith("MANIFEST.txt")); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lines = build({ liffId: arg("liff-id"), supabaseKey: arg("supabase-key"), out: path.resolve(arg("out", path.join(ROOT, "..", "v2"))) });
  console.log(lines.join("\n"));
}
