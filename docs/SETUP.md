# NutriHealth — Setup Guide (Module 1: Foundation & Authentication)

This is **Module 1** of the project, built module-by-module as requested.

## ✅ What's included in this module

```
NutriHealthAI/
├── index.html            # Home page
├── about.html            # About Us
├── features.html         # Features overview
├── contact.html          # Contact form (UI only, not yet wired to a table)
├── login.html            # Login (Supabase Auth)
├── register.html         # Register (Supabase Auth)
├── forgot-password.html  # Password reset request
├── config.js             # Supabase keys + shared constants
├── css/
│   └── style.css         # Full design system (used by every page)
├── js/
│   ├── ui.js              # Toasts, loader, dark mode, mobile nav
│   └── auth.js            # Sign up / log in / log out / session guard
├── sql/
│   └── schema.sql         # ALL 8 tables + Row Level Security policies
└── docs/
    └── SETUP.md           # This file
```

**Not yet built** (coming in the next modules): `dashboard.html`, `bmi.html`,
`symptoms.html`, `nutrition.html`, `diet-plan.html`, `exercise.html`,
`water.html`, `medicine.html`, `sleep.html`, `scanner.html`, `recipes.html`,
`chatbot.html` and their matching `js/*.js` files. `PROTECTED_PAGES` in
`config.js` already lists them so route protection is ready the moment
they're added.

---

## Step 1 — Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**.
2. Choose a name, database password, and region. Wait ~2 minutes for it to provision.
3. In the left sidebar go to **Project Settings → API**. Copy:
   - **Project URL**
   - **anon public** key (NOT the `service_role` key — never expose that one)

## Step 2 — Add your keys to the project

Open `config.js` and replace the placeholders:

```js
const SUPABASE_URL = "https://xxxxxxxxxxxx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

## Step 3 — Create the database tables

1. In Supabase, open the **SQL Editor** → **New query**.
2. Paste the entire contents of `sql/schema.sql`.
3. Click **Run**.

This creates all 8 tables (`users`, `bmi_logs`, `symptom_logs`, `water_logs`,
`medicine_reminders`, `sleep_logs`, `food_scans`, plus `nutrition_plans` and
`diet_plans` used by later modules), turns on **Row Level Security** for
every one of them, and adds a trigger so a `public.users` profile row is
created automatically whenever someone signs up.

## Step 4 — Configure authentication

1. Go to **Authentication → Providers** and confirm **Email** is enabled (it is by default).
2. While developing, you can turn **off** "Confirm email" under
   **Authentication → Settings** so new accounts can log in immediately
   without clicking an email link. Turn it back on before a real launch.
3. Go to **Authentication → URL Configuration** and set your **Site URL**
   (e.g. `http://localhost:5500` if using VS Code Live Server, or your
   deployed URL later) — this is required for the "forgot password" email
   link to redirect correctly.

## Step 5 — Set Edge Function secrets

This app runs entirely on **Groq** (free, no credit card required) for every
AI feature — no OpenAI key needed anywhere:

- **Chatbot** (`supabase/functions/chat`) needs `GROQ_API_KEY`
- **Symptom Checker's "AI Symptom Chat"** (`supabase/functions/symptom-chat`)
  needs `GROQ_API_KEY` — without it, the chat widget on the Symptom Checker
  page will show an error on every message instead of a reply.
- **Food tracker, Recipes, Diet plan, Food scanner** (`supabase/functions/spoonacular`)
  need `SPOONACULAR_API_KEY` — get a free key at
  [spoonacular.com/food-api](https://spoonacular.com/food-api)
- **Food Scanner's "Scan a photo" tab** (`supabase/functions/food-vision`)
  needs `GROQ_API_KEY` to identify food and estimate calories from a photo
  — without it, the photo tab will show an error and only the text-search
  tab will work.
- **Optional:** `GROQ_API_KEY` also lets Food Tracker, Recipes, Diet Plan,
  and the Scanner's *text* search fall back to AI-generated results
  (clearly labeled 🤖 in the UI) whenever Spoonacular is unavailable or its
  daily quota is exhausted — ingredient nutrition, recipe search/details,
  and full-day meal plans all have this fallback. Skip setting it if you'd
  rather those features just show an error instead of an unverified
  AI answer.
- **Food Scanner's "Scan a photo" tab** also retries automatically with
  backoff if Groq's vision model returns a transient error (e.g. a 503
  "over capacity" response) before giving up.

Get a free Groq key at [console.groq.com](https://console.groq.com) — one
key covers every AI feature above.

- **Optional:** `PEXELS_API_KEY` lets AI-generated recipes (from the
  Groq fallback above) show a representative food photo instead of no
  image at all. It's a keyword match against Pexels' stock photo
  library, not a verified photo of that exact dish, so the UI always
  labels it "Representative photo" with a credit link — it's never
  presented as a real photo of the AI-suggested recipe. Get a free key
  at [pexels.com/api](https://www.pexels.com/api/). Skip it if you'd
  rather AI recipes just show no image.

Set them with the Supabase CLI:

```bash
supabase secrets set GROQ_API_KEY=your-groq-key
supabase secrets set SPOONACULAR_API_KEY=your-spoonacular-key
supabase secrets set PEXELS_API_KEY=your-pexels-key
```

Or in the dashboard: **Project Settings → Edge Functions → Secrets**.

Then deploy the functions:

```bash
supabase functions deploy chat
supabase functions deploy symptom-chat
supabase functions deploy spoonacular
supabase functions deploy food-vision
```

## Step 6 — Run the project locally

No build step is required — this is plain HTML/CSS/JS.

- **Easiest:** install the "Live Server" extension in VS Code, right-click
  `index.html` → **Open with Live Server**.
- **Alternative:** run `npx serve` from the project folder, or open
  `index.html` directly in a browser (some Supabase calls work better
  served over `http://` than `file://`, so Live Server is recommended).

## Step 7 — Test the auth flow

1. Open the site → **Get started** → fill out **Register**.
2. Check the Supabase **Table Editor → users** table — a row should appear
   automatically.
3. Log in with the same account on **login.html**.
4. `dashboard.html` (Module 2) will use `requireAuth()` from `js/auth.js`
   to block access unless you're logged in.

---

## How the auth code works (for learning)

- `js/auth.js` wraps every Supabase Auth call: `handleRegister()`,
  `handleLogin()`, `handleLogout()`, `handleForgotPassword()`.
- `requireAuth()` — call this at the top of any protected page's JS file.
  It checks for a session and redirects to `login.html` if there isn't one.
- `redirectIfLoggedIn()` — used on `login.html`/`register.html` so an
  already-logged-in user skips straight to the dashboard.
- Row Level Security in `schema.sql` means even if someone tampered with
  frontend code, Postgres itself refuses to return another user's rows —
  `auth.uid() = user_id` is enforced on every table.

## Next modules (in order)

1. **Dashboard shell + sidebar layout** — `dashboard.html`, `js/dashboard.js`
2. **BMI Calculator** — `bmi.html`, `js/bmi.js`
3. **Water Intake Tracker** — `water.html`, `js/water.js`
4. **Sleep & Stress Tracker** — `sleep.html`, `js/sleep.js`
5. **Medicine Reminders** — `medicine.html`, `js/medicine.js`
6. **Symptom Checker** — `symptoms.html`, `js/symptoms.js`
7. **Nutrition Recommendation + Diet Plan Generator**
8. **Exercise Recommendation**
9. **Food Scanner**
10. **Recipe Recommendation**
11. **AI Health Chatbot**

Say "continue with Module 2" (or name a specific module) and it'll be built
directly on top of this foundation.

---

## Reminder Engine + WhatsApp Integration

The Reminder Center (`reminders.html`) now has a centralized, timezone-aware
backend engine plus optional WhatsApp delivery (with automatic browser/
in-app fallback). This needs a couple of extra one-time setup steps
(Edge Function secrets + scheduling a cron tick) — see
[`docs/REMINDER_ENGINE.md`](./REMINDER_ENGINE.md).
