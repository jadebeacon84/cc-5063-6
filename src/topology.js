import { cleanRing } from './geometry2d.js';

export function wrapDelta(d, period = 1) {
  let x = d;
  while (x > period / 2) x -= period;
  while (x < -period / 2) x += period;
  return x;
}

export function unwrapRingU(input, period = 1) {
  const ring = cleanRing(input);
  if (ring.length < 2) return { points: ring, closureShift: 0, span: 0 };
  const points = [{ ...ring[0], sourceIndex: 0 }];
  for (let i = 1; i < ring.length; i++) {
    const d = wrapDelta(ring[i].u - ring[i - 1].u, period);
    points.push({ ...ring[i], u: points[i - 1].u + d, sourceIndex: i });
  }
  const closingDelta = wrapDelta(ring[0].u - ring[ring.length - 1].u, period);
  const closingU = points[points.length - 1].u + closingDelta;
  const closureShift = Math.round((closingU - points[0].u) / period);
  const us = points.map((p) => p.u);
  return {
    points,
    closingU: points[0].u + closureShift * period,
    closureShift,
    minU: Math.min(...us),
    maxU: Math.max(...us),
    span: Math.max(...us) - Math.min(...us)
  };
}

export function periodicCopies(input, period = 1, tolerance = 1e-8) {
  const unwrapped = unwrapRingU(input, period);
  const copies = [];
  const kMin = Math.ceil(-unwrapped.maxU / period - tolerance);
  const kMax = Math.floor((period - unwrapped.minU) / period + tolerance);
  for (let k = kMin; k <= kMax; k++) {
    copies.push({
      shift: k * period,
      ring: unwrapped.points.map((p) => ({ u: p.u + k * period, v: p.v, sourceIndex: p.sourceIndex }))
    });
  }
  return { ...unwrapped, copies };
}

export function analyzeSeamRing(input, { period = 1, tolerance = 1e-7 } = {}) {
  const ring = cleanRing(input);
  const unwrapped = unwrapRingU(ring);
  const crossings = [];
  const seamEdges = [];
  for (let i = 0; i < unwrapped.points.length; i++) {
    const a = unwrapped.points[i];
    const b = unwrapped.points[(i + 1) % unwrapped.points.length];
    const bU = i === unwrapped.points.length - 1 ? unwrapped.closingU : b.u;
    for (let k = Math.floor(Math.min(a.u, bU)) - 1; k <= Math.ceil(Math.max(a.u, bU)) + 1; k++) {
      const da = a.u - k;
      const db = bU - k;
      if (Math.abs(da) <= tolerance && Math.abs(db) <= tolerance) {
        seamEdges.push({
          edgeIndex: i,
          liftU: k,
          canonicalU: 0,
          v0: a.v,
          v1: b.v,
          periodicKey: `seam-v:${((a.v + b.v) * 0.5).toFixed(7)}`
        });
      } else if ((da < -tolerance && db > tolerance) || (da > tolerance && db < -tolerance)) {
        const t = (k - a.u) / (bU - a.u);
        const v = a.v + (b.v - a.v) * t;
        crossings.push({
          edgeIndex: i,
          liftU: k,
          canonicalU: 0,
          v,
          periodicKey: `seam-v:${v.toFixed(7)}`,
          uv: { u: 0, v }
        });
      } else if (Math.abs(da) <= tolerance && Math.abs(db) > tolerance) {
        crossings.push({ edgeIndex: i, liftU: k, canonicalU: 0, v: a.v, endpoint: true, periodicKey: `seam-v:${a.v.toFixed(7)}`, uv: { u: 0, v: a.v } });
      }
    }
  }
  const touchesSeam = crossings.length > 0 || seamEdges.length > 0;
  const canTraceInAlternateChart = unwrapped.span < period - 2 * tolerance;
  return {
    touchesSeam,
    crossingCount: crossings.length,
    crossings,
    seamEdges,
    unwrapped,
    canonicalStrategy: touchesSeam ? 'split-at-seam' : 'single-chart',
    periodicStrategy: touchesSeam
      ? (canTraceInAlternateChart ? 'trace-across-seam' : 'multi-chart-trace')
      : 'closed-ring',
    seamLinks: crossings.map((c) => ({ ...c, twinU: 1, twinUV: { u: 1, v: c.v } }))
  };
}

export function findPeriodicPairs(vertices, { tolerance = 1e-7 } = {}) {
  const left = vertices.filter((p) => Math.abs(p.u) <= tolerance);
  const right = vertices.filter((p) => Math.abs(p.u - 1) <= tolerance);
  const pairs = [];
  const usedR = new Set();
  for (const a of left) {
    let best = null;
    let bestD = tolerance;
    right.forEach((b) => {
      if (usedR.has(b.id)) return;
      const d = Math.abs(a.v - b.v);
      if (d <= bestD) {
        best = b;
        bestD = d;
      }
    });
    if (best) {
      usedR.add(best.id);
      pairs.push({ a: a.id, b: best.id, key: `periodic-u:${((a.v + best.v) * 0.5).toFixed(7)}`, distance: bestD });
    }
  }
  return pairs;
}

export function findProjectionCoincidences(vertices, { camera = 'front-orthographic', tolerance = 1e-6 } = {}) {
  const groups = new Map();
  for (const v of vertices) {
    let key;
    if (camera === 'front-orthographic') {
      key = `xy:${v.projected?.[0]?.toFixed(5)},${v.projected?.[1]?.toFixed(5)}`;
    } else {
      key = `screen:${v.screenX?.toFixed(5)},${v.screenY?.toFixed(5)}`;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const pairs = [];
  for (const [screenKey, group] of groups.entries()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const samePeriodic = Math.abs(Math.abs(a.u - b.u) - 1) < 1e-6 || Math.abs(a.u - b.u) < 1e-6;
        const xyzD = Math.hypot(
          a.xyz[0] - b.xyz[0],
          a.xyz[1] - b.xyz[1],
          a.xyz[2] - b.xyz[2]
        );
        if (!samePeriodic && xyzD > tolerance) {
          pairs.push({ a: a.id, b: b.id, key: `projection:${screenKey}`, depthDistance: xyzD, weld: false });
        }
      }
    }
  }
  return pairs;
}
