// 最終UIチェック(お客様の画面を3か国語で撮影)。本物の画面とテスト用の PostgreSQL・member-api を使い、本番には接続しない。
// 使い方: node --experimental-strip-types tools/uicheck/capture.mjs && node tools/uicheck/build.mjs .. → tools/uicheck/site/ を Artifact として同じリンクに公開し直す
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import { startPg, q } from "../../patches/pgdb.mjs";
import { rpcOver } from "../../patches/pgrpc.mjs";
import { makeJwt, lineVerify } from "../../patches/jwtstub.mjs";
import { handle as memberApi } from "../../functions/member-api/handler.ts";
import { handle as staffQrApi } from "../../functions/staff-qr/handler.ts";
import { makeToken } from "../../functions/member-api/qr.ts";
import { RECOMMENDATIONS, DISCLAIMER } from "../../app-core/constitution-content.mjs";
import { ELEMENTS, ELEMENT_COLORS, ELEMENT_TEXT_COLORS } from "../../app-core/constitution.mjs";
const rgb = (h) => `rgb(${[0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16)).join(", ")})`;   // #rrggbb → ブラウザの計算値の形

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const pg = startPg();
const CH = "2011158053", SECRET = "e".repeat(64), UNIT = "10zen_aoyama";
const U = { staff: "00000000-0000-0000-0000-0000000000b2", viewer: "00000000-0000-0000-0000-0000000000c3", mgr: "00000000-0000-0000-0000-0000000000a1", plain: "00000000-0000-0000-0000-0000000000e5", kiosk: "00000000-0000-0000-0000-0000000000f6" };
const EMAIL = { "staff@t": U.staff, "viewer@t": U.viewer, "mgr@t": U.mgr, "plain@t": U.plain, "kiosk@t": U.kiosk };
const memberDeps = () => ({ fetchFn: lineVerify(() => Date.now()), supabase: rpcOver(pg), lineLoginChannelId: CH, qrSecret: SECRET, businessUnit: UNIT, allowedOrigins: [], nowMs: () => Date.now() });
const staffDeps = () => ({ supabase: { auth: { getUser: async (t) => ({ data: { user: { id: "00000000-0000-0000-0000-0000000000" + t.slice(6, 8) } }, error: null }) },
  from: () => ({ select: () => ({ eq: (_k, v) => ({ maybeSingle: async () => ({ data: JSON.parse(pg.exec(`select coalesce((select row_to_json(s) from (select role, active from staff_users where user_id=${q(v)}) s),'null');`)) }) }) }) }) },
  qrSecret: SECRET, businessUnit: UNIT, liffUrl: "https://liff.line.me/2011158053-N7nKgExB", allowedOrigins: [], nowMs: () => Date.now() });

const LIFF = `window.liff={init:async()=>{},isLoggedIn:()=>!!localStorage.getItem('tok'),getIDToken:()=>localStorage.getItem('tok'),getProfile:async()=>({userId:'Uline0000000000000000000000000001',displayName:'x'}),login:()=>{window.__loginCalled=true}};`;
const SB = `window.supabase={createClient(){const S=()=>JSON.parse(localStorage.getItem('sess')||'null');return{
 auth:{signInWithPassword:async({email,password})=>{const r=await fetch('/auth',{method:'POST',body:JSON.stringify({email,password})});if(!r.ok)return{error:{message:'bad'}};const j=await r.json();localStorage.setItem('sess',JSON.stringify(j));return{data:j,error:null}},
 getSession:async()=>({data:{session:S()}}),signOut:async()=>{localStorage.removeItem('sess');return{}}},
 rpc:async(name,args)=>{const s=S();const r=await fetch('/rpc/'+name,{method:'POST',headers:{'x-test-uid':s?s.user.id:'','content-type':'application/json'},body:JSON.stringify(args)});const j=await r.json();return r.ok?{data:j,error:null}:{data:null,error:{message:j.message}}}}}};`;
const CONFIG = `window.APP_CONFIG={liffId:"x",memberApi:"/member-api",staffQrApi:"/staff-qr",supabaseUrl:"x",supabaseKey:"x"};`;
const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".jpg": "image/jpeg", ".webp": "image/webp", ".png": "image/png" };
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
      const named = Object.entries(args).map(([k, v]) => `${k} => ${v === null || v === undefined ? "null" : q(typeof v === "object" ? JSON.stringify(v) : v)}`).join(", ");   // 配列・オブジェクトは JSON(supabase-js と同じ)
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
  pg.loadFile("100_phase1_schema.sql"); pg.loadFile("101_search_path_fix.sql"); pg.loadFile("102_rank_perks.sql");   // 102: ランク特典(スタッフ画面のコード入力は staff_lookup_code を使う)
  pg.loadFile("103_constitution_check.sql");                                                                            // 103: 1分体質チェック
  pg.loadFile("104_member_constitution_link.sql");                                                                      // 104: 会員の詳細・一覧に体質(店長・スタッフのみ)
  pg.loadFile("105_kpi.sql");                                                                                           // 105: 目標と KPI(店長・閲覧のみ)
  pg.loadFile("106_referral.sql");                                                                                      // 106: 友だち紹介と月次レポート
  pg.loadFile("107_constitution_each_visit.sql");                                                                       // 107: 体質チェックを来店のたびに(任意・スキップ可)
  for (const f of ["108_restore_old_backup_fix.sql", "109_confirm_inactive_member.sql", "110_dinner_tea_mode_partition.sql", "111_safeupdate_where.sql", "112_ruby_seasonal_tea.sql", "113_staff_list_cc_audit.sql", "114_suspicious_slot_threshold.sql"]) pg.loadFile(f);   // 108〜110: 監査(2026-10-15)の指摘への修正
  pg.exec(`update system_state set state='open';`);
  pg.exec(`update app_settings set value='false' where key='register_counts_as_visit'; update app_settings set value='0' where key='checkin_open_hour'; update app_settings set value='24' where key='checkin_close_hour';`);   // 登録日の扱い(既定=来店日として扱う)は DB テストと下の専用ケースで検証。ここでは来店の流れを見るため解除
  pg.exec(`insert into auth.users(id) values ${Object.values(U).map((u) => `('${u}')`).join(",")};
    insert into staff_users(user_id, display_name, role) values ('${U.staff}','スタッフ','staff'),('${U.viewer}','閲覧','viewer'),('${U.mgr}','店長','manager'),('${U.kiosk}','店頭タブレット','kiosk');`);
  const tokFor = (sub, name) => makeJwt({ sub, name });
  const newPage = async (tok) => { const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } }); const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/status of 4/.test(m.text())) p.errs.push(m.text()); });
    if (tok) await p.addInitScript((t) => localStorage.setItem("tok", t), tok); return p; };
  const text = (p, sel) => p.textContent(sel);
  const OUT = fileURLToPath(new URL("./site/shots", import.meta.url)); const log = [];
  const SHOP = "3fdf5fed-fee4-47df-b541-0cb32e93d14a", DLIFF = "1653687169-wzDlrXnN";
  const withCfg = async (p, extra = "") => { await p.route("**/app-reference/config.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: CONFIG.replace('liffId:"x"', 'liffId:"2011158053-fsQb9Hvf"').replace("};", `${extra}};`) })); return p; };
  const DINII = `,diniiShopId:"${SHOP}",diniiLiffId:"${DLIFF}"`;
  const page = async (tok, { w = 390, h = 844, dinii = true, locale = "ja-JP" } = {}) => { const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, locale }); const p = await ctx.newPage(); p.errs = [];
    p.on("pageerror", (e) => p.errs.push(e.message)); if (tok) await p.addInitScript((t) => localStorage.setItem("tok", t), tok); await withCfg(p, dinii ? DINII : ""); p.taps = 0; return p; };
  const tap = async (p, sel) => { p.taps++; await p.click(sel); };
  const shot = async (p, persona, step, note) => { const f = `${persona}_${String(step).padStart(2, "0")}.png`; await p.waitForTimeout(250); await p.screenshot({ path: `${OUT}/${f}`, fullPage: true });
    const small = await p.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && e.offsetParent !== null && parseFloat(getComputedStyle(e).fontSize) < 13).map((e) => `${parseFloat(getComputedStyle(e).fontSize)}px:${e.textContent.trim().slice(0, 24)}`).slice(0, 12));
    const hgt = await p.evaluate(() => document.documentElement.scrollHeight); const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    log.push({ persona, step, file: f, note, taps: p.taps, url: p.url().replace(BASE, ""), pageHeight: hgt, overflow, small, text: (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 700) }); };
  const freshQs = async () => `?action=visit&t=${(await makeToken(SECRET, UNIT, Date.now())).token}`;
  // ---- 最終UIチェック用の撮影(本番に接続しない。テスト用の DB と本物の画面) ----
  const hx = (c) => "U" + c.charCodeAt(0).toString(16).padStart(32, "0");
  const items = [];
  const snap = async (p, id, lang, { full = true } = {}) => {
    await p.waitForTimeout(350); const file = `${id}_${lang}.jpg`;
    await p.screenshot({ path: `${OUT}/${file}`, fullPage: full, type: "jpeg", quality: 80 });
    const size = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
    items.push({ id, lang, file, errs: [...p.errs] });
  };
  const answer = async (p, pick, mood = "soup") => { for (let i = 1; i <= 15; i++) { await p.waitForSelector(`#ccStep:has-text('${i} / 16')`); await p.click(`#ccOptions button[data-value="${pick(i)}"]`); } await p.waitForSelector("#ccStep:has-text('16 / 16')"); };
  const NAMES = { ja: "佐藤 花子", en: "Emma Brown", zh: "王芳" };
  const LOC = { ja: "ja-JP", en: "en-US", zh: "zh-CN" };
  let k = 0;
  for (const lang of ["ja", "en", "zh"]) {
    const tok = tokFor(hx(String.fromCharCode(97 + k++)), NAMES[lang]);
    const p = await page(tok, { locale: LOC[lang] });
    // 会員証
    await p.goto(`${BASE}/app-reference/card.html`); await p.waitForSelector("#register"); await snap(p, "c1_register", lang);
    await p.click("#register"); await p.waitForSelector("#points");
    const no = (await p.textContent("#memberNo")).split(" ").pop();
    pg.exec(`select public._grant(m.id, 'earn', 'visit', 1000, 'uicheck-${lang}', 'test', null, now() - interval '1 day') from members m where m.member_no = '${no}';
             update members set last_activity_on = current_date - 1 where member_no = '${no}';`);
    await p.goto(`${BASE}/app-reference/card.html${await freshQs()}`); await p.waitForSelector("#points"); await p.evaluate(() => window.scrollTo(0, 0)); await snap(p, "c2_card", lang);
    await p.focus(".card"); await p.keyboard.press("Enter"); await p.waitForTimeout(900); await snap(p, "c3_back", lang, { full: false });
    await p.focus(".card"); await p.keyboard.press("Enter"); await p.waitForTimeout(700);
    await p.click('#amountQuick button[data-amount="500"]'); await p.waitForFunction(() => document.getElementById("amount")?.value === "500"); await p.click("#redeem"); await p.waitForSelector("#pendingLeft", { timeout: 5000 }).catch(async () => { console.log("REDEEM FAIL", await p.evaluate(() => [document.getElementById("notice")?.textContent, document.getElementById("amount")?.value, document.querySelectorAll("#redeem").length])); }); await snap(p, "c4_redeem", lang);
    await p.click("#cancel"); await p.waitForSelector("#amount");
    // 体質チェック(お席の QR から)
    await p.goto(`${BASE}/app-reference/check.html?table=T01`); await p.waitForSelector("#ccAgree"); await snap(p, "k1_intro", lang);
    await p.click("#ccAgree"); await p.waitForSelector("#ccStep:has-text('1 / 16')"); await snap(p, "k2_question", lang);
    await answer(p, (i) => (i >= 13 ? 2 : i % 4 === 0 ? 1 : 0)); await snap(p, "k3_mood", lang);
    await p.click('#ccOptions button[data-value="soup"]'); await p.waitForSelector("#ccTypeName"); await snap(p, "k4_result", lang);
    // 2回目(あなたの体質・これまでのチェック)
    pg.exec(`update constitution_checks set created_at = created_at - interval '7 days' where member_id = (select id from members where member_no = '${no}');`);
    await p.click("#ccRetake"); await p.waitForSelector("#ccStart, #ccAgree"); await p.click((await p.$("#ccStart")) ? "#ccStart" : "#ccAgree");
    await answer(p, (i) => (i <= 3 ? 2 : i >= 13 ? 1 : 0)); await p.click('#ccOptions button[data-value="noodle"]'); await p.waitForSelector("#ccTypeName"); await snap(p, "k5_result2", lang);
    await p.goto(`${BASE}/app-reference/card.html`); await p.waitForSelector("#ccCard"); await p.evaluate(() => document.getElementById("ccCard").scrollIntoView()); await snap(p, "c5_card_after", lang);
    // Web 版(ログインなし)
    const w = await page(null, { locale: LOC[lang] });
    await w.goto(`${BASE}/app-reference/web-check.html?lang=${lang}`); await w.waitForSelector("#wcStart"); await snap(w, "w1_intro", lang);
    await w.click("#wcStart"); for (let i = 1; i <= 15; i++) { await w.waitForSelector(`#wcStep:has-text('${i} / 15')`); if (i === 1) await snap(w, "w2_question", lang); await w.click(`#wcOptions button[data-value="${i >= 7 && i <= 9 ? 2 : 0}"]`); }
    await w.waitForSelector("#wcTypeName"); await snap(w, "w3_result", lang);
    console.log(lang, "errors:", p.errs.length + w.errs.length);
  }
  // 店頭の QR 画面(タブレット横)
  const kq = await page(null, { w: 1180, h: 820 }); await kq.goto(`${BASE}/app-reference/qr.html`); await kq.waitForSelector("#login");
  await kq.fill("#email", "kiosk@t"); await kq.fill("#password", "pw"); await kq.click("#login");
  await kq.waitForSelector('#kiosk[data-lang="ja"]'); await snap(kq, "q1_kiosk", "ja", { full: false });
  await kq.waitForSelector('#kiosk[data-lang="en"]', { timeout: 15000 }); await snap(kq, "q1_kiosk", "en", { full: false });
  await kq.waitForSelector('#kiosk[data-lang="zh"]', { timeout: 8000 }); await snap(kq, "q1_kiosk", "zh", { full: false });
  // お席の QR(印刷用・日本語のみ)
  const tq = await page(null, { w: 900, h: 900 }); await tq.goto(`${BASE}/app-reference/table-qr.html`); await tq.waitForSelector("#list");
  await tq.fill("#list", "A1,T01\nA2,T02"); await tq.click("#make"); await tq.waitForSelector(".pop"); await snap(tq, "t1_tablecard", "ja");
  fs.writeFileSync(`${OUT}/../items.json`, JSON.stringify(items, null, 1));
  console.log("done", items.length, "errors", items.reduce((a, i) => a + i.errs.length, 0));
} finally { await browser.close(); server.close(); pg.stop(); }
