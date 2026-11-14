// Plate 1: one question through three assemblies of the same parts.
// Times are minutes after midnight on the day of the failure; the timeline
// runs from 06:00 to 06:00 the next morning (360 to 1800).

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") n.textContent = v; else n.setAttribute(k, v);
  }
  parent.append(n);
  return n;
}
const hhmm = (m) => {
  const d = ((Math.round(m) % 1440) + 1440) % 1440;
  return String(Math.floor(d / 60)).padStart(2, "0") + ":" + String(d % 60).padStart(2, "0");
};
const span = (m) => {
  const h = Math.floor(m / 60), mm = Math.round(m % 60);
  return h ? `${h} h ${String(mm).padStart(2, "0")} min` : `${mm} min`;
};
const onTimeline = (m) => (m < 360 ? m + 1440 : m);

const NIGHTLY_AT = 26 * 60, JOB_MIN = 30, RETRY_MIN = 30;
const STREAM_LAG = 2;
const OPEN = 7 * 60, CLOSE = 19 * 60, OUTAGE_MIN = 120;

function model({ failAt, outage, outAt, refresh }) {
  const outStart = onTimeline(outAt);
  const outEnd = outStart + OUTAGE_MIN;
  const down = (t) => outage && t >= outStart && t < outEnd;

  // Nightly copy: the 02:00 run needs the LIS when it starts.
  let start = NIGHTLY_AT;
  const tries = [start];
  while (down(start)) { start += RETRY_MIN; tries.push(start); }
  const nightly = {
    shown: start + JOB_MIN,
    runs: tries.map((t, i) => ({ t, ok: i === tries.length - 1 })),
    queries: tries.length,
    outageNote: outage && tries.length > 1
      ? `The 02:00 run cannot reach the LIS. It is retried every 30 minutes and succeeds at ${hhmm(start)}.`
      : "Nothing visible: the dashboard shows last night's copy all day anyway.",
  };

  // Stream: events flow from the scanners; stains come from an hourly copy of the LIS list.
  const stream = {
    shown: failAt + STREAM_LAG,
    queries: 24,
    outageNote: outage
      ? "Keeps showing new failures, with stains from its last good copy of the LIS list, up to about three hours old by the time the LIS is back."
      : "Nothing to report.",
  };

  // Virtual layer: every dashboard refresh asks the LIS and the image store.
  const every = 60 / refresh;
  const refreshes = [];
  for (let t = OPEN; t < CLOSE - 1e-9; t += every) refreshes.push(t);
  for (let t = OPEN + 1440; t < CLOSE + 1440 - 1e-9 && t < 1800; t += every) refreshes.push(t);
  const firstOk = refreshes.find((t) => t >= failAt && !down(t));
  const failed = refreshes.filter((t) => t < 1800 && down(t)).length;
  const virt = {
    shown: firstOk ?? null,
    refreshes: refreshes.filter((t) => t < 1800),
    queries: Math.round(refresh * ((CLOSE - OPEN) / 60)),
    failed,
    outageNote: !outage
      ? "Nothing to report."
      : failed
        ? `${failed} dashboard refresh${failed === 1 ? "" : "es"} fail${failed === 1 ? "s" : ""} with an error: every refresh needs the LIS, and there is no copy to fall back on.`
        : "The outage falls outside the hours the dashboard is used, so nobody sees it.",
  };
  return { outStart, outEnd, nightly, stream, virt };
}

function draw(state) {
  const m = model(state);
  const g = $("lanes");
  g.textContent = "";
  // Drawn at the plate's own width; on a phone the lane names move under the lines.
  const W = Math.max(300, Math.min(900, g.clientWidth || 900));
  const narrow = W < 600;
  const H = narrow ? 330 : 300;
  const LY = narrow ? [105, 195, 285] : [95, 170, 245];
  const x0 = narrow ? 14 : 160, x1 = W - (narrow ? 14 : 20);
  g.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const fs = narrow ? 12 : 13;
  const X = (t) => x0 + ((t - 360) / 1440) * (x1 - x0);
  const lanes = [
    { key: "nightly", name: "Nightly copy", y: LY[0] },
    { key: "stream", name: "Stream", y: LY[1] },
    { key: "virt", name: "Virtual layer", y: LY[2] },
  ];

  // hours
  for (let t = 360; t <= 1800; t += narrow ? 360 : 180) {
    svg("line", { x1: X(t), x2: X(t), y1: 40, y2: H - 14, stroke: "var(--rule)", "stroke-width": 1 }, g);
    svg("text", { x: X(t), y: 32, "text-anchor": t === 360 ? "start" : t === 1800 ? "end" : "middle", "font-size": narrow ? 12 : 14, text: hhmm(t) }, g);
  }
  svg("text", { x: X(1440), y: 16, "text-anchor": "middle", "font-size": 12, fill: "var(--muted)", text: "midnight" }, g);

  // outage band
  if (state.outage) {
    const a = Math.max(360, m.outStart), b = Math.min(1800, m.outEnd);
    if (b > a) {
      svg("rect", { x: X(a), y: 40, width: X(b) - X(a), height: H - 64, fill: "var(--red-soft)", stroke: "var(--red)", "stroke-dasharray": "4 3" }, g);
      svg("text", { x: Math.min(X(a), x1 - 70), y: H - 8, "font-size": 13, fill: "var(--red)", text: "LIS offline" }, g);
    }
  }

  // the failure
  const fx = X(state.failAt);
  svg("line", { x1: fx, x2: fx, y1: 40, y2: H - 14, stroke: "var(--ink)", "stroke-width": 2, "stroke-dasharray": "6 3" }, g);
  svg("text", { x: fx + 4, y: 54, "font-size": 13, text: `slide fails QC ${hhmm(state.failAt)}` }, g);

  for (const lane of lanes) {
    if (narrow) svg("text", { x: x0, y: lane.y + 24, "font-size": 13, "font-weight": 700, text: lane.name }, g);
    else svg("text", { x: 8, y: lane.y + 5, "font-size": 17, "font-weight": 700, text: lane.name }, g);
    svg("line", { x1: x0, x2: x1, y1: lane.y, y2: lane.y, stroke: "var(--ink)", "stroke-width": 1 }, g);
  }

  // nightly runs
  for (const r of m.nightly.runs) {
    svg("rect", { x: X(r.t), y: LY[0] - 9, width: Math.max(4, X(r.t + (r.ok ? JOB_MIN : 6)) - X(r.t)), height: 18, fill: r.ok ? "var(--ink)" : "var(--red)" }, g);
  }
  svg("text", { x: X(m.nightly.runs[0].t), y: LY[0] + 24, "text-anchor": "middle", "font-size": 12, fill: "var(--muted)", text: "nightly job" }, g);
  // virtual refresh ticks
  const down = (t) => state.outage && t >= m.outStart && t < m.outEnd;
  for (const t of m.virt.refreshes) {
    svg("line", { x1: X(t), x2: X(t), y1: LY[2] - 8, y2: LY[2] + 8, stroke: down(t) ? "var(--red)" : "var(--ink)", "stroke-width": down(t) ? 2 : 1 }, g);
  }
  // stream: always on
  svg("line", { x1: X(360), x2: X(1800), y1: LY[1], y2: LY[1], stroke: "var(--ink)", "stroke-width": 4, "stroke-dasharray": "2 4" }, g);

  // arrows from the failure to when it is shown
  const arrow = (y, to, label) => {
    if (to === null || to > 1800) {
      const late = fx > x0 + (x1 - x0) * 0.35;
      svg("text", { x: late ? fx - 6 : fx + 6, y: y - 12, "text-anchor": late ? "end" : "start", "font-size": fs, fill: "var(--red)", text: label }, g);
      return;
    }
    const tx = X(to);
    svg("path", { d: `M${fx} ${y - 18} H${tx}`, stroke: "var(--red)", "stroke-width": 2, fill: "none" }, g);
    svg("path", { d: `M${tx} ${y - 18} l-7 -5 v10 z`, fill: "var(--red)" }, g);
    svg("circle", { cx: tx, cy: y, r: 6, fill: "var(--paper)", stroke: "var(--red)", "stroke-width": 2.5 }, g);
    const right = tx > x1 - (narrow ? 120 : 220);
    svg("text", { x: right ? tx - 10 : tx + 10, y: y - 24, "text-anchor": right ? "end" : "start", "font-size": fs, "font-weight": 700, fill: "var(--red)", text: label }, g);
  };
  const lbl = (t) => narrow ? `${hhmm(t)}, +${span(t - state.failAt)}` : `shown ${hhmm(t)}, after ${span(t - state.failAt)}`;
  arrow(LY[0], m.nightly.shown, lbl(m.nightly.shown));
  arrow(LY[1], m.stream.shown, lbl(m.stream.shown));
  arrow(LY[2], m.virt.shown, m.virt.shown === null ? (narrow ? "next day, 07:00" : "next morning, 07:00 (off the chart)") : lbl(m.virt.shown));

  // the table
  const rows = [
    ["Nightly copy", "102 LIS + 101 image records → 202 SSIS or 401 Spark, started by 501 Airflow → 301 / 302 warehouse → 1001 / 1002 dashboard",
      `${hhmm(m.nightly.shown)} next morning (${span(m.nightly.shown - state.failAt)})`, m.nightly.outageNote, `${m.nightly.queries} (one big read)`, "1: the warehouse"],
    ["Stream", "101 scan events → 201 Kafka → 401 Spark Structured Streaming, joined to an hourly copy of 102 → warehouse table → 1004 Dash",
      `${hhmm(m.stream.shown)} (${span(m.stream.shown - state.failAt)})`, m.stream.outageNote, `${m.stream.queries} (hourly copy of the stain list)`, "2: the event log and the table"],
    ["Virtual layer", "102 LIS + 101 image records → 801 a virtual view → 1001 / 1002 dashboard",
      m.virt.shown === null ? "07:00 next morning, at the next refresh" : `${hhmm(m.virt.shown)} (${span(m.virt.shown - state.failAt)})`, m.virt.outageNote, `${m.virt.queries} (one per refresh)`, "0: reads the sources live"],
  ];
  const HEADS = ["Design", "Parts, in order", "Failure first shown", "During the outage", "Queries sent to the LIS a day", "Copies of the data"];
  const tb = $("compare");
  tb.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    r.forEach((v, i) => {
      const td = document.createElement(i === 0 ? "th" : "td");
      if (i === 0) td.scope = "row";
      td.textContent = v;
      td.dataset.label = HEADS[i];
      if (i === 1) td.className = "path";
      if (i === 4) td.className = "n";
      tr.append(td);
    });
    tb.append(tr);
  }
}

const state = {};
function read() {
  state.failAt = +$("failAt").value;
  state.outage = $("outage").checked;
  state.outAt = +$("outAt").value;
  state.refresh = +$("refresh").value;
  $("failAtV").textContent = hhmm(state.failAt);
  $("outAtV").textContent = `${hhmm(state.outAt)} to ${hhmm(state.outAt + OUTAGE_MIN)}`;
  $("refreshV").textContent = String(state.refresh);
  $("outAt").disabled = !state.outage;
  draw(state);
}
for (const id of ["failAt", "outage", "outAt", "refresh"]) $(id).addEventListener("input", read);
$("outage").addEventListener("change", read);
let wasNarrow = null;
window.addEventListener("resize", () => {
  const n = $("lanes").clientWidth < 600;
  if (n !== wasNarrow) { wasNarrow = n; draw(state); }
});
read();
