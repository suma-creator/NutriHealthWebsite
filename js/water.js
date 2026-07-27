/* =========================================================================
   water.js
   ========================================================================= */

let waterUser = null;
let todayWaterRow = null; // holds the row id for today's log, if it exists
let waterProfileCtx = null;

document.addEventListener("DOMContentLoaded", async () => {
  waterUser = await requireAuth();
  if (!waterUser) return;

  renderShell("water.html");
  await loadUserChip(waterUser);
  await loadTodayWater();

  waterProfileCtx = await initProfileSelector({
    containerId: "profileSelector",
    user: waterUser,
    fields: ["weight"],
    fieldIds: { weight: "wWeight" }
  });

  hidePageLoader();

  qs("#waterForm").addEventListener("submit", handleGoalUpdate);
});

async function loadTodayWater() {
  const { data } = await supabaseClient
    .from("water_logs")
    .select("*")
    .eq("user_id", waterUser.id)
    .eq("log_date", todayDateStr())
    .limit(1);

  if (data && data.length) {
    todayWaterRow = data[0];
  } else {
    // No log yet today — create one with a default 2000ml goal.
    const { data: created } = await supabaseClient
      .from("water_logs")
      .insert({ user_id: waterUser.id, recommended_water: 2000, consumed_water: 0, log_date: todayDateStr() })
      .select()
      .single();
    todayWaterRow = created;
  }
  renderWater();
}

function renderWater() {
  if (!todayWaterRow) return;
  const { consumed_water, recommended_water } = todayWaterRow;
  qs("#waterConsumed").textContent = `${consumed_water} ml`;
  qs("#waterGoal").textContent = `${recommended_water} ml`;
  const pct = Math.min(100, Math.round((consumed_water / recommended_water) * 100));
  qs("#waterProgressBar").style.width = `${pct}%`;
}

async function addWater(amount) {
  if (!todayWaterRow) return;
  const newAmount = todayWaterRow.consumed_water + amount;

  const { data, error } = await supabaseClient
    .from("water_logs")
    .update({ consumed_water: newAmount })
    .eq("id", todayWaterRow.id)
    .select()
    .single();

  if (error) { showToast(error.message, "error"); return; }

  todayWaterRow = data;
  renderWater();
  showToast(t("toast_water_amount_logged", "+{amount}ml logged 💧").replace("{amount}", amount), "success", 2000);

  if (data.consumed_water >= data.recommended_water) {
    showToast(t("toast_water_goal_reached", "Daily water goal reached! 🎉"), "success");
  }
}

async function resetWater() {
  if (!todayWaterRow) return;
  const { data, error } = await supabaseClient
    .from("water_logs")
    .update({ consumed_water: 0 })
    .eq("id", todayWaterRow.id)
    .select()
    .single();

  if (error) { showToast(error.message, "error"); return; }
  todayWaterRow = data;
  renderWater();
}

async function handleGoalUpdate(event) {
  event.preventDefault();
  const btn = qs("#waterBtn");
  const weight = parseFloat(qs("#wWeight").value);
  const recommended = Math.round(weight * 35);
  const mode = waterProfileCtx ? waterProfileCtx.getMode() : "me";

  if (mode === "me") {
    setBtnLoading(btn, true, "Updating...");

    const { data, error } = await supabaseClient
      .from("water_logs")
      .update({ recommended_water: recommended })
      .eq("id", todayWaterRow.id)
      .select()
      .single();

    setBtnLoading(btn, false, t("water_update_btn", "Update daily goal"));

    if (error) { showToast(error.message, "error"); return; }

    todayWaterRow = data;
    renderWater();
    qs("#waterOtherResult").style.display = "none";
    showToast(t("toast_water_goal_set", "Daily goal set to {amount}ml").replace("{amount}", recommended), "success");
  } else {
    const box = qs("#waterOtherResult");
    box.style.display = "block";
    box.innerHTML = `
      <div class="text-sm badge-temp mb-8">Temporary calculation — your own daily goal is unchanged.</div>
      <div class="card" style="padding:16px;text-align:center;">
        <div class="text-sm text-muted">Recommended daily intake</div>
        <div class="stat-value" style="font-size:1.8rem;">${recommended} ml</div>
      </div>
    `;
    if (waterProfileCtx) await waterProfileCtx.maybeSaveFamilyProfile();
    showToast(t("toast_water_temp", "Temporary water goal calculated."), "success");
  }
}
