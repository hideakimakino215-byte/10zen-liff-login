# 友だち紹介と月次レポートの設計(2026-10-15)

- **決定者:** 牧野さん(10ZEN 青山店 事業責任者)。2026-10-15 に決定。
- **状態:** **実装とローカルの自動テストまで(2026-10-15)。本番には未適用**(DB の適用・関数の公開・GAS の設定・メールの送信はしていない)。本番の反映は、別途承認を得てから「A-5」「B-5」の手順で行う。
- **公開リポジトリのため、実際の会員・売上・客数の数字はここに書かない。** テストのデータはすべて作り物(擬似データ)。

---

## A. 友だち紹介

### A-1. 決定(牧野さん 2026-10-15)

1. **招待:** 会員証に「友だちを招待」。会員ごとに推測できない招待コードを持つ(**リンクに会員番号は出さない**)。LINE アプリの中では `liff.shareTargetPicker`(使えるとき)で LINE のメッセージとして招待のリンクを送る。使えないときは LINE の「送る」画面(`https://line.me/R/share?text=…`)と、リンクのコピー。
   リンク = LIFF の URL に `?ref=<招待コード>`。LIFF が最初に `?liff.state=…` の形で渡す場合も受け付ける。会員でない人が開いて登録すると、紹介者が自動で記録される(友だちは何も入力しない)。
2. **特典は友だちの「初来店」のときだけ**(登録のときではない)。友だちと紹介者の両方にチケット「ディナーのお茶サービス」(発行から60日。102 のチケットとコードの使い方を使う)。
   **紹介者のランクがそのとき AMBER 以上なら、紹介者にはチケットの代わりに 100pt**(AMBER 以上はディナーの五巡茶がもともと無料のため)。
   チケットの名前は設定 `dinner_tea_mode` で変わる: `cup`(運営変更の前・既定)=「ディナーの五巡茶 1杯」/ `free_flow`(運営変更の後)=「ディナーの五巡茶 飲み放題」。店長が後から切り替えられる(スタッフ画面の店長の欄)。
3. **上限:** 紹介者1人あたり、日本時間の暦月で **5人まで**(登録の時点で数える)。6人目は通常どおり登録できる(通常の登録ボーナス 100pt)が、紹介としては記録されず、紹介の特典もない。会員証に「今月の招待 n/5人」。
4. 友だちの登録ボーナスは通常の 100pt のまま(増やさない)。**旧ルール(登録のときに紹介者・友だちの両方に +100pt)は廃止。** 新しい登録では `referral_referrer` / `referral_welcome` を付けない。過去の台帳はそのまま。
5. **お知らせ:** LINE のプッシュはしない。紹介者が次に会員証を開いたとき1回だけ「お友だちが来店しました。チケットが届いています」(AMBER 以上は「お友だちが来店しました。100ptを付けました」)。見たかどうかはサーバーに記録する。
6. **集計:** 「紹介からの新規来店数」(紹介された会員のうち、初来店がその月の人数)を `staff_kpi_overview` の補助の数字と、会員来店率のカードの補助の行に出す。スタッフ画面の集計タブにも出す。あわせて、その月に紹介から登録した人数も出す。
7. **不正の防止:** 自分自身の紹介はできない。紹介者は有効な会員で、試験/本番の区分(`is_test`)が同じであること(既存のコードと同じ)。特典は友だち1人につき1回だけ。

### A-2. 決め方の細部(依頼の文で決まっていなかった点と、その決め方)

- **「初来店」の決め方:** 店頭QR(Edge Function が QR を検証したもの)での来店記録(`app_checkin`)の最初の1回。
  - 登録した日の「来店扱い」(`register_counts_as_visit`=true のときに登録で入る `visits.source='register'` の行)だけでは初来店にしない。家で登録しても来店にならないため。
  - ただし、登録した日に店頭QRを読んだ場合(「本日はご登録ボーナスを付与済み」になる場合)は、QR で店にいたことが確かめられるので、その日を初来店とする(友だちと一緒に来店してその場で登録した場合に、特典が翌日以降にずれないように)。
  - 本番の設定は `register_counts_as_visit=false`(2026-10-10 の決定)なので、通常は登録の後の最初の店頭QRがそのまま初来店になる。
- **AMBER 以上の判定:** 友だちの初来店の時点の紹介者のランク(登録の時点ではない)。紹介者が登録の後に AMBER に上がっていれば 100pt。100pt はルール `referral_visit`(point_rules。台帳の rule_code も `referral_visit`)で付ける。累計にも入る。
- **紹介者が停止中**(初来店の時点で `status` が active でない): 紹介者には何も付けない(`referrer_reward='none'`)。友だちのチケットは出す。
- **チケットの名前:** 「お友だち紹介・ディナーの五巡茶 1杯」(何のチケットかがスタッフ・お客様に分かるよう、到達のお祝いの「AMBER 到達のお祝い・豆花 1つ」と同じ形にした)。店長が出し方を切り替えると、**まだ使っていない**紹介のチケットの名前も新しい名前に変える(使用済みは当時の名前のまま)。
- **期限:** 102 の到達のお祝いと同じ数え方(発行した日=日本時間から60日目の終わりまで。例: 9/10 発行 → 11/9 まで)。
- **上限の数え方:** 紹介として記録された登録の数(日本時間の `registered_month`)。上限は `app_settings.referral_monthly_cap`(既定 5)。同時の登録は紹介者の会員行のロックで直列化するので、同時に何人来ても5人を超えない。上限を超えた登録は監査ログに `referral_over_cap`(紹介者・月だけ。友だちの情報は残さない)。上限に達したら、会員証は招待のボタンを出さずに「今月の招待は上限(5人)に達しました。来月また招待できます」と出す。
- **無効なコード**(存在しない・形が違う・停止中の会員・試験/本番の区分が違う)は、通常の登録にする(エラーにしない)。**すでに会員の人**が招待のリンクを開いても、ふつうの会員証になり、紹介にはならない(紹介は登録のときだけ)。
- **旧ルールの扱い:** `point_rules` の `referral_referrer` / `referral_welcome` の行は消さない(過去の台帳の説明のため)。新しい `app_register` が使わないだけ。方針 `policy_decisions` の `referral`(本番は 2026-10-10 に `off` で決定済み)は、旧ルールの有効/無効を切り替えるだけで、新しい紹介には影響しない。新しい紹介を止める仕組みは今回は作っていない(必要なら設定を足す)。
- **旧形式の紹介(会員番号)は受け付けない:** member-api は `referrerMemberNo` を無視する(DB の `p_referrer_member_no` は古い member-api との互換のために引数だけ残し、使わない)。
- **お知らせの「1回だけ」:** `app_me` がお知らせ(`inviteNotice`)を返し、会員証が**表示したあと**に `invite_seen`(表示したお知らせの時刻 `until` まで)で既読にする。体質チェックの画面など、表示しない画面が `app_me` を呼んでも消えない。既読にした後に出た特典は、次に会員証を開いたときに出る。
- **登録した友だちへの表示:** 招待のリンクから開くと登録画面に「お友だちからの招待です。…」。登録すると「招待を受け付けました。初めてのご来店で特典チケットをお届けします」、会員証に「お友だちの招待で登録されました。初めてのご来店で「ディナーの五巡茶 1杯」のチケットをお届けします」。初来店のときは来店の文言に「お友だち紹介の特典チケット「…」をお届けしました」を添える。紹介者の名前は友だちに見せない。
- **招待のメッセージの文面:** 「10ZEN の LINE 会員証にご招待します。登録して初めてご来店いただくと「ディナーの五巡茶 1杯」のチケットをお届けします。」+ リンク。
- **LINE のログインで画面が移るとき:** 招待のコードは、そのタブの sessionStorage にも置き、ログインの後も登録に使う(使えない端末では置かない。LINE アプリの中ではログインの移動は起きない)。コードを読んだら URL からは消す。

### A-3. 実装メモ

#### DB(`db/106_referral.sql`・戻しは `db/106_referral_DOWN.sql`)

- **設定:** `app_settings` に `dinner_tea_mode`(`cup` / `free_flow`。既定 `cup`)と `referral_monthly_cap`(既定 `5`)。`point_rules` に `referral_visit`(100pt)。
- **チケットの種類:** `perk_ticket_types` / `perk_tickets` の `kind` に `referral` を追加(102 の制約を広げる)。種類 `referral_tea`(`label` は出し方の名前、`valid_days` 60)。
- **新しい表**(行レベルセキュリティつき。anon / authenticated は直接触れない。service_role は読み取り・追記・更新だけ。削除は不可)
  - `member_invite_codes`(`member_id` 主キー・`code` 一意・`created_at`): 招待コード。12文字の英数字と `-` `_`(強い乱数 72ビット)。会員証を開いたとき(`_member_view`)に作る。
  - `member_referrals`(`referred_member_id` 主キー=友だち1人に1行・`referrer_member_id`・`invite_code`・`registered_at`・`registered_month`(日本時間 `YYYY-MM`)・`first_visit_on`・`rewarded_at`・`referred_ticket_id`・`referrer_reward`(`ticket`/`points`/`none`)・`referrer_ticket_id`・`referrer_points`・`referrer_ledger_id`・`referrer_seen_at`)。自分自身は不可(制約)。友だちの `members.referred_by` にも紹介者を入れる(100 からある列)。
- **関数**
  - 置き換え: `app_register`(引数 `p_invite_code text default null` を足すため作り直し。権限は service_role だけ)・`app_checkin`(初来店の特典を足し、応答の会員の情報を `_member_view` に)・`_member_view`(紹介の情報 `invite` と `inviteNotice` を足す)・`staff_kpi_overview`(各月の `supporting` に `referralRegistrations` と `referralFirstVisits`)・`export_backup` / `restore_backup`(2つの表を追加。106 より前のバックアップも復元できる)。
  - お客様向け(service_role だけ): `app_invite_seen(issuer, subject, until, now)`。`app_register` の戻り値に `invite`(`linked` / `over_cap` / `invalid` / null)、`app_checkin` の戻り値に `referral`(`{ ticket, validThrough }` または null)。
  - スタッフ向け(ログイン済み。権限は中で確認): `staff_referral_stats()`(閲覧以上。店頭タブレットは拒否。今月の `referralRegistrations`・`referralFirstVisits`、累計の `registrationsTotal`・`firstVisitsTotal`・`waitingFirstVisit`、`overCapThisMonth`、`dinnerTeaMode`・`ticketLabel`・`monthlyCap`・`canEdit`)、`manager_set_dinner_tea_mode(p_mode)`(店長だけ。`invalid_mode`。監査ログ `dinner_tea_mode`。**監査 L-2 の修正(`db/110_dinner_tea_mode_partition.sql`):** 凍結中は `maintenance` で止める。まだ使っていないチケットの名前の書き換えは、いまの状態の区分の会員だけ(試験運用中=試験会員だけ・本番=本番会員だけ)。設定と新しく出すチケットの名前は全体で1つのままなので、試験運用中に切り替えた場合は、本番開始の後に同じ出し方でもう一度保存すると本番の会員のチケットの名前が揃う)。
  - 内部(誰も直接は呼べない): `_dinner_tea_label`・`_invite_code_for`・`_invite_snapshot`・`_referral_reward`・`_referral_month`・`_kpi_with_referral`。
  - 監査ログ: `referral_reward`(友だち・紹介者・紹介者への特典の種類)・`referral_over_cap`・`dinner_tea_mode`。
- **会員証の応答(`member`)に足したもの:** `invite { code, month, monthCount, monthlyCap, teaLabel, referrerReward('ticket'|'points'), rewardPoints, referred: { status: 'waiting_first_visit'|'rewarded' } | null }`、`inviteNotice { friends, tickets, points, until } | null`。紹介者の氏名・会員番号は返さない。
- **戻し(DOWN):** 置き換えた6つの関数・チケットの制約・設定を 105 の状態に戻し、2つの表・紹介のチケット(使用の申請を含む)・`referral_visit` のルールを消す。紹介者に付けた 100pt の台帳と `members.referred_by` は残る。先に `export_backup()` で保管すること。

#### API・クライアント・画面

- `functions/member-api`: `register` は `inviteCode`(12文字の形のものだけ。違えば無視)を受け、あるときだけ `p_invite_code` を渡す。`referrerMemberNo` は無視。新しい `action`: `invite_seen`(`until` は日時の文字列。違えば 400)。
- `app-core/member-client.mjs`: `register({ inviteCode, displayName })`・`inviteSeen(until)`・`inviteCodeFromLocation(search)`(`?ref=` と `?liff.state=` の両方)・`isInviteCode`・`inviteUrl(liffId, code)`。
- `app-core/screens.mjs`: `memberView(...).invite`(`inviteView`: `countText`「今月の招待 n/5人」・`rewardText`・`fullText`・`referredText`・`notice { text, until }`・`shareText(url)`)、`lineShareUrl(text)`、`registerNotice(res)`、`checkinScreen` の文言に初来店の特典を添える。文言は `messages.ja.invite_*`。
- `app-core/staff-client.mjs`: `referralStats()`・`setDinnerTeaMode(mode)`。`mapError` に `invalid_mode`。
- **会員証(card.html)の要素 ID:** `invite`(欄)・`inviteText`(特典の説明)・`inviteCount`(今月の招待 n/5人)・`inviteReferred`(紹介で登録した人)・`inviteShare`(`data-mode="picker"` のボタン、または `data-mode="line-share"` の LINE の送る画面へのリンク)・`inviteCopy`(リンクのコピー)・`inviteOut`(結果)・`inviteUrl`(コピーできなかったときのリンクの表示)・`inviteFull`(上限)・`inviteNotice`(紹介者へのお知らせ)・`inviteWelcome`(招待のリンクで開いた登録画面)。
- **スタッフ画面(staff.html)の要素 ID:** 集計タブに `referralStats`(紹介からの登録・紹介からの新規来店・初来店待ち)、店長だけ `teaModeBox`・`teaMode`(select: cup / free_flow)・`teaModeSave`・`teaModeOut`・`teaModeLabel`。目標とKPI の会員来店率のカードに `kpiReferralVisits`(紹介からの新規来店)・`kpiReferralRegs`(紹介からの登録)。既存の要素 ID・`data-tab`・文言(UI_CONTRACT_CHANGES_20261014.md で守るもの)は変えていない。描画は textContent と createElementNS だけ(innerHTML・CDN は使わない)。

### A-4. テスト(すべて擬似データ)

- `patches/test_referral.mjs`(12件・実 PostgreSQL): 適用/戻し・権限、招待コード、旧ルールの廃止、停止中・区分違いのコード、上限(日本時間の月の境目・7人の同時の登録で5人だけ)、初来店だけの特典(登録した日の QR・QR なしの来店扱い)、AMBER 以上の 100pt と停止中の紹介者、同時の来店記録での冪等、お知らせの既読、五巡茶の出し方の切り替え、集計(staff_referral_stats・staff_kpi_overview・試験運用中)、月次レポート、バックアップ/復元(106 より前のバックアップも)。
- `app-core/test_referral.mjs`(5件): 招待のリンクからのコードの取り出し(liff.state の形)、クライアント → member-api → DB の登録・初来店・お知らせ・既読、AMBER 以上の文言、スタッフの集計と切り替え。
- `app-reference/test_e2e.mjs`(+2件): 会員証の「友だちを招待」(LINE の送る画面・コピー・shareTargetPicker)、招待のリンク(liff.state の形)からの登録、初来店、お知らせが1回だけ、上限、スタッフ画面の集計・会員来店率のカードの補助・店長の切り替え。
- `functions/member-api/test.mjs`: 会員番号での紹介(旧ルール)を受け付けないことに書き換え(件数は同じ)。

### A-5. 本番の反映の手順(承認を得てから)

1. **DB に 106 を適用する**(`db/106_referral.sql`。100〜105 の後)。**member-api より先に適用する**(新しい member-api は招待コードがあるときだけ新しい引数を渡すので、コードなしの登録は 106 の前でも動くが、コードつきは失敗する。古い member-api は 106 の後でも動く)。
2. **Edge Function `member-api` を更新する**(`functions/member-api`)。
3. **LINE Developers で、LIFF アプリの「shareTargetPicker」を有効にする**(LIFF の設定画面のスイッチ)。有効にしないと、会員証は LINE の「送る」画面へのリンクに切り替わる(動きはするが、友だちを選ぶ画面は出ない)。
4. **配信物(v2)を組み立て直して公開する**(`tools/build_v2.mjs`。card.html・staff.html・app-core)。今回のコミットでは `v2/` は組み立て直していない(公開になるため)。
5. 実機(LINE アプリ)で、招待のメッセージを送る → 友だちの端末で開く → 登録 → 店頭QR → 紹介者の会員証のお知らせ、を確かめる。
6. 運営変更でディナーの五巡茶の飲み放題が始まったら、店長がスタッフ画面の集計タブ「お友だち紹介のチケット(店長のみ)」で「飲み放題」に切り替える。

### A-6. まだのもの・確かめたいこと

- 特典チケットの集計 `staff_ticket_stats` の種類別(`byKind`)は 102 のまま(到達のお祝い・季節の豆花だけ)。合計(発行・使用・使用率)には紹介のチケットも入る。月次レポートは紹介の分を別に数える。
- 上限を超えた友だちには、紹介にならなかったことを知らせていない(通常の登録として扱う)。紹介者の画面にも出さない(スタッフの集計 `overCapThisMonth` だけ)。
- 新しい紹介そのものを止める設定はない(必要になったら足す)。
- 本物の LINE(shareTargetPicker・外部のブラウザで開いたときのログイン)での確認。

---

## B. 月次レポート

### B-1. 決定(牧野さん 2026-10-15)

- 毎月1日 9時(日本時間)に、**前の月**のまとめをメールで送る。送り先は当面**牧野さんだけ**(スクリプト プロパティで設定。後で店長を足す)。
- **本番開始日(KPI の launch date)が決まった次の月から**。開始日が未設定の間、または前の月が開始日の月より前のときは送らない(メールなし)。
- 中身(**集計の数字だけ。氏名・会員番号・LINE ID は含まない**):
  1. 4つの KPI の実績 / 目標 / 達成率と、前の月との差。
  2. 会員: 新規登録数・紹介からの新規来店数・ランク別の人数。
  3. 体質チェック: タイプ別の人数・**チェック結果の傾向**(その月のチェックの回数とタイプの分布)・**来店時の実施率**(2026-10-15 の変更。下の B-7)。
  4. 特典: チケットの発行数・使用数・使用率。
  5. 1行の注意(例: 会員来店率が目標の80%未満・レジの客数が未取り込み)。
  6. スタッフ画面へのリンク(URL はスクリプト プロパティ)。
- 作り: DB の関数 `report_monthly(p_month 'YYYY-MM')`(service_role だけ)を既存の集計(`_kpi_overview`・体質・チケット・紹介)から作り、既存の Edge Function `backup-export` の新しい `action` `monthly_report` で返す。認証は**月次レポートだけに使えるトークン** = HMAC-SHA256(秘密, "monthly-report-v1")。既存のトークンの範囲は変えない(全体のトークンでも呼べる)。
- GAS: `gas_backup/monthly_report.gs` を、見張り役と同じ別のプロジェクト(「10ZENバックアップの見張り」)に置く。

### B-2. 決め方の細部

- **月:** 日本時間の暦月。「前の月」は GAS が日本時間で決める(1/1 0:00 からは前の年の12月)。DB はまだ終わっていない月を `month_not_finished` で省略する。
- **会員の区分:** スタッフ画面の集計と同じ。いまの状態が試験運用中(`test`)なら試験会員と試験用の客数、それ以外は本番(応答の `scope` で示し、メールの件名に「(試験運用のデータ)」と書く)。
- **KPI の値:** 105 の `_kpi_overview` を「その月の最後の時刻(日本時間)」で計算したもの(スタッフ画面の月の表と同じ値)。数の KPI の目標は日割りしない(月が終わっているため)。前の月との差は、率は % の差(メールでは pt)、数は件数の差。どちらかの月の実績がない(レジの客数が未取り込みなど)ときは「—」。
- **新規登録数**は KPI と同じ(移行で取り込んだ会員を除く)。4つの KPI と並べて「(補助)」として載せ、目標と達成率もつける。
- **ランク別:** 月末までに登録した有効会員を、**今の**ランクで数える(ランクの履歴は持っていない)。
- **体質のタイプ別:** 会員ごとの、月末までの最新の結果。**チェック結果の傾向:** その月(日本時間)に行われたチェック1回ずつの主なタイプの分布(バランス良好は別)と回数・人数。**来店時の実施率:** その月の会員の来店日(1会員1日1行)のうち、同じ日(日本時間)にその会員がチェックした日の割合(目標と KPI の補助の数字と同じ)。**今日の体調は載せない**(2026-10-15 に廃止。B-7)。
- **チケット:** その月の発行数(種類別: 到達のお祝い・季節の豆花・お友だち紹介)と使用数(その月に使った数)。**使用率は月末までの累計**(使用 ÷ 発行。スタッフ画面の「特典チケット(累計)」と同じ考え方)。
- **注意の行:** 目標のある KPI(4つと新規登録数)のうち、達成率が80%未満のもの(ちょうど80%・目標なしは除く)を1行ずつ。レジの客数が未取り込みなら1行。なければ「特になし」。
- **送れなかったとき:** 取得できない(通信エラー・HTTP のエラー・応答の形の違い・設定漏れ)ときは、**所有者だけ**に「【10ZEN】月次レポートを作れませんでした(YYYY年M月)」と直し方を送る(店長を送り先に足しても、技術的な知らせは所有者だけ)。直ったら `monthlyReport` を実行すると、その月の分を送る。
- **二重の送信の防止:** 送った月を `REPORT_LAST_SENT` に記録し、同じ月は送らない。同時に動いたときはロックの取れた1回だけ。
- **件名:** 「10ZEN 月次レポート 2026年10月」。

### B-3. 実装メモ

- **DB(106 に含む):** `report_monthly(p_month text, p_now timestamptz default now())`(service_role だけ。`p_now` はテスト用で、Edge Function は渡さない)。
  - 省略のとき: `{ month, skipped: true, reason: 'no_launch_date' | 'before_launch' | 'month_not_finished' }`(`before_launch` は `launchDate` も)。月の形の違いは `invalid_month`(22023)。
  - それ以外: `{ month, skipped: false, scope('production'|'test'), state, generatedAt, launchDate, monthIndex, milestone, previousMonth, kpis{ member_visit_rate・new_members・check_rate・revisit_rate・referral_clicks: { actual, target, achievementPercent, previous, change } }, pos{ customers, source, days, missing }, members{ newRegistrations, referralRegistrations, referralFirstVisits, activeMembers, memberVisits, byRank{ white_opal…onyx } }, constitution{ checkedMembers, checksInMonth, checkRatePercent, byType{ wood, fire, earth, metal, water, balanced }, checkResults{ checks, members, byType{ wood…water, balanced } }, visitCheckRate{ visitDays, checkedVisitDays, ratePercent } }(107 から。106 では checkResults・visitCheckRate の代わりに conditions{ answers, counts, top } だった), tickets{ issued, used, issuedByKind{ milestone, seasonal, referral }, cumulativeIssued, cumulativeUsed, usageRatePercent } }`。会員の ID・氏名・会員番号・LINE の ID・招待コードは含まない(テストで確認)。
- **Edge Function `backup-export`:** `action: "monthly_report", month: "YYYY-MM"`。トークン: 月次レポート用(`reportToken` = HMAC(秘密, "monthly-report-v1"))と全体のトークンで 200。見張り用のトークンでは 403。月次レポート用のトークンで `status`・`export`・`record` は 403。月の形の違いは 400、DB のエラーは 500。
- **GAS `gas_backup/monthly_report.gs`**(見張り役と同じプロジェクト。関数・変数の名前は `watchdog.gs` と重ならない)
  - `monthlyReport()`(トリガーの入口)・`monthlyReport_(nowMs)`(テストできる本体)・`buildReportMail_(json, staffUrl)`(件名・本文・注意の行)・`installMonthlyReportTrigger()`(所有者のみ。毎月1日 9時 Asia/Tokyo。何度実行しても1つ)・`monthlyReportSelfTest()`(所有者のみ。所有者だけに【試験】のメール。送った記録は残さない)。
  - スクリプト プロパティ: `REPORT_TOKEN`・`REPORT_TO`(カンマ区切り)・`STAFF_URL`・任意 `REPORT_URL`(省略時は `BACKUP_URL`)。内部で `REPORT_LAST_SENT`。トークンは実行ログ・メールに出さない。
- **GAS `gas_backup/backup.gs`:** `showReportToken()`(所有者のみ。`showWatchdogToken` と同じ形で、月次レポート用のトークンを実行ログに表示する)。`gas_freeze/test_surface.mjs` の公開関数の一覧に追加(12個)。

### B-4. テスト

- `gas_backup/test_monthly_report.mjs`(9件): 本物の backup-export の handler と使い捨ての PostgreSQL(擬似データ)で、トークンの範囲(見張り用のトークンと同じ形の検証)、本番開始日の前は送らないこと、文面、注意の行、個人の情報が出ないこと、取得できないときの所有者への知らせ、同じ月を2回送らないこと、トリガーと動作確認・ログにトークンを出さないこと、見張り役と同じプロジェクトに置けること。
- `patches/test_referral.mjs` の 11件目: `report_monthly` の権限・省略・値(105 の集計と同じ)・個人の情報がないこと・試験運用中の区分。12件目: バックアップから復元した DB で同じレポートになること。

### B-5. 本番の設定(承認を得てから)

`gas_backup/WATCHDOG_SETUP.md` の「月次レポート」の節の手順(DB 106 の適用と backup-export の更新 → 本体で `showReportToken` → 見張り役のプロジェクトに `monthly_report.gs` とスクリプト プロパティ → `installMonthlyReportTrigger` → `monthlyReportSelfTest`)。本番開始日が未設定の間は、トリガーを入れても毎月何も送らない(自動で始まる)。

### B-7. 体質チェックを来店のたびに(任意)へ変えたことによる変更(2026-10-15・db/107)

- 牧野さんの決定で「今日の体調」(3問)をやめ、1分体質チェックを来店のたびに任意でできるようにした(`CONSTITUTION_CHECK_DESIGN_20261015.md` の 12章)。
- **月次レポートの体質チェックの欄:** 「今日の体調でいちばん多い答え」を外し、「チェック結果の傾向」(この月のチェックの回数と、1回ずつのタイプの分布)と「来店時の実施率」(会員の来店日のうち、同じ日にチェックした日の割合と、その日数)を載せる。
  - メールの行: 「・チェック結果の傾向(この月のチェック N回): 木 モヤモヤ渋滞タイプ N回 / … / バランス良好 N回」(チェックがない月は「この月のチェックはありません」)、「・来店時の実施率: 50.0%(会員の来店 2日のうち、同じ日にチェックした日 1日)」(来店がない月は「—」)。
- **DB:** `report_monthly` を 107 で置き換え(署名・権限は同じ)。応答の `constitution.conditions` をなくし、`checkResults`・`visitCheckRate` を足した。ほかの項目は 106 と同じ。戻しは `db/107_constitution_each_visit_DOWN.sql`(106 の内容に戻る)。
- **テスト:** `gas_backup/test_monthly_report.mjs`(9件のまま。文面・値を変更)、`patches/test_constitution_each_visit.mjs` の 7件目(値・日本時間の月の境目・106 のほかの項目がそのまま)。

### B-6. まだのもの・確かめたいこと

- 店長を送り先に足す時期(`REPORT_TO` に追加するだけ)。
- 停止・退会の履歴、ランクの履歴を持っていないため、過去の月の「有効会員」「ランク別」は今の状態で数える(KPI の設計と同じ)。
- 実際の Google Apps Script・Gmail での確認(文面の見え方、トリガーの時刻)。

## 変更(2026-10-21、牧野さん決定・DB 116)

- 紹介された友だちには**紹介のチケットを出さない**(登録のときの初回特典「ディナーの五巡茶」だけ。同じ品が重なるため)。
- 紹介者への特典は今までどおり: 友だちの初来店で、AMBER 未満はディナーの五巡茶のチケット、AMBER 以上は +100pt(ポイントはランクが進むだけになるが、牧野さんの判断で据え置き)。
- 会員証の文: 「お友だちが初めてご来店されると、あなたに…。お友だちには、ご登録の特典のチケットが届きます」。
