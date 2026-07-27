/* =========================================================================
   nutrition.js
   ========================================================================= */

let nutritionUser = null;
let foodLog = [];
let currentNutritionPlan = null;
let nutritionProfileCtx = null;
const FOOD_LOG_KEY_PREFIX = "nutrihealth-food-log-";

document.addEventListener("DOMContentLoaded", async () => {
  nutritionUser = await requireAuth();
  if (!nutritionUser) return;

  renderShell("nutrition.html");
  await loadUserChip(nutritionUser);
  await loadFoodLog();
  await loadLatestPlan();

  nutritionProfileCtx = await initProfileSelector({
    containerId: "profileSelector",
    user: nutritionUser,
    fields: ["age", "gender", "height", "weight"],
    fieldIds: { age: "nAge", gender: "nGender", height: "nHeight", weight: "nWeight" }
  });

  hidePageLoader();

  qs("#nutritionForm").addEventListener("submit", handleNutritionSubmit);
});

// Mifflin-St Jeor equation for BMR, then scaled by activity + goal.
function calculateNutrition({ age, gender, weight, height, activity, goal }) {
  let bmr = gender === "male"
    ? 10 * weight + 6.25 * height - 5 * age + 5
    : 10 * weight + 6.25 * height - 5 * age - 161;

  let calories = bmr * activity;

  if (goal === "loss") calories -= 500;
  if (goal === "gain") calories += 400;

  calories = Math.max(1200, Math.round(calories));

  const proteinPerKg = goal === "loss" ? 1.8 : goal === "gain" ? 2.0 : 1.6;
  const protein_g = Math.round(weight * proteinPerKg);
  const fat_g = Math.round((calories * 0.25) / 9);
  const carbCalories = calories - protein_g * 4 - fat_g * 9;
  const carbs_g = Math.max(0, Math.round(carbCalories / 4));

  return { calories, protein_g, carbs_g, fat_g };
}

async function handleNutritionSubmit(event) {
  event.preventDefault();
  const btn = qs("#nutritionBtn");

  const inputs = {
    age: parseInt(qs("#nAge").value, 10),
    gender: qs("#nGender").value,
    weight: parseFloat(qs("#nWeight").value),
    height: parseFloat(qs("#nHeight").value),
    activity: parseFloat(qs("#nActivity").value),
    goal: qs("#nGoal").value
  };

  const result = calculateNutrition(inputs);
  const mode = nutritionProfileCtx ? nutritionProfileCtx.getMode() : "me";

  if (mode === "me") {
    setBtnLoading(btn, true, "Calculating...");
    const { error } = await supabaseClient.from("nutrition_plans").insert({
      user_id: nutritionUser.id,
      goal: inputs.goal,
      calories: result.calories,
      protein_g: result.protein_g,
      carbs_g: result.carbs_g,
      fat_g: result.fat_g
    });
    setBtnLoading(btn, false, t("nutrition_calculate_plan_btn", "Calculate my plan"));

    if (error) { showToast(error.message, "error"); return; }

    renderResult(result, { goal: inputs.goal, persisted: true });
    showToast(t("toast_nutrition_saved", "Nutrition plan saved!"), "success");
  } else {
    renderResult(result, { goal: inputs.goal, persisted: false });
    if (nutritionProfileCtx) await nutritionProfileCtx.maybeSaveFamilyProfile();
    showToast(t("toast_nutrition_temp", "Temporary plan calculated — this won't be saved to your history."), "success");
  }
}

function renderResult(result, { goal, persisted = true } = {}) {
  const grid = qs("#nutritionGrid");
  if (grid) {
    grid.classList.remove("grid-single");
    grid.classList.add("grid-double");
  }

  qs("#nutritionResult").style.display = "block";
  qs("#rCalories").textContent = `${result.calories} kcal`;
  qs("#rProtein").textContent = `${result.protein_g} g`;
  qs("#rCarbs").textContent = `${result.carbs_g} g`;
  qs("#rFat").textContent = `${result.fat_g} g`;

  const remainingRow = qs("#rRemainingCalories")?.closest(".grid");
  const reportLink = qs('a[href="nutrition-report.html"]');

  if (!persisted) {
    // Temporary calculation for someone else: show the targets, but don't
    // let it overwrite the signed-in user's own plan, remaining-calorie
    // tracking, or nutrition report.
    if (remainingRow) remainingRow.style.display = "none";
    if (reportLink) reportLink.style.display = "none";
    showTemporaryBadge(true);
    return;
  }

  if (remainingRow) remainingRow.style.display = "";
  if (reportLink) reportLink.style.display = "";
  showTemporaryBadge(false);

  currentNutritionPlan = { ...result, goal: goal || result.goal };
  renderRemainingTotals();
}

function showTemporaryBadge(show) {
  let badge = qs("#nutritionTempBadge");
  const resultCard = qs("#nutritionResult");
  if (!resultCard) return;

  if (show) {
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "nutritionTempBadge";
      badge.className = "text-sm badge-temp mb-16";
      badge.textContent = "Temporary calculation — this result is for reference only and won't be saved to your account history.";
      resultCard.insertBefore(badge, resultCard.firstChild);
    }
  } else if (badge) {
    badge.remove();
  }
}

function renderRemainingTotals() {
  const totals = foodLog.reduce(
    (sum, entry) => ({
      calories: sum.calories + entry.calories,
      protein: sum.protein + entry.protein,
      carbs: sum.carbs + entry.carbs,
      fat: sum.fat + entry.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  const target = currentNutritionPlan || { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };

  const remaining = {
    calories: target.calories - totals.calories,
    protein: target.protein_g - totals.protein,
    carbs: target.carbs_g - totals.carbs,
    fat: target.fat_g - totals.fat,
  };

  qs("#rRemainingCalories").textContent = `${Math.max(0, remaining.calories)} kcal`;
  qs("#rRemainingProtein").textContent = `${Math.max(0, remaining.protein).toFixed(1)} g`;
  qs("#rRemainingCarbs").textContent = `${Math.max(0, remaining.carbs).toFixed(1)} g`;
  qs("#rRemainingFat").textContent = `${Math.max(0, remaining.fat).toFixed(1)} g`;
  if (currentNutritionPlan) {
    const overText = (value) => value < 0 ? `+${Math.abs(value.toFixed(1))}` : "0";
    qs("#rRemainingCalories").textContent = remaining.calories >= 0 ? `${remaining.calories} kcal` : `Over by ${overText(remaining.calories)} kcal`;
    qs("#rRemainingProtein").textContent = remaining.protein >= 0 ? `${remaining.protein.toFixed(1)} g` : `Over by ${overText(remaining.protein)} g`;
    qs("#rRemainingCarbs").textContent = remaining.carbs >= 0 ? `${remaining.carbs.toFixed(1)} g` : `Over by ${overText(remaining.carbs)} g`;
    qs("#rRemainingFat").textContent = remaining.fat >= 0 ? `${remaining.fat.toFixed(1)} g` : `Over by ${overText(remaining.fat)} g`;
  }
  if (qs("#nutritionReport")) renderNutritionReport(remaining, totals);
}

function renderNutritionReport(remaining, totals) {
  const reportCard = qs("#nutritionReport");
  const reportHeadline = qs("#reportHeadline");
  const reportDetails = qs("#reportDetails");

  if (!currentNutritionPlan) {
    reportCard.style.display = "none";
    return;
  }

  reportCard.style.display = "block";

  const calorieMessage = remaining.calories >= 0
    ? `You are ${remaining.calories} kcal below your daily target. Add another balanced meal to reach your goal.`
    : `You have exceeded your target by ${Math.abs(remaining.calories)} kcal. Consider lighter meals or extra activity to balance today.`;

  const macroLines = [
    remaining.protein >= 0
      ? `Protein is ${remaining.protein.toFixed(1)} g short of your target.`
      : `Protein is ${Math.abs(remaining.protein).toFixed(1)} g above your target.`,
    remaining.carbs >= 0
      ? `Carbs are ${remaining.carbs.toFixed(1)} g short of your target.`
      : `Carbs are ${Math.abs(remaining.carbs).toFixed(1)} g above your target.`,
    remaining.fat >= 0
      ? `Fat is ${remaining.fat.toFixed(1)} g short of your target.`
      : `Fat is ${Math.abs(remaining.fat).toFixed(1)} g above your target.`,
  ];

  const goalNote = currentNutritionPlan.goal === "loss"
    ? "A mild calorie deficit supports weight loss; focus on protein-rich, nutrient-dense meals."
    : currentNutritionPlan.goal === "gain"
      ? "A slight calorie surplus supports muscle gain; keep protein high and choose healthy carbs."
      : "Maintaining calories helps keep energy steady; stay consistent with your food log.";

  const eatenCalories = totals.calories;
  const progressPercent = currentNutritionPlan.calories > 0
    ? Math.min(100, Math.round((eatenCalories / currentNutritionPlan.calories) * 100))
    : 0;

  reportHeadline.textContent = calorieMessage;
  reportDetails.innerHTML = `
    <div class="text-sm text-muted">Goal: ${currentNutritionPlan.calories} kcal · Eaten: ${eatenCalories} kcal · Progress: ${progressPercent}%</div>
    <ul class="text-sm mt-12" style="padding-left:18px;line-height:1.8;">
      <li>${macroLines[0]}</li>
      <li>${macroLines[1]}</li>
      <li>${macroLines[2]}</li>
    </ul>
    <p class="text-sm text-muted mt-12">${goalNote}</p>
  `;
}

async function loadLatestPlan() {
  const { data } = await supabaseClient
    .from("nutrition_plans")
    .select("*")
    .eq("user_id", nutritionUser.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (data && data.length) renderResult(data[0]);
}

async function loadFoodLog() {
  const key = `${FOOD_LOG_KEY_PREFIX}${nutritionUser.id}`;
  try {
    const stored = localStorage.getItem(key);
    foodLog = stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.warn("Failed to load food log", error);
    foodLog = [];
  }
}
