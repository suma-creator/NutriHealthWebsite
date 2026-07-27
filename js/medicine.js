/* =========================================================================
   medicine.js
   ========================================================================= */

let medUser = null;

document.addEventListener("DOMContentLoaded", async () => {
  medUser = await requireAuth();
  if (!medUser) return;

  renderShell("medicine.html");
  await loadUserChip(medUser);
  await loadReminders();
  prefillFromQueryParams();
  hidePageLoader();

  qs("#medForm").addEventListener("submit", handleAddReminder);
});

// If arriving from the Symptom Checker's "Add to Medicine Reminders" link,
// pre-fill the form with the suggested medicine so the user just needs to
// pick a time and confirm.
function prefillFromQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get("name");
  if (!name) return;

  qs("#medName").value = name;

  const dosage = params.get("dosage");
  if (dosage && dosage !== "—") qs("#medDosage").value = dosage;

  const frequency = params.get("frequency");
  const frequencySelect = qs("#medFrequency");
  if (frequency && frequency !== "—" && [...frequencySelect.options].some((opt) => opt.value === frequency)) {
    frequencySelect.value = frequency;
  }

  showToast(t("toast_medicine_suggested", 'Suggested from your symptom check — pick a time and add "{name}" below.').replace("{name}", name), "info", 5000);
  qs("#medTime")?.focus();
}

async function handleAddReminder(event) {
  event.preventDefault();
  const btn = qs("#medBtn");

  const payload = {
    user_id: medUser.id,
    medicine_name: qs("#medName").value.trim(),
    dosage: qs("#medDosage").value.trim(),
    frequency: qs("#medFrequency").value,
    time: qs("#medTime").value,
    notes: qs("#medNotes")?.value.trim() || null
  };

  setBtnLoading(btn, true, "Adding...");
  const { error } = await supabaseClient.from("medicine_reminders").insert(payload);
  setBtnLoading(btn, false, t("medicine_add_reminder_btn", "Add reminder"));

  if (error) { showToast(error.message, "error"); return; }

  showToast(t("toast_medicine_added", "Reminder added!"), "success");
  qs("#medForm").reset();
  await loadReminders();
}

function playReminderTone() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.18);
  } catch (error) {
    console.warn("Reminder tone not supported", error);
  }
}

async function loadReminders() {
  const [{ data, error }, { data: doseLogs }] = await Promise.all([
    supabaseClient.from("medicine_reminders").select("*").eq("user_id", medUser.id).order("time", { ascending: true }),
    supabaseClient.from("medicine_dose_logs").select("medicine_id, status").eq("user_id", medUser.id).eq("log_date", todayDateStr())
  ]);

  const container = qs("#medList");

  if (error || !data || !data.length) {
    container.innerHTML = `<p class="text-sm text-muted">No reminders yet — add your first one.</p>`;
    return;
  }

  const doseByMedId = {};
  (doseLogs || []).forEach((d) => { doseByMedId[d.medicine_id] = d.status; });

  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const nowMs = Date.now();
  let hasDueSoon = false;

  container.innerHTML = data.map((r) => {
    const [h, m] = r.time.split(":").map(Number);
    const dueMinutes = h * 60 + m;
    const isSnoozed = r.snoozed_until && new Date(r.snoozed_until).getTime() > nowMs;
    const isDueSoon = r.active !== false && !isSnoozed && Math.abs(dueMinutes - nowMinutes) <= 30;
    if (isDueSoon) hasDueSoon = true;

    const doseStatus = doseByMedId[r.id]; // 'taken' | 'skipped' | undefined
    const isPaused = r.active === false;

    const doseBadge = doseStatus === "taken"
      ? `<span class="text-sm" style="color:var(--color-mint);font-weight:700;">${t("med_dose_taken", "✅ Taken today")}</span>`
      : doseStatus === "skipped"
        ? `<span class="text-sm" style="color:var(--color-coral);font-weight:700;">${t("med_dose_skipped", "❌ Skipped today")}</span>`
        : "";

    const doseActions = !doseStatus && !isPaused ? `
        <div class="flex gap-8 mt-8">
          <button class="btn btn-outline btn-sm" onclick="logMedDose('${r.id}','taken')">${t("med_mark_taken", "✅ Taken")}</button>
          <button class="btn btn-ghost btn-sm" onclick="logMedDose('${r.id}','skipped')">${t("med_mark_skipped", "❌ Skip today")}</button>
        </div>` : "";

    const snoozeActions = isDueSoon ? `
        <div class="flex gap-8 mt-8">
          <span class="text-sm text-muted" style="align-self:center;">${t("med_snooze_label", "Snooze:")}</span>
          <button class="btn btn-ghost btn-sm" onclick="snoozeMedReminder('${r.id}',10)">10m</button>
          <button class="btn btn-ghost btn-sm" onclick="snoozeMedReminder('${r.id}',15)">15m</button>
          <button class="btn btn-ghost btn-sm" onclick="snoozeMedReminder('${r.id}',30)">30m</button>
        </div>` : "";

    return `
      <div class="flex-between" style="padding:12px 14px;border-radius:12px;border:1px solid var(--color-border);align-items:flex-start;${isDueSoon ? "background:var(--color-primary-light);" : ""}${isPaused ? "opacity:0.6;" : ""}">
        <div style="flex:1;">
          <div style="font-weight:600;">
            ${r.medicine_name}
            ${isDueSoon ? `<span class="text-sm" style="color:var(--color-primary);"> · ${t("med_due_soon", "due soon")}</span>` : ""}
            ${isPaused ? `<span class="text-sm text-muted"> · ${t("med_paused", "paused")}</span>` : ""}
            ${isSnoozed ? `<span class="text-sm text-muted"> · ${t("med_snoozed_until", "snoozed until")} ${formatTime12h(new Date(r.snoozed_until).toTimeString().slice(0,5))}</span>` : ""}
          </div>
          <div class="text-sm text-muted">${r.dosage || "No dosage set"} · ${r.frequency}</div>
          ${r.notes ? `<div class="text-sm text-muted mt-6">📝 ${escapeHtmlMed(r.notes)}</div>` : ""}
          <div class="mt-6">${doseBadge}</div>
          ${doseActions}
          ${snoozeActions}
        </div>
        <div class="flex-col gap-8" style="align-items:flex-end;">
          <span class="mono text-sm" style="font-weight:600;">${formatTime12h(r.time)}</span>
          <label class="switch" title="${t("med_pause_toggle_title", "Pause/resume this reminder")}">
            <input type="checkbox" ${r.active === false ? "" : "checked"} onchange="toggleMedActive('${r.id}', this.checked)" />
            <span class="switch-track"></span>
          </label>
          <button class="btn btn-ghost btn-sm" onclick="deleteReminder('${r.id}')" aria-label="Delete reminder">🗑️</button>
        </div>
      </div>
    `;
  }).join("");

  if (hasDueSoon) {
    playReminderTone();
  }
}

function escapeHtmlMed(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function toggleMedActive(id, active) {
  const { error } = await supabaseClient.from("medicine_reminders").update({ active }).eq("id", id);
  if (error) { showToast(error.message, "error"); await loadReminders(); return; }
  showToast(active ? t("med_resumed_toast", "Reminder resumed") : t("med_paused_toast", "Reminder paused"), "success");
  await loadReminders();
}

async function snoozeMedReminder(id, minutes) {
  const snoozedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const { error } = await supabaseClient.from("medicine_reminders").update({ snoozed_until: snoozedUntil }).eq("id", id);
  if (error) { showToast(error.message, "error"); return; }
  showToast(t("med_snoozed_toast", "Reminder snoozed {minutes} minutes.").replace("{minutes}", minutes), "success");
  await loadReminders();
}

async function logMedDose(medicineId, status) {
  const { error } = await supabaseClient.from("medicine_dose_logs").upsert({
    user_id: medUser.id,
    medicine_id: medicineId,
    log_date: todayDateStr(),
    status
  }, { onConflict: "medicine_id,log_date" });

  if (error) { showToast(error.message, "error"); return; }
  showToast(status === "taken" ? t("med_dose_taken_toast", "Marked as taken") : t("med_dose_skipped_toast", "Marked as skipped for today"), "success");
  await loadReminders();
}

async function deleteReminder(id) {
  const { error } = await supabaseClient.from("medicine_reminders").delete().eq("id", id);
  if (error) { showToast(error.message, "error"); return; }
  showToast(t("toast_medicine_removed", "Reminder removed"), "info");
  await loadReminders();
}
