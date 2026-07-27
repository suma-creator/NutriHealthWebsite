/* =========================================================================
   config.js
   -------------------------------------------------------------------------
   Central configuration file for NutriHealth.
   ========================================================================= */

/* ---------------- Supabase Configuration ---------------- */
const SUPABASE_URL = "https://umhyklqhzxcblwiheeuq.supabase.co";

const SUPABASE_ANON_KEY =
  "sb_publishable_Ja--_RmO1TIG-zPQBAjgiQ_PhC8oBc6";

/* Validate configuration */
const SUPABASE_CONFIG_VALID =
  typeof SUPABASE_URL === "string" &&
  typeof SUPABASE_ANON_KEY === "string" &&
  SUPABASE_URL.startsWith("https://") &&
  SUPABASE_URL.includes(".supabase.co") &&
  !SUPABASE_URL.includes("YOUR_") &&
  (
    SUPABASE_ANON_KEY.startsWith("eyJ") ||
    SUPABASE_ANON_KEY.startsWith("sb_publishable_")
  );

/* Create shared Supabase client */
const supabaseClient = SUPABASE_CONFIG_VALID
  ? window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY
    )
  : null;

/* Show helpful error if configuration is invalid */
if (!SUPABASE_CONFIG_VALID) {
  console.error(
    "Invalid Supabase configuration. Check SUPABASE_URL and SUPABASE_ANON_KEY."
  );
}

/* ---------------- App Configuration ---------------- */

const APP_NAME = "NutriHealth";

/* Public routes */
const PUBLIC_PAGES = [
  "index.html",
  "about.html",
  "features.html",
  "contact.html",
  "login.html",
  "register.html",
  "forgot-password.html"
];

/* Authentication routes */
const LOGIN_ROUTE = "login.html";
const DASHBOARD_ROUTE = "dashboard.html";

/* Protected pages */
const PROTECTED_PAGES = [
  "dashboard.html",
  "bmi.html",
  "symptoms.html",
  "nutrition.html",
  "nutrition-report.html",
  "diet-plan.html",
  "exercise.html",
  "water.html",
  "medicine.html",
  "sleep.html",
  "scanner.html",
  "recipes.html",
  "chatbot.html",
  "profile.html",
  "food-tracker.html",
  "health-score.html",
  "health-calendar.html",
  "settings.html",
  "appointment.html",
  "grocery.html",
  "journal.html",
  "gallery.html",
  "reminders.html"
];

/* ---------------- Optional AI Configuration ---------------- */

/*
   Spoonacular (food tracker, recipes, diet plan, food scanner) is called
   through the "spoonacular" Supabase Edge Function, not from the browser.
   Set the key as a Supabase secret instead of putting it here:

     supabase secrets set SPOONACULAR_API_KEY=your-key-here

   Get a free key at https://spoonacular.com/food-api
*/

/*
   The chatbot, symptom chat, recipe/diet-plan/scanner AI fallbacks, and
   photo food-scanning all run through Supabase Edge Functions using
   GROQ_API_KEY (set as a Supabase secret — see docs/SETUP.md), not from
   the browser. This app doesn't use OpenAI anywhere.

   AI_API_KEY/AI_API_URL below are an optional escape hatch only: if you
   fill them in, the Symptom Checker's one-shot AI explanation will use
   them as a last-resort client-side fallback if the Supabase "chat"
   function is unreachable. Leave them blank (default) to skip this —
   nothing calls out to them otherwise. If you do set AI_API_KEY, do NOT
   put a real secret key here for anything but local testing, since
   client-side code is visible to anyone using the site.
*/

const AI_API_KEY = "";
const AI_API_URL = "";
