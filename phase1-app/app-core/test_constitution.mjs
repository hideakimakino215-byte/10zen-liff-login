// 1分体質チェックの「アプリの核」の検証: 判定(constitution.mjs)・DB と同じ結果になること(多数の回答と日付)・説明文の言葉づかい・五角形の座標・
// 画面用データ(screens.mjs)・お客様クライアント → member-api(constitution_submit / referral_click)→ 実 PostgreSQL。本番には接続しない。
// 2026-10-15(db/107): 今日の体調(3問)をやめ、来店のたびに任意でチェック。あなたの体質(最新3回の平均)の決め方も DB と一致することを確かめる。
// 実行: node --experimental-strip-types test_constitution.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { startPg, q } from "../patches/pgdb.mjs";
import { rpcOver } from "../patches/pgrpc.mjs";
import { makeJwt, lineVerify } from "../patches/jwtstub.mjs";
import { handle as memberApi } from "../functions/member-api/handler.ts";
import { createMemberClient } from "./member-client.mjs";
import * as CC from "./constitution.mjs";
import * as CT from "./constitution-content.mjs";
import { radarGeometry, radarSvg } from "./radar.mjs";
import { NIHONDO_CONSULT_URL } from "./store-info.mjs";
import { cardScreen, memberView, constitutionCardView, constitutionResultView, checkSubmitScreen, profileView, historyView, ccPromptVisible, CC_SKIP_KEY } from "./screens.mjs";

const pg = startPg();
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const CH = "2011158053", SECRET = "k".repeat(64), UNIT = "10zen_aoyama", NOW = () => Date.now();
const deps = () => ({ fetchFn: lineVerify(NOW), supabase: rpcOver(pg), lineLoginChannelId: CH, qrSecret: SECRET, businessUnit: UNIT, allowedOrigins: [], nowMs: NOW });
const toApi = async (_url, init) => memberApi(new Request("https://x.test/member-api", { method: "POST", headers: init.headers, body: init.body }), deps());
const mkMember = (sub, name) => createMemberClient({ endpoint: "https://x.test/member-api", getIdToken: async () => makeJwt({ sub, name, nowMs: NOW() }), fetchFn: toApi, sleep: async () => {} });
const raw = async (sub, body) => { const r = await toApi("", { headers: { "content-type": "application/json", "x-liff-id-token": makeJwt({ sub, name: "x", nowMs: NOW() }) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const FORBIDDEN = /治る|治す|効く|効果的|改善/;
// 乱数(種を固定して毎回同じ)
let seed = 20261015; const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
const addDays = (d, k) => new Date(Date.parse(d + "T00:00:00Z") + k * 86400e3).toISOString().slice(0, 10);

try {
  // ---- 1. 判定(constitution.mjs) ----
  assert.equal(CC.QUESTIONS.length, 15); assert.deepEqual(CC.QUESTIONS.map((x) => x.no), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.deepEqual(CC.QUESTIONS.map((x) => x.element), ["wood", "wood", "wood", "fire", "fire", "fire", "earth", "earth", "earth", "metal", "metal", "metal", "water", "water", "water"]);
  assert.equal(CC.QUESTIONS[0].text, "イライラしたり、気分の浮き沈みが大きい"); assert.equal(CC.QUESTIONS[8].text, "考えすぎると食欲が落ちる・甘いものが欲しくなる");
  assert.equal(CC.QUESTIONS[14].text, "腰や膝がだるい・髪のハリが気になる");
  assert.deepEqual(CC.ANSWER_OPTIONS.map((o) => [o.label, o.value]), [["よくある", 2], ["ときどき", 1], ["あまりない", 0]]);
  assert.deepEqual(CC.ELEMENTS.map((e) => CC.ELEMENT_INFO[e].typeName), ["モヤモヤ渋滞タイプ", "カッカ熱こもりタイプ", "消化パワー不足タイプ", "うるおい不足タイプ", "ぽかぽかパワー不足タイプ"]);
  assert.deepEqual(CC.ELEMENTS.map((e) => CC.ELEMENT_INFO[e].kanji + CC.ELEMENT_INFO[e].organ), ["木肝", "火心", "土脾", "金肺", "水腎"]);
  assert.match(CC.ELEMENT_INFO.fire.state, /偏熱/); assert.match(CC.ELEMENT_INFO.metal.state, /燥.*津虚/); assert.match(CC.ELEMENT_INFO.earth.state, /脾虚/);
  for (const [d, e] of [["2026-01-16", "water"], ["2026-01-17", "earth"], ["2026-02-03", "earth"], ["2026-02-04", "water"], ["2026-03-01", "wood"], ["2026-04-17", "earth"], ["2026-05-05", "wood"],
                        ["2026-06-01", "fire"], ["2026-07-20", "earth"], ["2026-08-07", "fire"], ["2026-09-01", "metal"], ["2026-10-20", "earth"], ["2026-11-07", "metal"], ["2026-12-01", "water"]])
    assert.equal(CC.seasonElement(d), e, d);
  assert.equal(CC.jstDate(Date.parse("2026-10-19T14:59:59Z")), "2026-10-19"); assert.equal(CC.jstDate(Date.parse("2026-10-19T15:00:00Z")), "2026-10-20");
  assert.equal(CC.scoreAnswers([1, 2]), null); assert.equal(CC.scoreAnswers(Array(15).fill(3)), null); assert.equal(CC.scoreAnswers([..."000000000000000"]), null);
  assert.deepEqual(CC.evaluate([2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1], "2026-10-15"), { scores: { wood: 6, fire: 0, earth: 0, metal: 0, water: 3 }, primary: "wood", balanced: false, seasonElement: "metal" });
  assert.deepEqual(CC.evaluate(Array(15).fill(0), "2026-10-15"), { scores: { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 }, primary: "metal", balanced: true, seasonElement: "metal" });
  assert.equal(CC.pickElement({ wood: 3, fire: 3, earth: 0, metal: 0, water: 0 }, "metal"), "wood"); assert.equal(CC.pickElement({ wood: 3, fire: 3, earth: 0, metal: 0, water: 0 }, "fire"), "fire");
  // あなたの体質(最新3回の平均): 合計で比べ、同点は最新の回の季節。平均がすべて1点以下(ちょうど1点を含む)はバランス良好
  assert.deepEqual(CC.averageResult({ wood: 5, fire: 0, earth: 0, metal: 5, water: 0 }, 3, "metal"), { count: 3, scores: { wood: 1.67, fire: 0, earth: 0, metal: 1.67, water: 0 }, primary: "metal", balanced: false });
  assert.deepEqual(CC.averageResult({ wood: 3, fire: 0, earth: 0, metal: 0, water: 0 }, 3, "water"), { count: 3, scores: { wood: 1, fire: 0, earth: 0, metal: 0, water: 0 }, primary: "wood", balanced: true });
  assert.equal(CC.averageResult({ wood: 4, fire: 0, earth: 0, metal: 0, water: 0 }, 3, "water").scores.wood, 1.33);
  assert.equal(CC.averageResult({ wood: 1 }, 1, "wood"), null); assert.equal(CC.averageResult({ wood: 0, fire: 0, earth: 0, metal: 0, water: 0 }, 0, "wood"), null);
  const chk = (w, f, e, m, wa, se) => ({ scores: { wood: w, fire: f, earth: e, metal: m, water: wa }, seasonElement: se });
  assert.equal(CC.profileOf([]), null); assert.equal(CC.profileOf(null), null);
  assert.deepEqual(CC.profileOf([chk(0, 6, 0, 0, 0, "fire"), chk(0, 0, 0, 0, 0, "metal"), chk(6, 0, 0, 0, 0, "metal"), chk(0, 0, 0, 0, 6, "water")]),   // 4回目(いちばん古い)は入れない
    { count: 3, scores: { wood: 2, fire: 2, earth: 0, metal: 0, water: 0 }, primary: "fire", balanced: false });                                   // 木・火の同点 → 最新の回の季節(火)
  assert.equal(CC.profileOf([chk(0, 6, 0, 0, 0, "earth"), chk(6, 0, 0, 0, 0, "metal")]).primary, "wood");                                     // 季節(土)が同点にない → 木・火…の順
  assert.deepEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-25"].map(CC.teaOfDay), ["metal", "fire", "water", "wood", "metal", "earth", "metal", "earth"]);
  assert.deepEqual(CC.ELEMENTS.map(CC.teaWeekdayText), ["木曜日", "火曜日", "土曜日", "金曜日", "水曜日"]); assert.equal(CC.weekdayText("2026-10-15"), "木曜日");
  assert.equal(CC.seasonKey("2027-02-28"), "2026-winter"); assert.equal(CC.seasonKey("2026-12-01"), "2026-winter"); assert.equal(CC.seasonKey("2026-10-15"), "2026-autumn");
  ok("判定(constitution.mjs): 15問の文と順(1〜3=木 … 13〜15=水)・答え(よくある2/ときどき1/あまりない0)・5タイプと正式名称。合計・同点(季節→木火土金水の順)・バランス良好・季節と土用の境目・五巡茶の曜日。あなたの体質(最新3回の平均・同点は最新の回の季節・平均1点以下はバランス良好)");

  // ---- 2. DB と同じ結果(多数の回答と日付) ----
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql", "104_member_constitution_link.sql", "105_kpi.sql", "106_referral.sql",
                   "107_constitution_each_visit.sql"]) pg.loadFile(f);
  pg.exec(`update system_state set state='open'; update app_settings set value='false' where key='register_counts_as_visit';`);
  {
    const boundaries = ["01-16", "01-17", "02-03", "02-04", "02-28", "03-01", "04-16", "04-17", "05-04", "05-05", "05-31", "06-01", "07-19", "07-20", "08-06", "08-07", "08-31", "09-01", "10-19", "10-20", "11-06", "11-07", "11-30", "12-01", "12-31"];
    const cases = [];
    for (let i = 0; i < 600; i++) {
      // 同点が多く出るよう、半分は値の幅を狭くする
      const width = i % 2 ? 3 : 2, answers = Array.from({ length: 15 }, () => rnd(width));
      const date = i < boundaries.length * 4 ? `${2026 + (i % 3)}-${boundaries[i % boundaries.length]}` : addDays("2026-01-01", rnd(1100));
      cases.push({ answers, date });
    }
    const values = cases.map((c, i) => `(${i}, array[${c.answers.join(",")}]::integer[], ${q(c.date)}::date)`).join(",\n");
    const sqlRes = JSON.parse(pg.exec(`select json_agg(public._cc_result(a, d) order by i) from (values ${values}) v(i, a, d);`));
    let ties = 0, balanced = 0;
    cases.forEach((c, i) => {
      const js = CC.evaluate(c.answers, c.date); assert.deepEqual(sqlRes[i], js, JSON.stringify(c));
      const mx = Math.max(...Object.values(js.scores)); if (Object.values(js.scores).filter((x) => x === mx).length > 1) ties++; if (js.balanced) balanced++;
    });
    assert.ok(ties > 100 && balanced > 10, `ties=${ties} balanced=${balanced}`);
    // あなたの体質の平均(_cc_avg_result): 回数 1〜3 × いろいろな合計(同点が多く出るよう幅を狭くする)× 季節の五行
    const ac = [];
    for (let i = 0; i < 1500; i++) {
      const k = 1 + (i % 3), width = i % 2 ? k + 2 : 6 * k + 1;
      ac.push({ sums: Object.fromEntries(CC.ELEMENTS.map((e) => [e, rnd(width)])), n: k, season: CC.ELEMENTS[rnd(5)] });
    }
    const av = ac.map((c, i) => `(${i}, array[${CC.ELEMENTS.map((e) => c.sums[e]).join(",")}]::integer[], ${c.n}, ${q(c.season)})`).join(",\n");
    const ar = JSON.parse(pg.exec(`select json_agg(public._cc_avg_result(s, k, se) order by i) from (values ${av}) v(i, s, k, se);`));
    let aTies = 0, aBal = 0;
    ac.forEach((c, i) => {
      const js = CC.averageResult(c.sums, c.n, c.season); assert.deepEqual(ar[i], js, JSON.stringify(c));
      const mx = Math.max(...Object.values(c.sums)); if (Object.values(c.sums).filter((x) => x === mx).length > 1) aTies++; if (js.balanced) aBal++;
    });
    assert.ok(aTies > 200 && aBal > 50, `ties=${aTies} balanced=${aBal}`);
    // 会員ごとの結果の並び(1〜5回・同じ時刻を含む)→ _cc_profile と profileOf(新しい順)が同じ
    const mids = JSON.parse(pg.exec(`with x as (insert into members(member_no, display_name) select 'user' || lpad((90000 + g)::text, 5, '0'), 'p' || g from generate_series(1, 80) g returning id) select json_agg(id) from x;`));
    const rows = [], byMember = {};
    mids.forEach((id, mi) => {
      const k = 1 + rnd(5); byMember[id] = [];
      for (let t = 0; t < k; t++) {
        const answers = Array.from({ length: 15 }, () => rnd(mi % 2 ? 2 : 3)), date = addDays("2026-01-01", rnd(800)), at = `${date}T0${rnd(9)}:00:00Z`;
        const e = CC.evaluate(answers, CC.jstDate(Date.parse(at)));
        rows.push(`(${q(id)}::uuid, '{${answers.join(",")}}', 'soup', ${CC.ELEMENTS.map((el) => e.scores[el]).join(",")}, ${q(e.primary)}, ${e.balanced}, ${q(CC.seasonKey(CC.jstDate(Date.parse(at))))}, ${q(e.seasonElement)}, ${q(at)}::timestamptz)`);
        byMember[id].push({ ...e, at });
      }
    });
    pg.exec(`insert into constitution_checks(member_id, answers, mood, score_wood, score_fire, score_earth, score_metal, score_water, primary_element, balanced, season_key, season_element, created_at) values ${rows.join(",\n")};`);
    const inMids = `array[${mids.map((x) => q(x)).join(",")}]::uuid[]`;
    const prof = JSON.parse(pg.exec(`select json_object_agg(m, public._cc_profile(m)) from unnest(${inMids}) m;`));
    const order = JSON.parse(pg.exec(`select json_object_agg(member_id, ats) from (select member_id, json_agg(created_at order by created_at desc, id desc) ats from constitution_checks where member_id = any(${inMids}) group by member_id) z;`));
    let multi = 0;
    for (const id of mids) {
      const pool = [...byMember[id]];                                                                // DB の並び(新しい順・同じ時刻は id の順)に合わせる
      const ordered = order[id].map((at) => pool.splice(pool.findIndex((c) => Date.parse(c.at) === Date.parse(at)), 1)[0]);
      if (ordered.length > 3) multi++;
      const { latestOn, oldestOn, ...db } = prof[id]; const js = CC.profileOf(ordered);
      // 同じ時刻の回が平均の境目(3回目と4回目)にまたがると、どちらが入るかは id の順(JS では区別できない)。その会員は数だけ確かめる
      const tieAtCut = ordered.length > 3 && Date.parse(ordered[2].at) === Date.parse(ordered[3].at);
      if (tieAtCut) assert.equal(db.count, 3); else assert.deepEqual(db, js, id);
      assert.equal(latestOn, CC.jstDate(Date.parse(ordered[0].at)));
    }
    assert.ok(multi > 20, String(multi));
    pg.exec(`delete from constitution_checks where member_id = any(${inMids}); delete from members where id = any(${inMids});`);
    // 季節・五巡茶・季節の鍵は、3年分の毎日
    const days = Array.from({ length: 365 * 3 + 1 }, (_, i) => addDays("2026-01-01", i));
    const dv = days.map((d) => `(${q(d)}::date)`).join(",");
    const dr = JSON.parse(pg.exec(`select json_agg(json_build_array(public._season_element(d), public._tea_of_day(d), public._season_of(d) ->> 'key') order by d) from (values ${dv}) v(d);`));
    days.forEach((d, i) => assert.deepEqual(dr[i], [CC.seasonElement(d), CC.teaOfDay(d), CC.seasonKey(d)], d));
  }
  ok("DB と同じ結果: 600通りの回答×日付(季節・土用の境目を含む・同点とバランス良好を多数含む)で、点数・タイプ・バランス良好・季節の五行が DB(_cc_result)と一致。あなたの体質の平均 1500通り(_cc_avg_result。回数1〜3・同点・バランス良好を多数含む)と、80人分の結果の並び(_cc_profile。最新3回)も一致。2026〜2028年の毎日の季節・五巡茶・季節の鍵も一致");

  // ---- 3. 説明文(言葉づかい・承認済みの文・差し替えられるデータ) ----
  const strings = []; const walk = (v) => { if (typeof v === "string") strings.push(v); else if (typeof v === "function") { if (v.length <= 2) { try { walk(v("金曜日", "soup")); } catch (_e) {} } } else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(CT); walk(CC.QUESTIONS); walk(CC.ELEMENT_INFO); walk(CC.ANSWER_OPTIONS);
  for (const el of CC.ELEMENTS) for (const m of CT.MOODS) walk(CT.recommendDish(el, m.code));
  assert.ok(strings.length > 80, String(strings.length));
  for (const s of strings) assert.doesNotMatch(s, FORBIDDEN, s);
  // check.html・card.html: コメントを除いた本文(画面の文字・スクリプトの文字列)に禁止の言葉がない。HTML を文字列で入れない
  for (const f of ["check.html", "card.html"]) {
    const html = fs.readFileSync(new URL(`../app-reference/${f}`, import.meta.url), "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
    assert.doesNotMatch(html, FORBIDDEN, f); assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML/, f);
    if (f === "check.html") assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);
    assert.doesNotMatch(html, /今日の体調|ccCondition|ccSeasonPrompt|conditionSubmit/, f);                         // 今日の体調・季節の案内はやめた(db/107)
  }
  assert.doesNotMatch(fs.readFileSync(new URL("./constitution-content.mjs", import.meta.url), "utf8").replace(/\/\/.*$/gm, ""), FORBIDDEN);
  // 承認済みの文(2026-10-15)と、決まった文
  assert.equal(CT.TYPE_LINES.wood, "気持ちや巡りが滞りやすく、張りつめがちなタイプ。香りのよい食材で、のびのびと巡らせる食事を。");
  assert.equal(CT.TYPE_LINES.balanced, "今は大きな偏りが見られません。季節に合わせた食事で、この調子を保ちましょう。");
  assert.equal(CT.TEA_LINES.fire, "ラベンダーがほのかに香る、ほっとひと息つきたい日のお茶");
  assert.equal(CT.SEASON_LINES.earth, "季節の変わり目は、湿気で胃腸が疲れやすい時期。温かく、消化のよい食事を。");
  assert.ok(CT.TEA_LINES.water.includes(CT.WATER_TEA_NOTE)); assert.equal(CT.WATER_TEA_NOTE, "冷えが気になる方は温かいほうで");
  for (const el of [...CC.ELEMENTS, "balanced"]) assert.ok(CT.TYPE_LINES[el]); for (const el of CC.ELEMENTS) { assert.ok(CT.TEA_LINES[el]); assert.ok(CT.SEASON_LINES[el]); }
  assert.equal(CT.DISCLAIMER, "体質の傾向の目安で、医療的な診断ではありません"); assert.equal(CT.NIHONDO_LEAD, "もっと詳しく知りたい方は、薬日本堂の漢方相談へ");
  assert.equal(CT.SEASON_PROMPT, undefined); assert.equal(CT.CONDITION_INTRO, undefined); assert.equal(CC.CONDITION_QUESTIONS, undefined);   // 今日の体調・季節の案内はやめた
  assert.equal(CT.TODAY_CHECK_TITLE, "今日の1分体質チェック"); assert.equal(CT.TODAY_SKIP, "今日はスキップ"); assert.equal(CT.TODAY_LABEL, "今日の傾向"); assert.equal(CT.PROFILE_LABEL, "あなたの体質");
  assert.equal(CT.TEA_NAME, "五巡茶"); assert.equal(CT.CHECK_NAME, "1分体質チェック");
  assert.equal(CT.yourTeaDayText(CC.teaWeekdayText("metal")), "金曜日はあなたのお茶の日");
  assert.equal(NIHONDO_CONSULT_URL, "https://www.nihondo.co.jp/kampo/consultation/");
  // 食事の気分(仮)は DB の設定と同じコード。おすすめ表は 五行×気分 のすべてにある(仮の料理名)
  assert.deepEqual(CT.MOODS.map((m) => m.label), ["お粥", "スープ", "一人鍋", "麺", "みんなで鍋"]);
  assert.equal(CT.MOODS.map((m) => m.code).join(","), pg.exec(`select value from app_settings where key='constitution_moods';`));
  for (const el of CC.ELEMENTS) for (const m of CT.MOODS) { const r = CT.recommendDish(el, m.code); assert.match(r.dish, /^\(仮\)/); assert.ok(r.reason); }
  assert.equal(CT.recommendDish("water", "unknown").dish, CT.RECOMMENDATIONS.water.okayu); assert.equal(CT.recommendDish("x", "soup"), null);
  const src = fs.readFileSync(new URL("./constitution-content.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/文案\(牧野さん承認 2026-10-15・薬日本堂の表現チェック前\)/g) || []).length >= 3, true); assert.match(src, /仮: メニューが決まったら差し替える/);
  ok("説明文: お客様に見せる文(説明文のモジュール・質問・タイプ名・check.html・card.html)に「治る・効く・改善」などがない。承認済みの文・決まった文(診断ではない旨・薬日本堂・今日の1分体質チェック・今日はスキップ・今日の傾向・あなたの体質・五巡茶・お茶の日)のとおり。今日の体調と季節の案内の文はない。水の五巡茶の文に『温かいほうで』を含む。食事の気分は DB の設定と同じコードで、おすすめ表は全組み合わせに仮の料理名がある");

  // ---- 4. 五角形の座標 ----
  { const g = radarGeometry({ wood: 6, fire: 0, earth: 3, metal: null, water: 99 }, { max: 6, cx: 100, cy: 100, r: 50 });
    assert.deepEqual(g.axes.map((a) => a.element), CC.ELEMENTS); assert.deepEqual([g.axes[0].x, g.axes[0].y], [100, 50]);       // 木が上
    assert.deepEqual(g.dots.map((d) => [d.x, d.y]).slice(0, 2), [[100, 50], [100, 100]]);                                          // 6点=外周、0点=中心
    assert.deepEqual([g.dots[4].x, g.dots[4].y], [g.axes[4].x, g.axes[4].y]); assert.deepEqual([g.dots[3].x, g.dots[3].y], [100, 100]);   // 上限で止める・null は 0
    assert.equal(g.rings.length, 3); assert.equal(g.polygon.split(" ").length, 5); }
  ok("五角形の座標: 木を上に時計回り(火・土・金・水)。6点で外周・0点で中心。範囲外は上限で止め、未取得は 0");

  // ---- 4b. 五行の五色(グラフ・タイプの印)と五角形の色 ----
  { assert.deepEqual(CC.ELEMENT_COLORS, { wood: "#4f8a5b", fire: "#c2553f", earth: "#c39a2e", metal: "#8e99a6", water: "#2f3a56" });   // 牧野さんの依頼(2026-10-15)の色
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (h) => { const v = parseInt(h.slice(1), 16); return 0.2126 * lin(v >> 16) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255); };
    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    for (const e of CC.ELEMENTS) {
      for (const map of [CC.ELEMENT_COLORS, CC.ELEMENT_TEXT_COLORS, CC.ELEMENT_SOFT_COLORS]) assert.match(map[e], /^#[0-9a-f]{6}$/, e);
      // 文字の色: 白地・スタッフ画面の地・和紙色の地(体質チェック)・結果の詳細の強調の地・タイプの印の淡い地で 4.5:1 以上
      for (const bg of ["#ffffff", "#f3f5f8", "#f7f4ee", "#fffefb", "#f3ebdd", CC.ELEMENT_SOFT_COLORS[e]]) assert.ok(contrast(CC.ELEMENT_TEXT_COLORS[e], bg) >= 4.5, `${e} on ${bg}: ${contrast(CC.ELEMENT_TEXT_COLORS[e], bg).toFixed(2)}`);
    }
    assert.equal(new Set(Object.values(CC.ELEMENT_COLORS)).size, 5); assert.ok(!Object.values(CC.ELEMENT_COLORS).includes(CC.NEUTRAL_COLOR));
    // radarSvg: 色を渡すと点と軸の名前が五行の色(面は CSS のまま)。渡さなければ従来どおり。#rrggbb 以外の色は使わない
    const fake = { createElementNS: (ns, tag) => ({ ns, tag, attrs: {}, kids: [], textContent: "", setAttribute(k, v) { this.attrs[k] = v; }, append(...k) { this.kids.push(...k); } }) };
    const all = (n) => [n, ...n.kids.flatMap(all)];
    const labels = Object.fromEntries(CC.ELEMENTS.map((e) => [e, CC.ELEMENT_INFO[e].kanji]));
    const svg = radarSvg(fake, { wood: 1, fire: 2, earth: 3, metal: 4, water: 5 }, { labels, dotColors: CC.ELEMENT_COLORS, labelColors: { ...CC.ELEMENT_TEXT_COLORS, metal: "red;x:1" } });
    const nodes = all(svg); assert.ok(nodes.every((x) => x.ns === "http://www.w3.org/2000/svg"));
    const dots = nodes.filter((x) => x.attrs.class === "radar-dot"), texts = nodes.filter((x) => x.attrs.class === "radar-label");
    assert.deepEqual(dots.map((d) => d.attrs["data-element"]), CC.ELEMENTS); assert.deepEqual(texts.map((t) => t.textContent), ["木", "火", "土", "金", "水"]);
    for (const d of dots) assert.match(d.attrs.style, new RegExp(`^fill:${CC.ELEMENT_COLORS[d.attrs["data-element"]]};`));
    for (const t of texts) if (t.attrs["data-element"] !== "metal") assert.match(t.attrs.style, new RegExp(`^fill:${CC.ELEMENT_TEXT_COLORS[t.attrs["data-element"]]};`));
    assert.equal(texts.find((t) => t.attrs["data-element"] === "metal").attrs.style, undefined);                       // 形の違う色は無視
    assert.equal(nodes.find((x) => x.attrs.class === "radar-area").attrs.style, undefined);                               // 面は無彩色(CSS)
    const plain = all(radarSvg(fake, { wood: 1 }, { labels })); assert.ok(plain.every((x) => x.attrs.style === undefined));
    // 画面: スタッフ画面と体質チェックの結果は共通の色を使い、色の値を画面に直接書かない(棒・五角形・タイプの印)
    for (const f of ["../app-reference/staff.html", "../app-reference/check.html"]) {
      const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
      assert.match(src, /ELEMENT_COLORS/, f); assert.match(src, /ELEMENT_TEXT_COLORS/, f);
      for (const c of [...Object.values(CC.ELEMENT_COLORS), ...Object.values(CC.ELEMENT_TEXT_COLORS)]) assert.equal(src.toLowerCase().includes(c), false, `${f} ${c}`);
    } }
  ok("五行の五色: 木=緑・火=赤・土=黄土・金=銀灰・水=紺(白地で見えるよう調整)を constitution.mjs の1か所に置く。文字の色は白地・和紙色の地・タイプの印の地で 4.5:1 以上。五角形は点と軸の名前を五行の色にし、面は無彩色のまま。スタッフ画面と体質チェックは共通の色を使う");

  // ---- 5. 画面用データ ----
  { const base = { memberNo: "u", displayName: "x", rank: "white_opal", points: 0, yenPer100pt: 10, lifetimePoints: 0, lifetimeConfirmed: true, nextRank: null, expiresOn: null, redeemUnit: 100 };
    assert.equal(memberView(base).check, null);                                                         // 103 が未適用の応答
    const t = Date.parse("2026-10-16T03:00:00Z");                                                       // 金曜日
    const season = { key: "2026-autumn", element: "metal" };
    const none = constitutionCardView({ ...base, constitution: null, constitutionProfile: null, constitutionHistory: [], constitutionConsent: false, todayTea: "metal", yourTea: null, season, visitedToday: true }, t);
    assert.equal(none.done, false); assert.equal(none.entryLabel, "1分体質チェック"); assert.equal(none.entryHref, "check.html"); assert.equal(none.todayPrompt, false); assert.equal(none.result, null);   // 初めての方は入口だけ(来店しても案内は出さない)
    assert.equal(none.profile, null); assert.deepEqual(none.history, []);
    const c = { scores: { wood: 1, fire: 0, earth: 2, metal: 5, water: 4 }, primary: "metal", balanced: false, mood: "noodle", seasonKey: "2026-summer", seasonChanged: true, checkedOn: "2026-10-10", checkedToday: false };
    const pf = { count: 3, scores: { wood: 0.33, fire: 0, earth: 1.67, metal: 2, water: 3.33 }, primary: "water", balanced: false, latestOn: "2026-10-10", oldestOn: "2026-09-01" };
    const hist = [{ checkedOn: "2026-10-10", primary: "metal", balanced: false, scores: c.scores }, { checkedOn: "2026-09-20", primary: "water", balanced: false, scores: {} },
                  { checkedOn: "2026-09-01", primary: "water", balanced: true, scores: {} }, { checkedOn: "2026-08-01", primary: "nope", balanced: false }];
    const card = (over) => constitutionCardView({ ...base, constitution: c, constitutionProfile: pf, constitutionHistory: hist, constitutionConsent: true, todayTea: "metal", yourTea: "water", season, visitedToday: true, ...over }, t);
    const done = card({});
    assert.equal(done.entryLabel, "体質の結果と推移を見る"); assert.equal(done.entryHref, "check.html?view=result"); assert.equal(done.startHref, "check.html?start=1");
    assert.equal("seasonPrompt" in done, false); assert.equal("needsCondition" in done, false); assert.equal("condition" in done, false);   // 季節の案内・今日の体調はやめた
    assert.equal(done.todayPrompt, true); assert.equal(done.todayStr, "2026-10-16"); assert.equal(done.checkedToday, false); assert.equal(done.latestLabel, "前回の傾向(10/10)");
    assert.equal(done.result.typeName, "うるおい不足タイプ"); assert.equal(done.result.typeLine, CT.TYPE_LINES.metal);                 // 今日の傾向(最新の結果)
    assert.equal(done.result.dish.name, CT.RECOMMENDATIONS.metal.noodle); assert.equal(done.result.dish.element, "metal");              // おすすめは最新の結果から
    assert.equal(done.result.yourTea.name, "五巡茶(水)"); assert.equal(done.result.yourTea.dayText, "水曜日はあなたのお茶の日"); assert.equal(done.result.yourTea.isToday, false);   // あなたの五巡茶はあなたの体質から
    assert.equal(done.result.todayTea.weekday, "金曜日"); assert.equal(done.result.season.name, "秋"); assert.equal(done.result.formalText, "五行: 金 / 五臓: 肺 / 状態: 燥(そう)・津虚(しんきょ)");
    assert.deepEqual(done.result.details.filter((d) => d.isPrimary).map((d) => d.element), ["metal"]);
    assert.equal(done.profile.typeName, "ぽかぽかパワー不足タイプ"); assert.equal(done.profile.count, 3); assert.equal(done.profile.basisText, "最近3回のチェックの平均です"); assert.equal(done.profile.kanji, "水");
    assert.deepEqual(done.history.map((h) => [h.dateText, h.kanji, h.element, h.typeName]),
      [["10/10", "金", "metal", "うるおい不足タイプ"], ["9/20", "水", "water", "ぽかぽかパワー不足タイプ"], ["9/1", "バランス", null, "バランス良好"]]);   // 形の違う行は出さない
    // スキップ: 端末に覚えた日付が今日なら出さない(昨日の日付・覚えていないときは出す)
    assert.equal(CC_SKIP_KEY, "10zen_cc_skip");
    assert.equal(ccPromptVisible(done, null), true); assert.equal(ccPromptVisible(done, "2026-10-15"), true); assert.equal(ccPromptVisible(done, "2026-10-16"), false);
    const today = card({ constitution: { ...c, checkedOn: "2026-10-16", checkedToday: true } });
    assert.equal(today.todayPrompt, false); assert.equal(today.checkedToday, true); assert.equal(today.latestLabel, "今日の傾向"); assert.equal(ccPromptVisible(today, null), false);
    assert.equal(card({ visitedToday: false }).todayPrompt, false);                                        // 来店していない日は案内しない
    assert.equal(card({ constitutionProfile: null }).result.yourTea.name, "五巡茶(水)");                   // あなたの体質がない応答では yourTea(なければ結果の五行)
    assert.equal(card({ constitutionProfile: null, yourTea: null }).result.yourTea.name, "五巡茶(金)");
    assert.deepEqual([1, 2].map((k) => profileView({ ...pf, count: k }).basisText), ["1回分のチェックの結果です(来店のたびにチェックすると、最近3回の平均になります)", "2回分のチェックの平均です(3回分そろうと、最近3回の平均になります)"]);
    const bp = profileView({ ...pf, balanced: true }); assert.equal(bp.typeName, "バランス良好"); assert.equal(bp.typeLine, CT.TYPE_LINES.balanced); assert.equal(bp.element, null);
    assert.equal(profileView(null), null); assert.deepEqual(historyView(null), []); assert.equal(historyView(Array(9).fill(hist[0])).length, 6);
    const bal = constitutionResultView({ scores: { wood: 1, fire: 1, earth: 0, metal: 0, water: 1 }, primary: "water", balanced: true, mood: "soup" }, { todayTea: "water", seasonElement: "water", todayStr: "2026-12-02" });
    assert.equal(bal.typeName, "バランス良好"); assert.equal(bal.typeLine, CT.TYPE_LINES.balanced); assert.equal(bal.formalText, null); assert.equal(bal.details.some((d) => d.isPrimary), false);
    assert.equal(bal.yourTea.dayText, "水曜日はあなたのお茶の日"); assert.equal(bal.yourTea.line.split(CT.WATER_TEA_NOTE).length - 1, 1); }
  ok("画面用データ: 未実施は『1分体質チェック』の入口だけ。実施済みは『結果を見る』と、来店した日でまだ今日チェックしていなければ『今日の1分体質チェック』(?start=1)。スキップした日(端末に覚えた日付が今日)は出さない。今日の傾向(今日でなければ『前回の傾向(日付)』)・あなたの体質(回数に応じた説明)・これまでのチェック(日付と五行の印・6回まで)。おすすめの一品は最新の結果、あなたの五巡茶はあなたの体質から。季節の案内・今日の体調はない。103 未適用の応答では出さない");

  // ---- 6. お客様クライアント → member-api → DB ----
  { const SUB = "U" + "c".repeat(32), cli = mkMember(SUB, "体質 花子");
    assert.equal("conditionSubmit" in cli, false);                                                       // 今日の体調はクライアントからも外した
    assert.equal(checkSubmitScreen(await cli.constitutionSubmit({ answers: Array(15).fill(1), mood: "soup", consent: true }), NOW()).screen, "register");
    await cli.register(); assert.equal(cardScreen(await cli.me(), NOW()).view.check.done, false);           // 登録の応答は 100 のまま(会員証は続けて me を読む)
    const A = [2, 2, 1, 0, 0, 0, 0, 1, 0, 1, 2, 2, 0, 0, 1];                                           // 木5・火0・土1・金5・水1
    let s = checkSubmitScreen(await cli.constitutionSubmit({ answers: A, mood: "okayu" }), NOW());
    assert.equal(s.screen, "consent"); assert.equal(s.error, "はじめに、記録への同意をお願いします");
    assert.equal(Number(pg.exec(`select count(*) from constitution_checks;`)), 0);
    // 不正な形は member-api が 400 で止める(DB へ送らない)
    for (const body of [{ answers: A.slice(0, 14), mood: "okayu" }, { answers: [...A.slice(0, 14), 3], mood: "okayu" }, { answers: A.map(String), mood: "okayu" }, { answers: [...A.slice(0, 14), 1.5], mood: "okayu" },
                        { answers: A, mood: "Okayu" }, { answers: A, mood: 3 }, { answers: A, mood: "okayu", consent: "yes" }, { mood: "okayu" }])
      assert.equal((await raw(SUB, { action: "constitution_submit", ...body })).status, 400, JSON.stringify(body));
    { const r = await raw(SUB, { action: "constitution_submit", answers: A, mood: "ramen", consent: true }); assert.equal(r.status, 400); assert.equal(r.body.error, "invalid_mood"); }   // 設定にない気分は DB が拒否
    // 画面が点数やタイプを送っても使わない(回答から DB が計算する)。あなたの体質(profile)も DB が計算する
    const r = await raw(SUB, { action: "constitution_submit", answers: A, mood: "okayu", consent: true, scores: { wood: 0, fire: 6, earth: 0, metal: 0, water: 0 }, primary: "fire", balanced: true,
                               profile: { primary: "fire", count: 3 } });
    assert.equal(r.status, 200); assert.deepEqual(r.body.result.scores, { wood: 5, fire: 0, earth: 1, metal: 5, water: 1 });
    const expectPrimary = CC.evaluate(A, CC.jstDate(NOW())).primary; assert.equal(r.body.result.primary, expectPrimary); assert.equal(r.body.result.balanced, false);
    assert.equal(r.body.profile.count, 1); assert.equal(r.body.profile.primary, expectPrimary); assert.deepEqual(r.body.profile.scores, r.body.result.scores);
    assert.equal(pg.exec(`select score_fire || ':' || primary_element from constitution_checks;`), `0:${expectPrimary}`);
    assert.equal(JSON.stringify(r.body).includes(SUB), false); assert.equal(/member_?id|"id"/.test(JSON.stringify(r.body.result)), false);   // LINE の ID・内部 ID は返さない
    s = checkSubmitScreen(await cli.constitutionSubmit({ answers: Array(15).fill(0), mood: "nabe_share" }), NOW());     // 2回目は同意不要
    assert.equal(s.screen, "result"); assert.equal(s.view.result.typeName, "バランス良好"); assert.equal(s.view.consented, true);
    assert.equal(s.view.checkedToday, true); assert.equal(s.view.latestLabel, "今日の傾向"); assert.equal(s.view.profile.count, 2); assert.equal(s.view.history.length, 2);
    const avg = CC.profileOf([{ scores: { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 }, seasonElement: CC.seasonElement(CC.jstDate(NOW())) }, { scores: r.body.result.scores }]);
    assert.deepEqual(s.view.profile.scores, avg.scores); assert.equal(s.view.profile.primary, avg.primary);
    // 来店した日の案内: 前の日にチェックしていて、今日まだなら出す(今日チェックしたら出さない)
    const mid = `(select member_id from member_identities where subject=${q(SUB)})`;
    pg.exec(`update constitution_checks set created_at = created_at - interval '2 days' where member_id = ${mid};`);
    let card = cardScreen(await cli.me(), NOW()).view; assert.equal(card.check.todayPrompt, false);       // まだ来店していない(登録日を来店扱いにしない設定)
    pg.exec(`insert into visits(member_id, visit_on) select ${mid}, public._jst_date(now());`);
    card = cardScreen(await cli.me(), NOW()).view; assert.equal(card.check.todayPrompt, true); assert.equal(card.check.checkedToday, false);
    assert.equal(ccPromptVisible(card.check, card.check.todayStr), false);                                // 今日スキップした端末では出さない
    s = checkSubmitScreen(await cli.constitutionSubmit({ answers: [2, 2, 2, ...Array(12).fill(0)], mood: "soup" }), NOW());
    assert.equal(s.view.todayPrompt, false); assert.equal(s.view.checkedToday, true); assert.equal(s.view.profile.count, 3); assert.equal(s.view.history[0].checkedOn, CC.jstDate(NOW()));
    // 今日の体調(非推奨)の member-api の入口は、古い画面との互換のために残す
    assert.equal((await raw(SUB, { action: "condition_submit", temp: "cold", energy: "fine", concern: "none" })).status, 200);
    // 案内のクリック
    const rc = await cli.referralClick(); assert.equal(rc.kind, "ok"); assert.equal(rc.data.recorded, true);
    assert.equal(Number(pg.exec(`select count(*) from constitution_referral_clicks k join member_identities i on i.member_id=k.member_id where i.subject=${q(SUB)};`)), 1);
    assert.equal((await mkMember("U" + "f".repeat(32), "x").referralClick()).kind, "not_registered");
    // 凍結中
    pg.exec(`update system_state set state='frozen';`);
    assert.equal(checkSubmitScreen(await cli.constitutionSubmit({ answers: A, mood: "soup" }), NOW()).screen, "maintenance");
    pg.exec(`update system_state set state='open';`); }
  ok("クライアント → member-api → DB: 未登録は登録へ。初回の同意なしは『同意をお願いします』で記録なし。形の違う回答・気分・同意の値は 400(設定にない気分も 400)。画面が点数・タイプ・あなたの体質を送っても使わず、DB が計算する(応答に profile)。LINE の ID・内部 ID なし。来店した日で今日まだなら『今日の1分体質チェック』、チェックすると消えて今日の傾向・あなたの体質(回数が増える)・履歴に入る。今日の体調の入口は互換のためだけ。案内のクリックを記録。凍結中はメンテナンス");
  {
    // 全部が同点で高め(2026-10-16 案A): 表示だけ「全体的にゆらぎやすいタイプ」。おすすめと五巡茶は DB の五行(季節)のまま。色なし・正式名称なし
    const all6 = { wood: 6, fire: 6, earth: 6, metal: 6, water: 6 };
    assert.equal(CC.isAllHigh(all6), true); assert.equal(CC.isAllHigh({ ...all6, metal: 5 }), false);
    assert.equal(CC.isAllHigh({ wood: 3, fire: 3, earth: 3, metal: 3, water: 3 }), false);                    // 同点でも低めは五行(季節)のまま
    assert.equal(CC.isAllHigh({ wood: 4, fire: 4, earth: 4, metal: 4, water: 4 }), true);
    assert.equal(CC.isAllHigh({ wood: 4.33, fire: 4.33, earth: 4.33, metal: 4.33, water: 4.33 }), true); assert.equal(CC.isAllHigh(null), false);
    const r = constitutionResultView({ scores: all6, primary: "metal", balanced: false, mood: "porridge" }, { todayTea: "metal", seasonElement: "metal", todayStr: "2026-10-16" });
    assert.equal(r.typeName, CC.ALL_HIGH_NAME); assert.equal(r.typeLine, CT.TYPE_LINES.allHigh); assert.equal(r.allHigh, true); assert.equal(r.element, null);
    assert.equal(r.formalText, null); assert.ok(r.details.every((d) => !d.isPrimary)); assert.equal(r.yourTea.element, "metal");
    const pf = profileView({ count: 2, scores: all6, primary: "metal", balanced: false });
    assert.equal(pf.typeName, CC.ALL_HIGH_NAME); assert.equal(pf.element, null); assert.equal(pf.kanji, "全体");
    const h = historyView([{ checkedOn: "2026-10-16", primary: "metal", balanced: false, scores: all6 }])[0];
    assert.equal(h.kanji, "全体"); assert.equal(h.element, null); assert.equal(h.typeName, CC.ALL_HIGH_NAME);
    const one = constitutionResultView({ scores: { ...all6, wood: 5 }, primary: "fire", balanced: false, mood: "soup" }, {});
    assert.equal(one.allHigh, false); assert.equal(one.element, "fire"); assert.equal(one.typeName, CC.ELEMENT_INFO.fire.typeName);
    for (const w of ["治る", "効く", "改善"]) assert.ok(!CT.TYPE_LINES.allHigh.includes(w) && !CC.ALL_HIGH_NAME.includes(w));
    ok("全部が同点で高め(5つとも同じ・4点以上)は『全体的にゆらぎやすいタイプ』と表示(今日の傾向・あなたの体質・履歴)。色と正式名称は出さず、おすすめと五巡茶は季節の五行のまま。同点でも低め・1つでも違えば今までどおり");
  }
  console.log(`\n${n} constitution app tests passed`);
} finally { pg.stop(); }
