const EPS = 1e-10;

export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p.u * q.v - q.u * p.v;
  }
  return a * 0.5;
}

export function polygonArea(ring) {
  return Math.abs(signedArea(ring));
}

export function cleanRing(ring, tolerance = 1e-9) {
  if (!Array.isArray(ring)) return [];
  const out = [];
  for (const p0 of ring) {
    if (!Number.isFinite(p0?.u) || !Number.isFinite(p0?.v)) continue;
    const p = { u: p0.u, v: p0.v };
    if (!out.length || Math.hypot(p.u - out[out.length - 1].u, p.v - out[out.length - 1].v) > tolerance) {
      out.push(p);
    }
  }
  if (out.length > 1 && Math.hypot(out[0].u - out[out.length - 1].u, out[0].v - out[out.length - 1].v) <= tolerance) {
    out.pop();
  }
  return out;
}

export function orientRing(ring, ccw = true) {
  const area = signedArea(ring);
  if ((ccw && area < 0) || (!ccw && area > 0)) return [...ring].reverse();
  return ring;
}

function cross(a, b, c) {
  return (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
}

function onSegment(p, a, b, tol = EPS) {
  return Math.abs(cross(a, b, p)) <= tol &&
    p.u >= Math.min(a.u, b.u) - tol && p.u <= Math.max(a.u, b.u) + tol &&
    p.v >= Math.min(a.v, b.v) - tol && p.v <= Math.max(a.v, b.v) + tol;
}

export function segmentsIntersect(a, b, c, d, tol = EPS) {
  const c1 = cross(a, b, c);
  const c2 = cross(a, b, d);
  const c3 = cross(c, d, a);
  const c4 = cross(c, d, b);
  if (Math.abs(c1) <= tol && onSegment(c, a, b, tol)) return true;
  if (Math.abs(c2) <= tol && onSegment(d, a, b, tol)) return true;
  if (Math.abs(c3) <= tol && onSegment(a, c, d, tol)) return true;
  if (Math.abs(c4) <= tol && onSegment(b, c, d, tol)) return true;
  return (c1 > tol && c2 < -tol || c1 < -tol && c2 > tol) &&
         (c3 > tol && c4 < -tol || c3 < -tol && c4 > tol);
}

export function findSelfIntersections(ring) {
  const hits = [];
  const n = ring.length;
  if (n < 4) return hits;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      if (segmentsIntersect(a, b, c, d)) {
        hits.push({ edgeA: [i, (i + 1) % n], edgeB: [j, (j + 1) % n] });
      }
    }
  }
  return hits;
}

export function validateRing(input, { minArea = 1e-11, tolerance = 1e-9 } = {}) {
  const ring = cleanRing(input, tolerance);
  const errors = [];
  if (ring.length < 3) errors.push('degenerate-point-count');
  const area = ring.length >= 3 ? Math.abs(signedArea(ring)) : 0;
  if (ring.length >= 3 && area <= minArea) errors.push('zero-area-loop');
  const intersections = ring.length >= 4 ? findSelfIntersections(ring) : [];
  if (intersections.length) errors.push('self-intersecting');
  const edgeLengths = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    edgeLengths.push(Math.hypot(b.u - a.u, b.v - a.v));
  }
  return {
    valid: errors.length === 0,
    errors,
    ring,
    area,
    signedArea: ring.length ? signedArea(ring) : 0,
    orientation: signedArea(ring) > 0 ? 'CCW' : signedArea(ring) < 0 ? 'CW' : 'NONE',
    selfIntersections: intersections,
    minEdgeLength: edgeLengths.length ? Math.min(...edgeLengths) : 0
  };
}

export function pointOnRingBoundary(p, ring, tolerance = 1e-8) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (distancePointSegment(p, a, b) <= tolerance) return true;
  }
  return false;
}

export function pointInPolygon(p, ring, { boundary = true, tolerance = 1e-8 } = {}) {
  if (boundary && pointOnRingBoundary(p, ring, tolerance)) return true;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if ((a.v > p.v) !== (b.v > p.v)) {
      const x = a.u + (b.u - a.u) * (p.v - a.v) / (b.v - a.v);
      if (x > p.u) inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygonWithHoles(p, polygon, options) {
  const [outer, ...holes] = polygon;
  if (!pointInPolygon(p, outer, options)) return false;
  for (const hole of holes) {
    if (pointInPolygon(p, hole, options)) return false;
  }
  return true;
}

export function pointInEffectiveRegion(p, polygons, options) {
  return polygons.some((poly) => pointInPolygonWithHoles(p, poly, options));
}

export function densifyRing(input, maxStep = 0.02) {
  const ring = cleanRing(input);
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push({ u: a.u, v: a.v });
    const len = Math.hypot(b.u - a.u, b.v - a.v);
    const steps = Math.max(1, Math.ceil(len / maxStep));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      out.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
    }
  }
  return out;
}

export function distancePointSegment(p, a, b) {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const l2 = du * du + dv * dv;
  if (l2 <= EPS) return Math.hypot(p.u - a.u, p.v - a.v);
  let t = ((p.u - a.u) * du + (p.v - a.v) * dv) / l2;
  t = Math.max(0, Math.min(1, t));
  const x = a.u + t * du;
  const y = a.v + t * dv;
  return Math.hypot(p.u - x, p.v - y);
}

export function distancePointToEdges(p, edges) {
  let d = Infinity;
  for (const [a, b] of edges) d = Math.min(d, distancePointSegment(p, a, b));
  return d;
}

export function ringEdges(ring) {
  const edges = [];
  for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length]]);
  return edges;
}

export function hausdorffPointToEdges(points, edges) {
  let maxD = 0;
  let worst = null;
  for (const p of points) {
    let d = Infinity;
    for (const [a, b] of edges) d = Math.min(d, distancePointSegment(p, a, b));
    if (d > maxD) {
      maxD = d;
      worst = { p, d };
    }
  }
  return { max: maxD, worst };
}

export function sampleRing(ring, count = 256) {
  const edges = ringEdges(ring);
  const lengths = edges.map(([a, b]) => Math.hypot(b.u - a.u, b.v - a.v));
  const total = lengths.reduce((s, x) => s + x, 0);
  const out = [];
  for (let k = 0; k < count; k++) {
    let target = (k / count) * total;
    let idx = 0;
    while (idx < lengths.length - 1 && target > lengths[idx]) {
      target -= lengths[idx];
      idx++;
    }
    const [a, b] = edges[idx];
    const t = lengths[idx] ? target / lengths[idx] : 0;
    out.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
  }
  return out;
}

export function triangleArea2(a, b, c) {
  return 0.5 * Math.abs((b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v));
}
