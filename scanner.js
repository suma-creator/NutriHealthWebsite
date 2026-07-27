document.addEventListener("DOMContentLoaded", async () => {
  const user = await requireAuth();
  if (!user) return;

  renderShell("scanner.html");
  await loadUserChip(user);
  hidePageLoader();

  const scannerForm = qs("#scannerForm");
  const scannerResult = qs("#scannerResult");
  const foodNameEl = qs("#foodName");
  const caloriesEl = qs("#calories");
  const proteinEl = qs("#protein");
  const carbsEl = qs("#carbs");
  const fatEl = qs("#fat");
  const foodNote = qs("#foodNote");

  const MAX_PHOTO_DIMENSION = 900;
  const PHOTO_QUALITY = 0.72;
  let selectedPhotoDataUrl = null;

  /* ================= Tab switching ================= */
  window.setScannerTab = function (tab) {
    const isSearch = tab === "search";
    qs("#scannerTabSearch").style.display = isSearch ? "block" : "none";
    qs("#scannerTabPhoto").style.display = isSearch ? "none" : "block";
    qs("#scannerTabSearchBtn").classList.toggle("scanner-tab-active", isSearch);
    qs("#scannerTabPhotoBtn").classList.toggle("scanner-tab-active", !isSearch);
  };

  /* ================= Photo select + client-side resize/compress ================= */
  qs("#scannerPhotoInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;

        if (width > height && width > MAX_PHOTO_DIMENSION) {
          height = Math.round(height * (MAX_PHOTO_DIMENSION / width));
          width = MAX_PHOTO_DIMENSION;
        } else if (height > MAX_PHOTO_DIMENSION) {
          width = Math.round(width * (MAX_PHOTO_DIMENSION / height));
          height = MAX_PHOTO_DIMENSION;
        }

        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);

        selectedPhotoDataUrl = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);

        const preview = qs("#scannerPhotoPreview");
        preview.src = selectedPhotoDataUrl;
        preview.style.display = "block";
        qs("#scannerPhotoLabel").textContent = "📷 Tap to choose a different photo";
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  // ================= Spoonacular API (via secure edge function) =================
  // The API key lives server-side only (Supabase secret), never in this file.

  async function lookupFood(query) {
    const { ok, data, message } = await callSpoonacular("ingredientLookup", { query, amount: 100, unit: "grams" });
    if (!ok) return { error: message };
    if (!data.found) return { notFound: true };

    let note = "Live nutrition data from Spoonacular.";
    if (data.result.combined) {
      const missing = data.result.missingParts?.length ? ` (couldn't match: ${data.result.missingParts.join(", ")})` : "";
      note = `Combined nutrition for: ${data.result.parts.join(" + ")}${missing}`;
    } else if (data.result.aiEstimated) {
      note = `⚠️ Spoonacular is unavailable right now — this is an AI estimate, not verified nutrition data.`;
    } else if (data.result.estimated) {
      note = `Not a raw ingredient in Spoonacular — using a similar recipe's nutrition as an estimate.`;
    }

    return {
      entry: {
        name: data.result.name,
        category: "Food",
        serving: data.result.unit === "serving" ? `${data.result.amount} serving` : "100 g",
        calories: Math.round(data.result.calories),
        protein: `${data.result.protein.toFixed(1)}g`,
        carbs: `${data.result.carbs.toFixed(1)}g`,
        fat: `${data.result.fat.toFixed(1)}g`,
        image: data.result.image
      },
      note
    };
  }

  // ================= AI photo identification (via "food-vision" edge function) =================
  async function identifyPhoto(imageDataUrl) {
    const { ok, result, message } = await callFoodVision(imageDataUrl);
    if (!ok) return { error: message };

    if (!result || result.food_name === "Unrecognized") {
      return { notFound: true, note: result?.note };
    }

    const confidenceTag = result.confidence === "low" ? " — low confidence, portion may be hard to judge" : "";
    let note = `🤖 AI-estimated from your photo${confidenceTag}.`;
    if (result.note) note += ` ${result.note}`;

    return {
      entry: {
        name: result.food_name,
        category: "Food (AI photo)",
        serving: result.serving_estimate,
        calories: Math.round(result.calories),
        protein: `${result.protein_g.toFixed(1)}g`,
        carbs: `${result.carbs_g.toFixed(1)}g`,
        fat: `${result.fat_g.toFixed(1)}g`,
        image: imageDataUrl
      },
      note
    };
  }

  async function saveScan(entry) {
    if (!supabaseClient) return;
    await supabaseClient.from("food_scans").insert({
      user_id: user.id,
      food_name: entry.name,
      calories: Number(entry.calories) || null,
      protein: Number(entry.protein) || null,
      carbs: Number(entry.carbs) || null,
      fat: Number(entry.fat) || null,
      image_url: entry.image || null
    });
  }

  function renderResult(entry, source) {
    foodNameEl.textContent = entry.name;
    caloriesEl.textContent = entry.calories;
    proteinEl.textContent = entry.protein;
    carbsEl.textContent = entry.carbs;
    fatEl.textContent = entry.fat;
    foodNote.textContent = source;

    const categoryEl = qs("#foodCategory");
    const servingEl = qs("#foodServing");
    if (categoryEl) categoryEl.textContent = entry.category || "Food";
    if (servingEl) servingEl.textContent = entry.serving ? `Per ${entry.serving}` : "";

    scannerResult.style.display = "block";
  }

  scannerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = qs("#foodInput").value.trim();
    if (!query) return;

    const btn = scannerForm.querySelector("button[type=submit]");
    if (btn) { btn.disabled = true; btn.dataset.originalText = btn.textContent; btn.textContent = t("scanner_looking_up", "Looking up..."); }

    const lookup = await lookupFood(query);

    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || "Scan"; }

    if (lookup.error) {
      showToast(lookup.error, "error", 5000);
      return;
    }
    if (lookup.notFound) {
      showToast(t("toast_no_match_found", 'No match found for "{name}". Try a simpler or different name.').replace("{name}", query), "error");
      return;
    }

    renderResult(lookup.entry, lookup.note);
    const grid = qs("#scannerGrid");
    if (grid) {
      grid.classList.remove("grid-single");
      grid.classList.add("grid-double");
    }
    await saveScan(lookup.entry);
  });

  qs("#scannerPhotoForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedPhotoDataUrl) {
      showToast(t("toast_scanner_choose_photo", "Please choose a photo first."), "error");
      return;
    }

    const btn = qs("#scanPhotoBtn");
    setBtnLoading(btn, true, "Identifying...");

    const lookup = await identifyPhoto(selectedPhotoDataUrl);

    setBtnLoading(btn, false, t("scanner_identify_btn", "Identify Food"));

    if (lookup.error) {
      showToast(lookup.error, "error", 5000);
      return;
    }
    if (lookup.notFound) {
      showToast(lookup.note || t("toast_scanner_no_recognize", "Couldn't recognize food in that photo. Try a clearer, closer shot."), "error", 5000);
      return;
    }

    renderResult(lookup.entry, lookup.note);
    const grid = qs("#scannerGrid");
    if (grid) {
      grid.classList.remove("grid-single");
      grid.classList.add("grid-double");
    }
    await saveScan(lookup.entry);
  });

  qsa(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      qs("#foodInput").value = btn.dataset.food;
      scannerForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    });
  });
});
