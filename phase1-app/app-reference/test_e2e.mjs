// 参照UI(card.html / staff.html)を実ブラウザ(Chromium)で動かし、member-api・staff-qr・実 PostgreSQL まで通す。
// LIFF SDK と supabase-js(CDN)は同じインターフェースの小さな代替で置き換える。本番には接続しない。
// 実行: node --experimental-strip-types test_e2e.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import { startPg, q } from "../patches/pgdb.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { makeJwt, lineVerify } from "../patches/jwtstub.mjs";
import { handle as memberApi } from "../functions/member-api/handler.ts";
import { handle as staffQrApi } from "../functions/staff-qr/handler.ts";
import { makeToken } from "../functions/member-api/qr.ts";
import { RECOMMENDATIONS, DISCLAIMER } from "../app-core/constitution-content.mjs";
import { ELEMENTS, ELEMENT_COLORS, ELEMENT_TEXT_COLORS } from "../app-core/constitution.mjs";
const rgb = (h) => `rgb(${[0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16)).join(", ")})`;   // #rrggbb → ブラウザの計算値の形

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  for (const f of ["108_restore_old_backup_fix.sql", "109_confirm_inactive_member.sql", "110_dinner_tea_mode_partition.sql"]) pg.loadFile(f);   // 108〜110: 監査(2026-10-15)の指摘への修正
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
  // 店舗情報(旧 会員証の裏面から引き継ぎ): 営業時間・電話(発信)・住所(地図)・予約・30秒体質チェック(LINE IDつき)
  assert.match(await text(cust, "#storeHours"), /11:00〜21:00/);
  assert.equal(await cust.getAttribute("#storeTel", "href"), "tel:0364505834");
  assert.match(await cust.getAttribute("#storeMap", "href"), /^https:\/\/maps\.google\.com\/\?q=/);
  assert.equal(await cust.getAttribute("#storeBooking", "href"), "https://booking.ebica.jp/webrsv/search/e014032801/23809");
  assert.equal(await cust.getAttribute("#storeQuiz", "href"), "https://tally.so/r/440keB?line_user_id=Uline0000000000000000000000000001");
  for (const id of ["#storeMap", "#storeBooking", "#storeQuiz"]) assert.equal(await cust.getAttribute(id, "rel"), "noopener noreferrer");
  ok("店舗情報(裏面の引き継ぎ): 営業時間・電話(tel:)・地図・WEB予約・30秒体質チェック(line_user_id つき)が会員証に出る");

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
    for (const [fn, args] of [["staff_list_members", { p_query: null }], ["staff_dashboard", {}], ["staff_today_visits", {}], ["staff_lookup_redeem", { p_code: "123456" }],
                              ["staff_lookup_code", { p_code: "123456" }], ["staff_ticket_stats", {}], ["staff_constitution_stats", {}]]) {
      const r = await fetch("/rpc/" + fn, { method: "POST", headers: { "x-test-uid": s.user.id, "content-type": "application/json" }, body: JSON.stringify(args) }); out.push(r.status); } return out; });
  assert.deepEqual(denied, [400, 400, 400, 400, 400, 400, 400]);
  // 店頭アカウントで通常のスタッフ画面にログインしても入れない
  const stk = await newPage(); await stk.goto(`${BASE}/app-reference/staff.html`); await stk.fill("#email", "kiosk@t"); await stk.fill("#password", "pw"); await stk.click("#login"); await stk.waitForSelector("#msg:has-text('店頭QR専用')");
  assert.equal(await stk.locator("#nav").isVisible(), false);
  const qs = new URL(qrUrl).search;
  await cust.goto(`${BASE}/app-reference/card.html${qs}`); await cust.waitForSelector("#notice");
  assert.match(await text(cust, "#notice"), /100pt を付与/); assert.equal(await text(cust, "#points"), `${welcomeExpected + 100} pt`);
  await cust.goto(`${BASE}/app-reference/card.html${qs}`); await cust.waitForSelector("#notice"); assert.match(await text(cust, "#notice"), /付与済み/); assert.equal(await text(cust, "#points"), `${welcomeExpected + 100} pt`);
  await cust.goto(`${BASE}/app-reference/card.html?action=visit&t=1.AAAAAAAAAAAAAAAAAAAAAA`); await cust.waitForSelector("#notice"); assert.match(await text(cust, "#notice"), /使えません/);
  assert.equal(await text(cust, "#ccEntry"), "1分体質チェック"); assert.equal(await cust.locator("#ccTodayPrompt").count(), 0);   // 初めての方は来店した日も入口だけ
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

  // ---- 特典チケット: 会員証の「使う」→ コード → スタッフ画面の同じ入力欄で確定 → お客様に完了表示 ----
  const tk = await newPage(tokFor(sub("c"), "試験 花子"));
  await tk.goto(`${BASE}/app-reference/card.html`); await tk.waitForSelector("#register"); await tk.click("#register"); await tk.waitForSelector("#points");
  assert.equal(await tk.locator("#tickets").count(), 0); assert.equal(await tk.locator("#rankPerks").count(), 0);       // WHITE OPAL: チケットも来るたびの特典もまだない
  const clock1 = await text(tk, "#liveClock"); assert.match(clock1, /^\d{2}:\d{2}:\d{2}$/);
  await tk.waitForFunction((c) => document.getElementById("liveClock")?.textContent !== c, clock1, { timeout: 3000 });  // 毎秒更新される
  assert.notEqual(await tk.evaluate(() => getComputedStyle(document.querySelector(".front .in"), "::after").animationName), "none");   // 表面の模様がゆっくり動く
  pg.exec(`select public._grant(m.id, 'earn', 'visit', 1000 - public._effective_lifetime(m), 'e2e:amber', 'test', null, now()) from members m where display_name = '試験 花子';`);
  await tk.reload(); await tk.waitForSelector("#tickets button[data-ticket-id]");
  assert.match(await text(tk, "#rank"), /AMBER/); assert.match(await text(tk, "#tickets"), /AMBER 到達のお祝い・豆花 1つ/); assert.match(await text(tk, "#tickets"), /まで/);
  assert.match(await text(tk, "#rankPerks"), /ディナーの五巡茶 無料/); assert.doesNotMatch(await text(tk, "#rankPerks"), /薬日本堂/);   // 薬日本堂のご優待は EMERALD から
  assert.match(await text(tk, "#benefits"), /1,000pt達成/); assert.doesNotMatch(await tk.textContent("body"), /5%OFF/);
  assert.match(await text(tk, "#next"), /EMERALDまで あと 2,000 pt/); assert.match(await text(tk, "#lifetime"), /1,000 \/ 3,000 pt/);
  await tk.click("#tickets button[data-ticket-id]"); await tk.waitForSelector("#ticketCode");
  const tcode = (await text(tk, "#ticketCode")).replace(/\s/g, ""); assert.match(tcode, /^\d{6}$/); assert.match(await text(tk, "#ticketPendingInfo"), /豆花 1つ/);
  assert.equal(await tk.locator("#tickets button[data-ticket-id]").isDisabled(), true);
  await stf.click("[data-tab=redeem]"); await stf.fill("#code", tcode); await stf.click("#lookup"); await stf.waitForSelector("#confirm");
  assert.match(await text(stf, "#rMember"), /試験 花子\(user\d{5}\)/); assert.match(await text(stf, "#rTicket"), /特典チケット: AMBER 到達のお祝い・豆花 1つ/); assert.equal(await stf.locator("#rAmount").count(), 0);
  await stf.click("#confirm"); await stf.waitForSelector("#rDone"); assert.match(await text(stf, "#rDone"), /確定しました: AMBER 到達のお祝い・豆花 1つ/);
  await tk.waitForSelector("#lastTicket", { timeout: 8000 }); assert.match(await text(tk, "#lastTicket"), /ご利用いただきました/); assert.match(await text(tk, "#notice"), /ご利用いただきました/);
  assert.equal(await tk.locator("#tickets button[data-ticket-id]").count(), 0); assert.equal(await tk.locator("#ticketCode").count(), 0);
  await stf.click("#lookup").catch(() => {}); await stf.waitForSelector("#redeemMsg"); assert.match(await text(stf, "#redeemMsg"), /見つかりません/);   // 使い終えたコードは再利用できない
  await stf.click("[data-tab=dash]"); await stf.waitForSelector("#ticketStats"); assert.match(await text(stf, "#ticketStats"), /発行1枚.*使用1枚.*使用率100%/);
  await tk.emulateMedia({ reducedMotion: "reduce" });                                                                // 動きを減らす設定: 模様は止まり、時刻は更新し続ける
  assert.equal(await tk.evaluate(() => getComputedStyle(document.querySelector(".front .in"), "::after").animationName), "none");
  const clock2 = await text(tk, "#liveClock"); await tk.waitForFunction((c) => document.getElementById("liveClock")?.textContent !== c, clock2, { timeout: 3000 });
  ok("特典チケット: AMBER に上がると会員証にお祝いのチケットと『ディナーの五巡茶 無料』が出る→『使う』で6桁コード→スタッフ画面の同じ入力欄でチケットと判定・確定→お客様の画面に自動で『ご利用いただきました』。使い終えたコードは再利用できず、集計に発行・使用・使用率。表面に毎秒の時刻と動く模様(動きを減らす設定では模様だけ止まる)");

  // ---- 店長の手動調整・閲覧のみの制限 ----
  const mgr = await newPage(); await mgr.goto(`${BASE}/app-reference/staff.html`); await mgr.fill("#email", "mgr@t"); await mgr.fill("#password", "pw"); await mgr.click("#login"); await mgr.waitForSelector("#who:has-text('manager')");
  await mgr.click("[data-tab=members]"); await mgr.fill("#q", "試験"); await mgr.click("#search"); await mgr.waitForSelector("#list button"); await mgr.click("#list button");
  await mgr.waitForSelector("#adjust"); assert.match(await text(mgr, "#detail"), new RegExp(`${before - 100}pt`));
  assert.equal(await text(mgr, "#ccMemberDate"), "体質チェック: 未実施"); assert.equal(await mgr.locator("#ccMemberRadar").count(), 0);   // 体質チェックをまだしていない会員
  await mgr.fill("#adjPoints", "50"); await mgr.click("#adjust"); await mgr.waitForSelector("#adjOut:has-text('入力を確認')");
  await mgr.fill("#adjReason", "紙の台帳との差異の訂正"); await mgr.click("#adjust"); await mgr.waitForSelector("#ledger li:has-text('紙の台帳との差異の訂正')");
  assert.match(await text(mgr, "#detail"), new RegExp(`${before - 100 + 50}pt`));
  const view = await newPage(); await view.goto(`${BASE}/app-reference/staff.html`); await view.fill("#email", "viewer@t"); await view.fill("#password", "pw"); await view.click("#login"); await view.waitForSelector("#who:has-text('viewer')");
  await view.click("[data-tab=redeem]"); await view.fill("#code", "123456"); await view.click("#lookup"); await view.waitForSelector("#redeemMsg:has-text('権限がありません')");
  await view.click("[data-tab=members]"); await view.waitForSelector("#list button"); await view.click("#list button"); await view.waitForSelector("#detail"); assert.equal(await view.locator("#adjust").count(), 0);
  assert.equal(await view.locator("#ccMember").count(), 0);                                                        // 閲覧(本部)には体質の欄を出さない
  ok("店長: 検索→詳細→理由なしは拒否・理由つきで手動調整→履歴に理由が出る。閲覧のみ: 使用確認は拒否、会員の閲覧はでき、調整フォームは出ない");

  // ---- 1分体質チェック: 会員証の入口 → 同意 → 15問+気分(1問1画面・戻る)→ 結果(今日の傾向・あなたの体質・履歴)→ 薬日本堂 → 会員証 ----
  const cc = await newPage(tokFor(sub("d"), "試験 体質"));
  await cc.context().route("https://www.nihondo.co.jp/**", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<p>ok</p>" }));   // 外部には出ない
  await cc.goto(`${BASE}/app-reference/card.html`); await cc.waitForSelector("#register"); await cc.click("#register"); await cc.waitForSelector("#ccEntry");
  assert.equal(await text(cc, "#ccEntry"), "1分体質チェック"); assert.equal(await cc.locator("#ccTodayPrompt").count(), 0); assert.equal(await cc.locator("#ccTodayTea").count(), 0);
  await cc.click("#ccEntry"); await cc.waitForSelector("#ccAgree");
  assert.match(await text(cc, "#ccConsentText"), /会員証に記録/);
  await cc.click("#ccAgree"); await cc.waitForSelector("#ccStep:has-text('1 / 16')");
  assert.equal(await text(cc, "#ccQuestion"), "イライラしたり、気分の浮き沈みが大きい"); assert.deepEqual(await cc.locator("#ccOptions button").allTextContents(), ["よくある", "ときどき", "あまりない"]);
  const answer = async (step, value) => { await cc.waitForSelector(`#ccStep:has-text('${step} / 16')`); await cc.click(`#ccOptions button[data-value="${value}"]`); };
  await answer(1, 2); await answer(2, 1);
  await cc.waitForSelector("#ccStep:has-text('3 / 16')"); await cc.click("#ccBack"); await cc.waitForSelector("#ccStep:has-text('2 / 16')");   // 戻ると前の答えが選ばれている
  assert.equal(await cc.getAttribute('#ccOptions button[data-value="1"]', "aria-pressed"), "true");
  await answer(2, 2); await answer(3, 2);
  for (let i = 4; i <= 15; i++) await answer(i, i === 13 ? 1 : 0);                                             // 木6・水1
  await cc.waitForSelector("#ccStep:has-text('16 / 16')"); assert.equal(await text(cc, "#ccQuestion"), "今日の食事の気分は?");
  assert.deepEqual(await cc.locator("#ccOptions button").allTextContents(), ["お粥", "スープ", "一人鍋", "麺", "みんなで鍋"]);
  await cc.click('#ccOptions button[data-value="noodle"]'); await cc.waitForSelector("#ccTypeName");
  assert.equal(await text(cc, "#ccTodayLabel"), "今日の傾向"); assert.equal(await text(cc, "#ccTypeName"), "モヤモヤ渋滞タイプ"); assert.match(await text(cc, "#ccTypeLine"), /張りつめがち/);
  assert.equal(await cc.locator("#ccRadar polygon.radar-area").count(), 1); assert.equal(await cc.locator("#ccRadar text.radar-label").count(), 5);
  // 五角形の点と軸の名前は五行の色(面は無彩色)
  const fillOf = (p, sel) => p.evaluate((s) => getComputedStyle(document.querySelector(s)).fill, sel);
  for (const e of ELEMENTS) { assert.equal(await fillOf(cc, `#ccRadar circle.radar-dot[data-element=${e}]`), rgb(ELEMENT_COLORS[e]), e); assert.equal(await fillOf(cc, `#ccRadar text.radar-label[data-element=${e}]`), rgb(ELEMENT_TEXT_COLORS[e]), e); }
  assert.ok(!Object.values(ELEMENT_COLORS).map(rgb).includes(await fillOf(cc, "#ccRadar polygon.radar-area")));
  assert.equal(await cc.locator("#ccDetail").isVisible(), false); await cc.click("#ccDetailToggle"); assert.equal(await cc.locator("#ccDetail").isVisible(), true);
  assert.match(await text(cc, "#ccDetail"), /五行: 木 \/ 五臓: 肝 \/ 状態: 気滞/);
  // あなたの体質(1回目は今日の傾向と同じ)・これまでのチェック(1回)
  assert.equal(await text(cc, "#ccProfileName"), "モヤモヤ渋滞タイプ"); assert.match(await text(cc, "#ccProfileBasis"), /1回分のチェックの結果/);
  assert.equal(await cc.locator("#ccProfileRadar circle.radar-dot").count(), 5); assert.equal(await cc.locator("#ccHistory li").count(), 1);
  assert.equal(await cc.getAttribute("#ccHistory li", "data-element"), "wood");
  assert.match(await text(cc, "#ccDish"), new RegExp(RECOMMENDATIONS.wood.noodle.replace(/[()]/g, "\\$&"))); assert.match(await text(cc, "#ccDish"), /今日のおすすめの一品\(今日の傾向から\)/);
  // タイプ名・五巡茶の名前は五行の文字色(会員証と同じ)
  const colorOf = (p, sel) => p.evaluate((s) => getComputedStyle(document.querySelector(s)).color, sel);
  for (const s of ["#ccTypeName", "#ccProfileName", "#ccYourTea h3"]) assert.equal(await colorOf(cc, s), rgb(ELEMENT_TEXT_COLORS.wood), s);
  assert.equal(await text(cc, "#ccYourTeaDay"), "木曜日はあなたのお茶の日"); assert.match(await text(cc, "#ccYourTea"), /あなたの体質から.*五巡茶\(木\)/);
  assert.match(await text(cc, "#ccTodayTea"), /今日の五巡茶\(.曜日\)五巡茶\(.\)/); assert.match(await text(cc, "#ccSeason"), /季節のひとこと/);
  assert.equal(await text(cc, "#ccDisclaimer"), DISCLAIMER); assert.match(await cc.textContent("body"), /もっと詳しく知りたい方は、薬日本堂の漢方相談へ/);
  assert.doesNotMatch(await cc.textContent("body"), /治る|効く|改善/);
  assert.equal(await cc.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  const ccMember = `(select member_id from member_identities where subject=${q(sub("d"))})`;
  assert.equal(pg.exec(`select score_wood || ',' || score_water || ',' || primary_element || ',' || mood from constitution_checks where member_id=${ccMember};`), "6,1,wood,noodle");
  assert.equal(pg.exec(`select version from constitution_consents where member_id=${ccMember};`), "constitution_v1");
  const [popup] = await Promise.all([cc.waitForEvent("popup"), cc.click("#ccNihondo")]); await popup.close();
  for (let i = 0; i < 50 && pg.exec(`select count(*) from constitution_referral_clicks where member_id=${ccMember};`) !== "1"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(pg.exec(`select count(*) from constitution_referral_clicks where member_id=${ccMember};`), "1");
  await cc.click("#ccToCard"); await cc.waitForSelector("#ccEntry"); assert.equal(await text(cc, "#ccEntry"), "体質の結果と推移を見る");
  assert.match(await text(cc, "#ccTodayTea"), /今日の五巡茶: 五巡茶/); assert.equal(await cc.locator("#ccTodayPrompt").count(), 0);
  assert.equal(await text(cc, "#ccToday"), "今日の傾向: モヤモヤ渋滞タイプ"); assert.match(await text(cc, "#ccProfile"), /^あなたの体質: モヤモヤ渋滞タイプ/);
  assert.match(await text(cc, "#ccTodayDish"), /^今日のおすすめ: \(仮\)/);
  // タイプ名・今日の五巡茶の名前は五行の文字色(木=#42744c)。バランス良好でなければ data-element が付く
  assert.equal(await cc.locator("#ccToday b").getAttribute("data-element"), "wood");
  assert.equal(await cc.locator("#ccToday b").evaluate((n) => getComputedStyle(n).color), "rgb(66, 116, 76)");
  assert.equal(await cc.locator("#ccProfile b").getAttribute("data-element"), "wood");
  assert.ok(["wood", "fire", "earth", "metal", "water"].includes(await cc.locator("#ccTodayTea .cc-tea-name").getAttribute("data-element")));
  assert.doesNotMatch(await cc.textContent("#ccCard"), /今日の体調|季節が変わりました/); assert.equal(await cc.locator("#ccCondition, #ccSeasonPrompt").count(), 0);
  pg.exec(`insert into visits(member_id, visit_on) select ${ccMember}, public._jst_date(now());`);
  await cc.reload(); await cc.waitForSelector("#ccToday"); assert.equal(await cc.locator("#ccTodayPrompt").count(), 0);                    // 今日はもうチェック済み
  ok("1分体質チェック: 会員証の入口→同意→15問(1問1画面・タップで次へ・戻ると前の答えが残る)→食事の気分→結果(今日の傾向・五角形・タップで正式名称・あなたの体質・これまでのチェック・おすすめ・あなたの五巡茶とお茶の日・今日の五巡茶・季節・薬日本堂・診断ではない旨)。点数は DB が計算・相談ボタンのクリックを記録。会員証は『結果を見る』と今日の傾向・あなたの体質・今日のおすすめ。今日の体調・季節の案内は出ない");

  // ---- 来店のたびの任意のチェック: 来店した日に「今日の1分体質チェック」→ 今日はスキップ(その日は出ない)→ 別の日 → はじめる → 2回目の結果(今日の傾向とあなたの体質が違う)----
  pg.exec(`update constitution_checks set created_at = created_at - interval '2 days' where member_id=${ccMember};`);                  // 1回目は2日前のチェックにする
  await cc.reload(); await cc.waitForSelector("#ccTodayPrompt");
  assert.match(await text(cc, "#ccTodayPrompt"), /今日の1分体質チェック/); assert.equal(await text(cc, "#ccSkip"), "今日はスキップ"); assert.equal(await cc.getAttribute("#ccTodayStart", "href"), "check.html?start=1");
  assert.equal(await cc.locator("#ccToday").count(), 0); assert.match(await text(cc, "#ccProfile"), /あなたの体質: モヤモヤ渋滞タイプ/);
  await cc.click("#ccSkip"); await cc.waitForSelector("#ccTodayPrompt", { state: "detached" }); assert.equal(await cc.locator("#ccEntry").count(), 1);
  assert.equal(await cc.evaluate(() => localStorage.getItem("10zen_cc_skip")), jstToday);
  await cc.reload(); await cc.waitForSelector("#ccEntry"); assert.equal(await cc.locator("#ccTodayPrompt").count(), 0);                 // その日のあいだは出ない
  await cc.evaluate(() => localStorage.setItem("10zen_cc_skip", "2000-01-01"));                                                     // 別の日にスキップした記録 → 今日は出る
  await cc.reload(); await cc.waitForSelector("#ccTodayPrompt");
  // 端末に記録できないときは、この画面の間だけ隠す
  const nost = await newPage(tokFor(sub("d"), "試験 体質"));
  await nost.addInitScript(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === "10zen_cc_skip") throw new Error("QuotaExceededError"); return orig.call(this, k, v); }; });
  await nost.goto(`${BASE}/app-reference/card.html`); await nost.waitForSelector("#ccTodayPrompt"); await nost.click("#ccSkip");
  await nost.waitForSelector("#ccTodayPrompt", { state: "detached" }); await nost.reload(); await nost.waitForSelector("#ccTodayPrompt"); assert.deepEqual(nost.errs, []);
  await cc.click("#ccTodayStart"); await cc.waitForSelector("#ccStep:has-text('1 / 16')"); assert.equal(await cc.locator("#ccStart, #ccAgree").count(), 0);   // 同意済みは1問目から
  for (let i = 1; i <= 15; i++) await answer(i, i === 13 || i === 14 ? 2 : 0);                                // 水4
  await cc.waitForSelector("#ccStep:has-text('16 / 16')"); await cc.click('#ccOptions button[data-value="soup"]'); await cc.waitForSelector("#ccProfileName");
  assert.equal(await text(cc, "#ccTodayLabel"), "今日の傾向"); assert.equal(await text(cc, "#ccTypeName"), "ぽかぽかパワー不足タイプ");        // 今日の傾向 = 今回(水4)
  assert.equal(await text(cc, "#ccProfileName"), "モヤモヤ渋滞タイプ"); assert.match(await text(cc, "#ccProfileBasis"), /2回分のチェックの平均/);   // あなたの体質 = 2回の平均(木3・水2.5)
  assert.deepEqual(await cc.locator("#ccHistory li").evaluateAll((xs) => xs.map((x) => x.dataset.element)), ["water", "wood"]);
  assert.match(await text(cc, "#ccHistory li:first-child"), /ぽかぽかパワー不足タイプ/);
  assert.equal(await cc.evaluate(() => getComputedStyle(document.querySelector("#ccHistory li:first-child .chip")).color), rgb(ELEMENT_TEXT_COLORS.water));
  assert.match(await text(cc, "#ccProfileRadar"), /3\.0/); assert.match(await text(cc, "#ccProfileRadar"), /2\.5/);                     // 平均の点数(小数1桁)
  assert.match(await text(cc, "#ccDish"), new RegExp(RECOMMENDATIONS.water.soup.replace(/[()]/g, "\\$&")));                            // おすすめは今日の傾向から
  assert.equal(await text(cc, "#ccYourTeaDay"), "木曜日はあなたのお茶の日");                                                           // あなたの五巡茶はあなたの体質から
  assert.equal(await cc.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await cc.click("#ccToCard"); await cc.waitForSelector("#ccToday");
  assert.equal(await text(cc, "#ccToday"), "今日の傾向: ぽかぽかパワー不足タイプ"); assert.match(await text(cc, "#ccProfile"), /あなたの体質: モヤモヤ渋滞タイプ/);
  assert.equal(await cc.locator("#ccTodayPrompt").count(), 0);
  assert.equal(pg.exec(`select count(*) from constitution_checks where member_id=${ccMember};`), "2");
  await cc.click("#ccEntry"); await cc.waitForSelector("#ccRetake"); await cc.click("#ccRetake"); await cc.waitForSelector("#ccStart");   // もう一度: 2回目以降は同意を求めない
  assert.equal(await cc.locator("#ccAgree").count(), 0);
  ok("来店のたびのチェック(任意): 実施済みの方が来店した日は『今日の1分体質チェック』(はじめる・今日はスキップ)。スキップするとその日(日本時間)は出ない(端末に記録。記録できない端末ではその画面の間だけ)。はじめると同意済みなので1問目から。結果は今日の傾向(今回)とあなたの体質(平均)が別に出て、これまでのチェックに新しい順で並ぶ。おすすめは今日の傾向、あなたの五巡茶はあなたの体質から");

  // ---- 体質チェックの集計: 店長・閲覧はすべて、スタッフは今週のチェック結果の傾向だけ(ほかの数字は DOM にも出ない) ----
  await stf.click("[data-tab=constitution]"); await stf.waitForSelector("#ccWeek");
  assert.match(await text(stf, "#ccWeek"), /今週のチェック結果の傾向.*チェック 2 件\(1 人\)/);
  assert.match(await text(stf, "#ccWeekTypes li[data-element=wood]"), /木 モヤモヤ渋滞タイプ1/); assert.match(await text(stf, "#ccWeekTypes li[data-element=water]"), /水 ぽかぽかパワー不足タイプ1/);
  for (const id of ["#ccReach", "#ccTypes", "#ccAvgRadar", "#ccRevisit", "#ccReferral", "#ccRate", "#ccVisitRate"]) assert.equal(await stf.locator(id).count(), 0, id);
  assert.doesNotMatch(await stf.textContent("#app"), /実施した人数|薬日本堂|再来店率|タイプ別|来店時の実施率|体調/);
  for (const p of [mgr, view]) {
    await p.click("[data-tab=constitution]"); await p.waitForSelector("#ccReach");
    assert.match(await text(p, "#ccReach"), /実施した人数1人/); assert.match(await text(p, "#ccReferral"), /押された数1回/);
    assert.match(await text(p, "#ccTypes"), /水 ぽかぽかパワー不足タイプ.*1/); assert.equal(await p.locator("#ccAvgRadar polygon.radar-area").count(), 1);   // タイプ別は会員ごとの最新の結果
    assert.match(await text(p, "#ccRevisit"), /実施した人1/); assert.match(await text(p, "#ccWeek"), /チェック 2 件/);
    assert.match(await text(p, "#ccVisitRate"), /来店時の実施率\(\d{4}-\d{2}\)50%/); assert.match(await text(p, "#ccVisitRate"), /会員の来店 2 日のうち、同じ日にチェックした日 1 日/);   // 試験 太郎(未実施)と試験 体質(今日チェック)
    assert.doesNotMatch(await p.textContent("#app"), /体調/);
  }
  await mgr.click("[data-tab=redeem]"); await mgr.waitForSelector("[data-go=constitution]"); await mgr.waitForSelector("#ccPill:has-text('実施 1 人')");
  await stf.click("[data-tab=redeem]"); await stf.waitForSelector("#ccPill:has-text('今週のチェック 2 件')"); assert.match(await text(stf, "[data-go=constitution]"), /今週のチェック結果の傾向/);
  assert.equal(await stf.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  ok("体質チェックの集計(スタッフ画面): 店長・閲覧は実施人数・実施率・タイプ別・五行の平均(五角形)・再来店率の比較・相談の数・今月の来店時の実施率・今週のチェック結果の傾向。スタッフは今週のチェック結果の傾向(チェックの回数・人数・タイプの分布)だけで、ほかの数字は DOM にもない。今日の体調はどこにも出ない。ホームに体質チェックの入口。店頭タブレットは集計の関数も呼べない");

  // ---- 体質チェックと会員の紐づけ: 店長・スタッフは一覧のタイプの印(あなたの体質)と詳細(あなたの体質・実施日・今日の傾向・五角形)、閲覧には出さない ----
  for (const p of [mgr, stf]) {
    await p.click("[data-tab=members]"); await p.fill("#q", "体質"); await p.click("#search"); await p.waitForSelector("#list button .cc-chip");
    const chip = p.locator("#list button .cc-chip"); assert.equal(await chip.count(), 1);
    assert.equal(await chip.textContent(), "木"); assert.equal(await chip.getAttribute("data-element"), "wood");                        // あなたの体質(最新の結果は水)
    assert.equal(await chip.evaluate((x) => getComputedStyle(x).color), rgb(ELEMENT_TEXT_COLORS.wood)); assert.equal(await chip.evaluate((x) => getComputedStyle(x).borderTopColor), rgb(ELEMENT_COLORS.wood));
    await p.click("#list button"); await p.waitForSelector("#ccMember");
    assert.equal(await text(p, "#ccMemberType"), "木 モヤモヤ渋滞タイプ"); assert.match(await text(p, "#ccMemberProfile"), /^あなたの体質: /);
    assert.equal(await text(p, "#ccMemberDate"), `体質チェック: ${jstToday} 実施`); assert.equal(await text(p, "#ccMemberBasis"), "2回分のチェックから");
    assert.equal(await text(p, "#ccMemberToday"), "今日の傾向: 水 ぽかぽかパワー不足タイプ"); assert.equal(await text(p, "#ccMemberTodayType"), "水 ぽかぽかパワー不足タイプ");
    assert.equal(await p.locator("#ccMemberRadar circle.radar-dot").count(), 5); assert.equal(await p.locator("#ccMemberRadar text.radar-label").count(), 5);
    assert.match(await text(p, "#ccMemberRadar"), /3\.0/);                                                                             // あなたの体質の平均(木3.0)
    assert.equal(await fillOf(p, "#ccMemberRadar circle.radar-dot[data-element=water]"), rgb(ELEMENT_COLORS.water));
    assert.doesNotMatch(await p.textContent("#app"), /noodle|麺|よくある|ときどき|今日の体調/);                                     // 回答・食事の気分・今日の体調は出さない
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  }
  assert.equal(await mgr.locator("#adjust").count(), 1); assert.equal(await stf.locator("#adjust").count(), 0);
  await view.click("[data-tab=members]"); await view.fill("#q", "体質"); await view.click("#search"); await view.waitForSelector("#list button");
  assert.equal(await view.locator("#list .cc-chip").count(), 0);
  await view.click("#list button"); await view.waitForSelector("#detail");
  assert.equal(await view.locator("#ccMember").count(), 0); assert.doesNotMatch(await view.textContent("#app"), /体質チェック|モヤモヤ|今日の傾向/);
  ok("体質チェックと会員: 店長・スタッフは会員の一覧に五行の色のタイプの印(あなたの体質)、詳細にあなたの体質(最新3回の平均)・最新の実施日(日本時間)・今日チェックしていれば今日の傾向・小さな五角形(平均・五行の色)を見られる(回答・気分・今日の体調は出ない)。閲覧(本部)には一覧にも詳細にも出ない");

  // ---- 体質チェックの集計の色・店長の CSV(体質タイプ・実施日) ----
  await mgr.click("[data-tab=constitution]"); await mgr.waitForSelector("#ccTypes");
  const barColor = (sel) => mgr.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
  const barImage = (sel) => mgr.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundImage, sel);
  for (const e of ELEMENTS) { assert.equal(await barColor(`#ccTypes li[data-element=${e}] .track i`), rgb(ELEMENT_COLORS[e]), e); assert.equal(await barColor(`#ccWeekTypes li[data-element=${e}] .track i`), rgb(ELEMENT_COLORS[e]), e); }
  assert.match(await barImage("#ccTypes li[data-element=none] .track i"), /repeating-linear-gradient/);                  // バランス良好は灰色の斜線
  assert.match(await barImage("#ccWeekTypes li[data-element=none] .track i"), /repeating-linear-gradient/);
  assert.match(await text(mgr, "#ccTypes li[data-element=none]"), /バランス良好/); assert.match(await text(mgr, "#ccWeekTypes li[data-element=none]"), /バランス良好/);
  assert.equal(await fillOf(mgr, "#ccAvgRadar circle.radar-dot[data-element=earth]"), rgb(ELEMENT_COLORS.earth));
  await mgr.click("[data-tab=dash]"); await mgr.waitForSelector("#exportMembers");
  mgr.once("dialog", (d) => d.accept());
  const [dl] = await Promise.all([mgr.waitForEvent("download"), mgr.click("#exportMembers")]);
  const csv = fs.readFileSync(await dl.path(), "utf8").replace(/^\ufeff/, "").trim().split("\r\n").map((l) => l.split(","));
  const hi = csv[0].indexOf("体質タイプ"); assert.ok(hi > 0); assert.equal(csv[0][hi + 1], "体質チェック実施日");
  assert.ok(csv.every((r) => r.length === csv[0].length));
  const typed = csv.slice(1).filter((r) => r[hi] !== "未実施");
  assert.equal(typed.length, 1); assert.deepEqual(typed[0].slice(hi, hi + 2), ["木 モヤモヤ渋滞タイプ", jstToday]);                       // あなたの体質と最新の実施日
  assert.ok(csv.slice(1).filter((r) => r[hi] === "未実施").every((r) => r[hi + 1] === "")); assert.ok(csv.length > 3);
  assert.doesNotMatch(csv.flat().join(","), /noodle|cold|tired/);                                                          // 回答・気分・体調は含めない
  ok("色: 体質チェックの集計の棒(タイプ別・今週のチェック結果の傾向)は五行の色、バランス良好は灰色の斜線。五角形の点も五行の色。店長の CSV「会員別の利用状況」に体質タイプ(あなたの体質)と最新の実施日(回答は含めない)");

  // ---- 目標と KPI: 店長が擬似データの CSV(UTF-16・タブ・売上実績の形)を取り込み、率を見る ----
  { const [ty, tm] = jstToday.split("-").map(Number), py = tm === 1 ? ty - 1 : ty, pm = tm === 1 ? 12 : tm - 1, PM = `${py}-${String(pm).padStart(2, "0")}`;
    const dim = new Date(Date.UTC(py, pm, 0)).getUTCDate(), day = (d) => `${PM}-${String(d).padStart(2, "0")}`;
    const custOf = (d) => (d === 10 ? 0 : d === 15 ? 500 : 40);                                                              // 擬似の客数: 10日は0人・15日は外れ値
    const qq = (x) => `"${x}"`, head = ["当年日付", "前年日付", "曜日", "当年実績", "当年客数", "前年客数", "当年客単"].map(qq).join("\t");
    const lines = [head, ["TOTAL", "", "", "999,999", "9,999", "9,999", "999"].map(qq).join("\t")];
    for (let d = 1; d <= dim; d++) lines.push([day(d).replace(/-/g, ""), `${py - 1}${day(d).slice(5).replace(/-/g, "")}`, "月", "40,000", String(custOf(d)), "35", "1,000"].map(qq).join("\t"));
    const csvPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kpi-")), "uriage_synthetic.csv");
    fs.writeFileSync(csvPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join("\n") + "\n", "utf16le")]));
    // 前の月の来店(擬似): 3日に1人・5日に2人(どちらも客数を取り込む日)
    pg.exec(`insert into visits(member_id, visit_on, source) select id, '${day(3)}', 'store_qr' from members where display_name='試験 太郎';
             insert into visits(member_id, visit_on, source) select id, '${day(5)}', 'store_qr' from members where display_name in ('試験 太郎','試験 花子');`);
    const tot = 40 * (dim - 2), rate = (Math.round((1000 * 3) / tot) / 10).toFixed(1), esc = (x) => x.replace(/[.()]/g, "\\$&");
    await mgr.click("[data-tab=redeem]"); await mgr.waitForSelector("[data-go=kpi] #kpiPill");
    await mgr.click("[data-tab=kpi]"); await mgr.waitForSelector("#kpiCards");
    assert.match(await text(mgr, "#kpiLead"), /本番開始日が未設定/); assert.equal(await mgr.getAttribute("#kpiCard-check_rate", "data-status"), "none");
    await mgr.fill("#kpiLaunchDate", day(1)); await mgr.click("#kpiLaunchSave"); await mgr.waitForSelector("#kpiLaunchOut.ok");
    await mgr.waitForSelector(`#kpiLaunchShown:has-text('${day(1)}')`); assert.match(await text(mgr, "#kpiLead"), /今月は 2 か月目\(3か月の目標で判定\)/);
    await mgr.setInputFiles("#posFile", csvPath); await mgr.waitForSelector("#posTotals");
    assert.match(await text(mgr, "#posFileInfo"), /UTF-16・タブ区切り/); assert.match(await text(mgr, "#posFileInfo"), /売上は送りません/);
    assert.equal(await text(mgr, "#posTotals"), `見つかった日 ${dim} 日・取り込む日 ${dim - 2} 日・客数の合計 ${tot.toLocaleString("ja-JP")} 人(取り込む日)`);
    assert.equal(await mgr.$eval("#posDateCol", (x) => x.selectedOptions[0].textContent), "1列目: 当年日付"); assert.equal(await mgr.$eval("#posCustCol", (x) => x.selectedOptions[0].textContent), "5列目: 当年客数");
    assert.match(await text(mgr, "#posSkipped"), /日付ではない行.*1 行.*TOTAL/); assert.equal(await mgr.locator("#posOutliers input[type=checkbox]").count(), 2);
    assert.match(await text(mgr, "#posOutliers"), new RegExp(esc(`${day(15)} 500 人(中央値 40 人の3倍超)`)));
    await mgr.check(`#posOutliers input[data-outlier-date="${day(15)}"]`); assert.match(await text(mgr, "#posTotals"), new RegExp(`取り込む日 ${dim - 1} 日`));
    await mgr.uncheck(`#posOutliers input[data-outlier-date="${day(15)}"]`); assert.match(await text(mgr, "#posImport"), new RegExp(`${dim - 2} 日分`));
    await mgr.click("#posImport"); await mgr.waitForSelector("#posOut.ok");
    assert.equal(await text(mgr, "#posOut"), `取り込みました: 新しい日 ${dim - 2} 日・値を上書きした日 0 日・同じ値 0 日`);
    const row = `#kpiTable tr[data-month="${PM}"]`; await mgr.waitForSelector(`${row} td:nth-child(2):has-text('${tot.toLocaleString("ja-JP")}')`);
    assert.equal(await text(mgr, `${row} td:nth-child(4)`), `${rate}%`); assert.equal(await text(mgr, `${row} td:nth-child(3)`), "3");
    assert.equal(await text(mgr, `#kpiTable tr[data-month="${jstToday.slice(0, 7)}"] td:nth-child(4)`), "レジの客数が未取り込み");     // 今月はまだ
    assert.equal(await text(mgr, "#kpiVal-member_visit_rate"), "レジの客数が未取り込み"); assert.match(await text(mgr, "#kpiCard-member_visit_rate"), new RegExp(esc(`直近(${PM}): ${rate}%`)));
    assert.equal(await mgr.locator(`#kpiChart g[data-month="${PM}"] circle.dot`).count(), 1);
    // 取り込み直し: 同じ日付は上書き(監査ログに残る)・取り込み済みの警告
    await mgr.setInputFiles("#posFile", csvPath); await mgr.waitForSelector("#posOverwrite"); assert.match(await text(mgr, "#posOverwrite"), new RegExp(esc(`${PM}(${dim - 2}日分)`)));
    await mgr.click("#posImport"); await mgr.waitForSelector(`#posOut.ok:has-text('同じ値 ${dim - 2} 日')`);
    assert.equal(pg.exec(`select count(*) from audit_log where action='pos_import' and staff_user_id='${U.mgr}';`), "2");
    assert.equal(pg.exec(`select count(*) from pos_daily_customers;`), String(dim - 2));
    // 目標の変更: 実施率の3か月を 10% にすると達成(緑)
    await mgr.fill("#kpiT-check_rate-3", "10"); await mgr.click("#kpiTargetsSave"); await mgr.waitForSelector("#kpiTargetsOut.ok");
    await mgr.waitForSelector("#kpiCard-check_rate[data-status=ok]"); assert.match(await text(mgr, "#kpiAch-check_rate"), /達成率 \d+%・達成/);
    assert.match(await text(mgr, "#kpiVisitCheck"), /^来店時の実施率 \d+\.\d%\(来店 \d+ 日のうち \d+ 日\)$/); assert.doesNotMatch(await text(mgr, "#kpiCard-check_rate"), /季節の再チェック率/);
    assert.equal(await mgr.evaluate(() => getComputedStyle(document.querySelector("#kpiCard-check_rate")).borderTopColor), "rgb(79, 125, 58)");   // カードの色は KPI ごと(体質チェック=--sage)。達成の状況は札で示す
    assert.equal(await mgr.locator("#kpiCards .spark").count(), 0);                                                                                 // カードに推移の小さなグラフは出さない(牧野さん 2026-10-15)
    await mgr.fill("#kpiT-check_rate-3", "100.5"); await mgr.click("#kpiTargetsSave"); await mgr.waitForSelector("#kpiTargetsOut.bad");
    assert.equal(pg.exec(`select value from kpi_targets where kpi_code='check_rate' and milestone=3;`), "10.0");
    // 注文金額だけのファイルは、客数の行がないと伝える
    const onlyAmount = path.join(path.dirname(csvPath), "chumon_amount_only.csv");
    fs.writeFileSync(onlyAmount, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([["店舗コード", "店舗", "営業日", "集計対象", "11時", "合計"].map(qq).join("\t"),
      ["000000", "試験店舗", `${day(1).replace(/-/g, "/")}(月)`, "注文金額", "￥1,000", "￥1,000"].map(qq).join("\t")].join("\n"), "utf16le")]));
    await mgr.setInputFiles("#posFile", onlyAmount); await mgr.waitForSelector("#posError"); assert.match(await text(mgr, "#posError"), /客数の行がありません/); assert.equal(await mgr.locator("#posImport").count(), 0);
    assert.equal(await mgr.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    ok("目標とKPI(店長): 本番開始日の設定→段階の表示。擬似の CSV(UTF-16・タブ)を選ぶと、端末の中で日付と客数だけを読み、日数・合計・読み飛ばした行・確かめてほしい日(0人・中央値の3倍超。既定で除外・☑で含める)を見せてから取り込む。月の表に POS 客数と会員来店率、今月は『レジの客数が未取り込み』。取り込み直しは上書き(監査ログ)。目標を変えるとカードの色が変わる。注文金額だけのファイルは取り込めない");

    // 閲覧(本部)は見るだけ・スタッフはタブもカードもない
    await view.click("[data-tab=redeem]"); await view.waitForSelector("[data-go=kpi]");
    await view.click("[data-tab=kpi]"); await view.waitForSelector("#kpiTable");
    assert.equal(await text(view, `${row} td:nth-child(4)`), `${rate}%`); assert.equal(await view.getAttribute("#kpiCard-check_rate", "data-status"), "ok");
    for (const id of ["#kpiAdmin", "#posFile", "#kpiTargets", "#kpiLaunchDate", "#kpiTargetsSave", "#posImport", "#kpiManual", "#posMonth"]) assert.equal(await view.locator(id).count(), 0, id);
    const vDenied = await view.evaluate(async () => { const s = JSON.parse(localStorage.getItem("sess"));
      const r = await fetch("/rpc/manager_set_launch_date", { method: "POST", headers: { "x-test-uid": s.user.id, "content-type": "application/json" }, body: JSON.stringify({ p_date: null }) }); return r.status; });
    assert.equal(vDenied, 400); assert.equal(pg.exec(`select launch_date::text from kpi_settings;`), day(1));
    await stf.click("[data-tab=redeem]"); await stf.waitForSelector("[data-go=constitution]");
    assert.equal(await stf.locator("[data-tab=kpi]").count(), 0); assert.equal(await stf.locator("[data-go=kpi]").count(), 0); assert.equal(await stf.locator("#kpiPill").count(), 0);
    assert.doesNotMatch(await stf.textContent("#app"), /目標とKPI/); assert.doesNotMatch(await stf.textContent("#nav"), /目標とKPI/);
    const sDenied = await stf.evaluate(async () => { const s = JSON.parse(localStorage.getItem("sess"));
      const r = await fetch("/rpc/staff_kpi_overview", { method: "POST", headers: { "x-test-uid": s.user.id, "content-type": "application/json" }, body: JSON.stringify({ p_months: 13 }) }); return r.status; });
    assert.equal(sDenied, 400);
    ok("目標とKPI(権限): 閲覧(本部)は同じ数字と色を見られるが、本番開始日・目標・取り込み・手入力の部品は DOM になく、関数を直接呼んでも変えられない。スタッフにはタブ・ホームのカードが DOM になく、集計の関数も拒否される"); }

  // ---- 友だち紹介: 会員証の「友だちを招待」(LINE の「送る」画面・コピー・shareTargetPicker)→ 友だちが招待のリンク(liff.state の形)から登録 → 初来店 → 紹介者に1回だけお知らせ ----
  const freshQs = async () => `?action=visit&t=${(await makeToken(SECRET, UNIT, Date.now())).token}`;
  await cust.goto(`${BASE}/app-reference/card.html`); await cust.waitForSelector("#invite");
  assert.equal(await text(cust, "#inviteCount"), "今月の招待 0/5人"); assert.match(await text(cust, "#inviteText"), /お二人に「ディナーの五巡茶 1杯」のチケット/);
  assert.equal(await cust.getAttribute("#inviteShare", "data-mode"), "line-share");                                       // shareTargetPicker が使えない環境: LINE の「送る」画面へのリンク
  const shareHref = await cust.getAttribute("#inviteShare", "href"); assert.match(shareHref, /^https:\/\/line\.me\/R\/share\?text=/);
  const shareText = decodeURIComponent(shareHref.split("text=")[1]), inviteLink = shareText.match(/https:\/\/liff\.line\.me\/\S+/)[0];
  const refCode = new URL(inviteLink).searchParams.get("ref"); assert.match(refCode, /^[A-Za-z0-9_-]{12}$/); assert.equal(inviteLink, `https://liff.line.me/x?ref=${refCode}`);
  assert.doesNotMatch(shareText, /user\d{5}/); assert.equal(await cust.getAttribute("#inviteShare", "rel"), "noopener noreferrer");
  await cust.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }));
  await cust.click("#inviteCopy"); await cust.waitForSelector("#inviteOut:has-text('リンクをコピーしました')"); assert.equal(await cust.evaluate(() => window.__copied), inviteLink);
  await cust.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
  await cust.click("#inviteCopy"); await cust.waitForSelector("#inviteUrl"); assert.equal(await text(cust, "#inviteUrl"), inviteLink); assert.match(await text(cust, "#inviteOut"), /コピーできませんでした/);
  // LINE アプリの中(shareTargetPicker が使える): 友だちを選んで LINE のメッセージで送る
  const picker = await newPage(tokFor(sub("a"), "試験 太郎"));
  await picker.addInitScript(() => { let l; Object.defineProperty(window, "liff", { configurable: true, get: () => l,
    set: (v) => { l = Object.assign(v, { isApiAvailable: (n) => n === "shareTargetPicker", shareTargetPicker: async (msgs) => { window.__shared = msgs; return { status: "success" }; } }); } }); });
  await picker.goto(`${BASE}/app-reference/card.html`); await picker.waitForSelector("#inviteShare[data-mode=picker]");
  await picker.click("#inviteShare"); await picker.waitForSelector("#inviteOut:has-text('招待を送りました')");
  const shared = await picker.evaluate(() => window.__shared); assert.equal(shared.length, 1); assert.equal(shared[0].type, "text"); assert.equal(shared[0].text, shareText);
  // 友だち: 招待のリンクを開く(LIFF は最初に ?liff.state= の形で渡す)→ 登録ボタンだけ(何も入力しない)
  const fr = await newPage(tokFor(sub("9"), "紹介 友子"));
  await fr.goto(`${BASE}/app-reference/card.html?liff.state=${encodeURIComponent(`?ref=${refCode}`)}`); await fr.waitForSelector("#register");
  assert.match(await text(fr, "#inviteWelcome"), /お友だちからの招待です/);
  await fr.click("#register"); await fr.waitForSelector("#inviteReferred");
  assert.equal(await text(fr, "#notice"), "招待を受け付けました。初めてのご来店で特典チケットをお届けします"); assert.equal(await text(fr, "#points"), `${welcomeExpected} pt`);
  assert.match(await text(fr, "#inviteReferred"), /初めてのご来店で「ディナーの五巡茶 1杯」のチケット/); assert.equal(await fr.evaluate(() => location.search), "");
  assert.equal(await fr.locator("#tickets").count(), 0);                                                                     // 登録の時点では特典なし
  assert.equal(pg.exec(`select count(*) from member_referrals;`), "1");
  // 初来店(店頭QR)→ 友だちに特典チケット
  await fr.goto(`${BASE}/app-reference/card.html${await freshQs()}`); await fr.waitForSelector("#notice");
  assert.match(await text(fr, "#notice"), /100pt を付与しました。お友だち紹介の特典チケット「お友だち紹介・ディナーの五巡茶 1杯」をお届けしました/);
  await fr.waitForSelector("#tickets"); assert.match(await text(fr, "#tickets"), /お友だち紹介・ディナーの五巡茶 1杯/);
  // 紹介者: 次に会員証を開いたとき1回だけ「お友だちが来店しました」
  await cust.goto(`${BASE}/app-reference/card.html`); await cust.waitForSelector("#inviteNotice");
  assert.equal(await text(cust, "#inviteNotice"), "お友だちが来店しました。チケットが届いています"); assert.equal(await text(cust, "#inviteCount"), "今月の招待 1/5人");
  assert.match(await text(cust, "#tickets"), /お友だち紹介・ディナーの五巡茶 1杯/);
  for (let i = 0; i < 50 && pg.exec(`select count(*) from member_referrals where referrer_seen_at is not null;`) !== "1"; i++) await new Promise((r) => setTimeout(r, 100));
  await cust.reload(); await cust.waitForSelector("#invite"); assert.equal(await cust.locator("#inviteNotice").count(), 0);
  // すでに会員の人が招待のリンクを開いても、ふつうの会員証(紹介にはならない)。上限に達したら送れない
  await tk.goto(`${BASE}/app-reference/card.html?ref=${refCode}`); await tk.waitForSelector("#invite"); assert.equal(await tk.locator("#register").count(), 0);
  pg.exec(`update app_settings set value='1' where key='referral_monthly_cap';`);
  await cust.reload(); await cust.waitForSelector("#inviteFull"); assert.equal(await text(cust, "#inviteCount"), "今月の招待 1/1人");
  assert.equal(await cust.locator("#inviteShare").count(), 0); assert.equal(await cust.locator("#inviteCopy").count(), 0);
  pg.exec(`update app_settings set value='5' where key='referral_monthly_cap';`);
  assert.equal(pg.exec(`select count(*) from member_referrals;`), "1"); assert.equal(pg.exec(`select count(*) from point_ledger where rule_code in ('referral_referrer','referral_welcome');`), "0");
  assert.equal(await cust.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  ok("友だち紹介(会員証): 『友だちを招待』は LINE の中では shareTargetPicker で送り、使えなければ LINE の「送る」画面へのリンク。リンクのコピー(できなければリンクを表示)。リンクに会員番号は出ない。友だちは招待のリンク(liff.state の形)から登録ボタンを押すだけで紹介になり、初来店(店頭QR)で特典チケット。紹介者の会員証に『お友だちが来店しました。チケットが届いています』が1回だけ出て『今月の招待 1/5人』。すでに会員の人は紹介にならず、上限に達したら招待のボタンを出さない");

  // ---- 友だち紹介(スタッフ画面): 集計に紹介の数、目標とKPI の会員来店率のカードに『紹介からの新規来店』、店長だけ五巡茶の出し方を切り替え ----
  await mgr.click("[data-tab=redeem]"); await mgr.waitForSelector("#code"); await mgr.click("[data-tab=kpi]"); await mgr.waitForSelector("#kpiReferralVisits");
  assert.equal(await text(mgr, "#kpiReferralVisits"), "紹介からの新規来店 1人"); assert.equal(await text(mgr, "#kpiReferralRegs"), "紹介からの登録 1人");
  assert.equal(await mgr.locator("#kpiCard-member_visit_rate #kpiReferralVisits").count(), 1);
  await view.click("[data-tab=redeem]"); await view.waitForSelector("#code"); await view.click("[data-tab=kpi]"); await view.waitForSelector("#kpiReferralVisits"); assert.equal(await text(view, "#kpiReferralVisits"), "紹介からの新規来店 1人");
  await mgr.click("[data-tab=dash]"); await mgr.waitForSelector("#referralStats");
  assert.match(await text(mgr, "#referralStats"), /紹介からの登録1人.*紹介からの新規来店1人.*初来店待ち\(累計\)0人/);
  await mgr.waitForSelector("#teaModeBox"); assert.equal(await mgr.$eval("#teaMode", (x) => x.value), "cup"); assert.match(await text(mgr, "#teaModeLabel"), /ディナーの五巡茶 1杯/);
  await mgr.selectOption("#teaMode", "free_flow"); await mgr.click("#teaModeSave"); await mgr.waitForSelector("#teaModeOut.c-ok");
  assert.match(await text(mgr, "#teaModeOut"), /ディナーの五巡茶 飲み放題/); assert.equal(pg.exec(`select value from app_settings where key='dinner_tea_mode';`), "free_flow");
  await fr.goto(`${BASE}/app-reference/card.html`); await fr.waitForSelector("#tickets"); assert.match(await text(fr, "#tickets"), /お友だち紹介・ディナーの五巡茶 飲み放題/);
  await mgr.selectOption("#teaMode", "cup"); await mgr.click("#teaModeSave"); await mgr.waitForSelector("#teaModeOut:has-text('1杯')");
  for (const p of [stf, view]) { await p.click("[data-tab=dash]"); await p.waitForSelector("#referralStats"); assert.equal(await p.locator("#teaModeBox").count(), 0); assert.equal(await p.locator("#teaMode").count(), 0); }
  const sTea = await stf.evaluate(async () => { const s = JSON.parse(localStorage.getItem("sess"));
    const r = await fetch("/rpc/manager_set_dinner_tea_mode", { method: "POST", headers: { "x-test-uid": s.user.id, "content-type": "application/json" }, body: JSON.stringify({ p_mode: "free_flow" }) }); return r.status; });
  assert.equal(sTea, 400); assert.equal(pg.exec(`select value from app_settings where key='dinner_tea_mode';`), "cup");
  assert.equal(await mgr.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  ok("友だち紹介(スタッフ画面): 集計に今月の紹介からの登録・新規来店・初来店待ち。目標とKPI の会員来店率のカードに『紹介からの新規来店』『紹介からの登録』(店長・閲覧)。五巡茶の出し方(1杯/飲み放題)は店長だけが切り替えられ、友だちのチケットの名前も変わる。スタッフ・閲覧には部品がなく、関数を直接呼んでも変えられない");

  // ---- 表示の安全性 ----
  const evil = await newPage(tokFor(sub("b"), "<img src=x onerror=window.__x=1><script>window.__x=2</script>"));
  await evil.goto(`${BASE}/app-reference/card.html`); await evil.waitForSelector("#register"); await evil.click("#register"); await evil.waitForSelector("#name");
  assert.match(await text(evil, "#name"), /^<img src=x onerror=window.__x=1><script>/); assert.equal(await evil.evaluate(() => window.__x), undefined);
  await mgr.click("[data-tab=members]"); await mgr.fill("#q", "img"); await mgr.click("#search"); await mgr.waitForSelector("#list button"); assert.equal(await mgr.evaluate(() => window.__x), undefined);
  ok("表示名にHTML/スクリプトがあっても実行されず、文字として表示される(お客様画面・スタッフ画面とも)");
  const ptsNoOverflow = await cust.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth); assert.ok(ptsNoOverflow);
  for (const p of [cust, stf, mgr, view, evil, tk, cc, picker, fr, nost]) assert.deepEqual(p.errs, [], p.errs.join("|"));
  assert.equal(await tk.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.equal(Number(pg.exec(`select count(*) from public.verify_balances();`)), 0);
  ok("ブラウザのエラーなし・横スクロールなし・全会員で残高=台帳の合計");
  console.log(`\n${n} e2e tests passed`);
} finally { await browser.close(); server.close(); pg.stop(); }
