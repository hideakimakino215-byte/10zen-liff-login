// 画面の状態と表示用データ(見た目に依存しない)。UI は screen 名で分岐し、view の項目をそのまま表示する。
// 文言は messages に集約(差し替え可能)。数値の未取得は null のまま渡し、画面側で「—」と表示する(0 に変換しない)。
// 1分体質チェックの説明文は constitution-content.mjs、判定は constitution.mjs(DB と同じ決め方)。
import { ELEMENTS, ELEMENT_INFO, BALANCED_NAME, teaWeekdayText, weekdayText, jstDate } from "./constitution.mjs";
import { TYPE_LINES, TEA_LINES, TEA_NAME, SEASON_NAMES, SEASON_LINES, CHECK_NAME, TODAY_LABEL, latestLabel, profileBasisText, recommendDish, yourTeaDayText } from "./constitution-content.mjs";
export const messages = {
  ja: {
    needs_login: "LINE でログインしてください",
    not_registered: "会員登録がまだです。登録すると 100pt をプレゼントします",
    network_error: "通信できませんでした。電波の良い場所で、もう一度お試しください",
    server_error: "ただいま混み合っています。しばらくしてからもう一度お試しください",
    rate_limited: "操作が多すぎます。しばらくしてからもう一度お試しください",
    maintenance: "ただいま会員証のメンテナンス中です。しばらくしてからお試しください",
    checkin_outside_hours: "ただいまの時間帯は来店ポイントの対象外です。営業時間内に店頭のQRコードを読み取ってください",
    checkin_counted: (pts) => `ご来店ありがとうございます。${pts}pt を付与しました`,
    checkin_already: "本日の来店ポイントは付与済みです",
    checkin_registered_today: "本日はご登録ボーナスを付与済みです(来店ポイントは明日から)",
    qr_expired: "QRコードの有効期限が切れました。店頭のQRコードをもう一度読み取ってください",
    qr_invalid: "このQRコードは使えません。店頭のQRコードを読み取ってください",
    redeem_invalid_amount: (unit) => `ポイントは ${unit}pt 単位で使えます`,
    redeem_insufficient: "ポイントが足りません",
    redeem_already_pending: "すでに使用の申請中です。スタッフにコードをお見せください",
    redeem_confirmed: (pts, yen) => `${pts}pt(${yen}円分)を使用しました`,
    redeem_cancelled: "使用の申請を取り消しました",
    redeem_expired: "有効時間が過ぎました。もう一度申請してください",
    lifetime_unconfirmed: "累計ポイントは確認中です(ランクは現在のポイントから暫定表示)",
    top_rank: "最上位ランクです",
    ticket_done: (title) => `${title} をご利用いただきました`,
    ticket_cancelled: "チケットの使用を取り消しました",
    ticket_code_expired: "コードの有効時間が過ぎました。もう一度「使う」を押してください",
    ticket_not_found: "このチケットは使えません",
    ticket_used: "このチケットは使用済みです",
    ticket_expired: "このチケットは有効期限が切れています",
    ticket_already_pending: "ほかのチケットのコードを表示中です。先に取り消してください",
    ticket_valid_through: (d) => `${d}まで`,
    cc_consent_required: "はじめに、記録への同意をお願いします",
    cc_invalid: "回答を送れませんでした。最初からもう一度お試しください",
    // 友だち紹介(db/106)
    invite_title: "友だちを招待",
    invite_count: (n, cap) => `今月の招待 ${n}/${cap}人`,
    invite_reward_ticket: (tea) => `お友だちが初めてご来店されると、お二人に「${tea}」のチケットをお届けします`,
    invite_reward_points: (tea, pts) => `お友だちが初めてご来店されると、お友だちに「${tea}」のチケット、あなたに ${pts}pt をお届けします`,
    invite_full: (cap) => `今月の招待は上限(${cap}人)に達しました。来月また招待できます`,
    invite_referred_waiting: (tea) => `お友だちの招待で登録されました。初めてのご来店で「${tea}」のチケットをお届けします`,
    invite_notice_ticket: "お友だちが来店しました。チケットが届いています",
    invite_notice_points: (pts) => `お友だちが来店しました。${pts}ptを付けました`,
    invite_notice_both: (pts) => `お友だちが来店しました。チケットが届いています。${pts}ptを付けました`,
    invite_register: "お友だちからの招待です。登録して初めてご来店いただくと、特典チケットをお届けします",
    invite_linked: "招待を受け付けました。初めてのご来店で特典チケットをお届けします",
    invite_first_visit: (title) => `お友だち紹介の特典チケット「${title}」をお届けしました`,
    invite_share_text: (tea, url) => `10ZEN の LINE 会員証にご招待します。登録して初めてご来店いただくと「${tea}」のチケットをお届けします。\n${url}`,
    invite_copied: "リンクをコピーしました",
    invite_copy_failed: "コピーできませんでした。下のリンクを長押ししてコピーしてください",
    invite_sent: "招待を送りました",
  },
};
const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("ja-JP"));
const jpDate = (s) => (typeof s === "string" ? s.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1年$2月$3日") : null);
const codeText = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

// ランクごとの『来るたびに使える特典』(チケットではない。会員証に文字で出す)。上のランクは下のランクの特典も続けて使える。
//   small: true は小さく添える行(薬日本堂のご優待は暫定。中身は未定なので表示だけ)
const RANK_ORDER = ["white_opal", "amber", "emerald", "ruby", "onyx"];
export const RANK_PERKS = [
  ["amber", "ディナーの五巡茶 無料"],
  ["emerald", "季節の豆花チケット(季節ごとに1枚)"],
  ["ruby", "席・予約の優先案内"],
  ["onyx", "新メニュー試食会へご招待"],
  ["emerald", "薬日本堂のご優待(準備中)", true],
];
export function rankPerks(rank) {
  const at = RANK_ORDER.indexOf(rank);
  return RANK_PERKS.filter(([r]) => at >= 0 && RANK_ORDER.indexOf(r) <= at).map(([, text, small]) => ({ text, small: !!small }));
}

export function memberView(member, nowMs = Date.now(), lang = "ja") {
  if (!member) return null;
  const m = messages[lang];
  const pend = member.pendingRedeem;
  const left = pend ? Math.max(0, Math.floor((Date.parse(pend.expiresAt) - nowMs) / 1000)) : null;
  const exp = member.expiresOn ? member.expiresOn.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1年$2月$3日") : null;
  const pt = member.pendingTicket, lt = member.lastTicket;
  const ptLeft = pt ? Math.max(0, Math.floor((Date.parse(pt.expiresAt) - nowMs) / 1000)) : null;
  return {
    displayName: member.displayName ?? "会員",           // 氏名未取得でも画面は成立させる
    memberNo: member.memberNo,
    rank: member.rank, rankLabel: member.rankLabel,
    points: member.points, pointsText: `${fmt(member.points)} pt`,
    yenText: member.points === null ? "—" : `${fmt(Math.floor(member.points * member.yenPer100pt / 100))}円相当`,
    lifetimeText: `${fmt(member.lifetimePoints)} pt`, lifetimeNote: member.lifetimeConfirmed ? null : m.lifetime_unconfirmed,
    next: member.nextRank ? { label: member.nextRank.label, remainingText: `あと ${fmt(member.nextRank.remainingPoints)} pt`, percent: member.nextRank.percent, target: member.nextRank.targetPoints ?? null } : { label: null, remainingText: m.top_rank, percent: 100, target: null },
    expiresText: exp,
    visitedToday: !!member.visitedToday,
    canRedeem: !pend && member.points >= member.redeemUnit,
    redeemUnit: member.redeemUnit,
    pending: pend ? { code: pend.code, codeText: `${pend.code.slice(0, 3)} ${pend.code.slice(3)}`, points: pend.points, yen: pend.yen, secondsLeft: left, expired: left === 0 } : null,
    lastRedeem: member.lastRedeem ? { ...member.lastRedeem, message: member.lastRedeem.status === "confirmed" ? m.redeem_confirmed(member.lastRedeem.points, member.lastRedeem.yen) : member.lastRedeem.status === "cancelled" ? m.redeem_cancelled : m.redeem_expired } : null,
    // 特典(db/102)。102 が未適用の応答(tickets なし)でも画面は成立させる
    perks: rankPerks(member.rank),
    tickets: (Array.isArray(member.tickets) ? member.tickets : []).map((t) => ({ id: t.ticketId, title: t.title, kind: t.kind, validThroughText: m.ticket_valid_through(jpDate(t.validThrough) ?? "—") })),
    pendingTicket: pt ? { ticketId: pt.ticketId, title: pt.title, code: pt.code, codeText: codeText(pt.code), secondsLeft: ptLeft, expired: ptLeft === 0 } : null,
    lastTicket: lt ? { ...lt, message: lt.status === "confirmed" ? m.ticket_done(lt.title) : lt.status === "cancelled" ? m.ticket_cancelled : m.ticket_code_expired } : null,
    // 1分体質チェック(db/103)。103 が未適用の応答では null(会員証は従来どおり)
    check: constitutionCardView(member, nowMs),
    // 友だち紹介(db/106)。106 が未適用の応答では null(招待の欄を出さない)
    invite: inviteView(member, lang),
  };
}

// ---- 友だち紹介(db/106) ----
// 会員証の招待の欄: 今月の人数と上限・特典の説明・(紹介で登録した人には)初来店でチケットが届くこと・紹介者へのお知らせ(1回だけ)
export function inviteView(member, lang = "ja") {
  const iv = member?.invite, m = messages[lang];
  if (!iv || typeof iv.code !== "string") return null;
  const cap = Number(iv.monthlyCap) || 0, count = Number(iv.monthCount) || 0, tea = iv.teaLabel || "特典";
  const nt = member.inviteNotice;
  const noticeText = !nt ? null : nt.tickets > 0 && nt.points > 0 ? m.invite_notice_both(nt.points) : nt.points > 0 ? m.invite_notice_points(nt.points) : m.invite_notice_ticket;
  return {
    code: iv.code, count, cap, full: cap > 0 && count >= cap, teaLabel: tea,
    countText: m.invite_count(count, cap),
    rewardText: iv.referrerReward === "points" ? m.invite_reward_points(tea, iv.rewardPoints ?? 100) : m.invite_reward_ticket(tea),
    fullText: m.invite_full(cap),
    referredText: iv.referred?.status === "waiting_first_visit" ? m.invite_referred_waiting(tea) : null,
    notice: noticeText ? { text: noticeText, until: nt.until } : null,
    shareText: (url) => m.invite_share_text(tea, url),
  };
}
// LINE の「送る」画面の URL(shareTargetPicker が使えないときの代わり)
export const lineShareUrl = (text) => `https://line.me/R/share?text=${encodeURIComponent(text)}`;
// 登録の結果(register())→ 会員証に出す文言(招待が受け付けられたときだけ)
export function registerNotice(res, lang = "ja") {
  return res?.kind === "ok" && res.data?.invite === "linked" ? messages[lang].invite_linked : null;
}

// ---- 1分体質チェック(db/103・db/107: 来店のたびに任意でチェック) ----
const teaView = (el, todayStr) => (ELEMENT_INFO[el] ? { element: el, name: `${TEA_NAME}(${ELEMENT_INFO[el].kanji})`, line: TEA_LINES[el], weekday: todayStr ? weekdayText(todayStr) : null } : null);
const typeNameOf = (primary, balanced) => (balanced ? BALANCED_NAME : ELEMENT_INFO[primary]?.typeName ?? null);
const shortDate = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : "—");
// 結果の表示用データ(点数・タイプは DB が計算したもの)。今日のおすすめの一品は、この結果(今日チェックしていれば今日の、なければ最新の)の五行と食事の気分で選ぶ。
//   あなたの五巡茶は yourTea(あなたの体質の五行)。渡されなければこの結果の五行。水の五巡茶のひとことには「冷えが気になる方は温かいほうで」を含むので、別の注記は出さない
export function constitutionResultView({ scores, primary, balanced, mood }, { yourTea = null, todayTea = null, seasonElement = null, todayStr = null } = {}) {
  const info = ELEMENT_INFO[primary]; if (!info) return null;
  const rec = recommendDish(primary, mood), tea = ELEMENT_INFO[yourTea] ? yourTea : primary;
  return {
    primary, balanced: !!balanced, scores,
    typeName: typeNameOf(primary, balanced),
    typeLine: TYPE_LINES[balanced ? "balanced" : primary],
    // タップで見せる正式名称(五行・五臓・状態の名称)。点数の高い順ではなく 木・火・土・金・水 の順
    details: ELEMENTS.map((el) => ({ element: el, kanji: ELEMENT_INFO[el].kanji, organ: ELEMENT_INFO[el].organ, state: ELEMENT_INFO[el].state, typeName: ELEMENT_INFO[el].typeName,
      score: scores?.[el] ?? null, isPrimary: !balanced && el === primary })),
    formalText: balanced ? null : `五行: ${info.kanji} / 五臓: ${info.organ} / 状態: ${info.state}`,
    dish: rec ? { name: rec.dish, reason: rec.reason, element: primary } : null,
    yourTea: { ...teaView(tea), dayText: yourTeaDayText(teaWeekdayText(tea)), isToday: todayTea === tea },
    todayTea: teaView(todayTea, todayStr),
    season: ELEMENT_INFO[seasonElement] ? { element: seasonElement, name: SEASON_NAMES[seasonElement], line: SEASON_LINES[seasonElement] } : null,
  };
}

// あなたの体質(app_me の constitutionProfile。最新3回の平均。DB が計算)→ 表示用
export function profileView(p) {
  if (!p || !ELEMENT_INFO[p.primary]) return null;
  const count = Number(p.count) || 1;
  return { count, scores: p.scores, primary: p.primary, balanced: !!p.balanced, element: p.balanced ? null : p.primary,
    typeName: typeNameOf(p.primary, p.balanced), typeLine: TYPE_LINES[p.balanced ? "balanced" : p.primary],
    kanji: p.balanced ? "バランス" : ELEMENT_INFO[p.primary].kanji, basisText: profileBasisText(count) };
}

// これまでのチェック(app_me の constitutionHistory。新しい順・最大6回)→ 表示用(日付と五行の漢字の印)
export function historyView(list) {
  return (Array.isArray(list) ? list : []).filter((h) => ELEMENT_INFO[h?.primary]).slice(0, 6).map((h) => ({
    checkedOn: h.checkedOn ?? null, dateText: shortDate(h.checkedOn), primary: h.primary, balanced: !!h.balanced, element: h.balanced ? null : h.primary,
    kanji: h.balanced ? "バランス" : ELEMENT_INFO[h.primary].kanji, typeName: typeNameOf(h.primary, h.balanced), scores: h.scores ?? null }));
}

// 会員証・体質チェックの画面で使う情報(app_me の constitution / constitutionProfile / constitutionHistory / todayTea / season)
//   todayPrompt: 来店した日(visitedToday)に、実施済みの方がまだ今日チェックしていなければ「今日の1分体質チェック」を出す(スキップは画面が端末に覚える: ccPromptVisible)。
//   初めての方(未実施)は今までどおりの入口だけ。今日の体調(3問)と季節の再チェックの案内はやめた(db/107)
export function constitutionCardView(member, nowMs = Date.now()) {
  if (!member || typeof member.todayTea !== "string") return null;
  const c = member.constitution, today = jstDate(nowMs);
  const checkedToday = !!c?.checkedToday;
  const profile = profileView(member.constitutionProfile);
  const ctx = { yourTea: profile?.primary ?? member.yourTea ?? null, todayTea: member.todayTea, seasonElement: member.season?.element ?? null, todayStr: today };
  const result = c ? constitutionResultView(c, ctx) : null;
  return {
    done: !!c,
    entryLabel: c ? "結果を見る" : CHECK_NAME,
    entryHref: c ? "check.html?view=result" : "check.html",
    startHref: "check.html?start=1",
    consented: !!member.constitutionConsent,
    checkedToday,
    todayStr: today,
    todayPrompt: !!c && !!member.visitedToday && !checkedToday,
    latestLabel: c ? (checkedToday ? TODAY_LABEL : latestLabel(shortDate(c.checkedOn))) : null,
    profile,
    history: historyView(member.constitutionHistory),
    todayTea: teaView(member.todayTea, today),
    result,
  };
}
// 「今日はスキップ」: 端末に覚えた日付(日本時間)が今日なら、今日の案内を出さない
export const CC_SKIP_KEY = "10zen_cc_skip";
export const ccPromptVisible = (check, skippedOn) => !!check?.todayPrompt && skippedOn !== check.todayStr;

// 体質チェックの送信: constitutionSubmit() の結果 → 画面
export function checkSubmitScreen(res, nowMs = Date.now(), lang = "ja") {
  const m = messages[lang];
  if (res.kind === "ok") return { screen: "result", view: constitutionCardView(res.data.member, nowMs) };
  if (res.kind === "conflict" && res.code === "consent_required") return { screen: "consent", error: m.cc_consent_required };
  if (res.kind === "bad_request") return { screen: "error", retry: false, message: m.cc_invalid };
  if (res.kind === "not_registered") return { screen: "register", message: m.not_registered };
  if (res.kind === "maintenance") return { screen: "maintenance", retry: false, message: m.maintenance };
  if (res.kind === "auth_required") return { screen: "needs_login", message: m.needs_login };
  return { screen: "error", retry: res.kind !== "rate_limited", message: res.kind === "rate_limited" ? m.rate_limited : res.kind === "network_error" ? m.network_error : m.server_error };
}

// 会員証の画面: me() の結果 → 画面
export function cardScreen(res, nowMs = Date.now(), lang = "ja") {
  const m = messages[lang];
  switch (res.kind) {
    case "ok": return { screen: "card", view: memberView(res.data.member, nowMs, lang) };
    case "auth_required": return { screen: "needs_login", message: m.needs_login };
    case "maintenance": return { screen: "maintenance", retry: false, message: m.maintenance };
    case "not_registered": return { screen: "register", message: m.not_registered };
    case "network_error": return { screen: "error", retry: true, message: m.network_error };
    case "rate_limited": return { screen: "error", retry: true, message: m.rate_limited };
    default: return { screen: "error", retry: !!res.retryable, message: m.server_error };
  }
}

// 来店記録(QR 読み取り後)の画面: checkin() の結果 → 画面
export function checkinScreen(res, nowMs = Date.now(), lang = "ja") {
  const m = messages[lang];
  if (res.kind === "maintenance") return { screen: "maintenance", retry: false, message: m.maintenance };
  if (res.kind === "ok" && res.status === "outside_hours") return { screen: "checkin_outside_hours", message: m.checkin_outside_hours };
  if (res.kind === "ok") {
    const view = memberView(res.data.member, nowMs, lang);
    // 友だち紹介の初来店(db/106): 特典チケットを届けたことを添える
    const ref = res.data.referral?.ticket ? `。${m.invite_first_visit(res.data.referral.ticket)}` : "";
    return res.status === "counted" ? { screen: "checkin_success", granted: res.data.granted, message: m.checkin_counted(res.data.granted) + ref, view, referral: res.data.referral ?? null }
                                    : { screen: "checkin_already", reason: res.data.reason, message: (res.data.reason === "registered_today" ? m.checkin_registered_today : m.checkin_already) + ref, view, referral: res.data.referral ?? null };
  }
  if (res.kind === "bad_request") return res.code === "qr_expired" ? { screen: "qr_expired", message: m.qr_expired } : { screen: "qr_invalid", message: m.qr_invalid };
  if (res.kind === "not_registered") return { screen: "register_then_checkin", message: m.not_registered };
  if (res.kind === "auth_required") return { screen: "needs_login", message: m.needs_login };
  return { screen: "error", retry: res.kind !== "rate_limited", message: res.kind === "network_error" ? m.network_error : m.server_error };
}

// ポイント使用の申請画面: redeemRequest() の結果 → 画面
export function redeemScreen(res, nowMs = Date.now(), lang = "ja") {
  const m = messages[lang];
  if (res.kind === "ok") return { screen: "redeem_pending", view: memberView(res.data.member, nowMs, lang) };
  if (res.kind === "conflict") {
    const view = res.data?.member ? memberView(res.data.member, nowMs, lang) : null;
    if (res.code === "invalid_amount") return { screen: "redeem_form", error: m.redeem_invalid_amount(res.data?.unit), view };
    if (res.code === "insufficient_balance") return { screen: "redeem_form", error: m.redeem_insufficient, view };
    if (res.code === "already_pending") return { screen: "redeem_pending", notice: m.redeem_already_pending, view };
  }
  if (res.kind === "bad_request") return { screen: "redeem_form", error: m.redeem_invalid_amount(null) };
  if (res.kind === "maintenance") return { screen: "maintenance", retry: false, message: m.maintenance };
  if (res.kind === "auth_required") return { screen: "needs_login", message: m.needs_login };
  return { screen: "error", retry: res.kind !== "rate_limited", message: res.kind === "rate_limited" ? m.rate_limited : res.kind === "network_error" ? m.network_error : m.server_error };
}

// 使用の申請中の画面は、数秒おきに me() で状態を確認する(スタッフが確定すると pendingRedeem が消え、lastRedeem に結果が出る)
export function redeemWatch(prevView, nextView) {
  if (!prevView?.pending) return { change: "none" };
  if (nextView?.pending) return { change: nextView.pending.expired ? "expired" : "none" };
  const lr = nextView?.lastRedeem; return lr ? { change: lr.status, message: lr.message } : { change: "unknown" };
}

// 特典チケットの「使う」: ticketRequest() の結果 → 画面(pending ならコードを出す。使えないときは会員証のまま文言を出す)
export function ticketScreen(res, nowMs = Date.now(), lang = "ja") {
  const m = messages[lang];
  if (res.kind === "ok") return { screen: "ticket_pending", view: memberView(res.data.member, nowMs, lang) };
  if (res.kind === "conflict") {
    const view = res.data?.member ? memberView(res.data.member, nowMs, lang) : null;
    const error = { ticket_used: m.ticket_used, ticket_expired: m.ticket_expired, already_pending: m.ticket_already_pending }[res.code] ?? m.ticket_not_found;
    return { screen: "card", error, view };
  }
  if (res.kind === "bad_request") return { screen: "card", error: m.ticket_not_found };
  if (res.kind === "maintenance") return { screen: "maintenance", retry: false, message: m.maintenance };
  if (res.kind === "auth_required") return { screen: "needs_login", message: m.needs_login };
  return { screen: "error", retry: res.kind !== "rate_limited", message: res.kind === "rate_limited" ? m.rate_limited : res.kind === "network_error" ? m.network_error : m.server_error };
}

// チケットのコードを表示中も、数秒おきに me() で確認する(スタッフが確定すると pendingTicket が消え、lastTicket に結果が出る)
export function ticketWatch(prevView, nextView) {
  if (!prevView?.pendingTicket) return { change: "none" };
  if (nextView?.pendingTicket) return { change: nextView.pendingTicket.expired ? "expired" : "none" };
  const lt = nextView?.lastTicket; return lt ? { change: lt.status, message: lt.message } : { change: "unknown" };
}
