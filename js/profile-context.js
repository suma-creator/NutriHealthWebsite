/* =========================================================================
   profile-context.js
   Shared "My Profile" vs "Someone Else" selector, used by any calculator
   page that needs personal biometrics (Nutrition, BMI, Water Intake, etc).

   Usage (after auth.js + supabaseClient are ready):

     const ctx = await initProfileSelector({
       containerId: "profileSelector",       // an empty <div> in the form card
       user: currentUser,
       fields: ["age", "gender", "height", "weight"],
       fieldIds: { age: "nAge", gender: "nGender", height: "nHeight", weight: "nWeight" }
     });

     // Inside your submit handler:
     if (ctx.getMode() === "me") {
       // save the result to the user's own history as usual
     } else {
       // "Someone Else" — show the result but don't save it to the
       // signed-in user's own history/plan.
       await ctx.maybeSaveFamilyProfile();
     }

   Requires an (optional) `family_profiles` table — see sql/schema.sql.
   If that table doesn't exist yet, the "Saved Family Profiles" part of
   the UI is simply skipped and everything else still works.
   ========================================================================= */

const FAMILY_PROFILES_TABLE = "family_profiles";

async function fetchMyProfile(user) {
  try {
    const { data, error } = await supabaseClient
      .from("users")
      .select("name,email,age,gender,height,weight")
      .eq("id", user.id)
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn("Could not load profile for selector:", err.message || err);
    return null;
  }
}

async function fetchFamilyProfiles(user) {
  try {
    const { data, error } = await supabaseClient
      .from(FAMILY_PROFILES_TABLE)
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (err) {
    // Table probably doesn't exist yet if the migration hasn't been run.
    // Fail quietly — "Someone Else" mode still works without saved profiles.
    return [];
  }
}

async function saveFamilyProfileRow(user, profile) {
  try {
    const { data, error } = await supabaseClient
      .from(FAMILY_PROFILES_TABLE)
      .insert({ user_id: user.id, ...profile })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    showToast(t("toast_profile_save_fail", "Couldn't save this profile (family profiles may not be set up yet)."), "error");
    return null;
  }
}

async function deleteFamilyProfileRow(id) {
  try {
    const { error } = await supabaseClient.from(FAMILY_PROFILES_TABLE).delete().eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    showToast(err.message || t("toast_profile_delete_fail", "Couldn't delete that profile."), "error");
    return false;
  }
}

function profileFieldLabels() {
  return { age: t("pf_age", "Age"), gender: t("pf_gender", "Gender"), height: t("pf_height", "Height"), weight: t("pf_weight", "Weight") };
}
const PROFILE_FIELD_UNITS = { height: " cm", weight: " kg" };

async function initProfileSelector({ containerId, user, fields, fieldIds }) {
  const container = qs(`#${containerId}`);
  if (!container) return { getMode: () => "me", maybeSaveFamilyProfile: async () => {} };

  const myProfile = await fetchMyProfile(user);
  let familyProfiles = await fetchFamilyProfiles(user);
  let mode = "me";

  const fieldEl = (field) => qs(`#${fieldIds[field]}`);

  function setFieldValues(values, lock) {
    fields.forEach((field) => {
      const el = fieldEl(field);
      if (!el) return;
      const value = values ? values[field] : "";
      el.value = value === null || value === undefined ? "" : value;
      if (el.tagName === "SELECT") {
        el.disabled = !!lock;
      } else {
        el.readOnly = !!lock;
      }
      el.classList.toggle("field-locked", !!lock);
    });
  }

  function summaryLine(values) {
    const parts = fields.map((f) => {
      const val = values?.[f];
      const display = val === null || val === undefined || val === "" ? t("pf_not_set", "not set") : `${val}${PROFILE_FIELD_UNITS[f] || ""}`;
      return `${profileFieldLabels()[f]}: ${display}`;
    });
    return parts.join(" &nbsp;·&nbsp; ");
  }

  function renderBody() {
    const body = qs("#profileSelectorBody", container);

    if (mode === "me") {
      const missing = fields.filter((f) => myProfile?.[f] === null || myProfile?.[f] === undefined || myProfile?.[f] === "");
      body.innerHTML = `
        <div class="profile-summary-box">
          <div class="text-sm text-muted">${t("pf_using_saved", "Using your saved profile")}</div>
          <div class="text-sm mt-6" style="font-weight:600;">${summaryLine(myProfile)}</div>
          ${missing.length ? `<div class="text-sm mt-8">${t("pf_missing", "Missing")} ${missing.map((m) => profileFieldLabels()[m]).join(", ")} — <a href="profile.html">${t("pf_complete_profile", "complete your profile")}</a> ${t("pf_for_accurate", "for an accurate result.")}</div>` : ""}
        </div>
      `;
      setFieldValues(myProfile, true);
    } else {
      const savedOptions = familyProfiles
        .map((p) => `<option value="${p.id}">${p.name}</option>`)
        .join("");

      body.innerHTML = `
        <div class="profile-someone-else">
          <div class="text-sm badge-temp">${t("pf_temp_calc", "Temporary calculation — this won't be saved to your account history.")}</div>
          ${familyProfiles.length ? `
            <div class="form-group mt-12">
              <label class="form-label" for="${containerId}FamilySelect">${t("pf_load_saved", "Load a saved profile")}</label>
              <select class="form-select" id="${containerId}FamilySelect">
                <option value="">${t("pf_enter_manually", "— Enter manually —")}</option>
                ${savedOptions}
              </select>
            </div>
          ` : `<div class="text-sm text-muted mt-12">${t("pf_no_family_profiles", 'No saved family profiles yet — fill in the fields below and check "Save this person" to add one.')}</div>`}
          <div class="form-group mt-12">
            <label class="form-label" for="${containerId}OtherName">${t("pf_their_name", "Their name")}</label>
            <input class="form-input" type="text" id="${containerId}OtherName" placeholder="${t('pf_name_ph', 'e.g. Mom, Alex, a client')}" />
          </div>
          <label class="text-sm profile-save-check">
            <input type="checkbox" id="${containerId}SaveCheck" /> ${t("pf_save_person", "Save this person as a family profile for next time")}
          </label>
          ${familyProfiles.length ? `<div class="mt-8" id="${containerId}FamilyManage"></div>` : ""}
        </div>
      `;

      setFieldValues({}, false);

      const familySelect = qs(`#${containerId}FamilySelect`, container);
      if (familySelect) {
        familySelect.addEventListener("change", () => {
          const selected = familyProfiles.find((p) => String(p.id) === familySelect.value);
          if (selected) {
            setFieldValues(selected, false);
            qs(`#${containerId}OtherName`, container).value = selected.name || "";
          } else {
            setFieldValues({}, false);
            qs(`#${containerId}OtherName`, container).value = "";
          }
        });
      }

      const manageBox = qs(`#${containerId}FamilyManage`, container);
      if (manageBox && familyProfiles.length) {
        manageBox.innerHTML = familyProfiles
          .map((p) => `<button type="button" class="chip chip-remove" data-id="${p.id}">${t("pf_remove", "Remove")} ${p.name} ✕</button>`)
          .join(" ");
        qsa(".chip-remove", manageBox).forEach((btn) => {
          btn.addEventListener("click", async () => {
            const ok = await deleteFamilyProfileRow(btn.dataset.id);
            if (ok) {
              familyProfiles = familyProfiles.filter((p) => String(p.id) !== btn.dataset.id);
              showToast(t("toast_profile_removed", "Family profile removed."), "success");
              renderBody();
            }
          });
        });
      }
    }
  }

  container.innerHTML = `
    <div class="profile-selector-toggle">
      <label class="profile-toggle-pill">
        <input type="radio" name="${containerId}Mode" value="me" checked /> ${t("pf_my_profile", "My Profile")}
      </label>
      <label class="profile-toggle-pill">
        <input type="radio" name="${containerId}Mode" value="other" /> ${t("pf_someone_else", "Someone Else")}
      </label>
    </div>
    <div id="profileSelectorBody" class="mt-12"></div>
  `;

  qsa(`input[name="${containerId}Mode"]`, container).forEach((radio) => {
    radio.addEventListener("change", (event) => {
      mode = event.target.value;
      renderBody();
    });
  });

  renderBody();

  return {
    getMode: () => mode,
    async maybeSaveFamilyProfile() {
      if (mode !== "other") return;
      const checkbox = qs(`#${containerId}SaveCheck`, container);
      if (!checkbox || !checkbox.checked) return;

      const name = qs(`#${containerId}OtherName`, container)?.value?.trim();
      if (!name) {
        showToast(t("toast_profile_need_name", "Add their name to save this profile."), "warning");
        return;
      }

      const payload = { name };
      fields.forEach((f) => {
        const el = fieldEl(f);
        if (!el) return;
        payload[f] = el.tagName === "SELECT" ? el.value : (el.value === "" ? null : Number(el.value));
      });

      const saved = await saveFamilyProfileRow(user, payload);
      if (saved) {
        familyProfiles.push(saved);
        showToast(t("toast_profile_saved_family", 'Saved "{name}" as a family profile.').replace("{name}", name), "success");
      }
    }
  };
}
