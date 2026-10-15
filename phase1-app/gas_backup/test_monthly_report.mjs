// gas_backup/monthly_report.gs(月次レポート)を、Google のサービスの代替(スタブ)の上で検証する。Edge Function は実物(backup-export の handler.ts)+実 PostgreSQL(db/107 の report_monthly)。
// 本番には接続しない。メールは送らない(MailApp は記録するだけ)。データはすべて擬似(実在の会員・売上・客数ではない)。
// 実行: node --experimental-strip-types test_monthly_report.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { startPg, q } from "../patches/pgdb.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { handle, statusToken, backupToken, reportToken } from "../functions/backup-export/handler.ts";
import { ELEMENT_INFO, BALANCED_NAME } from "../app-core/constitution.mjs";

const pg = startPg(); let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const SECRET = "m".repeat(64), URL_ = "https://edge.test/backup-export", ISS = "2011158053";
const gasBytes = (buf) => [...buf].map((x) => (x > 127 ? x - 256 : x));
const fmt = (d, _tz, pat) => {   // Utilities.formatDate の代替(Asia/Tokyo 固定)
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return pat.replace("yyyy", p.year).replace("MM", p.month).replace("dd", p.day).replace("HH", p.hour).replace("mm", p.minute).replace(/^d$/, String(Number(p.day)));
};
const SVC = (sql) => pg.exec(`set role service_role;\n${sql}`);
const D = (s) => new Date(s).getTime();
const NAMES = ["月次 太郎", "月次 花子", "月次 次郎"];
try {
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role; grant select on auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql", "106_referral.sql", "107_constitution_each_visit.sql"]) pg.loadFile(f);
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit';`);
  // 擬似データ(2026年8〜9月): 登録・紹介・来店・体質チェック・今日の体調(非推奨。レポートには出さない)・9月のレジの客数(日別 20人×30日)
  const subs = NAMES.map((_, i) => "U" + String(i + 1).repeat(32));
  const reg = (i, at, code = null) => { SVC(`select public.app_register(${q(ISS)}, ${q(subs[i])}, ${q(NAMES[i])}, null, ${q(at)}::timestamptz, ${q(code)});`);
    pg.exec(`update members set created_at = ${q(at)}::timestamptz where id = (select member_id from member_identities where subject = ${q(subs[i])});`); };
  reg(0, "2026-08-20T03:00:00Z");
  const codeA = JSON.parse(SVC(`select public.app_me(${q(ISS)}, ${q(subs[0])}, now());`).split("\n").pop()).member.invite.code;
  reg(1, "2026-09-05T03:00:00Z", codeA); reg(2, "2026-09-06T03:00:00Z");
  for (const [i, at] of [[1, "2026-09-10T03:00:00Z"], [0, "2026-09-12T03:00:00Z"]]) SVC(`select public.app_checkin(${q(ISS)}, ${q(subs[i])}, null, ${q(at)}::timestamptz);`);
  for (const i of [0, 1]) SVC(`select public.app_constitution_submit(${q(ISS)}, ${q(subs[i])}, array[2,2,2,0,0,0,0,0,0,0,0,0,0,0,0]::integer[], 'soup', true, '2026-09-10T05:00:00Z'::timestamptz);`);
  SVC(`select public.app_condition_submit(${q(ISS)}, ${q(subs[0])}, 'cold', 'tired', 'dry', '2026-09-11T05:00:00Z'::timestamptz);`);
  pg.exec(`insert into pos_daily_customers(business_date, customers, source) select d::date, 20, 'synthetic.csv' from generate_series('2026-09-01'::date, '2026-09-30'::date, '1 day') d;`);
  const sb = rpcOver(pg);
  const call = async (body, tok, supabase = sb) => { const r = await handle(new Request(URL_, { method: "POST", headers: { authorization: "Bearer " + tok }, body: JSON.stringify(body) }), { supabase, secret: SECRET, nowMs: () => Date.now() }); return { status: r.status, body: await r.json() }; };

  // ---- 本体(backup.gs)と、見張り役のプロジェクト(watchdog.gs + monthly_report.gs)は別の実行環境 ----
  const who = { email: "owner@example.test" };
  const logs = [];
  const common = () => ({ console: { log: (x) => logs.push(String(x)) }, JSON, String, Date, Error, Number, Math, isFinite,
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.test" }), getActiveUser: () => ({ getEmail: () => who.email }) },
    Utilities: { computeHmacSha256Signature: (v, k) => gasBytes(crypto.createHmac("sha256", k).update(v).digest()), formatDate: fmt } });
  const main = vm.createContext({ ...common(), PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => ({ CHECKIN_SECRET: SECRET })[k] ?? null }) } });
  vm.runInContext(fs.readFileSync(new URL("./backup.gs", import.meta.url), "utf8"), main);
  vm.runInContext(fs.readFileSync(new URL("../gas_freeze/freeze.gs", import.meta.url), "utf8"), main);   // assertOwner_
  const wProps = {}, mails = [], fetched = [], triggers = []; let prepared = null, throwNet = false, locked = false;
  const w = vm.createContext({ ...common(),
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => wProps[k] ?? null, setProperty: (k, v) => { wProps[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !locked, releaseLock: () => {} }) },
    MailApp: { sendEmail: (to, subj, body) => mails.push({ to, subj, body }) },
    UrlFetchApp: { fetch: (url, o) => { fetched.push({ url, body: JSON.parse(o.payload), auth: o.headers.Authorization }); if (throwNet) throw new Error("network down"); return prepared; } },
    ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ onMonthDay: (day) => ({ atHour: (h) => ({ inTimezone: (tz) => ({ create: () => triggers.push({ fn, day, h, tz, getHandlerFunction: () => fn }) }) }) }),
                                                 everyDays: (d) => ({ atHour: (h) => ({ inTimezone: (tz) => ({ create: () => triggers.push({ fn, d, h, tz, getHandlerFunction: () => fn }) }) }) }) }) }) } });
  const wsrc = fs.readFileSync(new URL("./watchdog.gs", import.meta.url), "utf8"), msrc = fs.readFileSync(new URL("./monthly_report.gs", import.meta.url), "utf8");
  vm.runInContext(wsrc, w); vm.runInContext(msrc, w);                                                                        // 同じプロジェクトに2つのファイル
  const run = (expr) => JSON.parse(JSON.stringify(vm.runInContext(expr, w)));
  // GAS の fetch は同期。ハンドラー(実物)の応答を先に作っておき、月次レポートに渡す
  const prep = async (month, tok = wProps.REPORT_TOKEN) => { const r = await call({ action: "monthly_report", month }, tok); prepared = { getResponseCode: () => r.status, getContentText: () => JSON.stringify(r.body) }; mails.length = 0; fetched.length = 0; return r; };
  const OCT1 = D("2026-10-01T00:00:00Z");                                                                                    // 日本時間 10/1 9:00 → 前の月は 2026-09

  // 1) トークン: 本体の showReportToken(所有者のみ)で表示した値は、月次レポートの取得だけに使える。見張り用・全体のトークンの範囲は今までどおり
  const tok = vm.runInContext("showReportToken()", main);
  assert.equal(tok, await reportToken(SECRET)); assert.notEqual(tok, await statusToken(SECRET)); assert.notEqual(tok, await backupToken(SECRET));
  who.email = "other@example.test"; assert.throws(() => vm.runInContext("showReportToken()", main), /権限がありません/); who.email = "owner@example.test";
  pg.exec(`update kpi_settings set launch_date='2026-09-01';`);
  assert.equal((await call({ action: "monthly_report", month: "2026-09" }, tok)).status, 200);
  for (const a of ["status", "export"]) assert.equal((await call({ action: a }, tok)).status, 403, a);
  assert.equal((await call({ action: "record", ok: true }, tok)).status, 403); assert.equal(pg.exec(`select count(*) from backup_runs;`), "0");
  assert.equal((await call({ action: "monthly_report", month: "2026-09" }, await statusToken(SECRET))).status, 403);       // 見張り用のトークンでは取れない
  assert.equal((await call({ action: "status" }, await statusToken(SECRET))).status, 200); assert.equal((await call({ action: "export" }, await statusToken(SECRET))).status, 403);
  const full = await call({ action: "monthly_report", month: "2026-09" }, await backupToken(SECRET)); assert.equal(full.status, 200); assert.equal(full.body.month, "2026-09");
  assert.equal((await call({ action: "monthly_report", month: "2026-09" }, "0".repeat(64))).status, 401);
  for (const m of [undefined, "2026-13", "202609", "2026-9", 202609]) assert.equal((await call({ action: "monthly_report", month: m }, tok)).status, 400, String(m));
  assert.equal((await call({ action: "monthly_report", month: "2026-09" }, tok, rpcOver(pg, { failRpc: (x) => x === "report_monthly" }))).status, 500);
  ok("月次レポート用トークン: 本体の showReportToken(所有者のみ)で表示でき、月次レポートの取得だけに使える(状態の確認・書き出し・記録は 403)。見張り用のトークンでは取れず(403)、全体のトークンでは取れる。誤ったトークンは 401、月の形が違えば 400、DB のエラーは 500");

  Object.assign(wProps, { BACKUP_URL: URL_, REPORT_TOKEN: tok, REPORT_TO: "makino@example.test", STAFF_URL: "https://staff.example.test/app-reference/staff.html" });
  // 2) 本番開始日の前は送らない(未設定・前の月が開始日の月より前)。開始日の月が終わった次の月から送る
  pg.exec(`update kpi_settings set launch_date=null;`);
  await prep("2026-09"); let r = run(`monthlyReport_(${OCT1})`);
  assert.deepEqual(r, { status: "skipped", month: "2026-09", reason: "no_launch_date" }); assert.equal(mails.length, 0); assert.equal(wProps.REPORT_LAST_SENT, undefined);
  assert.deepEqual(fetched.map((f) => [f.url, f.body.action, f.body.month, f.auth === "Bearer " + tok]), [[URL_, "monthly_report", "2026-09", true]]);
  pg.exec(`update kpi_settings set launch_date='2026-10-05';`);
  await prep("2026-09"); r = run(`monthlyReport_(${OCT1})`); assert.equal(r.reason, "before_launch"); assert.equal(mails.length, 0);
  pg.exec(`update kpi_settings set launch_date='2026-09-20';`);                                                               // 9月が開始日の月 → 10/1 に9月の分を送る
  await prep("2026-09"); r = run(`monthlyReport_(${OCT1})`); assert.equal(r.status, "sent"); assert.equal(mails.length, 1); assert.equal(wProps.REPORT_LAST_SENT, "2026-09");
  ok("本番開始日が未設定・前の月が開始日の月より前のときは、DB が skipped を返し、メールを送らない(送った記録も残さない)。開始日の月が終わった次の月の1日に、その月の分を送る");

  // 3) 文面: 件名・期間・4つの KPI(実績/目標/達成率/前の月との差)・会員・ランク別・体質(チェック結果の傾向・来店時の実施率)・チケット・スタッフ画面のリンク
  delete wProps.REPORT_LAST_SENT; pg.exec(`update kpi_settings set launch_date='2026-09-01';`); wProps.REPORT_TO = "makino@example.test,manager@example.test";
  const rep = (await prep("2026-09")).body; r = run(`monthlyReport_(${OCT1})`);
  assert.equal(r.status, "sent"); assert.equal(r.recipients, 2); assert.equal(mails.length, 1); assert.equal(mails[0].to, "makino@example.test,manager@example.test");
  const m0 = mails[0]; assert.equal(m0.subj, "10ZEN 月次レポート 2026年9月");
  const lines = m0.body.split("\n");
  assert.equal(lines[0], "10ZEN 青山店 月次レポート 2026年9月(9月1日〜9月30日・日本時間)"); assert.equal(lines[1], "本番開始から 1 か月目(3か月の目標で判定)");
  const vr = rep.kpis.member_visit_rate; assert.equal(vr.target, 15); assert.equal(vr.actual, 0.3);
  assert.ok(lines.includes(`・会員来店率: 0.3% / 15.0% / ${vr.achievementPercent}% / 前の月との差 —`), m0.body);           // 8月はレジの客数がないので差は出ない
  const nm = rep.kpis.new_members; assert.equal(nm.actual, 2); assert.equal(nm.previous, 1);
  assert.ok(lines.includes(`(補助)新規登録数: 2人 / 300人 / ${nm.achievementPercent}% / 前の月との差 +1人`), m0.body);
  assert.ok(lines.includes(`・体質チェック実施率: ${rep.kpis.check_rate.actual.toFixed(1)}% / 40.0% / ${rep.kpis.check_rate.achievementPercent}% / 前の月との差 +${rep.kpis.check_rate.change.toFixed(1)}pt`), m0.body);
  assert.ok(lines.includes("・薬日本堂への送客: 0回 / 20回 / 0% / 前の月との差 ±0回"), m0.body);
  assert.ok(lines.includes("・新規登録: 2人")); assert.ok(lines.includes("・紹介からの新規来店: 1人(紹介からの登録 1人)"));
  assert.ok(lines.includes("・ランク別(有効会員 3人): WHITE OPAL 3人 / AMBER 0人 / EMERALD 0人 / RUBY 0人 / ONYX 0人"), m0.body);
  assert.ok(lines.includes("・会員の来店: 2回 / レジの客数: 600人(日別 30日分)"), m0.body);
  assert.ok(lines.includes("・実施した会員: 2人(実施率 66.7%)・この月のチェック 2回"), m0.body);
  assert.ok(lines.includes("・タイプ別: 木 モヤモヤ渋滞タイプ 2人 / 火 カッカ熱こもりタイプ 0人 / 土 消化パワー不足タイプ 0人 / 金 うるおい不足タイプ 0人 / 水 ぽかぽかパワー不足タイプ 0人 / バランス良好 0人"), m0.body);
  assert.ok(lines.includes("・チェック結果の傾向(この月のチェック 2回): 木 モヤモヤ渋滞タイプ 2回 / 火 カッカ熱こもりタイプ 0回 / 土 消化パワー不足タイプ 0回 / 金 うるおい不足タイプ 0回 / 水 ぽかぽかパワー不足タイプ 0回 / バランス良好 0回"), m0.body);
  assert.ok(lines.includes("・来店時の実施率: 50.0%(会員の来店 2日のうち、同じ日にチェックした日 1日)"), m0.body);   // 9/10 の来店は同じ日にチェック・9/12 の来店はしていない
  assert.doesNotMatch(m0.body, /今日の体調|冷えている/);                                                                      // 今日の体調はレポートに出さない(db/107)
  assert.deepEqual(rep.constitution.checkResults, { checks: 2, members: 2, byType: { wood: 2, fire: 0, earth: 0, metal: 0, water: 0, balanced: 0 } });
  assert.deepEqual(rep.constitution.visitCheckRate, { visitDays: 2, checkedVisitDays: 1, ratePercent: 50 }); assert.equal("conditions" in rep.constitution, false);
  assert.ok(lines.includes("・この月の発行: 2枚(到達のお祝い 0・季節の豆花 0・お友だち紹介 2)/ この月の使用: 0枚"), m0.body);
  assert.ok(lines.includes("・使用率(月末までの累計): 0.0%(発行 2枚・使用 0枚)"), m0.body);
  assert.equal(lines[lines.indexOf("■ スタッフ画面") + 1], "https://staff.example.test/app-reference/staff.html");
  ok("文面: 件名『10ZEN 月次レポート 2026年9月』、期間と本番開始からの月、4つの KPI と新規登録の実績・目標・達成率・前の月との差(率は pt、数は件数)、会員(新規登録・紹介からの新規来店・ランク別・来店とレジの客数)、体質(実施・タイプ別・この月のチェック結果の傾向・来店時の実施率)、チケット(発行・使用・使用率)、スタッフ画面のリンク。送り先はカンマ区切りで複数可");

  // 4) 注意の行: 目標の80%未満の KPI・レジの客数が未取り込み。ないときは「特になし」。試験運用中は件名と冒頭に明記
  const warnLines = (body) => { const L = body.split("\n"), i = L.indexOf("■ 注意"); const out = []; for (let k = i + 1; L[k] && L[k].startsWith("・"); k++) out.push(L[k]); return out; };
  assert.ok(warnLines(m0.body).includes(`・会員来店率が目標の80%未満です(達成率 ${vr.achievementPercent}%)`));
  const base = JSON.parse(JSON.stringify(rep));
  const mk = (patch) => { const j = JSON.parse(JSON.stringify(base)); patch(j); return run(`buildReportMail_(${JSON.stringify(j)}, "https://s.test")`); };
  const allOk = (j) => { for (const k of Object.keys(j.kpis)) j.kpis[k].achievementPercent = 100; j.pos.missing = false; };
  assert.deepEqual(warnLines(mk(allOk).body), ["・特になし"]); assert.deepEqual(mk(allOk).warnings, []);
  assert.deepEqual(warnLines(mk((j) => { allOk(j); j.kpis.member_visit_rate.achievementPercent = 80; }).body), ["・特になし"]);                 // ちょうど80%は注意しない
  assert.deepEqual(warnLines(mk((j) => { allOk(j); j.kpis.member_visit_rate.achievementPercent = 79; }).body), ["・会員来店率が目標の80%未満です(達成率 79%)"]);
  assert.deepEqual(warnLines(mk((j) => { allOk(j); j.kpis.member_visit_rate.achievementPercent = null; j.kpis.revisit_rate.achievementPercent = null; }).body), ["・特になし"]);   // 目標なしは注意しない
  const posMissing = mk((j) => { allOk(j); j.pos.missing = true; j.pos.customers = null; j.kpis.member_visit_rate.achievementPercent = null; });
  assert.deepEqual(warnLines(posMissing.body), ["・レジの客数が未取り込みです(会員来店率を計算できません。スタッフ画面の「目標とKPI」から取り込んでください)"]);
  assert.match(posMissing.body, /レジの客数: 未取り込み/);
  const noCheck = mk((j) => { j.constitution.checkResults = { checks: 0, members: 0, byType: {} }; j.constitution.visitCheckRate = { visitDays: 0, checkedVisitDays: 0, ratePercent: null }; }).body.split("\n");
  assert.ok(noCheck.includes("・チェック結果の傾向: この月のチェックはありません")); assert.ok(noCheck.includes("・来店時の実施率: —(会員の来店 0日のうち、同じ日にチェックした日 0日)"));
  const tst = mk((j) => { j.scope = "test"; }); assert.equal(tst.subject, "10ZEN 月次レポート 2026年9月(試験運用のデータ)"); assert.match(tst.body, /試験会員と試験用の客数/);
  assert.equal(run(`buildReportMail_(${JSON.stringify({ ...base, month: "2027-02" })}, "")`).body.split("\n")[0], "10ZEN 青山店 月次レポート 2027年2月(2月1日〜2月28日・日本時間)");
  assert.match(run(`buildReportMail_(${JSON.stringify(base)}, "")`).body, /STAFF_URL に設定してください/);
  assert.equal(run(`reportPreviousMonth_(${D("2026-12-31T15:00:00Z")})`), "2026-12"); assert.equal(run(`reportPreviousMonth_(${D("2026-12-31T14:59:00Z")})`), "2026-11");   // 日本時間の1/1 0:00 から
  assert.equal(run(`reportPreviousMonth_(${D("2027-01-01T00:00:00Z")})`), "2026-12");
  ok("注意の行: 目標の80%未満の KPI(ちょうど80%・目標なしは除く)とレジの客数の未取り込みを1行ずつ。なければ『特になし』。試験運用中は件名と冒頭に明記。前の月は日本時間で決める(1/1 0:00 から前の年の12月)");

  // 5) 個人の情報を含まない(氏名・会員番号・LINE の ID・内部 ID)
  const allText = JSON.stringify(rep) + m0.subj + m0.body;
  for (const nm2 of NAMES) assert.ok(!allText.includes(nm2), nm2);
  assert.doesNotMatch(allText, /user\d{5}|U[0-9a-f]{32}|U(\d)\1{31}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.ok(!allText.includes(codeA));                                                                                       // 招待コードも含まない
  ok("個人の情報を含まない: 応答とメールに、氏名・会員番号・LINE の ID・会員の内部 ID・招待コードが出ない");

  // 6) 取得できないとき: 所有者に『作れませんでした』(送り先の設定ではなく所有者だけ)。送った記録は残さず、直ったら同じ月を送れる
  delete wProps.REPORT_LAST_SENT;
  throwNet = true; mails.length = 0; r = run(`monthlyReport_(${OCT1})`); throwNet = false;
  assert.equal(r.status, "error"); assert.equal(mails.length, 1); assert.equal(mails[0].to, "owner@example.test"); assert.equal(mails[0].subj, "【10ZEN】月次レポートを作れませんでした(2026年9月)");
  assert.match(mails[0].body, /通信エラー: network down/); assert.match(mails[0].body, /monthlyReport を実行/); assert.equal(wProps.REPORT_LAST_SENT, undefined);
  prepared = { getResponseCode: () => 500, getContentText: () => "{}" }; mails.length = 0; r = run(`monthlyReport_(${OCT1})`); assert.equal(r.status, "error"); assert.match(mails[0].body, /HTTP 500/);
  prepared = { getResponseCode: () => 200, getContentText: () => "<html>" }; mails.length = 0; r = run(`monthlyReport_(${OCT1})`); assert.equal(r.status, "error"); assert.match(mails[0].body, /通信エラー/);
  await prep("2026-09", "0".repeat(64)); r = run(`monthlyReport_(${OCT1})`); assert.equal(r.status, "error"); assert.match(mails[0].body, /HTTP 401/);
  const keep = wProps.REPORT_TOKEN; delete wProps.REPORT_TOKEN; mails.length = 0; fetched.length = 0; r = run(`monthlyReport_(${OCT1})`);
  assert.equal(r.status, "error"); assert.match(mails[0].body, /設定.*足りません/); assert.equal(fetched.length, 0); wProps.REPORT_TOKEN = keep;
  await prep("2026-09"); r = run(`monthlyReport_(${OCT1})`); assert.equal(r.status, "sent"); assert.equal(mails[0].to, "makino@example.test,manager@example.test");
  ok("取得できない(通信エラー・HTTP 500・応答が JSON でない・トークン違い・設定漏れ)ときは、所有者だけに『月次レポートを作れませんでした』と直し方を送り、送った記録は残さない。直ったら同じ月の分を送れる");

  // 7) 同じ月の分は1回だけ(トリガーが2回動いても・同時に動いても)
  await prep("2026-09"); r = run(`monthlyReport_(${OCT1})`); assert.deepEqual(r, { status: "already_sent", month: "2026-09" }); assert.equal(mails.length, 0); assert.equal(fetched.length, 0);
  locked = true; delete wProps.REPORT_LAST_SENT; r = run(`monthlyReport_(${OCT1})`); assert.equal(r.status, "busy"); assert.equal(mails.length, 0); locked = false;
  delete wProps.REPORT_URL; assert.equal(wProps.BACKUP_URL, URL_);                                                            // 送り先の URL は省略時 BACKUP_URL(見張り役と同じ)
  ok("同じ月の分は1回だけ送る(送った月を記録。同時に動いたときはロックが取れた1回だけ)");

  // 8) トリガー・動作確認(所有者のみ)・実行ログにトークンを出さない
  logs.length = 0;
  vm.runInContext("installMonthlyReportTrigger()", w); vm.runInContext("installMonthlyReportTrigger()", w);
  const mt = triggers.filter((t) => t.fn === "monthlyReport"); assert.equal(mt.length, 1); assert.deepEqual([mt[0].day, mt[0].h, mt[0].tz], [1, 9, "Asia/Tokyo"]);
  who.email = "other@example.test";
  assert.throws(() => vm.runInContext("installMonthlyReportTrigger()", w), /権限がありません/); assert.throws(() => vm.runInContext("monthlyReportSelfTest()", w), /権限がありません/);
  who.email = "owner@example.test";
  await prep(run(`reportPreviousMonth_(${Date.now()})`)); delete wProps.REPORT_LAST_SENT;
  r = run("monthlyReportSelfTest()"); assert.equal(mails.length, 1); assert.equal(mails[0].to, "owner@example.test"); assert.match(mails[0].subj, /^【試験】10ZEN 月次レポート/);
  assert.equal(wProps.REPORT_LAST_SENT, undefined); assert.ok(["sent", "skipped"].includes(r.status));
  if (r.status === "skipped") assert.match(mails[0].body, /送りません/);
  await prep("2026-09"); assert.match(run("buildReportMail_(" + JSON.stringify(rep) + ", '')").body, /月次レポート 2026年9月/);
  run(`monthlyReport_(${OCT1})`); run("monthlyReport()");
  assert.ok(logs.some((x) => /月次レポートの結果/.test(x)) && logs.some((x) => /月次レポートの動作確認/.test(x)));
  assert.ok(!logs.join("\n").includes(tok)); assert.ok(!mails.some((x) => x.body.includes(tok) || x.subj.includes(tok)));
  ok("トリガーは所有者だけが設定でき、何度実行しても毎月1日 9時(日本時間)の1つだけ。動作確認 monthlyReportSelfTest(所有者のみ)は所有者だけに【試験】のメールを送り、送った記録は残さない。実行ログとメールにトークンを出さない");

  // 9) 見張り役と同じプロジェクトに置ける: 関数・変数の名前が重ならない。公開関数は3つだけ。会員データの書き出し・記録・状態の確認は呼ばない。表示名は会員証と同じ
  const names = (src) => [...src.matchAll(/^(?:function|var)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  const both = [...names(wsrc), ...names(msrc)]; assert.equal(both.length, new Set(both).size, "重複: " + both.filter((x, i) => both.indexOf(x) !== i));
  assert.deepEqual([...msrc.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]).filter((x) => !x.endsWith("_")).sort(), ["installMonthlyReportTrigger", "monthlyReport", "monthlyReportSelfTest"]);
  assert.ok(!/action:\s*"(export|record|status)"/.test(msrc)); assert.ok(!/CHECKIN_SECRET"\)/.test(msrc)); assert.ok(!/console\.log\([^)]*token/i.test(msrc));
  const TYPES = run("REPORT_TYPES_"); for (const [k, label] of TYPES) assert.equal(label, k === "balanced" ? BALANCED_NAME : `${ELEMENT_INFO[k].kanji} ${ELEMENT_INFO[k].typeName}`, k);
  assert.ok(!/REPORT_CONDITIONS_|今日の体調/.test(msrc));                                                                      // 今日の体調の表示はやめた(db/107)
  ok("見張り役(watchdog.gs)と同じプロジェクトに置ける: 関数・変数の名前が重ならない。公開関数は monthlyReport・installMonthlyReportTrigger・monthlyReportSelfTest の3つだけ。元の秘密を持たず、書き出し・記録・状態の確認は呼ばない。タイプの表示名は会員証(constitution.mjs)と同じ。今日の体調の表示はない");
  console.log(`\n${n} monthly report tests passed`);
} finally { pg.stop(); }
