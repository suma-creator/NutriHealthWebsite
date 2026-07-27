document.addEventListener("DOMContentLoaded", async () => {
  const user = await requireAuth();
  if (!user) return;

  renderShell("recipes.html");
  await loadUserChip(user);
  hidePageLoader();

  const searchForm = qs("#recipeSearchForm");
  const searchInput = qs("#recipeSearchInput");
  const resultsGrid = qs("#recipeResults");

  // Last rendered search results, keyed by id — lets us pull an
  // AI-generated recipe's inline ingredients/steps back out on demand
  // without a second AI call (groqGenerateRecipes already includes them).
  let lastResultsById = new Map();

  // ================= Spoonacular API (via secure edge function) =================
  // The API key lives server-side only (Supabase secret), never in this file.

  const aiBadge = `<span class="text-sm" style="font-weight:600;color:var(--color-amber);background:var(--tint-amber);padding:2px 8px;border-radius:20px;margin-left:6px;" title="Spoonacular was unavailable — this recipe is AI-generated, not from the recipe database.">🤖 AI generated</span>`;

  async function loadRecipeDetail(id, title, container) {
    container.innerHTML = `<div class="text-sm text-muted mt-12">Loading recipe...</div>`;

    // AI-generated recipes already carry their ingredients/steps from the
    // search response — no need to hit the network again.
    const cached = lastResultsById.get(id);
    if (cached?.aiGenerated && cached.ingredients) {
      renderRecipeDetail(cached, container);
      return;
    }

    const { ok, data, message } = await callSpoonacular("recipeInfo", { id, title });
    if (!ok) {
      container.innerHTML = `<div class="text-sm text-muted mt-12">${message}</div>`;
      return;
    }
    renderRecipeDetail(data.result, container);
  }

  function renderRecipeDetail(r, container) {
    container.innerHTML = `
      ${r.aiGenerated ? `<div class="mt-12">${aiBadge}</div>` : ""}
      ${r.imageIsIllustrative && r.imageCredit ? `<div class="text-sm text-muted mt-8">Representative photo · <a href="${r.imageCredit.pageUrl}" target="_blank" rel="noopener">Photo by ${r.imageCredit.photographer} on Pexels</a></div>` : ""}
      <div class="mt-12 text-sm"><strong>Ingredients</strong></div>
      <ul class="text-sm mt-8" style="padding-left:20px;">${(r.ingredients || []).map((i) => `<li>${i}</li>`).join("") || "<li>Not listed</li>"}</ul>
      ${r.steps?.length ? `<div class="mt-12 text-sm"><strong>Steps</strong></div><ol class="text-sm mt-8" style="padding-left:20px;">${r.steps.map((s) => `<li>${s}</li>`).join("")}</ol>` : ""}
      ${r.sourceUrl ? `<div class="mt-12"><a href="${r.sourceUrl}" target="_blank" rel="noopener" class="text-sm">View full recipe source →</a></div>` : ""}
    `;
  }

  function renderRecipes(list) {
    if (!list.length) {
      resultsGrid.innerHTML = `<div class="card"><p class="text-sm text-muted">I couldn't find a match for that search. Try a different ingredient, cuisine, or goal.</p></div>`;
      return;
    }

    lastResultsById = new Map(list.map((r) => [String(r.id), r]));

    resultsGrid.innerHTML = list.map((recipe, index) => `
      <div class="card" style="padding:24px;">
        ${recipe.image ? `<img src="${recipe.image}" alt="${recipe.title}" style="width:100%;border-radius:12px;margin-bottom:4px;" loading="lazy" />` : ""}
        ${recipe.imageIsIllustrative ? `<div class="text-sm text-muted" style="margin-bottom:8px;">Representative photo${recipe.imageCredit ? ` · <a href="${recipe.imageCredit.pageUrl}" target="_blank" rel="noopener">Photo by ${recipe.imageCredit.photographer} on Pexels</a>` : ""}</div>` : (recipe.image ? `<div style="margin-bottom:8px;"></div>` : "")}
        <h4>${recipe.title}${recipe.aiGenerated ? aiBadge : ""}</h4>
        ${recipe.summary ? `<p class="text-sm text-muted mt-8">${recipe.summary}${recipe.summary.length >= 220 ? "…" : ""}</p>` : ""}
        <div class="grid grid-3 mt-16" style="gap:12px;">
          <div class="card" style="padding:12px;text-align:center;">Calories<br /><strong>${recipe.calories || "—"}</strong></div>
          <div class="card" style="padding:12px;text-align:center;">Protein<br /><strong>${recipe.protein || "—"}g</strong></div>
          <div class="card" style="padding:12px;text-align:center;">Carbs<br /><strong>${recipe.carbs || "—"}g</strong></div>
        </div>
        <div class="text-sm text-muted mt-12">${recipe.readyInMinutes ? `⏱️ ${recipe.readyInMinutes} min` : ""}${recipe.servings ? ` · 🍽️ ${recipe.servings} servings` : ""}</div>
        <details class="mt-16" data-recipe-id="${recipe.id}" data-recipe-title="${recipe.title.replace(/"/g, "&quot;")}">
          <summary style="cursor:pointer;font-weight:600;">Ingredients &amp; instructions</summary>
          <div class="recipe-detail-${index}"></div>
        </details>
      </div>
    `).join("");

    qsa("details[data-recipe-id]", resultsGrid).forEach((detailsEl, index) => {
      let loaded = false;
      detailsEl.addEventListener("toggle", () => {
        if (detailsEl.open && !loaded) {
          loaded = true;
          loadRecipeDetail(detailsEl.dataset.recipeId, detailsEl.dataset.recipeTitle, detailsEl.querySelector(`.recipe-detail-${index}`));
        }
      });
    });
  }

  function renderEmptyState() {
    resultsGrid.innerHTML = `
      <div class="card" style="padding:24px;text-align:center;">
        <p class="text-sm text-muted">Search for a goal, ingredient, or meal type above — or tap one of the suggestions — to see matching recipes.</p>
      </div>
    `;
  }

  function renderLoading() {
    resultsGrid.innerHTML = `<div class="card" style="padding:24px;text-align:center;"><p class="text-sm text-muted">Searching recipes...</p></div>`;
  }

  async function runSearch(query) {
    renderLoading();
    const { ok, data, message } = await callSpoonacular("recipeSearch", { query, number: 12 });
    if (!ok) {
      resultsGrid.innerHTML = `<div class="card"><p class="text-sm text-muted">${message}</p></div>`;
      return;
    }
    if (data.aiGenerated && typeof showToast === "function") {
      showToast("🤖 Spoonacular is unavailable right now — showing AI-generated recipe suggestions instead.", "success", 5000);
    }
    if (data.aiUnavailable) {
      resultsGrid.innerHTML = `<div class="card"><p class="text-sm text-muted">No match in the recipe database for that search, and AI suggestions aren't set up yet on this server (missing GROQ_API_KEY), so local/regional dishes can't be generated. Ask your admin to run <code>supabase secrets set GROQ_API_KEY=your-groq-key</code> and redeploy the "spoonacular" function.</p></div>`;
      return;
    }
    renderRecipes(data.results);
  }

  qsa(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.recipe;
      searchInput.value = value.replace("-", " ");
      runSearch(searchInput.value);
    });
  });

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query) {
      renderEmptyState();
      return;
    }
    runSearch(query);
  });

  renderEmptyState();
});
