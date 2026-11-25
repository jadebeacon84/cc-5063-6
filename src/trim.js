import earcut from '../vendor/earcut.js';
import clipper from '../vendor/polygon-clipping.bundle.js';
import {
  cleanRing,
  orientRing,
  signedArea,
  validateRing,
  pointInPolygon,
  polygonArea,
  densifyRing
} from './geometry2d.js';
import { analyzeSeamRing, periodicCopies } from './topology.js';

const { difference, intersection, union } = clipper;

export const DOMAIN_RING = [
  { u: 0, v: 0 },
  { u: 1, v: 0 },
  { u: 1, v: 1 },
  { u: 0, v: 1 }
];

function ringToClip(ring) {
  return ring.map((p) => [p.u, p.v]);
}

function clipToRings(coords) {
  return coords.map(([u, v]) => ({ u, v }));
}

export function representativeInteriorPoint(ring) {
  const clean = cleanRing(ring);
  if (clean.length < 3) {
    const avg = clean.reduce((a, p) => ({ u: a.u + p.u / clean.length, v: a.v + p.v / clean.length }), { u: 0, v: 0 });
    return avg;
  }
  const flat = [];
  for (const p of clean) flat.push(p.u, p.v);
  let tris = [];
  try {
    tris = earcut(flat);
  } catch {
    tris = [];
  }
  if (tris.length >= 3) {
    const i = tris[0] * 2;
    const a = { u: flat[i], v: flat[i + 1] };
    const b = { u: flat[tris[1] * 2], v: flat[tris[1] * 2 + 1] };
    const c = { u: flat[tris[2] * 2], v: flat[tris[2] * 2 + 1] };
    return { u: (a.u + b.u + c.u) / 3, v: (a.v + b.v + c.v) / 3 };
  }
  return {
    u: clean.reduce((s, p) => s + p.u, 0) / clean.length,
    v: clean.reduce((s, p) => s + p.v, 0) / clean.length
  };
}

export function analyzeNesting(rings) {
  const reps = rings.map((ring) => representativeInteriorPoint(ring));
  return rings.map((ring, i) => {
    const containers = [];
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue;
      if (pointInPolygon(reps[i], rings[j], { boundary: false, tolerance: 1e-7 })) containers.push(j);
    }
    return {
      index: i,
      depth: containers.length,
      parent: containers.length ? containers[containers.length - 1] : null,
      parityRole: containers.length % 2 === 0 ? 'outer' : 'hole',
      containers
    };
  });
}

export function validateDefinition(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return { valid: false, errors: ['definition-not-object'] };
  const outerInput = def.outer?.points ? def.outer.points : (def.outer ?? DOMAIN_RING);
  const holesInput = def.holes ?? [];
  const outerCheck = validateRing(outerInput);
  if (!outerCheck.valid) errors.push({ contourId: def.outer?.id ?? 'outer', errors: outerCheck.errors });
  const holes = [];
  holesInput.forEach((h, index) => {
    const ringInput = h.points ?? h;
    const check = validateRing(ringInput);
    if (!check.valid) errors.push({ contourId: h.id ?? `hole-${index}`, errors: check.errors });
    holes.push({ ...h, normalized: check.ring, validation: check });
  });
  const outer = outerCheck.valid ? orientRing(outerCheck.ring, true) : orientRing(cleanRing(outerInput), true);
  const nesting = holesInput.length && holes.every((h) => h.validation.valid)
    ? analyzeNesting([outerCheck.ring, ...holes.map((h) => h.normalized)])
    : [];
  return {
    valid: errors.length === 0,
    errors,
    outer: { ...(def.outer ?? { id: 'parameter-domain' }), points: outer, normalized: outer, validation: outerCheck },
    holes: holes.map((h, i) => ({
      ...h,
      id: h.id ?? `hole-${i + 1}`,
      points: orientRing(h.normalized, false),
      normalized: orientRing(h.normalized, false),
      nesting: nesting[i + 1]
    })),
    nesting
  };
}

function periodicPolygonCopies(ring, densifyStep = 0) {
  const desiredCCW = signedArea(ring) > 0;
  const pc = periodicCopies(ring);
  return pc.copies.map((copy) => {
    const dense = densifyStep > 0 ? densifyRing(copy.ring, densifyStep) : copy.ring;
    return [ringToClip(orientRing(dense, desiredCCW))];
  });
}

export function planTrimming(def, options = {}) {
  const opts = { densifyStep: 0.018, ...options };
  const validation = validateDefinition(def);
  if (!validation.valid) {
    return { ok: false, ...validation, effectivePolygons: [], clipCoordinates: [] };
  }

  const outer = validation.outer;
  const holes = validation.holes;
  const seamReport = {
    outer: analyzeSeamRing(outer.normalized),
    holes: holes.map((h) => ({ id: h.id, ...analyzeSeamRing(h.normalized) }))
  };

  const outerDense = opts.densifyStep > 0 ? densifyRing(outer.normalized, opts.densifyStep) : outer.normalized;

  let region;
  const domainPolygon = [ringToClip(DOMAIN_RING)];
  const minU = Math.min(...outer.normalized.map((p) => p.u));
  const maxU = Math.max(...outer.normalized.map((p) => p.u));
  const minV = Math.min(...outer.normalized.map((p) => p.v));
  const maxV = Math.max(...outer.normalized.map((p) => p.v));
  const isFullDomain = Math.abs(outer.validation.area - 1) < 1e-8 &&
    minU <= 1e-8 && maxU >= 1 - 1e-8 && minV <= 1e-8 && maxV >= 1 - 1e-8;
  if (isFullDomain) {
    region = [domainPolygon];
  } else if (!seamReport.outer.touchesSeam) {
    region = intersection(domainPolygon, [ringToClip(outerDense)]);
  } else {
    const outerPolygons = periodicPolygonCopies(outer.normalized, opts.densifyStep);
    const outerUnion = union(...outerPolygons);
    region = intersection(domainPolygon, outerUnion);
  }

  for (const h of holes) {
    const clipCopies = periodicPolygonCopies(h.normalized, opts.densifyStep);
    for (const poly of clipCopies) {
      region = difference(region, poly);
    }
  }

  const effectivePolygons = region.map((polygon, pi) => ({
    id: `region-${pi + 1}`,
    rings: polygon.map((ring, ri) => ({
      id: `region-${pi + 1}-ring-${ri}`,
      role: ri === 0 ? 'outer' : 'hole',
      points: cleanRing(clipToRings(ring))
    }))
  }));

  const paramArea = effectivePolygons.reduce((sum, p) => {
    const outerArea = Math.abs(signedArea(p.rings[0].points));
    const holeArea = p.rings.slice(1).reduce((s, r) => s + Math.abs(signedArea(r.points)), 0);
    return sum + outerArea - holeArea;
  }, 0);

  return {
    ok: true,
    ...validation,
    options: opts,
    seamReport,
    effectivePolygons,
    clipCoordinates: region,
    counts: {
      definedHoles: holes.length,
      topologicalHoles: holes.length,
      canonicalPolygons: effectivePolygons.length,
      canonicalRings: effectivePolygons.reduce((s, p) => s + p.rings.length, 0)
    },
    area: { parameterPolygons: paramArea, domain: 1 }
  };
}
