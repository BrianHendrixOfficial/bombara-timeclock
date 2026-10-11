"use strict";
var API = "https://bllxuuinyhbaxnfodbqq.supabase.co/rest/v1/rpc/";
var KEY = "sb_publishable_Oj1w5MiNPP5_7K1RQg5fVQ_paWmKBZ5";
var HOUR = 3600000, MIN = 60000, DAY = 86400000;
var LUNCHES = [0, 15, 30, 45, 60, 90];
var TABS = ["timesheet", "punches", "jobs", "people"];
var ERR = {
  bad: "Wrong PIN. Try again.", locked: "Too many wrong tries. Wait a minute, then try again.",
  unknown: "That person is not on the crew any more.", no_job: "That job is closed. Pick another.",
  already_in: "Already on the clock.", not_in: "Not on the clock.", lunch_too_long: "That lunch is longer than the shift.",
  short: "Use at least 6 characters.", exists: "A manager passcode is already set.", bad_pin: "A PIN is exactly 4 digits.",
  missing: "Something is missing. Check the form.", bad_times: "Clock-out must be after clock-in.",
  bad_value: "One of those values is out of range. Check it and try again.", setup: "Set the manager passcode first.", net: "No connection. Check your signal and try again."
};
var KIND = {
  people: { fn: "tc_admin_person", added: " added to the crew", removed: " taken off the crew", restored: " is back on the crew", confirm: "Take off the crew? Past hours stay.", gone: "Off the crew", removeLabel: "Remove",
    empty: "Add each person with a 4-digit PIN. Tell them their PIN; they use it to clock in from their own phone." },
  jobs: { fn: "tc_admin_job", added: " added to jobs", removed: " closed", restored: " reopened", confirm: "Close this job? Past hours stay.", gone: "Closed", removeLabel: "Close job",
    empty: "Add each job site by name or address. Open jobs are the choices at clock-in." }
};
/* Crew state */
var C = { ready: false, offline: false, setup: true, people: [], me: null, data: null, picking: null, pin: "", remember: true, pending: null, busy: false };
/* Manager state */
var S = { pass: null, authed: false, people: [], jobs: [], punches: [], loaded: false,
  tab: "timesheet", week: 0, view: "person", shown: 40, editing: null, pinEdit: null, confirmDelete: null, confirmRemove: null };
var mode = "crew";
var $ = function (id) { return document.getElementById(id); };

function h(tag, attrs) {
  var e = document.createElement(tag), k, v, i;
  if (attrs) for (k in attrs) {
    v = attrs[k];
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, v);
  }
  for (i = 2; i < arguments.length; i++) add(e, arguments[i]);
  return e;
}
function add(e, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(function (x) { add(e, x); }); return; }
  e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
}
function store(kind, key, val) {
  try {
    var s = kind === "session" ? window.sessionStorage : window.localStorage;
    if (val === undefined) return s.getItem(key);
    if (val === null) s.removeItem(key); else s.setItem(key, val);
  } catch (e) {}
  return null;
}

/* ---- server ---- */
function rpc(fn, args) {
  return fetch(API + fn, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args || {}) })
    .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); });
}
/* Resolves the result, or {fail: code} after showing why. */
function call(fn, args, badMsg) {
  return rpc(fn, args).then(function (res) {
    if (res && res.ok === false) { toast(res.error === "bad" && badMsg ? badMsg : ERR[res.error] || "That did not work. Try again."); return { fail: res.error }; }
    return res;
  }, function () { toast(ERR.net); return { fail: "net" }; });
}

/* ---- time helpers ---- */
function pad(n) { return String(n).padStart(2, "0"); }
function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function fmtDay(ms) { return new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); }
function fmtDur(ms) { var m = Math.max(0, Math.floor(ms / MIN)); return Math.floor(m / 60) + "h " + pad(m % 60) + "m"; }
function dec(ms) { return (Math.max(0, ms) / HOUR).toFixed(2); }
function lunchLabel(m) { m = Number(m) || 0; if (!m) return "No lunch"; if (m < 60) return m + " min"; return Math.floor(m / 60) + " hr" + (m % 60 ? " " + (m % 60) + " min" : ""); }
function toInput(ms) { var d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function fromInput(s) { if (!s) return null; var t = new Date(s).getTime(); return isNaN(t) ? null : t; }
function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }
function dayStart() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function weekDays(offset) {
  var d = new Date(), out = [], i, first = d.getDate() - d.getDay() + offset * 7;
  for (i = 0; i <= 7; i++) out.push(new Date(d.getFullYear(), d.getMonth(), first + i).getTime());
  return out; /* Sunday 00:00 through the next Sunday 00:00 */
}
/* Settings from the server (set by crew.js from tc_me and admin.js from tc_admin). */
var CFG = { round: 0, periodDays: 7, periodAnchor: null };
/* Round a clock time to the nearest CFG.round minutes (0 = no rounding). */
function roundMs(ms) { var step = (Number(CFG.round) || 0) * MIN; return step ? Math.round(ms / step) * step : ms; }
/* Paid time on a punch: clock-out minus clock-in (each rounded per CFG.round) minus lunch. A running shift counts up to now, unrounded. */
function paid(p, now) {
  var a = roundMs(p.in), b = p.out == null ? now : roundMs(p.out);
  return Math.max(0, b - a - (Number(p.lunchMin) || 0) * MIN);
}
/* Where this phone is right now: resolves {lat, lng, acc} (acc in metres) or null if denied, unavailable or slow. Never rejects. */
function getSpot() {
  return new Promise(function (resolve) {
    var done = false;
    function finish(v) { if (!done) { done = true; resolve(v); } }
    if (!navigator.geolocation) { finish(null); return; }
    setTimeout(function () { finish(null); }, 9000);
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        finish({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy || 0) });
      }, function () { finish(null); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    } catch (e) { finish(null); }
  });
}
/* Metres between two points. */
function distanceM(lat1, lng1, lat2, lng2) {
  var R = 6371000, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}
/* A link that opens a point in the phone's maps app. */
function mapUrl(lat, lng) { return "https://www.google.com/maps?q=" + lat + "," + lng; }
function money(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function spanText(x) {
  var sameDay = x.out != null && new Date(x.out).toDateString() === new Date(x.in).toDateString();
  return fmtTime(x.in) + " – " + (x.out == null ? "now" : fmtTime(x.out) + (sameDay ? "" : " (" + fmtDay(x.out) + ")"));
}

var toastTimer;
function toast(msg) {
  var t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
}

