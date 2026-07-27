// supabase/functions/food-vision/index.ts
// Takes a base64 food photo and asks a vision-capable AI model to identify
// the dish and estimate its nutrition. Returns strict JSON so the client
// can drop it straight into the same result UI as the text-based scanner.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// Pulls the first {...} JSON object out of a model reply, in case it
// wrapped the JSON in markdown fences or added a sentence around it.
function extractJson(text: string): any | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are a nutrition vision assistant. Look at the photo of food and identify what it is, then estimate its nutrition for one typical serving as you see it in the photo.

Respond with ONLY a single JSON object, no other text, in exactly this shape:
{
  "food_name": "short, natural name of the dish/food, Title Case",
  "serving_estimate": "short description of the portion you estimated, e.g. '1 plate (approx 350g)'",
  "calories": <integer, kcal for that portion>,
  "protein_g": <number, grams>,
  "carbs_g": <number, grams>,
  "fat_g": <number, grams>,
  "confidence": "high" | "medium" | "low",
  "note": "one short sentence with any caveat (e.g. mixed dish, hidden oil/sauce, hard to judge portion size)"
}

If the photo does not clearly show food, set "food_name" to "Unrecognized" and explain briefly in "note", with calories/protein_g/carbs_g/fat_g all 0.
Never include markdown, backticks, or any text outside the JSON object.`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Transient = worth retrying/falling back on (model overloaded, rate
// limited, upstream hiccup). Non-transient (bad key, bad request) fails
// immediately instead of wasting retries.
function isTransient(status: number) {
  return status === 503 || status === 429 || status === 502 || status === 504;
}

type Provider = { name: string; apiUrl: string; apiKey: string; model: string; extraBody?: Record<string, unknown> };

// Calls one provider, retrying on transient errors (like Groq's "model
// currently over capacity" 503) with exponential backoff before giving up
// on that provider entirely.
async function callVisionProvider(provider: Provider, image: string, maxAttempts = 4) {
  let lastError: { status: number; message: string } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(provider.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Identify this food and estimate its nutrition." },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: 700,
        ...provider.extraBody,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return { ok: true as const, data };
    }

    const data = await response.json().catch(() => null);
    const message = data?.error?.message || `HTTP ${response.status}`;
    lastError = { status: response.status, message };
    console.error(`${provider.name} vision error (attempt ${attempt}/${maxAttempts}):`, response.status, message);

    // Only retry transient errors, and only if we have attempts left.
    if (!isTransient(response.status) || attempt === maxAttempts) break;

    // Exponential backoff with jitter: ~600ms, ~1200ms, ~2400ms, ~4800ms (+/-20%)
    const base = 600 * 2 ** (attempt - 1);
    const jitter = base * (0.8 + Math.random() * 0.4);
    await sleep(jitter);
  }

  return { ok: false as const, error: lastError! };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    const body = await req.json();
    const image = body?.image; // data URL, e.g. "data:image/jpeg;base64,...."

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return json({ ok: false, error: "A photo is required." }, 400);
    }

    const groqKey = Deno.env.get("GROQ_API_KEY");

    if (!groqKey) {
      console.error("No AI provider key is configured (GROQ_API_KEY).");
      return json({
        ok: false,
        error: "AI photo scanning isn't configured yet. Please set GROQ_API_KEY (free — no credit card required at console.groq.com).",
      }, 500);
    }

    // Retries transient errors (e.g. a Groq 503 "model currently over
    // capacity") with backoff before giving up — see callVisionProvider.
    const providers: Provider[] = [
      {
        name: "Groq",
        apiUrl: "https://api.groq.com/openai/v1/chat/completions",
        apiKey: groqKey,
        // Groq's current vision-capable chat model. (llama-4-scout was
        // deprecated — qwen3.6-27b is Groq's sole supported vision model as
        // of this writing. Check https://console.groq.com/docs/vision if
        // this starts failing consistently rather than intermittently.)
        model: "qwen/qwen3.6-27b",
        // qwen3.6-27b is a reasoning model — it defaults to "thinking mode"
        // and emits reasoning tokens before its actual answer. Combined
        // with strict response_format:"json_object", that trips Groq's own
        // JSON validator (400 "Failed to validate JSON") because the raw
        // completion isn't pure JSON. Fix: turn reasoning off entirely
        // (we don't need it for a quick classification) and, as a second
        // safety net, tell Groq to hide any reasoning tokens rather than
        // interleave them with the answer. No response_format here — we
        // parse the JSON out of the raw text ourselves (extractJson below),
        // which is more forgiving than Groq's strict validator.
        extraBody: { reasoning_effort: "none", reasoning_format: "hidden" },
      },
    ];

    let lastFailure: { status: number; message: string } | null = null;

    for (const provider of providers) {
      const result = await callVisionProvider(provider, image);

      if (!result.ok) {
        lastFailure = result.error;
        continue; // try the next provider, if any
      }

      const raw = result.data?.choices?.[0]?.message?.content?.trim();
      if (!raw) {
        lastFailure = { status: 502, message: "No answer was generated." };
        continue;
      }

      const parsed = extractJson(raw);
      if (!parsed || typeof parsed.food_name !== "string") {
        console.error(`Could not parse ${provider.name} vision JSON:`, raw);
        lastFailure = { status: 502, message: "Couldn't understand the AI's response." };
        continue;
      }

      return json({
        ok: true,
        result: {
          food_name: parsed.food_name,
          serving_estimate: parsed.serving_estimate || "1 serving (estimated)",
          calories: Number(parsed.calories) || 0,
          protein_g: Number(parsed.protein_g) || 0,
          carbs_g: Number(parsed.carbs_g) || 0,
          fat_g: Number(parsed.fat_g) || 0,
          confidence: parsed.confidence || "medium",
          note: parsed.note || "",
        },
      });
    }

    // Every provider (after retries) failed.
    const status = lastFailure?.status && lastFailure.status >= 400 ? lastFailure.status : 503;
    return json({
      ok: false,
      error: isTransient(status)
        ? "The AI photo service is temporarily overloaded. Please try again in a moment."
        : `The AI photo service returned an error (${status}). ${lastFailure?.message || "Please try again."}`,
    }, status);
  } catch (error) {
    console.error("Food vision error:", error);
    return json({ ok: false, error: "Something went wrong analyzing the photo." }, 500);
  }
});
