/* =========================================================================
   reminders.js — Reminder Center
   Water/Meal/Exercise/Sleep: simple per-user on/off + daily time,
   stored in reminder_settings.
   Medicine: reads the EXISTING medicine_reminders table to show the
   soonest upcoming time.
   ========================================================================= */

let reminderUser = null;
const REMINDER_TYPES = ["water", "meal", "exercise", "sleep", "medicine"];
// Types that support the "+ Add another time" flow (reminder_schedules).
const MULTI_TIME_TYPES = ["water", "meal", "exercise", "sleep"];
let reminderSettingsMap = {}; // type -> { enabled, reminder_time, wake_time, snooze_minutes }
let medicineReminders = [];
let reminderSchedulesMap = {}; // type -> [ { id, reminder_time, label, enabled, days_of_week }, ... ]
let exerciseGoals = null;
let skippedScheduleIds = new Set(); // schedule ids with a reminder_skips row for today

document.addEventListener("DOMContentLoaded", async () => {
  reminderUser = await requireAuth();
  if (!reminderUser) return;

  renderShell("reminders.html");
  await loadUserChip(reminderUser);

  await loadAll();
  wireCards();
  wireExtraTimes();
  wireExerciseSkipToday();
  wireExerciseGoals();
  wireSleepSettings();
  wireMealSkipPause();

  // Wire generic Skip / Pause handlers for all card types
  REMINDER_TYPES.forEach((type) => wireCardSkipPause(type));

  syncBrowserTimezone(); // fire-and-forget
  hidePageLoader();
});

async function loadAll() {
  const [{ data: settingsRows }, { data: medRows }, { data: scheduleRows }, { data: goalsRow }, { data: skipRows }] = await Promise.all([
    supabaseClient.from("reminder_settings").select("*").eq("user_id", reminderUser.id),
    supabaseClient.from("medicine_reminders").select("*").eq("user_id", reminderUser.id),
    supabaseClient.from("reminder_schedules").select("*").eq("user_id", reminderUser.id).order("reminder_time"),
    supabaseClient.from("exercise_goals").select("*").eq("user_id", reminderUser.id).maybeSingle(),
    supabaseClient.from("reminder_skips").select("schedule_id").eq("user_id", reminderUser.id).eq("skip_date", todayDateStr())
  ]);

  reminderSettingsMap = {};
  (settingsRows || []).forEach((row) => {
    reminderSettingsMap[row.reminder_type] = row;
  });
  medicineReminders = medRows || [];
  exerciseGoals = goalsRow || null;
  skippedScheduleIds = new Set((skipRows || []).map((r) => r.schedule_id));

  reminderSchedulesMap = {};
  MULTI_TIME_TYPES.forEach((t) => { reminderSchedulesMap[t] = []; });
  (scheduleRows || []).forEach((row) => {
    if (!reminderSchedulesMap[row.reminder_type]) reminderSchedulesMap[row.reminder_type] = [];
    reminderSchedulesMap[row.reminder_type].push(row);
  });

  REMINDER_TYPES.forEach(renderCard);
  MULTI_TIME_TYPES.forEach(renderExtraTimes);
  renderExerciseSkipStatus();
  renderExerciseGoalsSummary();
  renderSleepSettings();
  renderMealSkipPauseStatus();

  REMINDER_TYPES.forEach((type) => renderCardSkipPauseStatus(type));
}

// Sync user's IANA timezone
async function syncBrowserTimezone() {
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!detected) return;

    const { data } = await supabaseClient.from("users").select("timezone").eq("id", reminderUser.id).single();
    if (!data || data.timezone === detected) return;
    if (data.timezone && data.timezone !== "UTC") return;

    await supabaseClient.from("users").update({ timezone: detected }).eq("id", reminderUser.id);
  } catch (err) {
    console.warn("Could not sync browser timezone:", err);
  }
}

// Localized full weekday name
function weekdayFullName(date) {
  try {
    const lang = typeof getCurrentLang === "function" ? getCurrentLang() : "en";
    return new Intl.DateTimeFormat(lang === "bn" ? "bn-BD" : "en-US", { weekday: "long" }).format(date);
  } catch {
    return date.toLocaleDateString("en-US", { weekday: "long" });
  }
}

// Evaluates reminders strictly for today
function computeNextTimeLabel(timeStr, daysOfWeek, skippedToday) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();

  const target = new Date(now);
  target.setHours(h, m, 59, 999);

  if (skippedToday) {
    return t("reminder_skipped_today", "Skipped for today");
  }

  if (target < now) {
    return t("reminder_time_passed", "Time passed today");
  }

  return `${t("reminder_today_at", "Today at")} ${formatTime12h(timeStr)}`;
}

// Medicine times check for today
function computeNextMedicineTime() {
  if (!medicineReminders.length) return null;
  const times = medicineReminders.map((m) => m.time).filter(Boolean).sort();
  const now = new Date();
  const nowStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
  
  const upcoming = times.find((tm) => tm >= nowStr);
  if (!upcoming) {
    return t("reminder_time_passed", "Time passed today");
  }

  return computeNextTimeLabel(upcoming.slice(0, 5));
}

function statusBadge(enabled) {
  const on = { bg: "var(--tint-mint)", color: "var(--color-mint)", label: t("reminder_status_on", "On") };
  const off = { bg: "var(--color-surface-raised)", color: "var(--color-ink-soft)", label: t("reminder_status_off", "Off") };
  const m = enabled ? on : off;
  return `<span style="background:${m.bg};color:${m.color};padding:2px 10px;border-radius:20px;font-size:0.78rem;font-weight:700;">${m.label}</span>`;
}

function renderCard(type) {
  const card = qs(`.reminder-card[data-type="${type}"]`);
  if (!card) return;

  const setting = reminderSettingsMap[type] || { enabled: false, reminder_time: null };
  const statusEl = qs('[data-role="status"]', card);
  const toggleEl = qs('[data-role="enable-toggle"]', card);
  const nextTimeEl = qs('[data-role="next-time"]', card);

  if (statusEl) statusEl.innerHTML = statusBadge(setting.enabled);
  if (toggleEl) toggleEl.checked = !!setting.enabled;
  if (!nextTimeEl) return;

  // Medicine status
  if (type === "medicine") {
    const label = computeNextMedicineTime();
    nextTimeEl.textContent = label || t("reminder_no_medicines", "No medicines added yet");
    return;
  }

  // Disabled status
  if (!setting.enabled) {
    nextTimeEl.textContent = t("reminder_status_off", "Off");
    return;
  }

  // Multi-time types (water, meal, exercise, sleep) from reminder_schedules
  if (MULTI_TIME_TYPES.includes(type)) {
    const typeSchedules = reminderSchedulesMap[type] || [];
    const now = new Date();
    const currentHM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    if (typeSchedules.length > 0) {
      const upcoming = typeSchedules
        .filter((s) => s.enabled)
        .sort((a, b) => a.reminder_time.localeCompare(b.reminder_time))
        .find((s) => s.reminder_time.slice(0, 5) >= currentHM);

      if (upcoming) {
        const skippedToday = skippedScheduleIds.has(upcoming.id);
        nextTimeEl.textContent = computeNextTimeLabel(upcoming.reminder_time.slice(0, 5), upcoming.days_of_week, skippedToday);
      } else {
        nextTimeEl.textContent = t("reminder_time_passed", "Time passed today");
      }
      return;
    }

    // Fallback to primary setting single-time
    if (setting.reminder_time) {
      const skippedToday = setting.id && skippedScheduleIds.has(setting.id);
      nextTimeEl.textContent = computeNextTimeLabel(setting.reminder_time.slice(0, 5), setting.days_of_week, skippedToday);
    } else {
      nextTimeEl.textContent = t("reminder_not_set", "Not set");
    }
    return;
  }

  // Fallback for single-time types
  if (setting.reminder_time) {
    const skippedToday = setting.id && skippedScheduleIds.has(setting.id);
    nextTimeEl.textContent = computeNextTimeLabel(setting.reminder_time.slice(0, 5), setting.days_of_week, skippedToday);
  } else {
    nextTimeEl.textContent = t("reminder_not_set", "Not set");
  }
}

async function saveReminderSetting(type, patch) {
  const existing = reminderSettingsMap[type] || {};
  const payload = {
    user_id: reminderUser.id,
    reminder_type: type,
    enabled: existing.enabled || false,
    reminder_time: existing.reminder_time || null,
    ...patch,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabaseClient
    .from("reminder_settings")
    .upsert(payload, { onConflict: "user_id,reminder_type" })
    .select()
    .single();

  if (error) { showToast(error.message, "error"); return false; }
  reminderSettingsMap[type] = data;
  return true;
}

function wireCards() {
  qsa(".reminder-card").forEach((card) => {
    const type = card.dataset.type;
    if (type === "sleep") return; // Handled separately in wireSleepSettings()

    const toggleEl = qs('[data-role="enable-toggle"]', card);
    const editBtn = qs('[data-role="edit-btn"]', card);
    const editRow = qs('[data-role="edit-row"]', card);
    const timeInput = qs('[data-role="time-input"]', card);
    const daysPicker = qs('[data-role="days-picker"]', card);
    const saveBtn = qs('[data-role="save-btn"]', card);
    const cancelBtn = qs('[data-role="cancel-btn"]', card);

    if (toggleEl) {
      toggleEl.addEventListener("change", async () => {
        const ok = await saveReminderSetting(type, { enabled: toggleEl.checked });
        if (ok) {
          renderCard(type);
          if (type === "meal") renderMealSkipPauseStatus();
          showToast(t("reminder_saved_toast", "Reminder updated"), "success");
        } else {
          toggleEl.checked = !toggleEl.checked;
        }
      });
    }

    if (daysPicker) wireDayPickerToggle(daysPicker);

    if (type === "medicine" || !editBtn) return;

    editBtn.addEventListener("click", () => {
      // Find time from primary setting OR first schedule
      const current = reminderSettingsMap[type]?.reminder_time || 
                      (reminderSchedulesMap[type]?.[0]?.reminder_time);

      timeInput.value = current ? current.slice(0, 5) : "";
      if (daysPicker) {
        const existingDays = reminderSettingsMap[type]?.days_of_week;
        renderDayPicker(daysPicker, existingDays && existingDays.length ? existingDays : [todayWeekday()]);
      }
      editRow.style.display = "block";
      editBtn.style.display = "none";
    });

    cancelBtn?.addEventListener("click", () => {
      editRow.style.display = "none";
      editBtn.style.display = "inline-flex";
    });

    saveBtn?.addEventListener("click", async () => {
      if (!timeInput.value) { 
        showToast(t("reminder_pick_time", "Please choose a time first."), "error"); 
        return; 
      }

      setBtnLoading(saveBtn, true, t("reminder_save", "Save"));

      const patch = { reminder_time: timeInput.value, enabled: true };
      if (type === "exercise" && daysPicker) {
        patch.days_of_week = daysOfWeekForSave(getSelectedDays(daysPicker));
      }

      // 1. Save to primary reminder_settings table
      const ok = await saveReminderSetting(type, patch);

      // 2. If multi-time type, also sync to reminder_schedules so it appears instantly in schedules/next time!
      if (ok && MULTI_TIME_TYPES.includes(type)) {
        const existingSchedules = reminderSchedulesMap[type] || [];
        
        if (existingSchedules.length === 0) {
          // Add as first schedule if none exist
          const { data, error } = await supabaseClient
            .from("reminder_schedules")
            .insert({
              user_id: reminderUser.id,
              reminder_type: type,
              reminder_time: timeInput.value,
              enabled: true
            })
            .select()
            .single();

          if (!error && data) {
            reminderSchedulesMap[type] = [data];
          }
        }
      }

      setBtnLoading(saveBtn, false, t("reminder_save", "Save"));
      if (!ok) return;

      if (toggleEl) toggleEl.checked = true;
      editRow.style.display = "none";
      editBtn.style.display = "inline-flex";

      // Re-render both card status and extra times
      renderCard(type);
      renderExtraTimes(type);
      showToast(t("reminder_saved_toast", "Reminder updated"), "success");
    });
  });
}

/**
 * Clean & Organized Extra Times Renderer
 */
function renderExtraTimes(type) {
  const card = qs(`.reminder-card[data-type="${type}"]`);
  if (!card) return;
  const list = qs('[data-role="extra-times-list"]', card);
  if (!list) return;

  const rows = reminderSchedulesMap[type] || [];
  if (!rows.length) {
    list.innerHTML = `<div class="text-sm text-muted" style="padding: 8px 0;">${t("reminder_no_extra_times", "No extra times added.")}</div>`;
    return;
  }

  list.innerHTML = rows.map((row) => {
    // Show wake & snooze details strictly for Sleep reminders
    const metaParts = [];
    if (type === "sleep") {
      if (row.wake_time) metaParts.push(`${t("sleep_wake_label", "Wake:")} ${formatTime12h(row.wake_time.slice(0, 5))}`);
      if (row.snooze_minutes) metaParts.push(`${t("med_snooze_label", "Snooze:")} ${row.snooze_minutes}m`);
    }

    const subDetailsHtml = metaParts.length > 0 
      ? `<div class="text-xs text-muted mt-2">${metaParts.join(" • ")}</div>` 
      : "";

    return `
    <div class="extra-time-row flex-between align-center" data-schedule-id="${row.id}" style="padding: 10px 0; border-bottom: 1px solid var(--color-border, #eee);">
      <div>
        <div class="text-sm" style="font-weight: 500;">
          ${formatTime12h(row.reminder_time.slice(0, 5))}
          ${row.label ? `<span class="text-muted" style="font-weight: 400;"> — ${escapeHtml(row.label)}</span>` : ""}
          ${!row.enabled ? ` <em class="text-muted">(${t("reminder_status_off", "Off")})</em>` : ""}
        </div>
        ${subDetailsHtml}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-role="remove-extra-time" data-id="${row.id}" aria-label="${t("reminder_remove_time", "Remove")}">✕</button>
    </div>`;
  }).join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function wireExtraTimes() {
  MULTI_TIME_TYPES.forEach((type) => {
    const card = qs(`.reminder-card[data-type="${type}"]`);
    if (!card) return;

    const addBtn = qs('[data-role="add-time-btn"]', card);
    const addRow = qs('[data-role="add-time-row"]', card);
    const addInput = qs('[data-role="add-time-input"]', card);
    const addLabelInput = qs('[data-role="add-time-label"]', card);
    const addWakeInput = qs('[data-role="add-time-wake"]', card);
    const addSnoozeSelect = qs('[data-role="add-time-snooze"]', card);
    const addDaysPicker = qs('[data-role="add-time-days-picker"]', card);
    const addSaveBtn = qs('[data-role="add-time-save"]', card);
    const addCancelBtn = qs('[data-role="add-time-cancel"]', card);
    const list = qs('[data-role="extra-times-list"]', card);

    if (addDaysPicker) wireDayPickerToggle(addDaysPicker);

    if (addBtn && addRow) {
      addBtn.addEventListener("click", () => {
        addInput.value = "";
        if (addLabelInput) addLabelInput.value = "";
        if (addWakeInput) addWakeInput.value = "";
        if (addSnoozeSelect) addSnoozeSelect.value = "10";
        if (addDaysPicker) renderDayPicker(addDaysPicker, [todayWeekday()]);
        addRow.style.display = "block";
      });
      addCancelBtn?.addEventListener("click", () => { addRow.style.display = "none"; });

      addSaveBtn?.addEventListener("click", async () => {
        if (!addInput.value) {
          showToast(t("reminder_pick_time", "Please choose a time first."), "error");
          return;
        }
        setBtnLoading(addSaveBtn, true, t("reminder_save", "Save"));

        const payload = {
          user_id: reminderUser.id,
          reminder_type: type,
          reminder_time: addInput.value,
          label: addLabelInput?.value?.trim() || null,
          enabled: true
        };
        if (type === "sleep") {
          payload.wake_time = addWakeInput?.value || null;
          payload.snooze_minutes = Number(addSnoozeSelect?.value || 10);
        }
        if (type === "exercise" && addDaysPicker) {
          payload.days_of_week = daysOfWeekForSave(getSelectedDays(addDaysPicker));
        }

        const { data, error } = await supabaseClient
          .from("reminder_schedules")
          .insert(payload)
          .select()
          .single();

        setBtnLoading(addSaveBtn, false, t("reminder_save", "Save"));

        if (error) { showToast(error.message, "error"); return; }

        reminderSchedulesMap[type] = [...(reminderSchedulesMap[type] || []), data]
          .sort((a, b) => a.reminder_time.localeCompare(b.reminder_time));
        
        renderCard(type);
        renderExtraTimes(type);
        if (type === "meal") renderMealSkipPauseStatus();
        addRow.style.display = "none";
        showToast(t("reminder_saved_toast", "Reminder updated"), "success");
      });
    }

    list?.addEventListener("click", async (e) => {
      const removeBtn = e.target.closest('[data-role="remove-extra-time"]');
      if (removeBtn) {
        const id = removeBtn.dataset.id;
        const { error } = await supabaseClient.from("reminder_schedules").delete().eq("id", id).eq("user_id", reminderUser.id);
        if (error) { showToast(error.message, "error"); return; }

        reminderSchedulesMap[type] = (reminderSchedulesMap[type] || []).filter((r) => r.id !== id);
        renderCard(type);
        renderExtraTimes(type);
        if (type === "meal") renderMealSkipPauseStatus();
        showToast(t("reminder_removed_toast", "Time removed"), "success");
      }
    });
  });
}

function todayWeekday() {
  return new Date().getDay();
}

const DAY_SHORT_KEYS = ["day_short_sun", "day_short_mon", "day_short_tue", "day_short_wed", "day_short_thu", "day_short_fri", "day_short_sat"];
const DAY_SHORT_FALLBACK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderDayPicker(container, selectedDays) {
  const selected = Array.isArray(selectedDays) && selectedDays.length ? selectedDays : [0, 1, 2, 3, 4, 5, 6];
  container.innerHTML = [0, 1, 2, 3, 4, 5, 6].map((d) => `
    <button type="button" class="day-chip${selected.includes(d) ? " active" : ""}" data-day="${d}">${t(DAY_SHORT_KEYS[d], DAY_SHORT_FALLBACK[d])}</button>
  `).join("");
}

function getSelectedDays(container) {
  return qsa(".day-chip.active", container).map((c) => Number(c.dataset.day)).sort();
}

function wireDayPickerToggle(container) {
  container.addEventListener("click", (e) => {
    const chip = e.target.closest(".day-chip");
    if (!chip) return;
    chip.classList.toggle("active");
  });
}

function daysOfWeekForSave(selected) {
  return (selected.length === 0 || selected.length === 7) ? null : selected;
}

function renderExerciseSkipStatus() {
  const btn = qs("#exerciseSkipTodayBtn");
  const status = qs("#exerciseSkipStatus");
  if (!btn || !status) return;

  const scheduleId = reminderSettingsMap.exercise?.id;
  const skippedToday = scheduleId && skippedScheduleIds.has(scheduleId);

  if (skippedToday) {
    btn.disabled = true;
    btn.textContent = t("exercise_skipped_today_btn", "Skipped for today");
    status.textContent = t("exercise_skipped_today_hint", "You won't get a workout reminder today.");
  } else {
    btn.disabled = false;
    btn.textContent = t("reminder_skip_today_btn", "Skip today's workout");
    status.textContent = "";
  }
}

function wireExerciseSkipToday() {
  const btn = qs("#exerciseSkipTodayBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const scheduleId = reminderSettingsMap.exercise?.id;
    if (!scheduleId) {
      showToast(t("exercise_set_time_first", "Set a workout time first."), "error");
      return;
    }

    setBtnLoading(btn, true, t("reminder_saving", "Saving..."));
    const { error } = await supabaseClient.from("reminder_skips").insert({
      user_id: reminderUser.id,
      reminder_type: "exercise",
      schedule_id: scheduleId,
      skip_date: todayDateStr()
    });
    setBtnLoading(btn, false, t("reminder_skip_today_btn", "Skip today's workout"));

    if (error && error.code !== "23505") {
      showToast(error.message, "error");
      return;
    }

    skippedScheduleIds.add(scheduleId);
    renderCard("exercise");
    renderExerciseSkipStatus();
    showToast(t("exercise_skip_toast", "Today's workout reminder skipped."), "success");
  });
}

function renderExerciseGoalsSummary() {
  const el = qs("#exerciseGoalsSummary");
  if (!el) return;

  if (!exerciseGoals || (!exerciseGoals.daily_minutes_goal && !exerciseGoals.weekly_minutes_goal
      && !exerciseGoals.calories_goal && !exerciseGoals.daily_steps_goal && !exerciseGoals.weekly_sessions_goal)) {
    el.innerHTML = `<span class="text-muted">${t("exercise_goals_not_set", "No goals set yet.")}</span>`;
    return;
  }

  const parts = [];
  if (exerciseGoals.daily_minutes_goal) parts.push(`${t("exercise_goal_daily_minutes", "Daily minutes")}: <strong>${exerciseGoals.daily_minutes_goal}</strong>`);
  if (exerciseGoals.weekly_minutes_goal) parts.push(`${t("exercise_goal_weekly_minutes", "Weekly minutes")}: <strong>${exerciseGoals.weekly_minutes_goal}</strong>`);
  if (exerciseGoals.calories_goal) parts.push(`${t("exercise_goal_calories", "Calories to burn (daily)")}: <strong>${exerciseGoals.calories_goal}</strong>`);
  if (exerciseGoals.daily_steps_goal) parts.push(`${t("exercise_goal_steps", "Daily steps")}: <strong>${exerciseGoals.daily_steps_goal}</strong>`);
  if (exerciseGoals.weekly_sessions_goal) parts.push(`${t("exercise_goal_sessions", "Sessions per week")}: <strong>${exerciseGoals.weekly_sessions_goal}</strong>`);

  el.innerHTML = parts.map((p) => `<div class="mt-6">${p}</div>`).join("");
}

function wireExerciseGoals() {
  const editBtn = qs("#exerciseGoalsEditBtn");
  const form = qs("#exerciseGoalsForm");
  const saveBtn = qs("#exerciseGoalsSaveBtn");
  const cancelBtn = qs("#exerciseGoalsCancelBtn");
  if (!editBtn || !form) return;

  editBtn.addEventListener("click", () => {
    qs("#goalDailyMinutes").value = exerciseGoals?.daily_minutes_goal ?? "";
    qs("#goalWeeklyMinutes").value = exerciseGoals?.weekly_minutes_goal ?? "";
    qs("#goalCalories").value = exerciseGoals?.calories_goal ?? "";
    qs("#goalSteps").value = exerciseGoals?.daily_steps_goal ?? "";
    qs("#goalSessions").value = exerciseGoals?.weekly_sessions_goal ?? "";
    form.style.display = "block";
  });

  cancelBtn?.addEventListener("click", () => { form.style.display = "none"; });

  saveBtn?.addEventListener("click", async () => {
    const payload = {
      user_id: reminderUser.id,
      daily_minutes_goal: qs("#goalDailyMinutes").value ? Number(qs("#goalDailyMinutes").value) : null,
      weekly_minutes_goal: qs("#goalWeeklyMinutes").value ? Number(qs("#goalWeeklyMinutes").value) : null,
      calories_goal: qs("#goalCalories").value ? Number(qs("#goalCalories").value) : null,
      daily_steps_goal: qs("#goalSteps").value ? Number(qs("#goalSteps").value) : null,
      weekly_sessions_goal: qs("#goalSessions").value ? Number(qs("#goalSessions").value) : null,
      updated_at: new Date().toISOString()
    };

    setBtnLoading(saveBtn, true, t("reminder_save", "Save"));
    const { data, error } = await supabaseClient.from("exercise_goals").upsert(payload, { onConflict: "user_id" }).select().single();
    setBtnLoading(saveBtn, false, t("reminder_save", "Save"));

    if (error) { showToast(error.message, "error"); return; }

    exerciseGoals = data;
    renderExerciseGoalsSummary();
    form.style.display = "none";
    showToast(t("reminder_saved_toast", "Reminder updated"), "success");
  });
}

/* =========================================================================
   Compact Sleep Reminder Logic
   ========================================================================= */

function renderSleepSettings() {
  const card = qs('.reminder-card[data-type="sleep"]');
  if (!card) return;

  const setting = reminderSettingsMap.sleep || {};
  const bedtimeInput = qs('[data-role="sleep-bedtime"]', card);
  const wakeInput = qs('[data-role="sleep-wake"]', card);
  const snoozeSelect = qs('[data-role="sleep-snooze"]', card);

  if (bedtimeInput) bedtimeInput.value = setting.reminder_time ? setting.reminder_time.slice(0, 5) : "";
  if (wakeInput) wakeInput.value = setting.wake_time ? setting.wake_time.slice(0, 5) : "";
  if (snoozeSelect) snoozeSelect.value = String(setting.snooze_minutes || 10);
}

function wireSleepSettings() {
  const card = qs('.reminder-card[data-type="sleep"]');
  if (!card) return;

  const toggleEl = qs('[data-role="enable-toggle"]', card);
  const editBtn = qs('[data-role="edit-btn"]', card);
  const editRow = qs('[data-role="edit-row"]', card);
  const cancelBtn = qs('[data-role="cancel-btn"]', card);
  const saveBtn = qs('[data-role="save-btn"]', card);

  const bedtimeInput = qs('[data-role="sleep-bedtime"]', card);
  const wakeInput = qs('[data-role="sleep-wake"]', card);
  const snoozeSelect = qs('[data-role="sleep-snooze"]', card);

  if (toggleEl) {
    toggleEl.addEventListener("change", async () => {
      const ok = await saveReminderSetting("sleep", { enabled: toggleEl.checked });
      if (ok) {
        renderCard("sleep");
        showToast(t("reminder_saved_toast", "Reminder updated"), "success");
      } else {
        toggleEl.checked = !toggleEl.checked;
      }
    });
  }

  editBtn?.addEventListener("click", () => {
    renderSleepSettings();
    editRow.style.display = "block";
    editBtn.style.display = "none";
  });

  cancelBtn?.addEventListener("click", () => {
    editRow.style.display = "none";
    editBtn.style.display = "inline-flex";
  });

  saveBtn?.addEventListener("click", async () => {
    if (!bedtimeInput.value) {
      showToast(t("sleep_pick_bedtime", "Please set a bedtime time."), "error");
      return;
    }

    setBtnLoading(saveBtn, true, t("reminder_save", "Save"));

    const ok = await saveReminderSetting("sleep", {
      reminder_time: bedtimeInput.value,
      wake_time: wakeInput.value || null,
      snooze_minutes: Number(snoozeSelect.value || 10),
      enabled: true
    });

    setBtnLoading(saveBtn, false, t("reminder_save", "Save"));

    if (!ok) return;

    if (toggleEl) toggleEl.checked = true;
    editRow.style.display = "none";
    editBtn.style.display = "inline-flex";

    renderCard("sleep");
    showToast(t("reminder_saved_toast", "Sleep schedule updated"), "success");
  });
}

function getUpcomingMealSchedule() {
  const mealSchedules = reminderSchedulesMap.meal || [];
  const now = new Date();
  const currentHM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return mealSchedules
    .filter((s) => s.enabled)
    .sort((a, b) => a.reminder_time.localeCompare(b.reminder_time))
    .find((s) => s.reminder_time.slice(0, 5) >= currentHM) || null;
}

function renderMealSkipPauseStatus() {
  const skipBtn = qs("#mealSkipTodayBtn");
  const pauseBtn = qs("#mealPauseBtn");
  if (!skipBtn || !pauseBtn) return;

  const paused = reminderSettingsMap.meal?.enabled === false;
  pauseBtn.textContent = paused
    ? t("meal_resume_btn", "▶️ Resume reminders")
    : t("meal_pause_btn", "⏸️ Pause reminders");

  const upcoming = getUpcomingMealSchedule();
  const skippedToday = upcoming && skippedScheduleIds.has(upcoming.id);

  if (paused || !upcoming) {
    skipBtn.disabled = true;
    skipBtn.textContent = t("meal_skip_today_btn", "⏭️ Skip today");
  } else if (skippedToday) {
    skipBtn.disabled = false;
    skipBtn.textContent = t("reminder_undo_skip_btn", "↩️ Undo Skip");
  } else {
    skipBtn.disabled = false;
    skipBtn.textContent = t("meal_skip_today_btn", "⏭️ Skip today");
  }
}

function wireMealSkipPause() {
  const skipBtn = qs("#mealSkipTodayBtn");
  const pauseBtn = qs("#mealPauseBtn");
  if (!skipBtn || !pauseBtn) return;

  skipBtn.addEventListener("click", async () => {
    const upcoming = getUpcomingMealSchedule();
    if (!upcoming) {
      showToast(t("meal_no_upcoming", "No upcoming meal reminder to skip today."), "error");
      return;
    }

    const isSkipped = skippedScheduleIds.has(upcoming.id);
    const originalLabel = skipBtn.textContent;
    setBtnLoading(skipBtn, true, t("reminder_saving", "Saving..."));

    if (isSkipped) {
      const { error } = await supabaseClient.from("reminder_skips")
        .delete()
        .eq("user_id", reminderUser.id)
        .eq("reminder_type", "meal")
        .eq("schedule_id", upcoming.id)
        .eq("skip_date", todayDateStr());

      setBtnLoading(skipBtn, false, originalLabel);

      if (error) {
        showToast(error.message, "error");
        return;
      }

      skippedScheduleIds.delete(upcoming.id);
      renderCard("meal");
      renderMealSkipPauseStatus();
      showToast("Meal reminder restored for today!", "success");
    } else {
      const { error } = await supabaseClient.from("reminder_skips").insert({
        user_id: reminderUser.id,
        reminder_type: "meal",
        schedule_id: upcoming.id,
        skip_date: todayDateStr()
      });
      setBtnLoading(skipBtn, false, originalLabel);

      if (error && error.code !== "23505") {
        showToast(error.message, "error");
        return;
      }

      skippedScheduleIds.add(upcoming.id);
      renderCard("meal");
      renderMealSkipPauseStatus();
      showToast(t("meal_skip_toast", "Today's meal reminder skipped."), "success");
    }
  });

  pauseBtn.addEventListener("click", async () => {
    const currentlyPaused = reminderSettingsMap.meal?.enabled === false;
    const nextEnabled = currentlyPaused;

    const originalLabel = pauseBtn.textContent;
    setBtnLoading(pauseBtn, true, t("reminder_saving", "Saving..."));

    const ok = await saveReminderSetting("meal", { enabled: nextEnabled });
    if (!ok) { setBtnLoading(pauseBtn, false, originalLabel); return; }

    const mealRows = reminderSchedulesMap.meal || [];
    if (mealRows.length) {
      const { error } = await supabaseClient.from("reminder_schedules")
        .update({ enabled: nextEnabled, updated_at: new Date().toISOString() })
        .eq("user_id", reminderUser.id)
        .eq("reminder_type", "meal");

      if (error) {
        showToast(error.message, "error");
        setBtnLoading(pauseBtn, false, originalLabel);
        return;
      }
      mealRows.forEach((r) => { r.enabled = nextEnabled; });
    }

    setBtnLoading(pauseBtn, false, originalLabel);
    renderCard("meal");
    renderExtraTimes("meal");
    renderMealSkipPauseStatus();
    showToast(
      nextEnabled ? t("meal_resumed_toast", "Meal reminders resumed.") : t("meal_paused_toast", "Meal reminders paused."),
      "success"
    );
  });
}

function getUpcomingSchedule(type) {
  const schedules = reminderSchedulesMap[type] || [];
  const now = new Date();
  const currentHM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  
  return schedules
    .filter((s) => s.enabled)
    .sort((a, b) => a.reminder_time.localeCompare(b.reminder_time))
    .find((s) => s.reminder_time.slice(0, 5) >= currentHM) || null;
}

function renderCardSkipPauseStatus(type) {
  const skipBtn = qs(`#${type}SkipTodayBtn`);
  const pauseBtn = qs(`#${type}PauseBtn`);
  if (!skipBtn || !pauseBtn) return;

  const paused = reminderSettingsMap[type]?.enabled === false;
  pauseBtn.textContent = paused ? t("reminder_resume_btn", "▶️ Resume reminders") : t("reminder_pause_btn", "⏸️ Pause reminders");

  const upcoming = getUpcomingSchedule(type) || (reminderSettingsMap[type]?.id ? reminderSettingsMap[type] : null);
  const skippedToday = upcoming && skippedScheduleIds.has(upcoming.id);

  if (paused || !upcoming) {
    skipBtn.disabled = true;
    skipBtn.textContent = t("reminder_generic_skip_today_btn", "⏭️ Skip today");
  } else if (skippedToday) {
    skipBtn.disabled = false;
    skipBtn.textContent = t("reminder_undo_skip_btn", "↩️ Undo Skip");
  } else {
    skipBtn.disabled = false;
    skipBtn.textContent = t("reminder_generic_skip_today_btn", "⏭️ Skip today");
  }
}

function wireCardSkipPause(type) {
  const skipBtn = qs(`#${type}SkipTodayBtn`);
  const pauseBtn = qs(`#${type}PauseBtn`);
  if (!skipBtn || !pauseBtn) return;

  skipBtn.addEventListener("click", async () => {
    const upcoming = getUpcomingSchedule(type) || (reminderSettingsMap[type]?.id ? reminderSettingsMap[type] : null);
    if (!upcoming) {
      showToast(`No upcoming ${type} reminder to skip today.`, "error");
      return;
    }

    const isSkipped = skippedScheduleIds.has(upcoming.id);
    setBtnLoading(skipBtn, true, "Saving...");

    if (isSkipped) {
      const { error } = await supabaseClient.from("reminder_skips")
        .delete()
        .eq("user_id", reminderUser.id)
        .eq("reminder_type", type)
        .eq("schedule_id", upcoming.id)
        .eq("skip_date", todayDateStr());

      setBtnLoading(skipBtn, false, t("reminder_undo_skip_btn", "↩️ Undo Skip"));

      if (error) {
        showToast(error.message, "error");
        return;
      }

      skippedScheduleIds.delete(upcoming.id);
      renderCard(type);
      renderCardSkipPauseStatus(type);
      showToast(`${type} reminder restored for today!`, "success");
    } else {
      const { error } = await supabaseClient.from("reminder_skips").insert({
        user_id: reminderUser.id,
        reminder_type: type,
        schedule_id: upcoming.id,
        skip_date: todayDateStr()
      });

      setBtnLoading(skipBtn, false, t("reminder_generic_skip_today_btn", "⏭️ Skip today"));

      if (error && error.code !== "23505") {
        showToast(error.message, "error");
        return;
      }

      skippedScheduleIds.add(upcoming.id);
      renderCard(type);
      renderCardSkipPauseStatus(type);
      showToast(`Today's ${type} reminder skipped.`, "success");
    }
  });

  pauseBtn.addEventListener("click", async () => {
    const currentlyPaused = reminderSettingsMap[type]?.enabled === false;
    const nextEnabled = currentlyPaused;

    setBtnLoading(pauseBtn, true, "Saving...");

    const ok = await saveReminderSetting(type, { enabled: nextEnabled });
    if (!ok) { setBtnLoading(pauseBtn, false, pauseBtn.textContent); return; }

    const schedules = reminderSchedulesMap[type] || [];
    if (schedules.length) {
      const { error } = await supabaseClient.from("reminder_schedules")
        .update({ enabled: nextEnabled, updated_at: new Date().toISOString() })
        .eq("user_id", reminderUser.id)
        .eq("reminder_type", type);

      if (error) {
        showToast(error.message, "error");
        setBtnLoading(pauseBtn, false, pauseBtn.textContent);
        return;
      }
      schedules.forEach((r) => { r.enabled = nextEnabled; });
    }

    setBtnLoading(pauseBtn, false, pauseBtn.textContent);
    renderCard(type);
    renderExtraTimes(type);
    renderCardSkipPauseStatus(type);
    showToast(
      nextEnabled ? `${type} reminders resumed.` : `${type} reminders paused.`,
      "success"
    );
  });
}
/* =========================================================================
   Doctor Appointment Reminder Module
   Integrates database appointments with the Reminder Center UI
   ========================================================================= */

let doctorReminderState = {
  enabled: true,
  paused: false,
  skippedToday: false
};

// Initializes the Doctor Appointment card within the Reminder Center
async function initDoctorAppointmentReminder() {
  await loadUpcomingDoctorReminders();
}

// Fetch upcoming doctor appointments and populate the UI
async function loadUpcomingDoctorReminders() {
  if (!apptUser) return;

  const todayStr = todayDateStr();
  
  const { data, error } = await supabaseClient
    .from("doctor_appointments")
    .select("*")
    .eq("user_id", apptUser.id)
    .eq("status", "upcoming")
    .gte("appointment_date", todayStr)
    .order("appointment_date", { ascending: true })
    .order("appointment_time", { ascending: true });

  const listContainer = qs("#doctorAppointmentsList");
  const nextTimeEl = qs("#doctorNextTime");

  if (error || !data || data.length === 0) {
    if (listContainer) {
      listContainer.innerHTML = `<div class="text-xs text-muted">No upcoming appointments scheduled.</div>`;
    }
    if (nextTimeEl) {
      nextTimeEl.textContent = "No active reminders";
    }
    return;
  }

  // Update Next Reminder display to the earliest upcoming appointment
  const nextAppt = data[0];
  if (nextTimeEl) {
    const formattedDate = formatDate(nextAppt.appointment_date);
    const formattedTime = formatTime12h(nextAppt.appointment_time);
    nextTimeEl.textContent = `${formattedDate} at ${formattedTime} (${nextAppt.doctor_name})`;
  }

  // Render list inside card
  if (listContainer) {
    listContainer.innerHTML = data.map((appt) => `
      <div class="flex-between align-center text-xs py-1 px-2 border-rounded bg-surface-raised">
        <div>
          <strong>${appt.doctor_name}</strong> · ${formatTime12h(appt.appointment_time)}
          <div class="text-muted">${appt.hospital_name} (${formatDate(appt.appointment_date)})</div>
        </div>
        <button class="btn-icon text-muted" onclick="cancelDoctorReminder('${appt.id}')" title="Cancel Appointment">&times;</button>
      </div>
    `).join("");
  }
}

// Remove or cancel an appointment from the card
async function cancelDoctorReminder(appointmentId) {
  const { error } = await supabaseClient
    .from("doctor_appointments")
    .update({ status: "cancelled" })
    .eq("id", appointmentId);

  if (error) {
    showToast(error.message, "error");
    return;
  }
  showToast("Appointment reminder removed", "info");
  await loadUpcomingDoctorReminders();
}

// Attach to DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  initDoctorAppointmentReminder();
});
/* =========================================================================
   reminders.js — Reminder Center Logic
   Handles Water, Meal, Exercise, Sleep, Medicine, and Doctor Appointments
   ========================================================================= */

document.addEventListener("DOMContentLoaded", async () => {
  // 1. Authenticate user if apptUser is not already defined globally
  if (typeof apptUser === "undefined" || !apptUser) {
    if (typeof requireAuth === "function") {
      window.apptUser = await requireAuth();
    }
  }

  // 2. Initialize Reminder Modules
  initDoctorAppointmentCard();
  bindReminderControls();
});

/* -------------------------------------------------------------------------
   DOCTOR APPOINTMENTS REMINDER CARD
   ------------------------------------------------------------------------- */

async function initDoctorAppointmentCard() {
  const nextTimeEl = document.getElementById("doctorNextTime");
  const listEl = document.getElementById("doctorAppointmentsList");

  if (!window.apptUser) {
    if (nextTimeEl) nextTimeEl.textContent = "Please sign in";
    return;
  }

  // Get current date in YYYY-MM-DD format using todayDateStr or fallback
  const todayStr = typeof todayDateStr === "function" ? todayDateStr() : new Date().toISOString().split("T")[0];

  try {
    // Fetch upcoming doctor appointments
    const { data: appointments, error } = await supabaseClient
      .from("doctor_appointments")
      .select("*")
      .eq("user_id", window.apptUser.id)
      .eq("status", "upcoming")
      .gte("appointment_date", todayStr)
      .order("appointment_date", { ascending: true })
      .order("appointment_time", { ascending: true });

    if (error) throw error;

    if (!appointments || appointments.length === 0) {
      if (nextTimeEl) nextTimeEl.textContent = "No upcoming visits";
      if (listEl) {
        listEl.innerHTML = `<div class="text-xs text-muted py-2">No appointments scheduled for today.</div>`;
      }
      return;
    }

    // --- 1. SET NEXT REMINDER TIME (Earliest Visit) ---
    const earliest = appointments[0];
    const formattedDate = formatApptDate(earliest.appointment_date);
    const formattedTime = formatApptTime(earliest.appointment_time);

    if (nextTimeEl) {
      nextTimeEl.innerHTML = `<span class="text-primary">${formattedTime}</span> <span class="text-xs text-muted">(${formattedDate})</span>`;
    }

    // --- 2. RENDER UPCOMING APPOINTMENTS LIST ---
    if (listEl) {
      listEl.innerHTML = appointments.map((appt) => {
        const timeStr = formatApptTime(appt.appointment_time);
        const dateStr = formatApptDate(appt.appointment_date);

        return `
          <div class="flex-between align-center p-2 border-rounded" style="background: var(--color-surface-raised, rgba(255,255,255,0.05)); border: 1px solid var(--color-border, rgba(255,255,255,0.1)); border-radius: 8px;">
            <div style="min-width: 0; flex: 1;">
              <div class="font-semibold text-sm truncate" style="color: var(--color-text, #fff);">${appt.doctor_name}</div>
              <div class="text-xs text-muted truncate">🏥 ${appt.hospital_name} (${dateStr})</div>
            </div>
            <div class="text-right" style="margin-left: 10px; flex-shrink: 0;">
              <div class="badge badge-sm" style="background: rgba(147, 51, 234, 0.2); color: #c084fc; font-weight: 600; padding: 2px 6px; border-radius: 6px; font-size: 0.75rem;">
                🕒 ${timeStr}
              </div>
            </div>
          </div>
        `;
      }).join("");
    }

  } catch (err) {
    console.error("Error loading doctor appointment reminders:", err);
    if (nextTimeEl) nextTimeEl.textContent = "Error loading visits";
  }
}

/* -------------------------------------------------------------------------
   HELPER FORMATTING FUNCTIONS
   ------------------------------------------------------------------------- */

function formatApptTime(time24) {
  if (!time24) return "--:--";
  // Check if global formatTime12h exists from appointment.js
  if (typeof formatTime12h === "function") {
    return formatTime12h(time24);
  }
  // Fallback 12-hour converter
  const [h, m] = time24.split(":");
  let hours = parseInt(h, 10);
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${m} ${suffix}`;
}

function formatApptDate(dateStr) {
  if (!dateStr) return "";
  if (typeof formatDate === "function") {
    return formatDate(dateStr);
  }
  const d = new Date(dateStr);
  if (typeof getCurrentLang === "function" && getCurrentLang() === "bn" && typeof t === "function") {
    const monthName = t(`cal_month_${d.getMonth() + 1}`, "");
    const formatted = `${d.getDate()} ${monthName}`;
    return typeof localizeTimeString === "function" ? localizeTimeString(formatted) : formatted;
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* -------------------------------------------------------------------------
   GENERAL REMINDER CONTROLS & TOGGLES
   ------------------------------------------------------------------------- */

function bindReminderControls() {
  // Attach change event listeners to all enable switches
  document.querySelectorAll('[data-role="enable-toggle"]').forEach((toggle) => {
    toggle.addEventListener("change", (e) => {
      const card = e.target.closest(".reminder-card");
      const statusBadge = card ? card.querySelector('[data-role="status"]') : null;
      if (statusBadge) {
        statusBadge.textContent = e.target.checked ? "On" : "Off";
        statusBadge.style.backgroundColor = e.target.checked ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)";
        statusBadge.style.color = e.target.checked ? "#10b981" : "#ef4444";
      }
    });
  });
}

// Toggle Doctor Reminder specifically
function toggleReminder(type) {
  if (type === 'doctor') {
    const toggle = document.getElementById("doctorToggle");
    const badge = document.getElementById("doctorStatusBadge");
    if (toggle && badge) {
      const isOn = toggle.checked;
      badge.textContent = isOn ? "On" : "Off";
      badge.style.backgroundColor = isOn ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)";
      badge.style.color = isOn ? "#10b981" : "#ef4444";
    }
  }
}

// Pause Reminder handler
function pauseReminder(type) {
  if (typeof showToast === "function") {
    showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} reminders paused for today`, "info");
  } else {
    alert(`${type.charAt(0).toUpperCase() + type.slice(1)} reminders paused for today`);
  }
}
/* =========================================================================
   reminders.js — Comprehensive Reminder Center Module
   Handles Water, Meal, Exercise, Sleep, Medicine, and Doctor Appointments
   ========================================================================= */

// Global State Management for Reminders
const reminderState = {
  water: { enabled: true, paused: false, skippedToday: false },
  meal: { enabled: true, paused: false, skippedToday: false },
  exercise: { enabled: true, paused: false, skippedToday: false },
  sleep: { enabled: true, paused: false, skippedToday: false },
  medicine: { enabled: true, paused: false, skippedToday: false },
  doctor: { enabled: true, paused: false, skippedToday: false }
};

document.addEventListener("DOMContentLoaded", async () => {
  // 1. Authenticate user if apptUser is not already globally available
  if (typeof apptUser === "undefined" || !apptUser) {
    if (typeof requireAuth === "function") {
      window.apptUser = await requireAuth();
    }
  }

  // 2. Initialize Doctor Appointments Card
  await initDoctorAppointmentCard();

  // 3. Bind Event Listeners for standard cards and switches
  bindReminderControls();
});

/* -------------------------------------------------------------------------
   1. DOCTOR APPOINTMENTS MODULE
   ------------------------------------------------------------------------- */

async function initDoctorAppointmentCard() {
  const nextTimeEl = document.getElementById("doctorNextTime");
  const listEl = document.getElementById("doctorAppointmentsList");

  if (!window.apptUser) {
    if (nextTimeEl) nextTimeEl.textContent = t("doctor_please_sign_in", "Please sign in");
    return;
  }

  // Get current local date in YYYY-MM-DD format
  const todayStr = typeof todayDateStr === "function" 
    ? todayDateStr() 
    : new Date().toISOString().split("T")[0];

  try {
    // Query doctor appointments from database
    const { data: appointments, error } = await supabaseClient
      .from("doctor_appointments")
      .select("*")
      .eq("user_id", window.apptUser.id)
      .eq("status", "upcoming")
      .gte("appointment_date", todayStr)
      .order("appointment_date", { ascending: true })
      .order("appointment_time", { ascending: true });

    if (error) throw error;

    if (!appointments || appointments.length === 0) {
      if (nextTimeEl) nextTimeEl.textContent = t("doctor_no_upcoming_visits", "No upcoming visits");
      if (listEl) {
        listEl.innerHTML = `<div class="text-xs text-muted py-2">${t("doctor_no_appts_scheduled_today", "No appointments scheduled for today.")}</div>`;
      }
      return;
    }

    // --- A. Render Next Upcoming Appointment (Earliest) ---
    const earliest = appointments[0];
    const formattedDate = formatApptDate(earliest.appointment_date);
    const formattedTime = formatApptTime(earliest.appointment_time);

    if (nextTimeEl) {
      nextTimeEl.innerHTML = `<span class="text-primary">${formattedTime}</span> <span class="text-xs text-muted">(${formattedDate})</span>`;
    }

    // --- B. Render List of Scheduled Appointments ---
    if (listEl) {
      listEl.innerHTML = appointments.map((appt) => {
        const timeStr = formatApptTime(appt.appointment_time);
        const dateStr = formatApptDate(appt.appointment_date);

        return `
          <div class="flex-between align-center p-2 border-rounded mb-2" style="background: var(--color-surface-raised, rgba(255,255,255,0.05)); border: 1px solid var(--color-border, rgba(255,255,255,0.1)); border-radius: 8px;">
            <div style="min-width: 0; flex: 1;">
              <div class="font-semibold text-sm truncate" style="color: var(--color-text, #fff);">${appt.doctor_name}</div>
              <div class="text-xs text-muted truncate">🏥 ${appt.hospital_name || 'Clinic'} (${dateStr})</div>
            </div>
            <div class="text-right" style="margin-left: 10px; flex-shrink: 0;">
              <div class="badge badge-sm" style="background: rgba(147, 51, 234, 0.2); color: #c084fc; font-weight: 600; padding: 3px 8px; border-radius: 6px; font-size: 0.75rem;">
                🕒 ${timeStr}
              </div>
            </div>
          </div>
        `;
      }).join("");
    }

  } catch (err) {
    console.error("Error loading doctor appointment reminders:", err);
    if (nextTimeEl) nextTimeEl.textContent = "Error loading visits";
  }
}

/* -------------------------------------------------------------------------
   2. PAUSE / RESUME & TOGGLE CONTROLS
   ------------------------------------------------------------------------- */

// Toggle Enable/Disable Switch for Doctor Reminders
function toggleReminder(type) {
  if (type === 'doctor') {
    const toggle = document.getElementById("doctorToggle");
    if (toggle) {
      reminderState.doctor.enabled = toggle.checked;
      updateDoctorBadgeStatus();
    }
  }
}

// Pause or Resume Reminders
function pauseReminder(type) {
  if (!reminderState[type]) return;

  // Toggle pause state
  reminderState[type].paused = !reminderState[type].paused;
  const isPaused = reminderState[type].paused;

  // Handle Doctor-specific button and badge UI updates
  if (type === 'doctor') {
    const pauseBtn = document.getElementById("doctorPauseBtn");
    if (pauseBtn) {
      pauseBtn.textContent = isPaused ? t("reminder_resume_btn", "▶️ Resume reminders") : t("reminder_pause_btn", "⏸️ Pause reminders");
    }
    updateDoctorBadgeStatus();
  } else {
    // Handle generic card updates
    const card = document.querySelector(`.reminder-card[data-type="${type}"]`);
    const pauseBtn = card ? card.querySelector('[id$="PauseBtn"]') : null;
    if (pauseBtn) {
      pauseBtn.textContent = isPaused ? t("reminder_resume_btn", "▶️ Resume reminders") : t("reminder_pause_btn", "⏸️ Pause reminders");
    }
  }

  // Display feedback notification
  const title = type.charAt(0).toUpperCase() + type.slice(1);
  const msg = isPaused 
    ? `${title} reminders paused for today` 
    : `${title} reminders resumed`;

  if (typeof showToast === "function") {
    showToast(msg, "info");
  } else {
    alert(msg);
  }
}

// Update Doctor Status Badge UI (On / Off / Paused)
function updateDoctorBadgeStatus() {
  const badge = document.getElementById("doctorStatusBadge");
  if (!badge) return;

  if (!reminderState.doctor.enabled) {
    badge.textContent = t("reminder_status_off", "Off");
    badge.style.backgroundColor = "rgba(239, 68, 68, 0.2)";
    badge.style.color = "#ef4444";
  } else if (reminderState.doctor.paused) {
    badge.textContent = t("reminder_status_paused", "Paused");
    badge.style.backgroundColor = "rgba(245, 158, 11, 0.2)";
    badge.style.color = "#f59e0b";
  } else {
    badge.textContent = t("reminder_status_on", "On");
    badge.style.backgroundColor = "rgba(16, 185, 129, 0.2)";
    badge.style.color = "#10b981";
  }
}

// Bind listeners for standard card switches (Water, Meal, Sleep, Exercise, Medicine)
function bindReminderControls() {
  document.querySelectorAll('[data-role="enable-toggle"]').forEach((toggle) => {
    toggle.addEventListener("change", (e) => {
      const card = e.target.closest(".reminder-card");
      const type = card ? card.dataset.type : null;
      const statusBadge = card ? card.querySelector('[data-role="status"]') : null;

      if (type && reminderState[type]) {
        reminderState[type].enabled = e.target.checked;
      }

      if (statusBadge) {
        const isOn = e.target.checked;
        statusBadge.textContent = isOn ? t("reminder_status_on", "On") : t("reminder_status_off", "Off");
        statusBadge.style.backgroundColor = isOn ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)";
        statusBadge.style.color = isOn ? "#10b981" : "#ef4444";
      }
    });
  });
}

/* -------------------------------------------------------------------------
   3. TIME & DATE FORMATTING HELPERS
   ------------------------------------------------------------------------- */

function formatApptTime(time24) {
  if (!time24) return "--:--";
  // Use global formatTime12h from appointment.js if present
  if (typeof formatTime12h === "function") {
    return formatTime12h(time24);
  }
  // Fallback 24h to 12h converter
  const parts = time24.split(":");
  let hours = parseInt(parts[0], 10);
  const minutes = parts[1] ? parts[1].substring(0, 2) : "00";
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${suffix}`;
}

function formatApptDate(dateStr) {
  if (!dateStr) return "";
  if (typeof formatDate === "function") {
    return formatDate(dateStr);
  }
  const d = new Date(dateStr);
  if (typeof getCurrentLang === "function" && getCurrentLang() === "bn" && typeof t === "function") {
    const monthName = t(`cal_month_${d.getMonth() + 1}`, "");
    const formatted = `${d.getDate()} ${monthName}`;
    return typeof localizeTimeString === "function" ? localizeTimeString(formatted) : formatted;
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
