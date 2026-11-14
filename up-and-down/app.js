import {
  BALLOON, LAYERS, atmosphere, totalMass, equilibriumTemp,
  makeMorning, newFlight, step, pibalPath, bearing,
} from './sim.js';

const $ = (id) => document.getElementById(id);
const LOG_KEY = 'tidepool-up-and-down-log';
const DT = 0.1;
const HISTORY = 600; // seconds of flight shown on the height chart

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['paper', 'paper-2', 'ink', 'ink-soft', 'muted', 'rule', 'accent', 'wind', 'ok', 'hatch']) {
    colors[k] = cs.getPropertyValue('--' + k).trim();
  }
}
readColors();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); draw(); });

const FONT = getComputedStyle(document.body).fontFamily;

// ---------- state ----------
let morning, flight, pibal = null, paused = false, history = [];
let lastMsg = '', msgUntil = 0, logged = false;
const warned = {};

function start(seed) {
  morning = makeMorning(seed);
  flight = newFlight(morning, { groundTempC: +$('temp').value, people: +$('people').value });
  pibal = null;
  history = [{ t: 0, h: 0 }];
  logged = false;
  for (const k in warned) delete warned[k];
  paused = false;
  $('pause').firstChild.textContent = 'Pause';
  $('debrief').hidden = true;
  setControls(false, false);
  setStatus('Standing on the launch field. Hold the burner to lift off.');
  lockPreflight();
  draw();
}

function setStatus(text, alert = false, hold = 0) {
  const el = $('status');
  if (performance.now() < msgUntil && !alert) return;
  if (text !== lastMsg || el.classList.contains('alert') !== alert) {
    el.textContent = text;
    el.classList.toggle('alert', alert);
    lastMsg = text;
  }
  msgUntil = hold ? performance.now() + hold : 0;
}

function lockPreflight() {
  const flying = flight.airborne || flight.landed;
  $('temp').disabled = flying;
  $('people').disabled = flying;
}

// ---------- controls ----------
function setControls(burn, vent) {
  if (flight.landed) { burn = false; vent = false; }
  flight.burner = burn;
  flight.vent = vent;
  for (const [id, on] of [['burn', burn], ['vent', vent]]) {
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-pressed', String(on));
  }
}

function holdButton(id, key) {
  const el = $(id);
  const set = (on) => setControls(key === 'burn' ? on : flight.burner, key === 'vent' ? on : flight.vent);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture?.(e.pointerId); set(true); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, () => set(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // Keyboard users: Enter or Space on the focused button toggles for one second.
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); set(true); }
  });
  el.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); set(false); }
  });
}
holdButton('burn', 'burn');
holdButton('vent', 'vent');

function typing(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
}
document.addEventListener('keydown', (e) => {
  if (typing(e) || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); setControls(true, flight.vent); }
  else if (k === 'v') setControls(flight.burner, true);
  else if (k === 'm') dropMarker();
  else if (k === 'p') togglePause();
});
document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  // Keep Space from also pressing whichever button has focus.
  if (k === ' ' && !typing(e)) { e.preventDefault(); setControls(false, flight.vent); }
  else if (k === ' ') setControls(false, flight.vent);
  else if (k === 'v') setControls(flight.burner, false);
});
window.addEventListener('blur', () => setControls(false, false));

function dropMarker() {
  if (flight.marker || !flight.airborne || flight.landed) {
    if (!flight.airborne) setStatus('The marker can only be dropped in flight.', false, 2500);
    return;
  }
  const t = morning.target;
  flight.marker = { x: flight.x, y: flight.y, dist: Math.hypot(flight.x - t.x, flight.y - t.y) };
  setStatus(`Marker dropped ${fmtDist(flight.marker.dist)} from the target.`, false, 4000);
  draw();
}
$('drop').addEventListener('click', dropMarker);

function togglePause() {
  if (flight.landed) return;
  paused = !paused;
  $('pause').firstChild.textContent = paused ? 'Resume' : 'Pause';
  if (paused) { setControls(false, false); setStatus('Paused.'); }
}
$('pause').addEventListener('click', togglePause);

$('temp').addEventListener('input', () => {
  $('tempOut').textContent = $('temp').value + ' °C';
  if (!flight.airborne) start(morning.seed);
});
$('people').addEventListener('change', () => { if (!flight.airborne) start(morning.seed); });
$('seed').addEventListener('change', () => {
  const s = Math.max(1, Math.min(99999, Math.round(+$('seed').value) || 1));
  $('seed').value = s;
  start(s);
});
function newMorning() {
  const s = 1 + Math.floor(Math.random() * 99999);
  $('seed').value = s;
  start(s);
}
$('newMorning').addEventListener('click', newMorning);
$('again').addEventListener('click', () => start(morning.seed));
$('again2').addEventListener('click', newMorning);
$('pibal').addEventListener('click', () => {
  pibal = pibalPath(morning, flight.x, flight.y, flight.h);
  setStatus('Pilot balloon away. Its dotted path on the map shows the winds above you.', false, 4000);
  draw();
});
$('showWinds').addEventListener('change', draw);

// ---------- loop ----------
let lastFrame = performance.now();
let acc = 0;
function frame(now) {
  const elapsed = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!paused && !flight.landed) {
    acc += elapsed * +$('speed').value;
    const wasAirborne = flight.airborne;
    while (acc >= DT) {
      step(flight, DT);
      acc -= DT;
      if (flight.airborne && flight.t - history[history.length - 1].t >= 2) history.push({ t: flight.t, h: flight.h });
      if (flight.landed) break;
    }
    if (history.length > 2000) history = history.slice(-1500);
    if (!wasAirborne && flight.airborne) { setStatus('Lift-off.', false, 2500); lockPreflight(); }
    checkWarnings();
    if (flight.landed) land();
  }
  draw();
  requestAnimationFrame(frame);
}

function checkWarnings() {
  const tempC = flight.Ti - 273.15;
  if (tempC > BALLOON.neverExceedC) setStatus(`Envelope at ${tempC.toFixed(0)} °C, past the never-exceed figure. Stop burning.`, true);
  else if (tempC > BALLOON.maxTempC) setStatus(`Envelope at ${tempC.toFixed(0)} °C, over the 120 °C continuous limit.`, true);
  else if (flight.vent && flight.ventHeld > 3) setStatus('Vent held open over 3 seconds. Manuals say to pull it in short bursts.', true);
  else if (flight.fuel <= 0 && !warned.empty) { warned.empty = true; setStatus('Out of propane. The burner does nothing now; the balloon will cool and come down.', true, 6000); }
  else if (flight.fuel < BALLOON.fuelFull * 0.15 && !warned.low) { warned.low = true; setStatus('Fuel under 15%. Time to look for a field.', true, 5000); }
  else if (flight.airborne && !flight.landed && performance.now() >= msgUntil) {
    setStatus(flight.marker ? 'Marker away. Find somewhere to land.' : 'Flying. Pick the layer that drifts toward the target.');
  }
}

function land() {
  setControls(false, false);
  const td = flight.touchdown;
  const feel = td < 1.5 ? 'soft' : td < 3 ? 'firm' : 'hard';
  const rows = [
    ['Flight time', fmtTime(flight.t)],
    ['Marker', flight.marker ? `${fmtDist(flight.marker.dist)} from the target` : 'not dropped'],
    ['Touchdown', `${td.toFixed(1)} m/s, ${feel}`],
    ['Fuel left', `${Math.round((flight.fuel / BALLOON.fuelFull) * 100)}%`],
    ['Hottest envelope', `${flight.maxTempC.toFixed(0)} °C${flight.overTemp ? ', over the 120 °C limit' : ''}`],
    ['Longest vent pull', `${flight.maxVentHeld.toFixed(1)} s${flight.maxVentHeld > 3 ? ', over 3 s' : ''}`],
    ['Landed', `${fmtDist(Math.hypot(flight.x, flight.y))} from launch`],
  ];
  const dl = $('debriefList');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  $('debrief').hidden = false;
  setStatus(`Landed, ${feel}.`, td >= 3);
  if (!logged) {
    logged = true;
    addLog({
      date: new Date().toLocaleDateString('en-CA'),
      morning: morning.seed,
      groundTempC: flight.groundTempC,
      people: flight.people,
      time: Math.round(flight.t),
      marker: flight.marker ? Math.round(flight.marker.dist) : null,
      touchdown: +td.toFixed(2),
      fuel: Math.round((flight.fuel / BALLOON.fuelFull) * 100),
    });
  }
}

// ---------- formatting ----------
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`; }
function fmtTime(s) { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

// ---------- gauges ----------
function gauges() {
  const f = flight;
  $('gAlt').textContent = `${Math.round(f.h)} m`;
  $('gAltFt').textContent = `${Math.round(f.h * 3.281)} ft above the field`;
  const v = f.v;
  $('gVario').textContent = `${v >= 0.05 ? '+' : v <= -0.05 ? '−' : ''}${Math.abs(v).toFixed(1)} m/s`;
  $('gVarioS').textContent = f.landed ? 'landed' : !f.airborne ? 'on the field' : v > 0.3 ? 'climbing' : v < -0.3 ? 'sinking' : 'about level';
  const tempC = f.Ti - 273.15;
  $('gTemp').textContent = `${Math.round(tempC)} °C`;
  $('gTempBar').style.width = `${Math.min(100, Math.max(0, tempC / 150 * 100))}%`;
  $('gTempMark').style.left = `${BALLOON.maxTempC / 150 * 100}%`;
  $('gTempBox').classList.toggle('warn', tempC > BALLOON.maxTempC);
  const fuelPct = (f.fuel / BALLOON.fuelFull) * 100;
  $('gFuel').textContent = `${Math.round(fuelPct)}%`;
  $('gFuelBar').style.width = `${fuelPct}%`;
  $('gFuelBox').classList.toggle('warn', fuelPct < 15);
  if (f.airborne && !f.landed) {
    const w = windAtFlight();
    const sp = Math.hypot(w.x, w.y);
    $('gDrift').textContent = `${(sp * 3.6).toFixed(0)} km/h`;
    $('gDriftS').textContent = `toward ${compass(bearing(w.x, w.y))}`;
  } else {
    $('gDrift').textContent = '0 km/h';
    $('gDriftS').textContent = f.landed ? 'landed' : 'tied down on the field';
  }
  const dx = morning.target.x - f.x, dy = morning.target.y - f.y;
  $('gTarget').textContent = fmtDist(Math.hypot(dx, dy));
  $('gTargetS').textContent = `lies ${compass(bearing(dx, dy))}`;
  $('gTime').textContent = fmtTime(f.t);
  $('gMarker').textContent = f.marker ? fmtDist(f.marker.dist) : 'aboard';
  $('gMarkerS').textContent = f.marker ? 'from the target' : 'drop it over the target';
  $('drop').disabled = !!f.marker || !f.airborne || f.landed;
  $('pause').disabled = f.landed;
}

function windAtFlight() {
  // Same blend the model uses, looked up from the last two track samples.
  const n = flight.track.length;
  if (n >= 2) {
    const a = flight.track[n - 2], b = flight.track[n - 1];
    const dt = b.t - a.t;
    if (dt > 0) return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }
  return { x: 0, y: 0 };
}

// ---------- drawing ----------
function setup(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W: r.width, H: r.height };
}

function draw() {
  if (!flight) return;
  drawMap();
  drawAlt();
  gauges();
}

function hatch(ctx, x, y, w, h, gap, color) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -h; i < w; i += gap) { ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y); }
  ctx.stroke();
  ctx.restore();
}

function drawMap() {
  const { ctx, W, H } = setup($('map'));
  ctx.clearRect(0, 0, W, H);
  const f = flight, t = morning.target;
  const pts = [{ x: 0, y: 0 }, t, { x: f.x, y: f.y }];
  if (pibal) pts.push(pibal[pibal.length - 1]);
  let minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  let minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  let span = Math.max(maxX - minX, maxY - minY, 6000) * 1.3;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const scale = Math.min(W, H) / span;
  const X = (x) => W / 2 + (x - cx) * scale;
  const Y = (y) => H / 2 - (y - cy) * scale;

  // Grid, one line per kilometre.
  ctx.strokeStyle = colors.rule; ctx.lineWidth = 1;
  ctx.beginPath();
  const x0 = Math.floor((cx - span) / 1000) * 1000, x1 = cx + span;
  for (let x = x0; x <= x1; x += 1000) { ctx.moveTo(X(x), 0); ctx.lineTo(X(x), H); }
  const y0 = Math.floor((cy - span) / 1000) * 1000, y1 = cy + span;
  for (let y = y0; y <= y1; y += 1000) { ctx.moveTo(0, Y(y)); ctx.lineTo(W, Y(y)); }
  ctx.stroke();

  // North mark and scale bar.
  ctx.fillStyle = colors.ink; ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.5;
  ctx.font = `16px ${FONT}`; ctx.textAlign = 'center';
  ctx.beginPath(); ctx.moveTo(24, 44); ctx.lineTo(24, 18); ctx.moveTo(18, 26); ctx.lineTo(24, 16); ctx.lineTo(30, 26); ctx.stroke();
  ctx.fillText('N', 24, 60);
  const barM = span > 14000 ? 2000 : 1000;
  ctx.beginPath(); ctx.moveTo(14, H - 16); ctx.lineTo(14 + barM * scale, H - 16);
  ctx.moveTo(14, H - 21); ctx.lineTo(14, H - 11); ctx.moveTo(14 + barM * scale, H - 21); ctx.lineTo(14 + barM * scale, H - 11); ctx.stroke();
  ctx.font = `13px ${FONT}`; ctx.textAlign = 'left';
  ctx.fillText(`${barM / 1000} km`, 18 + barM * scale, H - 12);

  // Pilot balloon path.
  if (pibal) {
    ctx.strokeStyle = colors.wind; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
    ctx.beginPath();
    pibal.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = colors.wind; ctx.font = `13px ${FONT}`;
    let lastLabel = null;
    for (const L of LAYERS) {
      const p = pibal.find((q) => q.h >= (L.base + L.top) / 2);
      if (!p) continue;
      const px = X(p.x), py = Y(p.y);
      ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
      // Skip a label that would sit on top of the last one.
      if (!lastLabel || Math.hypot(px - lastLabel.x, py - lastLabel.y) > 26) {
        ctx.fillText(`${Math.round((L.base + L.top) / 2)} m`, px + 5, py - 4);
        lastLabel = { x: px, y: py };
      }
    }
  }

  // Launch field.
  ctx.strokeStyle = colors.ink; ctx.fillStyle = colors.ink; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(X(0), Y(0), 6, 0, Math.PI * 2); ctx.stroke();
  ctx.font = `italic 14px ${FONT}`; ctx.textAlign = 'left';
  ctx.fillText('Launch', X(0) + 9, Y(0) + 15);

  // Target.
  ctx.strokeStyle = colors.accent; ctx.fillStyle = colors.accent; ctx.lineWidth = 2;
  const tx = X(t.x), ty = Y(t.y);
  ctx.beginPath(); ctx.arc(tx, ty, 10, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(tx - 15, ty); ctx.lineTo(tx + 15, ty); ctx.moveTo(tx, ty - 15); ctx.lineTo(tx, ty + 15); ctx.stroke();
  const left = tx > W - 70;
  ctx.textAlign = left ? 'right' : 'left';
  ctx.fillText('Target', tx + (left ? -14 : 14), ty < 24 ? ty + 26 : ty - 12);
  ctx.textAlign = 'left';

  // Track.
  const tr = f.track.concat([{ x: f.x, y: f.y }]);
  ctx.strokeStyle = colors.ink; ctx.lineWidth = 2;
  ctx.beginPath();
  tr.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
  ctx.stroke();

  // Marker.
  if (f.marker) {
    ctx.fillStyle = colors.accent;
    ctx.fillRect(X(f.marker.x) - 4, Y(f.marker.y) - 4, 8, 8);
    ctx.font = `13px ${FONT}`;
    ctx.fillText(fmtDist(f.marker.dist), X(f.marker.x) + 7, Y(f.marker.y) + 14);
  }

  // Balloon, seen from above.
  const bx = X(f.x), by = Y(f.y);
  ctx.fillStyle = colors.paper; ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(bx, by, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 4; i++) { const a = (i * Math.PI) / 4; ctx.moveTo(bx + Math.cos(a) * 9, by + Math.sin(a) * 9); ctx.lineTo(bx - Math.cos(a) * 9, by - Math.sin(a) * 9); }
  ctx.stroke();
}

function arrow(ctx, x, y, headingDeg, len) {
  const a = (headingDeg * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const x1 = x - dx * len / 2, y1 = y - dy * len / 2, x2 = x + dx * len / 2, y2 = y + dy * len / 2;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  const hx = -dy, hy = dx, s = 5;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - dx * s * 1.6 + hx * s, y2 - dy * s * 1.6 + hy * s);
  ctx.lineTo(x2 - dx * s * 1.6 - hx * s, y2 - dy * s * 1.6 - hy * s);
  ctx.closePath(); ctx.fill();
}

function drawAlt() {
  const { ctx, W, H } = setup($('alt'));
  ctx.clearRect(0, 0, W, H);
  const top = 2000;
  const padL = 44, padB = 22, padT = 8;
  const windW = Math.min(118, W * 0.34);
  const plotW = W - padL - windW;
  const Yh = (h) => padT + (H - padT - padB) * (1 - h / top);
  const show = $('showWinds').checked;

  // Layer bands, hatched alternately.
  LAYERS.forEach((L, i) => {
    if (i % 2 === 0) hatch(ctx, padL, Yh(L.top), W - padL, Yh(L.base) - Yh(L.top), 7, colors.hatch);
    ctx.strokeStyle = colors.rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, Yh(L.top)); ctx.lineTo(W, Yh(L.top)); ctx.stroke();
  });

  // Axis.
  ctx.fillStyle = colors['ink-soft'];
  ctx.font = `12px ${FONT}`; ctx.textAlign = 'right';
  for (let h = 0; h <= top; h += 500) ctx.fillText(`${h} m`, padL - 5, Yh(h) + 4);
  ctx.strokeStyle = colors.ink; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.lineTo(padL + plotW, H - padB); ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillText('ten minutes ago', padL + 46, H - 6);
  ctx.fillText('now', padL + plotW - 12, H - 6);

  // Winds.
  ctx.textAlign = 'left';
  morning.winds.forEach((w) => {
    const yc = (Yh(w.base) + Yh(w.top)) / 2;
    const xc = padL + plotW + 22;
    if (show) {
      ctx.strokeStyle = colors.wind; ctx.fillStyle = colors.wind; ctx.lineWidth = 2;
      arrow(ctx, xc, yc, w.heading, Math.min(26, (Yh(w.base) - Yh(w.top)) * 0.8));
      ctx.font = `13px ${FONT}`;
      ctx.fillText(`${compass(w.heading)}`, xc + 18, yc - 2);
      ctx.fillText(`${Math.round(w.speed * 3.6)} km/h`, xc + 18, yc + 13);
    } else {
      ctx.fillStyle = colors.muted; ctx.font = `italic 13px ${FONT}`;
      ctx.fillText('hidden', xc - 4, yc + 4);
    }
  });

  // Height trace.
  const f = flight;
  const tNow = f.t, X = (t) => padL + plotW * (1 - (tNow - t) / HISTORY);
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, 0, plotW, H); ctx.clip();
  ctx.strokeStyle = colors.ink; ctx.lineWidth = 2;
  ctx.beginPath();
  const pts = history.filter((p) => p.t >= tNow - HISTORY - 4).concat([{ t: tNow, h: f.h }]);
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Yh(p.h)) : ctx.moveTo(X(p.t), Yh(p.h))));
  ctx.stroke();
  ctx.restore();

  // The balloon itself at "now".
  const bx = padL + plotW - 2, by = Yh(f.h);
  const r = 10;
  ctx.fillStyle = f.burner && f.fuel > 0 ? colors.accent : colors.paper;
  ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(bx, by - 2 * r);
  ctx.bezierCurveTo(bx + r * 1.5, by - 2 * r, bx + r * 1.2, by - r * 0.2, bx + r * 0.35, by + r * 0.3);
  ctx.lineTo(bx - r * 0.35, by + r * 0.3);
  ctx.bezierCurveTo(bx - r * 1.2, by - r * 0.2, bx - r * 1.5, by - 2 * r, bx, by - 2 * r);
  ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx, by - 2 * r); ctx.lineTo(bx, by + r * 0.3); ctx.stroke();
  ctx.fillStyle = colors.ink;
  ctx.fillRect(bx - 3, by + r * 0.55, 6, 5);
}

window.addEventListener('resize', draw);

// ---------- lift calculator ----------
function calc() {
  const t = +$('cTemp').value, p = +$('cPeople').value, h = +$('cAlt').value;
  $('cTempOut').textContent = `${t} °C`;
  $('cPeopleOut').textContent = String(p);
  $('cAltOut').textContent = `${h} m`;
  const a = atmosphere(h, t);
  const m = totalMass(p, BALLOON.fuelFull);
  const diff = m / BALLOON.volume;
  const rhoIn = a.rho - diff;
  const Ti = equilibriumTemp(h, t, p);
  const need = Ti - 273.15;
  $('cRhoOut').textContent = `${a.rho.toFixed(3)} kg/m³ at ${(a.T - 273.15).toFixed(0)} °C`;
  $('cMass').textContent = `${m} kg`;
  $('cDiff').textContent = `${diff.toFixed(3)} kg/m³`;
  $('cRhoIn').textContent = `${rhoIn.toFixed(3)} kg/m³`;
  $('cAirMass').textContent = `${Math.round(rhoIn * BALLOON.volume).toLocaleString('en-US')} kg`;
  $('cNeed').textContent = `About ${need.toFixed(0)} °C inside to float`;
  $('cBar').style.width = `${Math.min(100, Math.max(0, need / 150 * 100))}%`;
  $('cMark').style.left = `${BALLOON.maxTempC / 150 * 100}%`;
  const margin = BALLOON.maxTempC - need;
  $('cSay').textContent = margin < 0
    ? 'That is over the 120 °C continuous limit, so this balloon could not carry this load on a day like this. Fewer people, or a cooler morning.'
    : margin < 15
      ? `Only about ${margin.toFixed(0)} °C below the limit, which leaves little room to climb. Hot days and heavy loads squeeze this.`
      : `About ${margin.toFixed(0)} °C below the limit, which leaves room to heat up and climb.`;
}
for (const id of ['cTemp', 'cPeople', 'cAlt']) $(id).addEventListener('input', calc);

// ---------- logbook ----------
function readLog() {
  try { const v = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeLog(list) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-50))); return true; } catch { return false; }
}
function addLog(entry) {
  const list = readLog(); list.push(entry);
  if (!writeLog(list)) $('logMsg').textContent = 'This browser would not save the logbook.';
  renderLog();
}
function validEntry(e) {
  return e && typeof e === 'object' && typeof e.date === 'string' && Number.isFinite(e.morning)
    && Number.isFinite(e.time) && Number.isFinite(e.touchdown) && Number.isFinite(e.fuel)
    && (e.marker === null || Number.isFinite(e.marker));
}
function renderLog() {
  const body = $('logBody');
  const list = readLog().slice().reverse();
  body.replaceChildren();
  if (!list.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 6; td.textContent = 'No flights yet.'; tr.append(td); body.append(tr); return;
  }
  for (const e of list) {
    const tr = document.createElement('tr');
    for (const v of [e.date, `no. ${e.morning}`, fmtTime(e.time), e.marker === null ? '—' : fmtDist(e.marker), `${(+e.touchdown).toFixed(1)} m/s`, `${e.fuel}%`]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    body.append(tr);
  }
}
$('logExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(readLog(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'balloon-logbook.json';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('logMsg').textContent = 'Logbook exported.';
});
$('logImport').addEventListener('click', () => $('logFile').click());
$('logFile').addEventListener('change', async () => {
  const file = $('logFile').files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error('not a list');
    const good = data.filter(validEntry);
    writeLog(readLog().concat(good));
    renderLog();
    $('logMsg').textContent = `Imported ${good.length} flight${good.length === 1 ? '' : 's'}${good.length < data.length ? ` (skipped ${data.length - good.length} that did not look like logbook entries)` : ''}.`;
  } catch {
    $('logMsg').textContent = 'That file did not look like an exported logbook.';
  }
  $('logFile').value = '';
});
$('logClear').addEventListener('click', () => {
  if (!readLog().length) return;
  if (!confirm('Clear every flight from the logbook?')) return;
  writeLog([]);
  renderLog();
  $('logMsg').textContent = 'Logbook cleared.';
});

// ---------- go ----------
$('tempOut').textContent = $('temp').value + ' °C';
renderLog();
calc();
start(1 + Math.floor(Math.random() * 99999));
$('seed').value = morning.seed;
requestAnimationFrame(frame);
