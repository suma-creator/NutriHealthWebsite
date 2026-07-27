/* =========================================================================
   journal.js — Food Journal
   Lets a user save a photo of a meal plus how it made them feel. Photos
   are resized/compressed client-side into a JPEG data URL (no Supabase
   Storage bucket required) and stored directly on the row.
   ========================================================================= */

let journalUser = null;
let selectedPhotoDataUrl = null;
let selectedMood = null;
let journalEntries = [];

const MOODS = [
  { key: "happy", emoji: "😊", label: "Happy" },
  { key: "satisfied", emoji: "😌", label: "Satisfied" },
  { key: "excited", emoji: "🤩", label: "Excited" },
  { key: "energized", emoji: "💪", label: "Energized" },
  { key: "neutral", emoji: "😐", label: "Neutral" },
  { key: "guilty", emoji: "😔", label: "Guilty" },
  { key: "sick", emoji: "🤢", label: "Sick" },
  { key: "tired", emoji: "😴", label: "Tired" }
];

const MAX_PHOTO_DIMENSION = 900;
const PHOTO_QUALITY = 0.72;

document.addEventListener("DOMContentLoaded", async () => {
  journalUser = await requireAuth();
  if (!journalUser) return;

  renderShell("journal.html");
  await loadUserChip(journalUser);

  renderMoodChips();
  qs("#journalDate").value = todayDateStr();
  await loadEntries();
  hidePageLoader();

  qs("#journalPhotoInput").addEventListener("change", handlePhotoSelect);
  qs("#journalForm").addEventListener("submit", handleSaveEntry);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeEntryModal(); });
});

function renderMoodChips() {
  const row = qs("#journalMoodRow");
  row.innerHTML = MOODS.map((m) => `
    <button type="button" class="mood-chip" data-mood="${m.key}" onclick="selectMood('${m.key}')">
      ${m.emoji} ${m.label}
    </button>
  `).join("");
}

function selectMood(key) {
  selectedMood = selectedMood === key ? null : key; // click again to deselect
  qsa(".mood-chip").forEach((chip) => {
    chip.classList.toggle("mood-chip-active", chip.dataset.mood === selectedMood);
  });
}

/* ---- Photo select + client-side resize/compress ---- */
function handlePhotoSelect(event) {
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

      const preview = qs("#journalPhotoPreview");
      preview.src = selectedPhotoDataUrl;
      preview.style.display = "block";
      qs("#journalPhotoLabel").textContent = "📷 Tap to change photo";
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* ---- Save a new memory ---- */
async function handleSaveEntry(event) {
  event.preventDefault();
  const btn = qs("#journalSaveBtn");

  const payload = {
    user_id: journalUser.id,
    entry_date: qs("#journalDate").value || todayDateStr(),
    meal_type: qs("#journalMealType").value || null,
    title: qs("#journalTitle").value.trim() || null,
    mood: selectedMood,
    notes: qs("#journalNotes").value.trim() || null,
    photo_url: selectedPhotoDataUrl
  };

  setBtnLoading(btn, true, "Saving...");
  const { error } = await supabaseClient.from("food_journal_entries").insert(payload);
  setBtnLoading(btn, false, t("journal_save_btn", "Save Memory"));

  if (error) { showToast(error.message, "error"); return; }

  showToast(t("toast_journal_saved", "Memory saved 📔"), "success");
  resetForm();
  await loadEntries();
}

function resetForm() {
  qs("#journalForm").reset();
  qs("#journalDate").value = todayDateStr();
  selectedPhotoDataUrl = null;
  selectedMood = null;
  const preview = qs("#journalPhotoPreview");
  preview.src = "";
  preview.style.display = "none";
  qs("#journalPhotoLabel").textContent = "📷 Tap to add a photo of your food (optional)";
  qsa(".mood-chip").forEach((chip) => chip.classList.remove("mood-chip-active"));
}

/* ---- Feed + stats ---- */
async function loadEntries() {
  const { data, error } = await supabaseClient
    .from("food_journal_entries")
    .select("*")
    .eq("user_id", journalUser.id)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false });

  const feed = qs("#journalFeed");

  if (error || !data || !data.length) {
    journalEntries = [];
    feed.innerHTML = `<p class="text-sm text-muted">No memories yet — add your first food photo and how it made you feel above.</p>`;
    qs("#journalStatsRow").style.display = "none";
    return;
  }

  journalEntries = data;
  feed.innerHTML = data.map((entry) => renderEntryCard(entry)).join("");
  updateStats(data);
}

function moodMeta(key) {
  return MOODS.find((m) => m.key === key) || null;
}

function renderEntryCard(entry) {
  const mood = moodMeta(entry.mood);
  const mealLabel = entry.meal_type ? entry.meal_type.charAt(0).toUpperCase() + entry.meal_type.slice(1) : null;

  return `
    <div class="card journal-card" onclick="openEntryModal('${entry.id}')">
      ${entry.photo_url ? `<img class="journal-entry-photo" src="${entry.photo_url}" alt="Food photo" />` : ""}
      <div class="flex-between" style="align-items:flex-start;">
        <div>
          <div style="font-weight:700;">${entry.title || (mealLabel ? `${mealLabel}` : "Food memory")}</div>
          <div class="text-sm text-muted mt-6">${formatDate(entry.entry_date)}${mealLabel ? ` · ${mealLabel}` : ""}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); deleteEntry('${entry.id}')" aria-label="Delete memory">🗑️</button>
      </div>
      ${mood ? `<div class="text-sm mt-8">${mood.emoji} ${mood.label}</div>` : ""}
      ${entry.notes ? `<p class="text-sm text-muted mt-8" style="white-space:pre-wrap;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;">${entry.notes}</p>` : ""}
    </div>
  `;
}

/* ---- Read view modal ---- */
function openEntryModal(id) {
  const entry = journalEntries.find((e) => e.id === id);
  if (!entry) return;

  const mood = moodMeta(entry.mood);
  const mealLabel = entry.meal_type ? entry.meal_type.charAt(0).toUpperCase() + entry.meal_type.slice(1) : null;

  qs("#journalModalContent").innerHTML = `
    ${entry.photo_url ? `<img class="journal-modal-photo" src="${entry.photo_url}" alt="Food photo" />` : ""}
    <div class="journal-modal-body">
      <h3>${entry.title || (mealLabel ? mealLabel : "Food memory")}</h3>
      <div class="text-sm text-muted mt-8">${formatDate(entry.entry_date)}${mealLabel ? ` · ${mealLabel}` : ""}</div>
      ${mood ? `<span class="journal-modal-mood">${mood.emoji} ${mood.label}</span>` : ""}
      ${entry.notes ? `<p class="journal-modal-notes">${entry.notes}</p>` : `<p class="text-sm text-muted mt-16">No notes written for this one.</p>`}
    </div>
  `;
  qs("#journalModalOverlay").classList.add("open");
}

function closeEntryModal() {
  qs("#journalModalOverlay").classList.remove("open");
}

function closeEntryOnOverlay(event) {
  if (event.target.id === "journalModalOverlay") closeEntryModal();
}

function updateStats(data) {
  qs("#journalStatsRow").style.display = "grid";
  qs("#journalStatTotal").textContent = data.length;

  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);
  const thisWeek = data.filter((e) => new Date(e.entry_date) >= weekAgo).length;
  qs("#journalStatWeek").textContent = thisWeek;

  const moodCounts = {};
  data.forEach((e) => { if (e.mood) moodCounts[e.mood] = (moodCounts[e.mood] || 0) + 1; });
  const topMoodKey = Object.keys(moodCounts).sort((a, b) => moodCounts[b] - moodCounts[a])[0];
  const topMood = moodMeta(topMoodKey);
  qs("#journalStatMood").textContent = topMood ? `${topMood.emoji} ${topMood.label}` : "—";
}

async function deleteEntry(id) {
  const { error } = await supabaseClient.from("food_journal_entries").delete().eq("id", id);
  if (error) { showToast(error.message, "error"); return; }
  showToast(t("toast_journal_removed", "Memory removed"), "info");
  await loadEntries();
}
