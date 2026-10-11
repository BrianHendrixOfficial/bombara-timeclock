"use strict";
/* ================= Shell ================= */
function show() {
  var admin = mode === "admin";
  $("crew").hidden = admin;
  $("gate").hidden = !admin || S.authed;
  $("setup-form").hidden = C.setup;
  $("login-form").hidden = !C.setup;
  $("admin").hidden = !admin || !S.authed;
  $("mode-label").textContent = admin ? "Timeclock · Manager" : "Timeclock";
  $("mode-switch").textContent = admin ? (S.authed ? "Lock and go back to the crew clock" : "Back to the crew clock") : "Manager";
}
function setMode(m) {
  mode = m;
  if (m === "admin") {
    show();
    if (C.setup && !S.authed && S.pass) reloadAdmin(true);
    else if (S.authed) reloadAdmin(true);
  } else {
    if (S.authed) lock();
    show(); renderCrew();
    refreshState().then(function () { renderCrew(); loadMe(true); });
  }
}
function tick() {
  var now = new Date();
  $("now").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  $("today").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  document.querySelectorAll("[data-since]").forEach(function (el) { el.textContent = fmtDur(now.getTime() - Number(el.dataset.since)); });
}
function poll() {
  if (document.hidden) return;
  if (mode === "admin" && S.authed) { if (!S.editing && !S.pinEdit && !S.confirmDelete && !S.confirmRemove) reloadAdmin(true); }
  else if (mode === "crew" && C.me && !C.pending && !C.busy) loadMe(true);
}

$("mode-switch").addEventListener("click", function () { setMode(mode === "admin" ? "crew" : "admin"); });
document.addEventListener("keydown", function (ev) {
  if (mode !== "crew" || !C.picking) return;
  if (/^[0-9]$/.test(ev.key)) pressKey(ev.key);
  else if (ev.key === "Backspace") pressKey("back");
});
document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });

/* ---- start ---- */
try { var saved = JSON.parse(store("local", "tc_me") || "null"); if (saved && saved.id && saved.pin) C.me = saved; } catch (e) {}
S.pass = store("session", "tc_pass");
if ((location.hash || "") === "#manager") mode = "admin";
setTab("timesheet");
tick(); setInterval(tick, 1000);
setInterval(poll, 30000);
setInterval(function () { if (mode === "admin" && S.authed) { renderBoard(); renderSheet(); } }, 60000);
show(); renderCrew();
refreshState().then(function () {
  if (!C.offline && !C.setup) mode = "admin"; /* first run: go straight to setting the passcode */
  show(); renderCrew();
  if (mode === "admin" && C.setup && S.pass) reloadAdmin(true);
  if (mode === "crew") loadMe(true);
});
