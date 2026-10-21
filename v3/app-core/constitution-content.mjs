// 1分体質チェックの、お客様に見せる説明文(差し替えはこのファイルだけで済む)。設計: CONSTITUTION_CHECK_DESIGN_20261015.md
// 言葉づかいのきまり(設計書 7章): 「治る・効く・改善」を使わない。「〜な方に」「〜したい日に」のような表現にする(五巡茶もメニューも食品のため)。
//   app-core/test_constitution.mjs が、このファイル・constitution.mjs・check.html に禁止の言葉がないことを確かめる。
// 区分: 「文案(牧野さん承認 2026-10-15・薬日本堂の表現チェック前)」= 承認済みの文。公開前に薬日本堂の表現チェックの部署を通す。
//       「仮」= まだ決まっていない文(おすすめの理由)。
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
// 文案(牧野さん承認 2026-10-21・メニュー名 v1.0・薬日本堂の表現チェック前)。コードは DB の app_settings 'constitution_moods' と同じにする(テストが確認)
export const MOOD_QUESTION = "今日の食事の気分は?";
export const MOODS = Object.freeze([
  { code: "okayu", label: "お粥" },
  { code: "soup", label: "スープ" },
  { code: "nabe_solo", label: "一人鍋" },
  { code: "noodle", label: "麺" },
  { code: "nabe_share", label: "鍋セット" }, // 青山本店のみ(展開店は4択の予定)
]);

// ---- 今日のおすすめの一品(五行 × 食事の気分) ----
// 文案(牧野さん承認 2026-10-21・メニュー名 v1.0・薬日本堂の表現チェック前)。五色湯: 木=麻辣湯(赤)、火=酸辣湯(緑)、土=スパイス湯(黄)、金=鶏白湯(白)、水=黒麻湯(黒)
export const RECOMMENDATIONS = Object.freeze({
  wood:  { okayu: "野菜粥", soup: "麻辣湯", nabe_solo: "麻辣湯 一人鍋", noodle: "麻辣湯麺", nabe_share: "陰陽鍋セット(麻辣湯と鶏白湯)" },
  fire:  { okayu: "海老とアスパラの粥", soup: "酸辣湯", nabe_solo: "酸辣湯 一人鍋(辛さ0から)", noodle: "酸辣湯麺", nabe_share: "陰陽鍋セット(酸辣湯と鶏白湯)" },
  earth: { okayu: "ホタテとナツメの粥", soup: "スパイス湯", nabe_solo: "スパイス湯 一人鍋", noodle: "スパイス湯麺", nabe_share: "陰陽鍋セット(スパイス湯と黒麻湯)" },
  metal: { okayu: "蒸し鶏と茗荷の粥", soup: "鶏白湯", nabe_solo: "鶏白湯 一人鍋", noodle: "鶏白湯麺", nabe_share: "陰陽鍋セット(鶏白湯とスパイス湯)" },
  water: { okayu: "海鮮粥", soup: "黒麻湯", nabe_solo: "黒麻湯 一人鍋", noodle: "黒麻湯麺", nabe_share: "陰陽鍋セット(黒麻湯と麻辣湯)" },
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

// 文案(牧野さん承認 2026-10-15・薬日本堂の表現チェック前): 同意の文。設計書 7章の「結果を会員証に記録し、おすすめとお店の改善に使います」は、言葉づかいのきまり(「改善」を使わない)に合わせて言い換えた。
// 2026-10-16 牧野さん決定(監査 L-3「スタッフに見せる」): 店舗のスタッフが結果を見ておすすめに使うことを書き足した。本番の前に同意した会員はいないので、同意の版(constitution_v1)は変えない
export const CONSENT_TEXT = "結果を会員証に記録します。店舗のスタッフが結果を見て、お茶やお料理のおすすめに使います。お店づくりにも役立てます。";
// 文案(確認前): 画面の案内
export const INTRO_TEXT = "15問とその日の食事の気分で、いまの体質の傾向がわかります(約1分)。";

// ---- 来店のたびのチェック(2026-10-15 牧野さんの決定。db/107) ----
// 決まった言葉(決定のとおり): 見出し・スキップのボタン・結果の2つの層の名前
export const TODAY_CHECK_TITLE = "今日の1分体質チェック";
export const TODAY_SKIP = "今日はスキップ";
export const TODAY_LABEL = "今日の傾向";
export const PROFILE_LABEL = "あなたの体質";
// 体質に合う五巡茶の見出し(2026-10-17 牧野さん「あなたの五巡茶(あなたの体質から)」→「あなたにおすすめの五巡茶」)。会員証の体質チェックと Web 版で同じ
export const YOUR_TEA_LABEL = "あなたにおすすめの五巡茶";
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

// ---- Web 版の体質チェック(web-check.html。ログインなし・何も保存しない。2026-10-16 牧野さん承認)。文案(薬日本堂の表現チェック前) ----
export const WEB_INTRO_TEXT = "15問で、いまの体質の傾向がわかります(約1分)。";
export const WEB_PRIVACY_NOTE = "回答はこの画面の中だけで使い、保存・送信しません。";
export const WEB_CTA_LEAD = "10ZEN の LINE 会員証に登録すると、体質チェックの結果を記録して、ご来店のたびに体質に合わせたお茶やお料理をご案内します。";
export const WEB_CTA_BUTTON = "LINE で会員証に登録する";

// ---- ペルソナ実験(2026-10-17)を受けた文言(文案・薬日本堂の表現チェック前) ----
// 偏りが小さい・全部が同じくらい高いときの、おすすめの選び方の説明
export const EVEN_PICK_NOTE = "大きな偏りがないため、おすすめのお料理とお茶は、今の季節と点数の高い項目から選んでいます。";
// 会員でない方がお席の QR などから体質チェックを開いたとき
export const CHECK_REGISTER_LEAD = "体質チェックは、10ZEN の LINE 会員証(無料)でご利用いただけます。登録すると、ディナーの五巡茶 飲み放題 無料のチケットもお届けします。";
export const CHECK_REGISTER_BUTTON = "会員登録して体質チェックへ";
// 途中でやめた体質チェックの続き
export const RESUME_BUTTON = (n) => `続きから(${n}問目)`;
