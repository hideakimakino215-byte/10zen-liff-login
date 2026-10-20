// 画面の状態と表示用データ(見た目に依存しない)。UI は screen 名で分岐し、view の項目をそのまま表示する。
// 文言は messages に集約(差し替え可能)。数値の未取得は null のまま渡し、画面側で「—」と表示する(0 に変換しない)。
// 1分体質チェックの説明文は constitution-content.mjs、判定は constitution.mjs(DB と同じ決め方)。
import { ELEMENTS, ELEMENT_INFO, isAllHigh, jstDate } from "./constitution.mjs";
import { recommendDish } from "./constitution-content.mjs";
import { ccText, ticketTitle, dinnerTeaLabel, RANK_PERKS_I18N, punctDeep, paren } from "./i18n.mjs";
import { TEA_WEEKDAY } from "./constitution.mjs";
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
    expiry_soon: (date) => `ポイントの有効期限は ${date} です。ご来店・ご利用で延長されます`,   // 期限まで60日を切ったら(ペルソナ実験 2026-10-17)
    rank_up: (label) => `${label} に上がりました。会員ランク特典をご確認ください`,
    redeem_invalid_amount: (unit) => (Number.isFinite(unit) && unit > 0 ? `ポイントは ${unit}pt 単位で使えます` : "使うポイントを入力してください"),   // 空のまま押したときは単位が返らない(ペルソナ実験 2026-10-17 で「nullpt」と出ていた)
    redeem_insufficient: "ポイントが足りません",
    redeem_already_pending: "すでに使用の申請中です。スタッフにコードをお見せください",
    redeem_confirmed: (pts, yen) => `${pts}pt(${yen}円分)を使用しました`,
    redeem_cancelled: "使用の申請を取り消しました",
    redeem_expired: "有効時間が過ぎました。もう一度申請してください",
    // 通信の不調で結果が分からないとき(外部レビュー 2026-10-20)
    requesting: "確認しています…",
    cancel_failed: "取り消しを確認できませんでした。電波の良い場所で画面を開き直し、申請の状態を確かめてください",
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
    // 多言語(2026-10-17)で足した部品。日本語は今までの表示と同じ
    yen_equiv: (n) => `${n}円相当`, next_remaining: (n) => `あと ${n} pt`, date: (y, m, d) => `${y}年${m}月${d}日`, invite_tea_fallback: "特典",
  },
  // 英語・中国語(文案。英語・中国語のわかる方の確認と薬日本堂の表現チェックの前。言葉づかいのきまりは app-core/i18n.mjs と同じ)
  en: {
    needs_login: "Please log in with LINE",
    not_registered: "You're not registered yet. Register now and get 100 pt",
    network_error: "We couldn't connect. Please try again where the signal is better",
    server_error: "We're busy right now. Please try again in a little while",
    rate_limited: "Too many attempts. Please try again in a little while",
    maintenance: "The membership card is under maintenance. Please try again later",
    checkin_outside_hours: "Visit points can't be given at this time. Please scan the in-store QR code during opening hours",
    checkin_counted: (pts) => `Thank you for visiting. You earned ${pts} pt`,
    checkin_already: "You've already received today's visit points",
    checkin_registered_today: "You received your registration bonus today (visit points start tomorrow)",
    qr_expired: "This QR code has expired. Please scan the in-store QR code again",
    qr_invalid: "This QR code can't be used. Please scan the in-store QR code",
    expiry_soon: (date) => `Your points expire on ${date}. Visiting or using points extends this`,
    rank_up: (label) => `You've reached ${label}. Check your new rank benefits`,
    redeem_invalid_amount: (unit) => (Number.isFinite(unit) && unit > 0 ? `Points can be used in units of ${unit} pt` : "Please enter the points to use"),
    redeem_insufficient: "Not enough points",
    redeem_already_pending: "You already have a request in progress. Please show the code to our staff",
    redeem_confirmed: (pts, yen) => `You used ${pts} pt (¥${yen})`,
    redeem_cancelled: "Your request was cancelled",
    redeem_expired: "The time limit has passed. Please make a new request",
    requesting: "Checking…",
    cancel_failed: "We couldn't confirm the cancellation. Please reopen this screen where the signal is better and check your request",
    lifetime_unconfirmed: "Your total points are being confirmed (your rank is shown from your current points for now)",
    top_rank: "You're at the top rank",
    ticket_done: (title) => `You used: ${title}`,
    ticket_cancelled: "Ticket use was cancelled",
    ticket_code_expired: "The code's time limit has passed. Please tap \"Use\" again",
    ticket_not_found: "This ticket can't be used",
    ticket_used: "This ticket has already been used",
    ticket_expired: "This ticket has expired",
    ticket_already_pending: "Another ticket's code is showing. Please cancel it first",
    ticket_valid_through: (d) => `Valid until ${d}`,
    cc_consent_required: "Please agree to saving your results first",
    cc_invalid: "We couldn't send your answers. Please start again",
    invite_title: "Invite friends",
    invite_count: (n, cap) => `Invited this month: ${n}/${cap}`,
    invite_reward_ticket: (tea) => `When your friend visits for the first time, you'll both get a ticket for ${tea}`,
    invite_reward_points: (tea, pts) => `When your friend visits for the first time, they'll get a ticket for ${tea} and you'll get ${pts} pt`,
    invite_full: (cap) => `You've reached this month's limit (${cap}). You can invite more next month`,
    invite_referred_waiting: (tea) => `You registered through a friend's invitation. You'll get a ticket for ${tea} on your first visit`,
    invite_notice_ticket: "Your friend visited. You've received a ticket",
    invite_notice_points: (pts) => `Your friend visited. You earned ${pts} pt`,
    invite_notice_both: (pts) => `Your friend visited. You've received a ticket and ${pts} pt`,
    invite_register: "You were invited by a friend. Register and visit for the first time to get a reward ticket",
    invite_linked: "Your invitation was accepted. You'll get a reward ticket on your first visit",
    invite_first_visit: (title) => `Here's your friend referral ticket: ${title}`,
    invite_share_text: (tea, url) => `You're invited to the 10ZEN LINE membership card. Register and visit for the first time to get a ticket for ${tea}.\n${url}`,
    invite_copied: "Link copied",
    invite_copy_failed: "We couldn't copy it. Press and hold the link below to copy",
    invite_sent: "Invitation sent",
    yen_equiv: (n) => `Worth ¥${n}`, next_remaining: (n) => `${n} pt left`, date: (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, invite_tea_fallback: "a reward",
  },
  zh: punctDeep({
    needs_login: "请用LINE登录",
    not_registered: "您还没有注册会员。现在注册即送100pt",
    network_error: "无法连接网络。请在信号良好的地方重试",
    server_error: "当前访问人数较多。请稍后再试",
    rate_limited: "操作过于频繁。请稍后再试",
    maintenance: "会员卡正在维护中。请稍后再试",
    checkin_outside_hours: "当前时段不在来店积分的对象范围内。请在营业时间内扫描店内二维码",
    checkin_counted: (pts) => `感谢您的光临。已赠送 ${pts}pt`,
    checkin_already: "今天的来店积分已经赠送过了",
    checkin_registered_today: "今天已赠送注册奖励(来店积分从明天开始)",
    qr_expired: "二维码已过期。请重新扫描店内二维码",
    qr_invalid: "此二维码无法使用。请扫描店内二维码",
    expiry_soon: (date) => `您的积分有效期至 ${date}。来店或使用积分后会延长`,
    rank_up: (label) => `您已升级为 ${label}。请查看会员等级特典`,
    redeem_invalid_amount: (unit) => (Number.isFinite(unit) && unit > 0 ? `积分以 ${unit}pt 为单位使用` : "请输入要使用的积分"),
    redeem_insufficient: "积分不足",
    redeem_already_pending: "已有正在处理的申请。请向工作人员出示代码",
    redeem_confirmed: (pts, yen) => `已使用 ${pts}pt(${yen}日元)`,
    redeem_cancelled: "已取消使用申请",
    redeem_expired: "已超过有效时间。请重新申请",
    requesting: "正在确认…",
    cancel_failed: "无法确认是否已取消。请在信号良好的地方重新打开此页面，查看申请状态",
    lifetime_unconfirmed: "累计积分正在确认中(等级暂按当前积分显示)",
    top_rank: "已是最高等级",
    ticket_done: (title) => `已使用: ${title}`,
    ticket_cancelled: "已取消使用优惠券",
    ticket_code_expired: "代码已超过有效时间。请再次点击「使用」",
    ticket_not_found: "此优惠券无法使用",
    ticket_used: "此优惠券已使用",
    ticket_expired: "此优惠券已过期",
    ticket_already_pending: "正在显示其他优惠券的代码。请先取消",
    ticket_valid_through: (d) => `有效期至${d}`,
    cc_consent_required: "请先同意记录测试结果",
    cc_invalid: "回答发送失败。请从头再试一次",
    invite_title: "邀请好友",
    invite_count: (n, cap) => `本月已邀请 ${n}/${cap}人`,
    invite_reward_ticket: (tea) => `好友首次来店后,你们两人都将获得「${tea}」券`,
    invite_reward_points: (tea, pts) => `好友首次来店后,好友将获得「${tea}」券,你将获得 ${pts}pt`,
    invite_full: (cap) => `本月邀请已达上限(${cap}人)。下个月可以继续邀请`,
    invite_referred_waiting: (tea) => `您已通过好友邀请注册。首次来店时将获得「${tea}」券`,
    invite_notice_ticket: "您的好友已来店。优惠券已送达",
    invite_notice_points: (pts) => `您的好友已来店。已赠送 ${pts}pt`,
    invite_notice_both: (pts) => `您的好友已来店。优惠券已送达,并已赠送 ${pts}pt`,
    invite_register: "这是好友的邀请。注册并首次来店后,即可获得优惠券",
    invite_linked: "已接受邀请。首次来店时将送上优惠券",
    invite_first_visit: (title) => `已送上好友推荐优惠券「${title}」`,
    invite_share_text: (tea, url) => `邀请你加入10ZEN的LINE会员卡。注册并首次来店后,即可获得「${tea}」券。\n${url}`,
    invite_copied: "已复制链接",
    invite_copy_failed: "复制失败。请长按下方链接进行复制",
    invite_sent: "已发送邀请",
    yen_equiv: (n) => `相当于${n}日元`, next_remaining: (n) => `还差 ${n} pt`, date: (y, m, d) => `${y}年${m}月${d}日`, invite_tea_fallback: "特典",
  }),
};
const msgs = (lang) => messages[lang] ?? messages.ja;
const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("ja-JP"));
const jpDate = (s, lang = "ja") => { const m = typeof s === "string" ? s.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null; if (!m) return typeof s === "string" ? s : null; return lang === "ja" ? `${m[1]}年${m[2]}月${m[3]}日` : msgs(lang).date(m[1], Number(m[2]), Number(m[3])); };
const codeText = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

// ランクごとの『来るたびに使える特典』(チケットではない。会員証に文字で出す)。上のランクは下のランクの特典も続けて使える。
//   small: true は小さく添える行(薬日本堂のご優待は暫定。中身は未定なので表示だけ)
const RANK_ORDER = ["white_opal", "amber", "emerald", "ruby", "onyx"];
export const EXPIRY_NOTICE_DAYS = 60;
// ランクが上がったときのお知らせ(1回だけ)。前に見たランク(端末に覚えたもの)より上なら文を返す。初めて開いたとき(前のランクなし)は出さない
export function rankUpNotice(prevRank, view, lang = "ja") {
  if (!view || !prevRank) return null;
  const a = RANK_ORDER.indexOf(prevRank), b = RANK_ORDER.indexOf(view.rank);
  return a >= 0 && b > a ? msgs(lang).rank_up(view.rankLabel) : null;
}
export const RANK_PERKS = [
  ["amber", "ディナーの五巡茶 無料"],
  ["emerald", "季節の豆花チケット(季節ごとに1枚)"],
  ["ruby", "あなたの体質の五巡茶(持ち帰り用)チケット(季節ごとに1枚)"],
  ["onyx", "新メニュー試食会へご招待"],
  ["emerald", "薬日本堂のご優待(準備中)", true],
];
export function rankPerks(rank, lang = "ja") {
  const at = RANK_ORDER.indexOf(rank);
  return (RANK_PERKS_I18N[lang] ?? RANK_PERKS).filter(([r]) => at >= 0 && RANK_ORDER.indexOf(r) <= at).map(([, text, small]) => ({ text, small: !!small }));
}

export function memberView(member, nowMs = Date.now(), lang = "ja") {
  if (!member) return null;
  const m = msgs(lang);
  const pend = member.pendingRedeem;
  const left = pend ? Math.max(0, Math.floor((Date.parse(pend.expiresAt) - nowMs) / 1000)) : null;
  const exp = member.expiresOn ? jpDate(member.expiresOn, lang) : null;
  const tl = (t) => ticketTitle({ ...((Array.isArray(member.tickets) ? member.tickets : []).find((x) => x.ticketId === t.ticketId) ?? {}), ...t }, lang);   // チケット名を言語ごとに(日本語はそのまま)
  const pt = member.pendingTicket, lt = member.lastTicket;
  const ptLeft = pt ? Math.max(0, Math.floor((Date.parse(pt.expiresAt) - nowMs) / 1000)) : null;
  return {
    displayName: member.displayName ?? "会員",           // 氏名未取得でも画面は成立させる
    memberNo: member.memberNo,
    rank: member.rank, rankLabel: member.rankLabel,
    points: member.points, pointsText: `${fmt(member.points)} pt`,
    yenText: member.points === null ? "—" : m.yen_equiv(fmt(Math.floor(member.points * member.yenPer100pt / 100))),
    lifetimeText: `${fmt(member.lifetimePoints)} pt`, lifetimeNote: member.lifetimeConfirmed ? null : m.lifetime_unconfirmed,
    next: member.nextRank ? { label: member.nextRank.label, remainingText: m.next_remaining(fmt(member.nextRank.remainingPoints)), percent: member.nextRank.percent, target: member.nextRank.targetPoints ?? null } : { label: null, remainingText: m.top_rank, percent: 100, target: null },
    expiresText: exp,
    // ポイントの有効期限(最後の来店・利用から。DB の expiresOn)。期限まで60日を切ったら会員証に出す
    expirySoonText: (() => { if (!exp) return null; const d = Math.floor((Date.parse(`${member.expiresOn}T00:00:00+09:00`) - nowMs) / 86400000); return d <= EXPIRY_NOTICE_DAYS ? m.expiry_soon(exp) : null; })(),
    visitedToday: !!member.visitedToday,
    canRedeem: !pend && member.points >= member.redeemUnit,
    redeemUnit: member.redeemUnit,
    pending: pend ? { code: pend.code, codeText: `${pend.code.slice(0, 3)} ${pend.code.slice(3)}`, points: pend.points, yen: pend.yen, secondsLeft: left, expired: left === 0 } : null,
    lastRedeem: member.lastRedeem ? { ...member.lastRedeem, message: member.lastRedeem.status === "confirmed" ? m.redeem_confirmed(member.lastRedeem.points, member.lastRedeem.yen) : member.lastRedeem.status === "cancelled" ? m.redeem_cancelled : m.redeem_expired } : null,
    // 特典(db/102)。102 が未適用の応答(tickets なし)でも画面は成立させる
    perks: rankPerks(member.rank, lang),
    tickets: (Array.isArray(member.tickets) ? member.tickets : []).map((t) => ({ id: t.ticketId, title: tl(t), kind: t.kind, validThroughText: m.ticket_valid_through(jpDate(t.validThrough, lang) ?? "—") })),
    pendingTicket: pt ? { ticketId: pt.ticketId, title: tl(pt), code: pt.code, codeText: codeText(pt.code), secondsLeft: ptLeft, expired: ptLeft === 0 } : null,
    lastTicket: lt ? { ...lt, message: lt.status === "confirmed" ? m.ticket_done(tl(lt)) : lt.status === "cancelled" ? m.ticket_cancelled : m.ticket_code_expired } : null,
    // 1分体質チェック(db/103)。103 が未適用の応答では null(会員証は従来どおり)
    check: constitutionCardView(member, nowMs, lang),
    // 友だち紹介(db/106)。106 が未適用の応答では null(招待の欄を出さない)
    invite: inviteView(member, lang),
  };
}

// ---- 友だち紹介(db/106) ----
// 会員証の招待の欄: 今月の人数と上限・特典の説明・(紹介で登録した人には)初来店でチケットが届くこと・紹介者へのお知らせ(1回だけ)
export function inviteView(member, lang = "ja") {
  const iv = member?.invite, m = msgs(lang);
  if (!iv || typeof iv.code !== "string") return null;
  const cap = Number(iv.monthlyCap) || 0, count = Number(iv.monthCount) || 0, tea = dinnerTeaLabel(iv.teaLabel, lang) || m.invite_tea_fallback;
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
  return res?.kind === "ok" && res.data?.invite === "linked" ? msgs(lang).invite_linked : null;
}

// ---- 1分体質チェック(db/103・db/107: 来店のたびに任意でチェック) ----
const dow = (dateStr) => new Date(dateStr + "T00:00:00Z").getUTCDay();
const teaView = (el, todayStr, lang = "ja") => { const T = ccText(lang);
  return ELEMENT_INFO[el] ? { element: el, name: `${T.teaName}${paren(T.kanji[el], lang)}`, line: T.teaLines[el], weekday: todayStr ? T.weekdays[dow(todayStr)] : null } : null; };
// 表示の区分: バランス良好 → 全部が同点で高め(allHigh) → 五行。typeNameOf / lineOf / 色(element)はこの区分で決める
const kindOf = (primary, balanced, scores) => (balanced ? "balanced" : isAllHigh(scores) ? "allHigh" : primary);
const typeNameOf = (primary, balanced, scores, lang = "ja") => { const T = ccText(lang), k = kindOf(primary, balanced, scores); return k === "balanced" ? T.balancedName : k === "allHigh" ? T.allHighName : ELEMENT_INFO[primary] ? T.typeName[primary] : null; };
const kanjiOf = (primary, balanced, scores, lang = "ja") => { const T = ccText(lang), k = kindOf(primary, balanced, scores); return k === "balanced" ? T.balancedKanji : k === "allHigh" ? T.allHighKanji : T.kanji[primary]; };
const elementOf = (primary, balanced, scores) => (ELEMENT_INFO[kindOf(primary, balanced, scores)] ? primary : null);
const shortDate = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : "—");
// 結果の表示用データ(点数・タイプは DB が計算したもの)。今日のおすすめの一品は、この結果(今日チェックしていれば今日の、なければ最新の)の五行と食事の気分で選ぶ。
//   あなたの五巡茶は yourTea(あなたの体質の五行)。渡されなければこの結果の五行。水の五巡茶のひとことには「冷えが気になる方は温かいほうで」を含むので、別の注記は出さない。
//   lang: ja / en / zh(app-core/i18n.mjs)。料理名は決まるまで日本語のまま
export function constitutionResultView({ scores, primary, balanced, mood }, { yourTea = null, todayTea = null, seasonElement = null, todayStr = null, lang = "ja" } = {}) {
  const info = ELEMENT_INFO[primary]; if (!info) return null;
  const T = ccText(lang);
  const rec = recommendDish(primary, mood), tea = ELEMENT_INFO[yourTea] ? yourTea : primary;
  return {
    primary, balanced: !!balanced, allHigh: !balanced && isAllHigh(scores), element: elementOf(primary, balanced, scores), scores,
    typeName: typeNameOf(primary, balanced, scores, lang),
    typeLine: T.typeLines[kindOf(primary, balanced, scores)],
    // タップで見せる正式名称(五行・五臓・状態の名称)。点数の高い順ではなく 木・火・土・金・水 の順
    details: ELEMENTS.map((el) => ({ element: el, kanji: T.kanji[el], organ: T.organ[el], state: T.state[el], typeName: T.typeName[el],
      score: scores?.[el] ?? null, isPrimary: !balanced && !isAllHigh(scores) && el === primary })),
    formalText: balanced || isAllHigh(scores) ? null : T.formal(T.kanji[primary], T.organ[primary], T.state[primary]),
    dish: rec ? { name: rec.dish, reason: T.dishReasons[primary], element: primary } : null,
    yourTea: { ...teaView(tea, null, lang), dayText: T.yourTeaDay(T.weekdays[TEA_WEEKDAY[tea]]), isToday: todayTea === tea },
    todayTea: teaView(todayTea, todayStr, lang),
    season: ELEMENT_INFO[seasonElement] ? { element: seasonElement, name: T.seasonNames[seasonElement], line: T.seasonLines[seasonElement] } : null,
  };
}

// あなたの体質(app_me の constitutionProfile。最新3回の平均。DB が計算)→ 表示用
export function profileView(p, lang = "ja") {
  if (!p || !ELEMENT_INFO[p.primary]) return null;
  const T = ccText(lang), count = Number(p.count) || 1;
  const kind = kindOf(p.primary, p.balanced, p.scores);
  return { count, scores: p.scores, primary: p.primary, balanced: !!p.balanced, allHigh: kind === "allHigh", element: elementOf(p.primary, p.balanced, p.scores),
    typeName: typeNameOf(p.primary, p.balanced, p.scores, lang), typeLine: T.typeLines[kind],
    kanji: kanjiOf(p.primary, p.balanced, p.scores, lang), basisText: T.profileBasis(count) };
}

// これまでのチェック(app_me の constitutionHistory。新しい順・最大6回)→ 表示用(日付と五行の漢字の印)
export function historyView(list, lang = "ja") {
  return (Array.isArray(list) ? list : []).filter((h) => ELEMENT_INFO[h?.primary]).slice(0, 6).map((h) => ({
    checkedOn: h.checkedOn ?? null, dateText: shortDate(h.checkedOn), primary: h.primary, balanced: !!h.balanced, element: elementOf(h.primary, h.balanced, h.scores),
    kanji: kanjiOf(h.primary, h.balanced, h.scores, lang),
    typeName: typeNameOf(h.primary, h.balanced, h.scores, lang), scores: h.scores ?? null }));
}

// 会員証・体質チェックの画面で使う情報(app_me の constitution / constitutionProfile / constitutionHistory / todayTea / season)
//   todayPrompt: 来店した日(visitedToday)に、実施済みの方がまだ今日チェックしていなければ「今日の1分体質チェック」を出す(スキップは画面が端末に覚える: ccPromptVisible)。
//   初めての方(未実施)は今までどおりの入口だけ。今日の体調(3問)と季節の再チェックの案内はやめた(db/107)
export function constitutionCardView(member, nowMs = Date.now(), lang = "ja") {
  if (!member || typeof member.todayTea !== "string") return null;
  const T = ccText(lang);
  const c = member.constitution, today = jstDate(nowMs);
  const checkedToday = !!c?.checkedToday;
  const profile = profileView(member.constitutionProfile, lang);
  const ctx = { yourTea: profile?.primary ?? member.yourTea ?? null, todayTea: member.todayTea, seasonElement: member.season?.element ?? null, todayStr: today, lang };
  const result = c ? constitutionResultView(c, ctx) : null;
  return {
    done: !!c,
    entryLabel: c ? T.entryDone : T.checkName,
    entryHref: c ? "check.html?view=result" : "check.html",
    startHref: "check.html?start=1",
    consented: !!member.constitutionConsent,
    checkedToday,
    todayStr: today,
    todayPrompt: !!c && !!member.visitedToday && !checkedToday,
    latestLabel: c ? (checkedToday ? T.todayLabel : T.latestLabel(shortDate(c.checkedOn))) : null,
    profile,
    history: historyView(member.constitutionHistory, lang),
    todayTea: teaView(member.todayTea, today, lang),
    result,
  };
}
// 「今日はスキップ」: 端末に覚えた日付(日本時間)が今日なら、今日の案内を出さない
export const CC_SKIP_KEY = "10zen_cc_skip";
export const ccPromptVisible = (check, skippedOn) => !!check?.todayPrompt && skippedOn !== check.todayStr;

// 体質チェックの送信: constitutionSubmit() の結果 → 画面
export function checkSubmitScreen(res, nowMs = Date.now(), lang = "ja") {
  const m = msgs(lang);
  if (res.kind === "ok") return { screen: "result", view: constitutionCardView(res.data.member, nowMs, lang) };
  if (res.kind === "conflict" && res.code === "consent_required") return { screen: "consent", error: m.cc_consent_required };
  if (res.kind === "bad_request") return { screen: "error", retry: false, message: m.cc_invalid };
  if (res.kind === "not_registered") return { screen: "register", message: m.not_registered };
  if (res.kind === "maintenance") return { screen: "maintenance", retry: false, message: m.maintenance };
  if (res.kind === "auth_required") return { screen: "needs_login", message: m.needs_login };
  return { screen: "error", retry: res.kind !== "rate_limited", message: res.kind === "rate_limited" ? m.rate_limited : res.kind === "network_error" ? m.network_error : m.server_error };
}

// 会員証の画面: me() の結果 → 画面
export function cardScreen(res, nowMs = Date.now(), lang = "ja") {
  const m = msgs(lang);
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
  const m = msgs(lang);
  if (res.kind === "maintenance") return { screen: "maintenance", retry: false, message: m.maintenance };
  if (res.kind === "ok" && res.status === "outside_hours") return { screen: "checkin_outside_hours", message: m.checkin_outside_hours };
  if (res.kind === "ok") {
    const view = memberView(res.data.member, nowMs, lang);
    // 友だち紹介の初来店(db/106): 特典チケットを届けたことを添える
    const ref = res.data.referral?.ticket ? `${lang === "en" ? ". " : "。"}${m.invite_first_visit(ticketTitle({ title: res.data.referral.ticket, kind: "referral" }, lang))}` : "";   // チケット名も言語ごと(外部レビュー 2026-10-20)
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
  const m = msgs(lang);
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
  const m = msgs(lang);
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
