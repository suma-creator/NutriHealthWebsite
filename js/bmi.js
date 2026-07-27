/* =========================================================================
   bmi.js
   ========================================================================= */

let currentUser = null;
let bmiProfileCtx = null;

document.addEventListener("DOMContentLoaded", async () => {
  currentUser = await requireAuth();
  if (!currentUser) return;

  renderShell("bmi.html");
  await loadUserChip(currentUser);
  await loadBmiHistory();

  bmiProfileCtx = await initProfileSelector({
    containerId: "profileSelector",
    user: currentUser,
    fields: ["height", "weight"],
    fieldIds: { height: "height", weight: "weight" }
  });

  hidePageLoader();

  qs("#bmiForm").addEventListener("submit", handleBmiSubmit);
});

async function handleBmiSubmit(event) {
  event.preventDefault();
  const btn = qs("#bmiBtn");
  const height = parseFloat(qs("#height").value);
  const weight = parseFloat(qs("#weight").value);

  const heightM = height / 100;
  const bmi = +(weight / (heightM * heightM)).toFixed(1);
  const { category, tip, color } = getBmiCategory(bmi);

  const mode = bmiProfileCtx ? bmiProfileCtx.getMode() : "me";

  if (mode === "me") {
    setBtnLoading(btn, true, "Saving...");

    const { error } = await supabaseClient.from("bmi_logs").insert({
      user_id: currentUser.id,
      height,
      weight,
      bmi,
      category
    });

    setBtnLoading(btn, false, t("bmi_calculate_save_btn", "Calculate & save"));

    if (error) {
      showToast(error.message, "error");
      return;
    }

    showResult(bmi, category, tip, color, { persisted: true });
    showToast(t("toast_bmi_saved", "BMI calculated and saved!"), "success");
    await loadBmiHistory();
  } else {
    showResult(bmi, category, tip, color, { persisted: false });
    if (bmiProfileCtx) await bmiProfileCtx.maybeSaveFamilyProfile();
    showToast(t("toast_bmi_temp", "Temporary BMI calculated — this won't be saved to your history."), "success");
  }
}

function showResult(bmi, category, tip, color, { persisted = true } = {}) {
  const grid = qs("#bmiGrid");
  if (grid) {
    grid.classList.add("grid-2");
    grid.style.gridTemplateColumns = "1fr 1fr";
  }
  qs("#resultCard").style.display = "block";
  qs("#resultBmi").textContent = bmi;
  qs("#resultCategory").textContent = category;
  qs("#resultTip").textContent = tip;
  qs("#resultIcon").className = `stat-icon ${color}`;

  let badge = qs("#bmiTempBadge");
  const resultCard = qs("#resultCard");
  if (!persisted) {
    if (!badge && resultCard) {
      badge = document.createElement("div");
      badge.id = "bmiTempBadge";
      badge.className = "text-sm badge-temp mb-16";
      badge.textContent = t("bmi_temp_calc_note", "Temporary calculation — not saved to your BMI history.");
      resultCard.insertBefore(badge, resultCard.firstChild);
    }
  } else if (badge) {
    badge.remove();
  }
}

async function loadBmiHistory() {
  const { data, error } = await supabaseClient
    .from("bmi_logs")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(10);

  const body = qs("#historyBody");

  if (error || !data || !data.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-sm text-muted" style="padding:16px 0;">${t("bmi_no_entries_yet", "No entries yet — calculate your first BMI above.")}</td></tr>`;
    return;
  }

  // Show the most recent result in the result card too
  const latest = data[0];
  const cat = getBmiCategory(latest.bmi);
  showResult(latest.bmi, latest.category, cat.tip, cat.color);

  body.innerHTML = data.map((row) => `
    <tr style="border-bottom:1px solid var(--color-border);">
      <td style="padding:10px 0;" class="text-sm">${formatDate(row.created_at)}</td>
      <td style="padding:10px 0;" class="text-sm">${row.height} cm</td>
      <td style="padding:10px 0;" class="text-sm">${row.weight} kg</td>
      <td style="padding:10px 0;" class="text-sm mono" style="font-weight:600;">${row.bmi}</td>
      <td style="padding:10px 0;" class="text-sm">${row.category}</td>
    </tr>
  `).join("");
}
