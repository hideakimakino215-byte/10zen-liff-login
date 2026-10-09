import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handle } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false } });
serve((req) => handle(req, { supabase, secret: Deno.env.get("MEMBERSHIP_CHECKIN_SECRET") || "", nowMs: () => Date.now() }));
