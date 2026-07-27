/* =========================================================================
   health-calendar.js
   -------------------------------------------------------------------------
   Monthly Health Calendar + Daily Summary.

   Deliberately reads straight from the tables every other feature already
   writes to (bmi_logs, water_logs, sleep_logs, food_logs, exercise_logs,
   symptom_logs, doctor_appointments, reminder_history) instead of a
   duplicate "log everything again" pipeline — see the comment above
   daily_health_logs in sql/schema.sql for why. The only new table is
   daily_health_logs, used for the optional per-day mood/rating/note.

   Per-day score reuses the same component weights as js/health-score.js
   (Nutrition 30 / Exercise 25 / Sleep 20 / Hydration 15 / BMI 10) so the
   two pages agree with each other, but scores THAT DAY's data only
   (health-score.js scores "today" using the latest-known BMI/sleep even
   if logged days ago; the calendar is about what happened ON that date).
   ========================================================================= */

const CAL_WEEKDAY_KEYS = [
  "cal_sun", "cal_mon", "cal_tue", "cal_wed", "cal_thu", "cal_fri", "cal_sat"
];
const CAL_WEEKDAY_FALLBACK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const CAL_MONTH_KEYS = [
  "cal_month_1", "cal_month_2", "cal_month_3", "cal_month_4", "cal_month_5", "cal_month_6",
  "cal_month_7", "cal_month_8", "cal_month_9", "cal_month_10", "cal_month_11", "cal_month_12"
];
const CAL_MONTH_FALLBACK = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

let CAL_USER = null;
let CAL_YEAR = new Date().getFullYear();
let CAL_MONTH = new Date().getMonth(); // 0-indexed
let CAL_MONTH_MAP = {}; // dateStr -> day summary object, filled by loadMonthData
let CAL_CURRENT_STREAK = null; // real cross-month streak, shared with reports.js — see getCurrentStreak() in ui.js

// Phase 5 — filters, search, and chart period state
const CAL_FILTER_DEFS = [
  { key: "water", icon: "💧", labelKey: "cal_section_water", fallback: "Water" },
  { key: "meals", icon: "🍽", labelKey: "cal_section_nutrition", fallback: "Nutrition" },
  { key: "exercise", icon: "🏃", labelKey: "cal_section_exercise", fallback: "Exercise" },
  { key: "sleep", icon: "😴", labelKey: "cal_section_sleep", fallback: "Sleep" },
  { key: "medicineReminders", icon: "💊", labelKey: "cal_section_medicine", fallback: "Medicine" },
  { key: "bmi", icon: "⚖", labelKey: "cal_section_bmi", fallback: "BMI" },
  { key: "symptoms", icon: "🩺", labelKey: "cal_section_symptoms", fallback: "Symptom Checker" },
  { key: "appointments", icon: "📅", labelKey: "cal_section_appointment", fallback: "Doctor Appointment" },
];
let CAL_FILTER_TYPES = new Set(); // activity keys currently toggled on
let CAL_SEARCH_TERM = "";
let CAL_CHART_PERIOD = "monthly"; // "weekly" | "monthly" | "yearly"

document.addEventListener("DOMContentLoaded", async () => {
  const user = await requireAuth();
  if (!user) return;
  CAL_USER = user;

  renderShell("health-calendar.html");
  await loadUserChip(user);

  bindCalendarControls();
  renderFilterChips();
  await renderCalendarMonth();
  await renderAnalyticsSection();

  getCurrentStreak(user).then((streak) => {
    CAL_CURRENT_STREAK = streak;
    renderMonthlySummaryStrip(CAL_MONTH_MAP); // repaint with the real streak once it's in
  });

  hidePageLoader();
});

/* ---------------------------------------------------------------------
   Navigation
   --------------------------------------------------------------------- */
function bindCalendarControls() {
  document.getElementById("calPrevBtn")?.addEventListener("click", () => shiftMonth(-1));
  document.getElementById("calNextBtn")?.addEventListener("click", () => shiftMonth(1));
  document.getElementById("calTodayBtn")?.addEventListener("click", () => {
    const now = new Date();
    CAL_YEAR = now.getFullYear();
    CAL_MONTH = now.getMonth();
    renderCalendarMonth();
    renderAnalyticsSection();
  });
  document.getElementById("calModalOverlay")?.addEventListener("click", closeCalDayModal);
  document.getElementById("calModalCloseBtn")?.addEventListener("click", closeCalDayModal);
  document.getElementById("calMoodForm")?.addEventListener("submit", saveMoodNote);

  let searchDebounce = null;
  document.getElementById("calSearchInput")?.addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      CAL_SEARCH_TERM = e.target.value.trim().toLowerCase();
      applyCalFilters();
    }, 200);
  });

  document.getElementById("calClearFiltersBtn")?.addEventListener("click", () => {
    CAL_FILTER_TYPES.clear();
    CAL_SEARCH_TERM = "";
    const searchInput = document.getElementById("calSearchInput");
    if (searchInput) searchInput.value = "";
    renderFilterChips();
    applyCalFilters();
  });

  document.getElementById("calPeriodToggle")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-period]");
    if (!btn) return;
    CAL_CHART_PERIOD = btn.dataset.period;
    document.querySelectorAll("#calPeriodToggle [data-period]").forEach((b) => {
      b.classList.toggle("chip-active", b === btn);
    });
    renderAnalyticsSection();
  });
}

function shiftMonth(delta) {
  CAL_MONTH += delta;
  if (CAL_MONTH < 0) { CAL_MONTH = 11; CAL_YEAR -= 1; }
  if (CAL_MONTH > 11) { CAL_MONTH = 0; CAL_YEAR += 1; }
  renderCalendarMonth();
  renderAnalyticsSection();
}

/* ---------------------------------------------------------------------
   Month load + render
   --------------------------------------------------------------------- */
async function renderCalendarMonth() {
  const grid = document.getElementById("calendarGrid");
  const label = document.getElementById("calMonthLabel");
  if (!grid || !label) return;

  label.textContent = `${t(CAL_MONTH_KEYS[CAL_MONTH], CAL_MONTH_FALLBACK[CAL_MONTH])} ${CAL_YEAR}`;

  grid.innerHTML = `<div class="cal-loading">${t("cal_loading", "Loading your month…")}</div>`;

  CAL_MONTH_MAP = await loadMonthData(CAL_USER, CAL_YEAR, CAL_MONTH);
  renderMonthlySummaryStrip(CAL_MONTH_MAP);
  paintCalendarGrid(grid, CAL_YEAR, CAL_MONTH, CAL_MONTH_MAP);
  updateFilterStatus();
}

async function loadMonthData(user, year, month) {
  const { startStr, endStr } = monthRange(year, month);
  return loadDayMapForRange(user, startStr, endStr);
}

const CAL_STATUS_DOT = { excellent: "🟢", good: "🟡", average: "🟠", "needs-improvement": "🔴", "no-data": "⚪" };
const CAL_STATUS_LABEL_KEY = {
  excellent: "cal_status_excellent", good: "cal_status_good", average: "cal_status_average",
  "needs-improvement": "cal_status_needs_improvement", "no-data": "cal_status_no_data"
};
const CAL_STATUS_LABEL_FALLBACK = {
  excellent: "Excellent Day", good: "Good Day", average: "Average Day",
  "needs-improvement": "Needs Improvement", "no-data": "No Data"
};

/* ---------------------------------------------------------------------
   Grid painting
   --------------------------------------------------------------------- */
function paintCalendarGrid(grid, year, month, monthMap) {
  const { daysInMonth } = monthRange(year, month);
  const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sun
  const today = todayDateStr();

  let html = `<div class="cal-weekday-row">`;
  CAL_WEEKDAY_KEYS.forEach((k, i) => {
    html += `<div class="cal-weekday" data-i18n="${k}">${t(k, CAL_WEEKDAY_FALLBACK[i])}</div>`;
  });
  html += `</div><div class="cal-days-grid">`;

  for (let i = 0; i < firstWeekday; i++) html += `<div class="cal-day cal-day-empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const info = monthMap[dateStr];
    const status = info ? info.status : "no-data";
    const isToday = dateStr === today;
    const isFuture = dateStr > today;

    const icons = info ? dayActivityIcons(info) : "";
    const hasActiveFilter = CAL_FILTER_TYPES.size > 0 || !!CAL_SEARCH_TERM;
    const dimmed = hasActiveFilter && !dayMatchesFilters(info);

    html += `
      <button type="button" class="cal-day cal-day-status-${status} ${isToday ? "cal-day-today" : ""} ${isFuture ? "cal-day-future" : ""} ${dimmed ? "cal-day-dimmed" : ""}"
              data-date="${dateStr}" onclick="openCalDayModal('${dateStr}')">
        <span class="cal-day-num">${d}</span>
        <span class="cal-day-dot">${CAL_STATUS_DOT[status]}</span>
        ${icons ? `<span class="cal-day-icons">${icons}</span>` : ""}
        ${info && info.score !== null ? `<span class="cal-day-score">${info.score}</span>` : ""}
      </button>
    `;
  }

  html += `</div>`;
  grid.innerHTML = html;
  if (typeof applyTranslations === "function") applyTranslations(grid);
}

function dayActivityIcons(info) {
  const parts = [];
  if (info.water) parts.push("💧");
  if (info.meals?.length) parts.push("🍽");
  if (info.exercise) parts.push("🏃");
  if (info.sleep) parts.push("😴");
  if (info.medicineReminders?.length) parts.push("💊");
  if (info.bmi) parts.push("⚖");
  if (info.symptoms?.length) parts.push("🩺");
  if (info.appointments?.length) parts.push("📅");
  return parts.join(" ");
}

/* ---------------------------------------------------------------------
   Phase 5 — activity filters + search
   --------------------------------------------------------------------- */
function renderFilterChips() {
  const el = document.getElementById("calFilterChips");
  if (!el) return;
  el.innerHTML = CAL_FILTER_DEFS.map((f) => `
    <button type="button" class="chip chip-sm ${CAL_FILTER_TYPES.has(f.key) ? "chip-active" : ""}" data-filter-key="${f.key}">
      ${f.icon} <span data-i18n="${f.labelKey}">${t(f.labelKey, f.fallback)}</span>
    </button>
  `).join("");

  el.querySelectorAll("[data-filter-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.filterKey;
      if (CAL_FILTER_TYPES.has(key)) CAL_FILTER_TYPES.delete(key);
      else CAL_FILTER_TYPES.add(key);
      renderFilterChips();
      applyCalFilters();
    });
  });

  if (typeof applyTranslations === "function") applyTranslations(el);
}

// Repaints the already-loaded month without re-fetching from Supabase.
function applyCalFilters() {
  const grid = document.getElementById("calendarGrid");
  if (grid) paintCalendarGrid(grid, CAL_YEAR, CAL_MONTH, CAL_MONTH_MAP);
  updateFilterStatus();

  const clearBtn = document.getElementById("calClearFiltersBtn");
  if (clearBtn) clearBtn.style.display = (CAL_FILTER_TYPES.size || CAL_SEARCH_TERM) ? "inline-flex" : "none";
}

function updateFilterStatus() {
  const el = document.getElementById("calFilterStatus");
  if (!el) return;
  if (!CAL_FILTER_TYPES.size && !CAL_SEARCH_TERM) {
    el.textContent = "";
    return;
  }
  const days = Object.keys(CAL_MONTH_MAP);
  const matches = days.filter((d) => dayMatchesFilters(CAL_MONTH_MAP[d])).length;
  el.textContent = t("cal_filter_match_count", "{n} day(s) match this month").replace("{n}", matches);
}

function dayMatchesFilters(info) {
  if (!info) return CAL_FILTER_TYPES.size === 0 && !CAL_SEARCH_TERM;

  let filterOk = true;
  if (CAL_FILTER_TYPES.size) {
    filterOk = [...CAL_FILTER_TYPES].some((key) => {
      const v = info[key];
      return Array.isArray(v) ? v.length > 0 : !!v;
    });
  }

  let searchOk = true;
  if (CAL_SEARCH_TERM) {
    searchOk = dayTextBlob(info).includes(CAL_SEARCH_TERM);
  }

  return filterOk && searchOk;
}

function dayTextBlob(info) {
  const parts = [];
  (info.meals || []).forEach((m) => parts.push(m.name));
  (info.symptoms || []).forEach((s) => {
    parts.push((s.symptoms || []).join(" "));
    parts.push((s.possible_conditions || []).join(" "));
    parts.push(s.ai_summary || "");
  });
  (info.appointments || []).forEach((a) => {
    parts.push(a.doctor_name, a.specialty, a.hospital_name, a.reason);
  });
  if (info.mood?.note) parts.push(info.mood.note);
  if (info.exercise?.plan_type) parts.push(info.exercise.plan_type);
  if (info.bmi?.category) parts.push(info.bmi.category);
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/* ---------------------------------------------------------------------
   Monthly stats (Phase 4) — shared by the summary strip and js/reports.js.
   --------------------------------------------------------------------- */
function computeMonthStats(monthMap) {
  const days = Object.values(monthMap);
  const scored = days.filter((d) => d.score !== null);
  const avgScore = scored.length ? Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length) : null;
  const trackedDays = days.length;

  const withWater = days.filter((d) => d.water && d.water.recommended_water);
  const avgWaterPct = withWater.length
    ? Math.round(withWater.reduce((s, d) => s + (d.water.consumed_water / d.water.recommended_water) * 100, 0) / withWater.length)
    : null;

  const withSleep = days.filter((d) => d.sleep && typeof d.sleep.sleep_hours === "number");
  const avgSleepHrs = withSleep.length
    ? Number((withSleep.reduce((s, d) => s + d.sleep.sleep_hours, 0) / withSleep.length).toFixed(1))
    : null;

  const exerciseDays = days.filter((d) => d.exercise).length;

  const withMeals = days.filter((d) => d.meals && d.meals.length);
  const avgCalories = withMeals.length
    ? Math.round(withMeals.reduce((s, d) => s + d.meals.reduce((ms, m) => ms + (m.calories || 0), 0), 0) / withMeals.length)
    : null;

  return { avgScore, trackedDays, avgWaterPct, avgSleepHrs, exerciseDays, avgCalories };
}

function renderMonthlySummaryStrip(monthMap) {
  const el = document.getElementById("calSummaryStrip");
  if (!el) return;

  const { avgScore, trackedDays, avgWaterPct, avgSleepHrs, exerciseDays, avgCalories } = computeMonthStats(monthMap);
  const streak = CAL_CURRENT_STREAK ?? 0;

  el.innerHTML = `
    <div class="cal-stat-chip">
      <div class="cal-stat-value">${avgScore !== null ? avgScore : "—"}</div>
      <div class="cal-stat-label" data-i18n="cal_avg_score">Avg. Health Score</div>
    </div>
    <div class="cal-stat-chip">
      <div class="cal-stat-value">${avgWaterPct !== null ? avgWaterPct + "%" : "—"}</div>
      <div class="cal-stat-label" data-i18n="cal_avg_water">Avg. Water</div>
    </div>
    <div class="cal-stat-chip">
      <div class="cal-stat-value">${avgSleepHrs !== null ? avgSleepHrs + "h" : "—"}</div>
      <div class="cal-stat-label" data-i18n="cal_avg_sleep">Avg. Sleep</div>
    </div>
    <div class="cal-stat-chip">
      <div class="cal-stat-value">${exerciseDays}/${trackedDays || 0}</div>
      <div class="cal-stat-label" data-i18n="cal_exercise_days">Exercise Days</div>
    </div>
    <div class="cal-stat-chip">
      <div class="cal-stat-value">${avgCalories !== null ? avgCalories : "—"}</div>
      <div class="cal-stat-label" data-i18n="cal_avg_calories">Avg. Calories</div>
    </div>
    <div class="cal-stat-chip">
      <div class="cal-stat-value">${trackedDays}</div>
      <div class="cal-stat-label" data-i18n="cal_days_tracked">Days Tracked</div>
    </div>
    <div class="cal-stat-chip">
      <div class="cal-stat-value">${streak}</div>
      <div class="cal-stat-label" data-i18n="cal_current_streak">Current Streak</div>
    </div>
  `;
  if (typeof applyTranslations === "function") applyTranslations(el);
}

/* ---------------------------------------------------------------------
   Day detail modal
   --------------------------------------------------------------------- */
let CAL_OPEN_DATE = null;

async function openCalDayModal(dateStr) {
  CAL_OPEN_DATE = dateStr;
  const overlay = document.getElementById("calModalOverlay");
  const modal = document.getElementById("calDayModal");
  if (!overlay || !modal) return;

  overlay.classList.add("open");
  modal.classList.add("open");
  document.body.style.overflow = "hidden";

  document.getElementById("calModalDate").textContent = formatDate(dateStr);
  document.getElementById("calModalBody").innerHTML = `<div class="cal-loading">${t("cal_loading", "Loading your month…")}</div>`;

  // Data for this date is already in CAL_MONTH_MAP if it's in the currently
  // displayed month; otherwise (edge case: clicking a day that somehow
  // isn't) just re-derive from the map, which always covers the visible grid.
  const info = CAL_MONTH_MAP[dateStr] || {
    water: null, sleep: null, bmi: null, meals: [], exercise: null,
    symptoms: [], appointments: [], medicineReminders: [], mood: null,
    score: null, status: "no-data", components: {}
  };

  renderDayModalBody(dateStr, info);
}

function closeCalDayModal() {
  document.getElementById("calModalOverlay")?.classList.remove("open");
  document.getElementById("calDayModal")?.classList.remove("open");
  document.body.style.overflow = "";
  CAL_OPEN_DATE = null;
}

function renderDayModalBody(dateStr, info) {
  const body = document.getElementById("calModalBody");
  if (!body) return;

  const scoreBlock = info.score !== null
    ? `<div class="cal-score-ring" style="--ring-pct:${info.score}%;">
         <div class="cal-score-ring-value">${info.score}</div>
       </div>
       <div class="cal-score-status">${CAL_STATUS_DOT[info.status]} <span data-i18n="${CAL_STATUS_LABEL_KEY[info.status]}">${t(CAL_STATUS_LABEL_KEY[info.status], CAL_STATUS_LABEL_FALLBACK[info.status])}</span></div>`
    : `<div class="cal-score-ring cal-score-ring-empty"><div class="cal-score-ring-value">—</div></div>
       <div class="cal-score-status">⚪ <span data-i18n="cal_status_no_data">No Data</span></div>`;

  const sections = [];

  // Nutrition
  if (info.meals?.length) {
    const totals = info.meals.reduce((s, r) => ({
      calories: s.calories + (r.calories || 0), protein: s.protein + (r.protein || 0),
      carbs: s.carbs + (r.carbs || 0), fat: s.fat + (r.fat || 0)
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
    sections.push(calSection("🍽", "cal_section_nutrition", "Nutrition", `
      <div class="cal-kv-grid">
        <div><span data-i18n="cal_calories">Calories</span>: ${Math.round(totals.calories)} kcal</div>
        <div><span data-i18n="cal_protein">Protein</span>: ${Math.round(totals.protein)} g</div>
        <div><span data-i18n="cal_carbs">Carbohydrates</span>: ${Math.round(totals.carbs)} g</div>
        <div><span data-i18n="cal_fat">Fat</span>: ${Math.round(totals.fat)} g</div>
      </div>
      <div class="cal-meal-list">
        ${info.meals.map((m) => `<div class="cal-meal-row"><b>${mealLabel(m.meal)}</b> — ${escapeHtml(m.name)} (${Math.round(m.calories || 0)} kcal)</div>`).join("")}
      </div>
    `));
  }

  // Exercise
  if (info.exercise) {
    sections.push(calSection("🏃", "cal_section_exercise", "Exercise", `
      <div class="cal-kv-grid">
        <div><span data-i18n="cal_exercise_plan">Plan</span>: ${escapeHtml(info.exercise.plan_type || "—")}</div>
        <div><span data-i18n="cal_exercise_status">Status</span>: <span class="cal-pill cal-pill-good" data-i18n="cal_completed">Completed</span></div>
      </div>
    `));
  }

  // Sleep
  if (info.sleep) {
    sections.push(calSection("😴", "cal_section_sleep", "Sleep", `
      <div class="cal-kv-grid">
        <div><span data-i18n="cal_sleep_hours">Total Sleep</span>: ${info.sleep.sleep_hours} h</div>
        <div><span data-i18n="cal_sleep_stress">Stress Level</span>: ${info.sleep.stress_level ?? "—"}/10</div>
      </div>
    `));
  }

  // Water
  if (info.water) {
    const pct = info.water.recommended_water ? Math.round((info.water.consumed_water / info.water.recommended_water) * 100) : 0;
    sections.push(calSection("💧", "cal_section_water", "Water", `
      <div class="cal-kv-grid">
        <div><span data-i18n="cal_water_goal">Goal</span>: ${info.water.recommended_water} ml</div>
        <div><span data-i18n="cal_water_consumed">Consumed</span>: ${info.water.consumed_water} ml</div>
        <div><span data-i18n="cal_water_completion">Completion</span>: ${pct}%</div>
      </div>
    `));
  }

  // Medicine
  if (info.medicineReminders?.length) {
    const sent = info.medicineReminders.filter((r) => r.status === "sent").length;
    sections.push(calSection("💊", "cal_section_medicine", "Medicine", `
      <div class="cal-kv-grid">
        <div><span data-i18n="cal_medicine_reminders_sent">Reminders Sent</span>: ${sent} / ${info.medicineReminders.length}</div>
      </div>
      <div class="form-hint mt-8" data-i18n="cal_medicine_note">Shows reminders sent that day. Marking a dose as taken isn't tracked yet.</div>
    `));
  }

  // BMI
  if (info.bmi) {
    sections.push(calSection("⚖", "cal_section_bmi", "BMI", `
      <div class="cal-kv-grid">
        <div><span data-i18n="cal_bmi_value">BMI Value</span>: ${Number(info.bmi.bmi).toFixed(1)}</div>
        <div><span data-i18n="cal_bmi_category">Category</span>: ${escapeHtml(info.bmi.category || "")}</div>
      </div>
    `));
  }

  // Symptom Checker
  if (info.symptoms?.length) {
    sections.push(calSection("🩺", "cal_section_symptoms", "Symptom Checker", `
      ${info.symptoms.map((s) => `
        <div class="cal-meal-row">
          <b>${(s.symptoms || []).join(", ")}</b>
          ${s.risk_level ? ` — <span class="cal-pill">${riskLevelLabel(s.risk_level)}</span>` : ""}
          ${s.ai_summary ? `<div class="text-sm text-muted mt-4">${escapeHtml(s.ai_summary)}</div>` : ""}
        </div>
      `).join("")}
    `));
  }

  // Doctor Appointment
  if (info.appointments?.length) {
    sections.push(calSection("📅", "cal_section_appointment", "Doctor Appointment", `
      ${info.appointments.map((a) => `
        <div class="cal-meal-row">
          <b>${escapeHtml(a.doctor_name)}</b> (${escapeHtml(a.specialty)}) — ${formatTime12h(a.appointment_time)}
          <div class="text-sm text-muted">${escapeHtml(a.hospital_name)} · <span class="cal-pill">${escapeHtml(a.status)}</span></div>
        </div>
      `).join("")}
    `));
  }

  if (!sections.length) {
    sections.push(`<div class="cal-empty-state" data-i18n="cal_no_activity">No activity recorded for this day yet.</div>`);
  }

  const moodOptions = ["great", "good", "okay", "low", "bad"];
  const moodEmoji = { great: "😄", good: "🙂", okay: "😐", low: "😕", bad: "😣" };
  const currentMood = info.mood?.mood || "";
  const currentRating = info.mood?.daily_rating || "";
  const currentNote = info.mood?.note || "";

  body.innerHTML = `
    <div class="cal-modal-score">${scoreBlock}</div>
    ${sections.join("")}
    <div class="cal-section">
      <div class="cal-section-header">📝 <span data-i18n="cal_section_mood">How was your day?</span></div>
      <form id="calMoodForm">
        <input type="hidden" id="calMoodDate" value="${dateStr}" />
        <div class="cal-mood-picker">
          ${moodOptions.map((m) => `
            <label class="cal-mood-option">
              <input type="radio" name="calMood" value="${m}" ${currentMood === m ? "checked" : ""} />
              <span>${moodEmoji[m]}</span>
            </label>
          `).join("")}
        </div>
        <div class="form-group mt-16">
          <label class="form-label" for="calRating" data-i18n="cal_daily_rating">Daily Rating (1–5)</label>
          <input class="form-input" type="number" id="calRating" min="1" max="5" value="${currentRating}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="calNote" data-i18n="cal_note">Note</label>
          <textarea class="form-textarea" id="calNote" rows="3">${escapeHtml(currentNote)}</textarea>
        </div>
        <button type="submit" class="btn btn-primary btn-sm" data-i18n="cal_save_note">Save</button>
      </form>
    </div>
  `;

  document.getElementById("calMoodForm")?.addEventListener("submit", saveMoodNote);
  if (typeof applyTranslations === "function") applyTranslations(body);
}

function calSection(icon, key, fallback, innerHtml) {
  return `
    <div class="cal-section">
      <div class="cal-section-header">${icon} <span data-i18n="${key}">${fallback}</span></div>
      ${innerHtml}
    </div>
  `;
}

function mealLabel(meal) {
  const map = { breakfast: t("cal_meal_breakfast", "Breakfast"), lunch: t("cal_meal_lunch", "Lunch"), dinner: t("cal_meal_dinner", "Dinner"), snack: t("cal_meal_snack", "Snacks") };
  return map[meal] || meal;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function saveMoodNote(e) {
  e.preventDefault();
  const dateStr = document.getElementById("calMoodDate").value;
  const mood = document.querySelector('input[name="calMood"]:checked')?.value || null;
  const ratingRaw = document.getElementById("calRating").value;
  const daily_rating = ratingRaw ? parseInt(ratingRaw, 10) : null;
  const note = document.getElementById("calNote").value.trim() || null;

  const { error } = await supabaseClient.from("daily_health_logs").upsert({
    user_id: CAL_USER.id, log_date: dateStr, mood, daily_rating, note, updated_at: new Date().toISOString()
  }, { onConflict: "user_id,log_date" });

  if (error) {
    showToast(t("cal_save_error", "Could not save — please try again."), "error");
    return;
  }

  showToast(t("cal_save_success", "Saved!"), "success");

  // Keep the in-memory month map + calendar grid in sync without a full reload.
  if (!CAL_MONTH_MAP[dateStr]) {
    CAL_MONTH_MAP[dateStr] = {
      water: null, sleep: null, bmi: null, meals: [], exercise: null,
      symptoms: [], appointments: [], medicineReminders: [], mood: null,
      score: null, status: "no-data", components: {}
    };
  }
  CAL_MONTH_MAP[dateStr].mood = { log_date: dateStr, mood, daily_rating, note };

  const grid = document.getElementById("calendarGrid");
  if (grid) paintCalendarGrid(grid, CAL_YEAR, CAL_MONTH, CAL_MONTH_MAP);
}

/* =========================================================================
   Phase 5 — Trends & Analytics charts (Weekly / Monthly / Yearly)
   -------------------------------------------------------------------------
   Reuses the same day-map shape produced by loadDayMapForRange/loadMonthData.
   Weekly and Yearly re-fetch (7 days / full year); Monthly reuses the
   already-loaded CAL_MONTH_MAP so switching to Monthly never re-fetches.
   ========================================================================= */

const CAL_CHART_DEFS = [
  { key: "score", icon: "❤️", labelKey: "cal_chart_score", fallback: "Health Score", unit: "", max: 100, color: "var(--color-primary)" },
  { key: "water", icon: "💧", labelKey: "cal_chart_water", fallback: "Water", unit: "%", max: 100, color: "var(--color-secondary)" },
  { key: "sleep", icon: "😴", labelKey: "cal_chart_sleep", fallback: "Sleep", unit: "h", max: 12, color: "var(--color-mint)" },
  { key: "exercise", icon: "🏃", labelKey: "cal_chart_exercise", fallback: "Exercise", unit: "%", max: 100, color: "var(--color-amber)" },
  { key: "calories", icon: "🍽", labelKey: "cal_chart_calories", fallback: "Calories", unit: "kcal", max: null, color: "var(--color-coral)" },
];

async function renderAnalyticsSection() {
  const el = document.getElementById("calAnalyticsCharts");
  if (!el) return;
  el.innerHTML = `<div class="cal-loading">${t("cal_loading", "Loading your month…")}</div>`;

  let buckets = [];

  if (CAL_CHART_PERIOD === "weekly") {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 6);
    const startStr = fmtDateStr(start);
    const endStr = fmtDateStr(end);
    const map = await loadDayMapForRange(CAL_USER, startStr, endStr);
    buckets = buildDailyBuckets(map, startStr, endStr, "weekday");
  } else if (CAL_CHART_PERIOD === "monthly") {
    const { startStr, endStr } = monthRange(CAL_YEAR, CAL_MONTH);
    buckets = buildDailyBuckets(CAL_MONTH_MAP, startStr, endStr, "day");
  } else {
    const startStr = `${CAL_YEAR}-01-01`;
    const endStr = `${CAL_YEAR}-12-31`;
    const map = await loadDayMapForRange(CAL_USER, startStr, endStr);
    buckets = buildMonthlyBuckets(map, CAL_YEAR);
  }

  renderChartsFromBuckets(el, buckets);
}

function buildDailyBuckets(map, startStr, endStr, labelMode) {
  const buckets = [];
  const cursor = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);

  while (cursor <= end) {
    const dateStr = fmtDateStr(cursor);
    const info = map[dateStr] || null;
    const label = labelMode === "weekday"
      ? t(CAL_WEEKDAY_KEYS[cursor.getDay()], CAL_WEEKDAY_FALLBACK[cursor.getDay()]).slice(0, 3)
      : String(cursor.getDate());

    buckets.push({
      label,
      dateStr,
      score: info?.score ?? null,
      water: info?.water?.recommended_water ? Math.round((info.water.consumed_water / info.water.recommended_water) * 100) : null,
      sleep: (info?.sleep && typeof info.sleep.sleep_hours === "number") ? info.sleep.sleep_hours : null,
      exercise: info?.exercise ? 100 : (info ? 0 : null),
      calories: (info?.meals && info.meals.length) ? Math.round(info.meals.reduce((s, m) => s + (m.calories || 0), 0)) : null,
    });

    cursor.setDate(cursor.getDate() + 1);
  }

  return buckets;
}

function buildMonthlyBuckets(map, year) {
  const monthBuckets = Array.from({ length: 12 }, (_, i) => ({
    label: t(CAL_MONTH_KEYS[i], CAL_MONTH_FALLBACK[i]).slice(0, 3),
    days: [],
  }));

  Object.keys(map).forEach((dateStr) => {
    const [y, m] = dateStr.split("-").map(Number);
    if (y === year) monthBuckets[m - 1].days.push(map[dateStr]);
  });

  return monthBuckets.map((mb) => {
    const scored = mb.days.filter((d) => d.score !== null);
    const withWater = mb.days.filter((d) => d.water && d.water.recommended_water);
    const withSleep = mb.days.filter((d) => d.sleep && typeof d.sleep.sleep_hours === "number");
    const withMeals = mb.days.filter((d) => d.meals && d.meals.length);
    const exerciseDays = mb.days.filter((d) => d.exercise).length;

    return {
      label: mb.label,
      score: scored.length ? Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length) : null,
      water: withWater.length ? Math.round(withWater.reduce((s, d) => s + (d.water.consumed_water / d.water.recommended_water) * 100, 0) / withWater.length) : null,
      sleep: withSleep.length ? Number((withSleep.reduce((s, d) => s + d.sleep.sleep_hours, 0) / withSleep.length).toFixed(1)) : null,
      exercise: mb.days.length ? Math.round((exerciseDays / mb.days.length) * 100) : null,
      calories: withMeals.length ? Math.round(withMeals.reduce((s, d) => s + d.meals.reduce((ms, m) => ms + (m.calories || 0), 0), 0) / withMeals.length) : null,
    };
  });
}

function renderChartsFromBuckets(container, buckets) {
  container.innerHTML = CAL_CHART_DEFS.map((def) => renderMetricChartCard(def, buckets)).join("");
}

function renderMetricChartCard(def, buckets) {
  const values = buckets.map((b) => b[def.key]).filter((v) => v !== null && v !== undefined);

  if (!values.length) {
    return `
      <div class="cal-chart-card">
        <div class="cal-chart-header">
          <div class="cal-chart-title">${def.icon} <span data-i18n="${def.labelKey}">${t(def.labelKey, def.fallback)}</span></div>
        </div>
        <div class="cal-chart-empty" data-i18n="cal_chart_no_data">No data for this period yet.</div>
      </div>
    `;
  }

  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const avgLabel = def.key === "sleep" ? avg.toFixed(1) : Math.round(avg);
  const maxVal = def.max ?? Math.max(...values, 1);
  const today = todayDateStr();

  const bars = buckets.map((b) => {
    const v = b[def.key];
    const hasVal = v !== null && v !== undefined;
    const pct = hasVal ? Math.max(hasVal && v > 0 ? 4 : 0, Math.min(100, (v / maxVal) * 100)) : 0;
    const barStyle = hasVal
      ? `height:${pct}%; background:${def.color}; opacity:1;`
      : `height:2%; background:var(--color-border); opacity:0.5;`;
    const valueLabel = hasVal ? (def.key === "sleep" ? v.toFixed(1) : Math.round(v)) : "–";
    const isToday = b.dateStr === today;
    return `
      <div class="cal-chart-bar-col ${isToday ? "cal-chart-bar-today" : ""}" title="${b.label}: ${hasVal ? v + def.unit : t('cal_status_no_data', 'No Data')}">
        <div class="cal-chart-bar-value">${valueLabel}</div>
        <div class="cal-chart-bar-track">
          <div class="cal-chart-bar" style="${barStyle}"></div>
        </div>
        <div class="cal-chart-bar-label">${b.label}</div>
      </div>
    `;
  }).join("");

  const scrollHint = buckets.length > 8
    ? `<div class="cal-chart-scroll-hint">${t("cal_chart_scroll_hint", "⇔ scroll for more days")}</div>`
    : "";

  return `
    <div class="cal-chart-card">
      <div class="cal-chart-header">
        <div class="cal-chart-title">${def.icon} <span data-i18n="${def.labelKey}">${t(def.labelKey, def.fallback)}</span></div>
        <div class="cal-chart-avg">${t("cal_chart_avg_prefix", "Avg")} ${avgLabel}${def.unit}</div>
      </div>
      <div class="cal-chart-bars">${bars}</div>
      ${scrollHint}
    </div>
  `;
}
