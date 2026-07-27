let foodTrackerUser = null;
let foodLog = [];

document.addEventListener("DOMContentLoaded", async () => {
  foodTrackerUser = await requireAuth();
  if (!foodTrackerUser) return;

  renderShell("food-tracker.html");
  await loadUserChip(foodTrackerUser);
  await loadFoodLog();
  hidePageLoader();

  const foodForm = qs("#foodLogForm");
  const clearBtn = qs("#clearFoodLog");

  if (foodForm) foodForm.addEventListener("submit", handleFoodLogSubmit);
  if (clearBtn) clearBtn.addEventListener("click", clearFoodLog);
});

// ================= Spoonacular API (via secure edge function) =================
// The API key lives server-side only (Supabase secret), never in this file.

async function getFoodNutrition(foodName) {
  const { ok, data, message } = await callSpoonacular("ingredientLookup", { query: foodName, amount: 100, unit: "grams", aiOnly: true });

  if (!ok) return { error: message };
  if (!data.found) return { notFound: true };

  return {
    result: {
      name: data.result.name,
      calories: data.result.calories,
      protein: data.result.protein,
      carbs: data.result.carbs,
      fat: data.result.fat,
      combined: data.result.combined || false,
      parts: data.result.parts || null,
      missingParts: data.result.missingParts || null,
      estimated: data.result.estimated || false,
      aiEstimated: data.result.aiEstimated || false
    }
  };
}

// ================= Persistence (Supabase — today's entries only) =================
// Food logs live in the food_logs table now instead of localStorage, so the
// diary is scoped to "today" (matching the "Today's Food Journal" label) and
// the data is available server-side for the Health Score system.

async function loadFoodLog() {
  const { data, error } = await supabaseClient
    .from("food_logs")
    .select("id, meal, name, calories, protein, carbs, fat, is_ai_estimate, created_at")
    .eq("user_id", foodTrackerUser.id)
    .eq("log_date", todayDateStr())
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load food log:", error);
    foodLog = [];
  } else {
    foodLog = (data || []).map((row) => ({
      id: row.id,
      meal: row.meal,
      name: row.name,
      calories: row.calories,
      protein: row.protein,
      carbs: row.carbs,
      fat: row.fat,
      isAiEstimate: row.is_ai_estimate || false,
      createdAt: row.created_at
    }));
  }

  renderFoodLog();
}

async function handleFoodLogSubmit(event) {
  event.preventDefault();

  const meal = qs("#foodMeal").value;
  const name = qs("#foodName").value.trim();

  if (!name) {
    showToast(t("toast_foodtracker_enter_name", "Please enter a food name."), "error");
    return;
  }

  const btn = qs("#foodAddBtn");

  btn.disabled = true;
  btn.textContent = t("foodtracker_searching", "Searching...");

  const lookup = await getFoodNutrition(name);

  btn.disabled = false;
  btn.textContent = t("foodtracker_add_food", "Add Food");

  if (lookup.error) {
    showToast(lookup.error, "error", 5000);
    return;
  }
  if (lookup.notFound) {
    showToast(t("toast_no_match_found", 'No match found for "{name}". Try a simpler or different name.').replace("{name}", name), "error");
    return;
  }

  const nutrition = lookup.result;

  if (nutrition.combined) {
    const missing = nutrition.missingParts?.length ? ` (${t("toast_couldnt_match", "couldn't match:")} ${nutrition.missingParts.join(", ")})` : "";
    showToast(`${t("toast_combined_nutrition", "Combined nutrition for:")} ${nutrition.parts.join(" + ")}${missing}`, "success", 5000);
  } else if (nutrition.aiEstimated) {
    showToast(t("toast_ai_estimated_nutrition", "🤖 AI-estimated nutrition — not verified lab data, but works for any food, including local/regional dishes."), "success", 5000);
  } else if (nutrition.estimated) {
    showToast(t("toast_not_raw_ingredient", '"{name}" isn\'t a raw ingredient in Spoonacular — using a similar recipe\'s nutrition as an estimate.').replace("{name}", name), "warning", 5000);
  }

  const row = {
    user_id: foodTrackerUser.id,
    log_date: todayDateStr(),
    meal,
    name: nutrition.name,
    calories: Math.round(nutrition.calories),
    protein: Number(nutrition.protein.toFixed(1)),
    carbs: Number(nutrition.carbs.toFixed(1)),
    fat: Number(nutrition.fat.toFixed(1)),
    is_ai_estimate: nutrition.aiEstimated || false
  };

  const { error } = await supabaseClient.from("food_logs").insert(row);

  if (error) {
    showToast(error.message, "error");
    return;
  }

  await loadFoodLog();
  qs("#foodLogForm").reset();
  showToast(t("toast_foodtracker_added", "Food added successfully!"), "success");
}

async function clearFoodLog(event) {
  event.preventDefault();

  const { error } = await supabaseClient
    .from("food_logs")
    .delete()
    .eq("user_id", foodTrackerUser.id)
    .eq("log_date", todayDateStr());

  if (error) {
    showToast(error.message, "error");
    return;
  }

  foodLog = [];
  renderFoodLog();
  showToast(t("toast_foodtracker_cleared", "Today's food diary cleared."), "success");
}

function renderFoodLog() {
  const list = qs("#foodLogList");
  list.innerHTML = "";

  const MEAL_STYLE = {
    breakfast: { color: "var(--color-amber)", bg: "var(--tint-amber)", emoji: "🌅" },
    lunch:     { color: "var(--color-primary)", bg: "var(--color-primary-light)", emoji: "🥗" },
    dinner:    { color: "var(--color-secondary)", bg: "var(--color-secondary-light)", emoji: "🍽️" },
    snack:     { color: "var(--color-coral)", bg: "var(--tint-coral)", emoji: "🍎" }
  };

  const MEAL_LABEL_KEYS = { breakfast: "meal_breakfast", lunch: "meal_lunch", dinner: "meal_dinner", snack: "meal_snack" };

  if (!foodLog.length) {
    list.innerHTML = `<div class="text-sm text-muted" style="padding:20px 0;text-align:center;">${t("foodtracker_no_entries", "No food entries yet today. Add breakfast, lunch, dinner, or snack items above.")}</div>`;
  } else {
    foodLog.forEach((entry) => {
      const meal = MEAL_STYLE[entry.meal] || MEAL_STYLE.snack;
      const mealLabel = t(MEAL_LABEL_KEYS[entry.meal] || "meal_snack", entry.meal.charAt(0).toUpperCase() + entry.meal.slice(1));
      const item = document.createElement("div");
      item.className = "card";
      item.style.padding = "14px 16px";
      item.style.marginBottom = "12px";
      item.style.borderLeft = `4px solid ${meal.color}`;
      item.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;">
          <div>
            <span style="display:inline-flex;align-items:center;gap:6px;font-size:0.75rem;font-weight:700;color:${meal.color};background:${meal.bg};padding:3px 10px;border-radius:20px;">
              ${meal.emoji} ${mealLabel}
            </span>
            <div style="font-weight:700;margin-top:6px;">
              ${entry.name}
              ${entry.isAiEstimate ? `<span class="text-sm" style="font-weight:600;color:var(--color-amber);background:var(--tint-amber);padding:2px 8px;border-radius:20px;margin-left:6px;" title="${t("toast_ai_estimated_nutrition", "🤖 AI-estimated nutrition — not verified lab data, but works for any food, including local/regional dishes.")}">🤖 ${t("foodtracker_ai_estimate_badge", "AI estimate")}</span>` : ""}
            </div>
          </div>
          <div style="text-align:right;">
            <div class="text-sm text-muted">${localizeTimeString(new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div>
            <div class="mono" style="font-weight:700;color:var(--color-amber);">${entry.calories} ${t("unit_kcal", "kcal")}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <span class="text-sm" style="background:var(--color-secondary-light);color:var(--color-secondary);padding:3px 10px;border-radius:20px;">💪 ${entry.protein}${t("unit_g", "g")} ${t("nutrition_protein_label", "protein")}</span>
          <span class="text-sm" style="background:var(--color-primary-light);color:var(--color-primary);padding:3px 10px;border-radius:20px;">🌾 ${entry.carbs}${t("unit_g", "g")} ${t("nutrition_carbs_label", "carbs")}</span>
          <span class="text-sm" style="background:var(--tint-coral);color:var(--color-coral);padding:3px 10px;border-radius:20px;">🥑 ${entry.fat}${t("unit_g", "g")} ${t("nutrition_fat_label", "fat")}</span>
        </div>
      `;
      list.appendChild(item);
    });
  }

  const totals = foodLog.reduce(
    (sum, entry) => ({
      calories: sum.calories + entry.calories,
      protein: sum.protein + entry.protein,
      carbs: sum.carbs + entry.carbs,
      fat: sum.fat + entry.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  qs("#totalCalories").textContent = `${totals.calories} ${t("unit_kcal", "kcal")}`;
  qs("#totalProtein").textContent = `${totals.protein.toFixed(1)} ${t("unit_g", "g")}`;
  qs("#totalCarbs").textContent = `${totals.carbs.toFixed(1)} ${t("unit_g", "g")}`;
  qs("#totalFat").textContent = `${totals.fat.toFixed(1)} ${t("unit_g", "g")}`;
}
