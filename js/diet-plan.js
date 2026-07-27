/* =========================================================================
   diet-plan.js
   Personalized diet plans generated live from the Spoonacular meal planner,
   via the secure "spoonacular" Supabase Edge Function.
   ========================================================================= */

let dietUser = null;

// Maps each on-screen goal to Spoonacular's supported `diet` values (where
// one exists), an `exclude` list for goals without a direct diet match, and
// a sensible default daily calorie target.
const GOAL_META = {
  loss:          { diet: null,             exclude: null,                          calories: 1600 },
  maintenance:   { diet: null,             exclude: null,                          calories: 2000 },
  gain:          { diet: null,             exclude: null,                          calories: 2600 },
  muscleGain:    { diet: null,             exclude: null,                          calories: 2700 },
  fatLoss:       { diet: null,             exclude: null,                          calories: 1500 },
  highProtein:   { diet: null,             exclude: null,                          calories: 2200 },
  vegetarian:    { diet: "vegetarian",     exclude: null,                          calories: 2000 },
  vegan:         { diet: "vegan",          exclude: null,                          calories: 2000 },
  lowCarb:       { diet: null,             exclude: "bread, pasta, rice, sugar",   calories: 1800 },
  keto:          { diet: "ketogenic",      exclude: null,                          calories: 1900 },
  mediterranean: { diet: null,             exclude: null,                          calories: 2000 },
  glutenFree:    { diet: "gluten free",    exclude: null,                          calories: 2000 },
  diabetic:      { diet: null,             exclude: "sugar, candy, soda",          calories: 1900 },
  heartHealthy:  { diet: null,             exclude: "bacon, sausage, fried food",  calories: 2000 },
  lowSodium:     { diet: null,             exclude: "bacon, ham, soy sauce, pickles", calories: 2000 },
  athlete:       { diet: null,             exclude: null,                          calories: 2800 },
  budget:        { diet: null,             exclude: null,                          calories: 2000 },
  quickMeals:    { diet: null,             exclude: null,                          calories: 2000 }
};

document.addEventListener("DOMContentLoaded", async () => {
  dietUser = await requireAuth();
  if (!dietUser) return;

  renderShell("diet-plan.html");
  await loadUserChip(dietUser);
  await prefillFromNutrition();

  qs("#dietResult").style.display = "none";
  hidePageLoader();

  qs("#dGoal").addEventListener("change", () => {
    const meta = GOAL_META[qs("#dGoal").value] || GOAL_META.maintenance;
    qs("#dCalories").value = meta.calories;
  });

  qs("#dietForm").addEventListener("submit", handleGenerate);
});

// Prefill goal + calories from the latest nutrition plan, if one exists.
async function prefillFromNutrition() {
  const { data } = await supabaseClient
    .from("nutrition_plans")
    .select("goal, calories")
    .eq("user_id", dietUser.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (data && data.length) {
    if (data[0].goal && GOAL_META[data[0].goal]) qs("#dGoal").value = data[0].goal;
    if (data[0].calories) qs("#dCalories").value = Math.round(data[0].calories);
  }
}

// ================= Spoonacular API (via secure edge function) =================
// The API key lives server-side only (Supabase secret), never in this file.

async function fetchMealPlan(targetCalories, diet, exclude, cuisine) {
  const { ok, data, message } = await callSpoonacular("mealPlan", { targetCalories, diet, exclude, cuisine });
  if (!ok) return { error: message };
  return { plan: data };
}

async function fetchSnack(diet, cuisine) {
  const { ok, data } = await callSpoonacular("recipeSearch", { query: "healthy snack", diet, cuisine, number: 1 });
  if (!ok || !data.results?.length) return null;
  const r = data.results[0];
  return { id: r.id, title: r.title, image: r.image, calories: r.calories, sourceUrl: r.sourceUrl, aiGenerated: r.aiGenerated || false };
}

function mealCard(meal) {
  if (!meal) return `<div class="text-sm text-muted">No suggestion available.</div>`;
  const aiBadge = meal.aiGenerated
    ? `<span class="text-sm" style="font-weight:600;color:var(--color-amber);background:var(--tint-amber);padding:2px 8px;border-radius:20px;margin-left:6px;" title="Spoonacular was unavailable — this suggestion is AI-generated.">🤖 AI</span>`
    : "";
  return `
    <div class="recommend-title">✅ Today's Recommendation</div>
    ${meal.image ? `<img src="${meal.image}" alt="${meal.title}" style="width:100%;border-radius:10px;margin:8px 0;" loading="lazy" />` : ""}
    <div class="recommended-food">${meal.title}${meal.calories ? ` — ${meal.calories} kcal` : ""}${aiBadge}</div>
    ${meal.sourceUrl ? `<a href="${meal.sourceUrl}" target="_blank" rel="noopener" class="text-sm">View recipe →</a>` : ""}
  `;
}

async function handleGenerate(event) {
  event.preventDefault();

  const btn = qs("#dietBtn");
  const goal = qs("#dGoal").value;
  const cuisine = qs("#dCuisine")?.value || null;
  const targetCalories = Number(qs("#dCalories").value) || 2000;
  const meta = GOAL_META[goal] || GOAL_META.maintenance;

  setBtnLoading(btn, true, "Generating...");

  const [mealPlanResult, snack] = await Promise.all([
    fetchMealPlan(targetCalories, meta.diet, meta.exclude, cuisine),
    fetchSnack(meta.diet, cuisine)
  ]);

  setBtnLoading(btn, false, t("dietplan_generate_btn_plain", "Generate Diet Plan"));

  if (mealPlanResult.error) {
    showToast(mealPlanResult.error, "error", 5000);
    return;
  }

  const planData = mealPlanResult.plan;
  if (!planData?.meals?.length) {
    showToast(t("toast_diet_no_plan", "No meal plan could be generated for that goal. Try a different calorie target."), "error");
    return;
  }

  if (planData.aiGenerated) {
    const cuisineLabels = { bangladeshi: t("dietplan_cuisine_name_bd", "Bangladeshi"), indian: t("dietplan_cuisine_name_in", "Indian"), pakistani: t("dietplan_cuisine_name_pk", "Pakistani"), korean: t("dietplan_cuisine_name_kr", "Korean") };
    if (cuisine && cuisineLabels[cuisine]) {
      showToast(t("toast_diet_ai_cuisine", "🤖 This {cuisine} plan was generated by AI for authentic dishes.").replace("{cuisine}", cuisineLabels[cuisine]), "success", 5000);
    } else {
      showToast(t("toast_diet_ai_fallback", "🤖 Spoonacular is unavailable right now — this plan was generated by AI instead."), "success", 5000);
    }
  }

  const [breakfast, lunch, dinner] = planData.meals;

  const savedPlan = {
    breakfast: breakfast ? `${breakfast.title} (${breakfast.readyInMinutes || "?"} min)` : "No suggestion",
    lunch: lunch ? `${lunch.title} (${lunch.readyInMinutes || "?"} min)` : "No suggestion",
    dinner: dinner ? `${dinner.title} (${dinner.readyInMinutes || "?"} min)` : "No suggestion",
    snacks: snack ? snack.title : "No suggestion"
  };

  const { error } = await supabaseClient
    .from("diet_plans")
    .insert({
      user_id: dietUser.id,
      goal,
      cuisine: cuisine || null,
      breakfast: savedPlan.breakfast,
      lunch: savedPlan.lunch,
      dinner: savedPlan.dinner,
      snacks: savedPlan.snacks,
      // Recipe ids (not just titles) so the Grocery Planner can pull each
      // meal's real ingredient list from Spoonacular later.
      breakfast_id: breakfast?.id || null,
      lunch_id: lunch?.id || null,
      dinner_id: dinner?.id || null,
      snack_id: snack?.id || null
    });

  if (error) {
    showToast(error.message, "error");
    return;
  }

  renderPlan({
    breakfast: mealCard(breakfast),
    lunch: mealCard(lunch),
    dinner: mealCard(dinner),
    snacks: mealCard(snack)
  }, planData.nutrients);

  showToast(t("toast_diet_generated", "Diet plan generated successfully!"), "success");
}

function renderPlan(plan, nutrients) {
  qs("#dietResult").style.display = "grid";

  qs("#mealBreakfast").innerHTML = plan.breakfast;
  qs("#mealLunch").innerHTML = plan.lunch;
  qs("#mealDinner").innerHTML = plan.dinner;
  qs("#mealSnacks").innerHTML = plan.snacks;

  const summaryEl = qs("#dietNutrientSummary");
  if (summaryEl && nutrients) {
    summaryEl.textContent = `Estimated for the day: ${Math.round(nutrients.calories || 0)} kcal · ${Math.round(nutrients.protein || 0)}g protein · ${Math.round(nutrients.carbohydrates || 0)}g carbs · ${Math.round(nutrients.fat || 0)}g fat`;
    summaryEl.style.display = "block";
  }

  const groceryCta = qs("#dietGroceryCta");
  if (groceryCta) groceryCta.style.display = "block";
}
