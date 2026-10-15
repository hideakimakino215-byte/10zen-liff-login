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
import { RECOMMENDATIONS, DISCLAIMER } from "../app-core/constitution-content.mjs";

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
  pg.loadFile("100_phase1_schema.sql"); pg.loadFile("101_search_path_fix.sql"); pg.loadFile("102_rank_perks.sql");   // 102: ランク特典(スタッフ画面のコード入力は staff_lookup_code を使う)
  pg.loadFile("103_constitution_check.sql");                                                                            // 103: 1分体質チェック
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
  await mgr.fill("#adjPoints", "50"); await mgr.click("#adjust"); await mgr.waitForSelector("#adjOut:has-text('入力を確認')");
  await mgr.fill("#adjReason", "紙の台帳との差異の訂正"); await mgr.click("#adjust"); await mgr.waitForSelector("#ledger li:has-text('紙の台帳との差異の訂正')");
  assert.match(await text(mgr, "#detail"), new RegExp(`${before - 100 + 50}pt`));
  const view = await newPage(); await view.goto(`${BASE}/app-reference/staff.html`); await view.fill("#email", "viewer@t"); await view.fill("#password", "pw"); await view.click("#login"); await view.waitForSelector("#who:has-text('viewer')");
  await view.click("[data-tab=redeem]"); await view.fill("#code", "123456"); await view.click("#lookup"); await view.waitForSelector("#redeemMsg:has-text('権限がありません')");
  await view.click("[data-tab=members]"); await view.waitForSelector("#list button"); await view.click("#list button"); await view.waitForSelector("#detail"); assert.equal(await view.locator("#adjust").count(), 0);
  ok("店長: 検索→詳細→理由なしは拒否・理由つきで手動調整→履歴に理由が出る。閲覧のみ: 使用確認は拒否、会員の閲覧はでき、調整フォームは出ない");

  // ---- 1分体質チェック: 会員証の入口 → 同意 → 15問+気分(1問1画面・戻る)→ 結果 → 薬日本堂 → 会員証(来店した日の今日の体調) ----
  const cc = await newPage(tokFor(sub("d"), "試験 体質"));
  await cc.context().route("https://www.nihondo.co.jp/**", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<p>ok</p>" }));   // 外部には出ない
  await cc.goto(`${BASE}/app-reference/card.html`); await cc.waitForSelector("#register"); await cc.click("#register"); await cc.waitForSelector("#ccEntry");
  assert.equal(await text(cc, "#ccEntry"), "1分体質チェック"); assert.equal(await cc.locator("#ccCondition").count(), 0); assert.equal(await cc.locator("#ccTodayTea").count(), 0);
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
  assert.equal(await text(cc, "#ccTypeName"), "モヤモヤ渋滞タイプ"); assert.match(await text(cc, "#ccTypeLine"), /張りつめがち/);
  assert.equal(await cc.locator("#ccRadar polygon.radar-area").count(), 1); assert.equal(await cc.locator("#ccRadar text.radar-label").count(), 5);
  assert.equal(await cc.locator("#ccDetail").isVisible(), false); await cc.click("#ccDetailToggle"); assert.equal(await cc.locator("#ccDetail").isVisible(), true);
  assert.match(await text(cc, "#ccDetail"), /五行: 木 \/ 五臓: 肝 \/ 状態: 気滞/);
  assert.match(await text(cc, "#ccDish"), new RegExp(RECOMMENDATIONS.wood.noodle.replace(/[()]/g, "\\$&")));
  assert.equal(await text(cc, "#ccYourTeaDay"), "木曜日はあなたのお茶の日"); assert.match(await text(cc, "#ccYourTea"), /五巡茶\(木\)/);
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
  await cc.click("#ccToCard"); await cc.waitForSelector("#ccEntry"); assert.equal(await text(cc, "#ccEntry"), "結果を見る");
  assert.match(await text(cc, "#ccTodayTea"), /今日の五巡茶: 五巡茶/); assert.equal(await cc.locator("#ccCondition").count(), 0);           // まだ来店していない
  pg.exec(`insert into visits(member_id, visit_on) select ${ccMember}, public._jst_date(now());`);
  await cc.reload(); await cc.waitForSelector("#ccCondition");
  await cc.click('#ccCondition button[data-value="cold"]'); await cc.click('#ccCondition button[data-value="tired"]');
  assert.equal(await cc.getAttribute('#ccCondition button[data-value="cold"]', "aria-pressed"), "true");
  await cc.click('#ccCondition button[data-value="dry"]'); await cc.waitForSelector("#ccFocus");
  assert.equal(await cc.locator("#ccCondition").count(), 0); assert.match(await text(cc, "#ccFocus"), /今日のおすすめ: \(仮\).*今日のおすすめの五行: 木/);   // 木6 > 水3・土2・金2
  assert.equal(pg.exec(`select temp || ',' || energy || ',' || concern || ',' || focus_element from constitution_daily_conditions where member_id=${ccMember};`), "cold,tired,dry,wood");
  await cc.click("#ccEntry"); await cc.waitForSelector("#ccTypeName"); assert.match(await text(cc, "#ccDish"), /今日の体調から/);           // 実施済みは結果をそのまま出す
  pg.exec(`update constitution_checks set season_key='2020-summer' where member_id=${ccMember};`);
  await cc.goto(`${BASE}/app-reference/card.html`); await cc.waitForSelector("#ccSeasonPrompt"); assert.equal(await text(cc, "#ccSeasonPrompt"), "季節が変わりました。体質チェックをもう一度");
  await cc.click("#ccEntry"); await cc.waitForSelector("#ccRetake"); await cc.click("#ccRetake"); await cc.waitForSelector("#ccStart");   // 2回目は同意を求めない
  assert.equal(await cc.locator("#ccAgree").count(), 0);
  ok("1分体質チェック: 会員証の入口→同意→15問(1問1画面・タップで次へ・戻ると前の答えが残る)→食事の気分→結果(タイプ・五角形・タップで正式名称・おすすめ・あなたの五巡茶とお茶の日・今日の五巡茶・季節・薬日本堂・診断ではない旨)。点数は DB が計算・相談ボタンのクリックを記録。会員証は『結果を見る』に変わり、来店した日は今日の体調の3タップ→今日のおすすめ。季節が変わると案内");

  // ---- 体質チェックの集計: 店長・閲覧はすべて、スタッフは今週の体調の傾向だけ(ほかの数字は DOM にも出ない) ----
  await stf.click("[data-tab=constitution]"); await stf.waitForSelector("#ccWeek");
  assert.match(await text(stf, "#ccWeek"), /今週の体調の傾向.*回答 1 件/);
  for (const id of ["#ccReach", "#ccTypes", "#ccAvgRadar", "#ccRevisit", "#ccReferral", "#ccRate"]) assert.equal(await stf.locator(id).count(), 0, id);
  assert.doesNotMatch(await stf.textContent("#app"), /実施した人数|薬日本堂|再来店率|タイプ別/);
  for (const p of [mgr, view]) {
    await p.click("[data-tab=constitution]"); await p.waitForSelector("#ccReach");
    assert.match(await text(p, "#ccReach"), /実施した人数1人/); assert.match(await text(p, "#ccReferral"), /押された数1回/);
    assert.match(await text(p, "#ccTypes"), /木 モヤモヤ渋滞タイプ.*1/); assert.equal(await p.locator("#ccAvgRadar polygon.radar-area").count(), 1);
    assert.match(await text(p, "#ccRevisit"), /実施した人1/); assert.match(await text(p, "#ccWeek"), /回答 1 件/);
  }
  await mgr.click("[data-tab=redeem]"); await mgr.waitForSelector("[data-go=constitution]"); await mgr.waitForSelector("#ccPill:has-text('実施 1 人')");
  await stf.click("[data-tab=redeem]"); await stf.waitForSelector("#ccPill:has-text('今週の体調 1 件')");
  assert.equal(await stf.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  ok("体質チェックの集計(スタッフ画面): 店長・閲覧は実施人数・実施率・タイプ別・五行の平均(五角形)・再来店率の比較・相談の数・今週の体調。スタッフは今週の体調の傾向だけで、ほかの数字は DOM にもない。ホームに体質チェックの入口。店頭タブレットは集計の関数も呼べない");

  // ---- 表示の安全性 ----
  const evil = await newPage(tokFor(sub("b"), "<img src=x onerror=window.__x=1><script>window.__x=2</script>"));
  await evil.goto(`${BASE}/app-reference/card.html`); await evil.waitForSelector("#register"); await evil.click("#register"); await evil.waitForSelector("#name");
  assert.match(await text(evil, "#name"), /^<img src=x onerror=window.__x=1><script>/); assert.equal(await evil.evaluate(() => window.__x), undefined);
  await mgr.click("[data-tab=members]"); await mgr.fill("#q", "img"); await mgr.click("#search"); await mgr.waitForSelector("#list button"); assert.equal(await mgr.evaluate(() => window.__x), undefined);
  ok("表示名にHTML/スクリプトがあっても実行されず、文字として表示される(お客様画面・スタッフ画面とも)");
  const ptsNoOverflow = await cust.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth); assert.ok(ptsNoOverflow);
  for (const p of [cust, stf, mgr, view, evil, tk, cc]) assert.deepEqual(p.errs, [], p.errs.join("|"));
  assert.equal(await tk.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.equal(Number(pg.exec(`select count(*) from public.verify_balances();`)), 0);
  ok("ブラウザのエラーなし・横スクロールなし・全会員で残高=台帳の合計");
  console.log(`\n${n} e2e tests passed`);
} finally { await browser.close(); server.close(); pg.stop(); }
