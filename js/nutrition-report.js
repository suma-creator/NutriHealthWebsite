/* =========================================================================
   nutrition-report.js
   Builds a personalized nutrition report from:
     1. The signed-in user's profile (name, age) — public.users table
     2. Their most recently calculated nutrition plan — nutrition_plans table
     3. Today's logged meals (shared with the Food Tracker page) — localStorage
   ========================================================================= */

const REPORT_FOOD_LOG_KEY_PREFIX = "nutrihealth-food-log-";

let reportUser = null;
let reportProfile = null;
let reportPlan = null;

document.addEventListener("DOMContentLoaded", async () => {
  try {
    reportUser = await requireAuth();
    if (!reportUser) return;

    renderShell("nutrition-report.html");

    reportProfile = await loadUserChip(reportUser);
    renderUserInfo(reportUser, reportProfile);

    await loadLatestPlanForReport();
  } catch (error) {
    console.error("Failed to build nutrition report:", error);
    showToast?.("Something went wrong loading your report.", "error");
  } finally {
    hidePageLoader();
  }
});

function renderUserInfo(user, profile) {
  const name = profile?.name || user.user_metadata?.name || user.email || "—";
  const age = profile?.age ? `${profile.age} years` : "Not set in profile";

  qs("#reportUserName").textContent = name;
  qs("#reportUserAge").textContent = age;
  qs("#reportDate").textContent = formatDate(new Date());
}

function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

async function loadLatestPlanForReport() {
  const { data, error } = await supabaseClient
    .from("nutrition_plans")
    .select("*")
    .eq("user_id", reportUser.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Failed to load nutrition plan:", error);
  }

  reportPlan = data && data.length ? data[0] : null;

  if (!reportPlan) {
    qs("#planSavedDate").textContent = t("nutritionreport_no_plan_yet", "No plan yet");
    qs("#reportCalories").textContent = "—";
    qs("#reportProtein").textContent = "—";
    qs("#reportCarbs").textContent = "—";
    qs("#reportFat").textContent = "—";
    qs("#reportProgress").textContent = "—";
    qs("#reportDetails").innerHTML = `
      <li>You haven't calculated a nutrition plan yet. Head to the
        <a href="nutrition.html">Nutrition Calculator</a> to get your personalized
        daily calorie and macronutrient targets based on your age, weight,
        height, activity level, and goal.</li>
    `;
    return;
  }

  qs("#planSavedDate").textContent = formatDate(new Date(reportPlan.created_at));
  qs("#reportCalories").textContent = `${reportPlan.calories} kcal`;
  qs("#reportProtein").textContent = `${reportPlan.protein_g} g`;
  qs("#reportCarbs").textContent = `${reportPlan.carbs_g} g`;
  qs("#reportFat").textContent = `${reportPlan.fat_g} g`;

  const totals = loadTodaysFoodTotals();
  renderClinicalObservations(reportPlan, totals);
}

// Reads today's food log from the same localStorage key the Food Tracker
// and Nutrition Calculator pages use, so the report reflects what's
// actually been logged, not a separate/duplicate data source.
function loadTodaysFoodTotals() {
  const key = `${REPORT_FOOD_LOG_KEY_PREFIX}${reportUser.id}`;
  let entries = [];
  try {
    const stored = localStorage.getItem(key);
    entries = stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.warn("Failed to read food log for report:", error);
    entries = [];
  }

  return entries.reduce(
    (sum, entry) => ({
      calories: sum.calories + (Number(entry.calories) || 0),
      protein: sum.protein + (Number(entry.protein) || 0),
      carbs: sum.carbs + (Number(entry.carbs) || 0),
      fat: sum.fat + (Number(entry.fat) || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
}

function renderClinicalObservations(plan, totals) {
  const remaining = {
    calories: plan.calories - totals.calories,
    protein: plan.protein_g - totals.protein,
    carbs: plan.carbs_g - totals.carbs,
    fat: plan.fat_g - totals.fat,
  };

  const progressPercent = plan.calories > 0
    ? Math.min(100, Math.round((totals.calories / plan.calories) * 100))
    : 0;
  qs("#reportProgress").textContent = `${progressPercent}%`;

  // --- Calorie observation ---
  let calorieLine;
  if (totals.calories === 0) {
    calorieLine = `No meals logged yet today. Your daily target is <strong>${plan.calories} kcal</strong> — log meals in the Food Tracker to see live progress here.`;
  } else if (remaining.calories >= 0) {
    const severity = remaining.calories > plan.calories * 0.3 ? "significant" : "moderate";
    calorieLine = `Current intake is <strong>${Math.round(remaining.calories)} kcal below target</strong>. This is a ${severity} deficit and may support a weight loss goal if sustained appropriately.`;
  } else {
    calorieLine = `Current intake is <strong>${Math.round(Math.abs(remaining.calories))} kcal above target</strong>. Consider lighter meals or extra activity later today to stay on track.`;
  }

  // --- Macro observations ---
  const macroLine = (label, remainingValue, unit = "g") => {
    const abs = Math.abs(remainingValue).toFixed(1);
    if (remainingValue > 0.5) {
      const tip = {
        Protein: "ensure lean protein at each meal.",
        Carbs: "include whole grains or starchy vegetables.",
        Fat: "incorporate healthy fats like nuts, seeds, or olive oil.",
      }[label];
      return `${label} is <strong>${abs} ${unit} below target</strong>; ${tip}`;
    }
    if (remainingValue < -0.5) {
      return `${label} is <strong>${abs} ${unit} above target</strong>; keep an eye on portion sizes for the rest of the day.`;
    }
    return `${label} is right on target for today. Nice work staying consistent.`;
  };

  const proteinLine = macroLine("Protein", remaining.protein);
  const carbsLine = macroLine("Carbs", remaining.carbs);
  const fatLine = macroLine("Fat", remaining.fat);

  // --- Recommended approach (based on goal) ---
  const recommendation = plan.goal === "loss"
    ? "Focus on consistency, whole foods, and balanced macros to maintain your current momentum toward your weight loss goal."
    : plan.goal === "gain"
      ? "Prioritize protein and a modest calorie surplus, paired with resistance training, to support lean muscle gain."
      : "Keep calories and macros steady day to day — consistency is what maintains your current weight.";

  qs("#reportDetails").innerHTML = `
    <li>${calorieLine}</li>
    <li>${proteinLine}</li>
    <li>${carbsLine}</li>
    <li>${fatLine}</li>
    <li><strong>Recommended approach:</strong> ${recommendation}</li>
  `;
}
