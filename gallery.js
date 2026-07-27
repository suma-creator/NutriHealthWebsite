/* =========================================================================
   gallery.js — Food Gallery
   Folder-style photo album: Breakfast / Lunch / Dinner / Snack. Clicking a
   folder shows its photos; clicking a photo opens a lightbox that can step
   forward/backward through that same folder's photos.
   Photos are resized/compressed client-side into a JPEG data URL (no
   Supabase Storage bucket required).
   ========================================================================= */

let galleryUser = null;
let galleryPhotos = [];
let currentFolder = null;       // meal_type key while inside a folder, else null
let currentFolderPhotos = [];   // photos for currentFolder, in display order
let lightboxIndex = -1;         // index into currentFolderPhotos
let selectedGalleryPhotoDataUrl = null;

const MEAL_FOLDERS = [
  { key: "breakfast", label: "Breakfast", emoji: "🌅" },
  { key: "lunch", label: "Lunch", emoji: "☀️" },
  { key: "dinner", label: "Dinner", emoji: "🌙" },
  { key: "snack", label: "Snack", emoji: "🍿" }
];

const MAX_PHOTO_DIMENSION = 900;
const PHOTO_QUALITY = 0.72;

document.addEventListener("DOMContentLoaded", async () => {
  galleryUser = await requireAuth();
  if (!galleryUser) return;

  renderShell("gallery.html");
  await loadUserChip(galleryUser);

  await loadPhotos();
  hidePageLoader();

  qs("#galleryPhotoInput").addEventListener("change", handlePhotoSelect);
  qs("#galleryForm").addEventListener("submit", handleSavePhoto);
  document.addEventListener("keydown", handleKeydown);
});

function handleKeydown(e) {
  const lightboxOpen = qs("#galleryLightboxOverlay").classList.contains("open");
  if (!lightboxOpen) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") navigateLightbox(-1);
  if (e.key === "ArrowRight") navigateLightbox(1);
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

      selectedGalleryPhotoDataUrl = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);

      const preview = qs("#galleryPhotoPreview");
      preview.src = selectedGalleryPhotoDataUrl;
      preview.style.display = "block";
      qs("#galleryPhotoLabel").textContent = "📷 Tap to change photo";
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* ---- Save a new photo ---- */
async function handleSavePhoto(event) {
  event.preventDefault();

  if (!selectedGalleryPhotoDataUrl) {
    showToast(t("toast_gallery_choose_photo", "Please choose a photo first."), "error");
    return;
  }

  const btn = qs("#gallerySaveBtn");
  const mealType = qs("#galleryMealType").value;
  const payload = {
    user_id: galleryUser.id,
    meal_type: mealType,
    caption: qs("#galleryCaption").value.trim() || null,
    photo_url: selectedGalleryPhotoDataUrl
  };

  setBtnLoading(btn, true, "Uploading...");
  const { error } = await supabaseClient.from("food_gallery_photos").insert(payload);
  setBtnLoading(btn, false, t("gallery_add_btn", "Add to Gallery"));

  if (error) { showToast(error.message, "error"); return; }

  showToast(t("toast_gallery_added", "Photo added 🖼️"), "success");
  resetForm();
  await loadPhotos();

  // Jump straight into the folder the photo was added to.
  openFolder(mealType);
}

function resetForm() {
  qs("#galleryForm").reset();
  selectedGalleryPhotoDataUrl = null;
  const preview = qs("#galleryPhotoPreview");
  preview.src = "";
  preview.style.display = "none";
  qs("#galleryPhotoLabel").textContent = "📷 Tap to choose a photo";
}

/* ---- Load ---- */
async function loadPhotos() {
  const { data, error } = await supabaseClient
    .from("food_gallery_photos")
    .select("*")
    .eq("user_id", galleryUser.id)
    .order("created_at", { ascending: false });

  galleryPhotos = (!error && data) ? data : [];
  renderFolderGrid();

  // If we're currently inside a folder, refresh its contents too.
  if (currentFolder) {
    currentFolderPhotos = galleryPhotos.filter((p) => p.meal_type === currentFolder);
    renderPhotoGrid();
  }
}

/* ---- Folder view ---- */
function renderFolderGrid() {
  const grid = qs("#galleryFolderGrid");
  grid.innerHTML = MEAL_FOLDERS.map((folder) => {
    const photosInFolder = galleryPhotos.filter((p) => p.meal_type === folder.key);
    const cover = photosInFolder[0];
    return `
      <div class="folder-card ${cover ? "has-cover" : ""}" onclick="openFolder('${folder.key}')">
        ${cover ? `<div class="folder-card-cover" style="background-image:url('${cover.photo_url}');"></div>` : ""}
        <div class="folder-card-emoji">${folder.emoji}</div>
        <div class="folder-card-label">${folder.label}</div>
        <div class="folder-card-count">${photosInFolder.length} photo${photosInFolder.length === 1 ? "" : "s"}</div>
      </div>
    `;
  }).join("");
}

function openFolder(key) {
  currentFolder = key;
  currentFolderPhotos = galleryPhotos.filter((p) => p.meal_type === key);

  const folder = MEAL_FOLDERS.find((f) => f.key === key);
  qs("#galleryFolderTitle").textContent = folder ? `${folder.emoji} ${folder.label}` : "";

  qs("#galleryFolderView").style.display = "none";
  qs("#galleryPhotoView").style.display = "block";
  renderPhotoGrid();
  qs("#galleryPhotoView").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showFolderView() {
  currentFolder = null;
  qs("#galleryPhotoView").style.display = "none";
  qs("#galleryFolderView").style.display = "block";
  renderFolderGrid();
}

function renderPhotoGrid() {
  const grid = qs("#galleryGrid");

  if (!currentFolderPhotos.length) {
    grid.innerHTML = `<p class="text-sm text-muted">No photos in this folder yet — add one above.</p>`;
    return;
  }

  grid.innerHTML = currentFolderPhotos.map((photo, i) => `
    <div class="gallery-tile" onclick="openLightbox(${i})">
      <img src="${photo.photo_url}" alt="${photo.caption || "Food photo"}" />
      <button class="gallery-tile-delete" onclick="event.stopPropagation(); deletePhoto('${photo.id}')" aria-label="Delete photo">🗑️</button>
      ${photo.caption ? `<div class="gallery-tile-caption">${photo.caption}</div>` : ""}
    </div>
  `).join("");
}

/* ---- Lightbox with prev/next navigation within the open folder ---- */
function openLightbox(index) {
  lightboxIndex = index;
  renderLightbox();
  qs("#galleryLightboxOverlay").classList.add("open");
}

function renderLightbox() {
  const photo = currentFolderPhotos[lightboxIndex];
  if (!photo) return;

  const folder = MEAL_FOLDERS.find((f) => f.key === photo.meal_type);

  qs("#galleryLightboxImg").src = photo.photo_url;
  qs("#galleryLightboxContent").innerHTML = `
    <div class="text-sm" style="font-weight:700;">${folder ? `${folder.emoji} ${folder.label}` : ""}</div>
    <div class="text-sm text-muted mt-6">${formatDate(photo.created_at.slice(0, 10))}</div>
    ${photo.caption ? `<p class="text-sm mt-12">${photo.caption}</p>` : ""}
    <div class="gallery-lightbox-position">${lightboxIndex + 1} of ${currentFolderPhotos.length}</div>
  `;

  const multiPhoto = currentFolderPhotos.length > 1;
  qs(".gallery-lightbox-nav.prev").style.display = multiPhoto ? "flex" : "none";
  qs(".gallery-lightbox-nav.next").style.display = multiPhoto ? "flex" : "none";
}

function navigateLightbox(direction) {
  if (!currentFolderPhotos.length) return;
  lightboxIndex = (lightboxIndex + direction + currentFolderPhotos.length) % currentFolderPhotos.length;
  renderLightbox();
}

function closeLightbox() {
  qs("#galleryLightboxOverlay").classList.remove("open");
}

function closeLightboxOnOverlay(event) {
  if (event.target.id === "galleryLightboxOverlay") closeLightbox();
}

async function deletePhoto(id) {
  const { error } = await supabaseClient.from("food_gallery_photos").delete().eq("id", id);
  if (error) { showToast(error.message, "error"); return; }
  showToast(t("toast_gallery_removed", "Photo removed"), "info");
  closeLightbox();
  await loadPhotos();
}
