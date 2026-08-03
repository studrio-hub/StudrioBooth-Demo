/*
 * ADMIN-LOGIN.JS — Sign-in page logic only.
 * Lives on its own page (admin/index.html) now instead of being one
 * hidden section of a single-page app. A successful sign-in navigates
 * straight to dashboard.html; visiting this page while already signed
 * in skips straight past the form too.
 */

(function () {
  const els = {
    loginForm: document.getElementById("loginForm"),
    loginEmail: document.getElementById("loginEmail"),
    loginPassword: document.getElementById("loginPassword"),
    loginSubmitBtn: document.getElementById("loginSubmitBtn"),
    loginError: document.getElementById("loginError")
  };

  els.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.loginError.hidden = true;
    els.loginSubmitBtn.disabled = true;
    els.loginSubmitBtn.textContent = "Signing in…";

    try {
      await adminStorage.signIn(els.loginEmail.value.trim(), els.loginPassword.value);
      window.location.href = "dashboard.html";
    } catch (err) {
      els.loginError.textContent = "Sign-in failed — check your email and password.";
      els.loginError.hidden = false;
      els.loginSubmitBtn.disabled = false;
      els.loginSubmitBtn.textContent = "Sign in";
    }
  });

  /* Already signed in (e.g. came back to /admin/ with a live session)?
     Skip the form entirely and go straight to the dashboard. */
  (async function checkExistingSession() {
    try {
      const user = await adminStorage.getCurrentUser();
      if (user) window.location.href = "dashboard.html";
    } catch (e) {
      // Not signed in — stay on the login page, nothing to do.
    }
  })();
})();
