"use strict";
/* ================= Crew clock ================= */
var FORGOT_MS = 14 * HOUR, OT_MS = 40 * HOUR, NOTE_MAX = 280, DONE_MS = 2500;
/* Crew state beyond the fields declared in shared.js:
   C.data     = tc_me result for the CURRENT week (status card and totals always read this)
   C.week     = week being browsed in "My hours" (0 = this week, -1 = last week, ...)
   C.hist     = { week, state: "loading" | "ok" | "error", punches } for a browsed older week
   C.locating = waiting for the phone's location before a punch is sent */
C.week = 0; C.hist = null; C.note = ""; C.locating = false; C.failMsg = ""; C.loadFailed = false; C.seq = 0; C.histSeq = 0;
/* One plain line about location, shown until the first punch on this phone (only while the browser would still ask). */
C.locHint = !!navigator.geolocation && !store("local", "tc_loc_told");
if (C.locHint && navigator.permissions && navigator.permissions.query) {
  try {
    navigator.permissions.query({ name: "geolocation" }).then(function (st) {
      if (st && st.state !== "prompt") { C.locHint = false; if (C.ready) renderCrew(); }
    }, function () {});
  } catch (e) {}
}

function refreshState() {
  return rpc("tc_state").then(function (st) {
    C.ready = true; C.offline = false; C.setup = !!st.setup; C.people = st.people || [];
  }, function () { C.ready = true; C.offline = true; });
}
function forgetMe() {
  C.me = null; C.data = null; C.pending = null; C.picking = null; C.pin = "";
  C.extra = null; stopWatch();
  C.week = 0; C.hist = null; C.note = ""; C.failMsg = ""; C.loadFailed = false;
  store("local", "tc_me", null);
}
function meArgs(me, offset) {
  var d = weekDays(offset);
  return { p_person: me.id, p_pin: me.pin, p_since: iso(d[0]), p_until: iso(d[7]) };
}
function takeCfg(res) { CFG.round = Number(res.round) || 0; }
function kickedOut(quiet) {
  forgetMe();
  if (!quiet) toast("Your PIN changed or you were taken off the crew. Pick your name again.");
  refreshState().then(renderCrew);
}
/* Current week (plus the open punch). Also refreshes the browsed week when the person is looking at an older one. */
function loadMe(quiet) {
  if (!C.me) return Promise.resolve();
  var me = C.me, seq = ++C.seq;
  return rpc("tc_me", meArgs(me, 0)).then(function (res) {
    if (me !== C.me || seq !== C.seq) return;
    if (res.ok === false) {
      if (res.error === "bad" || res.error === "unknown") { kickedOut(quiet); return; }
      if (!quiet) toast(ERR[res.error] || "Could not load your hours.");
      if (!C.data) C.loadFailed = true;
    } else { takeCfg(res); C.data = res; C.loadFailed = false; if (!C.extra) loadExtra(); }
    renderCrew();
    if (C.data && C.week !== 0) return loadWeek(true);
  }, function () {
    if (me !== C.me || seq !== C.seq) return;
    if (!quiet) toast(ERR.net);
    if (!C.data) C.loadFailed = true;
    renderCrew();
  });
}
/* The browsed older week, Sunday through Saturday. */
function loadWeek(quiet) {
  if (!C.me || C.week === 0) return Promise.resolve();
  var me = C.me, wk = C.week, seq = ++C.histSeq;
  function stale() { return me !== C.me || wk !== C.week || seq !== C.histSeq; }
  if (!quiet || !C.hist || C.hist.week !== wk) { C.hist = { week: wk, state: "loading", punches: [] }; renderCrew(); }
  return rpc("tc_me", meArgs(me, wk)).then(function (res) {
    if (stale()) return;
    if (res.ok === false) {
      if (res.error === "bad" || res.error === "unknown") { kickedOut(quiet); return; }
      if (C.hist.state !== "ok") C.hist = { week: wk, state: "error", punches: [] };
    } else { takeCfg(res); C.hist = { week: wk, state: "ok", punches: res.punches || [] }; }
    renderCrew();
  }, function () {
    if (stale()) return;
    if (C.hist.state !== "ok") C.hist = { week: wk, state: "error", punches: [] };
    renderCrew();
  });
}
function goWeek(n) {
  C.week = Math.min(0, n);
  if (C.week === 0) { C.hist = null; C.histSeq++; renderCrew(); }
  else loadWeek(false);
}
function tryPin() {
  var p = C.picking, pin = C.pin;
  C.busy = true; renderCrew();
  rpc("tc_me", meArgs({ id: p.id, pin: pin }, 0)).then(function (res) {
    C.busy = false; C.pin = "";
    if (res.ok === false) { toast(ERR[res.error] || "That did not work."); renderCrew(); var d = document.querySelector(".dots"); if (d) d.classList.add("shake"); return; }
    C.me = { id: p.id, pin: pin }; takeCfg(res); C.data = res; C.picking = null;
    C.extra = null; loadExtra();
    C.week = 0; C.hist = null; C.note = ""; C.failMsg = ""; C.loadFailed = false;
    if (C.remember) store("local", "tc_me", JSON.stringify(C.me));
    renderCrew();
  }, function () { C.busy = false; C.pin = ""; toast(ERR.net); renderCrew(); });
}
function pressKey(k) {
  if (C.busy || !C.picking) return;
  if (k === "back") C.pin = C.pin.slice(0, -1);
  else if (C.pin.length < 4) C.pin += k;
  renderCrew();
  if (C.pin.length === 4) tryPin();
}
function myOpen() {
  var list = C.data ? C.data.punches : [];
  for (var i = 0; i < list.length; i++) if (list[i].out == null) return list[i];
  return null;
}

/* ---- punching ---- */
/* Every punch: get the phone's location (never blocks: null after 9 s or if denied), send, then confirm full screen. */
function punch(fn, extra, done) {
  var me = C.me;
  if (C.busy || !me) return;
  C.pending = null; C.busy = true; C.locating = true; C.failMsg = ""; renderCrew();
  getSpot().then(function (spot) {
    var args = { p_person: me.id, p_pin: me.pin }, k;
    for (k in extra) args[k] = extra[k];
    args.p_lat = spot ? spot.lat : null; args.p_lng = spot ? spot.lng : null; args.p_acc = spot ? spot.acc : null;
    C.locating = false;
    if (C.locHint) { C.locHint = false; store("local", "tc_loc_told", "1"); }
    renderCrew();
    return call(fn, args);
  }).then(function (res) {
    C.busy = false;
    if (me !== C.me) { renderCrew(); return; }
    if (!res.fail) { C.note = ""; showDone(done); }
    else if (res.fail === "bad" || res.fail === "unknown") { kickedOut(true); return; }
    else if (res.fail === "lunch_too_long") C.pending = "out"; /* let them pick a shorter lunch; the note is kept */
    else if (res.fail === "net") C.failMsg = "Not saved. No connection. Check your signal and try again.";
    return loadMe(true);
  });
}
function clockIn(j) { punch("tc_clock_in", { p_job: j.id }, { kind: "in", title: "Clocked in", job: j.name }); }
function switchJob(j) { punch("tc_switch_job", { p_job: j.id }, { kind: "switch", title: "Switched job", job: "Now on " + j.name }); }
function clockOut(m) {
  var open = myOpen(), note = C.note.trim().slice(0, NOTE_MAX);
  punch("tc_clock_out", { p_lunch: m, p_note: note || null },
    { kind: "out", title: "Clocked out", job: open ? open.job : "", extra: m ? "Lunch: " + lunchLabel(m).toLowerCase() : "No lunch" });
}
function startPunch() {
  if (C.busy) return;
  C.failMsg = "";
  if (myOpen()) { C.pending = "out"; renderCrew(); return; }
  var jobs = C.data.jobs || [];
  if (!jobs.length) { toast("No jobs are open yet. Ask the manager to add one."); return; }
  if (jobs.length === 1) { clockIn(jobs[0]); return; }
  C.pending = "in"; renderCrew();
}

/* ---- full-screen confirmation ---- */
var doneTimer = null;
function closeDone() {
  clearTimeout(doneTimer);
  var o = $("cw-done");
  if (o) o.remove();
}
function showDone(d) {
  closeDone();
  document.body.append(h("div", { id: "cw-done", class: "cw-done " + d.kind, role: "alert", onclick: closeDone },
    h("div", { class: "cw-check", "aria-hidden": "true" }),
    h("div", { class: "cw-done-title" }, d.title),
    h("div", { class: "cw-done-time mono" }, fmtTime(Date.now())),
    d.job && h("div", { class: "cw-done-job" }, d.job),
    d.extra && h("div", { class: "cw-done-extra" }, d.extra),
    h("div", { class: "cw-done-hint" }, "Tap to close")));
  doneTimer = setTimeout(closeDone, DONE_MS);
}
document.addEventListener("keydown", function (ev) { if ((ev.key === "Escape" || ev.key === "Enter") && $("cw-done")) closeDone(); });

/* ---- My hours ---- */
function shortDate(ms) { return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" }); }
function hoursSection(now) {
  var d = weekDays(C.week), state = "ok", src;
  if (C.week === 0) src = C.data.punches || [];
  else if (C.hist && C.hist.week === C.week) { state = C.hist.state; src = C.hist.punches || []; }
  else { state = "loading"; src = []; }
  /* A punch belongs to the week it started in; the open punch comes back for every range, so filter here. */
  var rows = src.filter(function (x) { return x.in >= d[0] && x.in < d[7]; }).sort(function (a, b) { return b.in - a.in; });
  var list = h("div", { class: "list cw-hours", id: "cw-hours" }), total = 0, days = [], byKey = {};
  rows.forEach(function (x) {
    var key = new Date(x.in).toDateString(), w = paid(x, now);
    if (!byKey[key]) { byKey[key] = { at: x.in, sum: 0, rows: [] }; days.push(byKey[key]); }
    byKey[key].rows.push(x); byKey[key].sum += w; total += w;
  });
  if (state === "loading") list.append(h("div", { class: "empty" }, "Loading…"));
  else if (state === "error") list.append(h("div", { class: "empty" }, "Could not load that week. Check your signal.",
    h("button", { class: "btn", "data-k": "wk-retry", onclick: function () { loadWeek(false); } }, "Try again")));
  else if (!rows.length) list.append(h("div", { class: "empty" }, C.week === 0 ? "Your shifts for this week show up here." : "No shifts that week."));
  else {
    days.forEach(function (g) {
      list.append(h("div", { class: "cw-day" },
        h("div", { class: "cw-dayhead" }, h("span", null, fmtDay(g.at)),
          g.rows.length > 1 && h("span", { class: "cw-daytotal" }, "Day total ", h("span", { class: "mono" }, dec(g.sum) + " h"))),
        g.rows.map(function (x) {
          return h("div", { class: "cw-shift" },
            h("div", { class: "main" }, h("strong", null, x.job),
              h("span", { class: "muted cw-when" }, h("span", { class: "mono" }, spanText(x)), x.out != null && h("span", { class: "cw-lunch" }, Number(x.lunchMin) ? lunchLabel(x.lunchMin).toLowerCase() + " lunch" : "no lunch")),
              x.note && h("span", { class: "cw-note" }, "Note: " + x.note)),
            h("span", { class: "mono hours" }, dec(paid(x, now)) + " h"));
        })));
    });
    list.append(h("div", { class: "cw-weektotal" },
      h("div", { class: "cw-weekline" }, h("span", null, "Week total"), h("span", { class: "mono" }, dec(total) + " h")),
      total > OT_MS && h("div", { class: "cw-otline" }, h("span", { class: "ot" }, "Overtime " + dec(total - OT_MS) + " h"), h("span", { class: "muted" }, "past 40.00 this week"))));
  }
  var name = C.week === 0 ? "This week" : C.week === -1 ? "Last week" : -C.week + " weeks ago";
  var nav = h("div", { class: "cw-weeknav" },
    h("button", { class: "btn cw-step", "data-k": "wk-prev", "aria-label": "Previous week", onclick: function () { goWeek(C.week - 1); } }, "←"),
    h("div", { class: "cw-weeklabel", id: "cw-week", "aria-live": "polite" }, h("span", { class: "label" }, name), h("strong", null, shortDate(d[0]) + " – " + shortDate(d[6]))),
    h("button", { class: "btn cw-step", "data-k": "wk-next", "aria-label": "Next week", disabled: C.week === 0, onclick: function () { goWeek(C.week + 1); } }, "→"));
  return h("div", { class: "cw-my" }, h("div", { class: "sec-head" }, h("h2", null, "My hours")), nav,
    C.week !== 0 && h("button", { class: "btn cw-thisweek", "data-k": "wk-now", onclick: function () { goWeek(0); } }, "Back to this week"),
    list);
}

/* ---- screen ---- */
function renderCrew() {
  var box = $("crew"), act = document.activeElement, key = act && box.contains(act) ? act.getAttribute("data-k") : null, s0 = null, s1 = null, el;
  if (key && act.tagName === "INPUT") { try { s0 = act.selectionStart; s1 = act.selectionEnd; } catch (e) {} }
  box.replaceChildren();
  drawCrew(box, Date.now());
  /* The screen is rebuilt on every change: put the focus back where it was (note field, week arrows). */
  if (key) {
    el = box.querySelector('[data-k="' + key + '"]');
    if (el && !el.disabled) { el.focus({ preventScroll: true }); if (s0 != null) { try { el.setSelectionRange(s0, s1); } catch (e) {} } }
  }
}
function drawCrew(box, now) {
  if (!C.ready) { box.append(h("div", { class: "card" }, h("p", { class: "muted" }, "Loading…"))); return; }
  if (C.offline) {
    box.append(h("div", { class: "card" }, h("p", null, "Can't reach the timeclock. Check your signal."),
      h("button", { class: "btn primary", onclick: function () { C.ready = false; renderCrew(); refreshState().then(function () { renderCrew(); loadMe(true); }); } }, "Try again")));
    return;
  }
  /* Signed in on this phone */
  if (C.me && C.data) {
    var open = myOpen(), t0 = dayStart(), wk = weekDays(0)[0], today = 0, week = 0;
    C.data.punches.forEach(function (x) { var w = paid(x, now); if (x.in >= t0) today += w; if (x.in >= wk) week += w; });
    var jobs = C.data.jobs || [];
    var others = open ? jobs.filter(function (j) { return j.id !== open.jobId; }) : [];
    if ((C.pending === "in" && open) || (C.pending === "out" && !open) || (C.pending === "switch" && !others.length)) C.pending = null;
    var ask = null, cancel = h("button", { class: "punch cancel", onclick: function () { C.pending = null; renderCrew(); } }, "Cancel");
    if (C.pending === "in") ask = h("div", { class: "ask" }, h("p", { class: "cw-q" }, "Which job?"),
      h("div", { class: "chips" }, jobs.map(function (j) { return h("button", { class: "chip", onclick: function () { clockIn(j); } }, j.name); })));
    if (C.pending === "switch") ask = h("div", { class: "ask" }, h("p", { class: "cw-q" }, "Switch to which job?"),
      h("div", { class: "chips" }, others.map(function (j) { return h("button", { class: "chip", onclick: function () { switchJob(j); } }, j.name); })));
    if (C.pending === "out") ask = h("div", { class: "ask" },
      h("label", { class: "field" }, h("span", { class: "label" }, "Add a note (optional)"),
        h("input", { type: "text", id: "cw-note", "data-k": "note", maxlength: NOTE_MAX, autocomplete: "off", enterkeyhint: "done", placeholder: "e.g. rained out", value: C.note,
          oninput: function (ev) { C.note = ev.target.value.slice(0, NOTE_MAX); } })),
      h("div", null, h("p", { class: "cw-q" }, "How long was lunch today?"), h("p", { class: "muted cw-fine" }, "Tap one to clock out.")),
      h("div", { class: "chips" }, LUNCHES.map(function (m) { return h("button", { class: "chip", onclick: function () { clockOut(m); } }, lunchLabel(m)); })));
    var btn = h("button", { class: "punch" + (C.busy ? " working" : open ? " out" : ""), id: "cw-punch", disabled: C.busy, onclick: startPunch },
      C.locating ? "Getting location…" : C.busy ? "Saving…" : open ? "Clock out" : "Clock in");
    var forgot = open && now - open.in >= FORGOT_MS;
    box.append(h("div", { class: "card" },
      h("div", null, h("div", { class: "me-name" }, C.data.name),
        h("div", { class: "status" },
          h("span", { class: "pill" + (open ? " in" : "") }, open ? "On the clock" : "Off the clock"),
          open && h("span", { class: "job" }, open.job),
          open && h("span", null, "since " + fmtTime(open.in) + (open.in < t0 ? " (" + fmtDay(open.in) + ")" : "") + " · ", h("span", { class: "mono", "data-since": open.in }, fmtDur(now - open.in))))),
      forgot && h("div", { class: "cw-warn", id: "cw-forgot", role: "note" },
        h("strong", null, "Still clocked in since " + fmtTime(open.in) + " on " + fmtDay(open.in) + "."),
        " Did you forget to clock out? Clock out now, then ask the manager to fix the time."),
      C.failMsg && !C.busy && h("div", { class: "cw-warn", id: "cw-fail", role: "alert" }, h("strong", null, C.failMsg)),
      C.pending ? [ask, cancel] : [btn,
        C.locating && h("p", { class: "muted cw-fine cw-center" }, "This saves in a few seconds, with or without location."),
        open && others.length && !C.busy && h("button", { class: "btn cw-second", id: "cw-switch", onclick: function () { C.failMsg = ""; C.pending = "switch"; renderCrew(); } }, "Switch job"),
        C.locHint && h("p", { class: "muted cw-fine", id: "cw-lochint" }, "This app records where the phone is only at the moment you clock in or out. Nothing in between.")],
      h("div", { class: "totals" },
        h("div", null, h("span", { class: "mono", id: "cw-today" }, dec(today)), h("span", { class: "label" }, "hrs today")),
        h("div", null, h("span", { class: "mono", id: "cw-weekhrs" }, dec(week)), h("span", { class: "label" }, "hrs this week"))),
      CFG.round > 0 && h("p", { class: "muted cw-fine", id: "cw-round" }, "Hours are rounded to the nearest " + CFG.round + " minutes.")));
    box.append(hoursSection(now));
    box.append(h("div", { class: "foot" }, h("button", { class: "btn link", disabled: C.busy, onclick: function () { forgetMe(); refreshState().then(renderCrew); } }, "Not " + C.data.name + "? Switch person")));
    return;
  }
  if (C.me && !C.data) {
    if (C.loadFailed) box.append(h("div", { class: "card" }, h("p", null, "Can't load your hours. Check your signal."),
      h("button", { class: "btn primary", onclick: function () { C.loadFailed = false; renderCrew(); loadMe(false); } }, "Try again")));
    else box.append(h("div", { class: "card" }, h("p", { class: "muted" }, "Loading your hours…")));
    return;
  }
  /* PIN entry */
  if (C.picking) {
    var dots = h("div", { class: "dots", "aria-label": C.pin.length + " of 4 digits entered" }, [0, 1, 2, 3].map(function (i) { return h("span", { class: "dot" + (i < C.pin.length ? " on" : "") }); }));
    var keys = h("div", { class: "keys" }, ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(function (k) { return h("button", { class: "key", onclick: function () { pressKey(k); } }, k); }),
      h("button", { class: "key ghost", onclick: function () { C.picking = null; C.pin = ""; renderCrew(); } }, "Back"),
      h("button", { class: "key", onclick: function () { pressKey("0"); } }, "0"),
      h("button", { class: "key ghost", "aria-label": "Delete last digit", onclick: function () { pressKey("back"); } }, "Delete"));
    var keep = h("input", { type: "checkbox", id: "remember", onchange: function (ev) { C.remember = ev.target.checked; } });
    keep.checked = C.remember;
    box.append(h("div", { class: "card" },
      h("div", null, h("div", { class: "me-name" }, C.picking.name), h("p", { class: "muted" }, C.busy ? "Checking…" : "Enter your 4-digit PIN")),
      dots, keys,
      h("label", { class: "cw-remember" }, keep, "Remember me on this phone")));
    return;
  }
  /* Name picker */
  if (!C.people.length) {
    box.append(h("div", { class: "card" }, h("h2", null, "No crew yet"), h("p", { class: "muted" }, "The manager adds each person and their PIN under Manager. Then names show up here to clock in.")));
    return;
  }
  box.append(h("div", null, h("div", { class: "sec-head" }, h("h2", null, "Who's clocking in?")),
    h("div", { class: "names" }, C.people.map(function (p) { return h("button", { class: "namebtn", onclick: function () { C.picking = p; C.pin = ""; renderCrew(); } }, p.name); }))));
}


/* ================= Reminders to clock in =================
   Two things set this off while the timeclock is open on the phone:
   pulling up to a job whose location the manager saved, and the time
   you are due on a job passing with no clock-in.
   A web page cannot watch where the phone is when it is closed. For a
   reminder that reaches you with the app shut, set up an arrival
   automation on the phone itself (iPhone: Shortcuts > Automation > Arrive). */
C.extra = null; C.spotNow = null; C.watchId = null; C.fired = {}; C.hushed = {};

function loadExtra() {
  if (!C.me) return;
  var me = C.me;
  rpc("tc_me_extra", { p_person: me.id, p_pin: me.pin }).then(function (res) {
    if (me !== C.me || !res || res.ok === false) return;
    C.extra = res;
    startWatch();
    renderAlert();
  }, function () {});
}
function startWatch() {
  if (C.watchId != null || !navigator.geolocation) return;
  if (!C.extra || !C.extra.jobs || !C.extra.jobs.length) return;
  try {
    C.watchId = navigator.geolocation.watchPosition(function (pos) {
      C.spotNow = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now() };
      renderAlert();
    }, function () {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 20000 });
  } catch (e) {}
}
function stopWatch() {
  if (C.watchId == null) return;
  try { navigator.geolocation.clearWatch(C.watchId); } catch (e) {}
  C.watchId = null; C.spotNow = null;
}
/* The closest saved job this phone is standing inside, or null. */
function nearJob() {
  if (!C.spotNow || !C.extra || !C.extra.jobs) return null;
  var best = null;
  C.extra.jobs.forEach(function (j) {
    var d = distanceM(C.spotNow.lat, C.spotNow.lng, j.lat, j.lng);
    if (d <= (Number(j.radius) || 300) && (!best || d < best.dist)) best = { job: j, dist: d };
  });
  return best;
}
function todayKey() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function dueNow() {
  var r = C.extra && C.extra.remind;
  if (!r || !r.on || !r.at) return false;
  var days = r.days && r.days.length ? r.days : [1, 2, 3, 4, 5], d = new Date();
  if (days.indexOf(d.getDay()) < 0) return false;
  var hm = String(r.at).split(":");
  var due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(hm[0]) || 0, Number(hm[1]) || 0).getTime();
  var now = Date.now();
  return now >= due && now <= due + 6 * HOUR;
}
function alertState() {
  if (mode !== "crew" || !C.me || !C.data) return null;
  var open = myOpen(), near = nearJob();
  if (!open && near) return { key: "in:" + near.job.id + ":" + todayKey(), kind: "in", job: near.job,
    title: "You are at " + near.job.name, body: "You are not on the clock." };
  if (!open && dueNow()) return { key: "due:" + todayKey(), kind: "due",
    title: "You are due on a job", body: "You have not clocked in yet today." };
  if (open && C.extra && C.extra.jobs && C.extra.jobs.length && C.spotNow && !near && Date.now() - open.in > 10 * MIN)
    return { key: "out:" + open.id, kind: "out",
      title: "Still on the clock", body: "You have left " + (open.job || "the job") + " and you are still clocked in." };
  return null;
}
/* A sound and a buzz the first time each reminder comes up. */
var actx = null;
function primeSound() {
  try {
    var A = window.AudioContext || window.webkitAudioContext;
    if (!actx && A) actx = new A();
    if (actx && actx.state === "suspended") actx.resume();
  } catch (e) {}
}
function chime() {
  try { if (navigator.vibrate) navigator.vibrate([130, 90, 130]); } catch (e) {}
  try {
    if (!actx) return;
    var t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, t); o.frequency.setValueAtTime(660, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.65);
  } catch (e) {}
}
function notify(a) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!document.hidden) return; /* the banner is already on screen */
    new Notification(a.title, { body: a.body, tag: a.key, icon: "icon-192.png" });
  } catch (e) {}
}
function askNotify() {
  try {
    if (!("Notification" in window)) { toast("This phone cannot show notifications from a web page."); return; }
    Notification.requestPermission().then(function (p) {
      toast(p === "granted" ? "Reminders will show even when the timeclock is in the background." : "Notifications stayed off. The banner still shows while the timeclock is open.");
      renderAlert();
    });
  } catch (e) {}
}
function renderAlert() {
  var box = $("crew-alert");
  if (!box) return;
  var a = alertState();
  box.replaceChildren();
  if (!a || C.hushed[a.key]) { box.hidden = true; return; }
  box.hidden = false;
  if (!C.fired[a.key]) { C.fired[a.key] = 1; chime(); notify(a); }

  var acts = h("div", { class: "c-alert-acts" });
  if (a.kind === "in") {
    acts.append(h("button", { class: "btn primary", onclick: function () {
      C.hushed[a.key] = 1; clockIn(a.job);
    } }, "Clock in on " + a.job.name));
  } else if (a.kind === "due") {
    acts.append(h("button", { class: "btn primary", onclick: function () {
      C.hushed[a.key] = 1; renderAlert();
      var jobs = (C.data && C.data.jobs) || [];
      if (jobs.length === 1) clockIn(jobs[0]); else { C.pending = "in"; renderCrew(); }
    } }, "Clock in"));
  } else {
    acts.append(h("button", { class: "btn primary", onclick: function () {
      C.hushed[a.key] = 1; C.pending = "out"; renderCrew();
    } }, "Clock out"));
  }
  if ("Notification" in window && Notification.permission === "default") {
    acts.append(h("button", { class: "btn", onclick: askNotify }, "Alert me in the background"));
  }
  acts.append(h("button", { class: "btn", onclick: function () { C.hushed[a.key] = 1; renderAlert(); } }, "Not now"));

  box.append(h("div", { class: "c-alert-main" }, h("strong", null, a.title), h("span", null, a.body)), acts);
}

/* Keep the banner honest as the clock and the phone's position move. */
document.addEventListener("click", primeSound);
setInterval(renderAlert, 60000);
var _renderCrew = renderCrew;
renderCrew = function () { _renderCrew.apply(null, arguments); renderAlert(); };
