// supabase/functions/spoonacular/index.ts
//
// Single proxy endpoint for every Spoonacular call the app needs
// (food tracker, recipes, diet plan, food scanner). The client sends
// { action, params } and this function forwards the request to
// Spoonacular with the API key attached server-side, so the key is
// never present in any file shipped to the browser.
//
// It also caches successful responses for up to 1 hour (per Spoonacular's
// own terms, which explicitly permit this) so repeated/duplicate lookups
// during normal use — or testing — don't burn through the daily free-tier
// point quota.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE = "https://api.spoonacular.com";
const CACHE_TTL_MS = 55 * 60 * 1000; // stay safely under Spoonacular's 1-hour allowance
const CACHEABLE_ACTIONS = new Set(["ingredientLookup", "recipeSearch", "recipeInfo", "mealPlan"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Edge Functions get these injected automatically — no manual secret needed.
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") as string,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function pickNutrient(nutrients: any[], name: string) {
  const match = nutrients?.find((n: any) => n.name === name);
  return match ? Number(match.amount) : 0;
}

function cacheKeyFor(action: string, params: Record<string, any>) {
  const clean = Object.keys(params || {})
    .sort()
    .reduce((acc: Record<string, any>, k) => {
      const v = params[k];
      if (v !== undefined && v !== null && v !== "") acc[k] = v;
      return acc;
    }, {});
  return `${action}:${JSON.stringify(clean)}`;
}

async function getCached(key: string) {
  try {
    const { data } = await supabaseAdmin
      .from("spoonacular_cache")
      .select("response, created_at")
      .eq("cache_key", key)
      .maybeSingle();
    if (!data) return null;
    if (Date.now() - new Date(data.created_at).getTime() > CACHE_TTL_MS) return null;
    return data.response;
  } catch (err) {
    console.error("Cache read failed:", err);
    return null;
  }
}

async function setCached(key: string, response: unknown) {
  try {
    await supabaseAdmin
      .from("spoonacular_cache")
      .upsert({ cache_key: key, response, created_at: new Date().toISOString() });
  } catch (err) {
    console.error("Cache write failed:", err);
  }
}

async function spoonFetch(path: string, query: Record<string, any>, apiKey: string) {
  const url = new URL(BASE + path);
  url.searchParams.set("apiKey", apiKey);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const res = await fetch(url.toString());
  const raw = await res.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    console.error(`Spoonacular returned non-JSON (${res.status}) for ${path}:`, raw.slice(0, 300));
    throw new Error(`Spoonacular returned an unexpected response (status ${res.status}). It may be rate-limited or temporarily down.`);
  }

  if (!res.ok) {
    console.error(`Spoonacular error (${res.status}) for ${path}:`, data);
    if (res.status === 401) throw new Error("Spoonacular rejected the API key (401). Double-check SPOONACULAR_API_KEY.");
    if (res.status === 402) throw new Error("Spoonacular daily quota exceeded (402). Wait for reset or upgrade your plan.");
    throw new Error(data?.message || `Spoonacular request failed (${res.status}).`);
  }

  return data;
}

async function lookupSingleIngredient(term: string, amount: number, unit: string, apiKey: string) {
  const search = await spoonFetch("/food/ingredients/search", { query: term, number: 1 }, apiKey);
  if (!search.results?.length) return null;

  const info = await spoonFetch(`/food/ingredients/${search.results[0].id}/information`, { amount, unit }, apiKey);
  const nutrients = info?.nutrition?.nutrients || [];

  return {
    id: info.id,
    name: info.name,
    image: info.image ? `https://img.spoonacular.com/ingredients_100x100/${info.image}` : null,
    amount,
    unit,
    calories: pickNutrient(nutrients, "Calories"),
    protein: pickNutrient(nutrients, "Protein"),
    carbs: pickNutrient(nutrients, "Carbohydrates"),
    fat: pickNutrient(nutrients, "Fat"),
  };
}

// AI fallback used only when Spoonacular can't answer (quota exceeded, key
// error, or a genuine no-match). NOT a nutrition database — Groq is an LLM,
// so this is a best-guess estimate, never real lab/verified data. Every
// result from this path is marked aiEstimated: true so the UI can label it
// honestly and differently from real Spoonacular data.
async function groqEstimateNutrition(query: string, amount: number, unit: string) {
  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) return null; // Not configured — silently skip, caller falls back to the real error/not-found.

  const prompt = `Estimate the nutrition for: "${query}", for an amount of ${amount} ${unit}.
Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{"name": "short food name", "calories": number, "protein": number, "carbs": number, "fat": number}
All numeric values are grams (protein/carbs/fat) or kcal (calories) for the given amount. Use your best nutritional knowledge. If the input isn't a real food, respond with {"name": null}.`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 200,
      }),
    });

    if (!res.ok) {
      console.error(`Groq fallback failed (${res.status}):`, await res.text());
      return null;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.name) return null;

    return {
      id: null,
      name: parsed.name,
      image: null,
      amount,
      unit,
      aiEstimated: true,
      calories: Number(parsed.calories) || 0,
      protein: Number(parsed.protein) || 0,
      carbs: Number(parsed.carbs) || 0,
      fat: Number(parsed.fat) || 0,
    };
  } catch (err) {
    console.error("Groq fallback error:", err);
    return null;
  }
}

// Spoonacular's ingredient search can return a real, existing item that is
// still the WRONG match for a regional/local dish it doesn't actually know
// (e.g. "roti" matching some unrelated bread). That's worse than finding
// nothing, since it looks confident. When Groq is configured, use it as a
// quick sanity check on Tier-1 matches specifically — if it doesn't think
// the match is right, the caller treats it as no match and falls through
// to the rest of the chain (which ends in Groq's own estimate anyway).
// If Groq isn't configured, this defaults to trusting Spoonacular, so
// nothing changes for anyone who hasn't set GROQ_API_KEY.
async function groqValidateMatch(query: string, matchedName: string): Promise<boolean> {
  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) return true;

  const prompt = `A food database matched the search "${query}" to the item "${matchedName}".
Is "${matchedName}" actually a correct, specific match for "${query}"? Be strict — "${query}" may be a regional or local dish/food name that a Western grocery database doesn't really carry, in which case a loosely-similar-sounding item is NOT a correct match.
Respond with ONLY one word: "yes" or "no".`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 5,
      }),
    });
    if (!res.ok) return true; // Validator itself failed — don't block the normal flow over it.

    const data = await res.json();
    const answer = (data?.choices?.[0]?.message?.content || "").trim().toLowerCase();
    return answer.startsWith("y");
  } catch (err) {
    console.error("Groq validation error:", err);
    return true; // Fail open — a broken validator shouldn't break every lookup.
  }
}

// If Groq's response got cut off mid-JSON (hit the token limit before
// finishing the array), a straight JSON.parse throws and we'd otherwise
// lose every recipe in the batch — including the ones that generated
// fine before the cutoff. Recover by trimming back to the last complete
// `}` that closes a recipe object and re-closing the array there.
function parsePossiblyTruncatedArray(raw: string): any[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const lastClose = raw.lastIndexOf("}");
    if (lastClose === -1) return null;
    const truncated = raw.slice(0, lastClose + 1) + "]";
    try {
      const parsed = JSON.parse(truncated);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

// Finds a representative food photo for an AI-generated recipe via Pexels.
// This is a keyword match against Pexels' stock library, NOT a verified
// photo of that exact dish — the caller must mark it as illustrative so
// the UI can be upfront that it may not be a precise match. Silently
// returns null if PEXELS_API_KEY isn't set or the search fails/misses,
// so recipes just fall back to no image (existing behavior) rather than
// breaking the whole result.
async function pexelsSearchImage(query: string): Promise<{ url: string; photographer: string; pageUrl: string } | null> {
  const pexelsKey = Deno.env.get("PEXELS_API_KEY");
  if (!pexelsKey || !query) return null;

  try {
    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", `${query} food dish`);
    url.searchParams.set("per_page", "1");
    url.searchParams.set("orientation", "landscape");

    const res = await fetch(url.toString(), { headers: { Authorization: pexelsKey } });
    if (!res.ok) {
      console.error(`Pexels search failed (${res.status}) for "${query}"`);
      return null;
    }

    const data = await res.json();
    const photo = data?.photos?.[0];
    if (!photo?.src) return null;

    return {
      url: photo.src.medium || photo.src.landscape || photo.src.original,
      photographer: photo.photographer || "Pexels",
      pageUrl: photo.url || "https://www.pexels.com",
    };
  } catch (err) {
    console.error(`Pexels search error for "${query}":`, err);
    return null;
  }
}

// AI fallback for recipe search, used when Spoonacular is unreachable or
// its daily point quota is exhausted (402). Same "not a real database,
// mark it honestly" principle as groqEstimateNutrition: every recipe from
// this path is tagged aiGenerated: true, includes no real image/source
// link, and carries its own ingredients+steps inline (since there's no
// real Spoonacular recipe id to look up later via recipeInfo).
async function groqGenerateRecipes(query: string, diet: string | undefined, intolerances: string | undefined, number: number, cuisine?: string) {
  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) return null;

  const requested = Math.min(number || 6, 6);
  const constraints = [
    diet ? `diet: ${diet}` : null,
    intolerances ? `avoid/allergic to: ${intolerances}` : null,
  ].filter(Boolean).join("; ");

  const cuisineMeta = cuisine ? CUISINE_META[cuisine] : null;
  const cuisineInstruction = cuisineMeta
    ? ` Every recipe must be an authentic, real ${cuisineMeta.label} dish that someone from that region would recognize (for example: ${cuisineMeta.examples}) — not a Western dish with a ${cuisineMeta.label} name attached.`
    : "";

  const prompt = `Suggest ${requested} realistic, distinct recipes matching: "${query || "a healthy meal"}"${constraints ? ` (${constraints})` : ""}.${cuisineInstruction}
Respond with ONLY a JSON array, no other text, no markdown fences, where each item has exactly this shape:
{"title": "recipe name", "summary": "1 short sentence", "readyInMinutes": number, "servings": number, "diets": ["vegetarian", ...] or [], "calories": number, "protein": number, "carbs": number, "fat": number, "ingredients": ["1 cup rice", "2 eggs", ...], "steps": ["Step 1 text", "Step 2 text", ...]}
Keep summaries to one short sentence and steps concise (under 20 words each) so the full response fits comfortably. calories/protein/carbs/fat are per serving. Use your best culinary and nutritional knowledge.`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
        max_tokens: 6000,
      }),
    });
    if (!res.ok) {
      console.error(`Groq recipe fallback failed (${res.status}):`, await res.text());
      return null;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const parsed = parsePossiblyTruncatedArray(cleaned);
    if (!parsed || !parsed.length) return null;
    if (data?.choices?.[0]?.finish_reason === "length") {
      console.error(`Groq recipe fallback: response truncated by max_tokens — recovered ${parsed.length}/${requested} recipes.`);
    }

    return await Promise.all(parsed.map(async (r: any, i: number) => {
      const title = r.title || "Suggested recipe";
      const photo = await pexelsSearchImage(title);
      return {
        id: `ai-${Date.now()}-${i}`,
        title,
        image: photo?.url || null,
        imageIsIllustrative: !!photo,
        imageCredit: photo ? { photographer: photo.photographer, pageUrl: photo.pageUrl } : null,
        readyInMinutes: Number(r.readyInMinutes) || null,
        servings: Number(r.servings) || 1,
        sourceUrl: null,
        summary: r.summary || "",
        diets: Array.isArray(r.diets) ? r.diets : [],
        calories: Math.round(Number(r.calories) || 0),
        protein: Math.round(Number(r.protein) || 0),
        carbs: Math.round(Number(r.carbs) || 0),
        fat: Math.round(Number(r.fat) || 0),
        aiGenerated: true,
        ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
        steps: Array.isArray(r.steps) ? r.steps : [],
      };
    }));
  } catch (err) {
    console.error("Groq recipe fallback error:", err);
    return null;
  }
}

// AI fallback for a single recipe's ingredients/steps — used when a client
// asks for recipeInfo on an AI-generated id (which has no real Spoonacular
// id to look up), or when a real Spoonacular id lookup fails. `title` is
// required in this path since there's nothing else to search by.
async function groqGenerateRecipeDetail(title: string) {
  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey || !title) return null;

  const prompt = `Write a realistic recipe for "${title}".
Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{"ingredients": ["1 cup rice", "2 eggs", ...], "steps": ["Step 1 text", "Step 2 text", ...], "servings": number, "readyInMinutes": number}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 1200,
      }),
    });
    if (!res.ok) {
      console.error(`Groq recipe-detail fallback failed (${res.status}):`, await res.text());
      return null;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.ingredients) && !Array.isArray(parsed.steps)) return null;

    const photo = await pexelsSearchImage(title);

    return {
      id: null,
      title,
      image: photo?.url || null,
      imageIsIllustrative: !!photo,
      imageCredit: photo ? { photographer: photo.photographer, pageUrl: photo.pageUrl } : null,
      servings: Number(parsed.servings) || 1,
      readyInMinutes: Number(parsed.readyInMinutes) || null,
      sourceUrl: null,
      aiGenerated: true,
      ingredients: Array.isArray(parsed.ingredients) ? parsed.ingredients : [],
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    };
  } catch (err) {
    console.error("Groq recipe-detail fallback error:", err);
    return null;
  }
}

// AI fallback for the day meal plan, used when Spoonacular's meal planner
// is unreachable or over quota.
// Cuisines offered by the Diet Planner beyond generic "Any". Spoonacular's
// meal planner endpoint has no cuisine parameter at all, and its recipe
// database only recognizes a fixed cuisine list that doesn't include
// Bangladeshi or Pakistani — so cuisine-specific plans go straight to AI,
// which can name real, authentic dishes instead of relabeled Western ones.
// `spoonacularCuisine` is set only where Spoonacular's own filter actually
// supports it, so the snack search can still try real data first there.
const CUISINE_META: Record<string, { label: string; spoonacularCuisine: string | null; examples: string }> = {
  bangladeshi: { label: "Bangladeshi", spoonacularCuisine: null, examples: "bhuna khichuri, shorshe ilish, chicken bhuna, beef tehari, aloo bhorta with daal and rice, mishti doi" },
  indian: { label: "Indian", spoonacularCuisine: "Indian", examples: "masala dosa, chana masala, palak paneer, chicken biryani, dal tadka, aloo paratha" },
  pakistani: { label: "Pakistani", spoonacularCuisine: null, examples: "chicken karahi, beef nihari, seekh kebab, chicken biryani, daal chawal, paratha with omelette" },
  korean: { label: "Korean", spoonacularCuisine: "Korean", examples: "bibimbap, kimchi jjigae, bulgogi, japchae, doenjang jjigae, gimbap" },
};

async function groqGenerateMealPlan(targetCalories: number, diet: string | undefined, exclude: string | undefined, cuisine?: string) {
  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) return null;

  const constraints = [
    diet ? `diet: ${diet}` : null,
    exclude ? `exclude: ${exclude}` : null,
  ].filter(Boolean).join("; ");

  const cuisineMeta = cuisine ? CUISINE_META[cuisine] : null;
  const cuisineInstruction = cuisineMeta
    ? ` All three meals must be authentic, real ${cuisineMeta.label} dishes that someone from that region would recognize (for example: ${cuisineMeta.examples}) — not Western dishes with a ${cuisineMeta.label} name attached.`
    : "";

  const prompt = `Build one day's meal plan (breakfast, lunch, dinner) totalling approximately ${targetCalories} kcal${constraints ? ` (${constraints})` : ""}.${cuisineInstruction}
Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{"breakfast": {"title": "name", "readyInMinutes": number, "servings": number}, "lunch": {"title": "name", "readyInMinutes": number, "servings": number}, "dinner": {"title": "name", "readyInMinutes": number, "servings": number}, "nutrients": {"calories": number, "protein": number, "carbohydrates": number, "fat": number}}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 500,
      }),
    });
    if (!res.ok) {
      console.error(`Groq meal-plan fallback failed (${res.status}):`, await res.text());
      return null;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.breakfast && !parsed.lunch && !parsed.dinner) return null;

    const toMeal = (m: any) => m ? {
      id: null,
      title: m.title || "Suggested meal",
      image: null,
      readyInMinutes: Number(m.readyInMinutes) || null,
      servings: Number(m.servings) || 1,
      sourceUrl: null,
      aiGenerated: true,
    } : null;

    return {
      meals: [toMeal(parsed.breakfast), toMeal(parsed.lunch), toMeal(parsed.dinner)].filter(Boolean),
      nutrients: parsed.nutrients ? {
        calories: Number(parsed.nutrients.calories) || targetCalories,
        protein: Number(parsed.nutrients.protein) || 0,
        carbohydrates: Number(parsed.nutrients.carbohydrates) || 0,
        fat: Number(parsed.nutrients.fat) || 0,
      } : null,
      aiGenerated: true,
    };
  } catch (err) {
    console.error("Groq meal-plan fallback error:", err);
    return null;
  }
}

// Runs the requested action and returns a plain { status, body } pair
// instead of a Response, so the caller can decide whether to cache it.
async function runAction(action: string, params: Record<string, any>, apiKey: string) {
  switch (action) {
    /* ---------------- Food Tracker & Food Scanner: ingredient lookup ---------------- */
    case "ingredientLookup": {
      const query = (params.query || "").trim();
      if (!query) return { status: 400, body: { ok: false, error: "A food name is required." } };

      const amount = params.amount || 100;
      const unit = params.unit || "grams";

      // Bengali script (and other non-Latin scripts) will never match
      // anything in Spoonacular's English-only ingredient/recipe database —
      // sending it through 3 tiers of guaranteed misses just burns quota
      // and adds delay before landing on AI anyway. Go straight there.
      const isNonLatinScript = /[^\u0000-\u024F\s0-9.,()&/+'-]/.test(query);

      // Food Tracker sends aiOnly:true to skip Spoonacular entirely and use
      // only the Groq estimate — Scanner does not set this and keeps the
      // full Spoonacular-first chain below.
      if (params.aiOnly || isNonLatinScript) {
        const aiResult = await groqEstimateNutrition(query, amount, unit);
        if (aiResult) return { status: 200, body: { ok: true, found: true, result: aiResult } };
        if (params.aiOnly && !Deno.env.get("GROQ_API_KEY")) {
          return { status: 500, body: { ok: false, error: "AI-only nutrition lookup isn't configured yet. Please set GROQ_API_KEY." } };
        }
        return { status: 200, body: { ok: true, found: false } };
      }

      try {
        // Tier 1: try it as a single grocery-style ingredient.
        const direct = await lookupSingleIngredient(query, amount, unit, apiKey);
        if (direct) {
          const confident = await groqValidateMatch(query, direct.name);
          if (confident) {
            return { status: 200, body: { ok: true, found: true, result: direct } };
          }
          console.log(`Tier 1 match "${direct.name}" for "${query}" flagged as likely wrong — falling through.`);
        }

        // Tier 2: compound descriptions like "Roti with vegetable curry" or
        // "rice and dal" — split on connector words and look up each part,
        // then sum the totals.
        const parts = query.split(/\s*(?:,|\+|\bwith\b|\band\b)\s*/i).map((p: string) => p.trim()).filter(Boolean);
        if (parts.length > 1) {
          const looked = await Promise.all(parts.map((p: string) => lookupSingleIngredient(p, amount, unit, apiKey)));
          const resolved = looked.filter(Boolean) as any[];
          if (resolved.length) {
            const combined = resolved.reduce((sum, r) => ({
              calories: sum.calories + r.calories,
              protein: sum.protein + r.protein,
              carbs: sum.carbs + r.carbs,
              fat: sum.fat + r.fat,
            }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

            const unresolved = parts.filter((_: string, i: number) => !looked[i]);
            return {
              status: 200,
              body: {
                ok: true,
                found: true,
                result: {
                  id: null,
                  name: query.charAt(0).toUpperCase() + query.slice(1),
                  image: null,
                  amount,
                  unit,
                  combined: true,
                  parts: resolved.map((r) => r.name),
                  missingParts: unresolved,
                  ...combined,
                },
              },
            };
          }
        }

        // Tier 3: not in the raw-ingredient database at all — likely a
        // regional/composed dish. Fall back to recipe search and use a
        // matching recipe's per-serving nutrition as an estimate. Fetch a
        // few candidates (not just the top one) and validate each, since
        // a loose/misspelled query can rank an unrelated recipe first.
        const recipeMatch = await spoonFetch("/recipes/complexSearch", {
          query,
          number: 5,
          addRecipeNutrition: true,
        }, apiKey);

        for (const r of recipeMatch.results || []) {
          const confident = await groqValidateMatch(query, r.title);
          if (!confident) {
            console.log(`Tier 3 candidate "${r.title}" for "${query}" flagged as likely wrong — trying next.`);
            continue;
          }
          const nutrients = r.nutrition?.nutrients || [];
          return {
            status: 200,
            body: {
              ok: true,
              found: true,
              result: {
                id: r.id,
                name: r.title,
                image: r.image || null,
                amount: r.servings || 1,
                unit: "serving",
                estimated: true,
                sourceUrl: r.sourceUrl || null,
                calories: pickNutrient(nutrients, "Calories"),
                protein: pickNutrient(nutrients, "Protein"),
                carbs: pickNutrient(nutrients, "Carbohydrates"),
                fat: pickNutrient(nutrients, "Fat"),
              },
            },
          };
        }

        // Nothing matched anywhere in Spoonacular — try the AI fallback
        // before giving up entirely.
        const aiResult = await groqEstimateNutrition(query, amount, unit);
        if (aiResult) return { status: 200, body: { ok: true, found: true, result: aiResult } };

        return { status: 200, body: { ok: true, found: false } };
      } catch (spoonacularError) {
        // Spoonacular itself failed (quota exceeded, bad key, etc.) — try
        // the AI fallback rather than failing the whole request. If the
        // fallback isn't configured or also fails, surface the ORIGINAL
        // Spoonacular error, since that's the real cause.
        const aiResult = await groqEstimateNutrition(query, amount, unit).catch(() => null);
        if (aiResult) return { status: 200, body: { ok: true, found: true, result: aiResult } };
        throw spoonacularError;
      }
    }

    /* ---------------- Recipes: search ---------------- */
    case "recipeSearch": {
      const query = (params.query || "").trim();
      const cuisine = params.cuisine && CUISINE_META[params.cuisine] ? params.cuisine : null;
      const cuisineMeta = cuisine ? CUISINE_META[cuisine] : null;

      // Bengali script (and other non-Latin scripts) will never match
      // anything in Spoonacular's English-only recipe database — go
      // straight to AI instead of burning a request on a guaranteed miss.
      const isNonLatinScript = /[^\u0000-\u024F\s0-9.,()&/+'-]/.test(query);

      // Bangladeshi/Pakistani aren't in Spoonacular's supported cuisine
      // list at all, so there's no real data to try — go straight to AI
      // for authentic dishes rather than returning an empty/irrelevant set.
      if (isNonLatinScript || (cuisineMeta && !cuisineMeta.spoonacularCuisine)) {
        const aiResults = await groqGenerateRecipes(query, params.diet, params.intolerances, params.number || 12, cuisine || undefined);
        if (aiResults) return { status: 200, body: { ok: true, results: aiResults, aiGenerated: true } };
        return { status: 200, body: { ok: true, results: [] } };
      }

      try {
        const data = await spoonFetch("/recipes/complexSearch", {
          query,
          diet: params.diet,
          intolerances: params.intolerances,
          cuisine: cuisineMeta?.spoonacularCuisine || undefined,
          number: params.number || 12,
          addRecipeInformation: true,
          addRecipeNutrition: true,
          sort: query ? undefined : "popularity",
        }, apiKey);

        const results = (data.results || []).map((r: any) => {
          const nutrients = r.nutrition?.nutrients || [];
          return {
            id: r.id,
            title: r.title,
            image: r.image,
            readyInMinutes: r.readyInMinutes,
            servings: r.servings,
            sourceUrl: r.sourceUrl,
            summary: (r.summary || "").replace(/<[^>]*>/g, "").slice(0, 220),
            diets: r.diets || [],
            calories: Math.round(pickNutrient(nutrients, "Calories")),
            protein: Math.round(pickNutrient(nutrients, "Protein")),
            carbs: Math.round(pickNutrient(nutrients, "Carbohydrates")),
            fat: Math.round(pickNutrient(nutrients, "Fat")),
          };
        });

        // A real Spoonacular query (not empty, not falling back already)
        // that comes back with zero matches is very often a local/regional
        // dish Spoonacular's Western database just doesn't carry, not
        // proof nothing exists — e.g. "shorshe ilish" or "khichuri" will
        // legitimately 200 with an empty array. Treat that the same as an
        // error for fallback purposes; only report "nothing found" if AI
        // isn't configured or also can't produce anything.
        if (!results.length && (query || cuisineMeta)) {
          const aiResults = await groqGenerateRecipes(query, params.diet, params.intolerances, params.number || 12, cuisine || undefined);
          if (aiResults) return { status: 200, body: { ok: true, results: aiResults, aiGenerated: true } };

          // Spoonacular had nothing AND the AI fallback produced nothing.
          // Distinguish "AI wasn't configured" from "AI tried and failed"
          // so the client can show an actionable message instead of a
          // generic "no match" that looks like a normal empty search.
          if (!Deno.env.get("GROQ_API_KEY")) {
            return {
              status: 200,
              body: {
                ok: true,
                results: [],
                aiUnavailable: true,
                aiUnavailableReason: "GROQ_API_KEY is not configured, so local/regional dishes that Spoonacular doesn't carry can't fall back to AI suggestions.",
              },
            };
          }
        }

        return { status: 200, body: { ok: true, results } };
      } catch (spoonacularError) {
        // Spoonacular itself failed (quota exceeded, bad key, down, etc.)
        // — generate recipe suggestions with AI instead of failing outright.
        const aiResults = await groqGenerateRecipes(query, params.diet, params.intolerances, params.number || 12, cuisine || undefined).catch(() => null);
        if (aiResults) return { status: 200, body: { ok: true, results: aiResults, aiGenerated: true } };
        if (!Deno.env.get("GROQ_API_KEY")) {
          const message = spoonacularError instanceof Error ? spoonacularError.message : String(spoonacularError);
          return { status: 200, body: { ok: false, error: `${message} (AI fallback unavailable: GROQ_API_KEY is not configured.)` } };
        }
        throw spoonacularError;
      }
    }

    /* ---------------- Recipes: full detail (ingredients + steps) ---------------- */
    case "recipeInfo": {
      if (!params.id) return { status: 400, body: { ok: false, error: "A recipe id is required." } };

      // AI-generated recipes (from recipeSearch's AI fallback) use ids like
      // "ai-<timestamp>-<index>" and have no real Spoonacular recipe to
      // fetch. If the client already has the ingredients/steps (it does —
      // groqGenerateRecipes includes them inline) it won't normally even
      // call this action for them, but handle it gracefully either way: if
      // a title was sent along, regenerate the detail with AI.
      if (String(params.id).startsWith("ai-")) {
        const aiDetail = await groqGenerateRecipeDetail(params.title);
        if (aiDetail) return { status: 200, body: { ok: true, result: aiDetail } };
        return { status: 400, body: { ok: false, error: "This is an AI-suggested recipe without a saved detail — please re-search to see its ingredients and steps." } };
      }

      try {
        const r = await spoonFetch(`/recipes/${params.id}/information`, { includeNutrition: false }, apiKey);
        const steps = r.analyzedInstructions?.[0]?.steps?.map((s: any) => s.step) || [];
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              id: r.id,
              title: r.title,
              image: r.image,
              servings: r.servings,
              readyInMinutes: r.readyInMinutes,
              sourceUrl: r.sourceUrl,
              ingredients: (r.extendedIngredients || []).map((i: any) => i.original),
              steps,
            },
          },
        };
      } catch (spoonacularError) {
        // Spoonacular failed — if we at least know the title, ask AI for a
        // plausible ingredients/steps list instead of a hard failure.
        const aiDetail = params.title ? await groqGenerateRecipeDetail(params.title).catch(() => null) : null;
        if (aiDetail) return { status: 200, body: { ok: true, result: aiDetail } };
        throw spoonacularError;
      }
    }

    /* ---------------- Personalized Diet Plan ---------------- */
    case "mealPlan": {
      const targetCalories = params.targetCalories || 2000;
      const cuisine = params.cuisine && CUISINE_META[params.cuisine] ? params.cuisine : null;

      // Spoonacular's /mealplanner/generate endpoint has no cuisine
      // parameter at all — it would just return generic Western dishes
      // regardless, which isn't an honest "Bangladeshi/Pakistani/etc. diet
      // plan". Go straight to AI for these so the dishes are actually real.
      if (cuisine) {
        if (!Deno.env.get("GROQ_API_KEY")) {
          return {
            status: 200,
            body: {
              ok: false,
              error: `${CUISINE_META[cuisine].label} diet plans need AI generation (Spoonacular's meal planner doesn't support cuisine filtering), and GROQ_API_KEY isn't configured on this server yet. Ask your admin to run "supabase secrets set GROQ_API_KEY=your-groq-key" and redeploy the "spoonacular" function.`,
            },
          };
        }
        const aiPlan = await groqGenerateMealPlan(targetCalories, params.diet, params.exclude, cuisine).catch(() => null);
        if (aiPlan) return { status: 200, body: { ok: true, meals: aiPlan.meals, nutrients: aiPlan.nutrients, aiGenerated: true } };
        return { status: 200, body: { ok: false, error: `Couldn't generate a ${CUISINE_META[cuisine].label} diet plan right now. Please try again in a moment.` } };
      }

      try {
        const data = await spoonFetch("/mealplanner/generate", {
          timeFrame: "day",
          targetCalories,
          diet: params.diet,
          exclude: params.exclude,
        }, apiKey);

        const meals = (data.meals || []).map((m: any) => ({
          id: m.id,
          title: m.title,
          image: m.id ? `https://img.spoonacular.com/recipes/${m.id}-312x231.jpg` : null,
          readyInMinutes: m.readyInMinutes,
          servings: m.servings,
          sourceUrl: m.sourceUrl,
        }));

        return { status: 200, body: { ok: true, meals, nutrients: data.nutrients || null } };
      } catch (spoonacularError) {
        // Spoonacular's meal planner failed (quota exceeded, down, etc.)
        // — build the day's plan with AI instead of failing the whole
        // "Generate Diet Plan" flow.
        const aiPlan = await groqGenerateMealPlan(targetCalories, params.diet, params.exclude).catch(() => null);
        if (aiPlan) return { status: 200, body: { ok: true, meals: aiPlan.meals, nutrients: aiPlan.nutrients, aiGenerated: true } };
        throw spoonacularError;
      }
    }

    /* ---------------- Food Scanner: image upload (not cached — binary input) ---------------- */
    case "imageAnalyze": {
      if (!params.imageBase64) return { status: 400, body: { ok: false, error: "An image is required." } };

      const base64 = String(params.imageBase64).split(",").pop() as string;
      const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append("file", new Blob([binary], { type: params.mimeType || "image/jpeg" }), "upload.jpg");

      const url = new URL(BASE + "/food/images/analyze");
      url.searchParams.set("apiKey", apiKey);
      const res = await fetch(url.toString(), { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        return { status: res.status, body: { ok: false, error: data?.message || "Image analysis failed." } };
      }

      return {
        status: 200,
        body: {
          ok: true,
          result: {
            category: data.category?.name?.replace(/_/g, " ") || "Unknown",
            probability: data.category?.probability || null,
            calories: data.nutrition?.calories?.value || null,
            protein: data.nutrition?.protein?.value || null,
            carbs: data.nutrition?.carbs?.value || null,
            fat: data.nutrition?.fat?.value || null,
          },
        },
      };
    }

    default:
      return { status: 400, body: { ok: false, error: `Unknown action: ${action}` } };
  }
}

// Whether a successful response is actually "nothing useful" — a cached
// empty result is worse than no cache at all, since it would keep serving
// "not found" instead of retrying (and this time maybe succeeding via the
// AI fallback). Used both to skip writing these to the cache, and to skip
// reading a stale one that predates this check (self-healing old rows).
function isEmptyResult(action: string, body: any): boolean {
  if (!body || body.ok === false) return true;
  if (action === "recipeSearch") return !body.results?.length;
  if (action === "ingredientLookup") return body.found === false;
  if (action === "mealPlan") return !body.meals?.length;
  return false;
}

Deno.serve(async (req) => {
  // Browsers send a CORS preflight OPTIONS request before the real POST.
  // It must return 200 with these headers or the browser blocks the actual call.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    const apiKey = Deno.env.get("SPOONACULAR_API_KEY");
    if (!apiKey) {
      console.error("SPOONACULAR_API_KEY is not configured.");
      return json({ ok: false, error: "Spoonacular is not configured yet. Please set SPOONACULAR_API_KEY." }, 500);
    }

    const body = await req.json();
    const action = body?.action;
    const params = body?.params || {};

    const cacheable = CACHEABLE_ACTIONS.has(action);
    const cacheKey = cacheable ? cacheKeyFor(action, params) : null;

    if (cacheKey) {
      const cached = await getCached(cacheKey);
      // Skip (not just don't-trust) a cached empty/not-found result — treat
      // it exactly like a miss so the request re-runs for real, including
      // the AI fallback. This also self-heals any stale empty rows written
      // before this check existed, without needing a manual DB cleanup.
      //
      // Also skip (never trust) a cached AI-generated result. The cache's
      // whole purpose is protecting Spoonacular's metered quota — AI
      // results never touched that quota, so there's nothing to protect by
      // caching them. Worse, trusting an old AI-generated cache entry means
      // any change to how we generate those results (e.g. adding Pexels
      // images) stays invisible for up to an hour behind stale entries
      // written before the change. Always regenerate AI results fresh.
      if (cached && !isEmptyResult(action, cached) && !cached.aiGenerated) {
        return json({ ...cached, cached: true });
      }
    }

    const { status, body: resultBody } = await runAction(action, params, apiKey);

    if (cacheKey && status === 200 && !isEmptyResult(action, resultBody) && !resultBody.aiGenerated) {
      await setCached(cacheKey, resultBody);
    }

    return json(resultBody, status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Spoonacular proxy error:", message);
    return json({ ok: false, error: message }, 500);
  }
});
