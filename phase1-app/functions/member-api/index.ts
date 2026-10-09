import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handle } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false } });
const deps = {
  fetchFn: fetch, supabase,
  lineLoginChannelId: Deno.env.get("LINE_LOGIN_CHANNEL_ID") || "2011158053",       // LIFF ID(2011158053-…)の先頭。秘密ではない
  qrSecret: Deno.env.get("MEMBERSHIP_CHECKIN_SECRET") || "",
  businessUnit: Deno.env.get("BUSINESS_UNIT") || "10zen_aoyama",
  allowedOrigins: (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean),
  nowMs: () => Date.now(),
};
serve((req) => handle(req, deps));
