// A small rate model of the worm's gentle-touch circuit.
// Simplified on purpose: each cell is one number between 0 and 1, gap
// junctions pull neighbours toward each other, and chemical synapses push
// (or brake) the next cell. Weights are hand-picked, not measured.

export const CELLS = [
  { id: 'ALML', group: 'sensory', side: 'head', label: 'Touch cell, front left' },
  { id: 'ALMR', group: 'sensory', side: 'head', label: 'Touch cell, front right' },
  { id: 'AVM',  group: 'sensory', side: 'head', label: 'Touch cell, front belly' },
  { id: 'PLML', group: 'sensory', side: 'tail', label: 'Touch cell, rear left' },
  { id: 'PLMR', group: 'sensory', side: 'tail', label: 'Touch cell, rear right' },
  { id: 'AVD',  group: 'inter', side: 'back', label: 'Relay for head touch' },
  { id: 'AVA',  group: 'inter', side: 'back', label: 'Command cell: back up' },
  { id: 'PVC',  group: 'inter', side: 'fwd',  label: 'Relay for tail touch' },
  { id: 'AVB',  group: 'inter', side: 'fwd',  label: 'Command cell: go forward' },
  { id: 'A',    group: 'motor', side: 'back', label: 'A-type motor neurons (backward)' },
  { id: 'B',    group: 'motor', side: 'fwd',  label: 'B-type motor neurons (forward)' },
];

// kind: 'gap' (two-way coupling), 'exc' (push), 'inh' (brake)
export const LINKS = [
  { a: 'ALML', b: 'AVM', kind: 'gap', w: 0.5 },
  { a: 'ALMR', b: 'AVM', kind: 'gap', w: 0.5 },
  { a: 'AVM',  b: 'AVD', kind: 'gap', w: 0.6 },
  { a: 'ALML', b: 'AVD', kind: 'exc', w: 0.35 },
  { a: 'ALMR', b: 'AVD', kind: 'exc', w: 0.35 },
  { a: 'PLML', b: 'PVC', kind: 'gap', w: 0.6 },
  { a: 'PLMR', b: 'PVC', kind: 'gap', w: 0.6 },
  { a: 'AVD',  b: 'AVA', kind: 'exc', w: 1.4 },
  { a: 'AVA',  b: 'A',   kind: 'exc', w: 1.2 },
  { a: 'PVC',  b: 'AVB', kind: 'exc', w: 1.4 },
  { a: 'AVB',  b: 'B',   kind: 'exc', w: 1.2 },
  { a: 'AVA',  b: 'AVB', kind: 'inh', w: 0.9 },
  { a: 'AVB',  b: 'AVA', kind: 'inh', w: 0.5 },
  { a: 'ALML', b: 'PVC', kind: 'inh', w: 0.3 },
  { a: 'ALMR', b: 'PVC', kind: 'inh', w: 0.3 },
  { a: 'PLML', b: 'AVD', kind: 'inh', w: 0.3 },
  { a: 'PLMR', b: 'AVD', kind: 'inh', w: 0.3 },
];

const TONIC = { AVB: 0.3 };   // a gentle resting crawl forward
const TAU = 0.15;             // seconds
export const DT = 0.02;

const clip = (x) => Math.max(0, Math.min(1, x));

export function initState() {
  const s = {};
  for (const c of CELLS) s[c.id] = 0;
  return s;
}

// One time step. touch: 'head' | 'tail' | null. dead: Set of ids.
export function step(state, touch, dead) {
  const input = {};
  for (const c of CELLS) {
    input[c.id] = TONIC[c.id] || 0;
    if (touch && c.group === 'sensory' && c.side === touch) input[c.id] += 1;
  }
  for (const l of LINKS) {
    if (dead.has(l.a) || dead.has(l.b)) continue;
    const pa = state[l.a], pb = state[l.b];
    if (l.kind === 'gap') {
      input[l.b] += l.w * (pa - pb);
      input[l.a] += l.w * (pb - pa);
    } else if (l.kind === 'exc') {
      input[l.b] += l.w * pa;
    } else {
      input[l.b] -= l.w * pa;
    }
  }
  const next = {};
  for (const c of CELLS) {
    if (dead.has(c.id)) { next[c.id] = 0; continue; }
    const s = state[c.id];
    next[c.id] = s + (DT / TAU) * (clip(input[c.id]) - s);
  }
  return next;
}

// Settle at rest, then touch for `touchSecs`, then let go.
// Returns the trace and a verdict.
export function trial(touch, dead, touchSecs = 1.2, afterSecs = 1.0) {
  let s = initState();
  for (let i = 0; i < 100; i++) s = step(s, null, dead);
  const rest = { ...s };
  const trace = [];
  const n1 = Math.round(touchSecs / DT), n2 = Math.round(afterSecs / DT);
  let peakA = rest.A, peakB = rest.B;
  for (let i = 0; i < n1 + n2; i++) {
    s = step(s, i < n1 ? touch : null, dead);
    trace.push(s);
    peakA = Math.max(peakA, s.A);
    peakB = Math.max(peakB, s.B);
  }
  return { rest, trace, peakA, peakB, verdict: classify(rest, peakA, peakB) };
}

export function classify(rest, peakA, peakB) {
  const backUp = peakA - rest.A;
  const speedUp = peakB - rest.B;
  if (backUp > 0.45) return 'back';
  if (backUp > 0.15) return 'weak-back';
  if (speedUp > 0.2) return 'forward';
  if (speedUp > 0.08) return 'weak-forward';
  return 'none';
}

export const VERDICTS = {
  'back': 'Backs up',
  'weak-back': 'Hesitates, a weak back-up',
  'forward': 'Speeds forward',
  'weak-forward': 'A weak speed-up',
  'none': 'No response',
};
