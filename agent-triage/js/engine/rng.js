/* Seeded randomness and small helpers shared by the engine.
 *
 * Every engine file attaches to one global namespace, AT. The same files load as classic
 * <script> tags in the browser (so the page works from file://) and through require() in Node
 * for the tests, with no build step.
 */
(function (AT) {
  'use strict';

  // Mulberry32: small, fast, seedable. Same seed, same sequence, every run.
  AT.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // FNV-1a. Turns a scenario id or a typed request into a seed, so a given input always
  // replays with the same latencies and the same injected faults.
  AT.hashSeed = function (str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };

  // Rough token estimate (about 4 characters per token for English). Good enough to show
  // where a real system spends its context; not a real tokenizer.
  AT.tokens = (s) => Math.max(1, Math.ceil(String(s).length / 4));

  AT.between = (rand, lo, hi) => Math.round(lo + rand() * (hi - lo));

  const STOP = new Set(('a an and are as at be been but by can could do does for from get got has have hi ' +
    'hello i i\'m if in into is it it\'s its just me my need needs of on or our please since so ' +
    'some still thanks that the their them then there this to up us was we were what when with ' +
    'would you your keeps keep any all also been being').split(' '));

  // Lowercased content words, used by the router and the known-issue search.
  AT.words = function (text) {
    return String(text).toLowerCase().replace(/\[[a-z]+\]/g, ' ').match(/[a-z][a-z0-9'_-]*/g)?.filter((w) => !STOP.has(w)) || [];
  };
})(globalThis.AT = globalThis.AT || {});
