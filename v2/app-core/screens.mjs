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
  },
};
const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("ja-JP"));

export function memberView(member, nowMs = Date.now(), lang = "ja") {
  if (!member) return null;
  const m = messages[lang];
  const pend = member.pendingRedeem;
  const left = pend ? Math.max(0, Math.floor((Date.parse(pend.expiresAt) - nowMs) / 1000)) : null;
  const exp = member.expiresOn ? member.expiresOn.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1年$2月$3日") : null;
  return {
    displayName: member.displayName ?? "会員",           // 氏名未取得でも画面は成立させる
    memberNo: member.memberNo,
    rank: member.rank, rankLabel: member.rankLabel,
    points: member.points, pointsText: `${fmt(member.points)} pt`,
    yenText: member.points === null ? "—" : `${fmt(Math.floor(member.points * member.yenPer100pt / 100))}円相当`,
    lifetimeText: `${fmt(member.lifetimePoints)} pt`, lifetimeNote: member.lifetimeConfirmed ? null : m.lifetime_unconfirmed,
    next: member.nextRank ? { label: member.nextRank.label, remainingText: `あと ${fmt(member.nextRank.remainingPoints)} pt`, percent: member.nextRank.percent } : { label: null, remainingText: m.top_rank, percent: 100 },
    expiresText: exp,
    visitedToday: !!member.visitedToday,
    canRedeem: !pend && member.points >= member.redeemUnit,
    redeemUnit: member.redeemUnit,
    pending: pend ? { code: pend.code, codeText: `${pend.code.slice(0, 3)} ${pend.code.slice(3)}`, points: pend.points, yen: pend.yen, secondsLeft: left, expired: left === 0 } : null,
    lastRedeem: member.lastRedeem ? { ...member.lastRedeem, message: member.lastRedeem.status === "confirmed" ? m.redeem_confirmed(member.lastRedeem.points, member.lastRedeem.yen) : member.lastRedeem.status === "cancelled" ? m.redeem_cancelled : m.redeem_expired } : null,
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
