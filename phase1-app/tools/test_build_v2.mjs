// 配信物 v2 の検証: 組み立て → 参照先がすべて存在 → 秘密が混ざらない → 不正な入力を拒否。実行: node --experimental-strip-types tools/test_build_v2.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { build } from "./build_v2.mjs";
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const out = fs.mkdtempSync(path.join(os.tmpdir(), "v2-"));
const KEY = "sb_publishable_" + "A".repeat(32);
const lines = build({ liffId: "2011158053-ABCDEFGH", supabaseKey: KEY, out });
const files = lines.map((l) => l.split("  ")[1]);
for (const f of ["app-core/member-client.mjs", "app-core/screens.mjs", "app-core/staff-client.mjs", "app-reference/card.html", "app-reference/index.html", "app-reference/staff.html", "app-reference/qr.html", "app-reference/whoami.html", "app-reference/config.js", "app-reference/vendor/liff.js", "app-reference/vendor/supabase.js", "app-reference/vendor/qrcode.js", "robots.txt"]) assert.ok(files.includes(f), f);
assert.ok(!files.some((f) => /test/.test(f)));
ok("配信物の構成: 3画面・クライアント・同梱ライブラリ・LIFF 読み込み・robots.txt。テストファイルは含まない");
// すべての <script src> と import の参照先が存在する
for (const html of ["card.html", "staff.html", "qr.html", "whoami.html"]) {
  const dir = path.join(out, "app-reference"); const t = fs.readFileSync(path.join(dir, html), "utf8");
  for (const m of t.matchAll(/<script src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(dir, m[1])), `${html}: ${m[1]}`);
  for (const m of t.matchAll(/from "([^"]+\.mjs)"/g)) assert.ok(fs.existsSync(path.resolve(dir, m[1])), `${html}: ${m[1]}`);
}
for (const f of fs.readdirSync(path.join(out, "app-core"))) for (const m of fs.readFileSync(path.join(out, "app-core", f), "utf8").matchAll(/from "(\.[^"]+)"/g)) assert.ok(fs.existsSync(path.resolve(out, "app-core", m[1])), `${f}: ${m[1]}`);
ok("画面が読み込むスクリプトとモジュールの参照先がすべて存在する");
assert.equal(fs.readFileSync(path.join(out, "app-reference/index.html"), "utf8"), fs.readFileSync(path.join(out, "app-reference/card.html"), "utf8"));   // 入口は card.html と同じ内容
const cfg = fs.readFileSync(path.join(out, "app-reference/config.js"), "utf8");
assert.match(cfg, /liffId: "2011158053-ABCDEFGH"/); assert.match(cfg, /memberApi: "https:\/\/ynqnhjvrzqdrfmvmudir\.supabase\.co\/functions\/v1\/member-api"/); assert.ok(cfg.includes(KEY));
assert.ok(!/service_role|secret/i.test(cfg));
assert.match(fs.readFileSync(path.join(out, "app-reference/vendor/liff.js"), "utf8"), /static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js/);
ok("設定は公開してよい値だけ(公開キー・LIFF ID・関数のURL)。LIFF SDK は LINE の公式の配信元から読み込む");
assert.throws(() => build({ liffId: "bad", supabaseKey: KEY, out }), /LIFF ID/);
assert.throws(() => build({ liffId: "2011158053-ABCDEFGH", supabaseKey: "eyJhbGciOi" + "x".repeat(60), out }), /公開キー/);
assert.throws(() => build({ liffId: "2011158053-ABCDEFGH", supabaseKey: "sb_secret_" + "x".repeat(40), out }), /公開キー/);
ok("不正な LIFF ID・公開キー以外(JWT 形式・secret キー)は組み立てを拒否する");
const m = fs.readFileSync(path.join(out, "MANIFEST.txt"), "utf8"); assert.equal(m.trim().split("\n").length, files.length); assert.match(m, /^[0-9a-f]{64}  /m);
ok("MANIFEST.txt に全ファイルの SHA-256 を記録する");
console.log(`\n${n} build tests passed`);
