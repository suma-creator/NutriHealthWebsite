-- =========================================================================
-- NutriHealth — Supabase / PostgreSQL Schema
-- ---------------------------------------------------------------------
-- HOW TO RUN:
--   1. Open your Supabase project → SQL Editor → New query.
--   2. Paste this whole file and click "Run".
--   3. This creates every table, enables Row Level Security (RLS), and
--      adds policies so each user can only see/edit their own data.
-- =========================================================================

-- Extension needed for gen_random_uuid()
create extension if not exists "pgcrypto";

-- =========================================================================
-- 1. USERS  (profile data — separate from Supabase's built-in auth.users)
-- =========================================================================
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  email       text not null,
  age         int,
  gender      text check (gender in ('male', 'female', 'other')),
  height      numeric,   -- cm
  weight      numeric,   -- kg
  created_at  timestamptz default now()
);

alter table public.users enable row level security;

create policy "Users can view their own profile"
  on public.users for select using (auth.uid() = id);
create policy "Users can update their own profile"
  on public.users for update using (auth.uid() = id);
create policy "Users can insert their own profile"
  on public.users for insert with check (auth.uid() = id);

-- Auto-create a public.users row whenever someone signs up via Supabase Auth.
-- This is a safety net alongside the insert done in js/auth.js.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', 'User'), new.email)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =========================================================================
-- 2. BMI LOGS
-- =========================================================================
create table if not exists public.bmi_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete cascade,
  height      numeric not null,
  weight      numeric not null,
  bmi         numeric not null,
  category    text not null,
  created_at  timestamptz default now()
);

alter table public.bmi_logs enable row level security;
create policy "Users manage their own bmi logs"
  on public.bmi_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 3. SYMPTOM LOGS
-- =========================================================================
create table if not exists public.symptom_logs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references public.users(id) on delete cascade,
  symptoms              text[] not null,
  possible_conditions   text[] ,
  recommendations       text,
  -- Added for the AI Symptom Checker enhancement (severity/probability/
  -- confidence/risk scoring, AI-generated summary, and captured vitals).
  severity_score        int,              -- 0-100
  confidence            int,              -- 0-100
  risk_level            text check (risk_level in ('Low', 'Moderate', 'High', 'Urgent')),
  ai_summary            text,             -- AI Health Summary shown on the result card
  ai_explanation        text,             -- Longer AI-generated explanation (optional, from the chat AI backend)
  vitals                jsonb,            -- { temperature, heartRate, bpSystolic, bpDiastolic, oxygenSaturation, respiratoryRate, bloodSugar }
  free_text_description text,             -- User's own words, if they used free-text input instead of/alongside the checklist
  created_at            timestamptz default now()
);

alter table public.symptom_logs enable row level security;
create policy "Users manage their own symptom logs"
  on public.symptom_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Safe to re-run: adds the new columns above to an existing table that was
-- created before this update, without touching any existing data.
alter table public.symptom_logs add column if not exists severity_score int;
alter table public.symptom_logs add column if not exists confidence int;
alter table public.symptom_logs add column if not exists risk_level text;
alter table public.symptom_logs add column if not exists ai_summary text;
alter table public.symptom_logs add column if not exists ai_explanation text;
alter table public.symptom_logs add column if not exists vitals jsonb;
alter table public.symptom_logs add column if not exists free_text_description text;

-- =========================================================================
-- 3b. VITAL SIGNS  (standalone log so vitals can be tracked over time,
--     independent of a specific symptom check, and charted on the dashboard)
-- =========================================================================
create table if not exists public.vital_signs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references public.users(id) on delete cascade,
  symptom_log_id        uuid references public.symptom_logs(id) on delete set null,
  temperature           numeric,   -- °C
  heart_rate            numeric,   -- bpm
  bp_systolic           numeric,   -- mmHg
  bp_diastolic          numeric,   -- mmHg
  oxygen_saturation     numeric,   -- %
  respiratory_rate      numeric,   -- breaths/min
  blood_sugar           numeric,   -- mg/dL
  bmi                   numeric,   -- pulled from bmi_logs at capture time
  created_at            timestamptz default now()
);

alter table public.vital_signs enable row level security;
create policy "Users manage their own vital signs"
  on public.vital_signs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 3c. REPORTS  (records every generated symptom/health report so the
--     dashboard can show "Latest Report" and users can revisit past ones)
-- =========================================================================
create table if not exists public.reports (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references public.users(id) on delete cascade,
  symptom_log_id    uuid references public.symptom_logs(id) on delete cascade,
  report_type       text not null default 'symptom_check', -- 'symptom_check' | 'nutrition' | ...
  delivery_method   text,      -- 'download' | 'print' | 'email' | 'share' | 'qr'
  summary           text,      -- short plain-text summary snapshot at generation time
  created_at        timestamptz default now()
);

alter table public.reports enable row level security;
create policy "Users manage their own reports"
  on public.reports for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 3d. PREVENTION HISTORY  (tracks which prevention tips a user has
--     acknowledged/completed from a symptom check, e.g. "Vaccination reminders")
-- =========================================================================
create table if not exists public.prevention_history (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references public.users(id) on delete cascade,
  symptom_log_id    uuid references public.symptom_logs(id) on delete cascade,
  tip               text not null,
  condition         text,
  completed_at      timestamptz default now()
);

alter table public.prevention_history enable row level security;
create policy "Users manage their own prevention history"
  on public.prevention_history for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 4. WATER LOGS
-- =========================================================================
create table if not exists public.water_logs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references public.users(id) on delete cascade,
  recommended_water   numeric not null, -- ml
  consumed_water      numeric default 0, -- ml
  log_date            date default current_date,
  created_at          timestamptz default now()
);

alter table public.water_logs enable row level security;
create policy "Users manage their own water logs"
  on public.water_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 5. MEDICINE REMINDERS
-- =========================================================================
create table if not exists public.medicine_reminders (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.users(id) on delete cascade,
  medicine_name  text not null,
  dosage         text,
  time           time not null,
  frequency      text not null, -- e.g. 'Daily', 'Twice a day', 'Weekly'
  created_at     timestamptz default now()
);

alter table public.medicine_reminders enable row level security;
create policy "Users manage their own medicine reminders"
  on public.medicine_reminders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 6. SLEEP LOGS
-- =========================================================================
create table if not exists public.sleep_logs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.users(id) on delete cascade,
  sleep_hours   numeric not null,
  stress_level  int check (stress_level between 1 and 10),
  created_at    timestamptz default now()
);

-- Sleep Information upgrade — the log form now captures the actual clock
-- times instead of only a duration. sleep_hours above is still always
-- populated (computed client-side from these two times, wrapping past
-- midnight correctly) so every existing average/report/dashboard
-- calculation keeps working unchanged; these are purely additive detail.
alter table public.sleep_logs add column if not exists sleep_time time;
alter table public.sleep_logs add column if not exists wake_time time;

alter table public.sleep_logs enable row level security;
create policy "Users manage their own sleep logs"
  on public.sleep_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 7. FOOD SCANS
-- =========================================================================
create table if not exists public.food_scans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete cascade,
  food_name   text not null,
  calories    numeric,
  protein     numeric,
  carbs       numeric,
  fat         numeric,
  image_url   text,
  created_at  timestamptz default now()
);

alter table public.food_scans enable row level security;
create policy "Users manage their own food scans"
  on public.food_scans for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 8. NUTRITION PLANS  (results from the Nutrition Recommendation module)
-- =========================================================================
create table if not exists public.nutrition_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete cascade,
  goal        text not null,
  calories    numeric not null,
  protein_g   numeric not null,
  carbs_g     numeric not null,
  fat_g       numeric not null,
  created_at  timestamptz default now()
);

alter table public.nutrition_plans enable row level security;
create policy "Users manage their own nutrition plans"
  on public.nutrition_plans for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 9. DIET PLANS  (generated meal plans)
-- =========================================================================
create table if not exists public.diet_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete cascade,
  goal        text not null,
  breakfast   text,
  lunch       text,
  dinner      text,
  snacks      text,
  created_at  timestamptz default now()
);

-- Spoonacular recipe ids behind each meal slot, so the Grocery Planner can
-- fetch real ingredient lists for a plan instead of just its title text.
-- (diet-plan.js and grocery.js already read/write these — this migration
-- was the missing piece that made Grocery Planner silently fail.)
alter table public.diet_plans add column if not exists breakfast_id bigint;
alter table public.diet_plans add column if not exists lunch_id bigint;
alter table public.diet_plans add column if not exists dinner_id bigint;
alter table public.diet_plans add column if not exists snack_id bigint;

-- Which cuisine (if any) this plan was generated for — "" / null means
-- "Any / Global" (Spoonacular's default), otherwise one of bangladeshi,
-- indian, pakistani, korean (all AI-generated for authenticity).
alter table public.diet_plans add column if not exists cuisine text;

alter table public.diet_plans enable row level security;
create policy "Users manage their own diet plans"
  on public.diet_plans for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- 10. FAMILY PROFILES (saved "Someone Else" profiles for quick reuse)
--     Powers the "My Profile / Someone Else" selector on the Nutrition,
--     BMI, and Water Intake calculators.
-- =========================================================================
create table if not exists public.family_profiles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete cascade,
  name        text not null,
  age         int,
  gender      text check (gender in ('male', 'female', 'other')),
  height      numeric,   -- cm
  weight      numeric,   -- kg
  created_at  timestamptz default now()
);

alter table public.family_profiles enable row level security;
create policy "Users manage their own family profiles"
  on public.family_profiles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================================
-- Spoonacular response cache
-- Used only by the "spoonacular" Edge Function (via the service role key,
-- which bypasses RLS) to avoid burning API quota on repeat/duplicate
-- lookups. Spoonacular's terms permit caching responses for up to 1 hour;
-- the function enforces that expiry itself. No client-side policies are
-- defined on purpose — this table is never queried directly by the browser.
-- =========================================================================
create table if not exists public.spoonacular_cache (
  cache_key   text primary key,
  response    jsonb not null,
  created_at  timestamptz default now()
);

alter table public.spoonacular_cache enable row level security;

-- =========================================================================
-- Food logs (Food Tracker) — moved from localStorage to a real table so
-- the Health Score system can compute a Nutrition score, and so entries
-- survive across devices/browsers.
-- =========================================================================
create table if not exists public.food_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete cascade,
  log_date    date not null default current_date,
  meal        text not null check (meal in ('breakfast','lunch','dinner','snack')),
  name        text not null,
  calories    numeric not null default 0,
  protein     numeric not null default 0,
  carbs       numeric not null default 0,
  fat         numeric not null default 0,
  is_ai_estimate boolean not null default false,
  created_at  timestamptz default now()
);

-- Migration for existing tables created before is_ai_estimate existed.
alter table public.food_logs add column if not exists is_ai_estimate boolean not null default false;

alter table public.food_logs enable row level security;
create policy "Users manage their own food logs"
  on public.food_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists food_logs_user_date_idx on public.food_logs (user_id, log_date);

-- =========================================================================
-- Exercise logs — the Exercise page previously only showed static
-- recommendations with no history. This table lets users mark a day's
-- workout complete, which the Health Score system uses for its Exercise
-- component (a 7-day completion rate).
-- =========================================================================
create table if not exists public.exercise_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete cascade,
  log_date    date not null default current_date,
  plan_type   text,
  created_at  timestamptz default now(),
  unique (user_id, log_date)
);

alter table public.exercise_logs enable row level security;
create policy "Users manage their own exercise logs"
  on public.exercise_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists exercise_logs_user_date_idx on public.exercise_logs (user_id, log_date);

-- =========================================================================
-- User settings/preferences — used by the Settings page. A single jsonb
-- column is enough since these are simple preference flags, not data that
-- needs its own relational structure.
-- =========================================================================
alter table public.users add column if not exists settings jsonb not null default '{}'::jsonb;

-- IANA time zone (e.g. "Asia/Dhaka", "America/New_York") used by the
-- Reminder Engine to convert each user's local reminder times to UTC
-- correctly. Auto-detected and saved once from the browser (see
-- js/reminders.js), editable later from Settings. Defaults to UTC so
-- nothing breaks for existing rows before that first save happens.
alter table public.users add column if not exists timezone text not null default 'UTC';

-- =========================================================================
-- 11. DOCTOR APPOINTMENTS
--     Powers the Doctor Appointment System. When a user books an
--     appointment, the app randomly assigns a doctor name + hospital
--     (from a curated Bangladesh-based list in appointment.js) so every
--     booking looks like a real, unique assignment.
-- =========================================================================
create table if not exists public.doctor_appointments (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references public.users(id) on delete cascade,
  doctor_name        text not null,
  doctor_degree      text,
  specialty          text not null,
  hospital_name      text not null,
  hospital_location  text,
  appointment_date   date not null,
  appointment_time   time not null,
  reason             text,
  status             text not null default 'upcoming' check (status in ('upcoming', 'completed', 'cancelled')),
  created_at         timestamptz default now()
);

alter table public.doctor_appointments enable row level security;
create policy "Users manage their own doctor appointments"
  on public.doctor_appointments for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists doctor_appointments_user_date_idx
  on public.doctor_appointments (user_id, appointment_date);

-- =========================================================================
-- 12. GROCERY PLANNER
--     Recipe IDs on diet_plans let the Grocery Planner pull each meal's
--     real ingredient list from Spoonacular (via the existing "recipeInfo"
--     action) and turn it into a categorized, checkable shopping list.
-- =========================================================================
alter table public.diet_plans add column if not exists breakfast_id integer;
alter table public.diet_plans add column if not exists lunch_id integer;
alter table public.diet_plans add column if not exists dinner_id integer;
alter table public.diet_plans add column if not exists snack_id integer;

create table if not exists public.grocery_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.users(id) on delete cascade,
  diet_plan_id  uuid references public.diet_plans(id) on delete cascade,
  item_name     text not null,
  category      text not null default 'Other',
  quantity      text,
  is_checked    boolean not null default false,
  created_at    timestamptz default now()
);

alter table public.grocery_items enable row level security;
create policy "Users manage their own grocery items"
  on public.grocery_items for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists grocery_items_user_plan_idx
  on public.grocery_items (user_id, diet_plan_id);

-- =========================================================================
-- 13. FOOD JOURNAL
--     Lets a user save a photo of a meal + how it made them feel, as a
--     personal memory log. Photos are stored as compressed base64 data
--     URLs directly on the row (resized client-side in journal.js) so no
--     Supabase Storage bucket setup is required.
-- =========================================================================
create table if not exists public.food_journal_entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.users(id) on delete cascade,
  entry_date   date not null default current_date,
  title        text,
  meal_type    text check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  mood         text,
  notes        text,
  photo_url    text,
  created_at   timestamptz default now()
);

alter table public.food_journal_entries enable row level security;
create policy "Users manage their own food journal entries"
  on public.food_journal_entries for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists food_journal_user_date_idx
  on public.food_journal_entries (user_id, entry_date desc);

-- =========================================================================
-- 14. FOOD GALLERY
--     A simple photo album organized by meal type (breakfast / lunch /
--     dinner / snack) — separate from the Food Journal, which is for
--     diary-style entries with mood + notes. Photos are stored the same
--     way (compressed base64 data URL, no Storage bucket required).
-- =========================================================================
create table if not exists public.food_gallery_photos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.users(id) on delete cascade,
  meal_type    text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  caption      text,
  photo_url    text not null,
  created_at   timestamptz default now()
);

alter table public.food_gallery_photos enable row level security;
create policy "Users manage their own food gallery photos"
  on public.food_gallery_photos for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists food_gallery_user_meal_idx
  on public.food_gallery_photos (user_id, meal_type, created_at desc);

-- =========================================================================
-- 15. REMINDER CENTER
--     A per-user on/off + time preference for reminder types that don't
--     already have one (water, meal, exercise, sleep). Medicine keeps
--     using the existing medicine_reminders table untouched — its card in
--     the Reminder Center only *reads* medicine_reminders (to show the
--     soonest upcoming time) and uses this table just for its own master
--     on/off notification-preference switch, so medicine.html's behavior
--     is completely unchanged.
-- =========================================================================
create table if not exists public.reminder_settings (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.users(id) on delete cascade,
  reminder_type  text not null check (reminder_type in ('water', 'meal', 'exercise', 'sleep', 'medicine')),
  enabled        boolean not null default false,
  reminder_time  time,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  unique (user_id, reminder_type)
);

-- Sleep Reminder upgrade — additive columns, only ever read/written for
-- reminder_type = 'sleep'. reminder_time above continues to mean
-- "bedtime" for the sleep row (unchanged meaning, unchanged engine
-- behavior). wake_time is new and purely informational + used to compute
-- the "recommended bedtime" suggestion client-side; snooze_minutes is the
-- user's preferred snooze length for the bedtime notification.
alter table public.reminder_settings add column if not exists wake_time time;
alter table public.reminder_settings add column if not exists snooze_minutes int not null default 10
  check (snooze_minutes in (10, 15, 30));
-- Sleep Dashboard — the user's nightly sleep-duration goal (hours). Only
-- ever read/written for reminder_type = 'sleep'; defaults to the commonly
-- recommended 8 hours.
alter table public.reminder_settings add column if not exists goal_hours numeric not null default 8;

alter table public.reminder_settings enable row level security;
create policy "Users manage their own reminder settings"
  on public.reminder_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists reminder_settings_user_idx on public.reminder_settings (user_id);

-- =========================================================================
-- 16. REMINDER ENGINE — extra times per day
--     reminder_settings (section 15) still holds the ONE primary on/off +
--     time per type exactly as before — reminders.html's existing Edit
--     flow is untouched. This table only holds ADDITIONAL times a user
--     adds on top of that primary one (water at 9am AND 3pm AND 8pm,
--     etc.), so "support multiple reminders per day" doesn't require
--     changing how the original single-time card works.
-- =========================================================================
create table if not exists public.reminder_schedules (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.users(id) on delete cascade,
  reminder_type  text not null check (reminder_type in ('water', 'meal', 'exercise', 'sleep')),
  label          text,                 -- optional, e.g. "Lunch", "Evening walk"
  reminder_time  time not null,
  enabled        boolean not null default true,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

alter table public.reminder_schedules enable row level security;
create policy "Users manage their own reminder schedules"
  on public.reminder_schedules for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists reminder_schedules_user_type_idx
  on public.reminder_schedules (user_id, reminder_type);

-- =========================================================================
-- 17. REMINDER HISTORY — the engine's duplicate-prevention ledger
--     Before the Reminder Engine sends anything, it INSERTs a row here
--     first. The unique constraint below means a second attempt at the
--     same (user, type, schedule, local calendar date, local time) is
--     rejected at the database level — so even if the cron tick overlaps,
--     retries, or runs twice, the same reminder can never fire twice.
-- =========================================================================
create table if not exists public.reminder_history (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references public.users(id) on delete cascade,
  reminder_type   text not null,
  source          text not null check (source in ('primary', 'additional', 'medicine', 'sleep_pre_30', 'sleep_pre_15', 'sleep_morning')),
  schedule_id     uuid not null, -- id from reminder_settings, reminder_schedules, or medicine_reminders (polymorphic, no FK)
  scheduled_date  date not null, -- the user's LOCAL calendar date this occurrence was for
  scheduled_time  time not null, -- the user's LOCAL time this occurrence was for
  channel         text check (channel in ('whatsapp', 'browser', 'in_app')),
  status          text not null default 'sent' check (status in ('sent', 'failed', 'skipped')),
  error_message   text,
  sent_at         timestamptz not null default now(),
  unique (user_id, reminder_type, schedule_id, scheduled_date, scheduled_time)
);

-- Widen the allowed `source` values for installs where reminder_history
-- already existed before the Sleep Reminder notification stages were
-- added (the inline check above only applies on first create).
alter table public.reminder_history drop constraint if exists reminder_history_source_check;
alter table public.reminder_history add constraint reminder_history_source_check
  check (source in ('primary', 'additional', 'medicine', 'sleep_pre_30', 'sleep_pre_15', 'sleep_morning'));

alter table public.reminder_history enable row level security;
create policy "Users view their own reminder history"
  on public.reminder_history for select using (auth.uid() = user_id);
-- No insert/update/delete policy for regular users on purpose — only the
-- Reminder Engine edge function (using the service-role key, which
-- bypasses RLS entirely) is allowed to write history rows. This is what
-- makes the dedupe guarantee trustworthy.

create index if not exists reminder_history_user_idx
  on public.reminder_history (user_id, sent_at desc);

-- =========================================================================
-- 18. WHATSAPP REMINDER SETTINGS
--     One row per user. Deliberately has NO client-writable columns via
--     RLS beyond SELECT — the phone number, verification, and on/off
--     state are only ever changed through the "whatsapp-verify" edge
--     function (service role), so a user can never flip verified=true
--     for a number they don't actually control.
-- =========================================================================
create table if not exists public.whatsapp_settings (
  user_id         uuid primary key references public.users(id) on delete cascade,
  phone_number    text,              -- E.164 format, e.g. +8801XXXXXXXXX
  enabled         boolean not null default false,
  verified        boolean not null default false,
  verified_at     timestamptz,
  otp_code_hash   text,
  otp_expires_at  timestamptz,
  otp_attempts    int not null default 0,
  last_send_error text,              -- last WhatsApp send failure, surfaced in Settings for troubleshooting
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.whatsapp_settings enable row level security;
create policy "Users view their own WhatsApp settings"
  on public.whatsapp_settings for select using (auth.uid() = user_id);

-- =========================================================================
-- 19. NOTIFICATIONS — in-app / browser fallback inbox
--     Written by the Reminder Engine (service role) whenever WhatsApp is
--     off, unverified, or fails to send for a given reminder. Read by
--     js/shell.js on every protected page, which shows each unread one
--     as a toast and, if permission was granted, a real browser
--     Notification — then marks it read.
-- =========================================================================
create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.users(id) on delete cascade,
  title         text not null,
  body          text not null,
  reminder_type text,
  is_read       boolean not null default false,
  created_at    timestamptz default now()
);

alter table public.notifications enable row level security;
create policy "Users view their own notifications"
  on public.notifications for select using (auth.uid() = user_id);
create policy "Users mark their own notifications read"
  on public.notifications for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- Inserts are service-role only (Reminder Engine), same reasoning as
-- reminder_history above.

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, is_read, created_at desc);

-- =========================================================================
-- 20a. REMINDER ENGINE PHASE 2 — additive columns + tables only.
--
--     Workout Days / Skip Today (Exercise), full sleep flow + per-schedule
--     snooze (Extra Sleep Times). Nothing below removes or renames any
--     existing column, table, policy, or the meaning of any existing row —
--     see docs/REMINDER_ENGINE.md for the full design notes.
-- =========================================================================

-- Workout Days — which weekdays a reminder is allowed to fire on.
-- 0=Sunday .. 6=Saturday (matches JS Date#getDay()). NULL/empty = every
-- day (unchanged default behavior for every existing row). Added to BOTH
-- reminder_settings (primary reminder) and reminder_schedules (extra
-- times) so the UI can already reference `days_of_week` on either table.
-- In practice only reminder_type = 'exercise' rows ever set this from the
-- UI, but the column (and the filter in get_due_reminders below) is
-- generic so it costs nothing for water/meal/sleep rows.
alter table public.reminder_settings add column if not exists days_of_week int[];
alter table public.reminder_schedules add column if not exists days_of_week int[];

-- Extra Sleep Times — give every extra sleep schedule the same shape as
-- the primary sleep row (reminder_settings.wake_time / snooze_minutes),
-- so an extra sleep schedule can run the full 30-min / 15-min / bedtime /
-- wake-up flow with its own snooze, independent of the primary one.
alter table public.reminder_schedules add column if not exists wake_time time;
alter table public.reminder_schedules add column if not exists snooze_minutes int not null default 10
  check (snooze_minutes in (10, 15, 30));

-- Notifications — carry enough context (which schedule/source this came
-- from, its label, and its configured snooze length) for the in-app
-- toast in js/shell.js to offer a "Snooze" action on sleep notifications
-- without an extra round-trip query. All nullable/additive; every other
-- reminder type simply leaves these null and nothing about them changes.
alter table public.notifications add column if not exists schedule_id uuid;
alter table public.notifications add column if not exists source text;
alter table public.notifications add column if not exists label text;
alter table public.notifications add column if not exists snooze_minutes int;

-- =========================================================================
-- 20b. REMINDER_SKIPS — "Skip today" for a single reminder occurrence.
--     One row = "don't send THIS schedule's reminder on THIS local date."
--     It expires itself the next day simply because skip_date no longer
--     matches "today" — no cleanup job needed. schedule_id is polymorphic
--     (id from reminder_settings or reminder_schedules), same pattern as
--     reminder_history.schedule_id.
-- =========================================================================
create table if not exists public.reminder_skips (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.users(id) on delete cascade,
  reminder_type  text not null,
  schedule_id    uuid not null,
  skip_date      date not null,
  created_at     timestamptz default now(),
  unique (user_id, reminder_type, schedule_id, skip_date)
);

alter table public.reminder_skips enable row level security;
drop policy if exists "Users manage their own reminder skips" on public.reminder_skips;
create policy "Users manage their own reminder skips"
  on public.reminder_skips for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists reminder_skips_lookup_idx
  on public.reminder_skips (user_id, reminder_type, schedule_id, skip_date);

-- =========================================================================
-- 20c. REMINDER_SNOOZES — one-off temporary occurrences created when a
--     user taps "Snooze" on a sleep notification. get_due_reminders picks
--     up any unconsumed row whose fire_at falls in the current tick
--     window and reports it with source = 'sleep_snooze'; the Reminder
--     Engine marks it consumed afterwards (success or failure — a snooze
--     is a one-shot, it never retries beyond its own window). Because
--     each row has its own id and that id becomes reminder_history's
--     schedule_id for the occurrence, the existing unique constraint on
--     reminder_history still guarantees it can never double-send even if
--     a tick overlaps.
-- =========================================================================
create table if not exists public.reminder_snoozes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.users(id) on delete cascade,
  reminder_type  text not null default 'sleep',
  schedule_id    uuid not null, -- the original reminder_settings/reminder_schedules id being snoozed
  label          text,
  fire_at        timestamptz not null,
  consumed       boolean not null default false,
  created_at     timestamptz default now()
);

alter table public.reminder_snoozes enable row level security;
drop policy if exists "Users create their own snoozes" on public.reminder_snoozes;
create policy "Users create their own snoozes"
  on public.reminder_snoozes for insert with check (auth.uid() = user_id);
drop policy if exists "Users view their own snoozes" on public.reminder_snoozes;
create policy "Users view their own snoozes"
  on public.reminder_snoozes for select using (auth.uid() = user_id);
-- No update/delete policy for regular users on purpose — only the
-- Reminder Engine (service role) marks a snooze consumed, same reasoning
-- as reminder_history above.

create index if not exists reminder_snoozes_due_idx
  on public.reminder_snoozes (consumed, fire_at);

-- Widen reminder_history's `source` check to cover the extra-sleep-time
-- stages and the new snooze source. Existing rows are unaffected.
alter table public.reminder_history drop constraint if exists reminder_history_source_check;
alter table public.reminder_history add constraint reminder_history_source_check
  check (source in (
    'primary', 'additional', 'medicine',
    'sleep_pre_30', 'sleep_pre_15', 'sleep_morning',
    'additional_sleep_pre_30', 'additional_sleep_pre_15', 'additional_sleep_morning',
    'sleep_snooze'
  ));

-- =========================================================================
-- 20. get_due_reminders() — used by the Reminder Engine's cron tick
--     Combines reminder_settings (primary time), reminder_schedules
--     (extra times) and medicine_reminders into one due-list, correctly
--     converting each user's LOCAL reminder time to "is it due right
--     now" using their saved IANA timezone. security definer + revoked
--     from anon/authenticated so it can only run as the service role
--     inside the Reminder Engine edge function.
--
--     Phase 2 additions (all additive, nothing above removed):
--       - Workout Days / Skip Today filters on the primary + additional
--         branches (a no-op for any row that never sets days_of_week or
--         is never skipped, i.e. every row except exercise ones a user
--         actually configured).
--       - Extra sleep schedules (reminder_schedules, reminder_type =
--         'sleep') now get their own 30-min / 15-min / wake-up stages,
--         exactly mirroring the primary sleep branches below.
--       - A snoozed-occurrence branch reading reminder_snoozes.
--       - A `snooze_minutes` output column so the engine can hand the
--         in-app notification its own schedule's configured snooze
--         length without a second query.
-- =========================================================================
create or replace function public.get_due_reminders(p_window_minutes int default 2)
returns table (
  user_id         uuid,
  reminder_type   text,
  source          text,
  schedule_id     uuid,
  label           text,
  local_date      date,
  local_time      time,
  timezone        text,
  snooze_minutes  int,
  goal_hours      numeric
) as $$
begin
  -- Comparing "is it due" using local TIMESTAMPS (today's date + the
  -- scheduled time) rather than HH:MI-of-day strings is what makes this
  -- correct across midnight — a reminder set for 23:59 with a 2-minute
  -- window correctly matches 23:59-00:01 instead of never firing.
  return query
  -- Primary reminder_settings (water/meal/exercise/sleep on-off + time).
  -- Medicine is excluded here and handled separately below.
  -- Repeat Every Day / Skip Today: only fires when today's local weekday
  -- is in days_of_week, or days_of_week is null/empty (= every day —
  -- what "Repeat every day" turns on). Skip Today excludes any occurrence
  -- with a matching reminder_skips row for this exact local date —
  -- automatically stops applying the next day since skip_date no longer
  -- matches.
  select
    rs.user_id, rs.reminder_type, 'primary'::text, rs.id, null::text,
    ((now() at time zone u.timezone)::date),
    rs.reminder_time,
    u.timezone,
    rs.snooze_minutes,
    case when rs.reminder_type = 'sleep' then rs.goal_hours else null end
  from public.reminder_settings rs
  join public.users u on u.id = rs.user_id
  where rs.enabled = true
    and rs.reminder_type <> 'medicine'
    and rs.reminder_time is not null
    and (now() at time zone u.timezone) >= ((now() at time zone u.timezone)::date + rs.reminder_time)
    and (now() at time zone u.timezone) < ((now() at time zone u.timezone)::date + rs.reminder_time + make_interval(mins => p_window_minutes))
    and (rs.days_of_week is null or array_length(rs.days_of_week, 1) is null
         or extract(dow from (now() at time zone u.timezone))::int = any(rs.days_of_week))
    and not exists (
      select 1 from public.reminder_skips sk
      where sk.user_id = rs.user_id and sk.reminder_type = rs.reminder_type and sk.schedule_id = rs.id
        and sk.skip_date = ((now() at time zone u.timezone)::date)
    )

  union all

  -- Additional per-day times — same Repeat/Skip filters, scoped to this
  -- specific extra schedule's own id. goal_hours for a sleep extra time
  -- comes from the user's ONE sleep goal (reminder_settings), since the
  -- goal is a single target the user sets once, not per-schedule.
  select
    sch.user_id, sch.reminder_type, 'additional'::text, sch.id, sch.label,
    ((now() at time zone u.timezone)::date),
    sch.reminder_time,
    u.timezone,
    sch.snooze_minutes,
    case when sch.reminder_type = 'sleep' then
      coalesce((select gs.goal_hours from public.reminder_settings gs where gs.user_id = sch.user_id and gs.reminder_type = 'sleep'), 8)
    else null end
  from public.reminder_schedules sch
  join public.users u on u.id = sch.user_id
  where sch.enabled = true
    and (now() at time zone u.timezone) >= ((now() at time zone u.timezone)::date + sch.reminder_time)
    and (now() at time zone u.timezone) < ((now() at time zone u.timezone)::date + sch.reminder_time + make_interval(mins => p_window_minutes))
    and (sch.days_of_week is null or array_length(sch.days_of_week, 1) is null
         or extract(dow from (now() at time zone u.timezone))::int = any(sch.days_of_week))
    and not exists (
      select 1 from public.reminder_skips sk
      where sk.user_id = sch.user_id and sk.reminder_type = sch.reminder_type and sk.schedule_id = sch.id
        and sk.skip_date = ((now() at time zone u.timezone)::date)
    )

  union all

  -- Medicine reminders — only when the master medicine notification switch
  -- in reminder_settings is on, exactly matching what the Reminder Center
  -- card already communicates to the user.
  select
    mr.user_id, 'medicine'::text, 'medicine'::text, mr.id, mr.medicine_name,
    ((now() at time zone u.timezone)::date),
    mr.time,
    u.timezone,
    null::int,
    null::numeric
  from public.medicine_reminders mr
  join public.users u on u.id = mr.user_id
  join public.reminder_settings rs2
    on rs2.user_id = mr.user_id and rs2.reminder_type = 'medicine' and rs2.enabled = true
  where (now() at time zone u.timezone) >= ((now() at time zone u.timezone)::date + mr.time)
    and (now() at time zone u.timezone) < ((now() at time zone u.timezone)::date + mr.time + make_interval(mins => p_window_minutes))

  union all

  -- Sleep Reminder: two heads-up notifications before the PRIMARY bedtime
  -- (bedtime itself already fires above via the 'primary' branch, since
  -- reminder_time IS the bedtime for the sleep row). time - interval
  -- wraps correctly past midnight (e.g. a 00:10 bedtime minus 30 minutes
  -- is 23:40 the same calendar day in this comparison), so this works
  -- for late bedtimes too.
  select
    rs.user_id, rs.reminder_type, 'sleep_pre_30'::text, rs.id, null::text,
    ((now() at time zone u.timezone)::date),
    (rs.reminder_time - interval '30 minutes')::time,
    u.timezone,
    rs.snooze_minutes,
    rs.goal_hours
  from public.reminder_settings rs
  join public.users u on u.id = rs.user_id
  where rs.enabled = true
    and rs.reminder_type = 'sleep'
    and rs.reminder_time is not null
    and (now() at time zone u.timezone) >= ((now() at time zone u.timezone)::date + (rs.reminder_time - interval '30 minutes')::time)
    and (now() at time zone u.timezone) < ((now() at time zone u.timezone)::date + (rs.reminder_time - interval '30 minutes')::time + make_interval(mins => p_window_minutes))

  union all

  select
    rs.user_id, rs.reminder_type, 'sleep_pre_15'::text, rs.id, null::text,
    ((now() at time zone u.timezone)::date),
    (rs.reminder_time - interval '15 minutes')::time,
    u.timezone,
    rs.snooze_minutes,
    rs.goal_hours
  from public.reminder_settings rs
  join public.users u on u.id = rs.user_id
  where rs.enabled = true
    and rs.reminder_type = 'sleep'
    and rs.reminder_time is not null
    and (now() at time zone u.timezone) >= ((now() at time zone u.timezone)::date + (rs.reminder_time - interval '15 minutes')::time)
    and (now() at time zone u.timezone) < ((now() at time zone u.timezone)::date + (rs.reminder_time - interval '15 minutes')::time + make_interval(mins => p_window_minutes))

  union all

  -- Sleep Reminder: morning "good morning" notification at the user's
  -- saved wake-up time (separate from bedtime, only fires if a wake_time
  -- has been set).
  select
    rs.user_id, rs.reminder_type, 'sleep_morning'::text, rs.id, null::text,
    ((now() at time zone u.timezone)::date),
    rs.wake_time,
    u.timezone,
    rs.snooze_minutes,
    rs.goal_hours
  from public.reminder_settings rs
  join public.users u on u.id = rs.user_id
  where rs.enabled = true
    and rs.reminder_type = 'sleep'
    and rs.wake_time is not null
    and (now() at time zone u.timezone) >= ((now() at time zone u.timezone)::date + rs.wake_time)
    and (now() at time zone u.timezone) < ((now() at time zone u.timezone)::date + rs.wake_time + make_interval(mins => p_window_minutes))

  union all

  -- Extra Sleep Times: the same 30-min heads-up, but for EVERY extra sleep
  -- schedule the user added (reminder_schedules, reminder_type='sleep').
  -- reminder_time on that row IS that schedule's own bedtime, exactly
  -- mirroring how it works for the primary sleep row above.
  select
    sch.user_id, sch.reminder_type, 'additional_sleep_pre_30'::text, sch.id, sch.label,
    ((now() at time zone u.timezone)::date),
    (sch.reminder_time - interval '30 minutes')::time,
    u.timezone,
    sch.snooze_minutes,
    coalesce((select gs.goal_hours from public.reminder_settings gs where gs.user_id = sch.user_id and gs.reminder_type = 'sleep'), 8)
  from public.reminder_schedules sch
  join public.users u on u.id = sch.user_id
  where sch.enabled = true
    and sch.reminder_type = 'sleep'
    and (now() at time zone u.timezone) >= ((now() at time zone u.timezone)::date + (sch.reminder_time - interval '30 minutes')::time)
    and (now() at time zone u.timezone) < ((now() at time zone u.timezone)::date + (sch.reminder_time - interval '30 minutes')::time + make_interval(mins => p_window_minutes))

  union all

  -- Extra Sleep Times: 15-minute heads-up.
  select
    sch.user_id, sch.reminder_type, 'additional_sleep_pre_15'::text, sch.id, sch.label,
    ((now() at time zone u.timezone)::date),
    (sch.reminder_time - interval '15 minutes')::time,
    u.timezone,
    sch.snooze_minutes,
    coalesce((select gs.goal_hours from public.reminder_settings gs where gs.user_id = sch.user_id and gs.reminder_type = 'sleep'), 8)
  from public.reminder_schedules sch
  join public.users u on u.id = sch.user_id
  where sch.enabled = true
    and sch.reminder_type = 'sleep'
    and (now() at time zone u.timezone) >= ((now() at time zone u.timezone)::date + (sch.reminder_time - interval '15 minutes')::time)
    and (now() at time zone u.timezone) < ((now() at time zone u.timezone)::date + (sch.reminder_time - interval '15 minutes')::time + make_interval(mins => p_window_minutes))

  union all

  -- Extra Sleep Times: wake-up notification, only if this extra schedule
  -- has its own wake_time set (independent of the primary sleep row's).
  select
    sch.user_id, sch.reminder_type, 'additional_sleep_morning'::text, sch.id, sch.label,
    ((now() at time zone u.timezone)::date),
    sch.wake_time,
    u.timezone,
    sch.snooze_minutes,
    coalesce((select gs.goal_hours from public.reminder_settings gs where gs.user_id = sch.user_id and gs.reminder_type = 'sleep'), 8)
  from public.reminder_schedules sch
  join public.users u on u.id = sch.user_id
  where sch.enabled = true
    and sch.reminder_type = 'sleep'
    and sch.wake_time is not null
    and (now() at time zone u.timezone) >= ((now() at time zone u.timezone)::date + sch.wake_time)
    and (now() at time zone u.timezone) < ((now() at time zone u.timezone)::date + sch.wake_time + make_interval(mins => p_window_minutes))

  union all

  -- Snooze: one-off occurrences created when a user taps "Snooze" on a
  -- sleep notification (see reminder_snoozes above). Compared directly
  -- against the stored UTC instant rather than local date+time math,
  -- since fire_at already IS the exact absolute moment to fire at.
  select
    rns.user_id, rns.reminder_type, 'sleep_snooze'::text, rns.id, rns.label,
    ((rns.fire_at at time zone u.timezone)::date),
    (rns.fire_at at time zone u.timezone)::time,
    u.timezone,
    null::int,
    coalesce((select gs.goal_hours from public.reminder_settings gs where gs.user_id = rns.user_id and gs.reminder_type = 'sleep'), 8)
  from public.reminder_snoozes rns
  join public.users u on u.id = rns.user_id
  where rns.consumed = false
    and now() >= rns.fire_at
    and now() < rns.fire_at + make_interval(mins => p_window_minutes);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function public.get_due_reminders(int) from public, anon, authenticated;
grant execute on function public.get_due_reminders(int) to service_role;



-- =========================================================================
-- 20. DAILY HEALTH LOGS — powers the Health Calendar's per-day Mood /
--     Daily Rating / Note fields.
--
--     Deliberately the ONLY new table added for the Health Calendar
--     feature. Every other section it shows (nutrition, exercise, sleep,
--     water, BMI, symptoms, appointments, medicine reminders sent) is
--     read directly from the tables that already exist (bmi_logs,
--     water_logs, sleep_logs, food_logs, exercise_logs, symptom_logs,
--     doctor_appointments, reminder_history) — see js/health-calendar.js.
--     That's an intentional choice: a parallel "log every action again
--     into one big activity_logs table" pipeline would mean touching
--     every existing feature's write path (bmi.js, water.js, sleep.js,
--     food-tracker.js, exercise.js, symptoms.js, appointment.js, ...),
--     which is exactly the kind of change most likely to break current
--     functionality. Reading from the existing tables gets the same
--     calendar with zero risk to anything that already works.
--
--     mood / daily_rating / note are the only genuinely new pieces of
--     data (nothing currently lets a user record "how the day felt"),
--     so those get one small table.
-- =========================================================================
create table if not exists public.daily_health_logs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.users(id) on delete cascade,
  log_date      date not null,
  mood          text check (mood in ('great', 'good', 'okay', 'low', 'bad')),
  daily_rating  int check (daily_rating between 1 and 5),
  note          text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (user_id, log_date)
);

alter table public.daily_health_logs enable row level security;
create policy "Users manage their own daily health logs"
  on public.daily_health_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists daily_health_logs_user_date_idx
  on public.daily_health_logs (user_id, log_date);

-- =========================================================================
-- DONE
-- After running this file, go to Authentication → Providers and make
-- sure "Email" is enabled. Optionally disable "Confirm email" while
-- you are developing, so new accounts can log in immediately.
--
-- For the Reminder Engine + WhatsApp Integration, see
-- docs/REMINDER_ENGINE.md for the extra one-time setup (Edge Function
-- secrets + scheduling the cron tick).
-- =========================================================================
