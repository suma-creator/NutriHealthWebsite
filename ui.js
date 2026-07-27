/* =========================================================================
   ui.js — shared UI helpers used on every page
   - Toast notifications
   - Page loader
   - Dark mode toggle (saved in localStorage)
   - Mobile sidebar / nav toggle
   - Small DOM helpers
   ========================================================================= */

/* ---------- Toast notifications ---------- */
// Call showToast(t("toast_water_logged", "Water logged!"), "success") from any page.
function showToast(message, type = "success", duration = 3500) {
  let container = document.querySelector(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const icons = { success: "✅", error: "⚠️", warning: "⏰", info: "ℹ️" };

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span>${message}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/* ---------- Page loader ---------- */
// Add <div class="page-loader" id="pageLoader"><div class="loader-pulse"></div></div>
// as the first element inside <body> on any page that fetches data on load.
function hidePageLoader() {
  const loader = document.getElementById("pageLoader");
  if (loader) loader.classList.add("hidden");
}
window.addEventListener("load", () => setTimeout(hidePageLoader, 250));

/* ---------- Dark mode ---------- */
function initTheme() {
  const saved = localStorage.getItem("nh_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeIcon(saved);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("nh_theme", next);
  updateThemeIcon(next);
}
function updateThemeIcon(theme) {
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.textContent = theme === "dark" ? "☀️" : "🌙";
  });
}
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.addEventListener("click", toggleTheme);
  });
});

/* ---------- Mobile sidebar toggle (dashboard pages) ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.querySelector(".sidebar-overlay");
  const toggleBtns = document.querySelectorAll(".nav-toggle");

  const openSidebar = () => { sidebar?.classList.add("open"); overlay?.classList.add("open"); };
  const closeSidebar = () => { sidebar?.classList.remove("open"); overlay?.classList.remove("open"); };

  toggleBtns.forEach((btn) => btn.addEventListener("click", openSidebar));
  overlay?.addEventListener("click", closeSidebar);
});

/* ---------- Mobile public-nav toggle ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const navToggle = document.querySelector(".navbar .nav-toggle");
  const navLinks = document.querySelector(".navbar .nav-links");
  navToggle?.addEventListener("click", () => navLinks?.classList.toggle("mobile-open"));
});

/* ---------- Small DOM helper ---------- */
function qs(selector, scope = document) { return scope.querySelector(selector); }
function qsa(selector, scope = document) { return Array.from(scope.querySelectorAll(selector)); }

/* ---------- Initials for avatar chips ---------- */
function getInitials(name) {
  if (!name) return "U";
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

/* ---------- Shared health helpers (used across bmi/dashboard/nutrition/diet pages) ---------- */
function getBmiCategory(bmi) {
  if (bmi < 18.5) return { category: t("bmi_cat_underweight", "Underweight"), color: "icon-amber", tip: t("bmi_tip_underweight", "Consider adding nutrient-dense meals and speak with a doctor if weight loss was unintentional.") };
  if (bmi < 25) return { category: t("bmi_cat_normal", "Normal weight"), color: "icon-mint", tip: t("bmi_tip_normal", "Great range — keep up a balanced diet and regular activity.") };
  if (bmi < 30) return { category: t("bmi_cat_overweight", "Overweight"), color: "icon-amber", tip: t("bmi_tip_overweight", "Small, consistent changes to diet and activity can help move toward a healthier range.") };
  return { category: t("bmi_cat_obese", "Obese"), color: "icon-coral", tip: t("bmi_tip_obese", "Consider consulting a healthcare provider to build a safe, personalized plan.") };
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (typeof getCurrentLang === "function" && getCurrentLang() === "bn" && typeof t === "function") {
    const monthName = t(`cal_month_${d.getMonth() + 1}`, "");
    const formatted = `${d.getDate()} ${monthName}, ${d.getFullYear()}`;
    return typeof localizeTimeString === "function" ? localizeTimeString(formatted) : formatted;
  }
  const formatted = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return typeof localizeTimeString === "function" ? localizeTimeString(formatted) : formatted;
}

function formatTime12h(timeStr) {
  if (!timeStr) return "";
  const [h, m] = timeStr.split(":");
  const hour = parseInt(h, 10);
  const period = hour >= 12 ? t("time_pm", "PM") : t("time_am", "AM");
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const out = `${h12}:${m} ${period}`;
  return typeof getCurrentLang === "function" && getCurrentLang() === "bn" && typeof toBanglaDigits === "function"
    ? toBanglaDigits(out)
    : out;
}

function todayDateStr() {
  return new Date().toISOString().split("T")[0];
}

function fmtDateStr(d) { return d.toISOString().split("T")[0]; }

/* =========================================================================
   Shared "current streak" helper (dashboard widgets + Health Calendar
   summary strip + Phase 6 exports all need the same number here).
   -------------------------------------------------------------------------
   Deliberately NOT derived from whichever single month happens to be
   loaded in memory — a streak that started in June and is still going in
   July has to see both months, and a user Browse-ing March in the Health
   Calendar should still see today's real streak, not "0 because today
   isn't in March". So this runs its own lightweight query (just the
   date/log_date columns — no need for the full day-map join) over a
   generous trailing window, then walks back from today.
   ========================================================================= */
const STREAK_LOOKBACK_DAYS = 400; // comfortably covers any realistic streak

async function loadActivityDateSet(user, startStr, endStr) {
  const startTs = `${startStr}T00:00:00`;
  const endTs = `${endStr}T23:59:59.999`;

  const [waterRes, sleepRes, bmiRes, foodRes, exerciseRes, symptomRes, dailyRes] = await Promise.all([
    supabaseClient.from("water_logs").select("log_date").eq("user_id", user.id).gte("log_date", startStr).lte("log_date", endStr),
    supabaseClient.from("sleep_logs").select("created_at").eq("user_id", user.id).gte("created_at", startTs).lte("created_at", endTs),
    supabaseClient.from("bmi_logs").select("created_at").eq("user_id", user.id).gte("created_at", startTs).lte("created_at", endTs),
    supabaseClient.from("food_logs").select("log_date").eq("user_id", user.id).gte("log_date", startStr).lte("log_date", endStr),
    supabaseClient.from("exercise_logs").select("log_date").eq("user_id", user.id).gte("log_date", startStr).lte("log_date", endStr),
    supabaseClient.from("symptom_logs").select("created_at").eq("user_id", user.id).gte("created_at", startTs).lte("created_at", endTs),
    supabaseClient.from("daily_health_logs").select("log_date").eq("user_id", user.id).gte("log_date", startStr).lte("log_date", endStr),
  ]);

  const dateKey = (isoTs) => (isoTs || "").split("T")[0];
  const set = new Set();
  (waterRes.data || []).forEach((r) => set.add(r.log_date));
  (foodRes.data || []).forEach((r) => set.add(r.log_date));
  (exerciseRes.data || []).forEach((r) => set.add(r.log_date));
  (dailyRes.data || []).forEach((r) => set.add(r.log_date));
  (sleepRes.data || []).forEach((r) => set.add(dateKey(r.created_at)));
  (bmiRes.data || []).forEach((r) => set.add(dateKey(r.created_at)));
  (symptomRes.data || []).forEach((r) => set.add(dateKey(r.created_at)));

  return set;
}

/* =========================================================================
   Shared day-map builder + per-day scorer.
   -------------------------------------------------------------------------
   Originally lived only in js/health-calendar.js; moved here so
   js/dashboard.js's "Health Score Calendar Preview" widget scores days
   exactly the same way the full Health Calendar does, instead of a second,
   drifting copy of the same weights.

   Weights: Nutrition 30 / Exercise 25 / Sleep 20 / Hydration 15 / BMI 10.
   Scores THAT DAY's data only (unlike health-score.js, which scores
   "today" using the latest-known BMI/sleep even if logged days ago).
   ========================================================================= */
const CAL_SCORE_WEIGHTS = { nutrition: 30, exercise: 25, sleep: 20, hydration: 15, bmi: 10 };

function monthRange(year, month) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);
  const fmt = (d) => d.toISOString().split("T")[0];
  return { startStr: fmt(start), endStr: fmt(end), daysInMonth: end.getDate() };
}

async function loadDayMapForRange(user, startStr, endStr) {
  const startTs = `${startStr}T00:00:00`;
  const endTs = `${endStr}T23:59:59.999`;

  const [
    waterRes, sleepRes, bmiRes, foodRes, exerciseRes,
    symptomRes, apptRes, medRes, dailyRes, planRes
  ] = await Promise.all([
    supabaseClient.from("water_logs").select("log_date, consumed_water, recommended_water")
      .eq("user_id", user.id).gte("log_date", startStr).lte("log_date", endStr),
    supabaseClient.from("sleep_logs").select("created_at, sleep_hours, stress_level")
      .eq("user_id", user.id).gte("created_at", startTs).lte("created_at", endTs),
    supabaseClient.from("bmi_logs").select("created_at, bmi, category, height, weight")
      .eq("user_id", user.id).gte("created_at", startTs).lte("created_at", endTs),
    supabaseClient.from("food_logs").select("log_date, meal, name, calories, protein, carbs, fat")
      .eq("user_id", user.id).gte("log_date", startStr).lte("log_date", endStr),
    supabaseClient.from("exercise_logs").select("log_date, plan_type")
      .eq("user_id", user.id).gte("log_date", startStr).lte("log_date", endStr),
    supabaseClient.from("symptom_logs").select("created_at, symptoms, possible_conditions, recommendations, risk_level, ai_summary")
      .eq("user_id", user.id).gte("created_at", startTs).lte("created_at", endTs),
    supabaseClient.from("doctor_appointments").select("appointment_date, appointment_time, doctor_name, specialty, hospital_name, status, reason")
      .eq("user_id", user.id).gte("appointment_date", startStr).lte("appointment_date", endStr),
    supabaseClient.from("reminder_history").select("scheduled_date, status")
      .eq("user_id", user.id).eq("source", "medicine").gte("scheduled_date", startStr).lte("scheduled_date", endStr),
    supabaseClient.from("daily_health_logs").select("log_date, mood, daily_rating, note")
      .eq("user_id", user.id).gte("log_date", startStr).lte("log_date", endStr),
    supabaseClient.from("nutrition_plans").select("calories, protein_g, carbs_g, fat_g")
      .eq("user_id", user.id).order("created_at", { ascending: false }).limit(1)
  ]);

  const plan = planRes.data?.[0] || null;
  const dateKey = (isoTs) => (isoTs || "").split("T")[0];
  const map = {};
  const day = (d) => (map[d] = map[d] || {
    water: null, sleep: null, bmi: null, meals: [], exercise: null,
    symptoms: [], appointments: [], medicineReminders: [], mood: null
  });

  (waterRes.data || []).forEach((r) => { day(r.log_date).water = r; });
  (sleepRes.data || []).forEach((r) => { day(dateKey(r.created_at)).sleep = r; });
  (bmiRes.data || []).forEach((r) => { day(dateKey(r.created_at)).bmi = r; });
  (foodRes.data || []).forEach((r) => { day(r.log_date).meals.push(r); });
  (exerciseRes.data || []).forEach((r) => { day(r.log_date).exercise = r; });
  (symptomRes.data || []).forEach((r) => { day(dateKey(r.created_at)).symptoms.push(r); });
  (apptRes.data || []).forEach((r) => { day(r.appointment_date).appointments.push(r); });
  (medRes.data || []).forEach((r) => { day(r.scheduled_date).medicineReminders.push(r); });
  (dailyRes.data || []).forEach((r) => { day(r.log_date).mood = r; });

  Object.keys(map).forEach((d) => {
    const scored = scoreDay(map[d], plan);
    map[d].score = scored.score;
    map[d].status = scored.status;
    map[d].components = scored.components;
  });

  return map;
}

function scoreDay(dayData, plan) {
  const components = {};

  if (dayData.water && dayData.water.recommended_water) {
    components.hydration = Math.max(0, Math.min(100,
      Math.round((dayData.water.consumed_water / dayData.water.recommended_water) * 100)));
  }
  if (dayData.sleep && typeof dayData.sleep.sleep_hours === "number") {
    components.sleep = Math.max(0, Math.min(100, Math.round(100 - Math.abs(dayData.sleep.sleep_hours - 8) * 12)));
  }
  if (dayData.exercise) {
    components.exercise = 100;
  }
  if (dayData.bmi) {
    const category = dayData.bmi.category || getBmiCategory(dayData.bmi.bmi).category;
    components.bmi = { Underweight: 70, "Normal weight": 100, Overweight: 65, Obese: 40 }[category] ?? 75;
  }
  if (dayData.meals && dayData.meals.length) {
    const totals = dayData.meals.reduce((sum, r) => ({
      calories: sum.calories + (r.calories || 0),
      protein: sum.protein + (r.protein || 0),
      carbs: sum.carbs + (r.carbs || 0),
      fat: sum.fat + (r.fat || 0),
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    if (!plan) {
      components.nutrition = 70;
    } else {
      const closeness = (actual, target) => {
        if (!target) return 100;
        return Math.max(0, 100 - (Math.abs(actual - target) / target) * 100);
      };
      const scores = [
        closeness(totals.calories, plan.calories),
        closeness(totals.protein, plan.protein_g),
        closeness(totals.carbs, plan.carbs_g),
        closeness(totals.fat, plan.fat_g),
      ];
      components.nutrition = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    }
  }

  const available = Object.keys(components);
  if (!available.length) return { score: null, status: "no-data", components };

  const totalWeight = available.reduce((sum, k) => sum + CAL_SCORE_WEIGHTS[k], 0);
  const weighted = available.reduce((sum, k) => sum + components[k] * (CAL_SCORE_WEIGHTS[k] / totalWeight), 0);
  const score = Math.round(weighted);

  let status = "needs-improvement";
  if (score >= 90) status = "excellent";
  else if (score >= 75) status = "good";
  else if (score >= 60) status = "average";

  return { score, status, components };
}

async function getCurrentStreak(user) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - STREAK_LOOKBACK_DAYS);

  const daySet = await loadActivityDateSet(user, fmtDateStr(start), fmtDateStr(end));

  let streak = 0;
  const cursor = new Date();
  while (daySet.has(fmtDateStr(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/* =========================================================================
   Shared Spoonacular caller (food tracker, recipes, diet plan, scanner).
   Distinguishes a real API/network error from a genuine "no match found"
   instead of collapsing both into one misleading message.
   ========================================================================= */
async function callSpoonacular(action, params) {
  try {
    const { data, error } = await supabaseClient.functions.invoke("spoonacular", {
      body: { action, params }
    });

    if (error) {
      // supabase-js sets `data` to null on a non-2xx response; the real
      // message the edge function sent is on error.context (a Response).
      let message = error.message || "Couldn't reach the food service.";
      try {
        if (error.context && typeof error.context.json === "function") {
          const body = await error.context.json();
          if (body?.error) message = body.error;
        }
      } catch (_) { /* ignore — fall back to error.message */ }
      console.error("Spoonacular error:", message);
      return { ok: false, message };
    }

    if (data?.ok === false) {
      console.error("Spoonacular error:", data.error);
      return { ok: false, message: data.error || "Something went wrong." };
    }

    return { ok: true, data };
  } catch (err) {
    console.error("Spoonacular call failed:", err);
    return { ok: false, message: "Couldn't reach the food service. Please try again." };
  }
}

/* =========================================================================
   AI food photo identification (Food Scanner's photo tab). Sends a
   compressed base64 photo to the "food-vision" edge function and gets
   back an identified food name + estimated calories/macros.
   ========================================================================= */
async function callFoodVision(imageDataUrl) {
  try {
    const { data, error } = await supabaseClient.functions.invoke("food-vision", {
      body: { image: imageDataUrl }
    });

    if (error) {
      let message = error.message || "Couldn't reach the AI photo service.";
      try {
        if (error.context && typeof error.context.json === "function") {
          const body = await error.context.json();
          if (body?.error) message = body.error;
        }
      } catch (_) { /* ignore — fall back to error.message */ }
      console.error("Food vision error:", message);
      return { ok: false, message };
    }

    if (data?.ok === false) {
      console.error("Food vision error:", data.error);
      return { ok: false, message: data.error || "Couldn't analyze that photo." };
    }

    return { ok: true, result: data.result };
  } catch (err) {
    console.error("Food vision call failed:", err);
    return { ok: false, message: "Couldn't reach the AI photo service. Please try again." };
  }
}
