// 画面の状態と表示用データ(見た目に依存しない)。UI は screen 名で分岐し、view の項目をそのまま表示する。
// 文言は messages に集約(差し替え可能)。数値の未取得は null のまま渡し、画面側で「—」と表示する(0 に変換しない)。
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
  },
};
const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("ja-JP"));
const jpDate = (s) => (typeof s === "string" ? s.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1年$2月$3日") : null);
const codeText = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

// ランクごとの『来るたびに使える特典』(チケットではない。会員証に文字で出す)。上のランクは下のランクの特典も続けて使える。
//   small: true は小さく添える行(薬日本堂のご優待は暫定。中身は未定なので表示だけ)
const RANK_ORDER = ["white_opal", "amber", "emerald", "ruby", "onyx"];
export const RANK_PERKS = [
  ["amber", "ディナーの漢方茶 無料"],
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
  };
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
    return res.status === "counted" ? { screen: "checkin_success", granted: res.data.granted, message: m.checkin_counted(res.data.granted), view }
                                    : { screen: "checkin_already", reason: res.data.reason, message: res.data.reason === "registered_today" ? m.checkin_registered_today : m.checkin_already, view };
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
