// A simplified hot air balloon: one envelope of hot air, a burner, a vent,
// and layered winds. Units are SI throughout (metres, seconds, kelvin, kg).

export const G = 9.81;
export const R_AIR = 287.05;
export const CP_AIR = 1005;

export const BALLOON = {
  volume: 2550,          // m³, about 90,000 cubic feet
  structure: 380,        // kg: envelope, basket, burner, empty tanks
  fuelFull: 100,         // kg of propane at launch
  person: 80,            // kg per person aboard
  area: 230,             // m², envelope cross-section for drag
  dragCoef: 0.5,
  burnerPower: 3.0e6,    // W, one burner going
  burnerEfficiency: 0.6, // share of the heat that stays in the envelope
  fuelEnergy: 46.4e6,    // J per kg of propane
  coolRate: 0.0025,      // 1/s, heat lost through the fabric
  ventRate: 0.04,        // 1/s, extra loss with the vent held open
  maxTempC: 120,         // continuous envelope limit many flight manuals give
  neverExceedC: 127,
};

export const LAYERS = [
  { base: 0, top: 150 },
  { base: 150, top: 400 },
  { base: 400, top: 750 },
  { base: 750, top: 1200 },
  { base: 1200, top: 1800 },
];
export const CEILING = 1800;

// Standard lapse rate from a given ground temperature, sea-level pressure.
export function atmosphere(h, groundTempC) {
  const T0 = groundTempC + 273.15;
  const T = T0 - 0.0065 * Math.max(0, h);
  const P = 101325 * Math.pow(T / T0, 5.2559);
  return { T, P, rho: P / (R_AIR * T) };
}

export function totalMass(people, fuel) {
  return BALLOON.structure + fuel + people * BALLOON.person;
}

// Inside temperature (K) at which the balloon floats level at height h.
export function equilibriumTemp(h, groundTempC, people, fuel = BALLOON.fuelFull) {
  const a = atmosphere(h, groundTempC);
  const rhoIn = a.rho - totalMass(people, fuel) / BALLOON.volume;
  if (rhoIn <= 0) return Infinity;
  return a.P / (R_AIR * rhoIn);
}

// Small seeded generator so a "morning" can be replayed.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Winds: each layer has a heading (degrees the air moves toward, clockwise
// from north) and a speed in m/s. Slow near the ground, faster and usually
// turning clockwise higher up.
export function makeMorning(seed) {
  const r = rng(seed);
  let heading = r() * 360;
  let speed = (4 + r() * 6) / 3.6;
  const winds = [];
  for (let i = 0; i < LAYERS.length; i++) {
    if (i > 0) {
      const turn = 20 + r() * 40;
      heading += r() < 0.25 ? -turn : turn;
      speed += (2 + r() * 7) / 3.6;
    }
    winds.push({ ...LAYERS[i], heading: ((heading % 360) + 360) % 360, speed });
  }
  // Place the target by pretending to fly a plan: some minutes in one
  // layer, then some in another. That keeps it within reach.
  let target;
  for (let tries = 0; tries < 20; tries++) {
    const a = Math.floor(r() * 3);
    let b = Math.floor(r() * LAYERS.length);
    if (b === a) b = (b + 2) % LAYERS.length;
    const t1 = (6 + r() * 14) * 60;
    const t2 = (6 + r() * 14) * 60;
    const x = vec(winds[a]).x * t1 + vec(winds[b]).x * t2;
    const y = vec(winds[a]).y * t1 + vec(winds[b]).y * t2;
    target = { x, y };
    if (Math.hypot(x, y) > 3000) break;
  }
  return { seed, winds, target };
}

export function vec(w) {
  const rad = (w.heading * Math.PI) / 180;
  return { x: Math.sin(rad) * w.speed, y: Math.cos(rad) * w.speed };
}

// Wind vector at height h, blended over 80 m around each layer boundary.
export function windAt(winds, h) {
  const BLEND = 40;
  const hh = Math.min(Math.max(h, 0), CEILING);
  for (let i = 0; i < winds.length - 1; i++) {
    const edge = winds[i].top;
    if (hh < edge - BLEND) return vec(winds[i]);
    if (hh <= edge + BLEND) {
      const f = (hh - (edge - BLEND)) / (2 * BLEND);
      const a = vec(winds[i]), b = vec(winds[i + 1]);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  return vec(winds[winds.length - 1]);
}

export function newFlight(morning, { groundTempC = 12, people = 2 } = {}) {
  const fuel = BALLOON.fuelFull;
  // Start a few degrees short of lift-off, standing on the launch field.
  const Ti = equilibriumTemp(0, groundTempC, people, fuel) - 3;
  return {
    morning, groundTempC, people,
    t: 0, x: 0, y: 0, h: 0, v: 0, Ti, fuel,
    burner: false, vent: false, ventHeld: 0, maxVentHeld: 0,
    airborne: false, landed: false, touchdown: null,
    maxTempC: Ti - 273.15, overTemp: false,
    marker: null, track: [{ x: 0, y: 0, h: 0, t: 0 }],
    lastTrack: 0,
  };
}

// Advance the flight by dt seconds of flight time.
export function step(f, dt) {
  if (f.landed) return f;
  const B = BALLOON;
  const air = atmosphere(f.h, f.groundTempC);
  const burning = f.burner && f.fuel > 0;

  // Heat in, heat out.
  const mInside = (air.P / (R_AIR * f.Ti)) * B.volume;
  let dT = -B.coolRate * (f.Ti - air.T);
  if (burning) {
    dT += (B.burnerPower * B.burnerEfficiency) / (mInside * CP_AIR);
    f.fuel = Math.max(0, f.fuel - (B.burnerPower / B.fuelEnergy) * dt);
  }
  if (f.vent) {
    dT -= B.ventRate * (f.Ti - air.T);
    f.ventHeld += dt;
    f.maxVentHeld = Math.max(f.maxVentHeld, f.ventHeld);
  } else {
    f.ventHeld = 0;
  }
  f.Ti = Math.max(air.T, f.Ti + dT * dt);
  const tempC = f.Ti - 273.15;
  f.maxTempC = Math.max(f.maxTempC, tempC);
  if (tempC > B.maxTempC) f.overTemp = true;

  // Lift, weight, drag. The air inside, and some of the air pushed aside,
  // has to be moved along with the balloon, which is a big part of the lag.
  const rhoIn = air.P / (R_AIR * f.Ti);
  const mass = totalMass(f.people, f.fuel);
  const lift = (air.rho - rhoIn) * B.volume * G;
  const weight = mass * G;
  const drag = 0.5 * air.rho * B.dragCoef * B.area * f.v * Math.abs(f.v);
  const mEff = mass + rhoIn * B.volume + 0.5 * air.rho * B.volume;
  const accel = (lift - weight - drag) / mEff;

  if (!f.airborne) {
    if (lift > weight) f.airborne = true; else return f;
  }

  f.v += accel * dt;
  f.h += f.v * dt;
  if (f.h > CEILING + 600) { f.h = CEILING + 600; f.v = Math.min(f.v, 0); }

  const w = windAt(f.morning.winds, f.h);
  // Near the ground the basket drags a little behind the wind; ignore that.
  f.x += w.x * dt;
  f.y += w.y * dt;
  f.t += dt;

  if (f.h <= 0) {
    f.h = 0;
    f.touchdown = -f.v;
    f.v = 0;
    f.landed = true;
  }
  if (f.t - f.lastTrack >= 5 || f.landed) {
    f.track.push({ x: f.x, y: f.y, h: f.h, t: f.t });
    f.lastTrack = f.t;
  }
  return f;
}

// A pilot balloon: a small helium balloon that rises at a steady rate and
// drifts with each layer in turn, so its path shows the winds aloft.
export function pibalPath(morning, x0, y0, h0, rise = 3) {
  const pts = [{ x: x0, y: y0, h: h0 }];
  let x = x0, y = y0, h = h0;
  const dt = 5;
  while (h < CEILING) {
    const w = windAt(morning.winds, h);
    x += w.x * dt; y += w.y * dt; h += rise * dt;
    pts.push({ x, y, h });
  }
  return pts;
}

export function bearing(dx, dy) {
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
