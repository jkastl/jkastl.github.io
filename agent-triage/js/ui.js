/* The page: scenario picker, playback, trace, metrics and the approval card.
 *
 * All the simulation lives in js/engine/. This file only pulls events from AT.run() one at a time
 * and draws them. Playback speed changes how fast events are shown, never what they are.
 */
(function (AT) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs, ...kids) => {
    const [name, ...cls] = tag.split('.');
    const el = document.createElement(name);
    if (cls.length) el.className = cls.join(' ');
    for (const k in attrs || {}) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const ACTORS = {
    intake: 'Intake', guardrails: 'Guardrails', router: 'Router', access: 'Data access agent',
    onboard: 'Onboarding agent', triage: 'Triage agent', gate: 'Write gate', human: 'Human', runner: 'Runner',
  };
  const TYPES = {
    intake: 'Intake', guardrail: 'Guardrail', decision: 'Decision', handoff: 'Handoff', tool_call: 'Tool call',
    tool_result: 'Result', tool_error: 'Error', retry: 'Retry', gate: 'Gate', approval_request: 'Needs approval',
    approval: 'Approval', outcome: 'Outcome',
  };
  const ROLES = { analyst: 'analyst', data_scientist: 'data scientist', data_engineer: 'data engineer', contractor: 'contractor', manager: 'manager', data_owner: 'data owner' };

  const S = {
    scenario: null, custom: false, speed: 1,
    it: null, events: [], visited: new Set(), waiting: null, done: false, playing: false, timer: 0,
  };

  // ---------------------------------------------------------------- setup
  function init() {
    const sel = $('scenario');
    const groups = { core: 'Core scenarios', edge: 'Edge cases' };
    let n = 0;
    for (const [g, label] of Object.entries(groups)) {
      sel.append(h('optgroup', { label }, AT.scenarios.filter((s) => s.group === g).map((s) => h('option', { value: s.id }, `${++n}. ${s.title}`))));
    }
    sel.append(h('optgroup', { label: 'Yours' }, h('option', { value: 'custom' }, 'Your own request')));
    sel.addEventListener('change', () => (sel.value === 'custom' ? goCustom(true) : load(sel.value)));

    $('requester').append(...Object.values(AT.data.people).map((p) =>
      h('option', { value: p.id }, `${p.name}, ${ROLES[p.role]}${p.status !== 'active' ? ' (not started)' : ''}`)));
    $('requester').addEventListener('change', () => goCustom());
    $('text').addEventListener('input', () => goCustom());

    $('run').addEventListener('click', () => (S.playing ? pause() : play()));
    $('step').addEventListener('click', () => { pause(); advance(); });
    $('reset').addEventListener('click', reset);
    for (const b of $('speed').querySelectorAll('button')) {
      b.addEventListener('click', () => {
        S.speed = Number(b.dataset.speed);
        for (const o of $('speed').querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
        if (S.playing) tick();
      });
    }
    $('expand').addEventListener('click', () => $('trace').querySelectorAll('details').forEach((d) => { d.open = true; }));
    $('collapse').addEventListener('click', () => $('trace').querySelectorAll('details').forEach((d) => { d.open = false; }));

    AT.diagram.mount($('diagram'));
    const fromHash = decodeURIComponent(location.hash.slice(1));
    load(AT.scenarios.some((s) => s.id === fromHash) ? fromHash : AT.scenarios[0].id, true);
  }

  function load(id, initial) {
    const s = AT.scenarios.find((x) => x.id === id);
    S.scenario = s;
    S.custom = false;
    $('scenario').value = s.id;
    $('requester').value = s.from;
    $('text').value = s.text;
    $('blurb').textContent = s.blurb;
    if (!initial) history.replaceState(null, '', '#' + s.id);
    reset();
  }

  // Editing the text or requester turns the scenario into the user's own request.
  function goCustom(fromSelect) {
    if (!S.custom) {
      S.custom = true;
      $('scenario').value = 'custom';
      $('blurb').textContent = 'Your own request. The same router, agents and guardrails handle it; if the router isn\'t sure, it comes to you.';
      history.replaceState(null, '', location.pathname + location.search);
      if (fromSelect) { $('text').value = ''; $('text').focus(); }
    }
    if (S.it) reset();
  }

  function request() {
    if (!S.custom) return AT.requestFor(S.scenario);
    const from = $('requester').value;
    const text = $('text').value.trim();
    return { id: 'REQ-' + AT.hashSeed(from + '|' + text).toString(36).slice(0, 5).toUpperCase(), from, channel: 'portal', subject: '', text };
  }

  // ---------------------------------------------------------------- playback
  function reset() {
    pause();
    Object.assign(S, { it: null, events: [], visited: new Set(), waiting: null, done: false });
    $('trace').replaceChildren();
    $('reply').replaceChildren(h('p.idle', {}, 'Appears when the run finishes.'));
    idleApproval();
    AT.diagram.highlight([], S.visited);
    renderMetrics();
    status('');
    buttons();
  }

  function start() {
    const req = request();
    if (!req.text) { status('Type a request first.'); $('text').focus(); return false; }
    reset();
    S.it = AT.run(req, { randomFaults: S.custom });
    return true;
  }

  // Pull one event from the engine. Returns false when there's nothing more to show right now.
  function advance(decision) {
    if (S.done || !S.it) { if (!start()) return false; }
    if (S.waiting && !decision) { status('Waiting for your decision in Human review.'); return false; }
    const step = decision ? S.it.next(decision) : S.it.next();
    S.waiting = null;
    if (step.done) { finish(); return false; }
    const ev = step.value;
    S.events.push(ev);
    for (const n of ev.nodes || []) S.visited.add(n);
    AT.diagram.highlight(ev.nodes || [], S.visited, ev.level);
    appendTrace(ev);
    renderMetrics();
    status(`${ACTORS[ev.actor] || ev.actor}: ${ev.title}`);
    if (ev.type === 'approval_request') {
      S.waiting = ev;
      showApproval(ev);
    }
    if (ev.type === 'outcome') {
      showReply(ev);
      S.it.next(); // let the generator return
      finish();
    }
    buttons();
    return true;
  }

  function finish() {
    S.done = true;
    pause();
    const m = AT.metrics(S.events);
    if (m.outcome) status(`Finished: ${AT.OUTCOMES[m.outcome].label}, ${(m.latencyMs / 1000).toFixed(2)} s of simulated time.`);
    buttons();
  }

  function play() {
    if (S.done || !S.it) { if (!start()) return; }
    S.playing = true;
    buttons();
    tick();
  }

  function pause() {
    S.playing = false;
    clearTimeout(S.timer);
    buttons();
  }

  function tick() {
    clearTimeout(S.timer);
    if (!S.playing) return;
    if (S.speed === 0) {
      while (S.playing && !S.waiting && !S.done && advance());
      return;
    }
    if (!advance() || S.waiting || S.done) return;
    // Longer steps (a 1.5 s timeout, a slow tool) take longer to show, within limits.
    const last = S.events[S.events.length - 1];
    const delay = Math.min(1400, Math.max(260, last.ms || 200)) / S.speed;
    S.timer = setTimeout(tick, delay);
  }

  function decide(d) {
    if (!S.waiting) return;
    idleApproval();
    advance(d);
    if (S.playing) tick();
  }

  function buttons() {
    $('run').textContent = S.playing ? '❚❚ Pause' : S.done ? '↻ Run again' : S.it ? '▶ Resume' : '▶ Run';
    $('step').disabled = !!S.waiting;
  }

  function status(text) { $('status').textContent = text; }

  // ---------------------------------------------------------------- rendering
  const sec = (ms) => '+' + (ms / 1000).toFixed(3) + 's';

  function json(obj) {
    const esc = JSON.stringify(obj, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return esc.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g, (m, str, colon, lit) => {
      if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
      if (lit) return `<span class="b">${lit}</span>`;
      return `<span class="n">${m}</span>`;
    });
  }

  function appendTrace(ev) {
    const body = h('div.body', {},
      ev.detail ? h('p', {}, ev.detail) : null,
      ev.tokens ? h('p.tok', {}, `Simulated tokens: ${ev.tokens.in.toLocaleString('en-US')} in, ${ev.tokens.out} out`) : null);
    if (ev.data) {
      const pre = h('pre.code.json');
      pre.innerHTML = json(ev.data);
      body.append(pre);
    }
    const d = h('details', {},
      h('summary', {},
        h('span.ts', {}, sec(ev.t)),
        h('span.ev.' + ev.type, {}, TYPES[ev.type] || ev.type),
        h('span.ti', {}, h('span.sr-only', {}, (ACTORS[ev.actor] || '') + ': '), ev.title),
        h('span.dur', {}, ev.ms ? ev.ms + ' ms' : '')),
      body);
    if (ev.type === 'approval_request' || ev.type === 'outcome') d.open = true;
    const li = h('li', { class: 'lv-' + ev.level + (reduced.matches ? '' : ' new') }, d);
    const list = $('trace');
    list.append(li);
    list.scrollTop = list.scrollHeight;
  }

  // Seconds for agent work, days once a person is involved.
  function duration(ms) {
    if (ms < 60000) return (ms / 1000).toFixed(2) + ' s';
    const days = ms / 86400000;
    return (Number.isInteger(Math.round(days * 10) / 10) ? Math.round(days) : days.toFixed(1)) + (days < 1.05 ? ' day' : ' days');
  }

  function renderMetrics() {
    const m = AT.metrics(S.events);
    const o = m.outcome ? AT.OUTCOMES[m.outcome] : null;
    const any = S.events.length > 0;
    const stat = (label, value, cls, note) => h('div', { class: 'stat' + (cls ? ' ' + cls : '') },
      h('span.stat-label', {}, label), h('span.stat-value', {}, value), note ? h('span.stat-note', {}, note) : null);
    $('metrics').replaceChildren(
      stat('Agent latency', any ? duration(m.latencyMs) : '–', null, 'simulated'),
      stat('Time to completion', any ? duration(m.completionMs) : '–', !o ? null : m.humanSteps ? 'warn' : 'good',
        any ? `${m.humanSteps} human step${m.humanSteps === 1 ? '' : 's'}` : 'incl. human steps'),
      stat('Tool calls', any ? String(m.toolCalls) : '–'),
      stat('Retries', any ? String(m.retries) : '–', m.retries ? 'warn' : null),
      stat('Guardrail hits', any ? String(m.interventions) : '–', m.interventions ? 'warn' : null),
      stat('Tokens', any ? m.tokens.toLocaleString('en-US') : '–', null, 'estimated'),
      stat('Outcome', o ? o.label : S.waiting ? 'Waiting on you' : S.it ? 'Running…' : '–', 'outcome ' + (o ? o.level : S.waiting ? 'warn' : '')),
    );
    renderEfficiency(m);
  }

  // One line that makes the point of automation: seconds when no person is needed, days when one is.
  function renderEfficiency(m) {
    const el = $('efficiency');
    const day = duration(AT.CONFIG.humanStepMs);
    if (S.waiting) {
      el.className = 'msg efficiency warn';
      el.textContent = `Waiting on a person. Each human step counts as ${day} of simulated time to completion.`;
    } else if (!m.outcome) {
      el.className = 'msg efficiency';
      el.textContent = `Time to completion counts each human step (an approval or a handoff to a person) as ${day}. Agent work takes seconds.`;
    } else if (m.humanSteps === 0) {
      el.className = 'msg efficiency good';
      el.textContent = `Closed in ${duration(m.completionMs)} with no human step. If a person had to review it, it would take about ${day}.`;
    } else {
      el.className = 'msg efficiency warn';
      const share = (100 * (1 - m.latencyMs / m.completionMs)).toFixed(m.latencyMs / m.completionMs < 0.001 ? 3 : 1);
      el.textContent = `${m.humanSteps} human step${m.humanSteps === 1 ? '' : 's'} × ${day} = ${duration(m.humanSteps * AT.CONFIG.humanStepMs)} of waiting. ` +
        `The agents' own work took ${duration(m.latencyMs)}, so ${share}% of the time to completion is waiting on people.`;
    }
  }

  function idleApproval() {
    $('hitl').classList.remove('waiting');
    $('hitl-body').replaceChildren(h('p.idle', {}, 'Nothing waiting. Low-confidence routes, high-risk writes and restricted data stop here for you to decide.'));
  }

  function showApproval(ev) {
    const pre = h('pre.code.json');
    pre.innerHTML = json(ev.data);
    const approve = h('button.btn.primary', { type: 'button', onclick: () => decide('approve') }, ev.approveLabel || 'Approve');
    const reject = h('button.btn.danger', { type: 'button', onclick: () => decide('reject') }, ev.rejectLabel || 'Reject');
    $('hitl').classList.add('waiting');
    $('hitl-body').replaceChildren(
      h('p.q', {}, h('strong', {}, ev.title + (/[?.]$/.test(ev.title) ? ' ' : '. ')), ev.detail),
      ev.approver ? h('p.as', {}, `Only this person can approve. You're deciding as ${ev.approver.name}, ${ev.approver.title}.`) : null,
      h('p.risk', {}, h('span', { class: 'tag ' + (ev.risk === 'high' ? 'bad' : 'warn') }, 'risk: ' + ev.risk)),
      pre,
      h('div.sim-ctl', { style: 'margin-top:.6rem' }, approve, reject));
    renderMetrics();
    status('Paused for human review. Approve or reject to continue.');
    // Bring the card into view (it sits further down on a phone) and put focus on it.
    const panel = $('hitl');
    const r = panel.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) panel.scrollIntoView({ block: 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' });
    approve.focus({ preventScroll: true });
  }

  function showReply(ev) {
    const o = AT.OUTCOMES[ev.data.outcome];
    const tagCls = { good: 'good', bad: 'bad', warn: 'warn', info: '' }[o.level];
    $('reply').replaceChildren(h('span', { class: 'tag ' + tagCls }, o.label), h('p.reply', {}, ev.detail));
  }

  init();
})(globalThis.AT = globalThis.AT || {});
