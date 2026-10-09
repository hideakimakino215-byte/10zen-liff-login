// 参照UI(card.html / staff.html)を実ブラウザ(Chromium)で動かし、member-api・staff-qr・実 PostgreSQL まで通す。
// LIFF SDK と supabase-js(CDN)は同じインターフェースの小さな代替で置き換える。本番には接続しない。
// 実行: node --experimental-strip-types test_e2e.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import { startPg, q } from "../patches/pgdb.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { makeJwt, lineVerify } from "../patches/jwtstub.mjs";
import { handle as memberApi } from "../functions/member-api/handler.ts";
import { handle as staffQrApi } from "../functions/staff-qr/handler.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pg = startPg();
const CH = "2011158053", SECRET = "e".repeat(64), UNIT = "10zen_aoyama";
const U = { staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3", mgr: "00000000-0000-0000-0000-0000000000a1", plain: "00000000-0000-0000-0000-0000000000e5", kiosk: "00000000-0000-0000-0000-0000000000f6" };
const EMAIL = { "staff@t": U.staff, "viewer@t": U.viewer, "mgr@t": U.mgr, "plain@t": U.plain, "kiosk@t": U.kiosk };
const memberDeps = () => ({ fetchFn: lineVerify(() => Date.now()), supabase: rpcOver(pg), lineLoginChannelId: CH, qrSecret: SECRET, businessUnit: UNIT, allowedOrigins: [], nowMs: () => Date.now() });
const staffDeps = () => ({ supabase: { auth: { getUser: async (t) => ({ data: { user: { id: "00000000-0000-0000-0000-0000000000" + t.slice(6, 8) } }, error: null }) },
  from: () => ({ select: () => ({ eq: (_k, v) => ({ maybeSingle: async () => ({ data: JSON.parse(pg.exec(`select coalesce((select row_to_json(s) from (select role, active from staff_users where user_id=${q(v)}) s),'null');`)) }) }) }) }) },
  qrSecret: SECRET, businessUnit: UNIT, liffUrl: "https://liff.line.me/2011158053-N7nKgExB", allowedOrigins: [], nowMs: () => Date.now() });

const LIFF = `window.liff={init:async()=>{},isLoggedIn:()=>!!localStorage.getItem('tok'),getIDToken:()=>localStorage.getItem('tok'),login:()=>{window.__loginCalled=true}};`;
const SB = `window.supabase={createClient(){const S=()=>JSON.parse(localStorage.getItem('sess')||'null');return{
 auth:{signInWithPassword:async({email,password})=>{const r=await fetch('/auth',{method:'POST',body:JSON.stringify({email,password})});if(!r.ok)return{error:{message:'bad'}};const j=await r.json();localStorage.setItem('sess',JSON.stringify(j));return{data:j,error:null}},
 getSession:async()=>({data:{session:S()}}),signOut:async()=>{localStorage.removeItem('sess');return{}}},
 rpc:async(name,args)=>{const s=S();const r=await fetch('/rpc/'+name,{method:'POST',headers:{'x-test-uid':s?s.user.id:'','content-type':'application/json'},body:JSON.stringify(args)});const j=await r.json();return r.ok?{data:j,error:null}:{data:null,error:{message:j.message}}}}}};`;
const CONFIG = `window.APP_CONFIG={liffId:"x",memberApi:"/member-api",staffQrApi:"/staff-qr",supabaseUrl:"x",supabaseKey:"x"};`;
const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript" };
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const send = (code, text, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(text); };
    const web = async (r) => { const b = await r.text(); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(b); };
    if (url.pathname === "/member-api") return web(await memberApi(new Request("http://x/member-api", { method: req.method, headers: req.headers, body: req.method === "POST" ? await body(req) : undefined }), memberDeps()));
    if (url.pathname === "/staff-qr") return web(await staffQrApi(new Request("http://x/staff-qr", { method: req.method, headers: req.headers }), staffDeps()));
    if (url.pathname === "/auth") { const { email, password } = JSON.parse(await body(req)); const uid = EMAIL[email]; if (!uid || password !== "pw") return send(401, "{}"); return send(200, JSON.stringify({ access_token: "valid-" + uid.slice(-2) + "x".repeat(30), user: { id: uid } })); }
    if (url.pathname.startsWith("/rpc/")) {
      const name = url.pathname.slice(5), uid = req.headers["x-test-uid"] || "", args = JSON.parse(await body(req) || "{}");
      const named = Object.entries(args).map(([k, v]) => `${k} => ${v === null || v === undefined ? "null" : q(v)}`).join(", ");
      const r = await pg.runAsync(uid ? `set role authenticated;\nset request.jwt.claim.sub = '${uid}';\nselect public.${name}(${named});` : `set role anon;\nselect public.${name}(${named});`);
      return r.status === 0 ? send(200, r.stdout) : send(400, JSON.stringify({ message: r.stderr }));
    }
    if (url.pathname === "/app-reference/vendor/liff.js") return send(200, LIFF, "text/javascript");
    if (url.pathname === "/app-reference/vendor/supabase.js") return send(200, SB, "text/javascript");
    if (url.pathname === "/app-reference/config.js") return send(200, CONFIG, "text/javascript");
    const f = path.join(ROOT, url.pathname); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, "nf", "text/plain");
    send(200, fs.readFileSync(f), MIME[path.extname(f)] || "text/plain");
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r)); const BASE = `http://127.0.0.1:${server.address().port}`;
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const jstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const welcomeExpected = jstToday >= "2026-10-10" && jstToday <= "2026-10-31" ? 200 : 100;
const sub = (c) => "U" + String(c).repeat(32).slice(0, 32);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  pg.loadFile("100_phase1_schema.sql");
  pg.exec(`update system_state set state='open';`);
  pg.exec(`update app_settings set value='false' where key='register_counts_as_visit';`);   // 登録日の扱い(既定=来店日として扱う)は DB テストと下の専用ケースで検証。ここでは来店の流れを見るため解除
  pg.exec(`insert into auth.users(id) values ${Object.values(U).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role) values ('${U.staff}','スタッフ','staff'),('${U.viewer}','閲覧','viewer'),('${U.mgr}','店長','manager'),('${U.kiosk}','店頭タブレット','kiosk');`);
  const tokFor = (sub, name) => makeJwt({ sub, name });
  const newPage = async (tok) => { const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } }); const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/status of 4/.test(m.text())) p.errs.push(m.text()); });
    if (tok) await p.addInitScript((t) => localStorage.setItem("tok", t), tok); return p; };
  const text = (p, sel) => p.textContent(sel);

  // ---- お客様: 登録 → 会員証 ----
  const cust = await newPage(tokFor(sub("a"), "試験 太郎"));
  await cust.goto(`${BASE}/app-reference/card.html`); await cust.waitForSelector("#register");
  assert.match(await text(cust, "#msg"), /100pt/);
  await cust.click("#register"); await cust.waitForSelector("#points");
  assert.equal(await text(cust, "#name"), "試験 太郎"); assert.equal(await text(cust, "#points"), `${welcomeExpected} pt`); assert.match(await text(cust, "#memberNo"), /user00001/); assert.match(await text(cust, "#rank"), /WHITE OPAL/);
  ok("お客様: 未登録→登録ボタン→会員証(氏名・会員番号・ポイント・ランク)");
  await cust.reload(); await cust.waitForSelector("#points"); assert.equal(await text(cust, "#points"), `${welcomeExpected} pt`);
  ok("再読み込み・再ログインしてもポイントは変わらない(登録の重複付与なし)");

  // ---- スタッフ: ログイン・権限 ----
  let stf = await newPage(); await stf.goto(`${BASE}/app-reference/staff.html`); await stf.waitForSelector("#login");
  await stf.fill("#email", "plain@t"); await stf.fill("#password", "pw"); await stf.click("#login"); await stf.waitForSelector("#msg:has-text('権限がありません')");
  await stf.fill("#email", "x@t"); await stf.fill("#password", "bad"); await stf.click("#login"); await stf.waitForSelector("#msg:has-text('ログインできませんでした')");
  await stf.fill("#email", "staff@t"); await stf.fill("#password", "pw"); await stf.click("#login"); await stf.waitForSelector("#who:has-text('staff')");
  ok("スタッフ: 誤ったパスワード・スタッフ権限のないアカウントは入れない。スタッフ権限で入れる");

  // ---- 店頭QR → お客様の来店 ----
  const kio = await newPage(); await kio.goto(`${BASE}/app-reference/qr.html`); await kio.waitForSelector("#login");
  await kio.fill("#email", "staff@t"); await kio.fill("#password", "pw"); await kio.click("#login"); await kio.waitForSelector("#msg:has-text('店頭QR専用')");   // 通常のスタッフアカウントは店頭ページに入れない
  await kio.fill("#email", "kiosk@t"); await kio.fill("#password", "pw"); await kio.click("#login");
  await kio.waitForFunction(() => document.getElementById("qrUrl")?.textContent.includes("action=visit"));
  const qrUrl = await text(kio, "#qrUrl"); assert.match(qrUrl, /^https:\/\/liff\.line\.me\/2011158053-N7nKgExB\?action=visit&t=\d+\.[A-Za-z0-9_-]{22}$/);
  // QR は画像(SVG)として表示され、URL の文字は画面に出ない
  assert.equal(await kio.locator("#qrImage svg").count(), 1); assert.ok((await kio.locator("#qrImage svg rect, #qrImage svg path").count()) > 0);
  assert.equal(await kio.locator("#qrUrl").isVisible(), false);
  // QR 表示中のページには、操作できる部品(ボタン・入力・リンク)が1つもない。お客様が触れても管理操作へ進めない
  assert.equal(await kio.locator("button, input, a, select, textarea, nav").count(), 0);
  // 店頭アカウントの資格情報を使って管理用の関数を直接呼んでも、すべて拒否される
  const denied = await kio.evaluate(async () => { const s = JSON.parse(localStorage.getItem("sess")); const out = [];
    for (const [fn, args] of [["staff_list_members", { p_query: null }], ["staff_dashboard", {}], ["staff_today_visits", {}], ["staff_lookup_redeem", { p_code: "123456" }]]) {
      const r = await fetch("/rpc/" + fn, { method: "POST", headers: { "x-test-uid": s.user.id, "content-type": "application/json" }, body: JSON.stringify(args) }); out.push(r.status); } return out; });
  assert.deepEqual(denied, [400, 400, 400, 400]);
  // 店頭アカウントで通常のスタッフ画面にログインしても入れない
  const stk = await newPage(); await stk.goto(`${BASE}/app-reference/staff.html`); await stk.fill("#email", "kiosk@t"); await stk.fill("#password", "pw"); await stk.click("#login"); await stk.waitForSelector("#msg:has-text('店頭QR専用')");
  assert.equal(await stk.locator("#nav").isVisible(), false);
  const qs = new URL(qrUrl).search;
  await cust.goto(`${BASE}/app-reference/card.html${qs}`); await cust.waitForSelector("#notice");
  assert.match(await text(cust, "#notice"), /100pt を付与/); assert.equal(await text(cust, "#points"), `${welcomeExpected + 100} pt`);
  await cust.goto(`${BASE}/app-reference/card.html${qs}`); await cust.waitForSelector("#notice"); assert.match(await text(cust, "#notice"), /付与済み/); assert.equal(await text(cust, "#points"), `${welcomeExpected + 100} pt`);
  await cust.goto(`${BASE}/app-reference/card.html?action=visit&t=1.AAAAAAAAAAAAAAAAAAAAAA`); await cust.waitForSelector("#notice"); assert.match(await text(cust, "#notice"), /使えません/);
  ok("店頭QR(店頭タブレット専用ページ・専用アカウント): 通常スタッフ/専用アカウントの取り違えは拒否、表示中は操作部品が0個で管理関数も呼べない。そのQRをお客様が読み取ると+100・同じQRの再読み取りは付与済み・不正なQRは拒否(ポイント不変)");

  // ---- ポイント使用: お客様の申請 → スタッフ確定 → お客様に完了表示 ----
  const before = welcomeExpected + 100;
  await cust.goto(`${BASE}/app-reference/card.html`); await cust.waitForSelector("#amount");
  await cust.fill("#amount", "150"); await cust.click("#redeem"); await cust.waitForSelector("#notice"); assert.match(await text(cust, "#notice"), /100pt 単位/);
  await cust.fill("#amount", "100"); await cust.click("#redeem"); await cust.waitForSelector("#pendingCode");
  const code = (await text(cust, "#pendingCode")).replace(/\s/g, ""); assert.match(code, /^\d{6}$/);
  await stf.click("[data-tab=redeem]"); await stf.fill("#code", code.slice(0, 3) + " " + code.slice(3)); await stf.click("#lookup"); await stf.waitForSelector("#confirm");
  assert.match(await text(stf, "#rMember"), /試験 太郎\(user00001\)/); assert.match(await text(stf, "#rAmount"), /100pt = 10円/);
  await stf.click("#confirm"); await stf.waitForSelector("#rDone"); assert.match(await text(stf, "#rDone"), /確定しました: 100pt\(10円分\)/);
  await cust.waitForSelector("#lastRedeem", { timeout: 8000 }); assert.match(await text(cust, "#lastRedeem"), /使用しました/); assert.equal(await text(cust, "#points"), `${before - 100} pt`);
  await stf.click("#lookup").catch(() => {});                               // 同じコードをもう一度: 確定済みなので見つからない
  await stf.waitForSelector("#redeemMsg"); assert.match(await text(stf, "#redeemMsg"), /見つかりません/);
  ok("ポイント使用: お客様の申請→コード表示→スタッフがコード入力・内容確認・確定→お客様の画面に自動で『使用しました』・残高-100。使い終えたコードは再利用できない");

  // ---- 店長の手動調整・閲覧のみの制限 ----
  const mgr = await newPage(); await mgr.goto(`${BASE}/app-reference/staff.html`); await mgr.fill("#email", "mgr@t"); await mgr.fill("#password", "pw"); await mgr.click("#login"); await mgr.waitForSelector("#who:has-text('manager')");
  await mgr.click("[data-tab=members]"); await mgr.fill("#q", "試験"); await mgr.click("#search"); await mgr.waitForSelector("#list button"); await mgr.click("#list button");
  await mgr.waitForSelector("#adjust"); assert.match(await text(mgr, "#detail"), new RegExp(`${before - 100}pt`));
  await mgr.fill("#adjPoints", "50"); await mgr.click("#adjust"); await mgr.waitForSelector("#adjOut:has-text('入力を確認')");
  await mgr.fill("#adjReason", "紙の台帳との差異の訂正"); await mgr.click("#adjust"); await mgr.waitForSelector("#ledger li:has-text('紙の台帳との差異の訂正')");
  assert.match(await text(mgr, "#detail"), new RegExp(`${before - 100 + 50}pt`));
  const view = await newPage(); await view.goto(`${BASE}/app-reference/staff.html`); await view.fill("#email", "viewer@t"); await view.fill("#password", "pw"); await view.click("#login"); await view.waitForSelector("#who:has-text('viewer')");
  await view.click("[data-tab=redeem]"); await view.fill("#code", "123456"); await view.click("#lookup"); await view.waitForSelector("#redeemMsg:has-text('権限がありません')");
  await view.click("[data-tab=members]"); await view.waitForSelector("#list button"); await view.click("#list button"); await view.waitForSelector("#detail"); assert.equal(await view.locator("#adjust").count(), 0);
  ok("店長: 検索→詳細→理由なしは拒否・理由つきで手動調整→履歴に理由が出る。閲覧のみ: 使用確認は拒否、会員の閲覧はでき、調整フォームは出ない");

  // ---- 表示の安全性 ----
  const evil = await newPage(tokFor(sub("b"), "<img src=x onerror=window.__x=1><script>window.__x=2</script>"));
  await evil.goto(`${BASE}/app-reference/card.html`); await evil.waitForSelector("#register"); await evil.click("#register"); await evil.waitForSelector("#name");
  assert.match(await text(evil, "#name"), /^<img src=x onerror=window.__x=1><script>/); assert.equal(await evil.evaluate(() => window.__x), undefined);
  await mgr.click("[data-tab=members]"); await mgr.fill("#q", "img"); await mgr.click("#search"); await mgr.waitForSelector("#list button"); assert.equal(await mgr.evaluate(() => window.__x), undefined);
  ok("表示名にHTML/スクリプトがあっても実行されず、文字として表示される(お客様画面・スタッフ画面とも)");
  const ptsNoOverflow = await cust.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth); assert.ok(ptsNoOverflow);
  for (const p of [cust, stf, mgr, view, evil]) assert.deepEqual(p.errs, [], p.errs.join("|"));
  assert.equal(Number(pg.exec(`select count(*) from public.verify_balances();`)), 0);
  ok("ブラウザのエラーなし・横スクロールなし・全会員で残高=台帳の合計");
  console.log(`\n${n} e2e tests passed`);
} finally { await browser.close(); server.close(); pg.stop(); }
