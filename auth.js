/* =========================================================================
   auth.js — Supabase authentication
   Handles: register, login, logout, session checks, protected routes,
   password reset. Loaded on every page (config.js must load first).
   ========================================================================= */

// Guard: if config.js wasn't filled out, show a clear message and
// prevent auth actions from trying to call the (missing) client.
const _SUPABASE_CONFIG_OK = typeof SUPABASE_CONFIG_VALID !== "undefined" ? SUPABASE_CONFIG_VALID : true;

function ensureSupabase() {
  if (!_SUPABASE_CONFIG_OK || typeof supabaseClient === "undefined" || !supabaseClient) {
    console.error("Supabase client not configured. Please set SUPABASE_URL and SUPABASE_ANON_KEY in config.js");
    if (typeof showToast === "function") {
      showToast(
        "Supabase not configured. Edit config.js with your project URL and anon key. The anon key must start with 'eyJ'.",
        "error",
        8000
      );
    } else {
      alert("Supabase not configured. Edit config.js with your project URL and anon key. The anon key must start with 'eyJ'.");
    }
    return false;
  }
  return true;
}

/* ---------- REGISTER ---------- */
// Wire this up to register.html's form (id="registerForm").
async function handleRegister(event) {
  event.preventDefault();

  if (!ensureSupabase()) return;

  const name = qs("#name").value.trim();
  const email = qs("#email").value.trim();
  const password = qs("#password").value;
  const confirmPassword = qs("#confirmPassword").value;
  const submitBtn = qs("#registerBtn");

  if (password !== confirmPassword) {
    showToast(t("toast_auth_pw_mismatch", "Passwords do not match."), "error");
    return;
  }
  if (password.length < 6) {
    showToast(t("toast_auth_pw_min", "Password must be at least 6 characters."), "error");
    return;
  }

  setBtnLoading(submitBtn, true, "Creating account...");

  // 1) Create the auth user in Supabase Auth
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { data: { name } } // stored in auth.users.user_metadata
  });

  if (error) {
    setBtnLoading(submitBtn, false, "Create account");
    showToast(error.message, "error");
    return;
  }

  // 2) Create the matching profile row in our public "users" table.
  //    (id must match the auth.users id — see schema.sql for the FK.)
  if (data.user) {
    const { error: profileError } = await supabaseClient.from("users").insert({
      id: data.user.id,
      name,
      email
    });
    if (profileError) {
      console.error("Profile insert error:", profileError.message);
      // Not fatal to the signup flow — the trigger in schema.sql is a
      // second safety net that also creates this row automatically.
    }
  }

  setBtnLoading(submitBtn, false, "Create account");
  showToast(t("toast_auth_account_created", "Account created! Check your email to confirm, then log in."), "success");
  setTimeout(() => (window.location.href = LOGIN_ROUTE), 1800);
}

/* ---------- LOGIN ---------- */
// Wire this up to login.html's form (id="loginForm").
async function handleLogin(event) {
  event.preventDefault();

  if (!ensureSupabase()) return;

  const email = qs("#email").value.trim();
  const password = qs("#password").value;
  const submitBtn = qs("#loginBtn");

  setBtnLoading(submitBtn, true, "Signing in...");

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error) {
    setBtnLoading(submitBtn, false, "Sign in");
    showToast(error.message, "error");
    return;
  }

  showToast(t("toast_auth_welcome_back", "Welcome back!"), "success");
  setTimeout(() => (window.location.href = DASHBOARD_ROUTE), 700);
}

/* ---------- FORGOT PASSWORD ---------- */
// Wire this up to forgot-password.html's form (id="forgotForm").
async function handleForgotPassword(event) {
  event.preventDefault();

  if (!ensureSupabase()) return;

  const email = qs("#email").value.trim();
  const submitBtn = qs("#forgotBtn");
  setBtnLoading(submitBtn, true, "Sending link...");

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + "/reset-password.html"
  });

  setBtnLoading(submitBtn, false, "Send reset link");

  if (error) {
    showToast(error.message, "error");
    return;
  }
  showToast(t("toast_auth_reset_sent", "Password reset link sent. Check your inbox."), "success");
}

/* ---------- LOGOUT ---------- */
// Wire this up to any "Log out" button: onclick="handleLogout()"
async function handleLogout() {
  if (!ensureSupabase()) return;
  await supabaseClient.auth.signOut();
  window.location.href = "index.html";
}

/* ---------- SESSION / ROUTE PROTECTION ---------- */
// Call requireAuth() at the top of every protected dashboard page.
// Redirects to login if there is no active session, and returns the user.
async function requireAuth() {
  if (!ensureSupabase()) return null;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = LOGIN_ROUTE;
    return null;
  }
  return session.user;
}

// Call redirectIfLoggedIn() on login/register pages so a logged-in user
// is sent straight to the dashboard instead of seeing the auth form again.
async function redirectIfLoggedIn() {
  if (!ensureSupabase()) return;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) window.location.href = DASHBOARD_ROUTE;
}

// Keeps sidebar/topbar user info in sync and reacts to logout in another tab.
if (typeof supabaseClient !== "undefined" && supabaseClient) {
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      const page = window.location.pathname.split("/").pop();
      if (PROTECTED_PAGES.includes(page)) window.location.href = LOGIN_ROUTE;
    }
  });
}

/* ---------- Populate topbar/sidebar with the logged-in user's info ---------- */
// Call this from dashboard.js and every protected page after requireAuth().
async function loadUserChip(user) {
  if (!ensureSupabase()) return null;
  const { data: profile } = await supabaseClient
    .from("users")
    .select("name, email, age, gender, height, weight, settings")
    .eq("id", user.id)
    .single();

  const name = profile?.name || user.user_metadata?.name || "User";
  qsa(".js-user-name").forEach((el) => (el.textContent = name));
  qsa(".js-user-email").forEach((el) => (el.textContent = user.email));
  qsa(".js-user-avatar").forEach((el) => (el.textContent = getInitials(name)));

  // If they set their language on another device, pick it up here so it's
  // consistent everywhere without needing to visit Settings again.
  const savedLang = profile?.settings?.language;
  if (savedLang && typeof getCurrentLang === "function" && savedLang !== getCurrentLang()) {
    setLang(savedLang);
  }

  return profile || {};
}

/* ---------- Small helper: button loading state ---------- */
function setBtnLoading(btn, isLoading, label) {
  if (!btn) return;
  btn.disabled = isLoading;
  btn.innerHTML = isLoading ? `<span class="spinner-sm"></span> ${label}` : label;
}
