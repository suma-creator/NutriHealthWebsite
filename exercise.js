document.addEventListener("DOMContentLoaded", async () => {
  const user = await requireAuth();
  if (!user) return;

  renderShell("exercise.html");
  await loadUserChip(user);
  hidePageLoader();

  const exerciseBtn = qs("#exerciseBtn");
  const exerciseResult = qs("#exerciseResult");
  const exerciseTitle = qs("#exerciseTitle");
  const exerciseDescription = qs("#exerciseDescription");
  const exerciseList = qs("#exerciseList");
  const completeStatus = qs("#exerciseCompleteStatus");
  const doneDetails = qs("#exerciseDoneDetails");
  const skipDetails = qs("#exerciseSkipDetails");

  let selectedGoal = null;
  let todayLog = null; // { status, plan_type, duration_minutes, calories_burned }
  let pendingStatus = null; // 'completed' | 'partial' | 'skipped' — chosen but not yet saved

  /* ---------------------------------------------------------------------
     Smart recommendation — rule-based, using whatever profile/BMI/history
     data is actually available. No new profile fields required; this
     reads what bmi.html / profile.html already collect.
     --------------------------------------------------------------------- */
  async function loadRecommendation() {
    const [{ data: profile }, { data: bmiRows }, { data: recentLogs }] = await Promise.all([
      supabaseClient.from("users").select("age, gender, height, weight").eq("id", user.id).maybeSingle(),
      supabaseClient.from("bmi_logs").select("bmi, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1),
      supabaseClient.from("exercise_logs").select("status").eq("user_id", user.id).order("log_date", { ascending: false }).limit(14)
    ]);

    const latestBmi = bmiRows && bmiRows[0] ? bmiRows[0] : null;
    const age = profile?.age ?? null;
    const completedRecently = (recentLogs || []).filter((l) => l.status === "completed" || !l.status).length;

    // Recompute the category from the raw number ourselves — bmi_logs.category
    // was saved through t() at insert time, so it may be stored in whatever
    // language the user had active that day and isn't safe to string-match.
    let bmiCategory = null;
    if (latestBmi && typeof latestBmi.bmi === "number") {
      if (latestBmi.bmi < 18.5) bmiCategory = "Underweight";
      else if (latestBmi.bmi < 25) bmiCategory = "Normal";
      else if (latestBmi.bmi < 30) bmiCategory = "Overweight";
      else bmiCategory = "Obese";
    }

    const rec = recommendExercisePlan({ age, bmiCategory, completedRecently });
    if (!rec) return;

    const card = qs("#exerciseSmartCard");
    const reasonEl = qs("#exerciseRecommendReason");
    const useBtn = qs("#exerciseUseRecommendedBtn");
    if (!card || !reasonEl || !useBtn) return;

    reasonEl.textContent = rec.reason;
    card.style.display = "block";
    useBtn.onclick = () => {
      qs("#goalSelect").value = rec.goal;
      exerciseBtn.click();
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
  }

  function recommendExercisePlan({ age, bmiCategory, completedRecently }) {
    // Age takes priority for safety (senior / prenatal-style caution isn't
    // inferable from age alone, so this only covers what's knowable).
    if (typeof age === "number" && age >= 60) {
      return { goal: "senior", reason: t("exercise_rec_senior", "Based on your age, we suggest a low-impact Senior Fitness routine focused on balance and gentle strength.") };
    }

    if (bmiCategory === "Obese" || bmiCategory === "Overweight") {
      return { goal: "weightLoss", reason: t("exercise_rec_weightloss", "Based on your latest BMI, a Weight Loss routine combining cardio and bodyweight moves is a good fit.") };
    }
    if (bmiCategory === "Underweight") {
      return { goal: "muscleGain", reason: t("exercise_rec_musclegain", "Based on your latest BMI, a Muscle Gain routine can help you build healthy strength.") };
    }

    if (typeof age === "number" && age < 18) {
      return { goal: "home", reason: t("exercise_rec_teen", "A light, no-equipment Home Workout is a safe starting point for your age group.") };
    }

    // Normal BMI (or unknown) — use recent consistency as a fitness-level proxy.
    if (completedRecently >= 8) {
      return { goal: "hiit", reason: t("exercise_rec_hiit", "You've been consistent lately — a HIIT workout can help you push further.") };
    }
    if (completedRecently >= 3) {
      return { goal: "strength", reason: t("exercise_rec_strength", "You're building a good habit — Strength Training is a solid next step.") };
    }
    return { goal: "beginner", reason: t("exercise_rec_beginner", "New to a routine? A Beginner workout is the easiest way to start consistently.") };
  }

  /* ---------------------------------------------------------------------
     Streak + today's goal progress
     --------------------------------------------------------------------- */
  async function loadStreakAndProgress() {
    const [{ data: logs }, { data: goals }] = await Promise.all([
      supabaseClient.from("exercise_logs").select("log_date, status, duration_minutes, calories_burned")
        .eq("user_id", user.id).order("log_date", { ascending: false }).limit(60),
      supabaseClient.from("exercise_goals").select("*").eq("user_id", user.id).maybeSingle()
    ]);

    const rows = logs || [];
    const byDate = {};
    rows.forEach((r) => { byDate[r.log_date] = r; });

    // Consecutive days (ending today or yesterday) counted as completed/partial.
    let streak = 0;
    const cursor = new Date();
    if (!byDate[todayDateStr()] || byDate[todayDateStr()].status === "skipped") {
      cursor.setDate(cursor.getDate() - 1); // today not logged yet — start counting from yesterday
    }
    while (true) {
      const key = cursor.toISOString().split("T")[0];
      const entry = byDate[key];
      if (entry && entry.status !== "skipped") { streak++; cursor.setDate(cursor.getDate() - 1); }
      else break;
    }

    const streakEl = qs("#exerciseStreakValue");
    if (streakEl) streakEl.textContent = `🔥 ${streak} ${streak === 1 ? t("exercise_day", "day") : t("exercise_days", "days")}`;

    const today = byDate[todayDateStr()];
    const minutesEl = qs("#exerciseTodayMinutes");
    const caloriesEl = qs("#exerciseTodayCalories");
    if (minutesEl) {
      const goalStr = goals?.daily_minutes_goal ? ` / ${goals.daily_minutes_goal}` : "";
      minutesEl.textContent = `${today?.duration_minutes ?? 0}${goalStr} ${t("exercise_min_short", "min")}`;
    }
    if (caloriesEl) {
      const goalStr = goals?.calories_goal ? ` / ${goals.calories_goal}` : "";
      caloriesEl.textContent = `${today?.calories_burned ?? 0}${goalStr} ${t("exercise_kcal_short", "kcal")}`;
    }
  }

  /* ---------------------------------------------------------------------
     Today's log status (Completed / Partial / Skipped)
     --------------------------------------------------------------------- */
  async function refreshTodayStatus() {
    const { data } = await supabaseClient
      .from("exercise_logs")
      .select("id, plan_type, status, duration_minutes, calories_burned, skip_reason, notes")
      .eq("user_id", user.id)
      .eq("log_date", todayDateStr())
      .maybeSingle();

    todayLog = data || null;
    doneDetails.style.display = "none";
    skipDetails.style.display = "none";
    pendingStatus = null;

    if (!todayLog) {
      completeStatus.textContent = "";
      return;
    }

    const labels = {
      completed: t("exercise_status_completed", "✅ Completed today"),
      partial: t("exercise_status_partial", "🟡 Partially completed today"),
      skipped: t("exercise_status_skipped", "❌ Skipped today")
    };
    let summary = labels[todayLog.status] || labels.completed;
    if (todayLog.plan_type) summary += ` — ${todayLog.plan_type}`;
    if (todayLog.status !== "skipped" && todayLog.duration_minutes) summary += ` (${todayLog.duration_minutes} ${t("exercise_min_short", "min")})`;
    if (todayLog.status === "skipped" && todayLog.skip_reason) summary += ` — ${todayLog.skip_reason}`;
    completeStatus.textContent = summary;
  }

  async function saveExerciseLog(extra) {
    const payload = {
      user_id: user.id,
      log_date: todayDateStr(),
      plan_type: selectedGoal,
      status: pendingStatus,
      ...extra
    };

    const { error } = await supabaseClient
      .from("exercise_logs")
      .upsert(payload, { onConflict: "user_id,log_date" });

    if (error) { showToast(error.message, "error"); return false; }
    showToast(t("exercise_toast_logged", "Workout logged for today!"), "success");
    await refreshTodayStatus();
    await loadStreakAndProgress();
    return true;
  }

  qs("#exerciseCompletedBtn")?.addEventListener("click", () => {
    pendingStatus = "completed";
    doneDetails.style.display = "block";
    skipDetails.style.display = "none";
  });
  qs("#exercisePartialBtn")?.addEventListener("click", () => {
    pendingStatus = "partial";
    doneDetails.style.display = "block";
    skipDetails.style.display = "none";
  });
  qs("#exerciseSkippedBtn")?.addEventListener("click", () => {
    pendingStatus = "skipped";
    skipDetails.style.display = "block";
    doneDetails.style.display = "none";
  });

  qs("#exerciseSaveDoneBtn")?.addEventListener("click", async () => {
    const btn = qs("#exerciseSaveDoneBtn");
    setBtnLoading(btn, true, t("reminder_save", "Save"));
    await saveExerciseLog({
      duration_minutes: qs("#exerciseDurationInput").value ? Number(qs("#exerciseDurationInput").value) : null,
      calories_burned: qs("#exerciseCaloriesInput").value ? Number(qs("#exerciseCaloriesInput").value) : null,
      skip_reason: null
    });
    setBtnLoading(btn, false, t("reminder_save", "Save"));
  });

  qs("#exerciseSaveSkipBtn")?.addEventListener("click", async () => {
    const btn = qs("#exerciseSaveSkipBtn");
    setBtnLoading(btn, true, t("reminder_save", "Save"));
    await saveExerciseLog({
      duration_minutes: null,
      calories_burned: null,
      skip_reason: qs("#exerciseSkipReasonInput").value.trim() || null,
      notes: qs("#exerciseSkipNotesInput").value.trim() || null
    });
    setBtnLoading(btn, false, t("reminder_save", "Save"));
  });

  await refreshTodayStatus();
  await loadStreakAndProgress();
  await loadRecommendation();

 const plans = {
  strength: {
    title: "Strength Routine",
    description: "A balanced set of bodyweight and resistance exercises.",
    items: [
      "Push-ups — 3 sets of 10",
      "Squats — 3 sets of 12",
      "Plank — 3 sets of 30s",
      "Lunges — 3 sets of 10 each leg"
    ]
  },

  cardio: {
    title: "Cardio Routine",
    description: "A heart-pumping sequence to improve endurance.",
    items: [
      "Jumping Jacks — 2 min",
      "High Knees — 3 sets of 30 sec",
      "Burpees — 3 sets of 8",
      "Brisk Walk or Jog — 15 min"
    ]
  },

  flexibility: {
    title: "Flexibility Flow",
    description: "Stretching exercises to improve flexibility and reduce stiffness.",
    items: [
      "Cat-Cow Stretch — 1 min",
      "Hamstring Stretch — 2 min each leg",
      "Shoulder Circles — 2 sets of 15",
      "Child's Pose — 2 min"
    ]
  },

  weightLoss: {
    title: "Weight Loss Workout",
    description: "Burn calories with a combination of cardio and bodyweight exercises.",
    items: [
      "Jump Rope — 5 min",
      "Mountain Climbers — 3 sets of 30 sec",
      "Burpees — 3 sets of 12",
      "Bodyweight Squats — 3 sets of 20",
      "Plank — 45 sec",
      "Walking or Cycling — 20 min"
    ]
  },

  muscleGain: {
    title: "Muscle Gain Workout",
    description: "Increase muscle strength and size with progressive exercises.",
    items: [
      "Push-ups — 4 sets of 12",
      "Pull-ups — 3 sets of 8",
      "Bench Press — 4 sets of 10",
      "Dumbbell Rows — 3 sets of 12",
      "Deadlift — 3 sets of 8",
      "Plank — 1 min"
    ]
  },

  beginner: {
    title: "Beginner Workout",
    description: "Simple exercises for people starting their fitness journey.",
    items: [
      "March in Place — 5 min",
      "Wall Push-ups — 3 sets of 10",
      "Chair Squats — 3 sets of 12",
      "Standing Side Leg Raises — 3 sets of 12",
      "Stretching — 10 min"
    ]
  },

  senior: {
    title: "Senior Fitness",
    description: "Low-impact exercises to improve balance, flexibility, and strength.",
    items: [
      "Chair Marches — 5 min",
      "Heel Raises — 3 sets of 15",
      "Chair Squats — 3 sets of 10",
      "Seated Arm Raises — 3 sets of 12",
      "Gentle Stretching — 10 min"
    ]
  },

  yoga: {
    title: "Yoga Session",
    description: "Relaxing yoga poses for flexibility, posture, and stress relief.",
    items: [
      "Mountain Pose — 1 min",
      "Downward Dog — 1 min",
      "Warrior II — 30 sec each side",
      "Cobra Pose — 1 min",
      "Child's Pose — 2 min",
      "Meditation — 5 min"
    ]
  },

  hiit: {
    title: "HIIT Workout",
    description: "High-intensity interval training for maximum calorie burn.",
    items: [
      "Jump Squats — 30 sec",
      "Burpees — 30 sec",
      "Mountain Climbers — 30 sec",
      "Rest — 30 sec",
      "Repeat for 5 rounds"
    ]
  },

  core: {
    title: "Core Strength",
    description: "Strengthen abdominal and lower back muscles.",
    items: [
      "Plank — 1 min",
      "Russian Twists — 20 reps",
      "Bicycle Crunches — 20 reps",
      "Leg Raises — 15 reps",
      "Side Plank — 30 sec each side"
    ]
  },

  home: {
    title: "Home Workout",
    description: "No-equipment exercises you can do anywhere.",
    items: [
      "Bodyweight Squats — 20 reps",
      "Push-ups — 15 reps",
      "Lunges — 12 each leg",
      "Glute Bridges — 20 reps",
      "Plank — 45 sec",
      "Jumping Jacks — 2 min"
    ]
  },

  office: {
    title: "Office Desk Workout",
    description: "Quick exercises to stay active during work.",
    items: [
      "Neck Stretch — 30 sec",
      "Shoulder Rolls — 20 reps",
      "Chair Squats — 15 reps",
      "Seated Knee Lifts — 20 reps",
      "Wrist Stretch — 30 sec",
      "Walk Around — 5 min"
    ]
  },

  pregnancy: {
    title: "Prenatal Fitness",
    description: "Gentle exercises suitable during pregnancy (with medical approval).",
    items: [
      "Walking — 20 min",
      "Pelvic Tilts — 15 reps",
      "Cat-Cow Stretch — 10 reps",
      "Side Leg Raises — 15 reps",
      "Deep Breathing — 5 min"
    ]
  },

  relaxation: {
    title: "Relaxation & Recovery",
    description: "Light movements to help muscles recover after exercise.",
    items: [
      "Foam Rolling — 10 min",
      "Full Body Stretch — 10 min",
      "Deep Breathing — 5 min",
      "Light Walking — 15 min",
      "Meditation — 10 min"
    ]
  }
};

  exerciseBtn.addEventListener("click", () => {
    const goal = qs("#goalSelect").value;
    selectedGoal = goal;
    const plan = plans[goal];
    exerciseTitle.textContent = plan.title;
    exerciseDescription.textContent = plan.description;
    exerciseList.innerHTML = plan.items.map((item) => `<div class="text-sm mt-8">• ${item}</div>`).join("");
    const grid = qs("#exerciseGrid");
    if (grid) {
      grid.classList.remove("grid-single");
      grid.classList.add("grid-double");
    }
    exerciseResult.style.display = "block";
  });
});