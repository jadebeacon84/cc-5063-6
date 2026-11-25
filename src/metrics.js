import { pointInEffectiveRegion, cleanRing } from './geometry2d.js';
import { unwrapRingU } from './topology.js';

export function triangleUVArea(mesh) {
  let sum = 0;
  for (const face of mesh.faces) {
    const [ia, ib, ic] = face.sourceVertices;
    const a = mesh.vertices[ia];
    const b = mesh.vertices[ib];
    const c = mesh.vertices[ic];
    sum += 0.5 * Math.abs((b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v));
  }
  return sum;
}

export function triangle3DArea(mesh) {
  let sum = 0;
  for (const face of mesh.faces) {
    const [ia, ib, ic] = face.sourceVertices;
    const a = mesh.vertices[ia].xyz;
    const b = mesh.vertices[ib].xyz;
    const c = mesh.vertices[ic].xyz;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0]
    ];
    sum += 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
  }
  return sum;
}

export function rayParityAreaEstimate(polygons, { grid = 140 } = {}) {
  let inside = 0;
  let boundary = 0;
  const total = grid * grid;
  for (let ix = 0; ix < grid; ix++) {
    const u = (ix + 0.5) / grid;
    for (let iv = 0; iv < grid; iv++) {
      const v = (iv + 0.5) / grid;
      if (pointInEffectiveRegion({ u, v }, polygons, { tolerance: 1e-9 })) inside++;
    }
  }
  return {
    area: inside / total,
    inside,
    total,
    boundarySamples: boundary,
    method: 'axis-aligned-grid-ray-parity'
  };
}

function dist3DPointSegment(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  let t = l2 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function canonicalU(u) {
  const x = ((u % 1) + 1) % 1;
  return Math.abs(x - 1) < 1e-10 ? 0 : x;
}

export function canonicalTrimSegments(ring, { samplesPerUnit = 900, periodic = true } = {}) {
  const sourceRing = cleanRing(ring);
  const rawSegments = [];
  if (!periodic) {
    for (let i = 0; i < sourceRing.length; i++) {
      const a = sourceRing[i];
      const b = sourceRing[(i + 1) % sourceRing.length];
      rawSegments.push([{ ...a, liftU: a.u }, { ...b, liftU: b.u }]);
    }
    const sampled = [];
    for (const [a, b] of rawSegments) {
      const len = Math.hypot(b.u - a.u, b.v - a.v);
      const n = Math.max(2, Math.ceil(len * samplesPerUnit));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        sampled.push({
          u: a.u + (b.u - a.u) * t,
          v: a.v + (b.v - a.v) * t,
          liftU: a.u + (b.u - a.u) * t
        });
      }
    }
    return { segments: rawSegments, sampled };
  }
  const unwrapped = unwrapRingU(sourceRing);
  const p = unwrapped.points;
  const segments = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = i === p.length - 1 ? { u: unwrapped.closingU, v: unwrapped.closingV ?? p[0].v } : p[i + 1];
    if (i === p.length - 1) b.v = p[0].v;
    const cuts = [0, 1];
    const lo = Math.min(a.u, b.u);
    const hi = Math.max(a.u, b.u);
    for (let k = Math.floor(lo) - 1; k <= Math.ceil(hi) + 1; k++) {
      if (k > lo + 1e-12 && k < hi - 1e-12) cuts.push((k - a.u) / (b.u - a.u));
    }
    cuts.sort((x, y) => x - y);
    for (let ci = 0; ci < cuts.length - 1; ci++) {
      const t0 = cuts[ci];
      const t1 = cuts[ci + 1];
      if (t1 - t0 < 1e-12) continue;
      const aa = { u: a.u + (b.u - a.u) * t0, v: a.v + (b.v - a.v) * t0 };
      const bb = { u: a.u + (b.u - a.u) * t1, v: a.v + (b.v - a.v) * t1 };
      const chartShift = Math.floor((aa.u + bb.u) * 0.5 + 1e-12);
      segments.push([
        { u: aa.u - chartShift, v: aa.v, liftU: aa.u },
        { u: bb.u - chartShift, v: bb.v, liftU: bb.u }
      ]);
    }
  }
  const sampled = [];
  for (const [a, b] of segments) {
    const len = Math.hypot(b.u - a.u, b.v - a.v);
    const n = Math.max(2, Math.ceil(len * samplesPerUnit));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      sampled.push({
        u: a.u + (b.u - a.u) * t,
        v: a.v + (b.v - a.v) * t,
        liftU: a.liftU + (b.liftU - a.liftU) * t
      });
    }
  }
  return { segments, sampled };
}

function maxToUVEdges(points, edges) {
  let max = 0;
  let worst = null;
  for (const p of points) {
    let d = Infinity;
    for (const [a, b] of edges) {
      const du = b.u - a.u;
      const dv = b.v - a.v;
      const l2 = du * du + dv * dv;
      let t = l2 ? ((p.u - a.u) * du + (p.v - a.v) * dv) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      d = Math.min(d, Math.hypot(p.u - (a.u + t * du), p.v - (a.v + t * dv)));
    }
    if (d > max) {
      max = d;
      worst = { u: p.u, v: p.v, d };
    }
  }
  return { max, worst };
}

function maxTo3DEdges(points, edges) {
  let max = 0;
  let worst = null;
  for (const p of points) {
    let d = Infinity;
    for (const [a, b] of edges) d = Math.min(d, dist3DPointSegment(p, a, b));
    if (d > max) {
      max = d;
      worst = { point: p, d };
    }
  }
  return { max, worst };
}

export function measureBoundaryErrors(definition, plan, mesh, surface) {
  const uvEdges = mesh.boundaryEdges.map((e) => [mesh.vertices[e.a], mesh.vertices[e.b]]);
  const xyzEdges = uvEdges.map(([a, b]) => [a.xyz, b.xyz]);
  const contours = [
    ...(definition.holes ?? []).map((h, i) => ({ ...h, id: h.id ?? `hole-${i + 1}`, kind: 'hole' }))
  ];
  const outerRaw = definition.outer?.points;
  const outerIsDomain = outerRaw && outerRaw.length >= 4 &&
    Math.min(...outerRaw.map((p) => p.u)) <= 1e-9 &&
    Math.max(...outerRaw.map((p) => p.u)) >= 1 - 1e-9 &&
    Math.min(...outerRaw.map((p) => p.v)) <= 1e-9 &&
    Math.max(...outerRaw.map((p) => p.v)) >= 1 - 1e-9;
  if (definition.outer && definition.measureOuter !== false && !outerIsDomain) {
    contours.push({ ...definition.outer, id: definition.outer.id ?? 'outer', kind: 'outer' });
  }

  const perContour = contours.map((c) => {
    const raw = c.points ?? c;
    const isFullDomain = c.id === 'outer-domain' || (
      raw.length === 4 &&
      Math.min(...raw.map((p) => p.u)) <= 1e-9 &&
      Math.max(...raw.map((p) => p.u)) >= 1 - 1e-9 &&
      Math.min(...raw.map((p) => p.v)) <= 1e-9 &&
      Math.max(...raw.map((p) => p.v)) >= 1 - 1e-9
    );
    const source = canonicalTrimSegments(raw, { periodic: !isFullDomain });
    const uv = maxToUVEdges(source.sampled, uvEdges);
    const source3D = source.sampled.map((p) => surface.mapUV(p.liftU ?? p.u, p.v));
    const xyz = maxTo3DEdges(source3D, xyzEdges);
    return { id: c.id, kind: c.kind, parameter: uv.max, parameterWorst: uv.worst, surface3D: xyz.max, surfaceWorst: xyz.worst };
  });

  return {
    perContour,
    parameterBoundaryError: Math.max(0, ...perContour.map((x) => x.parameter)),
    surfaceBoundaryError3D: Math.max(0, ...perContour.map((x) => x.surface3D)),
    units: { parameter: 'dimensionless uv', surface3D: 'world units' },
    stretch: surface.metricScale()
  };
}

export function crossValidate(definition, plan, mesh, surface, options = {}) {
  const exactParamArea = plan.area.parameterPolygons;
  const triParamArea = triangleUVArea(mesh);
  const area3d = triangle3DArea(mesh);
  const parity = rayParityAreaEstimate(
    plan.effectivePolygons.map((poly) => poly.rings.map((ring) => ring.points)),
    options.parityGrid ? { grid: options.parityGrid } : {}
  );
  const expected3d = exactParamArea * surface.metricScale().areaScale;
  const boundary = measureBoundaryErrors(definition, plan, mesh, surface);
  return {
    exactParamArea,
    triangleParamArea: triParamArea,
    triangleAreaError: Math.abs(triParamArea - exactParamArea),
    triangleAreaRelativeError: Math.abs(triParamArea - exactParamArea) / Math.max(exactParamArea, 1e-12),
    parityArea: parity.area,
    parityAreaError: Math.abs(parity.area - exactParamArea),
    parity,
    area3d,
    expectedCurvedArea3d: expected3d,
    area3dRelativeError: Math.abs(area3d - expected3d) / Math.max(expected3d, 1e-12),
    ...boundary
  };
}
