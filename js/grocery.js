/* =========================================================================
   grocery.js — Grocery Planner
   Pulls the user's most recent diet plan, fetches each meal's real
   ingredient list from Spoonacular (via the "recipeInfo" action, using the
   recipe ids saved by diet-plan.js), and turns them into a categorized,
   checkable shopping list stored in grocery_items.
   ========================================================================= */

let groceryUser = null;
let activeDietPlan = null;

const GROCERY_CATEGORIES = [
  { key: "Produce", label: "🥦 Produce", keywords: ["tomato", "onion", "garlic", "potato", "spinach", "lettuce", "carrot", "pepper", "cucumber", "apple", "banana", "lemon", "lime", "avocado", "broccoli", "cabbage", "ginger", "chili", "chilli", "cilantro", "parsley", "basil", "mushroom", "kale", "zucchini", "celery", "scallion", "green onion", "herb"] },
  { key: "Dairy & Eggs", label: "🥛 Dairy & Eggs", keywords: ["milk", "cheese", "butter", "yogurt", "yoghurt", "cream", "egg"] },
  { key: "Meat & Seafood", label: "🍗 Meat & Seafood", keywords: ["chicken", "beef", "pork", "fish", "shrimp", "salmon", "turkey", "bacon", "sausage", "mutton", "tuna", "lamb"] },
  { key: "Grains & Bakery", label: "🍞 Grains & Bakery", keywords: ["rice", "bread", "flour", "pasta", "oats", "oat", "noodle", "tortilla", "bun", "bagel", "cereal", "quinoa"] },
  { key: "Pantry & Spices", label: "🧂 Pantry & Spices", keywords: ["salt", "sugar", "oil", "vinegar", "sauce", "spice", "cumin", "paprika", "cinnamon", "honey", "syrup", "stock", "broth", "pepper", "powder", "extract", "baking", "yeast", "nut", "seed"] }
];

function categorize(text) {
  const lower = text.toLowerCase();
  for (const cat of GROCERY_CATEGORIES) {
    if (cat.keywords.some((kw) => lower.includes(kw))) return cat.key;
  }
  return "Other";
}

// Splits a Spoonacular ingredient line like "2 cups chopped onion" into a
// quantity chunk and a plain-language name. Falls back to the full line as
// the name when no clean leading quantity is found (e.g. "Salt to taste").
const UNIT_WORDS = "cups?|tablespoons?|tbsp|teaspoons?|tsp|ounces?|oz|pounds?|lbs?|grams?|g|kg|ml|liters?|litres?|l|pinch(?:es)?|cloves?|slices?|pieces?|cans?|packages?|servings?";
function parseIngredientLine(line) {
  const re = new RegExp(`^([\\d]+(?:[\\d\\/.\\s]*\\d)?)\\s*(${UNIT_WORDS})?\\s+(.*)$`, "i");
  const m = line.match(re);
  if (m) {
    const qty = `${m[1].trim()}${m[2] ? " " + m[2] : ""}`.trim();
    const name = m[3].trim();
    return { qty, name: name || line };
  }
  return { qty: "", name: line };
}

document.addEventListener("DOMContentLoaded", async () => {
  groceryUser = await requireAuth();
  if (!groceryUser) return;

  renderShell("grocery.html");
  await loadUserChip(groceryUser);
  await loadActivePlan();
  hidePageLoader();

  qs("#groceryGenerateBtn")?.addEventListener("click", handleGenerate);
  qs("#groceryAddForm")?.addEventListener("submit", handleAddCustomItem);
  qs("#groceryClearCheckedBtn")?.addEventListener("click", clearCheckedItems);
});

async function loadActivePlan() {
  const { data } = await supabaseClient
    .from("diet_plans")
    .select("*")
    .eq("user_id", groceryUser.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!data || !data.length) {
    qs("#groceryNoPlan").style.display = "block";
    qs("#groceryPlanCard").style.display = "none";
    qs("#groceryListSection").style.display = "none";
    return;
  }

  activeDietPlan = data[0];
  qs("#groceryNoPlan").style.display = "none";
  qs("#groceryPlanCard").style.display = "block";
  qs("#groceryListSection").style.display = "block";

  qs("#groceryPlanGoal").textContent = activeDietPlan.goal || "—";
  qs("#groceryPlanMeals").innerHTML = `
    <li><strong>Breakfast:</strong> ${activeDietPlan.breakfast || "—"}</li>
    <li><strong>Lunch:</strong> ${activeDietPlan.lunch || "—"}</li>
    <li><strong>Dinner:</strong> ${activeDietPlan.dinner || "—"}</li>
    <li><strong>Snacks:</strong> ${activeDietPlan.snacks || "—"}</li>
  `;

  await loadGroceryItems();
}

async function handleGenerate() {
  if (!activeDietPlan) return;
  const btn = qs("#groceryGenerateBtn");

  const recipeIds = [...new Set([
    activeDietPlan.breakfast_id,
    activeDietPlan.lunch_id,
    activeDietPlan.dinner_id,
    activeDietPlan.snack_id
  ].filter(Boolean))];

  if (!recipeIds.length) {
    showToast(t("toast_grocery_no_recipes", "This diet plan has no linked recipes to build a list from. Generate a new diet plan first."), "error", 5000);
    return;
  }

  setBtnLoading(btn, true, "Building list...");

  const results = await Promise.all(
    recipeIds.map((id) => callSpoonacular("recipeInfo", { id }))
  );

  const rawLines = [];
  results.forEach((r) => {
    if (r.ok && r.data?.result?.ingredients) {
      rawLines.push(...r.data.result.ingredients);
    }
  });

  if (!rawLines.length) {
    setBtnLoading(btn, false, t("grocery_generate_btn", "Generate Grocery List"));
    showToast(t("toast_grocery_fetch_fail", "Couldn't fetch ingredients for this plan right now. Please try again."), "error");
    return;
  }

  // Merge duplicate ingredients (by name) so the same item from multiple
  // meals shows once with each meal's quantity combined.
  const merged = new Map();
  rawLines.forEach((line) => {
    const { qty, name } = parseIngredientLine(line);
    const key = name.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, { name, qtys: new Set(), category: categorize(name) });
    }
    if (qty) merged.get(key).qtys.add(qty);
  });

  const items = [...merged.values()].map((item) => ({
    user_id: groceryUser.id,
    diet_plan_id: activeDietPlan.id,
    item_name: item.name.charAt(0).toUpperCase() + item.name.slice(1),
    category: item.category,
    quantity: [...item.qtys].join(" + "),
    is_checked: false
  }));

  // Regenerate: clear out any previous list for this plan, then insert fresh.
  await supabaseClient.from("grocery_items").delete().eq("diet_plan_id", activeDietPlan.id);
  const { error } = await supabaseClient.from("grocery_items").insert(items);

  setBtnLoading(btn, false, t("grocery_regenerate_btn", "Regenerate Grocery List"));

  if (error) { showToast(error.message, "error"); return; }

  showToast(t("toast_grocery_built", "Grocery list built — {n} items 🛒").replace("{n}", items.length), "success");
  await loadGroceryItems();
}

async function loadGroceryItems() {
  const { data, error } = await supabaseClient
    .from("grocery_items")
    .select("*")
    .eq("user_id", groceryUser.id)
    .eq("diet_plan_id", activeDietPlan.id)
    .order("category", { ascending: true })
    .order("created_at", { ascending: true });

  const container = qs("#groceryItemList");
  const genBtn = qs("#groceryGenerateBtn");

  if (error || !data || !data.length) {
    container.innerHTML = `<div class="card"><p class="text-sm text-muted">No grocery list yet — click "Generate Grocery List" above to build one from your active diet plan.</p></div>`;
    if (genBtn) genBtn.textContent = t("grocery_generate_btn", "Generate Grocery List");
    updateGroceryProgress([]);
    return;
  }

  if (genBtn) genBtn.textContent = t("grocery_regenerate_btn", "Regenerate Grocery List");

  const byCategory = {};
  data.forEach((item) => {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  });

  const order = [...GROCERY_CATEGORIES.map((c) => c.key), "Custom", "Other"];
  const sortedCats = Object.keys(byCategory).sort((a, b) => order.indexOf(a) - order.indexOf(b));

  container.innerHTML = sortedCats.map((cat) => {
    const meta = GROCERY_CATEGORIES.find((c) => c.key === cat);
    const label = cat === "Custom" ? "✏️ Custom Items" : (meta ? meta.label : "🛒 Other");
    const catItems = byCategory[cat];
    const catChecked = catItems.filter((i) => i.is_checked).length;

    return `
      <div class="card mb-16">
        <div class="flex-between mb-16">
          <h4 style="margin:0;font-size:1rem;">${label}</h4>
          <span class="text-sm text-muted">${catChecked}/${catItems.length}</span>
        </div>
        <div class="flex-col gap-10">
          ${catItems.map((item) => `
            <div class="flex-between" style="padding:10px 14px;border-radius:12px;border:1px solid var(--color-border);${item.is_checked ? "opacity:0.55;" : ""}">
              <label class="flex gap-16" style="align-items:center;cursor:pointer;">
                <input type="checkbox" ${item.is_checked ? "checked" : ""} onchange="toggleGroceryItem('${item.id}', this.checked)" />
                <span style="${item.is_checked ? "text-decoration:line-through;" : ""}">${item.item_name}${item.quantity ? ` <span class="text-sm text-muted">(${item.quantity})</span>` : ""}</span>
              </label>
              <button class="btn btn-ghost btn-sm" onclick="deleteGroceryItem('${item.id}')" aria-label="Remove item">🗑️</button>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }).join("");

  updateGroceryProgress(data);
}

function updateGroceryProgress(items) {
  const total = items.length;
  const checked = items.filter((i) => i.is_checked).length;
  const categories = new Set(items.map((i) => i.category)).size;
  const pct = total ? Math.round((checked / total) * 100) : 0;

  qs("#groceryProgressText").textContent = total ? `${checked} of ${total} items checked (${pct}%)` : "";
  const bar = qs("#groceryProgressBar");
  if (bar) bar.style.width = `${pct}%`;

  const statTotal = qs("#groceryStatTotal");
  const statChecked = qs("#groceryStatChecked");
  const statCategories = qs("#groceryStatCategories");
  if (statTotal) statTotal.textContent = total;
  if (statChecked) statChecked.textContent = checked;
  if (statCategories) statCategories.textContent = categories;
}

async function toggleGroceryItem(id, isChecked) {
  const { error } = await supabaseClient.from("grocery_items").update({ is_checked: isChecked }).eq("id", id);
  if (error) { showToast(error.message, "error"); return; }
  await loadGroceryItems();
}

async function deleteGroceryItem(id) {
  const { error } = await supabaseClient.from("grocery_items").delete().eq("id", id);
  if (error) { showToast(error.message, "error"); return; }
  await loadGroceryItems();
}

async function clearCheckedItems() {
  const { error } = await supabaseClient
    .from("grocery_items")
    .delete()
    .eq("user_id", groceryUser.id)
    .eq("diet_plan_id", activeDietPlan.id)
    .eq("is_checked", true);
  if (error) { showToast(error.message, "error"); return; }
  showToast(t("toast_grocery_cleared", "Checked items cleared"), "info");
  await loadGroceryItems();
}

async function handleAddCustomItem(event) {
  event.preventDefault();
  const name = qs("#groceryCustomName").value.trim();
  const qty = qs("#groceryCustomQty").value.trim();
  if (!name) return;

  const { error } = await supabaseClient.from("grocery_items").insert({
    user_id: groceryUser.id,
    diet_plan_id: activeDietPlan.id,
    item_name: name,
    category: "Custom",
    quantity: qty || null,
    is_checked: false
  });

  if (error) { showToast(error.message, "error"); return; }

  qs("#groceryAddForm").reset();
  await loadGroceryItems();
}
