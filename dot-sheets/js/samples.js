/* Three sample pictures, painted in code so there's something to try without a photo. Each gets
 * shading and grain so the simplifier has real work to do, the way it would with a photo.
 * Browser only (uses canvas). Attaches to globalThis.DotSamples.
 */
(function (S) {
  'use strict';

  function grain(ctx, w, h, amount, seed) {
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    let s = seed >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * amount;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }

  function lin(ctx, x0, y0, x1, y1, stops) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([t, c]) => g.addColorStop(t, c));
    return g;
  }
  function rad(ctx, x, y, r0, r1, stops) {
    const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
    stops.forEach(([t, c]) => g.addColorStop(t, c));
    return g;
  }

  function hills(ctx, w, h) {
    ctx.fillStyle = lin(ctx, 0, 0, 0, h * 0.6, [[0, '#7ec3ea'], [1, '#d9eef7']]);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = rad(ctx, w * 0.74, h * 0.2, 10, w * 0.2, [[0, 'rgba(255,240,170,1)'], [0.45, 'rgba(255,214,90,1)'], [0.5, 'rgba(255,230,150,0.35)'], [1, 'rgba(255,255,255,0)']]);
    ctx.fillRect(0, 0, w, h);
    // clouds
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const [cx, cy, s] of [[0.2, 0.14, 1], [0.42, 0.22, 0.7]]) {
      for (const [dx, dy, r] of [[0, 0, 40], [38, -12, 46], [80, 4, 36], [40, 14, 40]]) {
        ctx.beginPath(); ctx.arc(cx * w + dx * s * 1.4, cy * h + dy * s * 1.4, r * s * 1.4, 0, 7); ctx.fill();
      }
    }
    // far mountains
    ctx.fillStyle = lin(ctx, 0, h * 0.3, 0, h * 0.55, [[0, '#7c6fb0'], [1, '#a59ccc']]);
    ctx.beginPath(); ctx.moveTo(0, h * 0.5);
    [[0.12, 0.36], [0.26, 0.45], [0.4, 0.32], [0.55, 0.44], [0.68, 0.37], [0.85, 0.47], [1, 0.4]].forEach(([x, y]) => ctx.lineTo(x * w, y * h));
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fill();
    // hills
    const hill = (y0, amp, ph, c0, c1) => {
      ctx.fillStyle = lin(ctx, 0, y0 - amp, 0, h, [[0, c0], [1, c1]]);
      ctx.beginPath(); ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) ctx.lineTo(x, y0 + Math.sin(x / w * 5 + ph) * amp + Math.sin(x / w * 11 + ph * 2) * amp * 0.3);
      ctx.lineTo(w, h); ctx.fill();
    };
    hill(h * 0.56, h * 0.035, 1.2, '#5fbf5a', '#3c8f3e');
    hill(h * 0.7, h * 0.05, 3.4, '#2f9e55', '#1f6e3a');
    // path
    ctx.fillStyle = lin(ctx, 0, h * 0.7, 0, h, [[0, '#e7c58f'], [1, '#c9955a']]);
    ctx.beginPath(); ctx.moveTo(w * 0.47, h * 0.66);
    ctx.bezierCurveTo(w * 0.4, h * 0.78, w * 0.62, h * 0.85, w * 0.42, h); ctx.lineTo(w * 0.66, h);
    ctx.bezierCurveTo(w * 0.8, h * 0.85, w * 0.5, h * 0.78, w * 0.52, h * 0.66); ctx.fill();
    // house
    const hx = w * 0.5, hy = h * 0.6;
    ctx.fillStyle = '#c8323a'; ctx.fillRect(hx - 70, hy - 60, 140, 80);
    ctx.fillStyle = '#5a2a22'; ctx.beginPath(); ctx.moveTo(hx - 85, hy - 58); ctx.lineTo(hx, hy - 120); ctx.lineTo(hx + 85, hy - 58); ctx.fill();
    ctx.fillStyle = '#ffe6a1'; ctx.fillRect(hx - 50, hy - 40, 26, 26); ctx.fillRect(hx + 24, hy - 40, 26, 26);
    ctx.fillStyle = '#3b2216'; ctx.fillRect(hx - 13, hy - 30, 26, 50);
    // tree
    const tx = w * 0.2, ty = h * 0.66;
    ctx.fillStyle = '#6b4226'; ctx.fillRect(tx - 12, ty - 90, 24, 110);
    ctx.fillStyle = rad(ctx, tx - 20, ty - 160, 10, 120, [[0, '#7cd35f'], [1, '#2a7a33']]);
    ctx.beginPath(); ctx.arc(tx, ty - 150, 95, 0, 7); ctx.fill();
    // flowers
    for (let i = 0; i < 26; i++) {
      const x = ((i * 137) % 100) / 100 * w, y = h * (0.8 + ((i * 53) % 19) / 100);
      ctx.fillStyle = i % 3 ? '#f06292' : '#ffd54f';
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
    }
  }

  function fox(ctx, w, h) {
    ctx.fillStyle = lin(ctx, 0, 0, w, h, [[0, '#9fd8d0'], [1, '#4f9fb0']]);
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h * 0.55, s = Math.min(w, h) / 900;
    const P = (x, y) => [cx + x * s, cy + y * s];
    const path = pts => { ctx.beginPath(); ctx.moveTo(...P(...pts[0])); for (let i = 1; i < pts.length; i += 3) ctx.bezierCurveTo(...P(...pts[i]), ...P(...pts[i + 1]), ...P(...pts[i + 2])); ctx.closePath(); };
    // ears
    for (const m of [-1, 1]) {
      ctx.fillStyle = '#d9631e';
      path([[m * 120, -150], [m * 160, -260], [m * 230, -360], [m * 300, -380], [m * 310, -290], [m * 300, -200], [m * 260, -110]]); ctx.fill();
      ctx.fillStyle = '#3a1d10';
      path([[m * 240, -330], [m * 270, -370], [m * 300, -385], [m * 306, -370], [m * 308, -340], [m * 305, -320], [m * 290, -300]]); ctx.fill();
      ctx.fillStyle = '#fbe3d0';
      path([[m * 170, -160], [m * 200, -240], [m * 240, -300], [m * 270, -310], [m * 275, -260], [m * 265, -200], [m * 240, -140]]); ctx.fill();
    }
    // head
    ctx.fillStyle = rad(ctx, cx - 60 * s, cy - 120 * s, 20 * s, 420 * s, [[0, '#f5913e'], [1, '#c2531a']]);
    path([[0, -230], [170, -230], [330, -160], [340, 0], [300, 120], [120, 230], [0, 300], [-120, 230], [-300, 120], [-340, 0], [-330, -160], [-170, -230], [0, -230]]); ctx.fill();
    // cheeks and muzzle
    ctx.fillStyle = '#fbf3ea';
    path([[0, 40], [60, 20], [200, 20], [330, 10], [280, 130], [140, 230], [0, 300], [-140, 230], [-280, 130], [-330, 10], [-200, 20], [-60, 20], [0, 40]]); ctx.fill();
    // eyes
    for (const m of [-1, 1]) {
      ctx.fillStyle = '#2a170c';
      ctx.beginPath(); ctx.ellipse(...P(m * 130, -40), 38 * s, 30 * s, m * 0.25, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(...P(m * 130 + 10, -52), 9 * s, 0, 7); ctx.fill();
    }
    // nose
    ctx.fillStyle = '#1d0f08';
    path([[-40, 210], [-30, 180], [30, 180], [40, 210], [45, 240], [15, 262], [0, 262], [-15, 262], [-45, 240], [-40, 210]]); ctx.fill();
  }

  function bloom(ctx, w, h) {
    ctx.fillStyle = lin(ctx, 0, 0, 0, h, [[0, '#f6e7c9'], [1, '#e8cf9e']]);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = lin(ctx, 0, h * 0.78, 0, h, [[0, '#8f6a4a'], [1, '#6e4e35']]);
    ctx.fillRect(0, h * 0.8, w, h * 0.2);
    // pot
    ctx.fillStyle = lin(ctx, w * 0.3, 0, w * 0.7, 0, [[0, '#b55a32'], [0.5, '#e07a46'], [1, '#a24d2a']]);
    ctx.beginPath(); ctx.moveTo(w * 0.32, h * 0.62); ctx.lineTo(w * 0.68, h * 0.62); ctx.lineTo(w * 0.62, h * 0.88); ctx.lineTo(w * 0.38, h * 0.88); ctx.fill();
    ctx.fillStyle = '#c4643a'; ctx.fillRect(w * 0.3, h * 0.6, w * 0.4, h * 0.05);
    // stem and leaves
    ctx.strokeStyle = '#2f7d32'; ctx.lineWidth = w * 0.025; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(w * 0.5, h * 0.6); ctx.bezierCurveTo(w * 0.47, h * 0.48, w * 0.53, h * 0.4, w * 0.5, h * 0.33); ctx.stroke();
    ctx.fillStyle = '#43a047';
    for (const m of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(w * 0.5, h * (m < 0 ? 0.52 : 0.46));
      ctx.bezierCurveTo(w * (0.5 + m * 0.12), h * 0.4, w * (0.5 + m * 0.26), h * 0.47, w * (0.5 + m * 0.24), h * 0.5);
      ctx.bezierCurveTo(w * (0.5 + m * 0.18), h * 0.55, w * (0.5 + m * 0.08), h * 0.55, w * 0.5, h * (m < 0 ? 0.52 : 0.46)); ctx.fill();
    }
    // petals
    const fx = w * 0.5, fy = h * 0.27, R = w * 0.2;
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      ctx.save(); ctx.translate(fx, fy); ctx.rotate(a);
      ctx.fillStyle = lin(ctx, 0, 0, R, 0, [[0, '#c2185b'], [1, '#f48fb1']]);
      ctx.beginPath(); ctx.ellipse(R * 0.55, 0, R * 0.55, R * 0.24, 0, 0, 7); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = rad(ctx, fx - 8, fy - 8, 4, R * 0.3, [[0, '#ffe082'], [1, '#f9a825']]);
    ctx.beginPath(); ctx.arc(fx, fy, R * 0.28, 0, 7); ctx.fill();
  }

  const PAINT = { hills: [hills, 900, 1100], fox: [fox, 1000, 1000], bloom: [bloom, 900, 1150] };

  // Returns a canvas with the sample painted on it.
  S.make = function (name) {
    const [paint, w, h] = PAINT[name] || PAINT.hills;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    paint(ctx, w, h);
    grain(ctx, w, h, 26, name.length * 977);
    return cv;
  };
  S.names = Object.keys(PAINT);
})(typeof globalThis.DotSamples === 'object' ? globalThis.DotSamples : (globalThis.DotSamples = {}));
