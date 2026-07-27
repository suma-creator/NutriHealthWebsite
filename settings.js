/* =========================================================================
   settings.js — wires up settings.html (Appearance, Notifications, Privacy,
   Language, Account). Preferences are stored in the users.settings jsonb
   column so the upcoming Notifications system can read them.
   ========================================================================= */

let settingsUser = null;
let userSettings = {};

document.addEventListener("DOMContentLoaded", async () => {
  settingsUser = await requireAuth();
  if (!settingsUser) return;

  renderShell("settings.html");
  await loadUserChip(settingsUser);
  await loadSettings();
  hidePageLoader();

  wireAppearance();
  wireNotifications();
  wireWhatsApp();
  wirePrivacy();
  wireLanguage();
  wirePassword();
  wireDeleteAccount();
});

async function loadSettings() {
  const { data, error } = await supabaseClient
    .from("users")
    .select("settings")
    .eq("id", settingsUser.id)
    .single();

  if (error) {
    console.error("Failed to load settings:", error);
    userSettings = {};
  } else {
    userSettings = data?.settings || {};
  }

  qs("#notifMedicineToggle").checked = userSettings.notifyMedicine !== false; // default on
  qs("#notifDailyToggle").checked = userSettings.notifyDaily !== false; // default on
  qs("#privacyAnonToggle").checked = userSettings.shareAnonymousData === true; // default off
  qs("#languageSelect").value = userSettings.language || "en";
}

async function saveSettings(patch) {
  userSettings = { ...userSettings, ...patch };
  const { error } = await supabaseClient
    .from("users")
    .update({ settings: userSettings })
    .eq("id", settingsUser.id);

  if (error) showToast(error.message, "error");
  return !error;
}

/* ---------------- Appearance ---------------- */
function wireAppearance() {
  const toggle = qs("#darkModeToggle");
  toggle.checked = (localStorage.getItem("nh_theme") || "light") === "dark";
  toggle.addEventListener("change", () => {
    toggleTheme();
    toggle.checked = (localStorage.getItem("nh_theme") || "light") === "dark";
  });
}

/* ---------------- Notifications ---------------- */
function wireNotifications() {
  const permBtn = qs("#notifPermissionBtn");
  const permNote = qs("#notifPermissionNote");

  function refreshPermissionUI() {
    if (!("Notification" in window)) {
      permBtn.disabled = true;
      permBtn.textContent = t("settings_not_supported", "Not supported");
      permNote.textContent = t("settings_no_notif_support", "Your browser doesn't support notifications.");
      return;
    }
    if (Notification.permission === "granted") {
      permBtn.textContent = t("settings_enabled", "Enabled");
      permBtn.disabled = true;
      permNote.textContent = t("settings_reminders_can_send", "Reminders can be sent to this browser.");
    } else if (Notification.permission === "denied") {
      permBtn.textContent = t("settings_blocked", "Blocked");
      permBtn.disabled = true;
      permNote.textContent = "Notifications are blocked in your browser settings — enable them there to receive reminders.";
    } else {
      permBtn.textContent = t("settings_enable", "Enable");
      permBtn.disabled = false;
      permNote.textContent = t("settings_browser_notif_desc", "Allow NutriHealth to send reminders to this browser.");
    }
  }

  permBtn.addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    refreshPermissionUI();
    if (result === "granted") {
      showToast(t("toast_settings_notif_enabled", "Notifications enabled!"), "success");
      new Notification("NutriHealth", { body: "You're all set — you'll get reminders here." });
    }
  });

  refreshPermissionUI();

  qs("#notifMedicineToggle").addEventListener("change", async (e) => {
    const ok = await saveSettings({ notifyMedicine: e.target.checked });
    if (ok) showToast("Preference saved.", "success");
  });

  qs("#notifDailyToggle").addEventListener("change", async (e) => {
    const ok = await saveSettings({ notifyDaily: e.target.checked });
    if (ok) showToast("Preference saved.", "success");
  });
}

/* ---------------- WhatsApp Reminders ---------------- */
// The remaining reminder delivery channel, alongside the existing browser
// notifications and per-type toggles above. All state changes go through
// the "whatsapp-verify" Edge Function (never a direct table write) so a
// number can never be marked verified without actually receiving a code.
/* ---------------- WhatsApp Reminders ---------------- */
function wireWhatsApp() {
  const statusText = qs("#whatsappStatusText");
  const numberGroup = qs("#whatsappNumberGroup");
  const numberInput = qs("#whatsappNumberInput");
  const sendCodeBtn = qs("#whatsappSendCodeBtn");
  const codeGroup = qs("#whatsappCodeGroup");
  const codeInput = qs("#whatsappCodeInput");
  const verifyBtn = qs("#whatsappVerifyBtn");
  const cancelCodeBtn = qs("#whatsappCancelCodeBtn");
  const toggleGroup = qs("#whatsappToggleGroup");
  const enabledToggle = qs("#whatsappEnabledToggle");
  const verifiedNumberEl = qs("#whatsappVerifiedNumber");
  const changeNumberBtn = qs("#whatsappChangeNumberBtn");

  async function callWhatsApp(action, params = {}) {
    const { data, error } = await supabaseClient.functions.invoke(
      "whatsapp-verify",
      {
        body: {
          action,
          ...params,
        },
      }
    );

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return data;
  }

  async function refreshStatus() {
    const res = await callWhatsApp("get-status");

    if (!res.success) {
      statusText.textContent = "Couldn't load WhatsApp status.";
      return;
    }

    if (res.verified) {
      numberGroup.style.display = "none";
      codeGroup.style.display = "none";
      toggleGroup.style.display = "flex";
      changeNumberBtn.style.display = "inline-flex";
      verifiedNumberEl.textContent = res.phone_number || "";
      statusText.textContent = res.enabled ? "Verified" : "Verified (reminders off)";
      enabledToggle.checked = !!res.enabled;
    } else {
      numberGroup.style.display = "block";
      codeGroup.style.display = "none";
      toggleGroup.style.display = "none";
      changeNumberBtn.style.display = "none";
      statusText.textContent = res.last_send_error
        ? `Not verified — last error: ${res.last_send_error}`
        : "Not configured";
      if (res.phone_number) numberInput.value = res.phone_number;
    }
  }

  sendCodeBtn.addEventListener("click", async () => {
    const phone = numberInput.value.trim();

    if (!phone) {
      showToast("Enter your WhatsApp number.", "error");
      return;
    }

    setBtnLoading(sendCodeBtn, true, "Sending...");

    const res = await callWhatsApp("send-code", {
      phone_number: phone,
    });

    setBtnLoading(sendCodeBtn, false, "Send verification code");

    if (!res.success) {
      showToast(res.error || "Couldn't send code.", "error");
      return;
    }

    showToast("Code sent successfully. Check WhatsApp.", "success");

    numberGroup.style.display = "none";
    codeGroup.style.display = "block";
    codeInput.value = "";
  });

  verifyBtn.addEventListener("click", async () => {
    const code = codeInput.value.trim();

    if (!/^\d{6}$/.test(code)) {
      showToast("Enter the 6-digit code.", "error");
      return;
    }

    setBtnLoading(verifyBtn, true, "Verifying...");
    const res = await callWhatsApp("verify-code", { code });
    setBtnLoading(verifyBtn, false, "Verify");

    if (!res.success) {
      showToast(res.error || "Couldn't verify that code.", "error");
      return;
    }

    showToast("Verification successful.", "success");
    await refreshStatus();
  });

  cancelCodeBtn.addEventListener("click", () => {
    codeGroup.style.display = "none";
    numberGroup.style.display = "block";
  });

  changeNumberBtn.addEventListener("click", () => {
    numberGroup.style.display = "block";
    codeGroup.style.display = "none";
    toggleGroup.style.display = "none";
    changeNumberBtn.style.display = "none";
    numberInput.value = "";
    statusText.textContent = "Not configured";
  });

  enabledToggle.addEventListener("change", async (e) => {
    const desired = e.target.checked;
    const res = await callWhatsApp("toggle", { enabled: desired });

    if (!res.success) {
      e.target.checked = !desired; // revert on failure
      showToast(res.error || "Couldn't update the setting.", "error");
      return;
    }

    statusText.textContent = desired ? "Verified" : "Verified (reminders off)";
    showToast("WhatsApp reminders updated.", "success");
  });

  refreshStatus();
}

/* ---------------- Privacy ---------------- */
function wirePrivacy() {
  qs("#privacyAnonToggle").addEventListener("change", async (e) => {
    const ok = await saveSettings({ shareAnonymousData: e.target.checked });
    if (ok) showToast("Preference saved.", "success");
  });

  qs("#exportDataBtn").addEventListener("click", exportUserData);
}

async function exportUserData() {
  const btn = qs("#exportDataBtn");
  btn.disabled = true;
  btn.textContent = t("settings_preparing", "Preparing...");

  const tables = [
    "bmi_logs", "symptom_logs", "vital_signs", "reports", "prevention_history",
    "water_logs", "medicine_reminders", "sleep_logs", "food_scans",
    "nutrition_plans", "diet_plans", "family_profiles", "food_logs", "exercise_logs"
  ];

  try {
    const [profileRes, ...rest] = await Promise.all([
      supabaseClient.from("users").select("*").eq("id", settingsUser.id).single(),
      ...tables.map((t) => supabaseClient.from(t).select("*").eq("user_id", settingsUser.id))
    ]);

    const exportPayload = { profile: profileRes.data || null };
    tables.forEach((t, i) => { exportPayload[t] = rest[i].data || []; });

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nutrihealth-ai-data-${todayDateStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast(t("toast_settings_data_downloaded", "Your data has been downloaded."), "success");
  } catch (err) {
    console.error(err);
    showToast(t("toast_settings_export_fail", "Couldn't export your data. Please try again."), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = t("settings_download_data", "Download my data");
  }
}

/* ---------------- Language ---------------- */
function wireLanguage() {
  qs("#languageSelect").addEventListener("change", async (e) => {
    if (typeof setLang === "function") setLang(e.target.value);
    const ok = await saveSettings({ language: e.target.value });
    if (ok) showToast(t("settings_language_saved", "Language preference saved."), "success");
  });
}

/* ---------------- Password ---------------- */
function wirePassword() {
  qs("#passwordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = qs("#newPassword");
    const btn = qs("#passwordBtn");
    const password = input.value;

    if (!password || password.length < 6) {
      showToast(t("toast_settings_pw_min", "Password must be at least 6 characters."), "error");
      return;
    }

    btn.disabled = true;
    btn.textContent = t("settings_updating", "Updating...");

    const { error } = await supabaseClient.auth.updateUser({ password });

    btn.disabled = false;
    btn.textContent = t("settings_update_password", "Update password");

    if (error) {
      showToast(error.message, "error");
      return;
    }

    input.value = "";
    showToast(t("toast_settings_pw_updated", "Password updated."), "success");
  });
}

/* ---------------- Delete account ---------------- */
function wireDeleteAccount() {
  qs("#deleteAccountBtn").addEventListener("click", async () => {
    const first = confirm(
      t("settings_delete_confirm", "This permanently deletes your account and every piece of data associated with it — BMI history, food logs, symptom checks, reports, everything. This cannot be undone.\n\nContinue?")
    );
    if (!first) return;

    const typed = prompt(t("settings_delete_type_confirm", 'Type "DELETE" to confirm.'));
    if (typed !== "DELETE") {
      if (typed !== null) showToast(t("settings_delete_cancelled", "Account deletion cancelled — text didn't match."), "warning");
      return;
    }

    const btn = qs("#deleteAccountBtn");
    btn.disabled = true;
    btn.textContent = t("settings_deleting", "Deleting...");

    const { data, error } = await supabaseClient.functions.invoke("delete-account", { body: {} });

    if (error || data?.ok === false) {
      const message = data?.error || error?.message || "Couldn't delete your account. Please try again.";
      showToast(message, "error", 6000);
      btn.disabled = false;
      btn.textContent = t("settings_delete_my_account", "Delete my account");
      return;
    }

    await supabaseClient.auth.signOut();
    alert(t("settings_account_deleted", "Your account and all associated data have been permanently deleted."));
    window.location.href = "index.html";
  });
}
