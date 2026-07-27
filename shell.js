/* =========================================================================
   shell.js — renders the sidebar + topbar shared by every dashboard page.
   Each protected page just needs:

     <div class="app-shell">
       <div id="sidebarContainer"></div>
       <div class="sidebar-overlay"></div>
       <div class="main-content">
         <div id="topbarContainer"></div>
         <div class="page-body"> ...page content... </div>
       </div>
     </div>
     <script>renderShell('bmi.html', 'BMI Calculator');</script>

   Call this AFTER config.js, ui.js and auth.js are loaded.
   ========================================================================= */

const SIDEBAR_NAV = [
  { group: "Overview", groupKey: "nav_group_overview", links: [
    { href: "profile.html", icon: "👤", label: "Profile", key: "nav_profile" },
    { href: "dashboard.html", icon: "📊", label: "Dashboard", key: "nav_dashboard" },
    { href: "health-score.html", icon: "❤️", label: "Health Score", key: "nav_health_score" },
    { href: "health-calendar.html", icon: "📅", label: "Health Calendar", key: "nav_health_calendar" }
  ]},
  { group: "Track", groupKey: "nav_group_track", links: [
    { href: "bmi.html", icon: "⚖️", label: "BMI Calculator", key: "nav_bmi" },
    { href: "water.html", icon: "💧", label: "Water Intake", key: "nav_water" },
    { href: "sleep.html", icon: "😴", label: "Sleep & Stress", key: "nav_sleep" },
    { href: "medicine.html", icon: "⏰", label: "Medicine Reminders", key: "nav_medicine" },
    { href: "reminders.html", icon: "🔔", label: "Reminder Center", key: "nav_reminder_center" },
    { href: "symptoms.html", icon: "🩺", label: "Symptom Checker", key: "nav_symptoms" },
    { href: "appointment.html", icon: "🏥", label: "Doctor Appointments", key: "nav_appointment" }
  ]},
  { group: "Nutrition", groupKey: "nav_group_nutrition", links: [
    { href: "nutrition.html", icon: "🥗", label: "Nutrition Plan", key: "nav_nutrition" },
    { href: "nutrition-report.html", icon: "📊", label: "Nutrition Report", key: "nav_nutrition_report" },
    { href: "food-tracker.html", icon: "🍲", label: "Food Tracker", key: "nav_food_tracker" },
    { href: "diet-plan.html", icon: "🍽️", label: "Diet Plan", key: "nav_diet_plan" },
    { href: "grocery.html", icon: "🛒", label: "Grocery Planner", key: "nav_grocery" },
    { href: "journal.html", icon: "📔", label: "Food Journal", key: "nav_journal" },
    { href: "gallery.html", icon: "🖼️", label: "Food Gallery", key: "nav_gallery" },
    { href: "scanner.html", icon: "📷", label: "Food Scanner", key: "nav_scanner" },
    { href: "recipes.html", icon: "👩‍🍳", label: "Recipes", key: "nav_recipes" }
  ]},
  { group: "Move & Ask", groupKey: "nav_group_move", links: [
    { href: "exercise.html", icon: "🏃", label: "Exercise", key: "nav_exercise" },
    { href: "chatbot.html", icon: "🤖", label: "AI Chatbot", key: "nav_chatbot" }
  ]}
];

function renderShell(activePage) {
  const sidebarEl = document.getElementById("sidebarContainer");
  const topbarEl = document.getElementById("topbarContainer");
  if (!sidebarEl || !topbarEl) return;

  // The topbar's page title used to be pulled straight from document.title
  // (always English, and never re-translated when the user switched
  // language). Look up the matching sidebar nav entry instead so it gets a
  // proper data-i18n key and stays in sync with the language toggle.
  let pageTitleKey = null;
  for (const g of SIDEBAR_NAV) {
    const found = g.links.find((l) => l.href === activePage);
    if (found) { pageTitleKey = found.key; break; }
  }
  if (!pageTitleKey && activePage === "settings.html") pageTitleKey = "nav_settings";
  const pageTitleFallback = document.title.split("—")[0].trim();

  const groups = SIDEBAR_NAV.map((g) => `
    <div class="sidebar-section-label" data-i18n="${g.groupKey}">${g.group}</div>
    ${g.links.map((l) => `
      <a href="${l.href}" class="sidebar-link ${l.href === activePage ? "active" : ""}">
        <span class="ic">${l.icon}</span> <span data-i18n="${l.key}">${l.label}</span>
      </a>
    `).join("")}
  `).join("");

  sidebarEl.outerHTML = `
    <aside class="sidebar" id="sidebarContainer">
      <a href="dashboard.html" class="brand">
        <span class="brand-mark">✚</span> NutriHealth
      </a>
      ${groups}
      <div class="sidebar-footer">
        <a href="settings.html" class="sidebar-link ${activePage === "settings.html" ? "active" : ""}">
          <span class="ic">⚙️</span> <span data-i18n="nav_settings">Settings</span>
        </a>
        <button class="sidebar-link" style="width:100%;" onclick="handleLogout()">
          <span class="ic">🚪</span> <span data-i18n="nav_logout">Log out</span>
        </button>
      </div>
    </aside>
  `;

  topbarEl.outerHTML = `
    <div class="topbar" id="topbarContainer">
      <div class="flex gap-16">
        <button class="nav-toggle" aria-label="Open menu">☰</button>
        <h4 class="js-page-title"${pageTitleKey ? ` data-i18n="${pageTitleKey}"` : ""}>${pageTitleFallback}</h4>
      </div>
      <div class="flex gap-16">
        <button class="lang-toggle" aria-label="Switch language">বাং</button>
        <button class="theme-toggle" aria-label="Toggle dark mode">🌙</button>
        <div class="user-chip">
          <div class="avatar js-user-avatar">U</div>
          <div>
            <div class="text-sm" style="font-weight:600;" class="js-user-name" data-i18n="topbar_loading">Loading...</div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Re-bind listeners for the elements we just injected (ui.js binds on DOMContentLoaded,
  // which has already fired by the time this HTML exists).
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.querySelector(".sidebar-overlay");
  document.querySelectorAll(".nav-toggle").forEach((btn) =>
    btn.addEventListener("click", () => { sidebar?.classList.add("open"); overlay?.classList.add("open"); })
  );
  overlay?.addEventListener("click", () => { sidebar?.classList.remove("open"); overlay?.classList.remove("open"); });
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.addEventListener("click", toggleTheme);
    btn.textContent = (localStorage.getItem("nh_theme") || "light") === "dark" ? "☀️" : "🌙";
  });

  if (typeof initLangToggleButtons === "function") initLangToggleButtons();
  // On top of the local (localStorage) toggle above, also persist the
  // choice to the logged-in user's account so it follows them to other
  // devices — mirrors what the Settings page does, but read-merge-write
  // so it never clobbers other saved settings.
  document.querySelectorAll(".lang-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (!user) return;
        const { data: row } = await supabaseClient.from("users").select("settings").eq("id", user.id).single();
        const settings = { ...(row?.settings || {}), language: (typeof getCurrentLang === "function" ? getCurrentLang() : "en") };
        await supabaseClient.from("users").update({ settings }).eq("id", user.id);
      } catch (err) {
        console.warn("Could not save language preference to account:", err);
      }
    });
  });

  if (typeof applyTranslations === "function") applyTranslations();

  startReminderNotificationPolling();
}

/* =========================================================================
   Reminder Engine fallback delivery — in-app / browser notifications.
   The server-side Reminder Engine writes a row to `notifications` whenever
   WhatsApp is off, unverified, or fails to send for a due reminder. This
   polls for unread rows belonging to the logged-in user on every protected
   page (shell.js is loaded everywhere renderShell() runs), shows each one
   as a toast — plus a real OS-level Notification if the user already
   granted permission on the Settings page — and marks it read so it's
   only ever delivered once.
   ========================================================================= */
let _reminderPollStarted = false;

function startReminderNotificationPolling() {
  if (_reminderPollStarted) return; // renderShell can be called more than once per page
  _reminderPollStarted = true;

  const POLL_INTERVAL_MS = 60000;

  async function pollOnce() {
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) return;

      const { data: rows, error } = await supabaseClient
        .from("notifications")
        .select("id, title, body, reminder_type, schedule_id, source, label, snooze_minutes")
        .eq("user_id", user.id)
        .eq("is_read", false)
        .order("created_at", { ascending: true })
        .limit(10);

      if (error || !rows?.length) return;

      for (const n of rows) {
        // Show ONE of (in-page toast, native OS notification) per row, not
        // both — previously both always fired for every single
        // notification, which is what made e.g. the wake-up reminder look
        // like it "doubled up" even with just one sleep schedule. If the
        // tab is in the foreground, the in-page toast (with its Snooze
        // button, when applicable) is the better experience; if it's
        // backgrounded/minimized, the OS notification is the only one the
        // person will actually see, so that's the one we show.
        const tabIsVisible = document.visibilityState === "visible";
        const canUseNativeNotification = "Notification" in window && Notification.permission === "granted";

        if (tabIsVisible || !canUseNativeNotification) {
          const canSnooze = n.reminder_type === "sleep" && n.schedule_id && n.snooze_minutes;
          if (canSnooze && typeof showSnoozableToast === "function") {
            showSnoozableToast(n);
          } else if (typeof showToast === "function") {
            showToast(`${n.title}: ${n.body}`, "success", 6000);
          }
        } else {
          try { new Notification(n.title, { body: n.body }); } catch (_) { /* ignore */ }
        }
      }

      const ids = rows.map((n) => n.id);
      await supabaseClient.from("notifications").update({ is_read: true }).in("id", ids);
    } catch (err) {
      console.warn("Reminder notification poll failed:", err);
    }
  }

  pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

// Sleep Reminder upgrade — a toast with an inline "Snooze" button for
// bedtime/pre-bedtime notifications. Reuses the same toast-container /
// toast styling as showToast() in js/ui.js so it looks identical, just
// with one extra control. Clicking Snooze inserts a row into
// reminder_snoozes; the Reminder Engine picks it up on its next tick and
// sends a one-off reminder `snooze_minutes` later (see
// docs/REMINDER_ENGINE.md).
function showSnoozableToast(notification) {
  let container = document.querySelector(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = "toast success";
  toast.innerHTML = `
    <span class="toast-icon">⏰</span>
    <span>${notification.title}: ${notification.body}</span>
    <button type="button" class="btn btn-ghost btn-sm" data-role="snooze-btn" style="margin-left:8px;white-space:nowrap;">
      😴 ${t ? t("sleep_snooze_toast_btn", "Snooze") : "Snooze"} ${notification.snooze_minutes}m
    </button>
  `;
  container.appendChild(toast);

  const dismiss = () => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 300);
  };
  const autoDismiss = setTimeout(dismiss, 8000);

  qs('[data-role="snooze-btn"]', toast)?.addEventListener("click", async (e) => {
    clearTimeout(autoDismiss);
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) return;
      const fireAt = new Date(Date.now() + notification.snooze_minutes * 60000).toISOString();
      const { error } = await supabaseClient.from("reminder_snoozes").insert({
        user_id: user.id,
        reminder_type: "sleep",
        schedule_id: notification.schedule_id,
        label: notification.label || null,
        fire_at: fireAt
      });
      if (error) {
        if (typeof showToast === "function") showToast(error.message, "error");
      } else if (typeof showToast === "function") {
        showToast(t ? t("sleep_snoozed_toast", "Snoozed for {minutes} minutes.").replace("{minutes}", notification.snooze_minutes)
          : `Snoozed for ${notification.snooze_minutes} minutes.`, "success");
      }
    } catch (err) {
      console.warn("Snooze failed:", err);
    } finally {
      dismiss();
    }
  });
}
