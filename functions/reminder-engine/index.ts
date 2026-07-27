// supabase/functions/reminder-engine/index.ts
//
// The Reminder Engine's cron "tick" — see docs/REMINDER_ENGINE.md.
// Meant to be called by a scheduler roughly once a minute, NOT by the
// browser. Each tick:
//   1. Verifies the x-cron-secret header (if CRON_SECRET is set).
//   2. Calls public.get_due_reminders() — a service-role-only Postgres
//      function that returns every reminder occurrence due right now,
//      already converted into each user's own local timezone.
//   3. For each due occurrence, tries to INSERT it into reminder_history
//      first. The table's unique constraint rejects a duplicate insert,
//      which is what makes the "never send the same reminder twice"
//      guarantee real even if a tick overlaps or retries.
//   4. If the insert succeeds (this occurrence hasn't fired before), sends
//      the reminder over WhatsApp when the user has a verified + enabled
//      number, otherwise (or on a WhatsApp failure) falls back to writing
//      a row into `notifications` for the in-app/browser toast in
//      js/shell.js to pick up.
//   5. Updates the reminder_history row's status/channel/error_message to
//      reflect what actually happened, and — on a WhatsApp failure —
//      whatsapp_settings.last_send_error, surfaced in Settings.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendGreenApiMessage } from "../_shared/whatsapp-providers.ts";
import { reminderTitle, reminderBody, reminderWhatsAppText } from "../_shared/reminder-copy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type DueReminder = {
  user_id: string;
  reminder_type: string;
  source:
    | "primary" | "additional" | "medicine"
    | "sleep_pre_30" | "sleep_pre_15" | "sleep_morning"
    | "additional_sleep_pre_30" | "additional_sleep_pre_15" | "additional_sleep_morning"
    | "sleep_snooze";
  schedule_id: string;
  label: string | null;
  local_date: string; // YYYY-MM-DD
  local_time: string; // HH:MM:SS
  timezone: string;
  // Phase 2 — the schedule's own configured snooze length (10/15/30),
  // straight from get_due_reminders. Null for medicine and for an
  // already-snoozed occurrence (no re-snoozing a snooze).
  snooze_minutes: number | null;
  // Phase 2 fix — the user's own sleep goal (reminder_settings.goal_hours,
  // editable in Sleep tracking), so the bedtime notification says the
  // right number instead of a hardcoded "8 hours". Null for anything
  // that isn't a sleep-type occurrence.
  goal_hours: number | null;
};

const MORNING_SOURCES = new Set(["sleep_morning", "additional_sleep_morning"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Lock down the cron endpoint — if CRON_SECRET isn't set, the function
  // still runs (useful for local testing), matching docs/REMINDER_ENGINE.md.
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") !== cronSecret) {
    return json({ success: false, error: "Unauthorized." }, 401);
  }

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL") as string,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
  );

  try {
    const { data: due, error: dueError } = await adminClient.rpc("get_due_reminders", { p_window_minutes: 2 });

    if (dueError) {
      console.error("get_due_reminders failed:", dueError);
      return json({ success: false, error: dueError.message }, 500);
    }

    const dueReminders = (due || []) as DueReminder[];
    const results: Array<{ user_id: string; reminder_type: string; outcome: string }> = [];

    for (const reminder of dueReminders) {
      results.push(await processDueReminder(adminClient, reminder));
    }

    return json({ success: true, checked: dueReminders.length, results });
  } catch (error) {
    console.error("reminder-engine error:", error);
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred.",
    }, 500);
  }
});

// Looks up the user's most recent sleep_logs entry from the ~18 hours
// before their wake-up time (covers a late-night log for that same
// "night") to personalize the morning notification. Returns null (falls
// back to a generic "Rise and shine!" in reminder-copy.ts) if nothing
// was logged — logging sleep is optional, so this must never block the
// notification from sending.
async function lastNightSleepDurationLabel(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  localDate: string
): Promise<string | null> {
  try {
    const sinceIso = new Date(new Date(`${localDate}T00:00:00Z`).getTime() - 18 * 60 * 60 * 1000).toISOString();
    const { data, error } = await adminClient
      .from("sleep_logs")
      .select("sleep_hours, created_at")
      .eq("user_id", userId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    const totalMinutes = Math.round(Number(data.sleep_hours) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  } catch {
    return null;
  }
}

async function processDueReminder(adminClient: ReturnType<typeof createClient>, reminder: DueReminder) {
  const { user_id, reminder_type, source, schedule_id, label, local_date, local_time, snooze_minutes, goal_hours } = reminder;

  // Step 1 — claim this exact occurrence. If another tick already inserted
  // this row, Postgres' unique constraint makes this fail and we stop here
  // without sending anything a second time.
  const { data: historyRow, error: claimError } = await adminClient
    .from("reminder_history")
    .insert({
      user_id,
      reminder_type,
      source,
      schedule_id,
      scheduled_date: local_date,
      scheduled_time: local_time,
      status: "sent", // optimistic; corrected below if delivery fails
    })
    .select("id")
    .single();

  if (claimError) {
    // Unique-violation (already sent this occurrence) or any other insert
    // failure both just mean "don't send" — nothing more to do. Still mark
    // a snoozed occurrence consumed so it doesn't keep matching the tick
    // window for its remaining minute(s).
    if (source === "sleep_snooze") await markSnoozeConsumed(adminClient, schedule_id);
    return { user_id, reminder_type, outcome: "skipped-duplicate" };
  }

  const localTimeLabel = local_time.slice(0, 5); // HH:MM
  const sleepDurationLabel = MORNING_SOURCES.has(source)
    ? await lastNightSleepDurationLabel(adminClient, user_id, local_date)
    : null;
  const title = reminderTitle(reminder_type, source);
  const body = reminderBody(reminder_type, label, source, sleepDurationLabel, goal_hours);
  const whatsappText = reminderWhatsAppText(reminder_type, label, localTimeLabel, source, sleepDurationLabel, goal_hours);

  const { data: wa } = await adminClient
    .from("whatsapp_settings")
    .select("phone_number, enabled, verified")
    .eq("user_id", user_id)
    .maybeSingle();

  let channel: "whatsapp" | "in_app" = "in_app";
  let status: "sent" | "failed" = "sent";
  let errorMessage: string | null = null;

  if (wa?.enabled && wa?.verified && wa?.phone_number) {
    try {
      await sendGreenApiMessage(wa.phone_number, whatsappText);
      channel = "whatsapp";
    } catch (sendError) {
      errorMessage = sendError instanceof Error ? sendError.message : String(sendError);
      console.error(`WhatsApp send failed for user ${user_id}:`, errorMessage);

      await adminClient.from("whatsapp_settings")
        .update({ last_send_error: errorMessage, updated_at: new Date().toISOString() })
        .eq("user_id", user_id);

      // Fall back to the in-app/browser notification below.
      channel = "in_app";
    }
  }

  if (channel === "in_app") {
    // schedule_id/source/label/snooze_minutes let js/shell.js offer a
    // one-tap "Snooze" action on sleep notifications without a second
    // query. snooze_minutes is only ever meaningful (non-null) for
    // reminder_type === 'sleep' stages that aren't already a snooze.
    const { error: notifError } = await adminClient.from("notifications").insert({
      user_id,
      title,
      body,
      reminder_type,
      schedule_id,
      source,
      label,
      snooze_minutes,
    });
    if (notifError) {
      status = "failed";
      errorMessage = errorMessage || notifError.message;
    }
  }

  await adminClient.from("reminder_history")
    .update({ channel, status, error_message: errorMessage })
    .eq("id", historyRow.id);

  // A snooze is a one-shot: consumed regardless of whether delivery
  // ultimately succeeded, so it never fires again on a later tick.
  if (source === "sleep_snooze") await markSnoozeConsumed(adminClient, schedule_id);

  return { user_id, reminder_type, outcome: `${status}-via-${channel}` };
}

async function markSnoozeConsumed(adminClient: ReturnType<typeof createClient>, snoozeId: string) {
  try {
    await adminClient.from("reminder_snoozes").update({ consumed: true }).eq("id", snoozeId);
  } catch (err) {
    console.error(`Failed to mark reminder_snoozes ${snoozeId} consumed:`, err);
  }
}
