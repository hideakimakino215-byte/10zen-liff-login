// 配信物(v2/)を、実物の supabase-js・qrcode(同梱ライブラリ)のまま実ブラウザで動かす。Supabase の HTTP(auth / rest / functions)だけをローカルの代替で受け、
// 後ろは実 PostgreSQL 16・実の Edge Function の処理(handler.ts)。LIFF SDK だけ代替(LINE の配信元に依存するため)。本番には接続しない。
// 実行: node --experimental-strip-types tools/test_built_e2e.mjs
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import { startPg, q } from "../patches/pgdb.mjs";
import { makeJwt, lineVerify } from "../patches/jwtstub.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { handle as memberApi } from "../functions/member-api/handler.ts";
import { handle as staffQrApi } from "../functions/staff-qr/handler.ts";
import { build } from "./build_v2.mjs";

const pg = startPg(); const CH = "2011158053", SECRET = "b".repeat(64), UNIT = "10zen_aoyama";
const U = { staff: "00000000-0000-0000-0000-0000000000b2", kiosk: "00000000-0000-0000-0000-0000000000f6" };
const EMAIL = { "staff@t": U.staff, "kiosk@t": U.kiosk };
const out = fs.mkdtempSync(path.join(os.tmpdir(), "v2b-"));
const val = (sql) => pg.exec(sql);
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const userJwt = (uid) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: uid, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2lnbmF0dXJl`;
const subOf = (auth) => { try { return JSON.parse(Buffer.from(String(auth).replace(/^Bearer /, "").split(".")[1], "base64url").toString()).sub; } catch { return ""; } };
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const LIFF = `window.liff={init:async()=>{},isLoggedIn:()=>!!localStorage.getItem('tok'),getIDToken:()=>localStorage.getItem('tok'),login:()=>{},getProfile:async()=>({displayName:'試験 花子',userId:'U'+'7'.repeat(32)})};`;
const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript" };
const staffDeps = () => ({ supabase: { auth: { getUser: async (t) => ({ data: { user: { id: subOf(t) } }, error: null }) },
  from: () => ({ select: () => ({ eq: (_k, v) => ({ maybeSingle: async () => ({ data: JSON.parse(pg.exec(`select coalesce((select row_to_json(s) from (select role, active from staff_users where user_id=${q(v)}) s),'null');`)) }) }) }) }) },
  qrSecret: SECRET, businessUnit: UNIT, liffUrl: "https://liff.line.me/2011158053-N7nKgExB", allowedOrigins: [], nowMs: () => Date.now() });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"); const send = (c, t, type = "application/json") => { res.writeHead(c, { "content-type": type }); res.end(t); };
    const web = async (r) => { const b = await r.text(); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(b); };
    if (url.pathname === "/auth/v1/token") { const { email, password } = JSON.parse(await body(req)); const uid = EMAIL[email]; if (!uid || password !== "pw") return send(400, JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }));
      const exp = Math.floor(Date.now() / 1000) + 3600; return send(200, JSON.stringify({ access_token: userJwt(uid), token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r" + uid.slice(-4), user: { id: uid, aud: "authenticated", role: "authenticated", email } })); }
    if (url.pathname === "/auth/v1/logout") return send(204, "");
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.slice("/rest/v1/rpc/".length), uid = subOf(req.headers.authorization), args = JSON.parse((await body(req)) || "{}");
      const named = Object.entries(args).map(([k, v]) => `${k} => ${v === null || v === undefined ? "null" : q(typeof v === "object" ? JSON.stringify(v) : v)}`).join(", ");
      const r = await pg.runAsync(`set role authenticated;\nset request.jwt.claim.sub = '${uid}';\nselect public.${name}(${named});`);
      return r.status === 0 ? send(200, r.stdout) : send(400, JSON.stringify({ code: "P0001", message: (/ERROR:\s+([^\n]+)/.exec(r.stderr) || [])[1] || "error" }));
    }
    if (url.pathname === "/functions/v1/staff-qr") return web(await staffQrApi(new Request("http://x/staff-qr", { method: req.method, headers: req.headers }), staffDeps()));
    if (url.pathname === "/functions/v1/member-api") return web(await memberApi(new Request("http://x/member-api", { method: req.method, headers: req.headers, body: req.method === "POST" ? await body(req) : undefined }),
      { fetchFn: lineVerify(() => Date.now()), supabase: rpcOver(pg), lineLoginChannelId: CH, qrSecret: SECRET, businessUnit: UNIT, allowedOrigins: [], nowMs: () => Date.now() }));
    if (url.pathname === "/app-reference/vendor/liff.js") return send(200, LIFF, "text/javascript");
    const f = path.join(out, url.pathname); if (!f.startsWith(out) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, "nf", "text/plain");
    send(200, fs.readFileSync(f), MIME[path.extname(f)] || "text/plain");
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r)); const BASE = `http://127.0.0.1:${server.address().port}`;
build({ liffId: "2011158053-ABCDEFGH", supabaseKey: "sb_publishable_" + "T".repeat(32), out, supabaseUrl: BASE });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role; grant select on auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.loadFile("100_phase1_schema.sql"); pg.loadFile("101_search_path_fix.sql");
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit';
    insert into auth.users(id) values ('${U.staff}'), ('${U.kiosk}');
    insert into staff_users(user_id, display_name, role) values ('${U.staff}','スタッフ','staff'),('${U.kiosk}','店頭タブレット','kiosk');`);
  const newPage = async (tok) => { const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } }); const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/status of 4/.test(m.text())) p.errs.push(m.text()); }); if (tok) await p.addInitScript((t) => localStorage.setItem("tok", t), tok); return p; };
  const text = (p, sel) => p.textContent(sel);

  // 1) 店頭タブレット: 実物の supabase-js でログイン → staff-qr → QR 画像(SVG)
  const kio = await newPage(); await kio.goto(`${BASE}/app-reference/qr.html`); await kio.waitForSelector("#login");
  await kio.fill("#email", "kiosk@t"); await kio.fill("#password", "bad"); await kio.click("#login"); await kio.waitForSelector("#msg:has-text('ログインできませんでした')");
  await kio.fill("#password", "pw"); await kio.click("#login");
  await kio.waitForFunction(() => document.getElementById("qrUrl")?.textContent.includes("action=visit"));
  const qrUrl = await text(kio, "#qrUrl"); assert.match(qrUrl, /^https:\/\/liff\.line\.me\/2011158053-N7nKgExB\?action=visit&t=\d+\.[A-Za-z0-9_-]{22}$/);
  assert.equal(await kio.locator("#qrImage svg").count(), 1); assert.ok((await kio.locator("#qrImage svg").innerHTML()).length > 800);   // 実際の模様が描かれている
  assert.equal(await kio.locator("button, input, a, select, textarea, nav").count(), 0); assert.deepEqual(kio.errs, []);
  ok("配信物(実物の supabase-js・qrcode)の店頭ページ: 誤ったパスワードは拒否、ログイン後に staff-qr からQRを取得して画像で表示。操作部品は0個・ブラウザのエラーなし");

  // 2) お客様: LIFF が渡す ?liff.state= の形のQRで開く → 未登録なので登録して来店(登録日は来店扱いにしない設定のため来店ポイントも付く)
  const cust = await newPage(makeJwt({ sub: "U" + "7".repeat(32), name: "試験 花子" }));
  const via = qrUrl.replace("https://liff.line.me/2011158053-N7nKgExB", `${BASE}/app-reference/card.html`).replace(/\?(.*)$/, (_m, qs) => "?liff.state=" + encodeURIComponent("?" + qs));
  await cust.goto(via); await cust.waitForSelector("#notice"); await cust.waitForSelector("#points");
  assert.match(await text(cust, "#notice"), /100pt を付与/); assert.equal(await text(cust, "#points"), "200 pt"); assert.equal(await text(cust, "#name"), "試験 花子");
  assert.equal(val("select count(*) from visits where source='store_qr'"), "1"); assert.deepEqual(cust.errs, []);
  ok("お客様: LIFF の ?liff.state= の形の店頭QRで開くと、登録 → 来店の記録(登録100pt+来店100pt)。ブラウザのエラーなし");

  // 2b) 試験者ID表示ページ: 本人の LINE ユーザーIDだけを表示する(許可リストの登録用)
  { const w = await newPage(makeJwt({ sub: "U" + "7".repeat(32), name: "試験 花子" })); await w.goto(`${BASE}/app-reference/whoami.html`); await w.waitForSelector("#uid");
    assert.equal(await text(w, "#uid"), "U" + "7".repeat(32)); assert.deepEqual(w.errs, []); }
  ok("試験者ID表示ページ: 本人の LINE ユーザーID(U+32桁)が表示される");

  // 3) スタッフ: 実物の supabase-js でログイン → 使用の確認まで
  await cust.fill("#amount", "100"); await cust.click("#redeem"); await cust.waitForSelector("#pendingCode");
  const code = (await text(cust, "#pendingCode")).replace(/\s/g, "");
  const stf = await newPage(); await stf.goto(`${BASE}/app-reference/staff.html`); await stf.waitForSelector("#login");
  await stf.fill("#email", "kiosk@t"); await stf.fill("#password", "pw"); await stf.click("#login"); await stf.waitForSelector("#msg:has-text('店頭QR専用')");
  await stf.fill("#email", "staff@t"); await stf.fill("#password", "pw"); await stf.click("#login"); await stf.waitForSelector("#who:has-text('staff')");
  await stf.fill("#code", code); await stf.click("#lookup"); await stf.waitForSelector("#confirm"); assert.match(await text(stf, "#rAmount"), /100pt = 10円/);
  await stf.click("#confirm"); await stf.waitForSelector("#rDone"); assert.match(await text(stf, "#rDone"), /確定しました: 100pt/);
  await cust.waitForSelector("#lastRedeem", { timeout: 8000 }); assert.equal(await text(cust, "#points"), "100 pt");
  assert.equal(val("select count(*) from public.verify_balances()"), "0"); assert.deepEqual(stf.errs, []);
  ok("スタッフ(実物の supabase-js): 店頭専用アカウントは拒否・スタッフでログイン → コード入力 → 確定 → お客様の画面が自動で『使用しました』・残高100。残高=台帳");
  console.log(`\n${n} built e2e tests passed`);
} finally { await browser.close(); server.close(); pg.stop(); }
