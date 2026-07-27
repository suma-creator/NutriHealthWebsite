// supabase/functions/whatsapp-verify/index.ts
//
// Handles the whole WhatsApp Reminders setup flow for Settings:
//   action "get-status"   -> read the caller's whatsapp_settings row
//   action "send-code"    -> generate + hash an OTP, store it, send it via WhatsApp
//   action "verify-code"  -> check the OTP the user typed, mark the number verified
//   action "toggle"       -> turn WhatsApp reminders on/off for an already-verified number
//
// whatsapp_settings has no client insert/update RLS policy on purpose (see
// sql/schema.sql, section 18) — a user must never be able to mark a number
// "verified" without actually receiving a code on it. So every write here
// goes through the service-role "adminClient", gated by first resolving the
// real logged-in user from their own Authorization header via "callerClient".
// This is the same two-client pattern used in delete-account/index.ts.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendGreenApiMessage } from "../_shared/whatsapp-providers.ts";
import { generateOtp, hashOtp, isValidE164 } from "../_shared/otp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const OTP_TTL_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getCallerUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const callerClient = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_ANON_KEY") as string,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error } = await callerClient.auth.getUser();
  if (error || !user) return null;
  return user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let body: any = {};
    const text = await req.text();
    if (text) body = JSON.parse(text);

    // -------------------------------------------------
    // Green API incoming-message webhook (no user auth — Green API calls
    // this directly, not the browser). Left as a no-op passthrough.
    // -------------------------------------------------
    if (body.typeWebhook === "incomingMessageReceived") {
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    const action = body.action || (req.method === "GET" ? "get-status" : null);
    if (!action) {
      return json({ success: false, error: "Invalid action." }, 400);
    }

    const user = await getCallerUser(req);
    if (!user) {
      return json({ success: false, error: "Please log in again." }, 401);
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL") as string,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
    );

    // -------------------------------------------------
    // Status
    // -------------------------------------------------
    if (action === "get-status") {
      const { data: row } = await adminClient
        .from("whatsapp_settings")
        .select("phone_number, enabled, verified, verified_at, last_send_error")
        .eq("user_id", user.id)
        .maybeSingle();

      return json({
        success: true,
        configured: !!row?.verified,
        phone_number: row?.phone_number ?? null,
        verified: !!row?.verified,
        enabled: !!row?.enabled,
        last_send_error: row?.last_send_error ?? null,
      });
    }

    // -------------------------------------------------
    // Send OTP
    // -------------------------------------------------
    if (action === "send-code") {
      const phoneNumber = (body.phone_number || body.phone || "").trim();

      if (!phoneNumber || !isValidE164(phoneNumber)) {
        return json({ success: false, error: "Enter a valid number in international format, e.g. +8801XXXXXXXXX." }, 400);
      }

      const otpCode = generateOtp();
      const otpHash = await hashOtp(otpCode);
      const message = `Your NutriHealth verification code is: ${otpCode}. Valid for ${OTP_TTL_MINUTES} minutes.`;

      try {
        await sendGreenApiMessage(phoneNumber, message);
      } catch (sendError) {
        await adminClient.from("whatsapp_settings").upsert({
          user_id: user.id,
          phone_number: phoneNumber,
          last_send_error: sendError instanceof Error ? sendError.message : String(sendError),
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });

        return json({ success: false, error: "Couldn't send the code. Check the number and try again." }, 502);
      }

      const { error: upsertError } = await adminClient.from("whatsapp_settings").upsert({
        user_id: user.id,
        phone_number: phoneNumber,
        verified: false,
        otp_code_hash: otpHash,
        otp_expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString(),
        otp_attempts: 0,
        last_send_error: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      if (upsertError) {
        return json({ success: false, error: "Couldn't save your number. Please try again." }, 500);
      }

      return json({ success: true, message: "OTP sent successfully." });
    }

    // -------------------------------------------------
    // Verify OTP
    // -------------------------------------------------
    if (action === "verify-code") {
      const code = (body.code || body.otp || "").trim();
      if (!/^\d{6}$/.test(code)) {
        return json({ success: false, error: "Enter the 6-digit code." }, 400);
      }

      const { data: row } = await adminClient
        .from("whatsapp_settings")
        .select("phone_number, otp_code_hash, otp_expires_at, otp_attempts")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!row || !row.otp_code_hash) {
        return json({ success: false, error: "Request a new code first." }, 400);
      }
      if (row.otp_attempts >= MAX_OTP_ATTEMPTS) {
        return json({ success: false, error: "Too many attempts. Request a new code." }, 429);
      }
      if (!row.otp_expires_at || new Date(row.otp_expires_at).getTime() < Date.now()) {
        return json({ success: false, error: "That code expired. Request a new one." }, 400);
      }

      const submittedHash = await hashOtp(code);
      if (submittedHash !== row.otp_code_hash) {
        await adminClient.from("whatsapp_settings")
          .update({ otp_attempts: (row.otp_attempts || 0) + 1, updated_at: new Date().toISOString() })
          .eq("user_id", user.id);
        return json({ success: false, error: "Incorrect code." }, 400);
      }

      const { error: updateError } = await adminClient.from("whatsapp_settings").update({
        verified: true,
        verified_at: new Date().toISOString(),
        enabled: true,
        otp_code_hash: null,
        otp_expires_at: null,
        otp_attempts: 0,
        updated_at: new Date().toISOString(),
      }).eq("user_id", user.id);

      if (updateError) {
        return json({ success: false, error: "Couldn't confirm verification. Please try again." }, 500);
      }

      return json({ success: true, phone_number: row.phone_number, enabled: true });
    }

    // -------------------------------------------------
    // Toggle on/off (number must already be verified)
    // -------------------------------------------------
    if (action === "toggle") {
      const enabled = !!body.enabled;

      const { data: row } = await adminClient
        .from("whatsapp_settings")
        .select("verified")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!row?.verified) {
        return json({ success: false, error: "Verify a WhatsApp number first." }, 400);
      }

      const { error: updateError } = await adminClient.from("whatsapp_settings")
        .update({ enabled, updated_at: new Date().toISOString() })
        .eq("user_id", user.id);

      if (updateError) {
        return json({ success: false, error: "Couldn't update the setting. Please try again." }, 500);
      }

      return json({ success: true, enabled });
    }

    return json({ success: false, error: "Invalid action." }, 400);
  } catch (error) {
    console.error("whatsapp-verify error:", error);
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred.",
    }, 500);
  }
});
