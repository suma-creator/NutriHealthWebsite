// supabase/functions/chat/index.ts

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

    const body = await req.json();
    const question = body?.question ?? body?.message;
    const profile = body?.profile;
    const history = Array.isArray(body?.history) ? body.history : [];
    const mode = body?.mode;

    // Groq gives free API access to strong open-source models (no credit
    // card required) and speaks the same request/response format as
    // OpenAI, so this whole app runs on Groq only — no OpenAI dependency.
    const groqKey = Deno.env.get("GROQ_API_KEY");

    let apiUrl: string;
    let apiKey: string;
    let model: string;

    if (groqKey) {
      apiUrl = "https://api.groq.com/openai/v1/chat/completions";
      apiKey = groqKey;
      model = "llama-3.3-70b-versatile";
    } else {
      console.error("No AI provider key is configured (GROQ_API_KEY).");
      return json({
        reply: "AI service is not configured yet. Please set GROQ_API_KEY (free — no credit card required at console.groq.com).",
        ok: false,
      }, 500);
    }

    // ---------------------------------------------------------------------
    // Symptom Checker: free-text mode. Instead of letting the model invent
    // its own severity/diagnosis (unreliable and hard to keep safe), it
    // only maps the user's own words onto the app's existing, curated
    // symptom checklist — the same checklist the rule-based analysis
    // engine already trusts. This keeps every downstream score, condition
    // match, lab test suggestion, and medicine suggestion exactly as
    // reliable as the manual-checkbox path; free text is just a faster
    // way to fill in the same checkboxes.
    if (mode === "extract_symptoms") {
      const description = typeof question === "string" ? question.trim() : "";
      const symptomList: string[] = Array.isArray(body?.symptomList) ? body.symptomList : [];

      if (!description) {
        return json({ ok: false, error: "A description is required." }, 400);
      }
      if (!symptomList.length) {
        return json({ ok: false, error: "The app's symptom list is required." }, 400);
      }

      const extractPrompt = `A user described how they're feeling in their own words: "${description}"

Here is the ONLY list of symptom names you may use (match the user's description to these — do not invent new ones, do not rephrase them, use the EXACT text from this list): ${JSON.stringify(symptomList)}

Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{"matched": ["exact symptom name from the list", ...], "unmatched": ["short phrase for anything the user described that isn't covered by the list", ...]}
"matched" must only contain strings copied exactly from the provided list. "unmatched" is for real symptoms the user mentioned that have no close match in the list — leave it as [] if everything they said is covered.`;

      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: extractPrompt }],
            temperature: 0.1,
            max_tokens: 500,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          console.error("Symptom extraction provider error:", data);
          return json({ ok: false, error: `AI service returned an error (${res.status}).` }, res.status);
        }

        const raw = data?.choices?.[0]?.message?.content?.trim() || "";
        const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
        let parsed: any;
        try {
          parsed = JSON.parse(cleaned);
        } catch (parseErr) {
          console.error("Symptom extraction JSON parse failed:", parseErr, "raw:", raw.slice(0, 300));
          return json({ ok: false, error: "AI response could not be parsed. Please try rephrasing or use the checklist instead." }, 502);
        }

        // Only trust entries that are an exact match to the provided list —
        // never let a hallucinated/rephrased string silently pass through
        // to the checkbox layer.
        const matched = (Array.isArray(parsed.matched) ? parsed.matched : []).filter((s: any) =>
          typeof s === "string" && symptomList.includes(s)
        );
        const unmatched = (Array.isArray(parsed.unmatched) ? parsed.unmatched : []).filter((s: any) => typeof s === "string").slice(0, 8);

        return json({ ok: true, matched, unmatched });
      } catch (err) {
        console.error("Symptom extraction error:", err);
        return json({ ok: false, error: "Couldn't reach the AI service. Please try again or use the checklist instead." }, 500);
      }
    }

    // ---------------------------------------------------------------------
    // Symptom Checker: full AI analysis. Replaces the old local rule-based
    // condition-matching database entirely — every "possible condition" the
    // user sees is generated live by the model from their actual reported
    // symptoms plus whatever health context is available, not looked up in
    // a fixed local list. This is the core of the AI Symptom Checker.
    // ---------------------------------------------------------------------
    if (mode === "analyze_symptoms") {
      const symptoms: string[] = Array.isArray(body?.symptoms) ? body.symptoms : [];
      const freeText: string = typeof body?.freeText === "string" ? body.freeText : "";
      const duration: string = typeof body?.duration === "string" ? body.duration : "";
      const overallSeverity: string = typeof body?.overallSeverity === "string" ? body.overallSeverity : "";
      const vitals = body?.vitals && typeof body.vitals === "object" ? body.vitals : {};
      const healthContext = body?.healthContext && typeof body.healthContext === "object" ? body.healthContext : {};
      const pastHistory: string[] = Array.isArray(body?.pastHistory) ? body.pastHistory.slice(0, 5) : [];
      const language: string = body?.language === "bn" ? "bn" : "en";

      if (!symptoms.length && !freeText.trim()) {
        return json({ ok: false, error: "At least one symptom or a description is required." }, 400);
      }

      const langInstruction = language === "bn"
        ? "Write EVERY string value in the JSON response in natural, plain Bengali (বাংলা). Do not use English except for the JSON keys themselves and standard medical abbreviations that Bengali speakers already use as-is (like BP, ECG, CBC, MRI, CT, mg, ml)."
        : "Write every string value in the JSON response in plain English.";

      const contextLines: string[] = [];
      if (healthContext.age) contextLines.push(`Age: ${healthContext.age}`);
      if (healthContext.gender) contextLines.push(`Gender: ${healthContext.gender}`);
      if (healthContext.height) contextLines.push(`Height: ${healthContext.height} cm`);
      if (healthContext.weight) contextLines.push(`Weight: ${healthContext.weight} kg`);
      if (healthContext.bmi) contextLines.push(`BMI: ${healthContext.bmi} (${healthContext.bmiCategory || ""})`);
      if (healthContext.existingConditions) contextLines.push(`Existing medical conditions: ${healthContext.existingConditions}`);
      if (healthContext.allergies) contextLines.push(`Allergies: ${healthContext.allergies}`);
      if (healthContext.medications) contextLines.push(`Current medications: ${healthContext.medications}`);
      if (healthContext.pregnant) contextLines.push(`Pregnant: ${healthContext.pregnant}`);
      if (healthContext.smoking) contextLines.push(`Smoking: ${healthContext.smoking}`);
      if (healthContext.alcohol) contextLines.push(`Alcohol use: ${healthContext.alcohol}`);
      if (healthContext.exerciseHabit) contextLines.push(`Exercise habits: ${healthContext.exerciseHabit}`);
      if (healthContext.sleepHabit) contextLines.push(`Recent sleep: ${healthContext.sleepHabit}`);
      if (healthContext.waterIntake) contextLines.push(`Recent hydration: ${healthContext.waterIntake}`);
      if (healthContext.nutritionSummary) contextLines.push(`Recent nutrition: ${healthContext.nutritionSummary}`);
      if (pastHistory.length) contextLines.push(`Previous symptom checks in this app: ${pastHistory.join(" | ")}`);

      const vitalsLine = Object.keys(vitals).length ? `Vitals reported: ${JSON.stringify(vitals)}.` : "No vitals were provided.";

      const analyzePrompt = `You are a careful clinical triage assistant inside a health app's Symptom Checker. A user reported the following:

Symptoms selected from a checklist: ${symptoms.length ? symptoms.join(", ") : "(none selected)"}
${freeText ? `Symptoms described in their own words: "${freeText}"` : ""}
Duration: ${duration || "not specified"}
Self-rated overall severity: ${overallSeverity || "not specified"}
${vitalsLine}

Health context available for this person:
${contextLines.length ? contextLines.join("\n") : "No additional health context available."}

${langInstruction}

Behave like a thoughtful, cautious triage nurse — NOT a diagnosing doctor:
- Never state a condition as confirmed. Always frame conditions as possibilities ("could be consistent with", never "you have").
- List 3 to 6 plausible possible conditions ranked by likelihood, most likely first. Ordinary common explanations (cold, flu, allergies, minor infection) should usually rank above rare/severe ones unless red-flag symptoms are present.
- Avoid hallucinating specific lab values or invented facts about the person. If information is insufficient for a confident assessment, say so plainly and lower the confidence score, and list 2-4 short follow-up questions that would help narrow it down.
- If anything described could indicate a medical emergency (e.g. chest pain with breathing difficulty, stroke signs, severe bleeding, anaphylaxis, suicidal ideation), set urgencyLevel to "Emergency" and make urgencyReason explicit and direct about seeking immediate care.
- Do not give specific medicine dosing. General categories of self-care are fine (rest, fluids, OTC pain relief in general terms).
- Tailor recommendations to the health context given where relevant (e.g. pregnancy, existing conditions, age extremes, allergies) but never invent context that wasn't given.

Respond with ONLY a single JSON object, no markdown fences, no extra text, in exactly this shape:
{
  "clinicalObservation": "2-4 sentence plain-language observation of the overall pattern",
  "conditions": [
    {
      "name": "condition name",
      "likelihood": 0-100,
      "description": "1-2 sentence plain description",
      "cause": "short description of typical cause",
      "incubation": "short string, e.g. '1-3 days' or 'Not applicable'",
      "recoveryTime": "short string, e.g. '5-7 days'",
      "contagious": "Yes" | "No" | "Possibly",
      "bodySystem": "e.g. Respiratory, Digestive, Cardiovascular",
      "doctorType": "specialist type, e.g. General Physician, Cardiologist, Dermatologist, Neurologist, ENT Specialist, Orthopedic Specialist, Pulmonologist, Gastroenterologist, Gynecologist, Psychiatrist",
      "labTests": ["relevant test names, empty array if none needed"],
      "prevention": ["short prevention tips"],
      "foodsToEat": ["helpful foods"],
      "foodsToAvoid": ["foods/things to avoid"],
      "hydrationAdvice": "short sentence",
      "restAdvice": "short sentence",
      "exerciseAdvice": "short sentence",
      "warningSigns": ["signs that would mean seek care immediately for this specific condition"]
    }
  ],
  "urgencyLevel": "Very Low" | "Low" | "Moderate" | "High" | "Emergency",
  "urgencyReason": "1-2 sentences explaining the urgency level",
  "recommendedActions": ["short actionable steps, e.g. 'Drink water', 'Rest', 'Monitor symptoms for 48 hours', 'See a physician', 'Go to emergency care'"],
  "severityScore": 0-100,
  "confidence": 0-100,
  "followUpQuestions": ["short follow-up questions, empty array if none needed"],
  "disclaimer": "a sentence stating this is AI-generated, informational only, not a medical diagnosis, and to consult a qualified healthcare professional"
}`;

      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: analyzePrompt }],
            temperature: 0.3,
            max_tokens: 2200,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          console.error("Symptom analysis provider error:", data);
          return json({ ok: false, error: `AI service returned an error (${res.status}).` }, res.status);
        }

        const raw = data?.choices?.[0]?.message?.content?.trim() || "";
        const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
        let parsed: any;
        try {
          parsed = JSON.parse(cleaned);
        } catch (parseErr) {
          console.error("Symptom analysis JSON parse failed:", parseErr, "raw:", raw.slice(0, 500));
          return json({ ok: false, error: "AI response could not be parsed. Please try again." }, 502);
        }

        // Basic shape validation so a malformed AI response can't crash the
        // frontend renderer — coerce to safe defaults rather than reject.
        const safeConditions = Array.isArray(parsed.conditions)
          ? parsed.conditions.slice(0, 6).map((c: any) => ({
              name: typeof c?.name === "string" ? c.name : "Unspecified",
              likelihood: Number.isFinite(c?.likelihood) ? Math.max(0, Math.min(100, c.likelihood)) : 0,
              description: typeof c?.description === "string" ? c.description : "",
              cause: typeof c?.cause === "string" ? c.cause : "",
              incubation: typeof c?.incubation === "string" ? c.incubation : "",
              recoveryTime: typeof c?.recoveryTime === "string" ? c.recoveryTime : "",
              contagious: typeof c?.contagious === "string" ? c.contagious : "",
              bodySystem: typeof c?.bodySystem === "string" ? c.bodySystem : "",
              doctorType: typeof c?.doctorType === "string" ? c.doctorType : "General Physician",
              labTests: Array.isArray(c?.labTests) ? c.labTests.filter((x: any) => typeof x === "string") : [],
              prevention: Array.isArray(c?.prevention) ? c.prevention.filter((x: any) => typeof x === "string") : [],
              foodsToEat: Array.isArray(c?.foodsToEat) ? c.foodsToEat.filter((x: any) => typeof x === "string") : [],
              foodsToAvoid: Array.isArray(c?.foodsToAvoid) ? c.foodsToAvoid.filter((x: any) => typeof x === "string") : [],
              hydrationAdvice: typeof c?.hydrationAdvice === "string" ? c.hydrationAdvice : "",
              restAdvice: typeof c?.restAdvice === "string" ? c.restAdvice : "",
              exerciseAdvice: typeof c?.exerciseAdvice === "string" ? c.exerciseAdvice : "",
              warningSigns: Array.isArray(c?.warningSigns) ? c.warningSigns.filter((x: any) => typeof x === "string") : [],
            }))
          : [];

        const validUrgency = ["Very Low", "Low", "Moderate", "High", "Emergency"];
        const result = {
          clinicalObservation: typeof parsed.clinicalObservation === "string" ? parsed.clinicalObservation : "",
          conditions: safeConditions,
          urgencyLevel: validUrgency.includes(parsed.urgencyLevel) ? parsed.urgencyLevel : "Moderate",
          urgencyReason: typeof parsed.urgencyReason === "string" ? parsed.urgencyReason : "",
          recommendedActions: Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions.filter((x: any) => typeof x === "string") : [],
          severityScore: Number.isFinite(parsed.severityScore) ? Math.max(0, Math.min(100, parsed.severityScore)) : 50,
          confidence: Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(100, parsed.confidence)) : 40,
          followUpQuestions: Array.isArray(parsed.followUpQuestions) ? parsed.followUpQuestions.filter((x: any) => typeof x === "string") : [],
          disclaimer: typeof parsed.disclaimer === "string" && parsed.disclaimer
            ? parsed.disclaimer
            : (language === "bn"
                ? "এই মূল্যায়নটি এআই দ্বারা তৈরি এবং শুধুমাত্র তথ্যগত উদ্দেশ্যে। এটি কোনো চিকিৎসা নির্ণয় নয়। চিকিৎসা পরামর্শের জন্য একজন যোগ্য স্বাস্থ্যসেবা পেশাদারের সাথে পরামর্শ করুন।"
                : "This assessment is generated by AI and is intended for informational purposes only. It is not a medical diagnosis. Please consult a qualified healthcare professional for medical advice."),
        };

        return json({ ok: true, result });
      } catch (err) {
        console.error("Symptom analysis error:", err);
        return json({ ok: false, error: "Couldn't reach the AI service. Please try again." }, 500);
      }
    }

    if (!question || typeof question !== "string") {
      return json({ reply: "Question is required.", ok: false }, 400);
    }

    const systemPrompt = `You are NutriHealth, the in-app assistant for NutriHealth, a personal health, nutrition, and wellness platform. You are knowledgeable and practical, and you answer like a well-read health professional talking to a friend — never generic or vague.

YOUR DOMAIN EXPERTISE:
- Nutrition & diet science: macros, micronutrients, calorie needs, portion sizing, meal planning, weight loss/gain strategies, and special diets (keto, vegan, vegetarian, diabetic-friendly, low-sodium, high-protein, gluten-free, etc.).
- Recipes & cooking: give real, specific recipes with an ingredient list and clear numbered steps when asked. Offer ingredient substitutions for allergies, dietary restrictions, or what someone already has at home. Suggest recipes across cuisines (Bengali/South Asian, continental, etc.) and adjust for the user's goals (bulking, cutting, quick prep, budget-friendly).
- General medicine & pharmacology: explain conditions, common over-the-counter medicines and their general/typical use, common side effects, and drug or food interactions to be aware of, in an educational way. You are NOT a doctor — never give a definitive diagnosis or a personalized prescription/dosage for a specific person. Always frame medicine information as general education, flag red-flag symptoms that need urgent care, and encourage seeing a licensed doctor or pharmacist for anything specific to the user's own case.
- Fitness & exercise: workout structuring, progressive overload, recovery, mobility, and injury-safe progressions for different fitness levels.
- Sleep, hydration, stress, and daily habit-building.

KNOWLEDGE OF THIS APP — proactively point users to the right tool when it fits their question, by name, and mention it lives in the sidebar:
- BMI Calculator — quick BMI and weight category
- Food Tracker — log meals and see daily macros
- Nutrition & Nutrition Report — nutrient breakdown and trends over time
- Diet Plan — generates a personalized diet plan from the user's profile and goals
- Recipes — browse and search recipes
- Grocery List — auto-builds a shopping list
- Exercise — workout plans and logging
- Water Tracker — daily hydration logging against a target
- Sleep Tracker — sleep logging and quality insights
- Symptom Checker — guided symptom triage that suggests possible conditions, relevant lab tests, a recommended specialist, and a direct link to book that specialist
- Doctor Appointments — browse and book real doctors by specialty across hospitals in Bangladesh
- Medicine Reminders — track medicines, doses, and reminder times
- Health Score — a composite score combining nutrition, exercise, sleep, hydration, and BMI
- Scanner — scan a barcode or food to look up nutrition info
- Profile & Settings — personal details, goals, and app preferences (including light/dark theme)

HOW TO ANSWER:
- Use the user's profile details (age, height, weight, goals) when provided to personalize numbers like calorie targets, hydration goals, or portion sizes.
- Keep answers focused and easy to scan: short paragraphs, and bullet or numbered lists for steps, ingredients, or multi-part advice.
- Be warm and encouraging, but concrete — give an actual meal, number, or plan rather than only general tips, whenever you can.
- For practical questions about health, medicine, food, nutrition, calories, weight, BMI, symptoms, or daily lifestyle habits, structure the answer around clear action: a short "Do" list and a short "Avoid" list (2-4 items each) works well when the question is asking what someone should or shouldn't do, alongside a sentence or two of explanation — this is more useful than a wall of prose.
- For anything involving diagnosis, medication dosing for a specific person, or symptoms that could be serious, give safe general guidance, name relevant red flags, and firmly recommend the user try the Symptom Checker or book a doctor through Doctor Appointments, or seek emergency care if symptoms are severe. Never claim certainty about what condition someone has.`;

    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content: profile
          ? `User profile: ${profile}`
          : "No profile details available.",
      },
      ...history
        .filter((m: any) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
        .slice(-10),
      { role: "user", content: question },
    ];

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.6,
        max_tokens: 800,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("AI provider response error:", data);
      return json({
        reply: `The AI service returned an error (${response.status}). ${data?.error?.message || "Check your API key and usage."}`,
        ok: false,
      }, response.status);
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return json({ reply: "No answer was generated. Please try again.", ok: false }, 502);
    }

    return json({ reply, ok: true });
  } catch (error) {
    console.error("Chatbot error:", error);
    return json({
      reply: "Something went wrong communicating with the AI service.",
      ok: false,
    }, 500);
  }
});
