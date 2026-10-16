// 1分体質チェックの、お客様に見せる説明文(差し替えはこのファイルだけで済む)。設計: CONSTITUTION_CHECK_DESIGN_20261015.md
// 言葉づかいのきまり(設計書 7章): 「治る・効く・改善」を使わない。「〜な方に」「〜したい日に」のような表現にする(五巡茶もメニューも食品のため)。
//   app-core/test_constitution.mjs が、このファイル・constitution.mjs・check.html に禁止の言葉がないことを確かめる。
// 区分: 「文案(牧野さん承認 2026-10-15・薬日本堂の表現チェック前)」= 承認済みの文。公開前に薬日本堂の表現チェックの部署を通す。
//       「仮」= メニューが決まったら差し替える(食事の気分の選択肢・おすすめの一品)。
//       「文案(確認前)」= まだ承認されていない文。

// ---- タイプのひとこと ----
// 文案(牧野さん承認 2026-10-15・薬日本堂の表現チェック前)
export const TYPE_LINES = Object.freeze({
  wood: "気持ちや巡りが滞りやすく、張りつめがちなタイプ。香りのよい食材で、のびのびと巡らせる食事を。",
  fire: "からだに熱がこもりやすく、ほてりや寝つきが気になりやすいタイプ。熱を落ち着ける、みずみずしい食材がおすすめ。",
  earth: "胃腸が疲れやすく、湿気やむくみが気になりやすいタイプ。温かく、やさしい味つけで、おなかをいたわる食事を。",
  metal: "肌やのどが乾きやすく、季節の変わり目にゆらぎやすいタイプ。白い食材や、とろみのある料理でうるおいを意識して。",
  water: "冷えやすく、温める力が控えめなタイプ。黒い食材や温かい料理で、からだの芯から温まる食事を。",
  balanced: "今は大きな偏りが見られません。季節に合わせた食事で、この調子を保ちましょう。",
  allHigh: "どの項目にも当てはまりやすく、全体的にゆらぎやすいタイプ。まずは今の季節に合わせた食事で、ゆっくり整えていきましょう。",
});

// ---- 五巡茶(薬日本堂)のひとこと。表記は「五巡茶」で統一 ----
// 文案(牧野さん承認 2026-10-15・薬日本堂の表現チェック前)
//  水の五巡茶の文に「冷えが気になる方は温かいほうで」を含む(設計書 6章)。画面では別の注記を重ねて出さない(1回だけ)
export const TEA_LINES = Object.freeze({
  wood: "ローズやジャスミンが香る、気分を切り替えたい日のお茶",
  fire: "ラベンダーがほのかに香る、ほっとひと息つきたい日のお茶",
  earth: "はとむぎと柑橘皮の、季節の変わり目に飲みたいお茶",
  metal: "カリンやシソの、乾燥が気になる季節に飲みたいお茶",
  water: "よもぎや杜仲葉の、からだを温めたい日のお茶(冷えが気になる方は温かいほうで)",
});
export const TEA_NAME = "五巡茶";
export const WATER_TEA_NOTE = "冷えが気になる方は温かいほうで";   // TEA_LINES.water に含まれる(テストが確認)

// ---- 季節のひとこと(季節の五行ごと。土用=土) ----
// 文案(牧野さん承認 2026-10-15・薬日本堂の表現チェック前)
export const SEASON_NAMES = Object.freeze({ wood: "春", fire: "夏", earth: "土用", metal: "秋", water: "冬" });
export const SEASON_LINES = Object.freeze({
  wood: "芽吹きの春は、気持ちが高ぶりやすい季節。穀物や豆、甘みのある春野菜で、おなかを元気に。",
  fire: "熱がこもりやすい季節。夏野菜やほどよい苦味で、すっきりと。冷たいものの取りすぎに気をつけて。",
  earth: "季節の変わり目は、湿気で胃腸が疲れやすい時期。温かく、消化のよい食事を。",
  metal: "乾燥しやすい秋は、うるおいを意識して。梨やりんご、はちみつなど、酸味と甘みの組み合わせを。",
  water: "冷えやすい冬は、生姜やねぎなど温める食材と、黒い食材で、からだの芯から温かく。",
});

// ---- 16問目: 食事の気分(5択) ----
// 仮: メニューが決まったら差し替える(メニューの設計は別件)。コードは DB の app_settings 'constitution_moods' と同じにする(テストが確認)
export const MOOD_QUESTION = "今日の食事の気分は?";
export const MOODS = Object.freeze([
  { code: "okayu", label: "お粥" },          // 仮
  { code: "soup", label: "スープ" },         // 仮
  { code: "nabe_solo", label: "一人鍋" },    // 仮
  { code: "noodle", label: "麺" },           // 仮
  { code: "nabe_share", label: "みんなで鍋" }, // 仮
]);

// ---- 今日のおすすめの一品(五行 × 食事の気分) ----
// 仮: メニューが決まったら差し替える。料理名はすべて仮の名前
export const RECOMMENDATIONS = Object.freeze({
  wood:  { okayu: "(仮)春菊と鶏のお粥", soup: "(仮)陳皮香る野菜スープ", nabe_solo: "(仮)香味野菜の一人鍋", noodle: "(仮)ジャスミン香る汁麺", nabe_share: "(仮)香草たっぷりの薬膳鍋" },
  fire:  { okayu: "(仮)緑豆のお粥", soup: "(仮)冬瓜とトマトのスープ", nabe_solo: "(仮)ゴーヤと豆腐の一人鍋", noodle: "(仮)きゅうりと蒸し鶏の冷やし麺", nabe_share: "(仮)夏野菜の白湯鍋" },
  earth: { okayu: "(仮)はとむぎとかぼちゃのお粥", soup: "(仮)さつまいもと生姜のポタージュ", nabe_solo: "(仮)きのこと鶏の一人鍋", noodle: "(仮)やさしい味の鶏だし麺", nabe_share: "(仮)根菜たっぷりの薬膳鍋" },
  metal: { okayu: "(仮)白きくらげと百合根のお粥", soup: "(仮)梨と白きくらげのスープ", nabe_solo: "(仮)豆乳と白菜の一人鍋", noodle: "(仮)れんこんのとろみ麺", nabe_share: "(仮)白い食材の豆乳鍋" },
  water: { okayu: "(仮)黒米と黒豆のお粥", soup: "(仮)黒ごまと生姜のスープ", nabe_solo: "(仮)羊肉とねぎの一人鍋", noodle: "(仮)黒ごま担々麺", nabe_share: "(仮)クコの実と生姜の薬膳鍋" },
});
// おすすめの理由(五行ごと)。仮
export const DISH_REASONS = Object.freeze({
  wood: "香りのよい食材で、のびのびと過ごしたい方に",
  fire: "みずみずしい食材で、すっきり過ごしたい方に",
  earth: "温かく、やさしい味で、おなかをいたわりたい方に",
  metal: "とろみと白い食材で、うるおいを意識したい方に",
  water: "温かい料理で、からだの芯から温まりたい方に",
});
export function recommendDish(element, mood) {
  const row = RECOMMENDATIONS[element]; if (!row) return null;
  const dish = row[mood] ?? row[MOODS[0].code];
  return { dish, reason: DISH_REASONS[element] };
}

// ---- 決まった文(設計書のとおり) ----
export const CHECK_NAME = "1分体質チェック";
export const DISCLAIMER = "体質の傾向の目安で、医療的な診断ではありません";
export const NIHONDO_LEAD = "もっと詳しく知りたい方は、薬日本堂の漢方相談へ";
export const NIHONDO_BUTTON = "薬日本堂の漢方相談へ";
export const yourTeaDayText = (weekday) => `${weekday}はあなたのお茶の日`;

// 文案(牧野さん承認 2026-10-15・薬日本堂の表現チェック前): 同意の文。設計書 7章の「結果を会員証に記録し、おすすめとお店の改善に使います」は、言葉づかいのきまり(「改善」を使わない)に合わせて言い換えた
export const CONSENT_TEXT = "結果を会員証に記録し、おすすめとお店づくりに役立てます。";
// 文案(確認前): 画面の案内
export const INTRO_TEXT = "15問とその日の食事の気分で、いまの体質の傾向がわかります(約1分)。";

// ---- 来店のたびのチェック(2026-10-15 牧野さんの決定。db/107) ----
// 決まった言葉(決定のとおり): 見出し・スキップのボタン・結果の2つの層の名前
export const TODAY_CHECK_TITLE = "今日の1分体質チェック";
export const TODAY_SKIP = "今日はスキップ";
export const TODAY_LABEL = "今日の傾向";
export const PROFILE_LABEL = "あなたの体質";
// 文案(確認前): 会員証の案内・ボタン・結果の説明
export const TODAY_CHECK_TEXT = "来店のたびにチェックすると、最近3回の平均で「あなたの体質」がわかります(任意・約1分)。";
export const TODAY_START = "今日のチェックをはじめる";
export const HISTORY_LABEL = "これまでのチェック";
export const latestLabel = (dateText) => `前回の傾向(${dateText})`;
export function profileBasisText(count) {
  if (count >= 3) return "最近3回のチェックの平均です";
  if (count === 2) return "2回分のチェックの平均です(3回分そろうと、最近3回の平均になります)";
  return "1回分のチェックの結果です(来店のたびにチェックすると、最近3回の平均になります)";
}
