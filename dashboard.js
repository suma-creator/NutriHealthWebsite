/* =========================================================================
   dashboard.js
   ========================================================================= */

document.addEventListener("DOMContentLoaded", async () => {
  const user = await requireAuth();
  if (!user) return;

  renderShell("dashboard.html");
  await loadUserChip(user);
  await loadDashboard(user);
  hidePageLoader();
});

async function loadDashboard(user) {
  await Promise.all([
    loadBmiStat(user),
    loadWaterStat(user),
    loadSleepStat(user),
    loadReminders(user),
    loadSymptomHistory(user),
    loadAiHealthStatus(user),
    loadTodaySummary(user),
    loadStreakWidget(user),
    loadCalendarPreview(user),
    loadMonthlyProgress(user)
  ]);
}

/* =========================================================================
   Phase 6 — Today's Summary widget
   ========================================================================= */
async function loadTodaySummary(user) {
  const listEl = qs("#todaySummaryList");
  const dateEl = qs("#todaySummaryDate");
  if (!listEl) return;

  const today = todayDateStr();
  if (dateEl) dateEl.textContent = formatDate(today);

  const [waterRes, sleepRes, foodRes, exerciseRes, symptomRes] = await Promise.all([
    supabaseClient.from("water_logs").select("consumed_water, recommended_water").eq("user_id", user.id).eq("log_date", today).limit(1),
    supabaseClient.from("sleep_logs").select("sleep_hours").eq("user_id", user.id).gte("created_at", `${today}T00:00:00`).lte("created_at", `${today}T23:59:59.999`).limit(1),
    supabaseClient.from("food_logs").select("calories").eq("user_id", user.id).eq("log_date", today),
    supabaseClient.from("exercise_logs").select("plan_type").eq("user_id", user.id).eq("log_date", today).limit(1),
    supabaseClient.from("symptom_logs").select("id").eq("user_id", user.id).gte("created_at", `${today}T00:00:00`).lte("created_at", `${today}T23:59:59.999`).limit(1),
  ]);

  const water = waterRes.data && waterRes.data[0];
  const sleep = sleepRes.data && sleepRes.data[0];
  const meals = foodRes.data || [];
  const exercised = exerciseRes.data && exerciseRes.data.length > 0;
  const symptomChecked = symptomRes.data && symptomRes.data.length > 0;

  const items = [
    {
      icon: "💧", labelKey: ["dashboard_today_water", "Water"], done: !!water,
      value: water ? `${(water.consumed_water / 1000).toFixed(1)}/${(water.recommended_water / 1000).toFixed(1)}${t("unit_l", "L")}` : t("dashboard_not_logged", "Not logged")
    },
    {
      icon: "😴", labelKey: ["dashboard_today_sleep", "Sleep"], done: !!sleep,
      value: sleep ? `${sleep.sleep_hours}${t("unit_hr", "h")}` : t("dashboard_not_logged", "Not logged")
    },
    {
      icon: "🍽", labelKey: ["dashboard_meals", "Meals"], done: meals.length > 0,
      value: meals.length ? `${meals.length} ${t("dashboard_logged_suffix", "logged")}` : t("dashboard_not_logged", "Not logged")
    },
    {
      icon: "🏃", labelKey: ["dashboard_today_exercise", "Exercise"], done: exercised,
      value: exercised ? t("dashboard_done", "Done") : t("dashboard_not_logged", "Not logged")
    },
    {
      icon: "🩺", labelKey: ["dashboard_symptom_check", "Symptom Check"], done: symptomChecked,
      value: symptomChecked ? t("dashboard_done", "Done") : t("dashboard_not_logged", "Not logged")
    },
  ];

  listEl.innerHTML = items.map((it) => `
    <div class="today-summary-item ${it.done ? "tsi-done" : ""}">
      <span class="tsi-icon">${it.icon}</span>
      <span class="tsi-label">${t(it.labelKey[0], it.labelKey[1])}</span>
      <span class="tsi-value">${it.value}</span>
    </div>
  `).join("");
}

/* =========================================================================
   Phase 6 — Current Streak widget (uses the shared getCurrentStreak()
   in ui.js so this always agrees with the Health Calendar and reports).
   ========================================================================= */
async function loadStreakWidget(user) {
  const el = qs("#statStreak");
  const flame = qs("#streakFlame");
  if (!el) return;

  const streak = await getCurrentStreak(user);
  el.textContent = streak;
  if (flame) flame.classList.toggle("streak-active", streak > 0);
}

/* =========================================================================
   Phase 6 — Health Score Calendar Preview (last 7 days, reusing the same
   loadDayMapForRange/scoreDay the Health Calendar uses — see ui.js).
   ========================================================================= */
const DASH_STATUS_DOT = { excellent: "🟢", good: "🟡", average: "🟠", "needs-improvement": "🔴", "no-data": "⚪" };
const DASH_WEEKDAY_FALLBACK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DASH_WEEKDAY_KEYS = ["cal_sun", "cal_mon", "cal_tue", "cal_wed", "cal_thu", "cal_fri", "cal_sat"];

async function loadCalendarPreview(user) {
  const el = qs("#calendarPreviewStrip");
  if (!el) return;

  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  const startStr = fmtDateStr(start);
  const endStr = fmtDateStr(end);
  const today = todayDateStr();

  const map = await loadDayMapForRange(user, startStr, endStr);

  const cells = [];
  const cursor = new Date(`${startStr}T00:00:00`);
  const endDate = new Date(`${endStr}T00:00:00`);
  while (cursor <= endDate) {
    const dateStr = fmtDateStr(cursor);
    const info = map[dateStr];
    const status = info ? info.status : "no-data";
    cells.push(`
      <a href="health-calendar.html" class="cal-preview-day ${dateStr === today ? "cal-preview-today" : ""}" title="${dateStr}${info && info.score !== null ? " · " + info.score : ""}">
        <span class="cpd-dow">${t(DASH_WEEKDAY_KEYS[cursor.getDay()], DASH_WEEKDAY_FALLBACK[cursor.getDay()]).slice(0, 3)}</span>
        <span class="cpd-dot">${DASH_STATUS_DOT[status]}</span>
        <span class="cpd-num">${cursor.getDate()}</span>
      </a>
    `);
    cursor.setDate(cursor.getDate() + 1);
  }

  el.innerHTML = cells.join("");
}

/* =========================================================================
   Phase 6 — Monthly Progress widget (current month so far).
   ========================================================================= */
async function loadMonthlyProgress(user) {
  const listEl = qs("#monthlyProgressList");
  const labelEl = qs("#monthlyProgressLabel");
  if (!listEl) return;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const { startStr } = monthRange(year, month);
  const endStr = todayDateStr();
  const daysElapsed = now.getDate();

  if (labelEl) {
    if (typeof getCurrentLang === "function" && getCurrentLang() === "bn" && typeof t === "function") {
      const monthName = t(`cal_month_${now.getMonth() + 1}`, "");
      const formatted = `${monthName} ${now.getFullYear()}`;
      labelEl.textContent = typeof localizeTimeString === "function" ? localizeTimeString(formatted) : formatted;
    } else {
      labelEl.textContent = now.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }
  }

  const map = await loadDayMapForRange(user, startStr, endStr);
  const days = Object.values(map);
  const trackedDays = days.length;
  const scored = days.filter((d) => d.score !== null);
  const avgScore = scored.length ? Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length) : null;
  const exerciseDays = days.filter((d) => d.exercise).length;

  const rows = [
    {
      labelKey: ["dashboard_days_logged", "Days Logged"],
      value: `${trackedDays}/${daysElapsed}`,
      pct: daysElapsed ? Math.round((trackedDays / daysElapsed) * 100) : 0,
    },
    {
      labelKey: ["dashboard_avg_health_score", "Avg. Health Score"],
      value: avgScore !== null ? `${avgScore}/100` : "—",
      pct: avgScore ?? 0,
    },
    {
      labelKey: ["dashboard_exercise_days", "Exercise Days"],
      value: `${exerciseDays}/${daysElapsed}`,
      pct: daysElapsed ? Math.round((exerciseDays / daysElapsed) * 100) : 0,
    },
  ];

  listEl.innerHTML = rows.map((r) => `
    <div class="monthly-progress-row">
      <div class="mpr-top">
        <span>${t(r.labelKey[0], r.labelKey[1])}</span>
        <span style="font-weight:700;">${r.value}</span>
      </div>
      <div class="mpr-bar-track"><div class="mpr-bar-fill" style="width:${Math.max(0, Math.min(100, r.pct))}%;"></div></div>
    </div>
  `).join("");
}

async function loadBmiStat(user) {
  const { data } = await supabaseClient
    .from("bmi_logs")
    .select("bmi, category")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (data && data.length) {
    qs("#statBmi").textContent = data[0].bmi;
    qs("#statBmiCategory").textContent = data[0].category;
  }
}

async function loadWaterStat(user) {
  const { data } = await supabaseClient
    .from("water_logs")
    .select("consumed_water, recommended_water")
    .eq("user_id", user.id)
    .eq("log_date", todayDateStr())
    .limit(1);

  if (data && data.length) {
    const { consumed_water, recommended_water } = data[0];
    qs("#statWater").textContent = `${(consumed_water / 1000).toFixed(1)}${t("unit_l", "L")}`;
    qs("#statWater").nextElementSibling.textContent = `${t("dashboard_of_prefix", "of")} ${(recommended_water / 1000).toFixed(1)}${t("unit_l", "L")} ${t("dashboard_today_suffix", "today")}`;
  } else {
    qs("#statWater").textContent = `0${t("unit_l", "L")}`;
  }
}

async function loadSleepStat(user) {
  const { data } = await supabaseClient
    .from("sleep_logs")
    .select("sleep_hours")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (data && data.length) {
    qs("#statSleep").textContent = `${data[0].sleep_hours}${t("unit_hr", "h")}`;
  }
}

async function loadReminders(user) {
  const { data } = await supabaseClient
    .from("medicine_reminders")
    .select("medicine_name, dosage, time, frequency")
    .eq("user_id", user.id)
    .order("time", { ascending: true });

  const container = qs("#reminderList");
  qs("#statReminders").textContent = data ? data.length : 0;

  if (!data || !data.length) {
    container.innerHTML = `<p class="text-sm text-muted">${t("dashboard_no_reminders", "No reminders yet.")} <a href="medicine.html" class="gradient-text" style="font-weight:600;">${t("dashboard_add_one_link", "Add one →")}</a></p>`;
    return;
  }

  container.innerHTML = data.slice(0, 4).map((r) => `
    <div class="flex-between" style="padding:10px 0;border-bottom:1px solid var(--color-border);">
      <div>
        <div style="font-weight:600;font-size:0.9rem;">${r.medicine_name}</div>
        <div class="text-sm text-muted">${r.dosage || ""} · ${r.frequency}</div>
      </div>
      <span class="mono text-sm" style="font-weight:600;color:var(--color-primary);">${formatTime12h(r.time)}</span>
    </div>
  `).join("");
}

async function loadSymptomHistory(user) {
  const { data } = await supabaseClient
    .from("symptom_logs")
    .select("symptoms, possible_conditions, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(3);

  const container = qs("#symptomHistory");

  if (!data || !data.length) {
    container.innerHTML = `<p class="text-sm text-muted">${t("dashboard_no_symptom_checks", "No symptom checks yet.")} <a href="symptoms.html" class="gradient-text" style="font-weight:600;">${t("dashboard_run_check_link", "Run a check →")}</a></p>`;
    return;
  }

  container.innerHTML = data.map((s) => `
    <div style="padding:10px 0;border-bottom:1px solid var(--color-border);">
      <div class="flex-between">
        <span style="font-weight:600;font-size:0.9rem;">${s.symptoms.join(", ")}</span>
        <span class="text-sm text-muted">${formatDate(s.created_at)}</span>
      </div>
      <div class="text-sm text-muted mt-8">${(s.possible_conditions || []).join(", ") || "No specific conditions flagged"}</div>
    </div>
  `).join("");
}

/* =========================================================================
   AI Health Status — Health Score, Latest Disease, Risk Level,
   Latest Report, and Severity Trend chart.
   ========================================================================= */

function riskBadgeColor(riskLevel) {
  return { Low: "icon-mint", Moderate: "icon-amber", High: "icon-coral", Urgent: "icon-coral" }[riskLevel] || "icon-blue";
}

async function loadAiHealthStatus(user) {
  const [bmiRes, waterRes, sleepRes, symptomsRes, reportRes] = await Promise.all([
    supabaseClient.from("bmi_logs").select("bmi").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1),
    supabaseClient.from("water_logs").select("consumed_water, recommended_water").eq("user_id", user.id).eq("log_date", todayDateStr()).limit(1),
    supabaseClient.from("sleep_logs").select("sleep_hours").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1),
    supabaseClient.from("symptom_logs").select("severity_score, risk_level, possible_conditions, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(8),
    supabaseClient.from("reports").select("report_type, delivery_method, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1)
  ]);

  const symptomLogs = (symptomsRes.data || []).slice().reverse(); // oldest → newest for the trend chart
  const latestSymptom = symptomsRes.data && symptomsRes.data[0];
  const latestReport = reportRes.data && reportRes.data[0];

  renderHealthScore({
    bmi: bmiRes.data && bmiRes.data[0],
    water: waterRes.data && waterRes.data[0],
    sleep: sleepRes.data && sleepRes.data[0],
    symptom: latestSymptom
  });
  renderLatestDisease(latestSymptom);
  renderRiskLevel(latestSymptom);
  renderLatestReport(latestReport);
  renderSeverityTrend(symptomLogs);
}

function renderHealthScore({ bmi, water, sleep, symptom }) {
  const scores = [];

  if (bmi) {
    const category = getBmiCategory(bmi.bmi).category;
    scores.push({ Underweight: 70, "Normal weight": 100, Overweight: 65, Obese: 40 }[category] ?? 75);
  }
  if (water && water.recommended_water) {
    scores.push(Math.min(100, Math.round((water.consumed_water / water.recommended_water) * 100)));
  }
  if (sleep && typeof sleep.sleep_hours === "number") {
    scores.push(Math.max(0, Math.min(100, 100 - Math.abs(sleep.sleep_hours - 8) * 12)));
  }
  if (symptom && typeof symptom.severity_score === "number") {
    let symptomScore = 100 - symptom.severity_score;
    if (symptom.risk_level === "Urgent") symptomScore = Math.min(symptomScore, 30);
    scores.push(Math.max(0, symptomScore));
  }

  const el = qs("#statHealthScore");
  if (!scores.length) {
    el.textContent = "—";
    return;
  }
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  el.textContent = `${avg}/100`;
  el.style.color = avg >= 70 ? "var(--color-mint)" : avg >= 45 ? "var(--color-amber)" : "var(--color-coral)";
}

function renderLatestDisease(symptom) {
  const el = qs("#statLatestDisease");
  if (!symptom || !symptom.possible_conditions || !symptom.possible_conditions.length) {
    el.textContent = t("dashboard_no_checks_yet", "No checks yet");
    return;
  }
  el.textContent = symptom.possible_conditions[0];
}

function renderRiskLevel(symptom) {
  const el = qs("#statRiskLevel");
  if (!symptom || !symptom.risk_level) {
    el.textContent = "—";
    el.className = "stat-value";
    el.style.cssText = "font-size:1.1rem;";
    return;
  }
  el.textContent = symptom.risk_level;
  el.className = `stat-value ${riskBadgeColor(symptom.risk_level)}`;
  el.style.cssText = "font-size:0.9rem;display:inline-block;padding:5px 14px;border-radius:20px;font-weight:700;";
}

function renderLatestReport(report) {
  const el = qs("#statLatestReport");
  if (!report) {
    el.textContent = t("dashboard_no_reports_yet", "No reports yet");
    return;
  }
  const label = { symptom_check: t("dashboard_report_symptom", "Symptom report"), nutrition: t("dashboard_report_nutrition", "Nutrition report") }[report.report_type] || t("dashboard_report_generic", "Report");
  el.textContent = `${label} · ${formatDate(report.created_at)}`;
}

function renderSeverityTrend(symptomLogs) {
  const box = qs("#severityTrendBox");
  const chart = qs("#severityTrendChart");
  const withSeverity = symptomLogs.filter((s) => typeof s.severity_score === "number");

  if (withSeverity.length < 2) {
    box.style.display = "none";
    return;
  }

  box.style.display = "block";
  chart.innerHTML = `
    <div style="display:flex;align-items:flex-end;gap:10px;height:110px;padding-top:8px;">
      ${withSeverity.map((s) => {
        const heightPct = Math.max(6, s.severity_score);
        const barColor = s.severity_score >= 70 ? "var(--color-coral)" : s.severity_score >= 40 ? "var(--color-amber)" : "var(--color-mint)";
        return `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">
            <span class="text-sm mono" style="font-weight:600;">${s.severity_score}</span>
            <div style="width:100%;max-width:28px;height:${heightPct}px;border-radius:6px 6px 2px 2px;background:${barColor};"></div>
            <span class="text-sm text-muted" style="font-size:0.7rem;white-space:nowrap;">${formatDate(s.created_at).replace(/, \d{4}$/, "")}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}
