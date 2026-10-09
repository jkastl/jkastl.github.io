/* The architecture diagram: two inline SVG layouts (wide and phone) built from one node list.
 * CSS shows whichever fits. highlight() marks the active node(s) and everything visited so far.
 */
(function (AT) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    for (const kid of kids) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return el;
  };

  const BOXES = {
    intake: ['Intake', 'ticket + metadata'],
    guard: ['Input guardrails', 'PII · injection'],
    router: ['Router agent', 'intent + confidence'],
    access: ['Data access agent'],
    onboard: ['Onboarding agent'],
    triage: ['Triage agent'],
    gate: ['Write gate', 'policy re-check'],
    human: ['Human review', 'reviewer · data owner'],
    itsm: ['Ticketing (ITSM)', 'requests · incidents'],
    done: ['Outcome', 'reply to requester'],
  };
  const TOOLS_BY_AGENT = {
    access: ['lookup_dataset', 'check_existing_access', 'check_policy', 'create_ticket'],
    onboard: ['lookup_user', 'provision_workspace', 'assign_training'],
    triage: ['check_service_status', 'search_known_issues', 'escalate'],
  };

  // Each layout: viewBox, box positions [x, y, w, h], tool chip geometry, and which edges to draw.
  function wideLayout() {
    const n = {
      intake: [8, 160, 104, 60], guard: [134, 160, 116, 60], router: [272, 160, 118, 60],
      access: [420, 30, 138, 60], onboard: [420, 160, 138, 60], triage: [420, 290, 138, 60],
      gate: [800, 92, 118, 60], human: [800, 226, 118, 60], itsm: [948, 92, 128, 60], done: [948, 226, 128, 60],
    };
    const chips = {};
    const place = (agent, cy) => {
      const list = TOOLS_BY_AGENT[agent];
      const top = cy - (list.length * 26 - 4) / 2;
      list.forEach((t, i) => { chips[t] = [588, top + i * 26, 178, 22]; });
    };
    place('access', 60); place('onboard', 190); place('triage', 320);
    return { vb: '0 0 1084 372', n, chips, chipFont: 10.5, zone: [578, 2, 198, 368, 'TOOLS'] };
  }

  function narrowLayout() {
    const W = 114;
    const xs = [4, 123, 242];
    const n = {
      intake: [xs[0], 8, W, 54], guard: [xs[1], 8, W, 54], router: [xs[2], 8, W, 54],
      access: [xs[0], 96, W, 46], onboard: [xs[1], 96, W, 46], triage: [xs[2], 96, W, 46],
      gate: [xs[0], 300, W, 54], human: [xs[1], 300, W, 54], itsm: [xs[2], 300, W, 54],
      done: [xs[1], 384, W, 50],
    };
    const chips = {};
    ['access', 'onboard', 'triage'].forEach((a, col) => {
      TOOLS_BY_AGENT[a].forEach((t, i) => { chips[t] = [xs[col], 158 + i * 26, W, 21]; });
    });
    return { vb: '0 0 360 442', n, chips, chipFont: 8.2, narrow: true };
  }

  function edgePath(a, b, narrow) {
    const [ax, ay, aw, ah] = a;
    const [bx, by, bw, bh] = b;
    if (bx >= ax + aw - 1) {
      // left to right
      const x1 = ax + aw, y1 = ay + ah / 2, x2 = bx, y2 = by + bh / 2, mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }
    if (bx + bw <= ax + 1 && !narrow) {
      const x1 = ax, y1 = ay + ah / 2, x2 = bx + bw, y2 = by + bh / 2, mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }
    // top to bottom (or bottom to top)
    const down = by >= ay;
    const x1 = ax + aw / 2, y1 = down ? ay + ah : ay, x2 = bx + bw / 2, y2 = down ? by : by + bh, my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }

  function build(L) {
    const root = svg('svg', { viewBox: L.vb, class: L.narrow ? 'narrow' : 'wide', 'aria-hidden': 'true', focusable: 'false' });
    const all = { ...L.n };
    for (const [t, r] of Object.entries(L.chips)) all['tool:' + t] = r;
    const edges = [
      ['intake', 'guard'], ['guard', 'router'],
      ['router', 'access'], ['router', 'onboard'], ['router', 'triage'],
      ['gate', 'human'], ['gate', 'itsm', true], ['human', 'done', true], ['itsm', 'done', true],
    ];
    if (L.narrow) {
      // Agents to their first tool; the rest of the chips stack under it.
      for (const a of ['access', 'onboard', 'triage']) edges.push([a, 'tool:' + TOOLS_BY_AGENT[a][0]]);
      for (const a of ['access', 'onboard', 'triage']) {
        const list = TOOLS_BY_AGENT[a];
        edges.push(['tool:' + list[list.length - 1], 'gate', true]);
      }
      edges.splice(edges.findIndex((e) => e[0] === 'gate' && e[1] === 'human'), 1, ['gate', 'human']);
    } else {
      for (const a of Object.keys(TOOLS_BY_AGENT)) for (const t of TOOLS_BY_AGENT[a]) edges.push([a, 'tool:' + t]);
      for (const t of ['create_ticket', 'provision_workspace', 'assign_training', 'escalate']) edges.push(['tool:' + t, 'gate', true]);
    }

    const gEdges = svg('g', {});
    const edgeEls = [];
    for (const [a, b, dashed] of edges) {
      const p = svg('path', { d: edgePath(all[a], all[b], L.narrow), class: 'dg-edge' + (dashed ? ' dashed' : '') });
      p.dataset.a = a; p.dataset.b = b;
      edgeEls.push(p);
      gEdges.appendChild(p);
    }
    if (L.zone) {
      const [x, y, w, h, label] = L.zone;
      root.appendChild(svg('rect', { x, y, width: w, height: h, rx: 8, class: 'dg-zone' }));
      root.appendChild(svg('text', { x: x + 8, y: y + h - 6, class: 'dg-zone-l' }, label));
    }
    root.appendChild(gEdges);

    const nodeEls = {};
    for (const [id, [x, y, w, h]] of Object.entries(L.n)) {
      const [title, sub] = BOXES[id];
      const g = svg('g', { class: 'dg-node' });
      g.appendChild(svg('rect', { x, y, width: w, height: h, rx: 8 }));
      const cx = x + w / 2;
      if (sub) {
        g.appendChild(svg('text', { x: cx, y: y + h / 2 - 8, ...(L.narrow ? { style: 'font-size:11px' } : {}) }, title));
        g.appendChild(svg('text', { x: cx, y: y + h / 2 + 10, class: 'sub', ...(L.narrow ? { style: 'font-size:9px' } : {}) }, sub));
      } else {
        // On phones the agents drop the word "agent" to fit.
        g.appendChild(svg('text', { x: cx, y: y + h / 2, ...(L.narrow ? { style: 'font-size:11px' } : {}) }, L.narrow ? title.replace(' agent', '') : title));
      }
      nodeEls[id] = g;
      root.appendChild(g);
    }
    for (const [t, [x, y, w, h]] of Object.entries(L.chips)) {
      const write = AT.tools.get(t).kind === 'write';
      const g = svg('g', { class: 'dg-node chip' + (write ? ' write' : '') });
      g.appendChild(svg('rect', { x, y, width: w, height: h }));
      g.appendChild(svg('text', { x: x + w / 2, y: y + h / 2 + 0.5, style: `font-size:${L.chipFont}px` }, t));
      nodeEls['tool:' + t] = g;
      root.appendChild(g);
    }
    return { root, nodeEls, edgeEls };
  }

  let views = [];

  AT.diagram = {
    mount(host) {
      views = [build(wideLayout()), build(narrowLayout())];
      host.replaceChildren(...views.map((v) => v.root));
    },
    // active: node ids for the current event; visited: Set of every node touched so far.
    highlight(active, visited, level) {
      for (const v of views) {
        for (const [id, el] of Object.entries(v.nodeEls)) {
          const on = active.includes(id);
          el.classList.toggle('active', on);
          el.classList.toggle('visited', visited.has(id));
          for (const l of ['good', 'warn', 'bad']) el.classList.toggle(l, on && level === l);
        }
        for (const e of v.edgeEls) e.classList.toggle('visited', visited.has(e.dataset.a) && visited.has(e.dataset.b));
      }
    },
  };
})(globalThis.AT = globalThis.AT || {});
