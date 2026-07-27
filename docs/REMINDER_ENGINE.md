# Reminder Engine + WhatsApp Integration — Setup Guide

This covers the two features layered on top of the existing Reminder
Center (`reminders.html`): a centralized, timezone-aware **Reminder
Engine** that fires on a schedule, and **WhatsApp delivery** for those
reminders with automatic fallback to in-app/browser notifications.

Nothing here changes how the app behaves if you skip this setup — with
no cron scheduled and no WhatsApp secrets set, the Reminder Center still
works exactly as before (you just won't get the new proactive
WhatsApp/browser pushes).

---

## 1. Run the updated schema

`sql/schema.sql` is unchanged in its first 15 sections — everything new
is additive (`create table if not exists`, `add column if not exists`).
Re-run the whole file in **Supabase → SQL Editor**; existing tables and
data are untouched. This adds:

- `users.timezone` — auto-detected and saved by `reminders.html` the
  first time a user opens it (no action needed from you)
- `reminder_schedules` — extra times per day for water/meal/exercise/sleep
- `reminder_history` — the engine's duplicate-prevention ledger
- `whatsapp_settings`, `notifications`
- `public.get_due_reminders()` — the function the engine calls each tick
- **Phase 2:** `days_of_week` (on `reminder_settings` and
  `reminder_schedules`), `wake_time` + `snooze_minutes` (on
  `reminder_schedules`), the `reminder_skips` and `reminder_snoozes`
  tables, and `schedule_id`/`source`/`label`/`snooze_minutes` on
  `notifications` — see **Repeat Every Day & Skip Today** and **Extra
  Sleep Times & Snooze** below.

## 2. Deploy the two new Edge Functions

```bash
supabase functions deploy reminder-engine
supabase functions deploy whatsapp-verify
```

`whatsapp-verify` requires a logged-in user (called from Settings).
`reminder-engine` is meant to be called by a scheduler, not the browser.

## 3. Set Edge Function secrets

Pick **one** WhatsApp provider and set `WHATSAPP_PROVIDER` accordingly.
The reminder engine and the verification flow both call the same
`sendWhatsAppMessage()` helper — swapping providers never touches their
code, only these secrets.

**Option A — Meta WhatsApp Cloud API**
```bash
supabase secrets set WHATSAPP_PROVIDER=meta
supabase secrets set META_WHATSAPP_TOKEN=your-permanent-or-temp-token
supabase secrets set META_WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
```
Get these from [developers.facebook.com/docs/whatsapp/cloud-api](https://developers.facebook.com/docs/whatsapp/cloud-api).

**Option B — Twilio WhatsApp API**
```bash
supabase secrets set WHATSAPP_PROVIDER=twilio
supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxxxxx
supabase secrets set TWILIO_AUTH_TOKEN=your-auth-token
supabase secrets set TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```
Get these from your [Twilio Console](https://console.twilio.com) →
WhatsApp Sandbox (for testing) or an approved WhatsApp sender (for
production).

> **Read this if messages aren't arriving.** Twilio only lets you send
> plain freeform text ("Body") when the recipient messaged you in the
> last 24 hours. A reminder or OTP code is sent *by the app*, not in
> reply to the user — so outside that 24h window Twilio rejects it
> (error `63016`) and the app just falls back to the in-app/browser
> notification. This is the most common reason WhatsApp reminders
> silently "don't work" with Twilio. Two ways to fix it:
> - **Testing, right now:** open WhatsApp on the phone you're testing
>   with and send `join <your-sandbox-code>` to your Sandbox number
>   (shown on the Twilio Console's WhatsApp Sandbox page). That opens a
>   24h session and freeform messages will go through — but it expires
>   after 3 days of inactivity and needs to be redone.
> - **Production (recommended):** create an approved WhatsApp template
>   with **exactly one variable** in Twilio Console → Messaging →
>   Content Template Builder, then set:
>   ```bash
>   supabase secrets set TWILIO_CONTENT_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
>   ```
>   Once set, every send (reminders and OTP codes) automatically goes
>   through that template instead of freeform text, and works
>   regardless of the 24h window. Approval usually takes a few hours to
>   a couple of days from Meta/Twilio.
>
> To see the exact reason a message failed, check **Settings →
> WhatsApp Reminders** (shows the last delivery error) or the
> `whatsapp_settings.last_send_error` / `reminder_history.error_message`
> columns in Supabase.

**Optional — lock down the cron endpoint**
```bash
supabase secrets set CRON_SECRET=some-long-random-string
```
If set, `reminder-engine` requires a matching `x-cron-secret` header on
every request. If you skip this, the function still works (useful for
quick local testing) but anyone who finds the URL could trigger a tick.
Set it before going to production.

## 4. Schedule the Reminder Engine

The engine is a single "tick" — it needs to be called roughly every
1–2 minutes so due reminders are caught promptly (it checks a 2-minute
due window per tick, so anything slower than that can skip reminders).

**Recommended: Supabase Dashboard → Integrations → Cron Jobs**
1. Create a new Cron Job pointing at your `reminder-engine` function URL
   (`https://<project-ref>.supabase.co/functions/v1/reminder-engine`).
2. Schedule: every minute (`* * * * *`).
3. If you set `CRON_SECRET`, add header `x-cron-secret: <your secret>`.

This is preferred over hand-rolled `pg_cron` + `pg_net` SQL because it
avoids embedding any secret directly in the database, and it's visible
and editable from the dashboard.

**Alternative: any external scheduler** (GitHub Actions cron, a cheap
VPS crontab, cron-job.org, etc.) — just have it `POST` to the same URL
with the same header once a minute.

## 5. Try it out

1. Log in, go to **Reminder Center**, turn on Water reminders and set a
   time 2–3 minutes in the future. Optionally click **+ Add another
   time** to add a second time the same day.
2. Go to **Settings → WhatsApp Reminders**, enter your number in
   international format (e.g. `+8801XXXXXXXXX`), click **Send
   verification code**, enter the 6-digit code you receive on WhatsApp.
3. Wait for the reminder time — you should get a WhatsApp message. If
   WhatsApp isn't set up (or a send fails), you'll instead see a toast
   and, if you'd previously clicked **Enable** under Settings → Browser
   notifications, a real OS notification — delivered by the polling in
   `js/shell.js` reading the `notifications` table.
4. Check the **`reminder_history`** table in Supabase to see exactly
   what fired, through which channel, and confirm nothing double-sent.

## How duplicate prevention actually works

Each due reminder occurrence is uniquely identified by
`(user_id, reminder_type, schedule_id, scheduled_date, scheduled_time)`.
Before sending anything, `reminder-engine` tries to `INSERT` that row
into `reminder_history`. The table's `unique` constraint means a second
attempt at the exact same occurrence — from an overlapping tick, a
retry, or a wider window — is rejected by Postgres itself, so the engine
never sends the same reminder twice. This is enforced at the database
level, not just in the function's own logic.

## How multiple reminders per day work

The original Reminder Center card (on/off + one time) is untouched —
it's still `reminder_settings`. **+ Add another time** on the Water,
Meal, Exercise, and Sleep cards writes to the separate
`reminder_schedules` table instead, so a user can have as many extra
times as they like without changing how the original single-time flow
behaves. `get_due_reminders()` checks both tables (plus
`medicine_reminders`, unchanged) every tick.

## Repeat Every Day & Skip Today (Exercise)

Two additive controls on the Exercise card, and on every extra exercise
time added via **+ Add another time** — each extra time gets its own
independent "Repeat every day" toggle and Skip Today button, right under
its row in the Reminder Center:

- **Repeat every day** — a single checkbox, off by default. When a
  reminder (primary or extra) is first saved, it applies to **only the
  weekday it was set on** — `days_of_week` (`int[]`, 0=Sunday..6=Saturday)
  is set to that one day, e.g. `[3]` for a Wednesday. It will *not* fire
  on any other day unless the user turns this checkbox on, which sets
  `days_of_week` to `NULL` (= every day, same meaning it always had for
  water/meal/sleep). `get_due_reminders()` only returns an occurrence
  when today's local weekday (computed from the user's own timezone, not
  the server's) is in the array, or the array is `NULL`.
- **Skip today** — inserts a row into `reminder_skips`
  `(user_id, reminder_type, schedule_id, skip_date)`. `get_due_reminders()`
  excludes any occurrence with a matching skip row for *today's* local
  date; it needs no cleanup or "undo" — the skip simply stops matching
  the moment the local date rolls over, and the reminder is back to
  normal automatically the next day.

Both filters live entirely inside `get_due_reminders()`'s `where`
clauses, so they apply uniformly regardless of channel (WhatsApp,
browser, in-app) and can never be bypassed by one delivery path and not
another.

## Sleep Reminder — four notification stages, on every sleep schedule

Turning on the Sleep card sends up to four separate notifications around
one night's sleep, off the primary `reminder_settings` row
(`reminder_type = 'sleep'`). **Extra sleep times** (added the same way as
any other type, via + Add another time) get the exact same four-stage
flow, independently, off their own `reminder_schedules` row — including
their own optional wake-up time and their own snooze length:

| Stage | Fires at | Source (primary) | Source (extra time) | Title | Body |
|---|---|---|---|---|---|
| 30 minutes before bed | bedtime − 30 min | `sleep_pre_30` | `additional_sleep_pre_30` | 🌙 Time to prepare for bed. | Put away your phone and relax. |
| 15 minutes before bed | bedtime − 15 min | `sleep_pre_15` | `additional_sleep_pre_15` | 😴 Bedtime is approaching. | Bedtime is in 15 minutes. |
| At bedtime | bedtime (`reminder_time`) | `primary` | `additional` | 🌙 Good night! | Aim for `{goal_hours}` hours of sleep. |
| Morning wrap-up | `wake_time` | `sleep_morning` | `additional_sleep_morning` | ☀️ Good morning! | You slept `{duration}`. |

Each stage is deliberately worded differently (this used to read too
similarly between stages, which is why the bedtime and pre-bedtime
notifications could look interchangeable at a glance).

The morning notification only fires if that schedule has its own
wake-up time saved, and its body is filled in from the most recent
`sleep_logs` entry for that night when one exists — if the user hasn't
logged, it falls back to "Good morning! Time to wake up and start your
day." rather than skipping the notification.

The bedtime body's `{goal_hours}` comes from `reminder_settings.
goal_hours` — the user's own Sleep Goal, editable on the Sleep tracking
page (defaults to 8 for anyone who's never changed it) — **not** a
hardcoded "8 hours" regardless of what they've actually set. `get_due_
reminders()` returns it directly on every sleep-related row (primary
straight from that row; extra sleep schedules via a lookup, since the
goal is one setting per user, not per schedule) so the Reminder Engine
never needs a second query for it.

An extra sleep schedule's own `label` (e.g. "Nap", "Evening Sleep") is
appended to every stage's text, the same way labels already work for
every other reminder type — e.g. "🌙 Time to prepare for bed. Put away
your phone and relax. (Evening Sleep)".

## Snooze (per sleep schedule)

Every sleep schedule — primary and every extra one — has its own
`snooze_minutes` (10/15/30), set independently in the Reminder Center.
When a bedtime or pre-bedtime notification arrives in-app, `js/shell.js`
shows a **Snooze** button using that exact schedule's configured length
(carried on the `notifications` row by the engine, so no extra query is
needed client-side). Tapping it inserts one row into `reminder_snoozes`:

```
{ user_id, reminder_type: 'sleep', schedule_id, label, fire_at }
```

`get_due_reminders()` picks up any unconsumed row whose `fire_at` falls
in the current tick window and reports it with `source = 'sleep_snooze'`.
Because the snooze row's own `id` becomes `reminder_history`'s
`schedule_id` for that occurrence, the same unique-constraint mechanism
described above still guarantees it can only ever fire once — even if
two ticks see it. The Reminder Engine marks the `reminder_snoozes` row
`consumed = true` right after processing it (success or failure), so a
snooze never retries beyond its own one-shot window. Snoozing an
already-snoozed notification isn't offered (`snooze_minutes` comes back
`null` for `source = 'sleep_snooze'` rows) to avoid an unbounded chain.

## How time zones are handled

`users.timezone` stores an IANA name (e.g. `Asia/Dhaka`,
`America/New_York`), auto-detected from the browser via
`Intl.DateTimeFormat().resolvedOptions().timeZone` the first time
`reminders.html` loads, and never overwrites a value you've already set
to something other than the `UTC` default. `get_due_reminders()`
converts `now()` into each user's local time (`now() at time zone
u.timezone`) before comparing it against their reminder times, so a
9:00 AM water reminder fires at 9:00 AM *their* time regardless of where
your Supabase project's server is.

## Extending to a third WhatsApp provider (or another channel entirely)

Add a new class implementing the `WhatsAppProvider` interface in
`supabase/functions/_shared/whatsapp-providers.ts`, register it in the
`PROVIDERS` map, and point `WHATSAPP_PROVIDER` at its key. Nothing in
`reminder-engine/index.ts` or `whatsapp-verify/index.ts` needs to change
— they only ever call the provider-agnostic `sendWhatsAppMessage()`.
