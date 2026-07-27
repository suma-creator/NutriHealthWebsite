/* =========================================================================
   appointment.js — Doctor Appointment System
   Step 1: pick a specialty and browse a list of real-feeling doctors
   (Bangladeshi name + qualification + hospital), each randomly generated.
   Step 2: the user picks ONE doctor from that list, then confirms the
   date/time/reason to book.
   ========================================================================= */

let apptUser = null;
let currentDoctorList = [];
let selectedDoctor = null;
let activeLocationFilter = "all";

/* ---------------- Bangladesh doctor + hospital data ---------------- */

const DOCTOR_FIRST_NAMES = [
  "Abdul", "Mohammad", "Rezaul", "Kamal", "Nazrul", "Shahidul", "Habibur",
  "Mahbub", "Anwar", "Fazlul", "Ariful", "Golam", "Shafiqul", "Rashedul",
  "Iqbal", "Mizanur", "Aminul", "Zahirul", "Tanvir", "Sajjad",
  "Fahmida", "Nasrin", "Sultana", "Farzana", "Shirin", "Rehana", "Tania",
  "Nasreen", "Rubina", "Salma", "Ayesha", "Jasmin", "Nusrat", "Sabina",
  "Kamrun", "Shamima", "Rowshan", "Dilruba", "Afsana", "Mahmuda"
];

const DOCTOR_LAST_NAMES = [
  "Islam", "Rahman", "Hossain", "Ahmed", "Karim", "Chowdhury", "Khan",
  "Uddin", "Akter", "Begum", "Haque", "Alam", "Miah", "Siddique", "Bhuiyan",
  "Sarker", "Talukder", "Molla", "Kabir"
];

// Each specialty carries a plausible post-graduate qualification so the
// generated doctors "match" what the patient is booking for.
const SPECIALTIES = [
  { name: "General Physician", degree: "MBBS, FCPS (Medicine)" },
  { name: "Cardiologist", degree: "MBBS, MD (Cardiology)" },
  { name: "Dermatologist", degree: "MBBS, DDV" },
  { name: "Gynecologist & Obstetrician", degree: "MBBS, FCPS (Gynae & Obs)" },
  { name: "Orthopedic Surgeon", degree: "MBBS, MS (Orthopedics)" },
  { name: "Neurologist", degree: "MBBS, FCPS (Neurology)" },
  { name: "ENT Specialist", degree: "MBBS, DLO" },
  { name: "Pediatrician", degree: "MBBS, DCH, FCPS (Paediatrics)" },
  { name: "Dentist", degree: "BDS, FCPS (Dental)" },
  { name: "Psychiatrist", degree: "MBBS, MD (Psychiatry)" },
  { name: "Endocrinologist (Diabetes)", degree: "MBBS, FCPS (Endocrinology)" },
  { name: "Gastroenterologist", degree: "MBBS, MD (Gastroenterology)" },
  { name: "Nephrologist", degree: "MBBS, FCPS (Nephrology)" },
  { name: "Urologist", degree: "MBBS, MS (Urology)" },
  { name: "Ophthalmologist", degree: "MBBS, DO (Ophthalmology)" }
];

// Real hospitals across Bangladesh. Each is tagged with the specialties
// it's realistically strong in, so the random pick can prefer a good match
// before falling back to any hospital in the country.
const HOSPITALS = [
  { name: "Square Hospitals Ltd.", location: "Dhaka", tags: ["General Physician", "Cardiologist", "Orthopedic Surgeon", "Gastroenterologist"] },
  { name: "Evercare Hospital Dhaka", location: "Dhaka", tags: ["Cardiologist", "Neurologist", "Urologist", "Nephrologist"] },
  { name: "United Hospital", location: "Dhaka", tags: ["General Physician", "Cardiologist", "Endocrinologist (Diabetes)"] },
  { name: "Labaid Specialized Hospital", location: "Dhaka", tags: ["Cardiologist", "Orthopedic Surgeon", "Gastroenterologist"] },
  { name: "Bangabandhu Sheikh Mujib Medical University (BSMMU)", location: "Dhaka", tags: ["Neurologist", "Nephrologist", "Psychiatrist", "General Physician"] },
  { name: "Dhaka Medical College Hospital", location: "Dhaka", tags: ["General Physician", "Orthopedic Surgeon", "ENT Specialist"] },
  { name: "Ibrahim Cardiac Hospital & Research Institute", location: "Dhaka", tags: ["Cardiologist"] },
  { name: "BIRDEM General Hospital", location: "Dhaka", tags: ["Endocrinologist (Diabetes)", "General Physician", "Nephrologist"] },
  { name: "Bangladesh Eye Hospital", location: "Dhaka", tags: ["Ophthalmologist"] },
  { name: "Dhaka Dental College Hospital", location: "Dhaka", tags: ["Dentist"] },
  { name: "National Institute of Neurosciences & Hospital", location: "Dhaka", tags: ["Neurologist"] },
  { name: "Kurmitola General Hospital", location: "Dhaka", tags: ["General Physician", "Pediatrician"] },
  { name: "Popular Diagnostic Centre & Hospital", location: "Dhaka", tags: ["General Physician", "Gynecologist & Obstetrician", "Dermatologist"] },
  { name: "Chittagong Medical College Hospital", location: "Chattogram", tags: ["General Physician", "Orthopedic Surgeon", "Pediatrician"] },
  { name: "Chittagong Maa-O-Shishu Hospital", location: "Chattogram", tags: ["Gynecologist & Obstetrician", "Pediatrician"] },
  { name: "Apollo Imperial Hospitals", location: "Chattogram", tags: ["Cardiologist", "General Physician"] },
  { name: "Rajshahi Medical College Hospital", location: "Rajshahi", tags: ["General Physician", "Neurologist"] },
  { name: "Khulna Medical College Hospital", location: "Khulna", tags: ["General Physician", "Gynecologist & Obstetrician"] },
  { name: "Sylhet MAG Osmani Medical College Hospital", location: "Sylhet", tags: ["General Physician", "ENT Specialist"] },
  { name: "Rangpur Medical College Hospital", location: "Rangpur", tags: ["General Physician", "Orthopedic Surgeon"] },
  { name: "Sher-E-Bangla Medical College Hospital", location: "Barishal", tags: ["General Physician", "Pediatrician"] },
  { name: "Mymensingh Medical College Hospital", location: "Mymensingh", tags: ["General Physician", "Dermatologist"] },
  { name: "Comilla Medical College Hospital", location: "Cumilla", tags: ["General Physician", "Psychiatrist"] }
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Every distinct city/division that appears in the hospital data — powers
// the location search/filter UI.
const LOCATIONS = [...new Set(HOSPITALS.map((h) => h.location))].sort();

let doctorKeyCounter = 0;

function randomDoctorName(usedNames) {
  let name;
  let tries = 0;
  do {
    name = `Dr. ${pick(DOCTOR_FIRST_NAMES)} ${pick(DOCTOR_LAST_NAMES)}`;
    tries++;
  } while (usedNames.has(name) && tries < 20);
  usedNames.add(name);
  return name;
}

function hospitalsFor(specialtyName) {
  const matching = HOSPITALS.filter((h) => h.tags.includes(specialtyName));
  return matching.length ? matching : HOSPITALS;
}

// Narrows a specialty's hospital pool down to a chosen city/division.
// Falls back gracefully (and reports what happened) so the search never
// dead-ends with zero results:
//   1. hospitals that treat this specialty AND are in this location
//   2. any hospital in this location (specialty match relaxed)
//   3. hospitals that treat this specialty countrywide (location relaxed)
function hospitalsForLocation(specialtyName, location) {
  const specialtyPool = hospitalsFor(specialtyName);
  if (!location || location === "any") {
    return { pool: specialtyPool, fallback: null };
  }

  const exact = specialtyPool.filter((h) => h.location === location);
  if (exact.length) return { pool: exact, fallback: null };

  const sameLocation = HOSPITALS.filter((h) => h.location === location);
  if (sameLocation.length) return { pool: sameLocation, fallback: "location-only" };

  return { pool: specialtyPool, fallback: "countrywide" };
}

// Builds a list of unique, randomly generated doctors for a specialty +
// location so the user has real choices instead of one auto-assigned pick.
function generateDoctorList(specialtyName, location, count = 6) {
  const specialtyMeta = SPECIALTIES.find((s) => s.name === specialtyName) || SPECIALTIES[0];
  const { pool, fallback } = hospitalsForLocation(specialtyName, location);
  const candidateHospitals = [...pool];
  const usedNames = new Set();
  const list = [];

  for (let i = 0; i < count; i++) {
    // Cycle through hospitals without repeats until we run out, then allow repeats.
    const hospital = candidateHospitals.length
      ? candidateHospitals.splice(Math.floor(Math.random() * candidateHospitals.length), 1)[0]
      : pick(pool);

    list.push({
      _key: `d${++doctorKeyCounter}`,
      doctor_name: randomDoctorName(usedNames),
      doctor_degree: specialtyMeta.degree,
      specialty: specialtyMeta.name,
      hospital_name: hospital.name,
      hospital_location: hospital.location,
      years_experience: 4 + Math.floor(Math.random() * 22),
      rating: (3.8 + Math.random() * 1.2).toFixed(1),
      consultation_fee: 500 + Math.floor(Math.random() * 20) * 50
    });
  }
  return { doctors: list, fallback };
}

/* ---------------- Page wiring ---------------- */

document.addEventListener("DOMContentLoaded", async () => {
  apptUser = await requireAuth();
  if (!apptUser) return;

  renderShell("appointment.html");
  await loadUserChip(apptUser);

  populateSpecialtyOptions();
  populateLocationOptions();
  setMinDate();
  await loadAppointments();
  applyIncomingSpecialty();
  hidePageLoader();

  qs("#apptFindForm").addEventListener("submit", handleFindDoctors);
  qs("#apptBookForm").addEventListener("submit", handleBookAppointment);
  qs("#apptChangeDoctorBtn").addEventListener("click", backToDoctorList);
});

// Lets the symptom checker (or any other page) deep-link straight into a
// specialty search, e.g. appointment.html?specialty=Neurologist&location=Dhaka&autofind=1
function applyIncomingSpecialty() {
  const params = new URLSearchParams(window.location.search);
  const specialty = params.get("specialty");
  const location = params.get("location");

  if (specialty) {
    const select = qs("#apptSpecialty");
    const match = SPECIALTIES.find((s) => s.name === specialty);
    if (match) select.value = match.name;
  }
  if (location) {
    const locSelect = qs("#apptLocation");
    if (LOCATIONS.includes(location)) locSelect.value = location;
  }

  if (specialty && params.get("autofind") === "1") {
    runDoctorSearch();
    qs("#apptDoctorResults").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function populateSpecialtyOptions() {
  const select = qs("#apptSpecialty");
  select.innerHTML = SPECIALTIES.map((s) => `<option value="${s.name}">${s.name}</option>`).join("");
}

function populateLocationOptions() {
  const select = qs("#apptLocation");
  select.innerHTML = [`<option value="any">All locations in Bangladesh</option>`]
    .concat(LOCATIONS.map((loc) => `<option value="${loc}">${loc}</option>`))
    .join("");
}

function setMinDate() {
  qs("#apptDate").min = todayDateStr();
}

/* ---- Step 1: find doctors for a specialty + location ---- */
function handleFindDoctors(event) {
  event.preventDefault();
  runDoctorSearch();
}

function runDoctorSearch() {
  const specialty = qs("#apptSpecialty").value;
  const location = qs("#apptLocation").value;

  const { doctors, fallback } = generateDoctorList(specialty, location, 6);
  currentDoctorList = doctors;
  selectedDoctor = null;
  activeLocationFilter = "all";

  renderLocationFilterChips();
  renderFallbackNotice(fallback, specialty, location);
  renderDoctorList();

  qs("#apptDoctorResults").style.display = "block";
  qs("#apptBookingCard").style.display = "none";
  qs("#apptDoctorResults").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderFallbackNotice(fallback, specialty, location) {
  const notice = qs("#apptLocationNotice");
  if (fallback === "location-only") {
    notice.style.display = "block";
    notice.textContent = t("appt_no_specialty_location", `No ${specialty} listed in ${location} — showing other available doctors there instead.`).replace("{specialty}", specialty).replace("{location}", location);
  } else if (fallback === "countrywide") {
    notice.style.display = "block";
    notice.textContent = t("appt_no_hospitals_found", `No hospitals found in ${location} — showing ${specialty} doctors from across Bangladesh instead.`).replace("{location}", location).replace("{specialty}", specialty);
  } else {
    notice.style.display = "none";
    notice.textContent = "";
  }
}

// Quick client-side location filter chips over the current result set —
// lets the user narrow doctors by city without re-running the search,
// most useful when "All locations" was searched.
function renderLocationFilterChips() {
  const row = qs("#apptLocationFilterRow");
  const locationsInResults = [...new Set(currentDoctorList.map((d) => d.hospital_location))].sort();

  if (locationsInResults.length <= 1) {
    row.innerHTML = "";
    return;
  }

  const chips = ["all", ...locationsInResults];
  row.innerHTML = chips.map((loc) => `
    <button type="button" class="chip chip-sm ${activeLocationFilter === loc ? "chip-active" : ""}" onclick="filterDoctorsByLocation('${loc.replace(/'/g, "\\'")}')">
      📍 ${loc === "all" ? "All locations" : loc}
    </button>
  `).join("");
}

function filterDoctorsByLocation(location) {
  activeLocationFilter = location;
  renderLocationFilterChips();
  renderDoctorList();
}

function renderDoctorList() {
  const container = qs("#apptDoctorList");
  const noResults = qs("#apptNoResults");
  container.className = "doctor-grid";

  const visible = activeLocationFilter === "all"
    ? currentDoctorList
    : currentDoctorList.filter((d) => d.hospital_location === activeLocationFilter);

  if (!visible.length) {
    container.innerHTML = "";
    noResults.style.display = "block";
    return;
  }
  noResults.style.display = "none";

  container.innerHTML = visible.map((doc) => `
    <div class="card doctor-card">
      <div class="doctor-card-avatar">🧑‍⚕️</div>
      <div class="doctor-card-body">
        <div class="doctor-card-name">${doc.doctor_name}</div>
        <div class="text-sm text-muted mt-6">${doc.doctor_degree}</div>
        <div class="text-sm mt-6">🏥 ${doc.hospital_name}, 📍 ${doc.hospital_location}</div>
        <div class="text-sm text-muted mt-6">${doc.years_experience} yrs experience · ⭐ ${doc.rating} · Fee ৳${doc.consultation_fee}</div>
      </div>
      <button class="btn btn-primary btn-sm doctor-card-select" onclick="chooseDoctor('${doc._key}')">Select</button>
    </div>
  `).join("");
}

function chooseDoctor(key) {
  selectedDoctor = currentDoctorList.find((d) => d._key === key);
  if (!selectedDoctor) return;
  qs("#apptDoctorResults").style.display = "none";
  qs("#apptBookingCard").style.display = "block";

  qs("#apptSelectedDoctor").innerHTML = `
    <div style="font-weight:700;">${selectedDoctor.doctor_name}</div>
    <div class="text-sm text-muted mt-6">${selectedDoctor.doctor_degree} · ${selectedDoctor.specialty}</div>
    <div class="text-sm mt-6">🏥 ${selectedDoctor.hospital_name}, ${selectedDoctor.hospital_location}</div>
    <div class="text-sm text-muted mt-6">${selectedDoctor.years_experience} yrs experience · ⭐ ${selectedDoctor.rating} · Fee ৳${selectedDoctor.consultation_fee}</div>
  `;
  qs("#apptBookingCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function backToDoctorList() {
  qs("#apptBookingCard").style.display = "none";
  qs("#apptDoctorResults").style.display = "block";
}

/* ---- Step 2: confirm date/time/reason and book the chosen doctor ---- */
async function handleBookAppointment(event) {
  event.preventDefault();
  if (!selectedDoctor) { showToast(t("toast_appt_select_doctor", "Please select a doctor first."), "error"); return; }

  const btn = qs("#apptBtn");
  const date = qs("#apptDate").value;
  const time = qs("#apptTime").value;
  const reason = qs("#apptReason").value.trim();

  const payload = {
    user_id: apptUser.id,
    doctor_name: selectedDoctor.doctor_name,
    doctor_degree: selectedDoctor.doctor_degree,
    specialty: selectedDoctor.specialty,
    hospital_name: selectedDoctor.hospital_name,
    hospital_location: selectedDoctor.hospital_location,
    appointment_date: date,
    appointment_time: time,
    reason: reason || null,
    status: "upcoming"
  };

  setBtnLoading(btn, true, "Booking...");
  const { data, error } = await supabaseClient
    .from("doctor_appointments")
    .insert(payload)
    .select()
    .single();
  setBtnLoading(btn, false, t("appointment_confirm_booking_btn", "Confirm Booking"));

  if (error) { showToast(error.message, "error"); return; }

  renderConfirmation(data);
  qs("#apptBookForm").reset();
  setMinDate();
  qs("#apptBookingCard").style.display = "none";
  qs("#apptDoctorResults").style.display = "none";
  qs("#apptLocationFilterRow").innerHTML = "";
  qs("#apptLocationNotice").style.display = "none";
  currentDoctorList = [];
  selectedDoctor = null;
  activeLocationFilter = "all";
  showToast(t("toast_appt_booked", "Appointment booked!"), "success");
  await loadAppointments();
}

function renderConfirmation(appt) {
  const box = qs("#apptConfirmation");
  box.style.display = "block";
  box.innerHTML = `
    <div class="flex gap-16" style="align-items:flex-start;">
      <span class="stat-icon icon-mint">✅</span>
      <div>
        <h4>Appointment confirmed</h4>
        <p class="text-sm mt-8"><strong>${appt.doctor_name}</strong> — ${appt.doctor_degree}</p>
        <p class="text-sm text-muted">${appt.specialty}</p>
        <p class="text-sm mt-6">🏥 ${appt.hospital_name}, ${appt.hospital_location}</p>
        <p class="text-sm mt-6">📅 ${formatDate(appt.appointment_date)} at ${formatTime12h(appt.appointment_time)}</p>
      </div>
    </div>
  `;
}

function statusBadge(status) {
  const map = {
    upcoming: { color: "var(--color-primary)", tint: "var(--color-primary-light)", label: "Upcoming" },
    completed: { color: "var(--color-mint)", tint: "var(--tint-mint)", label: "Completed" },
    cancelled: { color: "var(--color-coral)", tint: "var(--tint-coral)", label: "Cancelled" }
  };
  const m = map[status] || map.upcoming;
  return `<span class="badge" style="background:${m.tint};color:${m.color};padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;display:inline-block;">${m.label}</span>`;
}

async function loadAppointments() {
  const { data, error } = await supabaseClient
    .from("doctor_appointments")
    .select("*")
    .eq("user_id", apptUser.id)
    .order("appointment_date", { ascending: true })
    .order("appointment_time", { ascending: true });

  const container = qs("#apptList");

  if (error || !data || !data.length) {
    container.innerHTML = `<p class="text-sm text-muted">${t("appt_none_booked_yet", "No appointments booked yet — find a doctor above to book your first one.")}</p>`;
    return;
  }

  container.innerHTML = data.map((a) => `
    <div class="flex-between" style="padding:14px;border-radius:12px;border:1px solid var(--color-border);flex-wrap:wrap;gap:10px;">
      <div>
        <div style="font-weight:600;">${a.doctor_name} <span class="text-sm text-muted">· ${a.specialty}</span></div>
        <div class="text-sm text-muted mt-6">${a.doctor_degree || ""}</div>
        <div class="text-sm mt-6">🏥 ${a.hospital_name}, ${a.hospital_location}</div>
        <div class="text-sm mt-6">📅 ${formatDate(a.appointment_date)} · 🕒 ${formatTime12h(a.appointment_time)}</div>
        ${a.reason ? `<div class="text-sm text-muted mt-6">Reason: ${a.reason}</div>` : ""}
      </div>
      <div class="flex-col gap-12" style="align-items:flex-end;">
        ${statusBadge(a.status)}
        <div class="flex gap-16">
          ${a.status === "upcoming" ? `
            <button class="btn btn-outline btn-sm" onclick="updateApptStatus('${a.id}', 'completed')">Mark done</button>
            <button class="btn btn-ghost btn-sm" onclick="updateApptStatus('${a.id}', 'cancelled')">Cancel</button>
          ` : ""}
          <button class="btn btn-ghost btn-sm" onclick="deleteAppointment('${a.id}')" aria-label="Delete appointment">🗑️</button>
        </div>
      </div>
    </div>
  `).join("");
}

async function updateApptStatus(id, status) {
  const { error } = await supabaseClient.from("doctor_appointments").update({ status }).eq("id", id);
  if (error) { showToast(error.message, "error"); return; }
  showToast(status === "completed" ? t("toast_appt_marked_completed", "Marked as completed") : t("toast_appt_cancelled", "Appointment cancelled"), "info");
  await loadAppointments();
}

async function deleteAppointment(id) {
  const { error } = await supabaseClient.from("doctor_appointments").delete().eq("id", id);
  if (error) { showToast(error.message, "error"); return; }
  showToast(t("toast_appt_removed", "Appointment removed"), "info");
  await loadAppointments();
}
