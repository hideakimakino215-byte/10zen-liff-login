// 使い捨てのローカル PostgreSQL 16 を起動して SQL / RPC を実行する検証用ハーネス(本番には接続しない)。
// RPC は呼び出しごとに別の psql プロセス(=別接続)で実行するので、同時実行は本物の並列になる。
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, copyFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PGBIN = "/usr/lib/postgresql/16/bin";
const HERE = dirname(fileURLToPath(import.meta.url));
const DBDIR = join(HERE, "..", "db");
const sh = (cmd) => { const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`); return r.stdout; };
export const q = (v) => v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`;

export function startPg() {
  const base = mkdtempSync(join(tmpdir(), "pgt-"));
  const data = join(base, "data"), sock = join(base, "s");
  sh(`mkdir -p ${sock} && chown -R postgres ${base} && chmod 755 ${base}`);
  sh(`su postgres -c "${PGBIN}/initdb -D ${data} -A trust >/dev/null"`);
  sh(`su postgres -c "${PGBIN}/pg_ctl -D ${data} -o '-p 55433 -k ${sock} -c listen_addresses= -c max_connections=100' -l ${base}/log -w start >/dev/null"`);
  const psqlArgs = ["-h", sock, "-p", "55433", "-U", "postgres", "-d", "t", "-v", "ON_ERROR_STOP=1", "-q", "-X", "-At"];
  sh(`psql -h ${sock} -p 55433 -U postgres -d postgres -q -X -c "create database t"`);
  const run = (sql) => { const r = spawnSync("psql", psqlArgs, { input: sql, encoding: "utf8" }); return r; };
  const exec = (sql) => { const r = run(sql); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const runAsync = (sql) => new Promise((res) => {
    const p = spawn("psql", psqlArgs); let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ status: code, stdout: out.trim(), stderr: err.trim() }));
    p.stdin.end(sql);
  });
  const loadFile = (name) => exec(readFileSync(join(DBDIR, name), "utf8"));
  const stop = () => { try { sh(`su postgres -c "${PGBIN}/pg_ctl -D ${data} -m immediate stop >/dev/null"`); } catch (_e) {} };
  return { exec, run, runAsync, loadFile, stop };
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
