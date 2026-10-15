// 1分体質チェックの「アプリの核」の検証: 判定(constitution.mjs)・DB と同じ結果になること(多数の回答と日付)・説明文の言葉づかい・五角形の座標・
// 画面用データ(screens.mjs)・お客様クライアント → member-api(constitution_submit / condition_submit / referral_click)→ 実 PostgreSQL。本番には接続しない。
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
import { cardScreen, memberView, constitutionCardView, constitutionResultView, checkSubmitScreen, conditionScreen } from "./screens.mjs";

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
  assert.equal(CC.conditionFocus({ wood: 3, fire: 1, earth: 2, metal: 2, water: 2 }, { temp: "cold", energy: "fine", concern: "none" }, "2026-10-15"), "water");
  assert.deepEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-25"].map(CC.teaOfDay), ["metal", "fire", "water", "wood", "metal", "earth", "metal", "earth"]);
  assert.deepEqual(CC.ELEMENTS.map(CC.teaWeekdayText), ["木曜日", "火曜日", "土曜日", "金曜日", "水曜日"]); assert.equal(CC.weekdayText("2026-10-15"), "木曜日");
  assert.equal(CC.seasonKey("2027-02-28"), "2026-winter"); assert.equal(CC.seasonKey("2026-12-01"), "2026-winter"); assert.equal(CC.seasonKey("2026-10-15"), "2026-autumn");
  ok("判定(constitution.mjs): 15問の文と順(1〜3=木 … 13〜15=水)・答え(よくある2/ときどき1/あまりない0)・5タイプと正式名称。合計・同点(季節→木火土金水の順)・バランス良好・季節と土用の境目・今日の体調の足し算・五巡茶の曜日");

  // ---- 2. DB と同じ結果(多数の回答と日付) ----
  pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  for (const f of ["100_phase1_schema.sql", "101_search_path_fix.sql", "102_rank_perks.sql", "103_constitution_check.sql"]) pg.loadFile(f);
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
    // 今日の体調の足し算(全27通り × いろいろな点数・日付)
    const opts = CC.CONDITION_QUESTIONS.map((x) => x.options.map((o) => o.value)), fc = [];
    for (let i = 0; i < 540; i++) {
      const s = { wood: rnd(7), fire: rnd(7), earth: rnd(7), metal: rnd(7), water: rnd(7) };
      fc.push({ s, ch: { temp: opts[0][i % 3], energy: opts[1][Math.floor(i / 3) % 3], concern: opts[2][Math.floor(i / 9) % 3] }, date: addDays("2026-01-01", rnd(1100)) });
    }
    const fv = fc.map((c, i) => `(${i}, array[${CC.ELEMENTS.map((e) => c.s[e]).join(",")}]::integer[], ${q(c.ch.temp)}, ${q(c.ch.energy)}, ${q(c.ch.concern)}, ${q(c.date)}::date)`).join(",\n");
    const fs2 = JSON.parse(pg.exec(`select json_agg(public._cc_focus(s, t, e, c, d) order by i) from (values ${fv}) v(i, s, t, e, c, d);`));
    fc.forEach((c, i) => assert.equal(fs2[i], CC.conditionFocus(c.s, c.ch, c.date), JSON.stringify(c)));
    // 季節・五巡茶・季節の鍵は、3年分の毎日
    const days = Array.from({ length: 365 * 3 + 1 }, (_, i) => addDays("2026-01-01", i));
    const dv = days.map((d) => `(${q(d)}::date)`).join(",");
    const dr = JSON.parse(pg.exec(`select json_agg(json_build_array(public._season_element(d), public._tea_of_day(d), public._season_of(d) ->> 'key') order by d) from (values ${dv}) v(d);`));
    days.forEach((d, i) => assert.deepEqual(dr[i], [CC.seasonElement(d), CC.teaOfDay(d), CC.seasonKey(d)], d));
  }
  ok("DB と同じ結果: 600通りの回答×日付(季節・土用の境目を含む・同点とバランス良好を多数含む)で、点数・タイプ・バランス良好・季節の五行が DB(_cc_result)と一致。今日の体調の足し算 540通り(_cc_focus)、2026〜2028年の毎日の季節・五巡茶・季節の鍵も一致");

  // ---- 3. 説明文(言葉づかい・承認済みの文・差し替えられるデータ) ----
  const strings = []; const walk = (v) => { if (typeof v === "string") strings.push(v); else if (typeof v === "function") { if (v.length <= 2) { try { walk(v("金曜日", "soup")); } catch (_e) {} } } else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(CT); walk(CC.QUESTIONS); walk(CC.ELEMENT_INFO); walk(CC.CONDITION_QUESTIONS); walk(CC.ANSWER_OPTIONS);
  for (const el of CC.ELEMENTS) for (const m of CT.MOODS) walk(CT.recommendDish(el, m.code));
  assert.ok(strings.length > 80, String(strings.length));
  for (const s of strings) assert.doesNotMatch(s, FORBIDDEN, s);
  // check.html: コメントを除いた本文(画面の文字・スクリプトの文字列)に禁止の言葉がない
  const html = fs.readFileSync(new URL("../app-reference/check.html", import.meta.url), "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  assert.doesNotMatch(html, FORBIDDEN); assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|https?:\/\/(?!www\.w3\.org)/);
  assert.doesNotMatch(fs.readFileSync(new URL("./constitution-content.mjs", import.meta.url), "utf8").replace(/\/\/.*$/gm, ""), FORBIDDEN);
  // 承認済みの文(2026-10-15)と、決まった文
  assert.equal(CT.TYPE_LINES.wood, "気持ちや巡りが滞りやすく、張りつめがちなタイプ。香りのよい食材で、のびのびと巡らせる食事を。");
  assert.equal(CT.TYPE_LINES.balanced, "今は大きな偏りが見られません。季節に合わせた食事で、この調子を保ちましょう。");
  assert.equal(CT.TEA_LINES.fire, "ラベンダーがほのかに香る、ほっとひと息つきたい日のお茶");
  assert.equal(CT.SEASON_LINES.earth, "季節の変わり目は、湿気で胃腸が疲れやすい時期。温かく、消化のよい食事を。");
  assert.ok(CT.TEA_LINES.water.includes(CT.WATER_TEA_NOTE)); assert.equal(CT.WATER_TEA_NOTE, "冷えが気になる方は温かいほうで");
  for (const el of [...CC.ELEMENTS, "balanced"]) assert.ok(CT.TYPE_LINES[el]); for (const el of CC.ELEMENTS) { assert.ok(CT.TEA_LINES[el]); assert.ok(CT.SEASON_LINES[el]); }
  assert.equal(CT.DISCLAIMER, "体質の傾向の目安で、医療的な診断ではありません"); assert.equal(CT.NIHONDO_LEAD, "もっと詳しく知りたい方は、薬日本堂の漢方相談へ");
  assert.equal(CT.SEASON_PROMPT, "季節が変わりました。体質チェックをもう一度"); assert.equal(CT.TEA_NAME, "五巡茶"); assert.equal(CT.CHECK_NAME, "1分体質チェック");
  assert.equal(CT.yourTeaDayText(CC.teaWeekdayText("metal")), "金曜日はあなたのお茶の日");
  assert.equal(NIHONDO_CONSULT_URL, "https://www.nihondo.co.jp/");
  // 食事の気分(仮)は DB の設定と同じコード。おすすめ表は 五行×気分 のすべてにある(仮の料理名)
  assert.deepEqual(CT.MOODS.map((m) => m.label), ["お粥", "スープ", "一人鍋", "麺", "みんなで鍋"]);
  assert.equal(CT.MOODS.map((m) => m.code).join(","), pg.exec(`select value from app_settings where key='constitution_moods';`));
  for (const el of CC.ELEMENTS) for (const m of CT.MOODS) { const r = CT.recommendDish(el, m.code); assert.match(r.dish, /^\(仮\)/); assert.ok(r.reason); }
  assert.equal(CT.recommendDish("water", "unknown").dish, CT.RECOMMENDATIONS.water.okayu); assert.equal(CT.recommendDish("x", "soup"), null);
  const src = fs.readFileSync(new URL("./constitution-content.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/文案\(牧野さん承認 2026-10-15・薬日本堂の表現チェック前\)/g) || []).length >= 3, true); assert.match(src, /仮: メニューが決まったら差し替える/);
  ok("説明文: お客様に見せる文(説明文のモジュール・質問・タイプ名・体調の選択肢・check.html)に「治る・効く・改善」などがない。承認済みの文・決まった文(診断ではない旨・薬日本堂・季節の案内・五巡茶・お茶の日)のとおり。水の五巡茶の文に『温かいほうで』を含む。食事の気分は DB の設定と同じコードで、おすすめ表は全組み合わせに仮の料理名がある");

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
    const none = constitutionCardView({ ...base, constitution: null, constitutionConsent: false, todayCondition: null, todayTea: "metal", yourTea: null, season: { key: "2026-autumn", element: "metal" }, visitedToday: true }, t);
    assert.equal(none.done, false); assert.equal(none.entryLabel, "1分体質チェック"); assert.equal(none.entryHref, "check.html"); assert.equal(none.needsCondition, false); assert.equal(none.result, null);
    const c = { scores: { wood: 1, fire: 0, earth: 2, metal: 5, water: 4 }, primary: "metal", balanced: false, mood: "noodle", seasonKey: "2026-summer", seasonChanged: true, checkedOn: "2026-08-01" };
    const done = constitutionCardView({ ...base, constitution: c, constitutionConsent: true, todayCondition: null, todayTea: "metal", yourTea: "metal", season: { key: "2026-autumn", element: "metal" }, visitedToday: true }, t);
    assert.equal(done.entryLabel, "結果を見る"); assert.equal(done.entryHref, "check.html?view=result"); assert.equal(done.seasonPrompt, "季節が変わりました。体質チェックをもう一度");
    assert.equal(done.needsCondition, true); assert.equal(done.result.typeName, "うるおい不足タイプ"); assert.equal(done.result.typeLine, CT.TYPE_LINES.metal);
    assert.equal(done.result.yourTea.dayText, "金曜日はあなたのお茶の日"); assert.equal(done.result.yourTea.isToday, true); assert.equal(done.result.yourTea.name, "五巡茶(金)");
    assert.equal(done.result.todayTea.weekday, "金曜日"); assert.equal(done.result.dish.name, CT.RECOMMENDATIONS.metal.noodle); assert.equal(done.result.dish.basis, "type");
    assert.equal(done.result.season.name, "秋"); assert.equal(done.result.formalText, "五行: 金 / 五臓: 肺 / 状態: 燥(そう)・津虚(しんきょ)");
    assert.deepEqual(done.result.details.filter((d) => d.isPrimary).map((d) => d.element), ["metal"]);
    const after = constitutionCardView({ ...base, constitution: { ...c, seasonChanged: false }, constitutionConsent: true, todayCondition: { temp: "cold", energy: "fine", concern: "none", focus: "water" },
      todayTea: "metal", yourTea: "metal", season: { key: "2026-autumn", element: "metal" }, visitedToday: true }, t);
    assert.equal(after.needsCondition, false); assert.equal(after.seasonPrompt, null); assert.equal(after.result.dish.name, CT.RECOMMENDATIONS.water.noodle); assert.equal(after.result.dish.basis, "today");
    assert.equal(after.condition.focusText, "今日のおすすめの五行: 水");
    const notToday = constitutionCardView({ ...base, constitution: c, constitutionConsent: true, todayCondition: null, todayTea: "metal", yourTea: "metal", season: { key: "2026-autumn", element: "metal" }, visitedToday: false }, t);
    assert.equal(notToday.needsCondition, false);                                                       // 来店していない日は今日の体調を出さない
    const bal = constitutionResultView({ scores: { wood: 1, fire: 1, earth: 0, metal: 0, water: 1 }, primary: "water", balanced: true, mood: "soup" }, { todayTea: "water", seasonElement: "water", todayStr: "2026-12-02" });
    assert.equal(bal.typeName, "バランス良好"); assert.equal(bal.typeLine, CT.TYPE_LINES.balanced); assert.equal(bal.formalText, null); assert.equal(bal.details.some((d) => d.isPrimary), false);
    assert.equal(bal.yourTea.dayText, "水曜日はあなたのお茶の日"); assert.equal(bal.yourTea.line.split(CT.WATER_TEA_NOTE).length - 1, 1); }
  ok("画面用データ: 未実施は『1分体質チェック』、実施済みは『結果を見る』。季節が変わったら案内。来店した日で未回答なら今日の体調を出す。結果はタイプ名・ひとこと・正式名称・あなたの五巡茶と曜日(『金曜日はあなたのお茶の日』)・今日の五巡茶・季節・おすすめの一品(今日の体調があればその五行で)。バランス良好は正式名称なし。103 未適用の応答では出さない");

  // ---- 6. お客様クライアント → member-api → DB ----
  { const SUB = "U" + "c".repeat(32), cli = mkMember(SUB, "体質 花子");
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
    // 画面が点数やタイプを送っても使わない(回答から DB が計算する)
    const r = await raw(SUB, { action: "constitution_submit", answers: A, mood: "okayu", consent: true, scores: { wood: 0, fire: 6, earth: 0, metal: 0, water: 0 }, primary: "fire", balanced: true });
    assert.equal(r.status, 200); assert.deepEqual(r.body.result.scores, { wood: 5, fire: 0, earth: 1, metal: 5, water: 1 });
    const expectPrimary = CC.evaluate(A, CC.jstDate(NOW())).primary; assert.equal(r.body.result.primary, expectPrimary); assert.equal(r.body.result.balanced, false);
    assert.equal(pg.exec(`select score_fire || ':' || primary_element from constitution_checks;`), `0:${expectPrimary}`);
    assert.equal(JSON.stringify(r.body).includes(SUB), false); assert.equal(/member_?id|"id"/.test(JSON.stringify(r.body.result)), false);   // LINE の ID・内部 ID は返さない
    s = checkSubmitScreen(await cli.constitutionSubmit({ answers: Array(15).fill(0), mood: "nabe_share" }), NOW());     // 2回目は同意不要
    assert.equal(s.screen, "result"); assert.equal(s.view.result.typeName, "バランス良好"); assert.equal(s.view.consented, true);
    // 今日の体調: 来店した日だけ出す(会員証の表示)→ 3つ選んで送る → 今日のおすすめ
    let card = cardScreen(await cli.me(), NOW()).view; assert.equal(card.check.needsCondition, false);       // まだ来店していない(登録日を来店扱いにしない設定)
    pg.exec(`insert into visits(member_id, visit_on) select member_id, public._jst_date(now()) from member_identities where subject=${q(SUB)};`);
    card = cardScreen(await cli.me(), NOW()).view; assert.equal(card.check.needsCondition, true);
    for (const body of [{ temp: "cold", energy: "fine" }, { temp: "cold", energy: "fine", concern: "x" }, { temp: 1, energy: "fine", concern: "none" }])
      assert.equal((await raw(SUB, { action: "condition_submit", ...body })).status, 400);
    let cs = conditionScreen(await cli.conditionSubmit({ temp: "hot", energy: "stress", concern: "dry" }), NOW());
    assert.equal(cs.screen, "card"); assert.equal(cs.notice, undefined);
    const focus = CC.conditionFocus({ wood: 0, fire: 0, earth: 0, metal: 0, water: 0 }, { temp: "hot", energy: "stress", concern: "dry" }, CC.jstDate(NOW()));
    assert.equal(cs.view.check.condition.focus, focus); assert.equal(cs.view.check.needsCondition, false); assert.equal(cs.view.check.result.dish.basis, "today");
    cs = conditionScreen(await cli.conditionSubmit({ temp: "cold", energy: "fine", concern: "none" }), NOW());
    assert.equal(cs.notice, "今日の体調は回答済みです"); assert.equal(cs.view.check.condition.focus, focus);
    { const o = mkMember("U" + "d".repeat(32), "未実施"); await o.register(); const x = conditionScreen(await o.conditionSubmit({ temp: "cold", energy: "fine", concern: "none" }), NOW()); assert.equal(x.notice, "先に体質チェックをしてください"); }
    // 案内のクリック
    const rc = await cli.referralClick(); assert.equal(rc.kind, "ok"); assert.equal(rc.data.recorded, true);
    assert.equal(Number(pg.exec(`select count(*) from constitution_referral_clicks k join member_identities i on i.member_id=k.member_id where i.subject=${q(SUB)};`)), 1);
    assert.equal((await mkMember("U" + "f".repeat(32), "x").referralClick()).kind, "not_registered");
    // 凍結中
    pg.exec(`update system_state set state='frozen';`);
    assert.equal(checkSubmitScreen(await cli.constitutionSubmit({ answers: A, mood: "soup" }), NOW()).screen, "maintenance");
    assert.equal(conditionScreen(await cli.conditionSubmit({ temp: "cold", energy: "fine", concern: "none" }), NOW()).screen, "maintenance");
    pg.exec(`update system_state set state='open';`); }
  ok("クライアント → member-api → DB: 未登録は登録へ。初回の同意なしは『同意をお願いします』で記録なし。形の違う回答・気分・同意の値は 400(設定にない気分も 400)。画面が点数・タイプを送っても使わず、回答から DB が計算する。応答に LINE の ID・内部 ID なし。今日の体調は来店した日だけ出て、1日1回(2回目は『回答済み』)。案内のクリックを記録。凍結中はメンテナンス");
  console.log(`\n${n} constitution app tests passed`);
} finally { pg.stop(); }
