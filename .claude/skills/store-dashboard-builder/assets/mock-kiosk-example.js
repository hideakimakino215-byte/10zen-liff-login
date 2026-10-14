// 店頭タブレットの QR 画面(qr.html)用の擬似データの例。本番に接続しない。
// ログイン: kiosk@t / pw(店頭QR専用)。staff@t / pw は「店頭QR専用ではない」ので入れない例。
// QR の中身は 30 秒ごとに変わる見本の URL(実際の来店には使えない)。
window.APP_CONFIG = { supabaseUrl: "preview", supabaseKey: "preview", staffQrApi: "/preview-staff-qr" };
(function () {
  const ACC = { "kiosk@t": { role: "kiosk", displayName: "店頭タブレット" }, "staff@t": { role: "staff", displayName: "青山店" }, "mgr@t": { role: "manager", displayName: "青山店 店長" } };
  let me = null;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.supabase = { createClient: () => ({
    auth: {
      signInWithPassword: async ({ email, password }) => { await wait(150); if (ACC[email] && password === "pw") { me = email; return { data: {}, error: null }; } return { data: null, error: { message: "invalid" } }; },
      signOut: async () => { me = null; return { error: null }; },
      getSession: async () => ({ data: { session: me ? { access_token: "preview-" + me } : null } }),
    },
    rpc: async (name) => { await wait(100); if (name === "staff_whoami") return { data: me ? { active: true, ...ACC[me] } : { active: false }, error: null }; return { data: null, error: { message: "forbidden" } }; },
  }) };
  // staff-qr 関数の代わり: 30 秒ごとに変わる見本の URL を返す
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (String(url) === window.APP_CONFIG.staffQrApi) {
      await wait(120);
      if (!me || ACC[me].role === "staff") return new Response("{}", { status: 403 });
      const slot = Math.floor(Date.now() / 30000), rand = Math.random().toString(36).slice(2, 12);
      return new Response(JSON.stringify({ url: `https://liff.line.me/preview?action=visit&t=${slot}.${rand}`, nextChangeAt: (slot + 1) * 30000 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url, opts);
  };
})();
