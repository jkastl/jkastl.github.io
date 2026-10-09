/* The router: decides which specialist agent gets a request, and how sure it is.
 *
 * In a real build this is an LLM call (a coordinator agent with a short list of sub-agents).
 * Here it's weighted phrase matching so every run is reproducible, but it has the same shape:
 * an intent, a confidence, a rationale, and the entities it pulled out. The confidence is what
 * matters downstream: below the threshold, a person decides instead.
 */
(function (AT) {
  'use strict';

  const INTENTS = ['data_access', 'onboarding', 'incident', 'out_of_scope'];

  // [phrase, weight]. Phrases are matched on word boundaries against the redacted text.
  const SIGNALS = {
    data_access: [
      ['need access', 3], ['request access', 3], ['get access', 3], ['access to', 2.5], ['read access', 3],
      ['access', 1], ['permission', 2], ['permissions', 2], ['dataset', 1.5], ['table', 1], ['data for', 1],
      ['query', 0.5], ['grant', 1], ['pull', 0.5], ['can i get', 1.5], ['can i see', 1.5], ['look at', 1],
    ],
    onboarding: [
      ['onboard', 3], ['onboarding', 3], ['new hire', 3], ['new analyst', 3], ['new starter', 3],
      ['joins', 2.5], ['joining', 2.5], ['start date', 2], ['starts on', 2], ['first day', 2.5],
      ['get them set up', 3], ['set up', 1.5], ['workspace', 1.5], ['usual training', 2], ['training', 1],
    ],
    incident: [
      ['not working', 3], ['broken', 2.5], ['error', 2], ['errors', 2], ['failing', 2.5], ['failed', 2],
      ['outage', 3], ['down', 1.5], ['stale', 2.5], ['delayed', 2.5], ['behind', 1.5], ['cancelled', 2],
      ['canceled', 2], ['crash', 2.5], ['crashes', 2.5], ['died', 2.5], ['restarts', 2], ['timeout', 1.5], ['slow', 1.5], ['missing', 1.5],
      ['wrong', 1.5], ['weird', 1], ['refresh', 1], ["won't", 1.5], ["isn't", 1], ['since monday', 1],
    ],
    out_of_scope: [
      ['flight', 3], ['hotel', 3], ['vacation', 3], ['pto', 3], ['payroll', 3], ['expense', 2.5],
      ['lunch', 3], ['weather', 3], ['joke', 3], ['parking', 3], ['laptop', 2], ['password reset', 2.5],
    ],
  };

  // Entity mentions are evidence too: naming a dataset leans toward an access request.
  const ENTITY_BONUS = { datasets: ['data_access', 2], services: ['incident', 1], people: ['onboarding', 1] };

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const has = (text, phrase) => new RegExp(`(^|[^a-z0-9])${esc(phrase)}([^a-z0-9]|$)`, 'i').test(text);

  // Longest alias first, and each span of text claims only one entity.
  function findEntities(text, requesterId) {
    const D = AT.data;
    const lower = text.toLowerCase();
    const pick = (table) => {
      const aliases = [];
      for (const [id, rec] of Object.entries(table)) for (const a of rec.aliases || []) aliases.push([a, id]);
      aliases.sort((a, b) => b[0].length - a[0].length);
      const hits = [];
      for (const [a, id] of aliases) if (has(lower, a) && !hits.includes(id)) hits.push(id);
      return hits;
    };
    const people = Object.values(D.people)
      .filter((p) => p.id !== requesterId && has(lower, p.name.toLowerCase()))
      .map((p) => p.id);
    return { datasets: pick(D.datasets), services: pick(D.services), people };
  }

  function classify(text, requesterId) {
    const lower = String(text).toLowerCase();
    const scores = Object.fromEntries(INTENTS.map((i) => [i, 0]));
    const evidence = [];
    for (const intent of INTENTS) {
      for (const [phrase, w] of SIGNALS[intent]) {
        if (has(lower, phrase)) { scores[intent] += w; evidence.push({ intent, signal: `"${phrase}"`, weight: w }); }
      }
    }
    const entities = findEntities(lower, requesterId);
    for (const [kind, [intent, w]] of Object.entries(ENTITY_BONUS)) {
      if (entities[kind].length) {
        scores[intent] += w;
        evidence.push({ intent, signal: `${kind.replace(/s$/, '')} ${entities[kind][0]}`, weight: w });
      }
    }

    const ranked = INTENTS.map((i) => [i, Math.round(scores[i] * 10) / 10]).sort((a, b) => b[1] - a[1]);
    const [[top, s1], [, s2]] = ranked;

    // Confidence = how much evidence there is × how clearly it points one way. Lots of signal
    // for two intents at once (or very little signal at all) both come out low.
    const amount = 1 - Math.exp(-s1 / 3);
    const separation = s1 > 0 ? (s1 - s2) / s1 : 0;
    const confidence = Math.round(amount * (0.55 + 0.45 * separation) * 100) / 100;
    const intent = s1 > 0 ? top : 'unknown';

    const forTop = evidence.filter((e) => e.intent === top).sort((a, b) => b.weight - a.weight).slice(0, 4);
    const rationale = s1 === 0
      ? 'No routing signals found in the request.'
      : `Strongest signals for ${top}: ${forTop.map((e) => `${e.signal} (+${e.weight})`).join(', ')}.` +
        (s2 > 0 ? ` Runner-up ${ranked[1][0]} scored ${s2}.` : '');

    return { intent, confidence, scores: Object.fromEntries(ranked), entities, rationale, evidence };
  }

  AT.router = { classify, findEntities, INTENTS, SIGNALS };
})(globalThis.AT = globalThis.AT || {});
