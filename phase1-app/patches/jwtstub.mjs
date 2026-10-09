// テスト用: JWT の形をした ID トークンと、LINE の検証 API(https://api.line.me/oauth2/v2.1/verify)の代替。
// 本物の署名検証は LINE 側が行う。ここでは署名部が "BAD" のものを拒否し、それ以外はペイロードをそのまま『検証済みの値』として返す。
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const makeJwt = ({ sub, name, aud = "2011158053", exp, nowMs = Date.now(), bad = false }) =>
  `eyJhbGciOiJIUzI1NiJ9.${b64({ iss: "https://access.line.me", sub, aud, exp: exp ?? Math.floor(nowMs / 1000) + 3600, name })}.${bad ? "BAD" : "c2lnbmF0dXJl"}`;
export const lineVerify = (nowMs = () => Date.now(), counter = { n: 0 }) => async (_url, init) => {
  counter.n++;
  const p = new URLSearchParams(init.body), t = p.get("id_token") || "", parts = t.split(".");
  if (parts.length !== 3 || parts[2] === "BAD") return new Response("{}", { status: 400 });
  const c = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (c.aud !== p.get("client_id") || c.exp <= Math.floor(nowMs() / 1000)) return new Response("{}", { status: 400 });
  return new Response(JSON.stringify(c), { status: 200 });
};
