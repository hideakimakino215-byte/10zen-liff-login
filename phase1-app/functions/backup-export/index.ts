import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";   // 版を固定(esm.sh の「@2」は最新版を取りに行き、2026-10-15 に組み立てが失敗した)
import { handle } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false } });
serve((req) => handle(req, { supabase, secret: Deno.env.get("MEMBERSHIP_CHECKIN_SECRET") || "", nowMs: () => Date.now() }));
