// 使い捨てのローカル PostgreSQL 16 を起動して SQL / RPC を実行する検証用ハーネス(本番には接続しない)。
// RPC は呼び出しごとに別の psql プロセス(=別接続)で実行するので、同時実行は本物の並列になる。
// 後片付け(監査 L-6): stop() でサーバーを止め、作業用のディレクトリ(<tmp>/pgt-*)も消す。stop() を呼ばずに終わったとき
//   (例外・process.exit・Ctrl-C・SIGTERM)も、終了時のフックで同じことをする。起動の途中で失敗したときも消す。
//   ディレクトリ名は pgt-<PGT_RUN_ID>-…(run_tests.sh が実行ごとの ID を渡し、最後に残っていないことを確かめる)。
// ポート: 接続は各インスタンス専用のディレクトリの UNIX ソケットだけ(TCP は使わない)。番号はプロセス ID と通し番号から決め、
//   起動に失敗したら別の番号で数回やり直す(以前は 55433 固定で、同時に2つ動かすとぶつかった)。
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, constants as osConstants } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PGBIN = "/usr/lib/postgresql/16/bin";
const HERE = dirname(fileURLToPath(import.meta.url));
const DBDIR = join(HERE, "..", "db");
const sh = (cmd) => { const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`); return r.stdout; };
export const q = (v) => v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`;

const RUN_ID = String(process.env.PGT_RUN_ID || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
const PREFIX = RUN_ID ? `pgt-${RUN_ID}-` : "pgt-";
const live = new Set();                 // 止めていない(消していない)インスタンスの stop
let seq = 0;
const nextPort = (attempt) => 20000 + ((process.pid * 7 + seq++ * 101 + attempt * 9973) % 40000);
let hooked = false;
function hookExit() {
  if (hooked) return; hooked = true;
  process.on("exit", () => { for (const stop of [...live]) stop(); });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, () => { for (const stop of [...live]) stop(); process.exit(128 + (osConstants.signals[sig] || 0)); });
  }
}

export function startPg() {
  hookExit();
  const base = mkdtempSync(join(tmpdir(), PREFIX));
  const data = join(base, "data"), sock = join(base, "s");
  let started = false, stopped = false, port = 0;
  const stop = () => {
    if (stopped) return; stopped = true; live.delete(stop);
    if (started) { try { sh(`su postgres -c "${PGBIN}/pg_ctl -D ${data} -m immediate stop >/dev/null"`); } catch (_e) {} }
    try { rmSync(base, { recursive: true, force: true }); } catch (_e) {}
  };
  live.add(stop);
  try {
    sh(`mkdir -p ${sock} && chown -R postgres ${base} && chmod 755 ${base}`);
    sh(`su postgres -c "${PGBIN}/initdb -D ${data} -A trust >/dev/null"`);
    let lastErr = null;
    for (let attempt = 0; attempt < 5 && !started; attempt++) {
      port = nextPort(attempt);
      try {
        sh(`su postgres -c "${PGBIN}/pg_ctl -D ${data} -o '-p ${port} -k ${sock} -c listen_addresses= -c max_connections=100' -l ${base}/log -w start >/dev/null"`);
        started = true;
      } catch (e) { lastErr = e; }
    }
    if (!started) throw lastErr;
    sh(`psql -h ${sock} -p ${port} -U postgres -d postgres -q -X -c "create database t"`);
  } catch (e) { stop(); throw e; }
  const psqlArgs = ["-h", sock, "-p", String(port), "-U", "postgres", "-d", "t", "-v", "ON_ERROR_STOP=1", "-q", "-X", "-At"];
  const run = (sql) => { const r = spawnSync("psql", psqlArgs, { input: sql, encoding: "utf8" }); return r; };
  const exec = (sql) => { const r = run(sql); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const runAsync = (sql) => new Promise((res) => {
    const p = spawn("psql", psqlArgs); let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ status: code, stdout: out.trim(), stderr: err.trim() }));
    p.stdin.end(sql);
  });
  const loadFile = (name) => exec(readFileSync(join(DBDIR, name), "utf8"));
  // 別のデータベース(同じサーバ内)。バックアップ→復元の訓練で、空のDBに復元するために使う
  const dbArgs = (db) => psqlArgs.map((a, i) => (psqlArgs[i - 1] === "-d" ? db : a));
  const createDb = (db) => sh(`psql -h ${sock} -p ${port} -U postgres -d postgres -q -X -c "create database ${db}"`);
  const execIn = (db, sql) => { const r = spawnSync("psql", dbArgs(db), { input: sql, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const loadFileIn = (db, name) => execIn(db, readFileSync(join(DBDIR, name), "utf8"));
  return { exec, run, runAsync, loadFile, createDb, execIn, loadFileIn, stop, base, port };
}

// supabase-js 互換の最小アダプター(handler が使う範囲だけ): from("stores").select().eq().single() と rpc()
export function supabaseOver(pg, hooks = {}) {
  const calls = [];
  const rpcCall = async (name, args) => {
    calls.push(["rpc", name]);
    if (hooks.beforeRpc) { const e = hooks.beforeRpc(name, args); if (e) return { data: null, error: e }; }
    const order = { record_membership_checkin: ["p_store_id", "p_line_user_id", "p_event_key", "p_event_at", "p_points", "p_rank", "p_lifetime", "p_user_id", "p_seq"],
                    sync_membership_points: ["p_store_id", "p_line_user_id", "p_points", "p_seq", "p_rank", "p_lifetime", "p_user_id", "p_last_visited_at"] }[name];
    const casts = { p_store_id: "uuid", p_event_at: "timestamptz", p_seq: "bigint", p_last_visited_at: "timestamptz", p_points: "integer", p_lifetime: "integer" };
    const parts = order.map((k) => `${q(args[k])}${casts[k] ? "::" + casts[k] : "::text"}`);
    const r = await pg.runAsync(`select public.${name}(${parts.join(",")});`);
    if (r.status !== 0) return { data: null, error: { message: r.stderr, code: (/ERROR:\s+(\w+)/.exec(r.stderr) || [])[1] } };
    return { data: JSON.parse(r.stdout), error: null };
  };
  return {
    calls,
    rpc: rpcCall,
    from(table) {
      const f = {}; const b = {
        select() { return b; }, eq(k, v) { f[k] = v; return b; },
        async single() {
          const where = Object.entries(f).map(([k, v]) => `${k}=${q(v)}`).join(" and ");
          const r = pg.run(`select row_to_json(t) from (select id from ${table} where ${where} limit 1) t;`);
          if (r.status !== 0) return { data: null, error: { message: r.stderr } };
          return r.stdout.trim() ? { data: JSON.parse(r.stdout.trim()), error: null } : { data: null, error: { message: "no rows" } };
        },
      };
      return b;
    },
  };
}
