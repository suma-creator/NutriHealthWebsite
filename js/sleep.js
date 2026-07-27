/* =========================================================================
   sleep.js
   ========================================================================= */

let sleepUser = null;

document.addEventListener("DOMContentLoaded", async () => {
  sleepUser = await requireAuth();
  if (!sleepUser) return;

  renderShell("sleep.html");
  await loadUserChip(sleepUser);
  await loadSleepHistory();
  await loadWeeklyReport();
  await loadMonthlyStats();
  await loadSleepDashboard();
  hidePageLoader();

  qs("#sleepForm").addEventListener("submit", handleSleepSubmit);
  qs("#sleepTimeInput").addEventListener("input", updateDurationPreview);
  qs("#wakeTimeInput").addEventListener("input", updateDurationPreview);
});

// Minutes of sleep between a sleep time and a wake time, wrapping past
// midnight correctly (e.g. sleep 23:30 -> wake 07:00 is 7.5h, not negative).
function computeSleepMinutes(sleepTimeStr, wakeTimeStr) {
  const [sh, sm] = sleepTimeStr.split(":").map(Number);
  const [wh, wm] = wakeTimeStr.split(":").map(Number);
  const sleepMinutes = sh * 60 + sm;
  const wakeMinutes = wh * 60 + wm;
  return ((wakeMinutes - sleepMinutes) + 24 * 60) % (24 * 60);
}

function formatDurationLabel(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Rounds a decimal-hours value to 1 decimal place for display, so a
// duration like 19.5499999...h from time-math never shows as "19.55h" in
// one place and "19.5h"/"19.6h" in another.
function roundHours(h) {
  return Math.round(Number(h) * 10) / 10;
}

// Sleep time / wake time only capture a time-of-day, not a date, so an
// accidental AM/PM-style mix-up (e.g. picking 04:00 instead of 16:00)
// silently produces a "valid" but wildly wrong wrap-around duration like
// 19h 33m. This isn't something the times alone can detect for certain,
// so instead of blocking it outright, anything outside a normal sleep
// window gets flagged so the person can double check before saving.
const SLEEP_DURATION_MIN_NORMAL_MINUTES = 2 * 60;
const SLEEP_DURATION_MAX_NORMAL_MINUTES = 12 * 60;

function isUnusualDuration(totalMinutes) {
  return totalMinutes < SLEEP_DURATION_MIN_NORMAL_MINUTES || totalMinutes > SLEEP_DURATION_MAX_NORMAL_MINUTES;
}

function updateDurationPreview() {
  const preview = qs("#sleepDurationPreview");
  const sleepTime = qs("#sleepTimeInput").value;
  const wakeTime = qs("#wakeTimeInput").value;
  if (!preview) return;

  if (!sleepTime || !wakeTime) {
    preview.className = "text-sm text-muted";
    preview.textContent = t("sleep_duration_preview_placeholder", "Duration will be calculated automatically.");
    return;
  }

  const minutes = computeSleepMinutes(sleepTime, wakeTime);
  const label = t("sleep_duration_preview", "That's {duration} of sleep.").replace("{duration}", formatDurationLabel(minutes));

  if (isUnusualDuration(minutes)) {
    preview.className = "text-sm mt-8";
    preview.style.color = "var(--color-amber, #e6b84e)";
    preview.textContent = `⚠️ ${label} ${t("sleep_duration_unusual_hint", "That's an unusual amount — double check your sleep and wake times.")}`;
  } else {
    preview.className = "text-sm text-muted";
    preview.style.color = "";
    preview.textContent = label;
  }
}

function analyzeSleep(hours, stress) {
  let quality, tip, icon;

  if (hours < 6) {
    quality = "Poor sleep";
    icon = "icon-coral";
    tip = "You're running on a sleep deficit. Try to add 30–60 extra minutes tonight and avoid screens before bed.";
  } else if (hours < 7) {
    quality = "Fair sleep";
    icon = "icon-amber";
    tip = "Close to the recommended range — a slightly earlier bedtime could help you feel sharper.";
  } else if (hours <= 9) {
    quality = "Good sleep";
    icon = "icon-mint";
    tip = "Right in the healthy 7–9 hour range. Keep this consistent bedtime routine going.";
  } else {
    quality = "Oversleeping";
    icon = "icon-amber";
    tip = "More than 9 hours regularly can sometimes signal fatigue or poor sleep quality — consider a consistent wake time.";
  }

  if (stress >= 7) {
    tip += " Your stress level is high today — a short walk, breathing exercise, or journaling before bed may help.";
  }

  return { quality, tip, icon };
}

async function handleSleepSubmit(event) {
  event.preventDefault();
  const sleep_time = qs("#sleepTimeInput").value;
  const wake_time = qs("#wakeTimeInput").value;
  const minutes = computeSleepMinutes(sleep_time, wake_time);

  if (isUnusualDuration(minutes)) {
    const proceed = confirm(
      `${t("sleep_duration_unusual_hint", "That's an unusual amount — double check your sleep and wake times.")}\n\n` +
      `${t("sleep_time_label", "Sleep time")}: ${formatTime12h(sleep_time)} → ${t("sleep_wake_time_input_label", "Wake-up time")}: ${formatTime12h(wake_time)} = ${formatDurationLabel(minutes)}.\n\n` +
      t("sleep_duration_confirm_save", "Save anyway?")
    );
    if (!proceed) return;
  }

  const btn = qs("#sleepBtn");
  const sleep_hours = roundHours(minutes / 60);
  const stress_level = parseInt(qs("#stressLevel").value, 10);

  setBtnLoading(btn, true, "Saving...");

  const { error } = await supabaseClient.from("sleep_logs").insert({
    user_id: sleepUser.id,
    sleep_hours,
    sleep_time,
    wake_time,
    stress_level
  });

  setBtnLoading(btn, false, t("sleep_save_entry_btn", "Save entry"));

  if (error) { showToast(error.message, "error"); return; }

  const { quality, tip, icon } = analyzeSleep(sleep_hours, stress_level);
  qs("#sleepResult").style.display = "block";
  const grid = qs("#sleepGrid");
  if (grid) {
    grid.classList.remove("grid-single");
    grid.classList.add("grid-double");
  }
  qs("#sleepQuality").textContent = quality;
  qs("#sleepTip").textContent = tip;
  qs("#sleepIcon").className = `stat-icon ${icon}`;

  showToast(t("toast_sleep_saved", "Sleep entry saved!"), "success");
  await loadSleepHistory();
  await loadWeeklyReport();
  await loadMonthlyStats();
  await loadSleepDashboard();
}

async function loadSleepHistory() {
  const { data, error } = await supabaseClient
    .from("sleep_logs")
    .select("*")
    .eq("user_id", sleepUser.id)
    .order("created_at", { ascending: false })
    .limit(7);

  const container = qs("#sleepHistory");

  if (error || !data || !data.length) {
    container.innerHTML = `<p class="text-sm text-muted">No entries yet — log your first night above.</p>`;
    return;
  }

  const latest = analyzeSleep(data[0].sleep_hours, data[0].stress_level);
  qs("#sleepResult").style.display = "block";
  qs("#sleepQuality").textContent = latest.quality;
  qs("#sleepTip").textContent = latest.tip;
  qs("#sleepIcon").className = `stat-icon ${latest.icon}`;

  container.innerHTML = data.map((row) => `
    <div class="flex-between" style="padding:10px 0;border-bottom:1px solid var(--color-border);">
      <span class="text-sm">${formatDate(row.created_at)}</span>
      <span class="text-sm mono">${roundHours(row.sleep_hours)}h sleep</span>
      <span class="text-sm mono">Stress ${row.stress_level}/10</span>
    </div>
  `).join("");
}

/* =========================================================================
   Smart Features — Weekly sleep report & Monthly sleep statistics.
   Both are read-only summaries computed client-side from sleep_logs;
   nothing here writes any data, so the simple log/history flow above is
   completely unaffected.
   ========================================================================= */

const SLEEP_CHART_MIN_HOURS = 8;

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function loadWeeklyReport() {
  const container = qs("#sleepWeeklyReport");
  if (!container) return;

  const { data, error } = await supabaseClient
    .from("sleep_logs")
    .select("*")
    .eq("user_id", sleepUser.id)
    .gte("created_at", daysAgoIso(7))
    .order("created_at", { ascending: true });

  if (error || !data || !data.length) {
    container.innerHTML = `<p class="text-sm text-muted" data-i18n="sleep_no_weekly_data">Not enough entries yet this week — log a few nights to see your report.</p>`;
    applyTranslations(container);
    return;
  }

  const hours = data.map((r) => Number(r.sleep_hours));
  const stress = data.map((r) => Number(r.stress_level)).filter((n) => !Number.isNaN(n));
  const avgHours = average(hours);
  const avgStress = average(stress);
  const maxHours = Math.max(...hours, SLEEP_CHART_MIN_HOURS);

  const bars = data.map((row) => {
    const h = roundHours(row.sleep_hours);
    const pct = Math.max(6, Math.round((h / maxHours) * 100));
    const day = new Date(row.created_at).toLocaleDateString(undefined, { weekday: "short" });
    return `
      <div class="flex-col" style="align-items:center;flex:1;">
        <div class="text-sm mono">${h}h</div>
        <div style="width:100%;max-width:28px;height:90px;display:flex;align-items:flex-end;">
          <div style="width:100%;height:${pct}%;background:var(--color-teal, var(--color-mint));border-radius:6px 6px 0 0;"></div>
        </div>
        <div class="text-sm text-muted mt-6">${day}</div>
      </div>`;
  }).join("");

  container.innerHTML = `
    <div class="flex gap-8" style="align-items:flex-end;">${bars}</div>
    <div class="flex-between mt-24" style="border-top:1px solid var(--color-border);padding-top:12px;">
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_avg_duration_label">Average sleep</div>
        <div style="font-weight:700;">${avgHours.toFixed(1)}h</div>
      </div>
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_avg_stress_label">Average stress</div>
        <div style="font-weight:700;">${avgStress.toFixed(1)}/10</div>
      </div>
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_nights_logged_label">Nights logged</div>
        <div style="font-weight:700;">${data.length}/7</div>
      </div>
    </div>
  `;
  applyTranslations(container);
}

async function loadMonthlyStats() {
  const container = qs("#sleepMonthlyStats");
  if (!container) return;

  const { data, error } = await supabaseClient
    .from("sleep_logs")
    .select("*")
    .eq("user_id", sleepUser.id)
    .gte("created_at", daysAgoIso(30))
    .order("created_at", { ascending: true });

  if (error || !data || !data.length) {
    container.innerHTML = `<p class="text-sm text-muted" data-i18n="sleep_no_monthly_data">Not enough entries yet this month — keep logging to unlock monthly stats.</p>`;
    applyTranslations(container);
    return;
  }

  const hours = data.map((r) => Number(r.sleep_hours));
  const avgHours = average(hours);
  const best = Math.max(...hours);
  const worst = Math.min(...hours);
  const inRange = hours.filter((h) => h >= 7 && h <= 9).length;
  const consistencyPct = Math.round((inRange / hours.length) * 100);

  container.innerHTML = `
    <div class="grid grid-2" style="gap:14px;">
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_avg_duration_label">Average sleep</div>
        <div style="font-weight:700;font-size:1.1rem;">${avgHours.toFixed(1)}h</div>
      </div>
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_entries_logged_label">Entries logged</div>
        <div style="font-weight:700;font-size:1.1rem;">${data.length}</div>
      </div>
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_best_night_label">Best night</div>
        <div style="font-weight:700;font-size:1.1rem;">${roundHours(best)}h</div>
      </div>
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_shortest_night_label">Shortest night</div>
        <div style="font-weight:700;font-size:1.1rem;">${roundHours(worst)}h</div>
      </div>
    </div>
    <div class="mt-16" style="border-top:1px solid var(--color-border);padding-top:12px;">
      <div class="flex-between text-sm">
        <span data-i18n="sleep_consistency_label">Nights in the healthy 7–9h range</span>
        <span class="mono">${consistencyPct}%</span>
      </div>
      <div style="background:var(--color-surface-raised);border-radius:20px;height:8px;margin-top:8px;overflow:hidden;">
        <div style="width:${consistencyPct}%;height:100%;background:var(--color-mint);"></div>
      </div>
    </div>
  `;
  applyTranslations(container);
}

/* =========================================================================
   Sleep Dashboard — today's duration, sleep goal, average duration, a
   compact weekly chart, current streak, and a 0-100 sleep score. Reads
   sleep_logs (last 30 days) plus the sleep goal stored on the existing
   reminder_settings row (reminder_type = 'sleep'); never writes to
   reminder_settings except when the user explicitly edits their goal.
   ========================================================================= */

let sleepGoalHours = 8;

async function loadSleepDashboard() {
  const container = qs("#sleepDashboard");
  if (!container) return;

  const [{ data: logs }, { data: settingRow }] = await Promise.all([
    supabaseClient
      .from("sleep_logs")
      .select("*")
      .eq("user_id", sleepUser.id)
      .gte("created_at", daysAgoIso(30))
      .order("created_at", { ascending: false }),
    supabaseClient
      .from("reminder_settings")
      .select("goal_hours")
      .eq("user_id", sleepUser.id)
      .eq("reminder_type", "sleep")
      .maybeSingle()
  ]);

  sleepGoalHours = Number(settingRow?.goal_hours) || 8;
  const data = logs || [];

  if (!data.length) {
    container.innerHTML = `<p class="text-sm text-muted" data-i18n="sleep_no_dashboard_data">Log your first night to see your dashboard.</p>`;
    applyTranslations(container);
    return;
  }

  const todayStr = todayDateStr();
  const todayEntry = data.find((row) => row.created_at.slice(0, 10) === todayStr) || data[0];
  const todayHours = roundHours(todayEntry.sleep_hours);

  const hours = data.map((r) => Number(r.sleep_hours));
  const avgHours = average(hours);

  // Current streak — consecutive calendar days (ending today or
  // yesterday) with at least one entry logged.
  const loggedDates = new Set(data.map((r) => r.created_at.slice(0, 10)));
  let streak = 0;
  let cursor = new Date();
  if (!loggedDates.has(todayDateStr())) cursor.setDate(cursor.getDate() - 1); // allow today to still be "in progress"
  while (true) {
    const key = cursor.toISOString().slice(0, 10);
    if (!loggedDates.has(key)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  // Sleep score (0-100): how close to the goal, consistency in the
  // healthy 7-9h range, and average stress — simple, transparent blend.
  const goalScore = Math.max(0, 100 - Math.abs(avgHours - sleepGoalHours) * 20);
  const inRangePct = (hours.filter((h) => h >= 7 && h <= 9).length / hours.length) * 100;
  const stressVals = data.map((r) => Number(r.stress_level)).filter((n) => !Number.isNaN(n));
  const avgStress = stressVals.length ? average(stressVals) : 5;
  const stressScore = Math.max(0, 100 - (avgStress - 1) * (100 / 9));
  const sleepScore = Math.round(goalScore * 0.4 + inRangePct * 0.35 + stressScore * 0.25);

  const last7 = data.slice(0, 7).slice().reverse();
  const maxH = Math.max(...last7.map((r) => Number(r.sleep_hours)), 8);
  const miniBars = last7.map((row) => {
    const h = roundHours(row.sleep_hours);
    const pct = Math.max(8, Math.round((h / maxH) * 100));
    return `<div style="flex:1;max-width:18px;height:${pct}%;background:var(--color-mint);border-radius:4px 4px 0 0;" title="${h}h"></div>`;
  }).join("");

  container.innerHTML = `
    <div class="grid grid-2" style="gap:16px;">
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_today_duration_label">Today's sleep duration</div>
        <div style="font-weight:700;font-size:1.3rem;">${todayHours}h</div>
      </div>
      <div>
        <div class="flex-between" style="align-items:center;">
          <div class="text-sm text-muted" data-i18n="sleep_goal_label">Sleep goal</div>
          <button type="button" class="btn btn-ghost btn-sm" id="sleepGoalEditBtn" data-i18n="reminder_edit">✏️ Edit</button>
        </div>
        <div style="font-weight:700;font-size:1.3rem;" id="sleepGoalDisplay">${sleepGoalHours}h</div>
        <div class="flex gap-8 mt-8" id="sleepGoalEditRow" style="display:none;">
          <input type="number" min="1" max="14" step="0.5" class="form-input" id="sleepGoalInput" style="max-width:100px;" value="${sleepGoalHours}" />
          <button type="button" class="btn btn-primary btn-sm" id="sleepGoalSaveBtn" data-i18n="reminder_save">Save</button>
        </div>
      </div>
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_avg_duration_30d_label">Average (30 days)</div>
        <div style="font-weight:700;font-size:1.3rem;">${avgHours.toFixed(1)}h</div>
      </div>
      <div>
        <div class="text-sm text-muted" data-i18n="sleep_streak_label">Sleep streak</div>
        <div style="font-weight:700;font-size:1.3rem;">🔥 ${streak} <span class="text-sm text-muted" data-i18n="sleep_streak_days">days</span></div>
      </div>
    </div>

    <div class="grid grid-2 mt-24" style="gap:16px;align-items:center;">
      <div>
        <div class="text-sm text-muted mb-8" data-i18n="sleep_weekly_chart_label">This week</div>
        <div class="flex gap-6" style="align-items:flex-end;height:50px;">${miniBars}</div>
      </div>
      <div class="text-center">
        <div class="text-sm text-muted" data-i18n="sleep_score_label">Sleep score</div>
        <div style="font-weight:800;font-size:2rem;color:var(--color-mint);">${sleepScore}</div>
        <div class="text-sm text-muted" data-i18n="sleep_score_out_of">out of 100</div>
      </div>
    </div>
  `;
  applyTranslations(container);
  wireSleepGoalEdit();
}

function wireSleepGoalEdit() {
  const editBtn = qs("#sleepGoalEditBtn");
  const editRow = qs("#sleepGoalEditRow");
  const saveBtn = qs("#sleepGoalSaveBtn");
  if (!editBtn) return;

  editBtn.addEventListener("click", () => {
    editRow.style.display = editRow.style.display === "none" ? "flex" : "none";
  });

  saveBtn.addEventListener("click", async () => {
    const value = Number(qs("#sleepGoalInput").value);
    if (!value || value <= 0) {
      showToast(t("sleep_goal_invalid", "Please enter a valid number of hours."), "error");
      return;
    }

    setBtnLoading(saveBtn, true, t("reminder_save", "Save"));
    const { error } = await supabaseClient
      .from("reminder_settings")
      .upsert({
        user_id: sleepUser.id,
        reminder_type: "sleep",
        goal_hours: value,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,reminder_type" });
    setBtnLoading(saveBtn, false, t("reminder_save", "Save"));

    if (error) { showToast(error.message, "error"); return; }

    showToast(t("reminder_saved_toast", "Reminder updated"), "success");
    await loadSleepDashboard();
  });
}
