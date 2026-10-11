"use strict";
/* ================= Manager ================= */
function nameIn(list, id, fallback) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name || "Unnamed";
  return fallback;
}
function personName(id) { return nameIn(S.people, id, "Removed person"); }
function jobName(id) { return id ? nameIn(S.jobs, id, "Removed job") : "No job"; }
function active(list) {
  return list.filter(function (p) { return p.active !== false; }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
}
function openPunch(personId) {
  for (var i = 0; i < S.punches.length; i++) if (S.punches[i].personId === personId && S.punches[i].out == null) return S.punches[i];
  return null;
}
/* Manager-only state and messages (added here because shared.js is fixed). */
S.mode = "week"; S.period = 0; S.rateEdit = null; S.locBusy = null; S.locMsg = null; S.setDirty = false; S.since = Infinity; S.seq = 0;
if (!ERR.bad_value) ERR.bad_value = "That value is not allowed. Check it and try again.";
var FORGOT_MS = 14 * HOUR, OT_MS = 40 * HOUR;
var RADII = [[90, "300 ft"], [150, "500 ft"], [300, "1000 ft"], [400, "¼ mile"]], RADIUS_DEFAULT = 150;

function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
function rateOf(personId) {
  var p = byId(S.people, personId);
  if (!p || p.rate == null || p.rate === "") return null;
  var n = Number(p.rate);
  return isFinite(n) && n >= 0 ? n : null;
}
function forgot(x, now) { return x.out == null && now - x.in >= FORGOT_MS; }
function fmtDist(m) { var ft = m * 3.28084; return ft < 1000 ? Math.round(ft / 10) * 10 + " ft" : (m / 1609.344).toFixed(1) + " mi"; }
function radiusLabel(m) {
  for (var i = 0; i < RADII.length; i++) if (RADII[i][0] === m) return RADII[i][1];
  return fmtDist(m);
}
/* Where one end ("in" or "out") of a punch was, and whether that is away from the job's saved spot. */
function spot(x, end) {
  var lat = x[end + "Lat"], lng = x[end + "Lng"], j = byId(S.jobs, x.jobId), r = { has: lat != null && lng != null, lat: lat, lng: lng, known: false, away: false, dist: 0 };
  if (r.has && j && j.lat != null && j.lng != null) {
    r.known = true; r.dist = distanceM(Number(j.lat), Number(j.lng), Number(lat), Number(lng));
    r.away = r.dist > (Number(j.radius) || 0) + (Number(x[end + "Acc"]) || 0);
  }
  return r;
}

/* ---- dates and ranges ---- */
function ymd(ms) { var d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function md(ms) { var d = new Date(ms); return (d.getMonth() + 1) + "/" + d.getDate(); }
function parseYmd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null; }
function addDays(ms, n) { var d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); }
function rangeLabel(start, end) {
  var a = new Date(start), b = new Date(addDays(end, -1));
  return a.toLocaleDateString([], { month: "short", day: "numeric" }) + " – " + b.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
/* The pay period `offset` periods away from the one containing today. With no first day saved, periods are counted from Sunday Jan 7, 2024. */
function periodRange(offset, len, anchor) {
  len = Number(len) === 14 ? 14 : 7;
  var a = parseYmd(anchor); if (a == null) a = new Date(2024, 0, 7).getTime();
  var k = Math.floor(Math.round((dayStart() - a) / DAY) / len) + offset, start = addDays(a, k * len);
  return { start: start, end: addDays(start, len) };
}
/* Cut a range at each Sunday: the pieces overtime is counted in. */
function weekSegs(start, end) {
  var out = [], s = start, e;
  while (s < end) { e = Math.min(end, addDays(s, 7 - new Date(s).getDay())); out.push([s, e]); s = e; }
  return out;
}
/* What the timesheet is showing: columns to print and the Sunday-Saturday pieces for overtime. */
function visibleRange() {
  var cols = [], R, i;
  if (S.mode === "period") {
    R = periodRange(S.period, CFG.periodDays, CFG.periodAnchor); R.segs = weekSegs(R.start, R.end);
    R.segs.forEach(function (s, n) {
      var last = addDays(s[1], -1);
      cols.push({ start: s[0], end: s[1], label: "Wk " + (n + 1), sub: md(s[0]) + (last > s[0] ? "–" + md(last) : "") });
    });
    R.split = new Date(R.start).getDay() !== 0;
  } else {
    var days = weekDays(S.week);
    R = { start: days[0], end: days[7], segs: [[days[0], days[7]]], split: false };
    for (i = 0; i < 7; i++) cols.push({ start: days[i], end: days[i + 1], label: new Date(days[i]).toLocaleDateString([], { weekday: "short" }), sub: md(days[i]) });
  }
  R.cols = cols; R.period = S.mode === "period";
  return R;
}
function slot(list, ms, key) {
  for (var i = list.length - 1; i > 0; i--) if (ms >= (key ? list[i][key] : list[i][0])) return i;
  return 0;
}

function lock() {
  S.authed = false; S.pass = null; S.loaded = false; S.since = Infinity;
  S.editing = S.pinEdit = S.confirmDelete = S.confirmRemove = S.rateEdit = S.locBusy = S.locMsg = null; S.setDirty = false;
  store("session", "tc_pass", null); show();
}
function sinceMs() { return Math.min(visibleRange().start, Date.now() - 35 * DAY); }
function reloadAdmin(quiet) {
  var since = sinceMs(), pass = S.pass, seq = ++S.seq;
  return rpc("tc_admin", { p_pass: pass, p_since: iso(since) }).then(function (res) {
    if (pass !== S.pass) return false; /* locked or re-keyed while this was in the air */
    if (res.ok === false) {
      if (S.authed || !quiet) toast(res.error === "bad" ? "Wrong passcode." : ERR[res.error] || "Could not open.");
      if (res.error === "setup") C.setup = false;
      lock(); return false;
    }
    if (seq !== S.seq) return true; /* a newer load is on its way */
    var st = res.settings || {};
    CFG.round = Number(st.round) || 0; CFG.periodDays = Number(st.periodDays) === 14 ? 14 : 7; CFG.periodAnchor = st.periodAnchor || null;
    if (sinceMs() < since - MIN) return reloadAdmin(quiet); /* the settings moved the visible pay period further back */
    S.people = res.people || []; S.jobs = res.jobs || []; S.punches = res.punches || []; S.loaded = true; S.since = since;
    if (!S.authed) { S.authed = true; store("session", "tc_pass", S.pass); show(); }
    renderAdmin();
    return true;
  }, function () { if (!quiet) toast(ERR.net); return false; });
}
function adminDo(fn, args, okMsg) {
  args.p_pass = S.pass;
  return call(fn, args, "Wrong passcode.").then(function (res) {
    if (res.fail) { if (res.fail === "bad") lock(); return false; }
    if (okMsg) toast(okMsg);
    return reloadAdmin(true).then(function () { return true; });
  });
}

/* ---- on the clock now ---- */
function renderBoard() {
  var box = $("board"), now = Date.now(), t0 = dayStart(), people = active(S.people), inCount = 0, late = 0;
  box.replaceChildren();
  if (!S.loaded) { box.append(h("div", { class: "empty" }, "Loading…")); $("count").textContent = ""; return; }
  if (!people.length) {
    box.append(h("div", { class: "empty" }, h("p", null, "No one is on the crew yet. Add people and their PINs, add a job, then send the crew the link."),
      h("button", { class: "btn primary", onclick: function () { setTab("people"); $("people-name").focus(); } }, "Add the first person")));
    $("count").textContent = ""; return;
  }
  var rows = people.map(function (p) {
    var open = openPunch(p.id), today = 0;
    S.punches.forEach(function (x) { if (x.personId === p.id && x.in >= t0) today += paid(x, now); });
    return { p: p, open: open, today: today, late: !!open && forgot(open, now) };
  });
  /* forgotten clock-outs first, then everyone on the clock, then everyone out (names stay A to Z inside each group) */
  rows.sort(function (a, b) { return (b.late - a.late) || ((b.open ? 1 : 0) - (a.open ? 1 : 0)); });
  rows.forEach(function (r) {
    var open = r.open;
    if (open) inCount++;
    if (r.late) late++;
    box.append(h("div", { class: "row" + (r.late ? " m-late" : ""), "data-person": r.p.id },
      h("div", { class: "who" }, h("span", { class: "name" }, r.p.name),
        h("span", { class: "status" },
          h("span", { class: "pill" + (open ? " in" : "") }, open ? "On the clock" : "Out"),
          open && h("span", { class: "job" }, jobName(open.jobId)),
          open && h("span", null, "since " + fmtTime(open.in) + (open.in < t0 ? " (" + fmtDay(open.in) + ")" : "") + " · ", h("span", { class: "mono", "data-since": open.in }, fmtDur(now - open.in)))),
        r.late && h("span", { class: "status" },
          h("span", { class: "m-tag strong" }, "Forgot to clock out?"),
          h("button", { class: "btn small", "data-fix": open.id, onclick: function () { fixPunch(open.id); } }, "Fix"))),
      h("div", { class: "today" }, h("span", { class: "mono" }, dec(r.today)), h("span", { class: "label" }, "hrs today"))));
  });
  $("count").textContent = inCount + " of " + people.length + (late ? " · " + late + " to check" : "");
}
/* Jump to a punch's edit form in the Punches tab. */
function fixPunch(id) {
  var at = -1, i;
  for (i = 0; i < S.punches.length; i++) if (S.punches[i].id === id) { at = i; break; }
  if (at < 0) return;
  if (at >= S.shown) S.shown = at + 1;
  S.editing = null; S.confirmDelete = null;
  setTab("punches"); renderLog();
  S.editing = id; drawEdit(S.punches[at]);
  var host = document.querySelector('[data-punch="' + id + '"]');
  if (host && host.scrollIntoView) host.scrollIntoView({ block: "center" });
}

/* ---- timesheet ---- */
function zeros(n) { var a = []; while (n--) a.push(0); return a; }
/* Hours in the visible range by person and by job, with overtime, est. pay and labor. */
function tally(R) {
  var now = Date.now(), n = R.cols.length, P = {}, J = {}, po = [], jo = [];
  function blank(name) { return { name: name, cells: zeros(n), live: zeros(n), seg: zeros(R.segs.length), total: 0, labor: 0, rated: 0, unrated: 0 }; }
  function prow(id) { if (!P[id]) { P[id] = blank(personName(id)); P[id].rate = rateOf(id); po.push(id); } return P[id]; }
  function jrow(id) { if (!J[id]) { J[id] = blank(jobName(id === "none" ? null : id)); jo.push(id); } return J[id]; }
  active(S.people).forEach(function (p) { prow(p.id); });
  active(S.jobs).forEach(function (j) { jrow(j.id); });
  S.punches.forEach(function (x) {
    if (x.in < R.start || x.in >= R.end) return;
    var w = paid(x, now), c = slot(R.cols, x.in, "start"), p = prow(x.personId), j = jrow(x.jobId || "none");
    [p, j].forEach(function (r) { r.cells[c] += w; r.total += w; if (x.out == null) r.live[c] = 1; });
    p.seg[slot(R.segs, x.in)] += w;
    if (p.rate == null) j.unrated += w; else { j.rated += w; j.labor += w / HOUR * p.rate; }
  });
  var sum = { total: 0, reg: 0, ot: 0, pay: 0, hasRates: false, partial: false, labor: 0, laborAny: false, laborPartial: false };
  var people = po.map(function (id) {
    var r = P[id];
    r.ot = 0; r.seg.forEach(function (ms) { r.ot += Math.max(0, ms - OT_MS); });
    r.reg = r.total - r.ot;
    r.pay = r.rate == null ? null : (r.reg + r.ot * 1.5) / HOUR * r.rate;
    sum.total += r.total; sum.reg += r.reg; sum.ot += r.ot;
    if (r.pay != null) { sum.pay += r.pay; sum.hasRates = true; } else if (r.total > 0) sum.partial = true;
    return r;
  });
  var jobs = jo.map(function (id) {
    var r = J[id];
    sum.labor += r.labor; if (r.rated > 0) sum.laborAny = true; if (r.unrated > 0) sum.laborPartial = true;
    return r;
  });
  if (!sum.hasRates) sum.partial = false;
  return { people: people, jobs: jobs, sum: sum };
}
function partTag() { return h("span", { class: "m-part" }, "partial"); }
function hoursCell(ms, live, cls) { return h("td", { class: (cls || "") + (ms ? "" : " zero") + (live ? " live" : "") }, ms ? dec(ms) : "–"); }
function payCell(r) { return h("td", { class: "pay" + (r.pay == null ? " zero" : "") }, r.pay == null ? "–" : money(r.pay)); }
function laborCell(amount, rated, unrated) {
  if (!(rated > 0)) return h("td", { class: "pay zero" }, "–", unrated > 0 && h("span", { class: "m-part" }, "no rate"));
  return h("td", { class: "pay" }, money(amount), unrated > 0 && partTag());
}
function renderSheet() {
  var R = visibleRange(), byJob = S.view === "job", per = R.period, off = per ? S.period : S.week, word = per ? "pay period" : "week";
  var box = $("sheet"), T = tally(R), rows = byJob ? T.jobs : T.people, sum = T.sum, n = R.cols.length, sums = zeros(n);
  $("wk-label").textContent = rangeLabel(R.start, R.end);
  $("wk-prev").setAttribute("aria-label", "Previous " + word); $("wk-next").setAttribute("aria-label", "Next " + word);
  $("wk-now").textContent = per ? "This period" : "This week"; $("wk-now").disabled = off === 0;
  $("mode-week").setAttribute("aria-pressed", per ? "false" : "true"); $("mode-period").setAttribute("aria-pressed", per ? "true" : "false");
  $("view-person").setAttribute("aria-pressed", byJob ? "false" : "true"); $("view-job").setAttribute("aria-pressed", byJob ? "true" : "false");
  $("export").textContent = "Export " + word + " as CSV";
  renderStats(sum); renderNote(R, byJob);
  box.replaceChildren();
  if (!rows.length) {
    box.append(h("div", { class: "empty" }, !S.loaded ? "Loading hours…" : byJob ? "Hours for each job appear here once you add jobs." : "Hours for each person appear here once the crew has people."));
    return;
  }
  var head = h("tr", null, h("th", null, byJob ? "Job" : "Person"));
  R.cols.forEach(function (c) { head.append(h("th", null, c.label, h("span", null, c.sub))); });
  if (per && !byJob) head.append(h("th", { class: "total" }, "Regular"), h("th", null, "Overtime"), h("th", null, "Total"));
  else head.append(h("th", { class: "total" }, "Total"));
  head.append(h("th", { class: "pay" }, byJob ? "Labor" : "Est. pay"));
  var body = h("tbody");
  rows.forEach(function (r) {
    var tr = h("tr", null, h("td", null, r.name));
    r.cells.forEach(function (ms, i) { sums[i] += ms; tr.append(hoursCell(ms, r.live[i])); });
    if (byJob) tr.append(h("td", { class: "total" }, dec(r.total)), laborCell(r.labor, r.rated, r.unrated));
    else if (per) tr.append(h("td", { class: "total" }, dec(r.reg)), h("td", { class: r.ot ? "" : "zero" }, r.ot ? h("span", { class: "ot" }, dec(r.ot)) : "–"), h("td", null, dec(r.total)), payCell(r));
    else tr.append(h("td", { class: "total" }, dec(r.total), r.ot > 0 && h("span", { class: "ot" }, "OT " + dec(r.ot))), payCell(r));
    body.append(tr);
  });
  var foot = h("tr", null, h("td", null, "All"));
  sums.forEach(function (ms) { foot.append(h("td", null, ms ? dec(ms) : "–")); });
  if (byJob) foot.append(h("td", { class: "total" }, dec(sum.total)), laborCell(sum.labor, sum.laborAny ? 1 : 0, sum.laborPartial ? 1 : 0));
  else {
    if (per) foot.append(h("td", { class: "total" }, dec(sum.reg)), h("td", null, sum.ot ? dec(sum.ot) : "–"), h("td", null, dec(sum.total)));
    else foot.append(h("td", { class: "total" }, dec(sum.total)));
    foot.append(h("td", { class: "pay" }, sum.hasRates ? money(sum.pay) : "–", sum.partial && partTag()));
  }
  box.append(h("table", { class: per ? "m-period" : "m-week" }, h("thead", null, head), body, h("tfoot", null, foot)));
}
/* Summary before the table: the three numbers the owner looks for first. */
function renderStats(sum) {
  function stat(id, label, value, extra, warn) {
    return h("div", { class: "m-stat" + (warn ? " warn" : "") }, h("span", { class: "label" }, label), h("span", { class: "mono", id: id }, value), extra);
  }
  $("stats").replaceChildren(
    stat("stat-hours", "Hours", dec(sum.total)),
    stat("stat-ot", "Overtime", dec(sum.ot), null, sum.ot > 0),
    stat("stat-pay", "Est. pay", sum.hasRates ? money(sum.pay) : "–", sum.partial ? partTag() : !sum.hasRates && S.loaded ? h("span", { class: "m-sub muted" }, "No rates set") : null));
}
function renderNote(R, byJob) {
  var lines = ["Hours are decimal (7.50 = 7 h 30 min) with lunch already taken out. A shift counts toward the day it started. A green dot marks a shift still running."];
  if (CFG.round) lines.push("Each clock-in and clock-out is rounded to the nearest " + CFG.round + " minutes before hours are added up (Settings).");
  lines.push("Overtime (OT) is hours past 40 in a Sunday–Saturday week" + (R.period ? ", worked out for each week and then added up." : "."));
  if (R.split) lines.push("This pay period does not start on a Sunday, so it cuts through a calendar week. Overtime is still counted per Sunday–Saturday week, but only over the days inside this pay period.");
  lines.push("Est. pay = regular hours × hourly rate + overtime hours × rate × 1.5. A dash means that person has no rate (Crew tab); “partial” means the total leaves those people out.");
  if (byJob) lines.push("Labor = paid hours on the job × each person's hourly rate, with no overtime premium, because overtime cannot be pinned to one job. So Labor can add up to less than Est. pay. “partial” means some hours on that job belong to people with no rate and are not in the figure.");
  var box = $("sheet-note"); box.replaceChildren();
  add(box, lines.map(function (t) { return h("p", null, t); }));
}
/* Change week / period / mode, loading older punches when the range reaches back past what is loaded. */
function showRange() {
  renderSheet();
  if (S.authed && visibleRange().start < S.since) reloadAdmin(true);
}
function exportSheet() {
  var R = visibleRange(), now = Date.now();
  var lines = ["Name,Job,Date,Clock in,Clock out,Lunch (min),Paid hours,Note,In location,In away from job,Out location,Out away from job"];
  function q(s) { s = String(s == null ? "" : s); if (/^[=+\-@\t]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }
  function where(x, end) {
    var s = spot(x, end);
    return [s.has ? "Yes" : "No", !s.known ? "" : s.away ? q("Yes (" + fmtDist(s.dist) + ")") : "No"];
  }
  S.punches.filter(function (x) { return x.in >= R.start && x.in < R.end; })
    .sort(function (a, b) { return personName(a.personId).localeCompare(personName(b.personId)) || a.in - b.in; })
    .forEach(function (x) {
      var done = x.out != null, sameDay = done && ymd(x.out) === ymd(x.in);
      lines.push([q(personName(x.personId)), q(jobName(x.jobId)), ymd(x.in), q(fmtTime(x.in)),
        done ? q(fmtTime(x.out) + (sameDay ? "" : " (" + ymd(x.out) + ")")) : q("still on the clock"), done ? (Number(x.lunchMin) || 0) : "", dec(paid(x, done ? x.out : now)), q(x.note || "")]
        .concat(where(x, "in"), done ? where(x, "out") : ["", ""]).join(","));
    });
  if (lines.length < 2) { toast("No punches in this " + (R.period ? "pay period" : "week") + " to export."); return; }
  var url = URL.createObjectURL(new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv" }));
  var name = R.period ? "bombara-timeclock-pay-period-" + ymd(R.start) + "-to-" + ymd(addDays(R.end, -1)) : "bombara-timeclock-week-of-" + ymd(R.start);
  var link = h("a", { href: url, download: name + ".csv" });
  document.body.append(link); link.click(); link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
}

/* ---- punches ---- */
function renderLog() {
  if (S.editing) return; /* keep an open edit form intact */
  var box = $("log"), now = Date.now();
  box.replaceChildren();
  if (!S.punches.length) { box.append(h("div", { class: "empty" }, S.loaded ? "No punches yet. Each clock-in shows up here, where you can correct a time, job, lunch or note, or delete a mistake." : "Loading punches…")); $("more").hidden = true; return; }
  S.punches.slice(0, S.shown).forEach(function (x) { box.append(logItem(x, now)); });
  $("more").hidden = S.punches.length <= S.shown;
}
function spotBits(x, end, label) {
  var s = spot(x, end);
  return h("span", { class: "m-end", "data-end": end }, h("span", { class: "m-endlabel" }, label),
    s.has ? h("a", { href: mapUrl(s.lat, s.lng), target: "_blank", rel: "noopener" }, "Map") : h("span", { class: "muted" }, "No location"),
    s.away && h("span", { class: "m-tag" }, "Away from job · " + fmtDist(s.dist)));
}
function logItem(x, now) {
  var actions, late = forgot(x, now);
  if (S.confirmDelete === x.id) {
    actions = [h("span", { class: "muted" }, "Delete this punch?"),
      h("button", { class: "btn small danger", onclick: function () { S.confirmDelete = null; adminDo("tc_admin_delete_punch", { p_id: x.id }, "Punch deleted"); } }, "Delete"),
      h("button", { class: "btn small", onclick: function () { S.confirmDelete = null; renderLog(); } }, "Keep")];
  } else {
    actions = [h("span", { class: "mono hours" }, dec(paid(x, now)) + " h"),
      h("button", { class: "btn small", onclick: function () { S.editing = x.id; S.confirmDelete = null; drawEdit(x); } }, "Edit"),
      h("button", { class: "btn small danger", onclick: function () { S.confirmDelete = x.id; renderLog(); } }, "Delete")];
  }
  return h("div", { class: "item", "data-punch": x.id },
    h("div", { class: "main" },
      h("strong", null, personName(x.personId) + " · " + jobName(x.jobId)),
      h("span", { class: "muted" }, fmtDay(x.in) + " · ", h("span", { class: "mono" }, spanText(x)), x.out != null && " · " + lunchLabel(x.lunchMin).toLowerCase()),
      late && h("span", null, h("span", { class: "m-tag strong" }, "Forgot to clock out? Running " + fmtDur(now - x.in))),
      h("span", { class: "m-spots" }, spotBits(x, "in", "In"), x.out != null && spotBits(x, "out", "Out")),
      x.note && h("span", { class: "m-note" }, h("span", { class: "m-endlabel" }, "Note"), x.note)),
    h("div", { class: "actions" }, actions));
}
function drawEdit(x) {
  var host = document.querySelector('[data-punch="' + x.id + '"]');
  if (!host) { S.editing = null; return; }
  var tin = h("input", { type: "datetime-local", id: "edit-in", value: toInput(x.in), required: true });
  var tout = h("input", { type: "datetime-local", id: "edit-out", value: x.out == null ? "" : toInput(x.out) });
  var jobs = active(S.jobs);
  if (x.jobId && !jobs.some(function (j) { return j.id === x.jobId; })) jobs.push({ id: x.jobId, name: jobName(x.jobId) });
  var job = h("select", { id: "edit-job" }, !x.jobId && h("option", { value: "" }, "No job"), jobs.map(function (j) { return h("option", { value: j.id }, j.name); }));
  job.value = x.jobId || "";
  var cur = Number(x.lunchMin) || 0, opts = LUNCHES.indexOf(cur) < 0 ? LUNCHES.concat(cur).sort(function (a, b) { return a - b; }) : LUNCHES;
  var lunch = h("select", { id: "edit-lunch" }, opts.map(function (m) { return h("option", { value: m }, lunchLabel(m)); }));
  lunch.value = String(cur);
  var note = h("input", { type: "text", id: "edit-note", maxlength: "280", autocomplete: "off", value: x.note || "" });
  function done() { S.editing = null; renderLog(); }
  var form = h("form", { class: "form", onsubmit: function (ev) {
    ev.preventDefault();
    var a = fromInput(tin.value), b = fromInput(tout.value), m = b == null ? 0 : Number(lunch.value) || 0;
    if (a == null) { toast("Enter a clock-in time."); return; }
    if (b != null && b <= a) { toast(ERR.bad_times); return; }
    if (b != null && m * MIN >= b - a) { toast(ERR.lunch_too_long); return; }
    S.editing = null;
    adminDo("tc_admin_punch", { p_id: x.id, p_person: x.personId, p_job: job.value || null, p_in: iso(a), p_out: iso(b), p_lunch: m, p_note: note.value.trim().slice(0, 280) }, "Punch updated").then(function (ok) { if (!ok) renderLog(); });
  } },
    h("label", { class: "field" }, h("span", { class: "label" }, "Job"), job),
    h("label", { class: "field" }, h("span", { class: "label" }, "Clock in"), tin),
    h("label", { class: "field" }, h("span", { class: "label" }, "Clock out (blank = still working)"), tout),
    h("label", { class: "field" }, h("span", { class: "label" }, "Lunch"), lunch),
    h("label", { class: "field m-wide" }, h("span", { class: "label" }, "Note (optional)"), note),
    h("button", { class: "btn primary", type: "submit" }, "Save"),
    h("button", { class: "btn", type: "button", onclick: done }, "Cancel"));
  host.replaceChildren(h("div", { class: "main" }, h("strong", null, personName(x.personId)),
    forgot(x, Date.now()) && h("span", { class: "m-tag strong", id: "edit-hint" }, "Running " + fmtDur(Date.now() - x.in) + ". Enter the real clock-out time."),
    form));
  (x.out == null ? tout : tin).focus();
}

/* ---- jobs and crew ---- */
function fillSelect(id, list) {
  var sel = $(id), keep = sel.value;
  sel.replaceChildren();
  list.forEach(function (p) { sel.append(h("option", { value: p.id }, p.name)); });
  if (keep) sel.value = keep;
}
/* v2 calls take every argument; `more` overrides the nulls (p_pin, p_rate / p_lat, p_lng, p_radius). */
function saveEntry(kind, id, name, isActive, okMsg, more) {
  var args = kind === "people" ? { p_id: id, p_name: name, p_pin: null, p_active: isActive, p_rate: null }
    : { p_id: id, p_name: name, p_active: isActive, p_lat: null, p_lng: null, p_radius: null }, k;
  for (k in more || {}) args[k] = more[k];
  return adminDo(KIND[kind].fn, args, okMsg);
}
function sorted(kind) {
  return S[kind].slice().sort(function (a, b) { return (a.active === false) - (b.active === false) || String(a.name).localeCompare(String(b.name)); });
}
function removeActions(kind, p, redraw) {
  var k = KIND[kind];
  return [h("span", { class: "muted" }, k.confirm),
    h("button", { class: "btn small danger", onclick: function () { S.confirmRemove = null; saveEntry(kind, p.id, null, false, p.name + k.removed); } }, k.removeLabel),
    h("button", { class: "btn small", onclick: function () { S.confirmRemove = null; redraw(); } }, "Keep")];
}
function renderPeople() {
  if (S.rateEdit && $("rate-edit")) return; /* keep a rate being typed */
  var k = KIND.people, box = $("people"), all = sorted("people");
  box.replaceChildren();
  if (!all.length) box.append(h("div", { class: "empty" }, S.loaded ? k.empty : "Loading…"));
  all.forEach(function (p) {
    var gone = p.active === false, key = "people/" + p.id, rate = rateOf(p.id), actions;
    if (gone) actions = h("button", { class: "btn small", onclick: function () { saveEntry("people", p.id, null, true, p.name + k.restored); } }, "Restore");
    else if (S.confirmRemove === key) actions = removeActions("people", p, renderPeople);
    else if (S.pinEdit === p.id) {
      var pin = h("input", { type: "text", id: "pin-edit", inputmode: "numeric", maxlength: "4", autocomplete: "off", "aria-label": "New 4-digit PIN for " + p.name, style: "width:90px" });
      actions = h("form", { class: "form", onsubmit: function (ev) {
        ev.preventDefault();
        if (!/^[0-9]{4}$/.test(pin.value)) { toast(ERR.bad_pin); return; }
        S.pinEdit = null; saveEntry("people", p.id, null, null, "New PIN saved for " + p.name, { p_pin: pin.value });
      } }, pin, h("button", { class: "btn small primary", type: "submit" }, "Save PIN"),
        h("button", { class: "btn small", type: "button", onclick: function () { S.pinEdit = null; renderPeople(); } }, "Cancel"));
      setTimeout(function () { pin.focus(); }, 0);
    } else if (S.rateEdit === p.id) {
      var inp = h("input", { type: "number", id: "rate-edit", inputmode: "decimal", min: "0", max: "999.99", step: "0.01", placeholder: "0.00", autocomplete: "off", "aria-label": "Hourly rate in dollars for " + p.name, value: rate == null ? "" : rate.toFixed(2) });
      actions = h("form", { class: "form", novalidate: true, onsubmit: function (ev) {
        ev.preventDefault();
        var raw = inp.value.trim(), n = Math.round(Number(raw) * 100) / 100;
        if (raw !== "" && (!isFinite(n) || n < 0 || n > 999.99)) { toast("Enter dollars per hour from 0 to 999.99, or leave it blank for no rate."); return; }
        if (raw === "" && inp.validity && inp.validity.badInput) { toast("Enter dollars per hour from 0 to 999.99, or leave it blank for no rate."); return; }
        S.rateEdit = null; saveEntry("people", p.id, null, null, raw === "" ? "Rate cleared for " + p.name : "Rate saved for " + p.name, { p_rate: raw === "" ? -1 : n });
      } }, h("span", { class: "m-unit" }, "$"), inp, h("span", { class: "m-unit" }, "/hr"),
        h("button", { class: "btn small primary", type: "submit" }, "Save rate"),
        h("button", { class: "btn small", type: "button", onclick: function () { S.rateEdit = null; renderPeople(); } }, "Cancel"),
        h("span", { class: "muted m-sub" }, "Leave blank for no rate."));
      setTimeout(function () { inp.focus(); inp.select(); }, 0);
    } else actions = [
      h("button", { class: "btn small", onclick: function () { S.rateEdit = p.id; S.pinEdit = S.confirmRemove = null; renderPeople(); } }, "Rate"),
      h("button", { class: "btn small", onclick: function () { S.pinEdit = p.id; S.rateEdit = S.confirmRemove = null; renderPeople(); } }, "New PIN"),
      h("button", { class: "btn small", onclick: function () { S.confirmRemove = key; S.pinEdit = S.rateEdit = null; renderPeople(); } }, k.removeLabel)];
    box.append(h("div", { class: "item", "data-id": p.id },
      h("div", { class: "main" }, h("strong", null, p.name),
        gone ? h("span", { class: "muted" }, k.gone) : rate == null ? h("span", { class: "muted" }, "No rate") : h("span", { class: "mono m-rate" }, money(rate) + "/hr")),
      h("div", { class: "actions" }, actions)));
  });
  fillSelect("missed-person", active(S.people));
}
function setJobSpot(j) {
  S.locBusy = j.id; S.locMsg = null; S.confirmRemove = null; renderJobs();
  getSpot().then(function (pt) {
    S.locBusy = null;
    if (!S.authed) return;
    if (!pt) {
      S.locMsg = { id: j.id, text: "Could not get your location. Allow location for this page in your phone's settings, step outside for a clear signal, then try again." };
      renderJobs(); return;
    }
    saveEntry("jobs", j.id, null, null, "Location saved for " + j.name + (pt.acc ? " (within about " + fmtDist(pt.acc) + ")" : ""),
      { p_lat: pt.lat, p_lng: pt.lng, p_radius: j.lat == null || j.lng == null ? RADIUS_DEFAULT : null }).then(function (ok) { if (!ok) renderJobs(); });
  });
}
function renderJobs() {
  var k = KIND.jobs, box = $("jobs"), all = sorted("jobs"), f = document.activeElement;
  if (f && f.dataset && f.dataset.radius) return; /* keep an open radius picker */
  box.replaceChildren();
  if (!all.length) box.append(h("div", { class: "empty" }, S.loaded ? k.empty : "Loading…"));
  all.forEach(function (j) {
    var gone = j.active === false, key = "jobs/" + j.id, locKey = "loc/" + j.id, has = j.lat != null && j.lng != null, actions, loc = null;
    if (gone) actions = h("button", { class: "btn small", onclick: function () { saveEntry("jobs", j.id, null, true, j.name + k.restored); } }, "Restore");
    else if (S.confirmRemove === key) actions = removeActions("jobs", j, renderJobs);
    else actions = h("button", { class: "btn small", onclick: function () { S.confirmRemove = key; renderJobs(); } }, k.removeLabel);
    if (!gone) {
      var busy = S.locBusy === j.id, radius = Number(j.radius) || RADIUS_DEFAULT, opts = RADII.slice(), sel = null;
      if (has) {
        if (!opts.some(function (o) { return o[0] === radius; })) { opts.push([radius, fmtDist(radius)]); opts.sort(function (a, b) { return a[0] - b[0]; }); }
        sel = h("select", { id: "radius-" + j.id, "data-radius": "1", "aria-label": "How close counts as at " + j.name, onchange: function () {
          var v = Number(sel.value); sel.blur();
          saveEntry("jobs", j.id, null, null, "Punches within " + radiusLabel(v) + " now count as at " + j.name, { p_radius: v });
        } }, opts.map(function (o) { return h("option", { value: o[0] }, o[1]); }));
        sel.value = String(radius);
      }
      loc = h("div", { class: "m-loc" },
        h("div", { class: "m-locline" },
          has ? [h("span", { class: "m-tag ok" }, "Location set"), h("a", { href: mapUrl(j.lat, j.lng), target: "_blank", rel: "noopener" }, "Map"),
            h("label", { class: "m-radius" }, h("span", { class: "muted" }, "At the job within"), sel)]
            : h("span", { class: "muted" }, "No location yet")),
        S.locMsg && S.locMsg.id === j.id && h("p", { class: "m-msg", role: "alert" }, S.locMsg.text),
        h("div", { class: "actions" },
          S.confirmRemove === locKey ? [h("span", { class: "muted" }, "Clear this job's location?"),
            h("button", { class: "btn small danger", onclick: function () { S.confirmRemove = null; saveEntry("jobs", j.id, null, null, "Location cleared for " + j.name, { p_radius: 0 }); } }, "Clear"),
            h("button", { class: "btn small", onclick: function () { S.confirmRemove = null; renderJobs(); } }, "Keep")]
            : [h("button", { class: "btn small", id: "setloc-" + j.id, disabled: busy || !!S.locBusy, onclick: function () { setJobSpot(j); } }, busy ? "Finding where you are…" : "Set to where I am now"),
              has && h("button", { class: "btn small", id: "clearloc-" + j.id, onclick: function () { S.confirmRemove = locKey; S.locMsg = null; renderJobs(); } }, "Clear location")]));
    }
    box.append(h("div", { class: "item", "data-id": j.id },
      h("div", { class: "main" }, h("strong", null, j.name), gone && h("span", { class: "muted" }, k.gone)),
      h("div", { class: "actions" }, actions), loc));
  });
  fillSelect("missed-job", active(S.jobs));
}

/* ---- settings ---- */
function settingsPreview() {
  var len = Number($("set-period").value) === 14 ? 14 : 7, anchor = $("set-anchor").value || null, R = periodRange(0, len, anchor), last = addDays(R.end, -1);
  var day = function (ms) { return new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); };
  var box = $("set-current"), split = new Date(R.start).getDay() !== 0;
  box.replaceChildren();
  add(box, [h("span", null, "Current pay period: ", h("strong", null, day(R.start) + " – " + day(last)), "."),
    split && h("span", { class: "m-tag", id: "set-split" }, "Does not start on a Sunday"),
    split && h("span", { class: "muted" }, "It cuts through a calendar week. Overtime is still counted per Sunday–Saturday week, only over the days inside each pay period.")]);
}
function renderSettings() {
  if (S.setDirty) return; /* keep unsaved choices */
  $("set-round").value = String(CFG.round); $("set-period").value = String(CFG.periodDays); $("set-anchor").value = CFG.periodAnchor || "";
  settingsPreview();
}

function renderAdmin() { renderBoard(); renderSheet(); renderLog(); renderPeople(); renderJobs(); renderSettings(); }
function setTab(name) {
  if (!$("panel-" + name) || !$("tab-" + name)) name = "timesheet";
  if (S.tab === "settings" && name !== "settings" && S.setDirty) { S.setDirty = false; renderSettings(); }
  S.tab = name;
  document.querySelectorAll(".tab").forEach(function (b) {
    var on = b.dataset.tab === name;
    b.setAttribute("aria-selected", on ? "true" : "false");
    $("panel-" + b.dataset.tab).hidden = !on;
  });
}


/* ---- manager wiring ---- */
$("setup-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var a = $("setup-pass").value, b = $("setup-pass2").value;
  if (a.length < 6) { toast(ERR.short); return; }
  if (a !== b) { toast("The two passcodes don't match."); return; }
  call("tc_setup", { p_pass: a }).then(function (res) {
    if (res.fail) { if (res.fail === "exists") { C.setup = true; show(); } return; }
    $("setup-pass").value = ""; $("setup-pass2").value = "";
    C.setup = true; S.pass = a; toast("Passcode saved."); reloadAdmin();
  });
});
$("login-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  S.pass = $("login-pass").value; $("login-pass").value = "";
  reloadAdmin();
});
$("pass-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var a = $("pass-new").value, b = $("pass-new2").value;
  if (a.length < 6) { toast(ERR.short); return; }
  if (a !== b) { toast("The two passcodes don't match."); return; }
  call("tc_admin_pass", { p_pass: S.pass, p_new: a }, "Wrong passcode.").then(function (res) {
    if (res.fail) return;
    S.pass = a; store("session", "tc_pass", a); $("pass-new").value = ""; $("pass-new2").value = ""; toast("Manager passcode changed.");
  });
});
$("people-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var name = $("people-name").value.trim().replace(/\s+/g, " "), pin = $("people-pin").value;
  if (!name) return;
  if (!/^[0-9]{4}$/.test(pin)) { toast(ERR.bad_pin); return; }
  if (S.people.some(function (p) { return p.active !== false && String(p.name).toLowerCase() === name.toLowerCase(); })) { toast(name + " is already on the crew."); return; }
  saveEntry("people", null, name, null, name + KIND.people.added, { p_pin: pin }).then(function (ok) { if (ok) { $("people-name").value = ""; $("people-pin").value = ""; } });
});
$("jobs-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var name = $("jobs-name").value.trim().replace(/\s+/g, " ");
  if (!name) return;
  if (S.jobs.some(function (p) { return p.active !== false && String(p.name).toLowerCase() === name.toLowerCase(); })) { toast(name + " is already a job."); return; }
  saveEntry("jobs", null, name, null, name + KIND.jobs.added).then(function (ok) { if (ok) $("jobs-name").value = ""; });
});
$("missed-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var who = $("missed-person").value, job = $("missed-job").value, a = fromInput($("missed-in").value), b = fromInput($("missed-out").value);
  var m = b == null ? 0 : Number($("missed-lunch").value) || 0;
  if (!who) { toast("Add a person first."); return; }
  if (!job) { toast("Add a job first."); return; }
  if (a == null) { toast("Enter a clock-in time."); return; }
  if (b != null && b <= a) { toast(ERR.bad_times); return; }
  if (b != null && m * MIN >= b - a) { toast(ERR.lunch_too_long); return; }
  adminDo("tc_admin_punch", { p_id: null, p_person: who, p_job: job, p_in: iso(a), p_out: iso(b), p_lunch: m, p_note: $("missed-note").value.trim().slice(0, 280) }, "Punch added").then(function (ok) {
    if (ok) { $("missed-in").value = ""; $("missed-out").value = ""; $("missed-lunch").value = "0"; $("missed-note").value = ""; $("missed").open = false; }
  });
});
document.querySelectorAll(".tab").forEach(function (b) { b.addEventListener("click", function () { setTab(b.dataset.tab); }); });
function page(n) { if (S.mode === "period") S.period += n; else S.week += n; showRange(); }
$("wk-prev").addEventListener("click", function () { page(-1); });
$("wk-next").addEventListener("click", function () { page(1); });
$("wk-now").addEventListener("click", function () { if (S.mode === "period") S.period = 0; else S.week = 0; showRange(); });
$("mode-week").addEventListener("click", function () { S.mode = "week"; showRange(); });
$("mode-period").addEventListener("click", function () { S.mode = "period"; showRange(); });
$("view-person").addEventListener("click", function () { S.view = "person"; renderSheet(); });
$("view-job").addEventListener("click", function () { S.view = "job"; renderSheet(); });
$("export").addEventListener("click", exportSheet);
["set-round", "set-period", "set-anchor"].forEach(function (id) {
  ["input", "change"].forEach(function (evName) { $(id).addEventListener(evName, function () { S.setDirty = true; settingsPreview(); }); });
});
$("settings-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var round = Number($("set-round").value), days = Number($("set-period").value), anchor = $("set-anchor").value || null;
  if ([0, 5, 6, 10, 15].indexOf(round) < 0 || (days !== 7 && days !== 14)) { toast(ERR.bad_value); return; }
  if (anchor && parseYmd(anchor) == null) { toast("Pick a date for the first day of a pay period."); return; }
  S.setDirty = false;
  adminDo("tc_admin_settings", { p_round: round, p_period_days: days, p_period_anchor: anchor }, "Settings saved").then(function (ok) { if (!ok) S.setDirty = true; });
});
$("more").addEventListener("click", function () { S.shown += 40; renderLog(); });
