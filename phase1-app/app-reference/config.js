// 配信時に設定する値(秘密ではない公開値のみ。service_role / 秘密鍵は絶対に置かない)
window.APP_CONFIG = {
  liffId: "2011158053-N7nKgExB",
  memberApi: "https://ynqnhjvrzqdrfmvmudir.supabase.co/functions/v1/member-api",
  staffQrApi: "https://ynqnhjvrzqdrfmvmudir.supabase.co/functions/v1/staff-qr",
  supabaseUrl: "https://ynqnhjvrzqdrfmvmudir.supabase.co",
  supabaseKey: "",          // 公開(anon/publishable)キー。デプロイ時に設定
};
