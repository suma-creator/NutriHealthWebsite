document.addEventListener("DOMContentLoaded", async () => {
  const user = await requireAuth();
  if (!user) return;

  renderShell("chatbot.html");
  let profile = await loadUserChip(user) || {};
  profile = loadCachedProfile(profile);
  hidePageLoader();

  const chatForm = qs("#chatForm");
  const chatInput = qs("#chatInput");
  const chatWindow = qs("#chatWindow");
  const statusDot = qs("#chatStatusDot");
  const statusText = qs("#chatStatusText");

  // Voice chat: mic button fills the input via speech-to-text; the header
  // toggle controls whether bot replies are automatically read aloud.
  const autoSpeak = typeof VoiceHelper !== "undefined"
    ? VoiceHelper.attachAutoSpeakToggle(qs("#chatVoiceToggle"), "nh_chatbot_autospeak")
    : { isEnabled: () => false };

  if (typeof VoiceHelper !== "undefined") {
    VoiceHelper.attachMic(qs("#chatVoiceInputBtn"), chatInput, {
      onEnd: (transcript) => {
        if (transcript) sendChatQuestion(transcript);
      }
    });

    // Always-visible "Stop talking" control — appears whenever a reply is
    // being read aloud, regardless of which message triggered it or where
    // the user has scrolled to.
    const stopBar = qs("#chatVoiceStopBar");
    qs("#chatStopTalkingBtn")?.addEventListener("click", () => VoiceHelper.stopSpeaking());
    VoiceHelper.onSpeakStateChange((speaking) => {
      if (stopBar) stopBar.style.display = speaking ? "flex" : "none";
    });
  }

  const directOpenAIConfigured =
    typeof AI_API_KEY === "string" && AI_API_KEY.trim().length > 0;
  const aiAvailable = Boolean(supabaseClient?.functions) || directOpenAIConfigured;

  let conversationHistory = [];
  let connectionKnown = false;

  setStatus(aiAvailable ? "connecting" : "offline");

  appendMessage(
    `Hey ${profile?.name?.split(" ")[0] || "there"}! I'm your smart assistant — ask me about nutrition, recipes, medicine, symptoms, BMI, calories, weight, and healthy lifestyle habits: what to do and what to avoid. I'll use your profile to personalize answers when it helps.`,
    "bot"
  );

  function setStatus(state) {
    statusDot.classList.remove("offline");
    if (state === "connecting") {
      statusText.textContent = t("chatbot_checking_connection", "Checking connection…");
    } else if (state === "online") {
      statusText.textContent = t("chatbot_online", "Online — AI powered");
    } else {
      statusDot.classList.add("offline");
      statusText.textContent = t("chatbot_offline", "Limited mode — offline guidance");
    }
  }

  function timeNow() {
    return localizeTimeString(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }

  function appendMessage(text, type = "bot", opts = {}) {
    const row = document.createElement("div");
    row.className = `chat-row ${type}`;

    const avatar = document.createElement("div");
    avatar.className = `chat-avatar-sm ${type}`;
    avatar.textContent = type === "bot" ? "🤖" : "🙂";

    const col = document.createElement("div");
    col.className = "chat-bubble-col";

    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${type}${opts.diagnostic ? " diagnostic" : ""}`;
    bubble.textContent = text;

    const timestamp = document.createElement("div");
    timestamp.className = "chat-timestamp";
    timestamp.textContent = timeNow();

    col.appendChild(bubble);

    let speakBtn = null;
    if (type === "bot" && typeof VoiceHelper !== "undefined" && VoiceHelper.isSynthesisSupported()) {
      speakBtn = document.createElement("button");
      speakBtn.type = "button";
      speakBtn.className = "chat-bubble-speak-btn";
      speakBtn.textContent = t("chatbot_listen_btn", "🔊 Listen");
      speakBtn.addEventListener("click", () => VoiceHelper.speakWithButton(text, speakBtn));
      col.appendChild(speakBtn);
    }

    col.appendChild(timestamp);
    row.appendChild(avatar);
    row.appendChild(col);
    chatWindow.appendChild(row);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    if (type === "bot" && !opts.diagnostic && autoSpeak.isEnabled() && typeof VoiceHelper !== "undefined" && speakBtn) {
      VoiceHelper.speakWithButton(text, speakBtn);
    }

    return row;
  }

  function showTyping() {
    const row = document.createElement("div");
    row.className = "chat-row bot";
    row.id = "chatTypingRow";

    const avatar = document.createElement("div");
    avatar.className = "chat-avatar-sm bot";
    avatar.textContent = "🤖";

    const col = document.createElement("div");
    col.className = "chat-bubble-col";

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble bot";
    bubble.innerHTML = '<div class="chat-typing"><span></span><span></span><span></span></div>';
    bubble.style.padding = "0";

    col.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(col);
    chatWindow.appendChild(row);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }

  function hideTyping() {
    const row = qs("#chatTypingRow");
    if (row) row.remove();
  }

  function cacheProfile(profileData) {
    try {
      localStorage.setItem("nh_profile", JSON.stringify(profileData));
    } catch (error) {
      console.warn("Profile cache failed", error);
    }
  }

  function loadCachedProfile(profileData = {}) {
    if (profileData && Object.keys(profileData).length > 0) {
      cacheProfile(profileData);
      return profileData;
    }
    try {
      const stored = localStorage.getItem("nh_profile");
      if (stored) return JSON.parse(stored);
    } catch (error) {
      console.warn("Failed reading cached profile", error);
    }
    return profileData;
  }

  function buildProfileContext(profile) {
    if (!profile || Object.keys(profile).length === 0) return "No saved profile details.";
    const lines = [];
    if (profile.name) lines.push(`Name: ${profile.name}`);
    if (profile.age) lines.push(`Age: ${profile.age}`);
    if (profile.gender) lines.push(`Gender: ${profile.gender}`);
    if (profile.height) lines.push(`Height: ${profile.height} cm`);
    if (profile.weight) lines.push(`Weight: ${profile.weight} kg`);
    return lines.join("; ");
  }

  const DIRECT_SYSTEM_PROMPT = `You are NutriHealth, the in-app assistant for NutriHealth, a personal health, nutrition, and wellness platform. You are knowledgeable and practical, and you answer like a well-read health professional talking to a friend — never generic or vague.

YOUR DOMAIN EXPERTISE:
- Nutrition & diet science: macros, micronutrients, calorie needs, portion sizing, meal planning, weight loss/gain strategies, and special diets (keto, vegan, vegetarian, diabetic-friendly, low-sodium, high-protein, gluten-free, etc.).
- Recipes & cooking: give real, specific recipes with an ingredient list and clear numbered steps when asked. Offer ingredient substitutions for allergies, dietary restrictions, or what someone already has at home. Suggest recipes across cuisines and adjust for the user's goals (bulking, cutting, quick prep, budget-friendly).
- General medicine & pharmacology: explain conditions and common over-the-counter medicines educationally, flag red-flag symptoms, and never give a definitive diagnosis or a personalized dosage — always recommend a licensed doctor or pharmacist for anything specific to the user's own case.
- BMI, body weight, and calorie management: explain what BMI does and doesn't capture, healthy weight ranges, and sustainable calorie approaches.
- Fitness & exercise, sleep, hydration, stress, and daily habit-building.

KNOWLEDGE OF THIS APP — proactively point users to the right tool by name when it fits their question (BMI Calculator, Food Tracker, Nutrition & Nutrition Report, Diet Plan, Recipes, Grocery List, Exercise, Water Tracker, Sleep Tracker, Symptom Checker, Doctor Appointments, Medicine Reminders, Health Score, Scanner, Profile & Settings).

Use profile details when provided to personalize numbers. Keep answers focused, with bullet or numbered lists for steps/ingredients. For practical questions about health, medicine, food, nutrition, calories, weight, BMI, symptoms, or lifestyle habits, structure the answer with a short "Do" list and a short "Avoid" list (2-4 items each) plus a sentence of explanation, when the question is asking what someone should or shouldn't do. For anything involving diagnosis or medication dosing, give safe general guidance and recommend the Symptom Checker or Doctor Appointments, or emergency care if severe.`;

  async function askAiDirect(question, profile, history) {
    const endpoint =
      typeof AI_API_URL === "string" && AI_API_URL.trim().length > 0
        ? AI_API_URL
        : "https://api.openai.com/v1/chat/completions";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: DIRECT_SYSTEM_PROMPT },
            {
              role: "system",
              content: profile ? `User profile: ${profile}` : "No profile details available.",
            },
            ...(Array.isArray(history) ? history.slice(-10) : []),
            { role: "user", content: question },
          ],
          temperature: 0.6,
          max_tokens: 800,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error("Direct OpenAI API error:", data);
        return { reply: null, diagnosticMessage: data?.error?.message || `OpenAI request failed (${response.status}).` };
      }

      const reply = data?.choices?.[0]?.message?.content?.trim();
      return reply ? { reply } : { reply: null, diagnosticMessage: "OpenAI returned an empty response." };
    } catch (err) {
      console.error("Direct OpenAI request failed:", err);
      return { reply: null, diagnosticMessage: err?.message || "Couldn't reach OpenAI." };
    }
  }

  async function askAi(question, profile) {
    const profileContext = buildProfileContext(profile);

    if (supabaseClient?.functions) {
      try {
        const { data, error } = await supabaseClient.functions.invoke("chat", {
          body: {
            question,
            profile: profileContext,
            history: conversationHistory,
          },
        });

        if (!error && data?.ok && data?.reply) {
          return { reply: data.reply, source: "backend" };
        }

        // The edge function reached us but returned a known, informative
        // error (e.g. "OPENAI_API_KEY is not configured") — surface that
        // instead of silently discarding it.
        if (!error && data?.reply) {
          return { reply: null, diagnosticMessage: data.reply, source: "backend" };
        }

        console.warn("AI service did not return a usable reply:", data, error);
        return {
          reply: null,
          diagnosticMessage: error?.message || "The backend chat service didn't respond as expected.",
          source: "backend",
        };
      } catch (err) {
        console.error("Supabase function invocation error:", err);
        if (!directOpenAIConfigured) {
          return { reply: null, diagnosticMessage: err?.message || "Couldn't reach the backend chat service.", source: "backend" };
        }
        // fall through to direct OpenAI below
      }
    }

    if (directOpenAIConfigured) {
      const result = await askAiDirect(question, profileContext, conversationHistory);
      return { ...result, source: "direct" };
    }

    return { reply: null, diagnosticMessage: "No AI backend is configured.", source: "none" };
  }

  function formatProfileDetails(profile) {
    if (!profile) return "";
    const details = [];
    if (profile.age) details.push(`${profile.age} years old`);
    if (profile.gender) details.push(profile.gender);
    if (profile.height) details.push(`${profile.height} cm tall`);
    if (profile.weight) details.push(`${profile.weight} kg`);
    return details.length ? `I see you are ${details.join(", ")}. ` : "";
  }

  const RECIPE_BANK = [
    { type: "breakfast", tags: ["quick", "protein"], name: "Veggie Masala Omelette", ingredients: "2 eggs, chopped onion & tomato, green chili, a handful of spinach, salt, pepper", steps: "Whisk the eggs with a pinch of salt. Sauté the vegetables 2 minutes, pour eggs over, cook until set (about 4 minutes), fold and serve." },
    { type: "breakfast", tags: ["quick"], name: "Overnight Oats with Berries", ingredients: "½ cup oats, ¾ cup milk or yogurt, 1 tsp honey, handful of berries, chia seeds", steps: "Mix oats, milk/yogurt, honey and chia in a jar. Refrigerate overnight. Top with berries before eating." },
    { type: "breakfast", tags: ["protein"], name: "Greek Yogurt Parfait", ingredients: "1 cup Greek yogurt, granola, mixed nuts, sliced banana, a drizzle of honey", steps: "Layer yogurt, granola and fruit in a glass, repeat, top with nuts and honey." },
    { type: "breakfast", tags: ["low-carb"], name: "Avocado & Egg on the Side", ingredients: "1 avocado, 2 boiled eggs, cherry tomatoes, lemon juice, salt, pepper, chili flakes", steps: "Mash avocado with lemon, salt and pepper. Serve alongside sliced boiled eggs and tomatoes." },

    { type: "lunch", tags: ["protein"], name: "Grilled Chicken & Quinoa Bowl", ingredients: "150g chicken breast, ½ cup cooked quinoa, mixed greens, cherry tomatoes, cucumber, olive oil, lemon", steps: "Season and grill the chicken 5-6 minutes per side. Slice and serve over quinoa and greens with a lemon-olive oil dressing." },
    { type: "lunch", tags: ["vegetarian", "low-carb"], name: "Chickpea & Spinach Curry", ingredients: "1 can chickpeas, 2 cups spinach, onion, tomato, garlic, ginger, cumin, turmeric", steps: "Sauté onion, garlic and ginger, add spices and tomato, cook 3-4 minutes. Add chickpeas and spinach, simmer 8-10 minutes. Serve with a small portion of rice or on its own." },
    { type: "lunch", tags: ["quick", "protein"], name: "Tuna & White Bean Wrap", ingredients: "1 can tuna, ½ cup white beans, whole-wheat wrap, lettuce, mustard or light mayo", steps: "Mix tuna, beans and a spoon of mustard/mayo. Spread on the wrap with lettuce, roll and slice." },

    { type: "dinner", tags: ["protein"], name: "Baked Salmon with Roasted Vegetables", ingredients: "1 salmon fillet, broccoli, bell pepper, olive oil, garlic, lemon, salt, pepper", steps: "Toss vegetables in oil and seasoning, roast at 200°C for 15 minutes. Add salmon to the tray, bake 12-15 more minutes until flaky." },
    { type: "dinner", tags: ["low-carb", "protein"], name: "Lean Beef Stir-Fry with Broccoli", ingredients: "150g lean beef strips, broccoli, carrot, garlic, ginger, soy sauce, a little sesame oil", steps: "Sear beef 2-3 minutes on high heat, remove. Stir-fry vegetables 3-4 minutes, add garlic, ginger, soy sauce, return beef, toss and serve." },
    { type: "dinner", tags: ["vegetarian"], name: "Paneer & Vegetable Stir-Fry", ingredients: "150g paneer cubes, bell peppers, onion, garlic, soy sauce, a little cornstarch, oil", steps: "Pan-fry paneer until golden, set aside. Stir-fry vegetables 3-4 minutes, add sauce, return paneer, toss 1-2 minutes and serve." },

    { type: "snack", tags: ["protein", "quick"], name: "Greek Yogurt with Honey & Almonds", ingredients: "1 cup Greek yogurt, a drizzle of honey, a small handful of almonds", steps: "Combine and eat — takes under 2 minutes." },
    { type: "snack", tags: ["quick"], name: "Apple Slices with Peanut Butter", ingredients: "1 apple, 1-2 tbsp natural peanut butter", steps: "Slice the apple and dip in peanut butter." },
    { type: "snack", tags: ["low-carb", "protein"], name: "Roasted Chickpeas", ingredients: "1 can chickpeas, olive oil, paprika, salt, cumin", steps: "Pat chickpeas dry, toss with oil and spices, roast at 200°C for 20-25 minutes until crisp." },
  ];

  const recipeRotation = {};

  function getRecipeSuggestion(lower) {
    let mealType = null;
    if (lower.includes("breakfast")) mealType = "breakfast";
    else if (lower.includes("lunch")) mealType = "lunch";
    else if (lower.includes("dinner")) mealType = "dinner";
    else if (lower.includes("snack")) mealType = "snack";

    if (!mealType) {
      if (lower.includes("recipe") || lower.includes("cook") || lower.includes("meal")) {
        return `Tell me what you're after — quick breakfast, high-protein dinner, low-carb lunch, or a healthy snack — plus any ingredients to avoid, and I'll suggest something specific. You can also browse ready-made ideas on the Recipes page and build a shopping list on Grocery List.`;
      }
      return null;
    }

    const wantsProtein = lower.includes("protein");
    const wantsLowCarb = lower.includes("low-carb") || lower.includes("low carb");
    const wantsVeg = lower.includes("vegetarian") || lower.includes("veg ");
    const wantsQuick = lower.includes("quick") || lower.includes("easy") || lower.includes("fast");

    let candidates = RECIPE_BANK.filter((r) => r.type === mealType);
    const tagFiltered = candidates.filter(
      (r) =>
        (!wantsProtein || r.tags.includes("protein")) &&
        (!wantsLowCarb || r.tags.includes("low-carb")) &&
        (!wantsVeg || r.tags.includes("vegetarian")) &&
        (!wantsQuick || r.tags.includes("quick"))
    );
    if (tagFiltered.length > 0) candidates = tagFiltered;

    const key = `${mealType}:${wantsProtein}:${wantsLowCarb}:${wantsVeg}:${wantsQuick}`;
    const i = recipeRotation[key] || 0;
    const pick = candidates[i % candidates.length];
    recipeRotation[key] = i + 1;

    return `**${pick.name}**\nIngredients: ${pick.ingredients}\nSteps: ${pick.steps}\n\nWant another option, or a different meal type — just ask. You can also browse more ideas on the Recipes page and build a shopping list on Grocery List.`;
  }

  function localFallbackResponse(question, profile) {
    const lower = question.toLowerCase();
    const profileIntro = formatProfileDetails(profile);

    if (lower.includes("who am i") || lower.includes("my name")) {
      return `You are ${profile?.name || "a NutriHealth user"}. ${profileIntro}I'm here to help with whatever you want to ask.`;
    }

    if (lower.includes("bmi") || (lower.includes("height") && lower.includes("weight"))) {
      if (profile?.height && profile?.weight) {
        const bmi = Number((profile.weight / ((profile.height / 100) ** 2)).toFixed(1));
        const category = bmi < 18.5 ? "underweight" : bmi < 25 ? "normal weight" : bmi < 30 ? "overweight" : "obese";
        return `${profileIntro}Your height is ${profile.height} cm and weight is ${profile.weight} kg, giving an approximate BMI of ${bmi} (${category}).\n\nDo:\n• Track it over time on the BMI Calculator page rather than judging one reading\n• Focus on waist size, strength, and energy alongside the number\n• Pair a modest calorie adjustment with regular activity if you're aiming to change it\n\nAvoid:\n• Making drastic diet changes based on BMI alone\n• Treating BMI as a diagnosis — it doesn't account for muscle mass or body composition`;
      }
      return "I don't have enough profile info to calculate your BMI. Save your height and weight in Profile, or use the BMI Calculator page directly.";
    }

    if (lower.includes("weight") && (lower.includes("lose") || lower.includes("loss") || lower.includes("gain"))) {
      const goal = lower.includes("gain") ? "gaining" : "losing";
      return `For ${goal} weight sustainably:\n\nDo:\n• ${goal === "gaining" ? "Eat in a modest calorie surplus (~300-500 kcal/day) with enough protein" : "Eat in a modest calorie deficit (~300-500 kcal/day) rather than crashing calories"}\n• Prioritize protein and fiber so you stay fuller\n• Strength train a couple times a week to protect muscle\n• Track progress weekly, not daily — weight naturally fluctuates\n\nAvoid:\n• Extreme calorie restriction or skipping meals\n• Cutting out entire food groups without a real reason\n• Judging progress by the scale alone — check energy, strength, and how clothes fit too\n\nYou can build a full personalized plan on the Diet Plan page.`;
    }

    if (lower.includes("calorie")) {
      return `A simple starting point: maintenance calories are roughly your weight (kg) × 30, adjusted up or down ~15-20% for gaining or losing weight, then fine-tuned based on how your weight actually trends over a few weeks.\n\nDo:\n• Prioritize protein (about 1.6-2.2g per kg bodyweight) inside that calorie target\n• Fill most meals with vegetables, whole grains, and lean protein\n• Reassess every 2-3 weeks based on real progress\n\nAvoid:\n• Guessing with very low calorie numbers long-term\n• Ignoring liquid calories (juice, sugary drinks) when counting\n\nFor a number tailored to you, check the Diet Plan page — it uses your profile.`;
    }

    if (lower.includes("sleep") || lower.includes("rest") || lower.includes("insomnia")) {
      return `Do:\n• Keep a consistent sleep and wake time, even on weekends\n• Wind down with a calm, low-light routine 30-60 minutes before bed\n• Keep your room cool, dark, and quiet\n\nAvoid:\n• Caffeine within 6-8 hours of bedtime\n• Screens right before bed — the light and stimulation delay sleep\n• Long naps late in the day if you struggle to fall asleep at night\n\nAim for 7-9 hours a night, and log your nights on the Sleep Tracker page to see patterns.`;
    }

    if (lower.includes("hydrate") || lower.includes("water")) {
      return `Do:\n• Sip water steadily through the day instead of large amounts at once\n• Aim for roughly 2-3 liters a day, more if you're active or it's hot\n• Add a pinch of salt or electrolytes after heavy sweating\n\nAvoid:\n• Relying on thirst alone — by then you're already mildly dehydrated\n• Replacing water mostly with sugary or caffeinated drinks\n\nLog it on the Water Tracker page to see how you're doing against your goal.`;
    }

    if (lower.includes("workout") || lower.includes("exercise") || lower.includes("gym")) {
      return `A balanced weekly routine mixes strength training, cardio, and mobility, with at least one rest or active-recovery day.\n\nDo:\n• Train each major muscle group 2x/week for strength\n• Warm up before, and stretch or walk to cool down after\n• Increase weight or reps gradually over weeks\n\nAvoid:\n• Jumping straight to high intensity with no warm-up\n• Training the same muscles hard on back-to-back days\n\nTell me your goal — fat loss, muscle gain, or general fitness — and I can suggest a weekly split. Log sessions on the Exercise page.`;
    }

    if (lower.includes("medicine") || lower.includes("medication") || lower.includes("drug") || lower.includes("dose") || lower.includes("dosage") || lower.includes("paracetamol") || lower.includes("ibuprofen")) {
      return `I can share general, educational information about common over-the-counter medicines, but I can't give you a personal dosage or diagnosis.\n\nDo:\n• Follow the dose on the package or your pharmacist's instructions\n• Check for interactions if you're taking other medicines\n• Track your regular medicines and reminder times on the Medicine page\n\nAvoid:\n• Exceeding the labeled maximum dose or combining similar medicines\n• Taking medicine to mask symptoms that keep coming back — get it checked instead\n\nFor anything specific to how you're feeling, use the Symptom Checker page, or a pharmacist/doctor directly.`;
    }

    if (lower.includes("symptom") || lower.includes("fever") || lower.includes("pain") || lower.includes("sick") || lower.includes("cough") || lower.includes("headache")) {
      return `Do:\n• Rest, stay hydrated, and monitor how symptoms change over 24-48 hours\n• Use the Symptom Checker page — it suggests possible causes, relevant lab tests, and the type of specialist to see, with a direct link to book one\n• Note anything unusual: when it started, severity, and what makes it better or worse\n\nAvoid:\n• Ignoring symptoms that are severe, sudden, or rapidly worsening — seek care right away instead of waiting on an app\n• Self-diagnosing based on a single symptom`;
    }

    if (lower.includes("doctor") || lower.includes("appointment") || lower.includes("specialist") || lower.includes("hospital")) {
      return `You can browse and book doctors by specialty on the Doctor Appointments page — pick a specialty like Cardiologist or Dermatologist, compare doctors and hospitals, then confirm a date and time. If you're not sure which specialist you need, run your symptoms through the Symptom Checker first — it'll recommend one for you.`;
    }

    const recipeAnswer = getRecipeSuggestion(lower);
    if (recipeAnswer) return recipeAnswer;

    if (lower.includes("salad")) {
      return `For a weight-loss-friendly salad:\n\nDo:\n• Build on leafy greens plus a lean protein like grilled chicken or chickpeas\n• Dress it light — lemon juice, a little olive oil, salt, pepper, herbs\n• Add fiber and crunch: cucumber, tomatoes, bell pepper, a few nuts or seeds\n\nAvoid:\n• Heavy creamy dressings, extra cheese, and croutons — they quietly add a lot of calories`;
    }

    if (lower.includes("what can") && lower.includes("app") || lower.includes("what does this app do") || lower.includes("features")) {
      return `NutriHealth covers a lot: BMI Calculator, Food Tracker, Nutrition & Nutrition Report, a personalized Diet Plan, Recipes, Grocery List, Exercise logging, Water and Sleep tracking, a Symptom Checker, Doctor Appointments, Medicine Reminders, a combined Health Score, and a food/barcode Scanner. Ask me about any of these and I'll point you to the right page.`;
    }

    return `I'm here to help with your health, nutrition, recipes, general medicine questions, BMI, calories, weight, fitness, sleep, hydration, and how to use any tool in this app — just ask me something specific, like "what should I eat to gain muscle" or "is a 25 BMI healthy".`;
  }

  async function generateResponse(question, profile) {
    if (aiAvailable) {
      const result = await askAi(question, profile);
      if (result.reply) {
        if (!connectionKnown) {
          connectionKnown = true;
          setStatus("online");
        }
        return { text: result.reply, diagnostic: false };
      }

      if (!connectionKnown) {
        connectionKnown = true;
        setStatus("offline");
      }

      const fallback = localFallbackResponse(question, profile);
      return { text: fallback, diagnostic: false, note: result.diagnosticMessage };
    }
    return { text: localFallbackResponse(question, profile), diagnostic: false };
  }

  let diagnosticShown = false;

  function sendChatQuestion(question) {
    if (!question) return;
    appendMessage(question, "user");
    chatInput.value = "";
    showTyping();

    generateResponse(question, profile).then((result) => {
      hideTyping();

      if (result.note && !diagnosticShown) {
        diagnosticShown = true;
        appendMessage(
          `Heads up — I couldn't reach the AI service (${result.note}), so I'm using general built-in guidance for now. The person who set up this app can check the OPENAI_API_KEY configuration.`,
          "bot",
          { diagnostic: true }
        );
      }

      appendMessage(result.text, "bot");

      conversationHistory.push({ role: "user", content: question });
      conversationHistory.push({ role: "assistant", content: result.text });
      if (conversationHistory.length > 12) {
        conversationHistory = conversationHistory.slice(-12);
      }
    });
  }

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendChatQuestion(chatInput.value.trim());
  });

  qsa(".quick-question").forEach((btn) => {
    btn.addEventListener("click", () => sendChatQuestion(btn.textContent.trim()));
  });
});
