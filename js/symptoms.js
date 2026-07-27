/* =========================================================================
   symptoms.js
   Educational, rule-based matching + optional AI-generated explanation.
   Not a medical diagnostic tool — every result carries that disclaimer.

   Flow implemented (per the Symptom Checker Enhancement Roadmap):
   Symptoms -> AI Analysis -> Possible Disease -> Severity -> Confidence ->
   Probability -> Health Summary -> Medicines -> Foods/Exercise/Avoid ->
   Warnings -> Lab Tests -> Doctor Recommendation -> Prevention -> Report
   ========================================================================= */

let symptomUser = null;
let symptomProfile = null;
let latestBmi = null;          // { bmi, category } from bmi_logs, if any
let lastAnalysis = null;       // full analysis object for the current result, used by the report panel

const SYMPTOM_LIST = [
  "Fever",
  "Cough",
  "Headache",
  "Fatigue",
  "Sore throat",
  "Nausea",
  "Chest pain",
  "Shortness of breath",
  "Body ache",
  "Dizziness",
  "Rash",
  "Diarrhea",
  "Runny nose",
  "Loss of appetite",
  "Vomiting",
  "Chills",
  "Sneezing",
  "Abdominal pain",
  "Joint pain",
  "Muscle pain",
  "Back pain",
  "Itching",
  "Watery eyes",
  "Constipation",
  "Stomach pain",
  "Heartburn",
  "Difficulty swallowing",
  "Wheezing",
  "Night sweats",
  "Weight loss",
  "Blurred vision",
  "Ear pain",
  "Eye redness",
  "Frequent urination",
  "Painful urination",
  "Swelling",
  "Numbness or tingling",
  "Confusion",
  "Yellowing of skin or eyes",
  "Excessive thirst",
  "Palpitations",
  "Cold hands or feet",
  "Swollen glands"
];

// Display-only Bangla labels for the symptom checklist. The underlying
// SYMPTOM_LIST strings stay in English everywhere else (checkbox values,
// condition matching, synonyms, AI extraction) so nothing downstream
// breaks — this map only changes what the user reads on the chip.
const SYMPTOM_I18N_KEYS = {
  "Fever": "symptom_fever",
  "Cough": "symptom_cough",
  "Headache": "symptom_headache",
  "Fatigue": "symptom_fatigue",
  "Sore throat": "symptom_sore_throat",
  "Nausea": "symptom_nausea",
  "Chest pain": "symptom_chest_pain",
  "Shortness of breath": "symptom_shortness_of_breath",
  "Body ache": "symptom_body_ache",
  "Dizziness": "symptom_dizziness",
  "Rash": "symptom_rash",
  "Diarrhea": "symptom_diarrhea",
  "Runny nose": "symptom_runny_nose",
  "Loss of appetite": "symptom_loss_of_appetite",
  "Vomiting": "symptom_vomiting",
  "Chills": "symptom_chills",
  "Sneezing": "symptom_sneezing",
  "Abdominal pain": "symptom_abdominal_pain",
  "Joint pain": "symptom_joint_pain",
  "Muscle pain": "symptom_muscle_pain",
  "Back pain": "symptom_back_pain",
  "Itching": "symptom_itching",
  "Watery eyes": "symptom_watery_eyes",
  "Constipation": "symptom_constipation",
  "Stomach pain": "symptom_stomach_pain",
  "Heartburn": "symptom_heartburn",
  "Difficulty swallowing": "symptom_difficulty_swallowing",
  "Wheezing": "symptom_wheezing",
  "Night sweats": "symptom_night_sweats",
  "Weight loss": "symptom_weight_loss",
  "Blurred vision": "symptom_blurred_vision",
  "Ear pain": "symptom_ear_pain",
  "Eye redness": "symptom_eye_redness",
  "Frequent urination": "symptom_frequent_urination",
  "Painful urination": "symptom_painful_urination",
  "Swelling": "symptom_swelling",
  "Numbness or tingling": "symptom_numbness_tingling",
  "Confusion": "symptom_confusion",
  "Yellowing of skin or eyes": "symptom_yellowing_skin_eyes",
  "Excessive thirst": "symptom_excessive_thirst",
  "Palpitations": "symptom_palpitations",
  "Cold hands or feet": "symptom_cold_hands_feet",
  "Swollen glands": "symptom_swollen_glands"
};
function symptomLabel(s) {
  const key = SYMPTOM_I18N_KEYS[s];
  return key ? t(key, s) : s;
}

/* -------------------------------------------------------------------------
   AI-based symptom analysis. There is deliberately no local disease/rule
   database here — every possible-condition match, severity/risk estimate,
   lab test suggestion, lifestyle advice, and medicine note comes from a
   single AI call (analyzeSymptomsWithAI, below), which also writes its
   response directly in the user's selected language (English or Bangla).
   The render* functions further down stay dumb: they just display
   whatever structured object they're given.
   ------------------------------------------------------------------------- */
function generalPreventionTips() {
  return [
    t("prevention_wash_hands", "Wash hands regularly"),
    t("prevention_stay_hydrated", "Stay hydrated"),
    t("prevention_sleep", "Get 7–9 hours of sleep")
  ];
}


document.addEventListener("DOMContentLoaded", async () => {
  symptomUser = await requireAuth();
  if (!symptomUser) return;

  renderShell("symptoms.html");
  symptomProfile = await loadUserChip(symptomUser);
  renderSymptomGrid();
  await loadLatestBmi();
  await loadSymptomHistory();
  hidePageLoader();

  qs("#symptomForm").addEventListener("submit", handleSymptomSubmit);
  qs("#modeChecklistBtn").addEventListener("click", () => setSymptomInputMode("checklist"));
  qs("#modeFreetextBtn").addEventListener("click", () => setSymptomInputMode("freetext"));
  qs("#analyzeFreeTextBtn").addEventListener("click", handleAnalyzeFreeText);
  qs("#reportDownloadBtn")?.addEventListener("click", () => generateReport("download"));
  qs("#reportPrintBtn")?.addEventListener("click", () => generateReport("print"));
  qs("#reportEmailBtn")?.addEventListener("click", () => generateReport("email"));
  qs("#reportShareBtn")?.addEventListener("click", () => generateReport("share"));
  qs("#reportQrBtn")?.addEventListener("click", () => generateReport("qr"));
  qs("#reportDoctorBtn")?.addEventListener("click", generateDoctorSummary);
});

function renderSymptomGrid() {
  qs("#symptomGrid").innerHTML = SYMPTOM_LIST.map((s, i) => `
    <label class="symptom-chip">
      <input type="checkbox" value="${s}" id="sym${i}" />
      ${symptomLabel(s)}
    </label>
  `).join("");
}

function getSelectedSymptoms() {
  return SYMPTOM_LIST.filter((_, i) => qs(`#sym${i}`).checked);
}

/* -------------------------------------------------------------------------
   Free-text symptom input. The user can describe how they feel in their
   own words instead of clicking checkboxes; AI maps that description onto
   the SAME checklist (SYMPTOM_LIST) rather than generating its own
   diagnosis, so every downstream step (severity scoring, condition
   matching, lab tests, medicine suggestions) stays exactly as reliable as
   the manual-checkbox path. Both input options ultimately just check
   boxes in #symptomGrid — "Check symptoms" always reads from there.
   ------------------------------------------------------------------------- */
function setSymptomInputMode(mode) {
  const isFreetext = mode === "freetext";
  qs("#modeChecklistBtn").setAttribute("aria-selected", String(!isFreetext));
  qs("#modeFreetextBtn").setAttribute("aria-selected", String(isFreetext));
  qs("#symptomFreetextSection").style.display = isFreetext ? "block" : "none";
  qs("#symptomChecklistSection").style.display = isFreetext ? "none" : "block";
}

// Lightweight local fallback for free-text symptom extraction, used when
// the AI backend is unavailable so the free-text input still works
// offline. Not as smart as the AI extractor, but covers common phrasing.
const SYMPTOM_SYNONYMS = {
  "Fever": ["fever", "high temperature", "temp is high", "running a temperature"],
  "Cough": ["cough", "coughing"],
  "Headache": ["headache", "head hurts", "migraine"],
  "Fatigue": ["fatigue", "tired", "exhausted", "no energy", "worn out"],
  "Sore throat": ["sore throat", "throat hurts", "throat pain"],
  "Nausea": ["nausea", "nauseous", "feel sick to my stomach", "queasy"],
  "Chest pain": ["chest pain", "chest hurts", "pain in my chest"],
  "Shortness of breath": ["shortness of breath", "can't breathe", "trouble breathing", "hard to breathe", "breathless"],
  "Body ache": ["body ache", "body aches", "aching all over"],
  "Dizziness": ["dizzy", "dizziness", "lightheaded", "light-headed"],
  "Rash": ["rash", "skin bumps", "hives"],
  "Diarrhea": ["diarrhea", "loose stool", "loose stools"],
  "Runny nose": ["runny nose", "nose is running"],
  "Loss of appetite": ["loss of appetite", "not hungry", "don't want to eat"],
  "Vomiting": ["vomiting", "throwing up", "vomited"],
  "Chills": ["chills", "shivering"],
  "Sneezing": ["sneezing", "sneeze"],
  "Abdominal pain": ["abdominal pain", "stomach ache", "stomach pain", "belly pain", "tummy pain"],
  "Joint pain": ["joint pain", "joints hurt", "achy joints"],
  "Muscle pain": ["muscle pain", "muscles ache", "sore muscles"],
  "Back pain": ["back pain", "back hurts"],
  "Itching": ["itching", "itchy"],
  "Watery eyes": ["watery eyes", "eyes watering"],
  "Constipation": ["constipation", "constipated"],
  "Heartburn": ["heartburn", "acid reflux"],
  "Difficulty swallowing": ["difficulty swallowing", "hard to swallow", "trouble swallowing"],
  "Wheezing": ["wheezing", "wheeze"],
  "Night sweats": ["night sweats", "sweating at night"],
  "Weight loss": ["weight loss", "losing weight", "lost weight"],
  "Blurred vision": ["blurred vision", "blurry vision", "vision is blurry"],
  "Ear pain": ["ear pain", "ear hurts", "earache"],
  "Eye redness": ["eye redness", "red eyes", "eyes are red"],
  "Frequent urination": ["frequent urination", "peeing a lot", "urinating often"],
  "Painful urination": ["painful urination", "burning when i pee", "pain when urinating", "burns when i urinate"],
  "Swelling": ["swelling", "swollen"],
  "Numbness or tingling": ["numbness", "tingling", "pins and needles", "numb"],
  "Confusion": ["confusion", "confused", "disoriented"],
  "Yellowing of skin or eyes": ["yellowing", "jaundice", "yellow eyes", "yellow skin"],
  "Excessive thirst": ["excessive thirst", "very thirsty", "always thirsty"],
  "Palpitations": ["palpitations", "heart racing", "heart pounding", "irregular heartbeat"],
  "Cold hands or feet": ["cold hands", "cold feet", "hands and feet are cold"],
  "Swollen glands": ["swollen glands", "swollen lymph nodes", "neck glands are swollen"]
};

function localExtractSymptoms(text) {
  const lower = text.toLowerCase();
  const matched = [];
  Object.keys(SYMPTOM_SYNONYMS).forEach((symptom) => {
    const hit = SYMPTOM_SYNONYMS[symptom].some((phrase) => lower.includes(phrase));
    if (hit) matched.push(symptom);
  });
  return matched;
}

async function handleAnalyzeFreeText() {
  const btn = qs("#analyzeFreeTextBtn");
  const statusEl = qs("#freeTextStatus");
  const text = qs("#symptomFreeText").value.trim();

  if (!text) {
    statusEl.textContent = t("symptoms_describe_first", "Describe how you're feeling first.");
    return;
  }

  setBtnLoading(btn, true, t("symptoms_analyzing", "Analyzing..."));
  statusEl.textContent = "";

  function applyMatches(matched, unmatched, sourceNote) {
    if (!matched.length) {
      statusEl.textContent = t("symptoms_no_match", "Couldn't match that to any symptoms on our list — try rephrasing, or use the checklist instead.");
      setBtnLoading(btn, false, t("symptoms_analyze_ai_btn", "🤖 Analyze with AI"));
      return;
    }

    SYMPTOM_LIST.forEach((s, i) => {
      if (matched.includes(s)) {
        const input = qs(`#sym${i}`);
        input.checked = true;
        input.closest(".symptom-chip")?.classList.add("ai-detected");
      }
    });

    const noteEl = qs("#aiDetectedNote");
    let note = `${sourceNote} ${matched.map(symptomLabel).join(", ")}.`;
    if (unmatched.length) {
      note += ` ${t("symptoms_also_mentioned", "Also mentioned (not on our checklist, worth telling a doctor):")} ${unmatched.join(", ")}.`;
    }
    note += " " + t("symptoms_review_adjust", 'Review and adjust below, then click "Check symptoms."');
    noteEl.textContent = note;
    noteEl.style.display = "block";

    setSymptomInputMode("checklist");
    setBtnLoading(btn, false, t("symptoms_analyze_ai_btn", "🤖 Analyze with AI"));
  }

  try {
    const { data, error } = await supabaseClient.functions.invoke("chat", {
      body: { question: text, mode: "extract_symptoms", symptomList: SYMPTOM_LIST },
    });

    if (error || data?.ok === false) {
      // AI backend unavailable — fall back to local keyword matching
      // instead of just showing an error, so free-text still works.
      const localMatches = localExtractSymptoms(text);
      if (localMatches.length) {
        applyMatches(localMatches, [], t("symptoms_matched_offline", "🔎 Matched from your description (offline mode):"));
      } else {
        statusEl.textContent = data?.error || t("symptoms_analyze_error", "Couldn't analyze that right now — try the checklist instead.");
        setBtnLoading(btn, false, t("symptoms_analyze_ai_btn", "🤖 Analyze with AI"));
      }
      return;
    }

    const matched = Array.isArray(data.matched) ? data.matched : [];
    const unmatched = Array.isArray(data.unmatched) ? data.unmatched : [];

    if (!matched.length) {
      // AI reachable but found nothing — try the local matcher as a second pass.
      const localMatches = localExtractSymptoms(text);
      if (localMatches.length) {
        applyMatches(localMatches, [], t("symptoms_matched_from_desc", "🔎 Matched from your description:"));
        return;
      }
      statusEl.textContent = t("symptoms_no_match", "Couldn't match that to any symptoms on our list — try rephrasing, or use the checklist instead.");
      setBtnLoading(btn, false, t("symptoms_analyze_ai_btn", "🤖 Analyze with AI"));
      return;
    }

    applyMatches(matched, unmatched, t("symptoms_ai_detected_from_desc", "🤖 AI detected from your description:"));
  } catch (err) {
    console.error("Free-text symptom analysis failed:", err);
    const localMatches = localExtractSymptoms(text);
    if (localMatches.length) {
      applyMatches(localMatches, [], t("symptoms_matched_offline", "🔎 Matched from your description (offline mode):"));
    } else {
      statusEl.textContent = t("symptoms_generic_error", "Something went wrong — try the checklist instead.");
      setBtnLoading(btn, false, t("symptoms_analyze_ai_btn", "🤖 Analyze with AI"));
    }
  }
}

/* -------------------------------------------------------------------------
   BMI integration — pull the user's latest BMI so it can inform the AI
   Health Summary and be shown alongside the result, without recalculating it.
   ------------------------------------------------------------------------- */
async function loadLatestBmi() {
  const { data } = await supabaseClient
    .from("bmi_logs")
    .select("bmi, category")
    .eq("user_id", symptomUser.id)
    .order("created_at", { ascending: false })
    .limit(1);

  latestBmi = data && data.length ? data[0] : null;
  const el = qs("#bmiContextNote");
  if (el) {
    el.textContent = latestBmi
      ? `Latest BMI on file: ${latestBmi.bmi} (${latestBmi.category}). This is factored into your health summary.`
      : "No BMI on file yet — log one on the BMI Calculator for a more complete health summary.";
  }
}

function getVitalsInput() {
  const val = (id) => {
    const v = qs(id)?.value;
    return v !== undefined && v !== "" ? Number(v) : null;
  };
  return {
    temperature: val("#vitalTemp"),
    heartRate: val("#vitalHeartRate"),
    bpSystolic: val("#vitalBpSys"),
    bpDiastolic: val("#vitalBpDia"),
    oxygenSaturation: val("#vitalOxygen"),
    respiratoryRate: val("#vitalRespRate"),
    bloodSugar: val("#vitalBloodSugar")
  };
}

function hasAnyVital(vitals) {
  return Object.values(vitals).some((v) => v !== null && v !== undefined);
}

// Flags out-of-range vitals against common adult reference ranges.
// Educational only — not a substitute for clinical interpretation.
function flagAbnormalVitals(vitals) {
  const flags = [];
  if (vitals.temperature !== null) {
    if (vitals.temperature >= 38) flags.push({ label: t("vital_flag_temp_high", "Elevated temperature"), severity: vitals.temperature >= 39.5 ? 2 : 1 });
    else if (vitals.temperature < 35.5) flags.push({ label: t("vital_flag_temp_low", "Low temperature"), severity: 1 });
  }
  if (vitals.heartRate !== null) {
    if (vitals.heartRate > 100) flags.push({ label: t("vital_flag_hr_high", "Elevated heart rate"), severity: vitals.heartRate > 130 ? 2 : 1 });
    else if (vitals.heartRate < 50) flags.push({ label: t("vital_flag_hr_low", "Low heart rate"), severity: 1 });
  }
  if (vitals.bpSystolic !== null && vitals.bpDiastolic !== null) {
    if (vitals.bpSystolic >= 140 || vitals.bpDiastolic >= 90) flags.push({ label: t("vital_flag_bp_high", "High blood pressure"), severity: vitals.bpSystolic >= 160 ? 2 : 1 });
    else if (vitals.bpSystolic < 90) flags.push({ label: t("vital_flag_bp_low", "Low blood pressure"), severity: 1 });
  }
  if (vitals.oxygenSaturation !== null) {
    if (vitals.oxygenSaturation < 95) flags.push({ label: t("vital_flag_o2_low", "Low oxygen saturation"), severity: vitals.oxygenSaturation < 90 ? 2 : 1 });
  }
  if (vitals.respiratoryRate !== null) {
    if (vitals.respiratoryRate > 20) flags.push({ label: t("vital_flag_resp_high", "Elevated respiratory rate"), severity: vitals.respiratoryRate > 28 ? 2 : 1 });
  }
  if (vitals.bloodSugar !== null) {
    if (vitals.bloodSugar > 180) flags.push({ label: t("vital_flag_sugar_high", "High blood sugar"), severity: vitals.bloodSugar > 250 ? 2 : 1 });
    else if (vitals.bloodSugar < 70) flags.push({ label: t("vital_flag_sugar_low", "Low blood sugar"), severity: 2 });
  }
  return flags;
}

/* -------------------------------------------------------------------------
   AI Analysis — a single call to the "analyze_symptoms" mode of the chat
   edge function (same Groq/OpenAI backend as the chatbot). The AI returns
   the full structured result — possible conditions with probabilities,
   severity/confidence/risk level, lab tests, doctor type, lifestyle
   advice, general medicine notes, and a plain-language explanation — all
   already written in the user's selected language (English or Bangla).
   There is no local matching/scoring logic and no local disease list:
   this function's only job is building the request and validating the
   shape of what comes back.
   ------------------------------------------------------------------------- */

const URGENCY_TO_RISK = {
  "Very Low": "Low",
  "Low": "Low",
  "Moderate": "Moderate",
  "High": "High",
  "Emergency": "Urgent"
};

async function analyzeSymptomsWithAI(selected, vitalsFlags, vitals, options = {}) {
  const { durationDays = null, overallSeverity = null, freeTextDescription = null } = options;
  const lang = typeof getCurrentLang === "function" ? getCurrentLang() : "en";

  const payload = {
    mode: "analyze_symptoms",
    symptoms: selected,
    freeText: freeTextDescription || "",
    duration: durationDays || "",
    overallSeverity: overallSeverity || "",
    vitals,
    healthContext: {
      age: symptomProfile?.age || null,
      gender: symptomProfile?.gender || null,
      height: symptomProfile?.height || null,
      weight: symptomProfile?.weight || null,
      bmi: latestBmi?.bmi || null,
      bmiCategory: latestBmi?.category || null
    },
    language: lang === "bn" ? "bn" : "en"
  };

  const { data, error } = await supabaseClient.functions.invoke("chat", { body: payload });

  if (error || data?.ok === false) {
    throw new Error(data?.error || error?.message || "AI analysis failed.");
  }

  const result = data.result || {};
  const rawConditions = Array.isArray(result.conditions) ? result.conditions : [];
  const urgencyLevel = result.urgencyLevel;
  const riskLevel = URGENCY_TO_RISK[urgencyLevel] || "Moderate";
  const top = rawConditions[0] || null;

  const conditionInfo = top ? {
    name: top.name,
    description: top.description,
    cause: top.cause,
    incubation: top.incubation,
    recoveryTime: top.recoveryTime,
    contagious: top.contagious === "Yes",
    bodySystem: top.bodySystem,
    doctorType: DOCTOR_TYPE_TO_SPECIALTY[top.doctorType] ? top.doctorType : "General Physician",
    doctorTypeLabel: top.doctorType,
    labTests: top.labTests || [],
    prevention: top.prevention || [],
    foods: top.foodsToEat || [],
    avoid: top.foodsToAvoid || [],
    hydration: top.hydrationAdvice,
    rest: top.restAdvice,
    exercise: top.exerciseAdvice,
    warnings: top.warningSigns || []
  } : null;

  return {
    conditions: rawConditions.map((c) => c.name).filter(Boolean),
    probabilities: rawConditions.map((c) => ({ name: c.name, probability: c.likelihood })).filter((p) => p.name),
    severity: Number.isFinite(result.severityScore) ? result.severityScore : 40,
    confidence: Number.isFinite(result.confidence) ? result.confidence : 50,
    riskLevel,
    isUrgent: riskLevel === "Urgent",
    emergencyCombos: urgencyLevel === "Emergency" && result.urgencyReason ? [{ reason: result.urgencyReason }] : [],
    topCondition: top?.name || null,
    conditionInfo,
    aiSummary: result.clinicalObservation || t("symptoms_ai_summary_fallback", "Analysis complete — see the details below."),
    explanation: [result.clinicalObservation, result.urgencyReason].filter(Boolean).join(" ") || null,
    // The AI is deliberately instructed not to give specific medicine
    // dosing (safety), so there's no structured medicine list to show —
    // the medicine suggestions section just stays hidden.
    medicineSuggestions: [],
    recommendation: Array.isArray(result.recommendedActions) && result.recommendedActions.length
      ? result.recommendedActions.join(". ") + "."
      : (riskLevel === "Urgent"
          ? t("symptoms_recommendation_urgent", "Some of your symptoms can be serious. Please consult a doctor promptly or seek emergency care if symptoms worsen.")
          : t("symptoms_recommendation_general", "Rest, stay hydrated, and monitor your symptoms. If they persist or worsen, consult a doctor.")),
    vitalsFlags,
    durationDays,
    overallSeverity
  };
}


async function handleSymptomSubmit(event) {
  event.preventDefault();
  const btn = qs("#symptomBtn");
  const selected = getSelectedSymptoms();
  const freeTextDescription = qs("#symptomFreeText").value.trim() || null;

  if (!selected.length) {
    showToast(t("toast_symptoms_select_one", "Select at least one symptom."), "warning");
    return;
  }

  const vitals = getVitalsInput();
  const vitalsFlags = flagAbnormalVitals(vitals);
  const durationDays = qs("#symptomDuration")?.value || null;
  const overallSeverity = qs("#symptomOverallSeverity")?.value || null;

  setBtnLoading(btn, true, t("symptoms_analyzing", "Analyzing..."));

  let analysis;
  try {
    analysis = await analyzeSymptomsWithAI(selected, vitalsFlags, vitals, { durationDays, overallSeverity, freeTextDescription });
  } catch (err) {
    console.error("AI symptom analysis failed:", err);
    setBtnLoading(btn, false, t("symptoms_check_btn", "Check symptoms"));
    const detail = err?.message ? ` (${err.message})` : "";
    showToast(t("toast_symptoms_ai_failed", "AI analysis is temporarily unavailable — please try again in a moment.") + detail, "error");
    return;
  }

  const { data: inserted, error } = await supabaseClient
    .from("symptom_logs")
    .insert({
      user_id: symptomUser.id,
      symptoms: selected,
      possible_conditions: analysis.conditions,
      recommendations: analysis.recommendation,
      severity_score: analysis.severity,
      confidence: analysis.confidence,
      risk_level: analysis.riskLevel,
      ai_summary: analysis.aiSummary,
      ai_explanation: analysis.explanation,
      vitals,
      free_text_description: freeTextDescription
    })
    .select()
    .single();

  if (error) {
    setBtnLoading(btn, false, t("symptoms_check_btn", "Check symptoms"));
    showToast(error.message, "error");
    return;
  }

  if (hasAnyVital(vitals)) {
    await supabaseClient.from("vital_signs").insert({
      user_id: symptomUser.id,
      symptom_log_id: inserted?.id || null,
      temperature: vitals.temperature,
      heart_rate: vitals.heartRate,
      bp_systolic: vitals.bpSystolic,
      bp_diastolic: vitals.bpDiastolic,
      oxygen_saturation: vitals.oxygenSaturation,
      respiratory_rate: vitals.respiratoryRate,
      blood_sugar: vitals.bloodSugar,
      bmi: latestBmi?.bmi || null
    });
  }

  lastAnalysis = { ...analysis, recommendation: analysis.recommendation, symptomLogId: inserted?.id || null, selected, vitals };

  renderResult(analysis, analysis.recommendation);
  setBtnLoading(btn, false, t("symptoms_check_btn", "Check symptoms"));
  showToast(t("toast_symptoms_saved", "Symptom check saved."), "success");
  await loadSymptomHistory();

  // The explanation came back as part of the same AI call above — no
  // second network round-trip needed, just display it.
  const explanationBox = qs("#aiExplanationBox");
  const loadingEl = qs("#aiExplanationLoading");
  const textEl = qs("#aiExplanationText");
  explanationBox.style.display = "block";
  loadingEl.style.display = "none";
  textEl.style.display = "block";
  textEl.textContent = analysis.explanation || t("symptoms_explanation_unavailable", "AI explanation is temporarily unavailable — the AI Health Summary above still reflects your results.");
}

/* -------------------------------------------------------------------------
   Rendering
   ------------------------------------------------------------------------- */
function renderResult(analysis, recommendation) {
  qs("#symptomResult").style.display = "block";
  qs("#aiExplanationBox").style.display = "none";
  qs("#aiExplanationText").style.display = "none";
  qs("#aiExplanationLoading").style.display = "none";
  const showUrgent = analysis.riskLevel === "Urgent";
  qs("#urgentNotice").style.display = showUrgent ? "block" : "none";
  if (showUrgent) {
    const noticeText = analysis.emergencyCombos.length
      ? analysis.emergencyCombos.map((c) => c.reason).join(" ")
      : t("symptoms_urgent_notice_fallback", "Some of your reported symptoms can be serious. Please contact a doctor or emergency services.");
    qs("#urgentNoticeText").textContent = noticeText;
  }
  qs("#recommendationText").textContent = recommendation;

  renderAiAnalysis(analysis);
  renderConditionsList(analysis);
  renderDiseaseInfoCard(analysis.conditionInfo);
  renderLifestyleAdvice(analysis.conditionInfo);
  renderLabTests(analysis.conditionInfo);
  renderDoctorRecommendation(analysis.conditionInfo);
  renderPreventionChecklist(analysis);
  renderMedicineSuggestions(analysis.medicineSuggestions, analysis.isUrgent);

  qs("#symptomResult").scrollIntoView({ behavior: "smooth", block: "start" });
}

function riskBadgeColor(riskLevel) {
  return { Low: "icon-mint", Moderate: "icon-amber", High: "icon-coral", Urgent: "icon-coral" }[riskLevel] || "icon-blue";
}

function renderAiAnalysis(analysis) {
  qs("#aiSeverityValue").textContent = `${analysis.severity}/100`;
  qs("#aiConfidenceValue").textContent = `${analysis.confidence}%`;
  const riskEl = qs("#aiRiskValue");
  riskEl.textContent = t(`risk_level_${analysis.riskLevel.toLowerCase()}`, analysis.riskLevel);
  riskEl.className = `stat-icon ${riskBadgeColor(analysis.riskLevel)}`;
  riskEl.style.cssText = "display:inline-block;width:auto;height:auto;padding:4px 12px;border-radius:20px;font-size:0.85rem;font-weight:700;";

  const nameEl = qs("#reportPatientName");
  if (nameEl) nameEl.textContent = symptomProfile?.name || symptomUser?.email || "—";
  const dateEl = qs("#reportPatientDate");
  if (dateEl) dateEl.textContent = formatDate(new Date());
  const riskBannerEl = qs("#reportPatientRisk");
  if (riskBannerEl) riskBannerEl.textContent = t(`risk_level_${analysis.riskLevel.toLowerCase()}`, analysis.riskLevel);

  qs("#aiSummaryText").textContent = analysis.aiSummary;

  const probEl = qs("#aiProbabilityList");
  probEl.innerHTML = analysis.probabilities.length
    ? analysis.probabilities.map((p) => `
        <div class="mb-8">
          <div class="flex-between text-sm"><span>${p.name}</span><span style="font-weight:700;">${p.probability}%</span></div>
          <div style="height:8px;border-radius:6px;background:var(--color-primary-light);overflow:hidden;">
            <div style="height:100%;width:${p.probability}%;background:var(--color-primary);"></div>
          </div>
        </div>
      `).join("")
    : `<p class="text-sm text-muted">${t("symptoms_not_enough_data", "Not enough matching symptoms to estimate probabilities.")}</p>`;

  if (analysis.vitalsFlags.length) {
    qs("#vitalsFlagsBox").style.display = "block";
    qs("#vitalsFlagsList").innerHTML = analysis.vitalsFlags
      .map((f) => `<span class="badge" style="background:${f.severity === 2 ? "var(--tint-coral)" : "var(--tint-amber)"};color:${f.severity === 2 ? "var(--color-coral)" : "var(--color-amber)"};padding:4px 10px;border-radius:20px;font-size:0.78rem;font-weight:700;margin:0 6px 6px 0;display:inline-block;">${f.label}</span>`)
      .join("");
  } else {
    qs("#vitalsFlagsBox").style.display = "none";
  }
}

function renderConditionsList(analysis) {
  qs("#conditionsList").innerHTML = analysis.conditions.length
    ? analysis.conditions.map((c) => `<div class="flex gap-12"><span class="stat-icon icon-blue" style="width:32px;height:32px;font-size:1rem;margin:0;flex-shrink:0;">🩺</span><span>${c}</span></div>`).join("")
    : `<p class="text-sm text-muted">${t("symptoms_no_conditions_matched", "No specific conditions strongly matched — that's often a good sign.")}</p>`;
}

function renderDiseaseInfoCard(info) {
  const box = qs("#diseaseInfoBox");
  if (!info) { box.style.display = "none"; return; }
  box.style.display = "block";
  qs("#diseaseInfoName").textContent = info.name;
  qs("#diseaseInfoDescription").textContent = info.description;
  qs("#diseaseInfoCause").textContent = info.cause;
  qs("#diseaseInfoIncubation").textContent = info.incubation;
  qs("#diseaseInfoRecovery").textContent = info.recoveryTime;
  qs("#diseaseInfoContagious").textContent = info.contagious ? t("common_yes", "Yes") : t("common_no", "No");
  qs("#diseaseInfoBodySystem").textContent = info.bodySystem;
}

function renderLifestyleAdvice(info) {
  const box = qs("#lifestyleAdviceBox");
  if (!info) { box.style.display = "none"; return; }
  box.style.display = "block";

  qs("#lifestyleFoodsList").innerHTML = (info.foods || []).map((f) => `<li>${f}</li>`).join("") || `<li>${t("symptoms_no_specific_recs", "No specific recommendations")}</li>`;
  qs("#lifestyleAvoidList").innerHTML = (info.avoid || []).map((a) => `<li>${a}</li>`).join("") || `<li>${t("symptoms_nothing_specific_avoid", "Nothing specific to avoid")}</li>`;
  qs("#lifestyleHydrationText").textContent = info.hydration || t("symptoms_hydration_fallback", "No specific guidance — drink water regularly.");
  qs("#lifestyleRestText").textContent = info.rest || t("symptoms_rest_fallback", "Get adequate rest based on how you're feeling.");
  qs("#lifestyleExerciseText").textContent = info.exercise || t("symptoms_exercise_fallback", "Listen to your body; ease back into activity as you recover.");
  qs("#lifestyleWarningsList").innerHTML = (info.warnings || []).map((w) => `<li>${w}</li>`).join("") || `<li>${t("symptoms_warnings_fallback", "Seek care if symptoms worsen or don't improve")}</li>`;
}

function renderLabTests(info) {
  const box = qs("#labTestsBox");
  if (!info || !info.labTests?.length) { box.style.display = "none"; return; }
  box.style.display = "block";
  qs("#labTestsList").innerHTML = info.labTests.map((test) => `<li>${test}</li>`).join("");
}

// The symptom checker's doctorType strings are written for readability
// ("Psychiatrist or Clinical Psychologist", "Dermatologist or General
// Physician", etc.) and don't always match a specialty name exactly in
// the appointment booking system's specialty list. Map each known
// variant onto the closest bookable specialty so the "Book a doctor"
// link can pre-select the right one. The AI is instructed to always
// return doctorType as one of these exact English values (regardless of
// the response language) so this mapping — and the specialty link —
// keep working; doctorTypeLabel carries the localized text to display.
const DOCTOR_TYPE_TO_SPECIALTY = {
  "General Physician": "General Physician",
  "Cardiologist": "Cardiologist",
  "Dermatologist": "Dermatologist",
  "Dermatologist or General Physician": "Dermatologist",
  "Gynecologist & Obstetrician": "Gynecologist & Obstetrician",
  "Orthopedic Surgeon": "Orthopedic Surgeon",
  "Neurologist": "Neurologist",
  "ENT Specialist": "ENT Specialist",
  "Pediatrician": "Pediatrician",
  "Dentist": "Dentist",
  "Psychiatrist": "Psychiatrist",
  "Psychiatrist or Clinical Psychologist": "Psychiatrist",
  "Endocrinologist (Diabetes)": "Endocrinologist (Diabetes)",
  "Gastroenterologist": "Gastroenterologist",
  "Nephrologist": "Nephrologist",
  "Urologist": "Urologist",
  "Ophthalmologist": "Ophthalmologist",
  "Allergist": "General Physician",
  "Pulmonologist": "General Physician",
  "Hematologist": "General Physician",
  "Infectious Disease Specialist": "General Physician",
  "Emergency Physician": "General Physician"
};

function specialtyForDoctorType(doctorType) {
  return DOCTOR_TYPE_TO_SPECIALTY[doctorType] || "General Physician";
}

function renderDoctorRecommendation(info) {
  const box = qs("#doctorRecBox");
  if (!info) { box.style.display = "none"; return; }
  box.style.display = "block";
  qs("#doctorRecType").textContent = info.doctorTypeLabel || info.doctorType;
  qs("#doctorRecReason").textContent = t("symptoms_doctor_reason", "Based on a possible match with {condition} ({system}).")
    .replace("{condition}", info.name)
    .replace("{system}", (info.bodySystem || "").toLowerCase());

  const specialty = specialtyForDoctorType(info.doctorType);
  const link = qs("#doctorRecBookLink");
  if (link) {
    link.href = `appointment.html?specialty=${encodeURIComponent(specialty)}&autofind=1`;
  }
}

function renderPreventionChecklist(analysis) {
  const tips = generalPreventionTips();
  if (analysis.conditionInfo?.prevention?.length) tips.push(...analysis.conditionInfo.prevention);

  const uniqueTips = [...new Set(tips)];
  qs("#preventionList").innerHTML = uniqueTips.map((tip, i) => `
    <label class="flex gap-12" style="align-items:center;padding:8px 0;">
      <input type="checkbox" class="prevention-check" data-tip="${tip.replace(/"/g, "&quot;")}" id="prevTip${i}" />
      <span class="text-sm">${tip}</span>
    </label>
  `).join("");

  qsa(".prevention-check").forEach((box) => {
    box.addEventListener("change", async (e) => {
      if (!e.target.checked) return;
      await supabaseClient.from("prevention_history").insert({
        user_id: symptomUser.id,
        symptom_log_id: lastAnalysis?.symptomLogId || null,
        tip: e.target.dataset.tip,
        condition: analysis.topCondition || null
      });
      showToast(t("toast_symptoms_logged_done", "Nice — logged as done."), "success", 2000);
    });
  });
}

function renderMedicineSuggestions(suggestions, isUrgent) {
  const section = qs("#medicineSuggestions");
  const list = qs("#medicineSuggestionList");

  if (isUrgent) {
    // Don't suggest OTC medicine for potentially serious/urgent symptoms —
    // the urgent notice already directs the person to seek medical care.
    section.style.display = "none";
    return;
  }

  if (!Array.isArray(suggestions) || !suggestions.length) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  list.innerHTML = suggestions.map((med) => {
    const name = med.name || "";
    const dosage = med.dosage || "";
    const frequency = med.frequency || "";
    const params = new URLSearchParams({ name, dosage, frequency });
    return `
      <div class="card" style="padding:16px;">
        <div class="flex-between" style="align-items:flex-start;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:700;">${name}</div>
            <div class="text-sm text-muted mt-6">${dosage} · ${frequency}</div>
            <div class="text-sm mt-8">${med.note || ""}</div>
            ${med.sideEffects ? `<div class="text-sm text-muted mt-8"><strong>${t("med_side_effects_label", "Possible side effects:")}</strong> ${med.sideEffects}</div>` : ""}
          </div>
          <a href="medicine.html?${params.toString()}" class="btn btn-outline btn-sm">${t("symptoms_add_to_reminders_btn", "Add to Medicine Reminders →")}</a>
        </div>
      </div>
    `;
  }).join("");
}

async function loadSymptomHistory() {
  const { data, error } = await supabaseClient
    .from("symptom_logs")
    .select("*")
    .eq("user_id", symptomUser.id)
    .order("created_at", { ascending: false })
    .limit(6);

  const container = qs("#symptomHistoryList");

  if (error || !data || !data.length) {
    container.innerHTML = `<p class="text-sm text-muted">No past checks yet.</p>`;
    return;
  }

  container.innerHTML = data.map((row) => `
    <div style="padding:10px 0;border-bottom:1px solid var(--color-border);">
      <div class="flex-between" style="flex-wrap:wrap;gap:8px;">
        <span style="font-weight:600;font-size:0.9rem;">${row.symptoms.join(", ")}</span>
        <span class="text-sm text-muted">${formatDate(row.created_at)}</span>
      </div>
      <div class="text-sm text-muted mt-8">${(row.possible_conditions || []).join(", ") || "No conditions flagged"}</div>
      ${row.risk_level ? `<span class="badge" style="background:var(--color-primary-light);color:var(--color-primary);padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;display:inline-block;margin-top:6px;">${row.risk_level} risk · severity ${row.severity_score ?? "—"}</span>` : ""}
    </div>
  `).join("");
}

/* -------------------------------------------------------------------------
   Reports — Download (print-to-PDF), Print, Email, Share, QR Code.
   No paid services required: printing uses the browser's native "Save as
   PDF" destination, and the QR code uses the free api.qrserver.com image API.
   ------------------------------------------------------------------------- */
function buildReportSummaryText() {
  if (!lastAnalysis) return "";
  const a = lastAnalysis;
  const lines = [
    `NutriHealth — Symptom Check Report`,
    `Date: ${new Date().toLocaleString()}`,
    `Patient: ${symptomProfile?.name || symptomUser.email}`,
    ``,
    `Symptoms: ${a.selected.join(", ")}`,
    `Possible conditions: ${a.conditions.join(", ") || "None strongly matched"}`,
    `Severity: ${a.severity}/100 | Confidence: ${a.confidence}% | Risk level: ${a.riskLevel}`,
    `Recommendation: ${a.recommendation}`
  ];
  if (a.conditionInfo) {
    lines.push(``, `Top match: ${a.conditionInfo.name}`, a.conditionInfo.description, `Suggested specialist: ${a.conditionInfo.doctorType}`);
  }
  return lines.join("\n");
}

function buildDoctorSummaryText() {
  if (!lastAnalysis) return "";
  const a = lastAnalysis;
  const lines = [
    `NutriHealth — Clinical Summary (patient-generated, for physician review)`,
    `Generated: ${new Date().toLocaleString()}`,
    `Patient: ${symptomProfile?.name || symptomUser.email}`,
    ``,
    `Reported symptoms: ${a.selected.join(", ")}`,
    `AI severity score: ${a.severity}/100`,
    `AI confidence: ${a.confidence}%`,
    `Risk level: ${a.riskLevel}`
  ];

  if (a.probabilities?.length) {
    lines.push(``, `Differential (rule-based probability):`);
    a.probabilities.forEach((p) => lines.push(`  - ${p.name}: ${p.probability}%`));
  }

  if (a.vitalsFlags?.length) {
    lines.push(``, `Abnormal vitals flagged:`);
    a.vitalsFlags.forEach((f) => lines.push(`  - ${f.label}`));
  }

  if (a.conditionInfo) {
    const info = a.conditionInfo;
    lines.push(
      ``,
      `Top match: ${info.name}`,
      `Body system: ${info.bodySystem || "—"}`,
      `Typical incubation: ${info.incubation || "—"} | Recovery: ${info.recoveryTime || "—"} | Contagious: ${info.contagious ? "Yes" : "No"}`,
      `Suggested lab tests: ${(info.labTests || []).join(", ") || "None specific"}`,
      `Suggested specialist: ${info.doctorType || "General Physician"}`
    );
  }

  lines.push(``, `Note: generated by an educational AI symptom checker, not a diagnosis. Please correlate clinically.`);
  return lines.join("\n");
}

async function generateReport(method) {
  if (!lastAnalysis) {
    showToast(t("toast_symptoms_run_first_report", "Run a symptom check first to generate a report."), "warning");
    return;
  }

  const summary = buildReportSummaryText();

  // Log this report generation, but never let a DB hiccup here block the
  // actual user-facing action below (download/print/email/share/qr).
  supabaseClient.from("reports").insert({
    user_id: symptomUser.id,
    symptom_log_id: lastAnalysis.symptomLogId,
    report_type: "symptom_check",
    delivery_method: method,
    summary
  }).then(({ error }) => {
    if (error) console.warn("Report logging failed (non-blocking):", error.message);
  });

  if (method === "download" || method === "print") {
    document.title = `NutriHealth-Symptom-Report-${todayDateStr()}`;
    window.print();
    return;
  }

  if (method === "email") {
    const subject = encodeURIComponent("My NutriHealth Symptom Report");
    const body = encodeURIComponent(summary);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
    return;
  }

  if (method === "share") {
    if (navigator.share) {
      try {
        await navigator.share({ title: "NutriHealth Symptom Report", text: summary });
      } catch (err) {
        console.warn("Share cancelled or failed:", err);
      }
    } else {
      await navigator.clipboard?.writeText(summary);
      showToast(t("toast_symptoms_share_unsupported", "Sharing isn't supported on this browser — summary copied to clipboard instead."), "info", 4000);
    }
    return;
  }

  if (method === "qr") {
    const box = qs("#reportQrBox");
    const img = qs("#reportQrImage");
    const statusEl = qs("#reportQrStatus");
    const linkEl = qs("#reportQrOpenLink");

    // QR codes have a practical data-capacity ceiling — keep well under it
    // so the third-party generator doesn't reject an overlong payload.
    const encoded = encodeURIComponent(summary.slice(0, 500));
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encoded}`;

    box.style.display = "block";
    img.style.display = "none";
    if (statusEl) { statusEl.style.display = "block"; statusEl.textContent = t("symptoms_generating_qr", "Generating QR code..."); }
    if (linkEl) linkEl.style.display = "none";

    img.onload = () => {
      if (statusEl) statusEl.style.display = "none";
      img.style.display = "inline-block";
      if (linkEl) { linkEl.href = qrUrl; linkEl.style.display = "inline-block"; }
    };
    img.onerror = () => {
      if (statusEl) {
        statusEl.style.display = "block";
        statusEl.textContent = "Couldn't load the QR code (the QR service may be blocked or unreachable on this network).";
      }
      if (linkEl) { linkEl.href = qrUrl; linkEl.style.display = "inline-block"; }
      showToast("QR code service didn't respond. Try the direct link below, or check your network/ad-blocker.", "error", 5000);
    };

    img.src = qrUrl;
  }
}

async function generateDoctorSummary() {
  if (!lastAnalysis) {
    showToast(t("toast_symptoms_run_first_doctor", "Run a symptom check first to generate a doctor summary."), "warning");
    return;
  }

  const doctorSummary = buildDoctorSummaryText();

  await supabaseClient.from("reports").insert({
    user_id: symptomUser.id,
    symptom_log_id: lastAnalysis.symptomLogId,
    report_type: "symptom_check",
    delivery_method: "doctor_summary",
    summary: doctorSummary
  });

  try {
    await navigator.clipboard.writeText(doctorSummary);
    showToast(t("toast_symptoms_doctor_copied", "Doctor summary copied — paste it into an email or message to your physician."), "success", 4500);
  } catch (err) {
    console.warn("Clipboard write failed:", err);
    const subject = encodeURIComponent("Clinical summary from NutriHealth");
    const body = encodeURIComponent(doctorSummary);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }
}
// ================= AI Symptom Chat =================
(function initSymptomChat() {
  const form = qs("#symptomChatForm");
  const input = qs("#symptomChatInput");
  const log = qs("#symptomChatLog");
  if (!form || !input || !log) return; // page doesn't have the chat panel

  let history = [];

  const autoSpeak = typeof VoiceHelper !== "undefined"
    ? VoiceHelper.attachAutoSpeakToggle(qs("#symptomChatVoiceToggle"), "nh_symptomchat_autospeak")
    : { isEnabled: () => false };

  if (typeof VoiceHelper !== "undefined") {
    VoiceHelper.attachMic(qs("#symptomChatVoiceInputBtn"), input, {
      onEnd: (transcript) => {
        if (transcript) {
          input.value = transcript;
          form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
        }
      }
    });

    // Always-visible "Stop talking" control, same as the main chatbot.
    const stopBar = qs("#symptomChatVoiceStopBar");
    qs("#symptomChatStopTalkingBtn")?.addEventListener("click", () => VoiceHelper.stopSpeaking());
    VoiceHelper.onSpeakStateChange((speaking) => {
      if (stopBar) stopBar.style.display = speaking ? "flex" : "none";
    });
  }

  function bubble(role, text) {
    const div = document.createElement("div");
    div.style.cssText = role === "user"
      ? "align-self:flex-end;background:var(--color-primary);color:#06231c;padding:10px 14px;border-radius:14px 14px 2px 14px;max-width:80%;"
      : "align-self:flex-start;background:var(--color-surface-raised);color:var(--color-ink);border:1px solid var(--color-border);padding:10px 14px;border-radius:14px 14px 14px 2px;max-width:80%;";
    div.className = "text-sm";
    div.textContent = text;
    log.appendChild(div);

    if (role === "assistant" && typeof VoiceHelper !== "undefined" && VoiceHelper.isSynthesisSupported()) {
      const speakBtn = document.createElement("button");
      speakBtn.type = "button";
      speakBtn.className = "chat-bubble-speak-btn";
      speakBtn.style.alignSelf = "flex-start";
      speakBtn.textContent = "🔊 Listen";
      speakBtn.addEventListener("click", () => VoiceHelper.speakWithButton(text, speakBtn));
      log.appendChild(speakBtn);
      div.dataset.hasSpeakBtn = "1";
      div._speakBtn = speakBtn;
    }

    log.scrollTop = log.scrollHeight;
    return div;
  }

  async function callSymptomChat(messages) {
    try {
      const { data, error } = await supabaseClient.functions.invoke("symptom-chat", {
        body: { messages }
      });
      if (error) {
        console.warn("Symptom chat function error:", error);
        return { ok: false, message: "Something went wrong. Please try again." };
      }
      if (data?.ok === false) {
        return { ok: false, message: data.error || "Something went wrong. Please try again." };
      }
      if (!data?.reply) {
        return { ok: false, message: "The assistant didn't return a reply. Please try again." };
      }
      return { ok: true, reply: data.reply };
    } catch (err) {
      console.warn("Symptom chat network error:", err);
      return { ok: false, message: "Network error. Please try again." };
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    bubble("user", text);
    history.push({ role: "user", content: text });
    input.value = "";
    input.disabled = true;

    const typing = bubble("assistant", "Typing...");
    const { ok, reply, message } = await callSymptomChat(history);
    typing.remove();

    if (!ok) {
      bubble("assistant", message);
    } else {
      const bubbleEl = bubble("assistant", reply);
      history.push({ role: "assistant", content: reply });
      if (autoSpeak.isEnabled() && typeof VoiceHelper !== "undefined" && bubbleEl._speakBtn) {
        VoiceHelper.speakWithButton(reply, bubbleEl._speakBtn);
      }
    }

    input.disabled = false;
    input.focus();
  });

  bubble("assistant", "Hi, I'm here to help you think through what you're feeling. What symptoms are you noticing, and when did they start? (If this is an emergency, please call your local emergency number right away.)");
})();