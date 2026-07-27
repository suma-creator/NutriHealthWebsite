/* =========================================================================
   health-score.js
   Combines BMI, Water, Sleep, Nutrition, and Exercise into one weighted
   Health Score. Weights: Nutrition 30% / Exercise 25% / Sleep 20% /
   Water 15% / BMI 10%. Any component with no data yet is excluded and the
   remaining weights are renormalized proportionally, rather than treating
   "no data" as "zero" — a brand-new account shouldn't start at a crushed
   score just because it hasn't logged anything yet.
   ========================================================================= */

const HEALTH_SCORE_WEIGHTS = { nutrition: 30, exercise: 25, sleep: 20, hydration: 15, bmi: 10 };

document.addEventListener("DOMContentLoaded", async () => {
  const user = await requireAuth();
  if (!user) return;

  renderShell("health-score.html");
  await loadUserChip(user);
  await loadHealthScore(user);
  hidePageLoader();
});

async function loadHealthScore(user) {
  const today = todayDateStr();
  const sevenDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString().split("T")[0]; // today + 6 days back = 7-day window

  const [bmiRes, waterRes, sleepRes, foodRes, planRes, exerciseRes] = await Promise.all([
    supabaseClient.from("bmi_logs").select("bmi").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1),
    supabaseClient.from("water_logs").select("consumed_water, recommended_water").eq("user_id", user.id).eq("log_date", today).limit(1),
    supabaseClient.from("sleep_logs").select("sleep_hours").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1),
    supabaseClient.from("food_logs").select("calories, protein, carbs, fat").eq("user_id", user.id).eq("log_date", today),
    supabaseClient.from("nutrition_plans").select("calories, protein_g, carbs_g, fat_g").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1),
    supabaseClient.from("exercise_logs").select("log_date").eq("user_id", user.id).gte("log_date", sevenDaysAgo).lte("log_date", today)
  ]);

  const components = {
    bmi: scoreBmi(bmiRes.data?.[0]),
    hydration: scoreHydration(waterRes.data?.[0]),
    sleep: scoreSleep(sleepRes.data?.[0]),
    nutrition: scoreNutrition(foodRes.data, planRes.data?.[0]),
    exercise: scoreExercise(exerciseRes.data)
  };

  renderComponents(components);
  renderOverall(components);
}

/* ---------------- Individual component scorers ---------------- */
/* Each returns { value: 0-100, note: string } or null when there's no data. */

function scoreBmi(bmiRow) {
  if (!bmiRow) return null;
  const category = getBmiCategory(bmiRow.bmi).category;
  const value = { Underweight: 70, "Normal weight": 100, Overweight: 65, Obese: 40 }[category] ?? 75;
  return { value, note: `Latest BMI ${bmiRow.bmi.toFixed(1)} — ${category}` };
}

function scoreHydration(waterRow) {
  if (!waterRow || !waterRow.recommended_water) return null;
  const value = Math.max(0, Math.min(100, Math.round((waterRow.consumed_water / waterRow.recommended_water) * 100)));
  return { value, note: `${waterRow.consumed_water} / ${waterRow.recommended_water} ml today` };
}

function scoreSleep(sleepRow) {
  if (!sleepRow || typeof sleepRow.sleep_hours !== "number") return null;
  const value = Math.max(0, Math.min(100, Math.round(100 - Math.abs(sleepRow.sleep_hours - 8) * 12)));
  return { value, note: `Latest log: ${sleepRow.sleep_hours}h (ideal is 7–9h)` };
}

function scoreExercise(rows) {
  if (!rows) return null;
  const distinctDays = new Set(rows.map((r) => r.log_date)).size;
  const value = Math.round((distinctDays / 7) * 100);
  return { value, note: `${distinctDays} of the last 7 days logged` };
}

function scoreNutrition(foodRows, plan) {
  if (!foodRows || !foodRows.length) return null;

  const totals = foodRows.reduce((sum, r) => ({
    calories: sum.calories + (r.calories || 0),
    protein: sum.protein + (r.protein || 0),
    carbs: sum.carbs + (r.carbs || 0),
    fat: sum.fat + (r.fat || 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  if (!plan) {
    // No target to compare against — still show something logged, but
    // note that a nutrition plan would make this score meaningful.
    return { value: 70, note: `${Math.round(totals.calories)} kcal logged today — set up a Nutrition Plan for an accurate score` };
  }

  const closeness = (actual, target) => {
    if (!target) return 100;
    const diffPct = Math.abs(actual - target) / target * 100;
    return Math.max(0, 100 - diffPct);
  };

  const scores = [
    closeness(totals.calories, plan.calories),
    closeness(totals.protein, plan.protein_g),
    closeness(totals.carbs, plan.carbs_g),
    closeness(totals.fat, plan.fat_g),
  ];
  const value = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  return { value, note: `${Math.round(totals.calories)} / ${Math.round(plan.calories)} kcal vs. your plan today` };
}

/* ---------------- Rendering ---------------- */

function renderComponents(components) {
  Object.entries(components).forEach(([key, result]) => {
    const card = document.querySelector(`[data-component="${key}"]`);
    if (!card) return;
    const valueEl = card.querySelector("[data-value]");
    const barEl = card.querySelector("[data-bar]");
    const noteEl = card.querySelector("[data-note]");

    if (!result) {
      valueEl.textContent = t("healthscore_no_data", "No data");
      barEl.style.width = "0%";
      barEl.style.opacity = "0.25";
      noteEl.textContent = logHintFor(key);
      return;
    }

    valueEl.textContent = `${result.value}%`;
    barEl.style.width = `${result.value}%`;
    noteEl.textContent = result.note;
  });
}

function logHintFor(key) {
  return {
    nutrition: "Log a meal in Food Tracker to include this.",
    exercise: "Mark a workout complete in Exercise to include this.",
    sleep: "Log your sleep hours to include this.",
    hydration: "Log water intake today to include this.",
    bmi: "Calculate your BMI to include this.",
  }[key] || "No data yet.";
}

function renderOverall(components) {
  const available = Object.entries(components).filter(([, v]) => v !== null);

  const scoreEl = document.getElementById("scoreBig");
  const messageEl = document.getElementById("scoreMessage");

  if (!available.length) {
    scoreEl.textContent = "—";
    messageEl.textContent = "Start logging your BMI, water, sleep, meals, or a workout to see your Health Score.";
    return;
  }

  const totalWeight = available.reduce((sum, [key]) => sum + HEALTH_SCORE_WEIGHTS[key], 0);
  const weighted = available.reduce((sum, [key, v]) => sum + v.value * (HEALTH_SCORE_WEIGHTS[key] / totalWeight), 0);
  const overall = Math.round(weighted);

  scoreEl.textContent = overall;
  scoreEl.style.color = overall >= 75 ? "var(--color-mint)" : overall >= 50 ? "var(--color-amber)" : "var(--color-coral)";

  const missing = Object.keys(HEALTH_SCORE_WEIGHTS).filter((k) => !components[k]);
  if (missing.length) {
    messageEl.textContent = `Based on ${available.length} of 5 tracked areas — log the rest for a fuller picture.`;
  } else if (overall >= 85) {
    messageEl.textContent = t("healthscore_msg_excellent", "Excellent — you're on top of every area this app tracks.");
  } else if (overall >= 65) {
    messageEl.textContent = t("healthscore_msg_solid", "Solid overall. Check the lowest-scoring area below for the easiest win.");
  } else {
    messageEl.textContent = t("healthscore_msg_room", "There's real room to improve — start with whichever area below is lowest.");
  }
}
