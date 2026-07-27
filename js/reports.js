/* =========================================================================
   reports.js
   -------------------------------------------------------------------------
   Phase 6 (part 1) — Export & Reports.

   Reads from the same CAL_MONTH_MAP / CAL_YEAR / CAL_MONTH / CAL_USER
   globals that js/health-calendar.js maintains (this script is loaded
   right after it on health-calendar.html, and classic <script> tags in
   the same document share one top-level scope, so those bindings are
   already visible here — same pattern the rest of the app uses for
   supabaseClient, t(), formatDate(), etc.).

   Three raw exports (CSV / Excel / PDF) dump the currently-viewed month's
   daily data one row per day. "Generate Monthly Health Report" builds a
   fuller, formatted PDF: cover summary + full daily breakdown table.
   ========================================================================= */

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("calExportCsvBtn")?.addEventListener("click", () => safeExport(exportMonthCsv));
  document.getElementById("calExportExcelBtn")?.addEventListener("click", () => safeExport(exportMonthExcel));
  document.getElementById("calExportPdfBtn")?.addEventListener("click", () => safeExport(exportMonthPdfSummary));
  document.getElementById("calMonthlyReportBtn")?.addEventListener("click", () => safeExport(generateMonthlyReport));
});

function safeExport(fn) {
  const statusEl = document.getElementById("calExportStatus");
  try {
    if (!CAL_USER || !CAL_MONTH_MAP || !Object.keys(CAL_MONTH_MAP).length) {
      if (statusEl) statusEl.textContent = t("cal_export_no_data", "Nothing to export yet — this month has no logged data.");
      return;
    }
    fn();
    if (statusEl) statusEl.textContent = "";
  } catch (err) {
    console.error("Export failed:", err);
    if (statusEl) statusEl.textContent = t("cal_export_error", "Export failed — please try again.");
    if (typeof showToast === "function") showToast(t("cal_export_error", "Export failed — please try again."), "error");
  }
}

/* ---------------------------------------------------------------------
   Shared: build one row per day of the currently-viewed month.
   --------------------------------------------------------------------- */
function reportsMonthLabel() {
  return `${t(CAL_MONTH_KEYS[CAL_MONTH], CAL_MONTH_FALLBACK[CAL_MONTH])} ${CAL_YEAR}`;
}

function reportsUserName() {
  return document.querySelector(".js-user-name")?.textContent?.trim() || "User";
}

function buildMonthlyRows() {
  const { daysInMonth } = monthRange(CAL_YEAR, CAL_MONTH);
  const rows = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${CAL_YEAR}-${String(CAL_MONTH + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const info = CAL_MONTH_MAP[dateStr];
    if (!info) continue; // skip untouched days — keeps exports focused on actual activity

    const mealTotals = (info.meals || []).reduce((s, m) => ({
      calories: s.calories + (m.calories || 0),
      protein: s.protein + (m.protein || 0),
      carbs: s.carbs + (m.carbs || 0),
      fat: s.fat + (m.fat || 0),
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    rows.push({
      Date: dateStr,
      "Health Score": info.score ?? "",
      "Water (ml)": info.water?.consumed_water ?? "",
      "Water Goal (ml)": info.water?.recommended_water ?? "",
      "Sleep (h)": info.sleep?.sleep_hours ?? "",
      "Exercised": info.exercise ? "Yes" : "No",
      "Calories": info.meals?.length ? Math.round(mealTotals.calories) : "",
      "Protein (g)": info.meals?.length ? Math.round(mealTotals.protein) : "",
      "Carbs (g)": info.meals?.length ? Math.round(mealTotals.carbs) : "",
      "Fat (g)": info.meals?.length ? Math.round(mealTotals.fat) : "",
      "BMI": info.bmi?.bmi ? Number(info.bmi.bmi).toFixed(1) : "",
      "Mood": info.mood?.mood ?? "",
      "Daily Rating": info.mood?.daily_rating ?? "",
      "Note": info.mood?.note ?? "",
    });
  }

  return rows;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------------
   CSV export
   --------------------------------------------------------------------- */
function exportMonthCsv() {
  const rows = buildMonthlyRows();
  if (!rows.length) throw new Error("No days with data this month");

  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    const s = String(val ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");

  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8;" }), `nutrihealth-${CAL_YEAR}-${String(CAL_MONTH + 1).padStart(2, "0")}.csv`);
}

/* ---------------------------------------------------------------------
   Excel export (SheetJS)
   --------------------------------------------------------------------- */
function exportMonthExcel() {
  if (typeof XLSX === "undefined") throw new Error("XLSX library not loaded");
  const rows = buildMonthlyRows();
  if (!rows.length) throw new Error("No days with data this month");

  const stats = computeMonthStats(CAL_MONTH_MAP);
  const summaryRows = [
    { Metric: "Month", Value: reportsMonthLabel() },
    { Metric: "Avg. Health Score", Value: stats.avgScore ?? "—" },
    { Metric: "Avg. Water (%)", Value: stats.avgWaterPct ?? "—" },
    { Metric: "Avg. Sleep (h)", Value: stats.avgSleepHrs ?? "—" },
    { Metric: "Exercise Days", Value: `${stats.exerciseDays}/${stats.trackedDays}` },
    { Metric: "Avg. Calories", Value: stats.avgCalories ?? "—" },
    { Metric: "Current Streak", Value: CAL_CURRENT_STREAK ?? 0 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Daily Log");
  XLSX.writeFile(wb, `nutrihealth-${CAL_YEAR}-${String(CAL_MONTH + 1).padStart(2, "0")}.xlsx`);
}

/* ---------------------------------------------------------------------
   PDF export — quick one-page summary
   --------------------------------------------------------------------- */
function getJsPDF() {
  const ctor = window.jspdf?.jsPDF;
  if (!ctor) throw new Error("jsPDF library not loaded");
  return ctor;
}

function exportMonthPdfSummary() {
  const JsPDF = getJsPDF();
  const stats = computeMonthStats(CAL_MONTH_MAP);
  const doc = new JsPDF();

  doc.setFontSize(18);
  doc.text("NutriHealth — Monthly Summary", 14, 20);
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text(`${reportsUserName()} · ${reportsMonthLabel()}`, 14, 28);
  doc.text(`Generated ${new Date().toLocaleDateString()}`, 14, 34);

  doc.autoTable({
    startY: 42,
    head: [["Metric", "Value"]],
    body: [
      ["Avg. Health Score", stats.avgScore ?? "—"],
      ["Avg. Water", stats.avgWaterPct !== null ? `${stats.avgWaterPct}%` : "—"],
      ["Avg. Sleep", stats.avgSleepHrs !== null ? `${stats.avgSleepHrs} h` : "—"],
      ["Exercise Days", `${stats.exerciseDays} / ${stats.trackedDays}`],
      ["Avg. Calories", stats.avgCalories ?? "—"],
      ["Days Tracked", stats.trackedDays],
      ["Current Streak", `${CAL_CURRENT_STREAK ?? 0} day(s)`],
    ],
    theme: "striped",
    headStyles: { fillColor: [55, 200, 170] },
  });

  doc.save(`nutrihealth-summary-${CAL_YEAR}-${String(CAL_MONTH + 1).padStart(2, "0")}.pdf`);
}

/* ---------------------------------------------------------------------
   Generate Monthly Health Report — full formatted PDF
   --------------------------------------------------------------------- */
function generateMonthlyReport() {
  const JsPDF = getJsPDF();
  const rows = buildMonthlyRows();
  const stats = computeMonthStats(CAL_MONTH_MAP);
  const doc = new JsPDF();

  // Cover / header
  doc.setFontSize(20);
  doc.setTextColor(20, 90, 75);
  doc.text("Monthly Health Report", 14, 22);
  doc.setFontSize(12);
  doc.setTextColor(60);
  doc.text(`NutriHealth · ${reportsMonthLabel()}`, 14, 30);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Prepared for ${reportsUserName()} (${CAL_USER.email || ""})`, 14, 36);
  doc.text(`Generated on ${new Date().toLocaleDateString()}`, 14, 41);

  // Summary block
  doc.autoTable({
    startY: 48,
    head: [["Monthly Statistic", "Value"]],
    body: [
      ["Average Health Score", stats.avgScore !== null ? `${stats.avgScore} / 100` : "No data"],
      ["Average Water Intake", stats.avgWaterPct !== null ? `${stats.avgWaterPct}% of goal` : "No data"],
      ["Average Sleep", stats.avgSleepHrs !== null ? `${stats.avgSleepHrs} hours/night` : "No data"],
      ["Exercise Days", `${stats.exerciseDays} of ${stats.trackedDays} tracked days`],
      ["Average Calories Logged", stats.avgCalories !== null ? `${stats.avgCalories} kcal/day` : "No data"],
      ["Days Tracked", `${stats.trackedDays}`],
      ["Current Streak", `${CAL_CURRENT_STREAK ?? 0} day(s)`],
    ],
    theme: "grid",
    headStyles: { fillColor: [55, 200, 170] },
    styles: { fontSize: 10 },
  });

  // Daily breakdown table
  const afterSummaryY = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(13);
  doc.setTextColor(20, 90, 75);
  doc.text("Daily Breakdown", 14, afterSummaryY);

  doc.autoTable({
    startY: afterSummaryY + 4,
    head: [["Date", "Score", "Water", "Sleep", "Exercise", "Calories", "Mood"]],
    body: rows.map((r) => [
      r.Date,
      r["Health Score"] || "—",
      r["Water Goal (ml)"] ? `${r["Water (ml)"]}/${r["Water Goal (ml)"]} ml` : (r["Water (ml)"] || "—"),
      r["Sleep (h)"] ? `${r["Sleep (h)"]} h` : "—",
      r["Exercised"],
      r["Calories"] || "—",
      r["Mood"] || "—",
    ]),
    theme: "striped",
    headStyles: { fillColor: [55, 200, 170] },
    styles: { fontSize: 8 },
    didDrawPage: (data) => {
      // Repeat a light title on subsequent pages when the table spans several pages.
      if (data.pageNumber > 1) {
        doc.setFontSize(9);
        doc.setTextColor(150);
        doc.text(`NutriHealth — ${reportsMonthLabel()} (cont.)`, 14, 10);
      }
    },
  });

  const finalY = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(9);
  doc.setTextColor(140);
  doc.text(
    "This report is generated from data you logged in NutriHealth and is not a substitute for professional medical advice.",
    14,
    finalY > 280 ? 15 : finalY,
    { maxWidth: 180 }
  );

  doc.save(`nutrihealth-monthly-report-${CAL_YEAR}-${String(CAL_MONTH + 1).padStart(2, "0")}.pdf`);
}
