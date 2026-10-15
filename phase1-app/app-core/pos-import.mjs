// レジ(POS)の CSV から「日付」と「客数」だけを取り出す(スタッフ画面の店長用。ブラウザの中だけで読む。売上などほかの列は読まない・送らない)。
// 見た目に依存しない純粋な関数だけ。app-core/test_pos_import.mjs が擬似データ(app-core/fixtures/pos/)で確かめる。
//  * 文字コード: UTF-16(BOM つき LE/BE。BOM なしの LE も推定)・UTF-8(BOM あり/なし)・Shift_JIS。区切り: タブかカンマ(多い方)。"…" の囲みに対応。
//  * 列: 見出しの言葉で日付の列(日付・営業日・date)と客数の列(客数・人数・customers)を自動で選ぶ(「前年」「差」「客単」などは除く。「当年」を優先)。
//    選べないとき・違うときは、画面で列を選び直せる(analyzePosFile の mapping)。
//  * 縦持ちの形(「集計対象」の列があり、行ごとに 注文金額/客数 などが並ぶ形)は、集計対象が「客数」の行の「合計」の列を客数として読む。
//    客数の行がなければ no_customer_rows(例: 注文金額だけを出力したファイル)。
//  * 合計・週計・平均などの日付でない行、客数が空・数値でない行、同じ日付の2回目は飛ばし、理由を返す。
//  * 外れ値: 客数0の日と、そのファイルの客数の中央値の3倍を超える日に印を付ける(既定では取り込まない。画面で含められる)。
export const MAX_ROWS_PER_CALL = 400;           // manager_import_pos_customers の1回の上限(DB と同じ)
export const OUTLIER_FACTOR = 3;

const DATE_WORDS = /日付|営業日|年月日|date/i;
const CUSTOMER_WORDS = /客数|人数|来店数|customers?|guests?|covers/i;
const NOT_CURRENT = /前年|前差|差異|差客|客単|単価|率|平均|予算|比/;

// ---------- 文字コード ----------
export function decodeBytes(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dec = (enc, from = 0, fatal = false) => new TextDecoder(enc, { fatal }).decode(b.subarray(from));
  if (b[0] === 0xff && b[1] === 0xfe) return { text: dec("utf-16le", 2), encoding: "utf-16le" };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: dec("utf-16be", 2), encoding: "utf-16be" };
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: dec("utf-8", 3), encoding: "utf-8" };
  // BOM なしの UTF-16: 先頭の 2 バイトごとに 0 が多い
  const k = Math.min(b.length, 400); let zOdd = 0, zEven = 0;
  for (let i = 0; i < k; i++) if (b[i] === 0) (i % 2 ? zOdd++ : zEven++);
  if (k >= 4 && zOdd > k / 4 && zEven === 0) return { text: dec("utf-16le"), encoding: "utf-16le" };
  if (k >= 4 && zEven > k / 4 && zOdd === 0) return { text: dec("utf-16be"), encoding: "utf-16be" };
  try { return { text: dec("utf-8", 0, true), encoding: "utf-8" }; } catch (_e) { /* UTF-8 ではない */ }
  return { text: dec("shift_jis"), encoding: "shift_jis" };
}

// ---------- 区切りと囲み ----------
export function detectDelimiter(text) {
  const first = String(text).split(/\r?\n/).find((l) => l.trim() !== "") || "";
  const tabs = (first.match(/\t/g) || []).length, commas = (first.match(/,/g) || []).length;
  return tabs >= commas && tabs > 0 ? "\t" : ",";
}
export function parseDelimited(text, delim) {
  const rows = []; let row = [], cell = "", inQ = false; const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c;
    } else if (c === '"' && cell === "") inQ = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

// ---------- 値 ----------
const z2h = (s) => String(s ?? "").replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[／]/g, "/").replace(/[－ー−]/g, "-");
// 日付 → 'YYYY-MM-DD'(実在する日付だけ)。YYYYMMDD・YYYY/MM/DD(曜)・YYYY-MM-DD・YYYY/M/D・YYYY年M月D日
export function parseDate(v) {
  const s = z2h(v).trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s) || /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:\s*[(（][^)）]*[)）])?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s) || /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*[(（][^)）]*[)）])?$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 2000) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
// 客数 → 0 以上の整数(「1,234」「1,234人」「 12 」も可)。空・「-」・小数・負・文字は null
export function parseCount(v) {
  const s = z2h(v).replace(/[,，\s]/g, "").replace(/[人名組]$/, "");
  if (!/^\d{1,7}$/.test(s)) return null;
  return Number(s);
}

// ---------- 列の自動選択 ----------
const pick = (header, words) => {
  const cands = header.map((h, i) => ({ h: String(h).trim(), i })).filter((x) => words.test(x.h) && !NOT_CURRENT.test(x.h));
  if (!cands.length) return null;
  return (cands.find((x) => /当年|今年|本年/.test(x.h)) || cands[0]).i;
};
// 見出しの行: 先頭から 10 行のうち、日付の言葉を含む最初の行(なければ1行目)
export function findHeader(rows) {
  const k = rows.slice(0, 10).findIndex((r) => r.some((c) => DATE_WORDS.test(String(c))));
  return k >= 0 ? k : 0;
}
export function detectColumns(header) {
  const kindCol = header.findIndex((h) => /集計対象/.test(String(h)));
  const dateCol = pick(header, DATE_WORDS), customersCol = pick(header, CUSTOMER_WORDS);
  if (kindCol >= 0 && customersCol === null) {
    const totalCol = header.findIndex((h) => /^(合計|計|total)$/i.test(String(h).trim()));
    return { layout: "long", dateCol, customersCol: totalCol >= 0 ? totalCol : null, kindCol };
  }
  return { layout: "wide", dateCol, customersCol, kindCol: -1 };
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

// ---------- 全体 ----------
// 戻り値: { ok, error?, encoding, delimiter, header, headerRow, mapping, days:[{date, customers, line, flag}], skipped:[{line, reason, value}], median, months:[…] }
//  error: empty(中身がない)/ no_date_column / no_customers_column / no_customer_rows(縦持ちで客数の行がない)/ no_days(日付と客数の組が1つもない)
//  mapping を渡すと列を選び直せる({ dateCol, customersCol }。縦持ちのファイルでは集計対象が「客数」の行に限る)
//  today('YYYY-MM-DD'。日本時間の今日)を渡すと、それより後の日付は future_date として飛ばす(DB も未来の日付は受け付けない)
export function analyzePosFile(bytes, { mapping = null, today = null } = {}) {
  const { text, encoding } = decodeBytes(bytes);
  const delimiter = detectDelimiter(text);
  const all = parseDelimited(text, delimiter);
  const base = { encoding, delimiter, header: [], headerRow: 0, days: [], skipped: [], median: null, months: [] };
  if (!all.length) return { ...base, ok: false, error: "empty" };
  const headerRow = findHeader(all), header = all[headerRow].map((h) => String(h).trim());
  const auto = detectColumns(header);
  const map = { ...auto, ...(mapping ? { dateCol: mapping.dateCol ?? auto.dateCol, customersCol: mapping.customersCol ?? auto.customersCol } : {}) };
  const res = { ...base, header, headerRow, mapping: map, autoMapping: auto };
  if (map.dateCol === null || map.dateCol < 0 || map.dateCol >= header.length) return { ...res, ok: false, error: "no_date_column" };
  if (map.customersCol === null || map.customersCol < 0 || map.customersCol >= header.length) return { ...res, ok: false, error: "no_customers_column" };
  const body = all.slice(headerRow + 1).map((r, i) => ({ r, line: headerRow + i + 2 }));
  let rows = body;
  if (map.layout === "long") {
    rows = body.filter(({ r }) => /客数/.test(String(r[map.kindCol] ?? "")));
    if (!rows.length) return { ...res, ok: false, error: "no_customer_rows", kinds: [...new Set(body.map(({ r }) => String(r[map.kindCol] ?? "").trim()).filter(Boolean))] };
    for (const { r, line } of body) if (!/客数/.test(String(r[map.kindCol] ?? ""))) res.skipped.push({ line, reason: "not_customers_row", value: String(r[map.kindCol] ?? "").trim() });
  }
  const seen = new Set();
  for (const { r, line } of rows) {
    const rawDate = String(r[map.dateCol] ?? "").trim(), date = parseDate(rawDate);
    if (!date) { res.skipped.push({ line, reason: "not_a_date", value: rawDate }); continue; }
    if (today && date > today) { res.skipped.push({ line, reason: "future_date", value: date, date }); continue; }
    const rawC = String(r[map.customersCol] ?? "").trim(), c = parseCount(rawC);
    if (c === null) { res.skipped.push({ line, reason: "bad_customers", value: rawC, date }); continue; }
    if (seen.has(date)) { res.skipped.push({ line, reason: "duplicate_date", value: date, date }); continue; }
    seen.add(date); res.days.push({ date, customers: c, line, flag: null });
  }
  if (!res.days.length) return { ...res, ok: false, error: "no_days" };
  res.days.sort((a, b) => (a.date < b.date ? -1 : 1));
  res.median = median(res.days.map((d) => d.customers));
  for (const d of res.days) d.flag = d.customers === 0 ? "zero" : res.median > 0 && d.customers > OUTLIER_FACTOR * res.median ? "high" : null;
  res.months = summarize(res.days);
  return { ...res, ok: true };
}

// 月ごとのまとめ(取り込む日だけ: include は外れ値のうち含める日付の集合。省略時は外れ値を含めない)
export function summarize(days, include = new Set()) {
  const by = new Map();
  for (const d of days) {
    const m = d.date.slice(0, 7); const x = by.get(m) || { month: m, days: 0, customers: 0, flagged: 0, excluded: 0 };
    if (d.flag) x.flagged++;
    if (d.flag && !include.has(d.date)) x.excluded++; else { x.days++; x.customers += d.customers; }
    by.set(m, x);
  }
  return [...by.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

// 取り込む行([{date, customers}])。外れ値は include にある日付だけ含める
export function rowsForImport(days, include = new Set()) {
  return days.filter((d) => !d.flag || include.has(d.date)).map((d) => ({ date: d.date, customers: d.customers }));
}
export function chunk(rows, size = MAX_ROWS_PER_CALL) { const out = []; for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size)); return out; }

// 画面の文言(飛ばした理由・エラー)
export const SKIP_REASONS = { not_a_date: "日付ではない行(合計・週計・平均など)", bad_customers: "客数が空か数値ではない", duplicate_date: "同じ日付の2回目", future_date: "今日より後の日付", not_customers_row: "客数ではない行(注文金額など)" };
export const ERRORS = {
  empty: "ファイルの中身がありません",
  no_date_column: "日付の列が見つかりません。下で列を選んでください",
  no_customers_column: "客数の列が見つかりません。下で列を選んでください",
  no_customer_rows: "このファイルには客数の行がありません(注文金額だけの出力など)。レジで「客数」を含めて出力したファイルを選んでください",
  no_days: "日付と客数の組が1つも読み取れませんでした。列の選び方を確かめてください",
};
export const ENCODING_LABELS = { "utf-16le": "UTF-16", "utf-16be": "UTF-16(BE)", "utf-8": "UTF-8", shift_jis: "Shift_JIS" };
