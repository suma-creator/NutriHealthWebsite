document.addEventListener("DOMContentLoaded", async () => {
  const user = await requireAuth();
  if (!user) return;

  renderShell("profile.html");
  await loadUserChip(user);
  hidePageLoader();

  const profileName = qs("#profileName");
  const profileEmail = qs("#profileEmail");
  const profileAge = qs("#profileAge");
  const profileGender = qs("#profileGender");
  const profileHeight = qs("#profileHeight");
  const profileWeight = qs("#profileWeight");
  const profileForm = qs("#profileForm");

  const { data: profile, error } = await supabaseClient
    .from("users")
    .select("name,email,age,gender,height,weight")
    .eq("id", user.id)
    .single();

  const cachedProfile = loadCachedProfile();
  const activeProfile = error || !profile ? cachedProfile : profile;

  profileName.value = activeProfile?.name || user.user_metadata?.name || "";
  profileEmail.value = activeProfile?.email || user.email;
  profileAge.value = activeProfile?.age || "";
  profileGender.value = activeProfile?.gender || "";
  profileHeight.value = activeProfile?.height || "";
  profileWeight.value = activeProfile?.weight || "";

  function cacheProfile(profileData) {
    try {
      localStorage.setItem("nh_profile", JSON.stringify(profileData));
    } catch (err) {
      console.warn("Unable to cache profile", err);
    }
  }

  function loadCachedProfile() {
    try {
      const stored = localStorage.getItem("nh_profile");
      if (stored) return JSON.parse(stored);
    } catch (err) {
      return null;
    }
    return null;
  }

  profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = profileName.value.trim();
    if (!name) {
      showToast(t("toast_profile_enter_name", "Please enter your name."), "warning");
      return;
    }

    const age = profileAge.value ? Number(profileAge.value) : null;
    const height = profileHeight.value ? Number(profileHeight.value) : null;
    const weight = profileWeight.value ? Number(profileWeight.value) : null;
    const gender = profileGender.value || null;

    const dataToSave = {
      id: user.id,
      name,
      email: profileEmail.value,
      age,
      gender,
      height,
      weight
    };

    const { error: updateError } = await supabaseClient
      .from("users")
      .upsert(dataToSave, { onConflict: ["id"] });

    if (updateError) {
      showToast(updateError.message || t("toast_profile_update_fail", "Unable to update profile."), "error");
      return;
    }

    cacheProfile(dataToSave);
    showToast(t("toast_profile_updated", "Profile updated successfully."), "success");
    await loadUserChip({ ...user, user_metadata: { ...user.user_metadata, name } });
  });
});
