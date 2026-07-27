// supabase/functions/delete-account/index.ts
//
// Deletes the CALLING user's own account and, via the existing
// "on delete cascade" foreign keys, every row of their data across the
// app's tables. This can only run server-side because deleting an auth
// user requires the service-role key, which must never reach the browser.
//
// Security: this function requires a valid JWT (verify_jwt = true in
// config.toml — the request is rejected before it even reaches this code
// if the token is missing/invalid). It then re-derives the user from that
// same token itself (defense in depth) and only ever deletes THAT user —
// there is no way to pass a different user id in and delete someone else.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ ok: false, error: "Missing authorization." }, 401);
    }

    // Client scoped to the caller's own token — used only to find out who they are.
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL") as string,
      Deno.env.get("SUPABASE_ANON_KEY") as string,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) {
      return json({ ok: false, error: "Could not verify your identity. Please log in again." }, 401);
    }

    // Admin client (service role) — the only client capable of deleting auth users.
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL") as string,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
    );

    const { error: deleteErr } = await adminClient.auth.admin.deleteUser(user.id);
    if (deleteErr) {
      console.error("Account deletion failed:", deleteErr);
      return json({ ok: false, error: "Failed to delete account. Please try again or contact support." }, 500);
    }

    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("delete-account error:", message);
    return json({ ok: false, error: message }, 500);
  }
});
