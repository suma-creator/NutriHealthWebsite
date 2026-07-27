import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// This assistant is a conversational triage helper, not a diagnostic tool.
// Every rule below exists to keep it from overstepping into confident
// medical claims it isn't qualified to make.
const SYSTEM_PROMPT = `You are a warm, careful virtual health assistant inside a Symptom Checker feature. You're having a conversation with someone about symptoms they're experiencing, the way a thoughtful triage nurse would before a doctor's visit — NOT delivering a diagnosis.

Rules you always follow:
1. Ask short, focused follow-up questions one or two at a time (onset, duration, severity 1-10, what makes it better/worse, associated symptoms, relevant history) before offering any thoughts — don't interrogate with a huge list at once.
2. Once you have enough detail, describe what the symptoms *could* be consistent with in plain language, always as possibilities ("this pattern can sometimes be seen with...") — never a confident diagnosis.
3. Always plainly recommend seeing a licensed clinician for an actual diagnosis and treatment plan — say so directly, don't just imply it.
4. Never give specific medication names with dosing instructions. You can mention general categories of care (rest, hydration, general OTC pain relief) but defer specifics to a pharmacist or doctor.
5. If anything could indicate a medical emergency (chest pain, trouble breathing, stroke signs like face drooping/arm weakness/slurred speech, severe bleeding, signs of anaphylaxis, suicidal thoughts, thoughts of harming others, a child/infant with high fever or lethargy), stop the triage flow immediately and clearly tell them to call emergency services or go to the nearest ER right now — don't keep gathering history first.
6. Keep responses short: 2-5 sentences, plus one follow-up question if relevant. This is a conversation, not an article.
7. Be warm and validating about how they're feeling, without being alarmist.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    const body = await req.json();
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.length) {
      return json({ ok: false, error: "A message is required." }, 400);
    }

    // Only role/content pass through — clients shouldn't be able to smuggle
    // in a different system prompt.
    const history = messages
      .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
      .slice(-20) // cap history so requests stay small and on-topic
      .map((m: any) => ({ role: m.role, content: m.content }));

    const groqKey = Deno.env.get("GROQ_API_KEY");

    const providers: { name: string; url: string; key: string; model: string }[] = [];
    if (groqKey) providers.push({ name: "Groq", url: "https://api.groq.com/openai/v1/chat/completions", key: groqKey, model: "openai/gpt-oss-120b" });

    if (!providers.length) {
      return json({ ok: false, error: "The symptom checker isn't configured yet. Please set GROQ_API_KEY (free — no credit card required at console.groq.com)." }, 500);
    }

    let lastError = "";
    for (const provider of providers) {
      try {
        const res = await fetch(provider.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.key}` },
          body: JSON.stringify({
            model: provider.model,
            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
            temperature: 0.4,
            max_tokens: 400,
          }),
        });
        if (!res.ok) {
          lastError = `${provider.name} ${res.status}: ${await res.text()}`;
          console.error(lastError);
          continue;
        }
        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content?.trim();
        if (!reply) { lastError = `${provider.name} returned no content`; continue; }
        return json({ ok: true, reply });
      } catch (err) {
        lastError = `${provider.name} error: ${err}`;
        console.error(lastError);
      }
    }

    console.error("symptom-chat: all providers failed —", lastError);
    return json({ ok: false, error: "The symptom checker is temporarily unavailable. Please try again in a moment." }, 503);
  } catch (error) {
    console.error("symptom-chat error:", error);
    return json({ ok: false, error: "Something went wrong." }, 500);
  }
});