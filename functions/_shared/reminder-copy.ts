// supabase/functions/_shared/reminder-copy.ts
//
// One place to build the human-readable text for a reminder, so
// reminder-engine's WhatsApp and in-app/browser fallback paths always say
// the same thing.

const TITLES: Record<string, string> = {
  water: "💧 Water Reminder",
  meal: "🍽️ Meal Reminder",
  exercise: "🏃 Exercise Reminder",
  sleep: "😴 Sleep Reminder",
  medicine: "💊 Medicine Reminder",
};

const DEFAULT_BODIES: Record<string, string> = {
  water: "Time to drink some water and stay hydrated!",
  meal: "Time for your next meal — don't skip it.",
  exercise: "Time for your workout — let's get moving!",
  medicine: "Time to take your medicine.",
};

// Sleep Reminder — four distinct stages, each with its own title and body
// (previously the pre-bed stages and bedtime all read too similarly; each
// one below is deliberately different so a person can tell at a glance
// which stage a notification is for).
//
// Extra Sleep Times: every extra sleep schedule (source prefixed
// "additional_sleep_*" / "additional") runs through the exact same copy
// as the matching primary stage — the only difference is that schedule's
// own `label` (e.g. "Nap", "Evening Sleep") gets appended, same as every
// other reminder type.
const SLEEP_STAGE_BASE: Record<string, "pre_30" | "pre_15" | "bedtime" | "morning"> = {
  sleep_pre_30: "pre_30",
  sleep_pre_15: "pre_15",
  primary: "bedtime",       // only meaningful when reminderType === "sleep"
  sleep_morning: "morning",
  additional_sleep_pre_30: "pre_30",
  additional_sleep_pre_15: "pre_15",
  additional: "bedtime",    // only meaningful when reminderType === "sleep"
  additional_sleep_morning: "morning",
};

const SLEEP_STAGE_TITLES: Record<string, string> = {
  pre_30: "🌙 Time to prepare for bed.",
  pre_15: "😴 Bedtime is approaching.",
  bedtime: "🌙 Good night!",
  morning: "☀️ Good morning!",
};

const SLEEP_STAGE_BODIES: Record<string, string> = {
  pre_30: "Put away your phone and relax.",
  pre_15: "Bedtime is in 15 minutes.",
};

// Appends "(Label)" the same way every other reminder type already does,
// so a labelled extra sleep schedule reads e.g. "🌙 Time to prepare for
// bed. Put away your phone and relax. (Evening Sleep)".
function withLabel(text: string, label?: string | null): string {
  return label ? `${text} (${label})` : text;
}

function sleepStage(reminderType: string, source?: string): "pre_30" | "pre_15" | "bedtime" | "morning" | null {
  if (reminderType !== "sleep" || !source) return null;
  return SLEEP_STAGE_BASE[source] ?? null;
}

export function reminderTitle(reminderType: string, source?: string): string {
  if (source === "sleep_snooze") return "😴 Snoozed Reminder";
  const stage = sleepStage(reminderType, source);
  if (stage) return SLEEP_STAGE_TITLES[stage];
  return TITLES[reminderType] || "🔔 NutriHealth Reminder";
}

// sleepDurationLabel (e.g. "7h 45m") is only used for the morning stage,
// computed by the caller from last night's sleep_logs entry when one
// exists. goalHours is the user's own Sleep Goal (reminder_settings.
// goal_hours, editable on the Sleep tracking page) — falls back to 8 if
// it's ever missing so a brand-new row still reads sensibly.
export function reminderBody(reminderType: string, label?: string | null, source?: string, sleepDurationLabel?: string | null, goalHours?: number | null): string {
  const stage = sleepStage(reminderType, source);

  if (stage === "morning") {
    const base = sleepDurationLabel
      ? `You slept ${sleepDurationLabel}.`
      : "Time to wake up and start your day.";
    return withLabel(base, label);
  }
  if (stage === "bedtime") {
    const hours = goalHours ?? 8;
    return withLabel(`Aim for ${hours} hours of sleep.`, label);
  }
  if (stage && SLEEP_STAGE_BODIES[stage]) {
    return withLabel(SLEEP_STAGE_BODIES[stage], label);
  }
  if (source === "sleep_snooze") {
    return withLabel("This is your snoozed bedtime reminder.", label);
  }
  if (reminderType === "medicine" && label) {
    return `It's time to take ${label}.`;
  }
  if (label) {
    return `${DEFAULT_BODIES[reminderType] || "This is your reminder."} (${label})`;
  }
  return DEFAULT_BODIES[reminderType] || "This is your reminder.";
}

export function reminderWhatsAppText(reminderType: string, label: string | null | undefined, localTime: string, source?: string, sleepDurationLabel?: string | null, goalHours?: number | null): string {
  const footer = reminderType === "medicine"
    ? "\nOpen NutriHealth → Medicine Reminders to mark it taken, skip today, or snooze."
    : "";
  return `${reminderTitle(reminderType, source)}\n${reminderBody(reminderType, label, source, sleepDurationLabel, goalHours)}\n⏰ ${localTime} — NutriHealth${footer}`;
}
