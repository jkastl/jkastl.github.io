// Loads the engine the same way the page does: each file attaches to globalThis.AT.
const path = require('node:path');
for (const f of ['rng', 'data', 'guardrails', 'policy', 'router', 'tools', 'agents', 'runner', 'scenarios']) {
  require(path.join(__dirname, '..', 'js', 'engine', f + '.js'));
}
module.exports = globalThis.AT;
