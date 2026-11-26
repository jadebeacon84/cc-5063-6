import {
  cleanRing,
  signedArea,
  segmentIntersectionDetails,
  pointInEffectiveRegion
} from './geometry2d.js';
import { unwrapRingU, periodicCopies } from './topology.js';
import { planTrimming, DOMAIN_RING } from './trim.js';
import { buildTrimmedMesh } from './mesh.js';
import { CylinderSurface } from './surface.js';

const EPS = 1e-9;

export class IntervalIndex1D {
  constructor(entries = []) {
    this.entries = entries.map((entry) => {
      const start = Math.min(entry.start, entry.end);
      const end = Math.max(entry.start, entry.end);
      return { ...entry, start, end };
    });
    this.root = this.#build(this.entries);
  }

  #build(items) {
    if (!items.length) return null;
    const centers = items.map((item) => (item.start + item.end) * 0.5).sort((a, b) => a - b);
    const center = centers[Math.floor(centers.length / 2)];
    const centerItems = [];
    const leftItems = [];
    const rightItems = [];
    for (const item of items) {
      if (item.end < center - EPS) leftItems.push(item);
      else if (item.start > center + EPS) rightItems.push(item);
      else centerItems.push(item);
    }
    centerItems.sort((a, b) => a.start - b.start || b.end - a.end);
    return {
      center,
      items: centerItems,
      left: this.#build(leftItems),
      right: this.#build(rightItems)
    };
  }

  queryRange(lo, hi) {
    const out = new Set();
    const visit = (node) => {
      if (!node) return;
      if (hi < node.center) {
        for (const item of node.items) {
          if (item.start <= hi + EPS && item.end >= lo - EPS) out.add(item.id);
        }
        visit(node.left);
      } else if (lo > node.center) {
        for (const item of node.items) {
          if (item.start <= hi + EPS && item.end >= lo - EPS) out.add(item.id);
        }
        visit(node.right);
      } else {
        for (const item of node.items) out.add(item.id);
        visit(node.left);
        visit(node.right);
      }
    };
    visit(this.root);
    return out;
  }

  queryPoint(x) {
    return this.queryRange(x, x);
  }
}

export function createIntervalIndex(entries) {
  return new IntervalIndex1D(entries);
}

export function ringBBox(ring) {
  const points = cleanRing(ring);
  const us = points.map((p) => p.u);
  const vs = points.map((p) => p.v);
  return {
    minU: Math.min(...us),
    maxU: Math.max(...us),
    minV: Math.min(...vs),
    maxV: Math.max(...vs)
  };
}

export function bboxesEqual(a, b, tolerance = 1e-9) {
  return Math.abs(a.minU - b.minU) <= tolerance &&
    Math.abs(a.maxU - b.maxU) <= tolerance &&
    Math.abs(a.minV - b.minV) <= tolerance &&
    Math.abs(a.maxV - b.maxV) <= tolerance;
}

export function canClipInOneDirectedTile(ring, options = {}) {
  return classifyDirectedSeamLoop(ring, options).locality === 'single-tile';
}

export function requiresTwoSidedSeamIntersection(ring, options = {}) {
  return classifyDirectedSeamLoop(ring, options).locality === 'two-sided-joint';
}

function findDirectedSeamPassages(ring, unwrapped, tolerance) {
  const passages = [];
  const points = unwrapped.points;
  if (points.length < 2) return passages;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    for (let k = Math.floor(unwrapped.minU) - 1; k <= Math.ceil(unwrapped.maxU) + 1; k++) {
      if (Math.abs(p.u - k) > tolerance) continue;
      const prev = points[(i - 1 + points.length) % points.length].u;
      const next = i === points.length - 1 ? unwrapped.closingU : points[i + 1].u;
      if ((prev < k - tolerance && next > k + tolerance) ||
          (prev > k + tolerance && next < k - tolerance)) {
        const direction = next > prev ? 'increasing' : 'decreasing';
        const v = p.v;
        if (!passages.some((x) => x.vertexIndex === i && x.liftU === k)) {
          passages.push({ vertexIndex: i, liftU: k, seamU: 0, v, direction });
        }
      }
    }
  }

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const bU = i === points.length - 1 ? unwrapped.closingU : points[i + 1].u;
    const bV = i === points.length - 1 ? points[0].v : points[i + 1].v;
    for (let k = Math.floor(Math.min(a.u, bU)) - 1; k <= Math.ceil(Math.max(a.u, bU)) + 1; k++) {
      const da = a.u - k;
      const db = bU - k;
      if (Math.abs(da) > tolerance && Math.abs(db) > tolerance &&
          ((da < 0 && db > 0) || (da > 0 && db < 0))) {
        const t = (k - a.u) / (bU - a.u);
        passages.push({
          edgeIndex: i,
          liftU: k,
          seamU: 0,
          v: a.v + (bV - a.v) * t,
          direction: db > da ? 'increasing' : 'decreasing',
          interior: true
        });
      }
    }
  }

  return passages;
}

function findCanonicalSeamEdges(ring, tolerance) {
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    let seamU = null;
    if (Math.abs(a.u) <= tolerance && Math.abs(b.u) <= tolerance) seamU = 0;
    if (Math.abs(a.u - 1) <= tolerance && Math.abs(b.u - 1) <= tolerance) seamU = 1;
    if (seamU !== null && Math.abs(b.v - a.v) > tolerance) {
      edges.push({
        edgeIndex: i,
        seamU,
        v0: a.v,
        v1: b.v,
        direction: b.v > a.v ? 'increasing' : 'decreasing',
        dvSign: Math.sign(b.v - a.v)
      });
    }
  }
  return edges;
}

export function classifyDirectedSeamLoop(input, { tolerance = 1e-7, padding = 1e-6 } = {}) {
  const ring = cleanRing(input);
  const bbox = ringBBox(ring);
  const canonicalArea = signedArea(ring);
  const unwrapped = unwrapRingU(ring, 1);
  const liftedRing = [...unwrapped.points, { u: unwrapped.closingU, v: ring[0]?.v ?? 0 }];
  const liftedArea = signedArea(liftedRing);
  const passages = findDirectedSeamPassages(ring, unwrapped, tolerance);
  const seamEdges = findCanonicalSeamEdges(ring, tolerance);
  const increasing = passages.filter((p) => p.direction === 'increasing').length;
  const decreasing = passages.filter((p) => p.direction === 'decreasing').length;
  const balancedThroughSeam = passages.length >= 2 && increasing > 0 && decreasing > 0;

  let directedClass = 'plain-loop';
  let locality = 'single-tile';
  let booleanStrategy = 'canonical-difference';
  if (balancedThroughSeam) {
    directedClass = 'true-seam-crossing';
    locality = 'two-sided-joint';
    booleanStrategy = 'periodic-copies-joint';
  } else if (seamEdges.length > 0) {
    directedClass = 'seam-foldback';
    locality = 'single-tile';
    booleanStrategy = 'one-periodic-tile';
  } else if (passages.length > 0 || unwrapped.minU < -tolerance || unwrapped.maxU > 1 + tolerance) {
    directedClass = 'lifted-single-side';
    locality = 'single-tile';
    booleanStrategy = 'one-periodic-tile';
  }

  const liftedAreaSign = Math.sign(liftedArea) || Math.sign(canonicalArea);
  for (const edge of seamEdges) {
    edge.interiorUSign = -liftedAreaSign * edge.dvSign;
  }

  const paddedMinU = unwrapped.minU - padding;
  const paddedMaxU = unwrapped.maxU + padding;
  const paddedMinV = bbox.minV - padding;
  const paddedMaxV = bbox.maxV + padding;
  const queryRegions = [];
  const shiftMin = Math.ceil(-paddedMaxU - tolerance);
  const shiftMax = Math.floor(1 - paddedMinU + tolerance);
  for (let shift = shiftMin; shift <= shiftMax; shift++) {
    const lo = Math.max(0, paddedMinU + shift);
    const hi = Math.min(1, paddedMaxU + shift);
    if (hi < lo - tolerance) continue;
    queryRegions.push({
      id: `period-${shift}`,
      shift,
      side: lo <= tolerance && hi < 1 - tolerance ? 'u=0' : hi >= 1 - tolerance && lo > tolerance ? 'u=1' : 'interior',
      uInterval: [lo, hi],
      vInterval: [paddedMinV, paddedMaxV]
    });
  }

  return {
    directedClass,
    locality,
    booleanStrategy,
    canonicalStrategy: balancedThroughSeam ? 'split-at-seam' : seamEdges.length ? 'touch-or-fold-at-seam' : 'single-chart',
    indexDecision: balancedThroughSeam ? 'query-both-seam-sides-jointly' : 'query-one-directed-tile',
    bbox,
    rectangleTouchesSeam: bbox.minU <= tolerance || bbox.maxU >= 1 - tolerance,
    rectangleSpansSeamCandidate: bbox.minU <= 0.1 + tolerance && bbox.maxU >= 0.9 - tolerance,
    canonicalArea,
    liftedArea,
    windingShift: unwrapped.closureShift,
    span: unwrapped.span,
    passages,
    seamEdges,
    queryRegions
  };
}

export const classifySeamLoop = classifyDirectedSeamLoop;
export const classifySeamSide = classifyDirectedSeamLoop;
export const resolveSeamIndexSide = classifyDirectedSeamLoop;
export const getSeamClipPlan = classifyDirectedSeamLoop;
export const planSeamLocality = classifyDirectedSeamLoop;

function edgeRecord(id, a, b, extra = {}) {
  return {
    id,
    a: { u: a.u, v: a.v },
    b: { u: b.u, v: b.v },
    bbox: ringBBox([a, b]),
    ...extra
  };
}

export class CandidateIndex {
  constructor({ edges = [], faces = [], padding = 1e-7 } = {}) {
    this.padding = padding;
    this.edges = edges.map((edge) => edgeRecord(edge.id, edge.a, edge.b, edge));
    this.faces = faces.map((face) => ({
      ...face,
      bbox: face.bbox ?? ringBBox(face.points ?? [])
    }));
    this.edgeUIndex = new IntervalIndex1D(this.edges.map((e) => ({ id: e.id, start: e.bbox.minU, end: e.bbox.maxU })));
    this.edgeVIndex = new IntervalIndex1D(this.edges.map((e) => ({ id: e.id, start: e.bbox.minV, end: e.bbox.maxV })));
    this.faceUIndex = new IntervalIndex1D(this.faces.map((f) => ({ id: f.id, start: f.bbox.minU, end: f.bbox.maxU })));
    this.faceVIndex = new IntervalIndex1D(this.faces.map((f) => ({ id: f.id, start: f.bbox.minV, end: f.bbox.maxV })));
  }

  static fromRings(rings, options = {}) {
    const list = Array.isArray(rings) ? rings : [rings];
    const edges = [];
    for (const [ringIndex, item] of list.entries()) {
      const idPrefix = item.id ?? `ring-${ringIndex}`;
      const points = cleanRing(item.points ?? item);
      for (let i = 0; i < points.length; i++) {
        edges.push(edgeRecord(
          `${idPrefix}:edge-${i}`,
          points[i],
          points[(i + 1) % points.length],
          { contourId: idPrefix, edgeIndex: i }
        ));
      }
    }
    return new CandidateIndex({ edges, ...options });
  }

  static fromMesh(mesh, options = {}) {
    const edgeMap = new Map();
    for (const tri of mesh.triangles) {
      const ids = tri.vertices;
      for (let i = 0; i < 3; i++) {
        const aId = ids[i];
        const bId = ids[(i + 1) % 3];
        const key = aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, edgeRecord(key, mesh.vertices[aId], mesh.vertices[bId], { sourceVertexIds: [aId, bId] }));
        }
      }
    }
    const faces = mesh.faces.map((face) => {
      const points = face.sourceVertices.map((id) => mesh.vertices[id]);
      let area = 0;
      for (let i = 0; i < points.length; i += 3) {
        const a = points[i];
        const b = points[i + 1];
        const c = points[i + 2];
        area += 0.5 * Math.abs((b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v));
      }
      return {
        id: face.faceIndex,
        faceId: face.faceId,
        points,
        area,
        centroidUV: face.centroidUV,
        bbox: ringBBox(points)
      };
    });
    return new CandidateIndex({ edges: [...edgeMap.values()], faces, ...options });
  }

  queryEdges(regions) {
    const reasons = new Map();
    for (const region of regions) {
      const [uLo, uHi] = region.uInterval;
      const [vLo, vHi] = region.vInterval;
      const uHits = this.edgeUIndex.queryRange(uLo, uHi);
      const vHits = this.edgeVIndex.queryRange(vLo, vHi);
      for (const id of uHits) {
        if (!vHits.has(id)) continue;
        if (!reasons.has(id)) reasons.set(id, []);
        reasons.get(id).push({ region: region.id, side: region.side, source: 'directed-interval-index' });
      }
    }
    return this.edges
      .filter((edge) => reasons.has(edge.id))
      .map((edge) => ({ ...edge, candidateSources: reasons.get(edge.id) }));
  }

  queryFaces(regions) {
    const reasons = new Map();
    for (const region of regions) {
      const [uLo, uHi] = region.uInterval;
      const [vLo, vHi] = region.vInterval;
      const uHits = this.faceUIndex.queryRange(uLo, uHi);
      const vHits = this.faceVIndex.queryRange(vLo, vHi);
      for (const id of uHits) {
        if (!vHits.has(id)) continue;
        if (!reasons.has(id)) reasons.set(id, []);
        reasons.get(id).push({ region: region.id, side: region.side, source: 'directed-face-interval-index' });
      }
    }
    return this.faces
      .filter((face) => reasons.has(face.id))
      .map((face) => ({ ...face, candidateSources: reasons.get(face.id) }));
  }
}

export function buildCandidateIndex(source, options = {}) {
  if (source?.edges || source?.faces) return new CandidateIndex(source);
  if (source?.triangles && source?.vertices) return CandidateIndex.fromMesh(source, options);
  return CandidateIndex.fromRings(source, options);
}

export function exactIntersectionsForCandidates(ring, candidateEdges, { tolerance = 1e-8, periodic = true } = {}) {
  const points = cleanRing(ring);
  const copies = periodic ? periodicCopies(points).copies : [{ ring: points }];
  const results = [];
  const seen = new Set();

  for (let queryEdgeIndex = 0; queryEdgeIndex < points.length; queryEdgeIndex++) {
    for (const candidate of candidateEdges) {
      let best = null;
      for (const copy of copies) {
        const copyRing = copy.ring;
        const a = copyRing[queryEdgeIndex];
        const b = copyRing[(queryEdgeIndex + 1) % copyRing.length];
        const detail = segmentIntersectionDetails(a, b, candidate.a, candidate.b, tolerance);
        if (detail.type !== 'none') {
          best = { detail, shift: copy.shift };
          if (detail.type !== 'coincident') break;
        }
      }
      if (!best) continue;
      const key = `${queryEdgeIndex}\u0000${candidate.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        queryEdgeIndex,
        targetEdgeId: candidate.id,
        type: best.detail.type,
        kind: best.detail.kind ?? best.detail.type,
        shift: best.shift,
        overlapLength: best.detail.overlapLength ?? 0,
        candidateSources: candidate.candidateSources ?? []
      });
    }
  }
  return results;
}

export function evaluateClipLocality(ring, index, { padding = 1e-6, tolerance = 1e-8, periodic = true } = {}) {
  const classification = classifyDirectedSeamLoop(ring, { padding });
  const candidateEdges = index.queryEdges(classification.queryRegions);
  const intersections = exactIntersectionsForCandidates(ring, candidateEdges, { tolerance, periodic });
  return {
    classification,
    regions: classification.queryRegions,
    candidateEdgeCount: candidateEdges.length,
    candidatePairCount: cleanRing(ring).length * candidateEdges.length,
    exactIntersectionCount: intersections.length,
    coincidentIntersectionCount: intersections.filter((x) => x.type === 'coincident').length,
    tangentIntersectionCount: intersections.filter((x) => x.kind === 'tangent').length,
    intersections,
    candidateEdges
  };
}

export function verifyCandidateCompleteness(ring, index, locality, options = {}) {
  const allIntersections = exactIntersectionsForCandidates(ring, index.edges, options);
  const candidateKeys = new Set(locality.intersections.map((x) => `${x.queryEdgeIndex}:${x.targetEdgeId}`));
  const missed = allIntersections
    .filter((x) => !candidateKeys.has(`${x.queryEdgeIndex}:${x.targetEdgeId}`))
    .map((x) => ({ queryEdgeIndex: x.queryEdgeIndex, targetEdgeId: x.targetEdgeId, kind: x.kind }));
  return {
    bruteForceIntersectionCount: allIntersections.length,
    acceleratedIntersectionCount: locality.exactIntersectionCount,
    missedIntersectionCount: missed.length,
    missed,
    complete: missed.length === 0
  };
}

export function auditSkippedFaces({ mesh, index, ring, plan, padding = 1e-6 }) {
  const classification = classifyDirectedSeamLoop(ring, { padding });
  const candidateFaces = index.queryFaces(classification.queryRegions);
  const candidateIds = new Set(candidateFaces.map((face) => face.id));
  let skippedFaceCount = 0;
  let skippedArea = 0;
  let erroneouslyExcludedFaceCount = 0;
  let erroneousExclusionArea = 0;
  const erroneousFaces = [];

  for (const face of index.faces) {
    if (candidateIds.has(face.id)) continue;
    skippedFaceCount++;
    skippedArea += face.area;
    const inside = pointInEffectiveRegion(
      face.centroidUV,
      plan.effectivePolygons.map((poly) => poly.rings.map((r) => r.points)),
      { boundary: false, tolerance: 1e-7 }
    );
    if (!inside) {
      erroneouslyExcludedFaceCount++;
      erroneousExclusionArea += face.area;
      erroneousFaces.push({ faceId: face.faceId, centroidUV: face.centroidUV, area: face.area });
    }
  }

  return {
    triangleCount: index.faces.length,
    candidateFaceCount: candidateFaces.length,
    skippedFaceCount,
    skippedArea,
    erroneouslyExcludedFaceCount,
    erroneousExclusionArea,
    erroneousFaces: erroneousFaces.slice(0, 20)
  };
}

function rectPoints(u0, v0, u1, v1) {
  return [
    { u: u0, v: v0 },
    { u: u1, v: v0 },
    { u: u1, v: v1 },
    { u: u0, v: v1 }
  ];
}

export function makeSameBBoxSeamPair() {
  const bbox = { minU: 0, maxU: 0.9, minV: 0.4, maxV: 0.6 };
  const crossing = [
    { u: 0.9, v: 0.4 },
    { u: 0, v: 0.45 },
    { u: 0.1, v: 0.6 }
  ];
  const foldback = [
    { u: 0, v: 0.4 },
    { u: 0, v: 0.6 },
    { u: 0.9, v: 0.6 },
    { u: 0.7, v: 0.4 }
  ];
  return {
    bbox,
    crossing: { id: 'directed-crosses-periodic-seam', points: crossing },
    foldback: { id: 'directed-folds-back-along-seam', points: foldback }
  };
}

export function makeSeamPickProbes() {
  return {
    inside: { name: 'directed_crossing_hole_inside_seam', u: 0, v: 0.47, expectHit: false },
    outside: { name: 'same_seam_interval_outside_hole', u: 0, v: 0.2, expectHit: true }
  };
}

export function makeFalseSeamGuardRing(phase = 'before') {
  const pair = makeSameBBoxSeamPair();
  const points = pair.crossing.points.map((p, i) =>
    phase === 'after' && i === 1 ? { ...p, v: 0.48 } : { ...p }
  );
  return {
    id: 'bbox-spans-seam-but-spatially-disjoint',
    role: 'guard',
    points,
    movedPoint: phase === 'after' ? { pointIndex: 1, from: { u: 0, v: 0.45 }, to: { u: 0, v: 0.48 } } : null
  };
}

function triangleRecord(id, points) {
  const bbox = ringBBox(points);
  let area = 0;
  const [a, b, c] = points;
  area = 0.5 * Math.abs((b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v));
  return { id, points, bbox, area, centroidUV: { u: (a.u + b.u + c.u) / 3, v: (a.v + b.v + c.v) / 3 } };
}

export function guardCandidateSourceAudit() {
  const targets = [
    triangleRecord('distant-central-face', [
      { u: 0.45, v: 0.45 }, { u: 0.55, v: 0.45 }, { u: 0.5, v: 0.55 }
    ]),
    triangleRecord('positive-seam-side-face', [
      { u: 0.02, v: 0.45 }, { u: 0.08, v: 0.45 }, { u: 0.05, v: 0.55 }
    ]),
    triangleRecord('negative-seam-side-face', [
      { u: 0.92, v: 0.45 }, { u: 0.98, v: 0.45 }, { u: 0.95, v: 0.55 }
    ])
  ];
  const edgeRecords = [];
  for (const face of targets) {
    for (let i = 0; i < 3; i++) {
      edgeRecords.push(edgeRecord(`${face.id}:edge-${i}`, face.points[i], face.points[(i + 1) % 3], { faceId: face.id }));
    }
  }
  const index = new CandidateIndex({ edges: edgeRecords, faces: targets });

  const snapshot = (phase) => {
    const guard = makeFalseSeamGuardRing(phase);
    const classification = classifyDirectedSeamLoop(guard.points);
    const edges = index.queryEdges(classification.queryRegions);
    const faces = index.queryFaces(classification.queryRegions);
    return {
      phase,
      movedPoint: guard.movedPoint,
      directedClass: classification.directedClass,
      locality: classification.locality,
      regions: classification.queryRegions,
      targets: targets.map((target) => {
        const edgeHits = edges.filter((edge) => edge.faceId === target.id);
        const faceHit = faces.some((face) => face.id === target.id);
        const rectangleHit =
          target.bbox.minU <= classification.bbox.maxU &&
          target.bbox.maxU >= classification.bbox.minU &&
          target.bbox.minV <= classification.bbox.maxV &&
          target.bbox.maxV >= classification.bbox.minV;
        return {
          target: target.id,
          rectangleSource: rectangleHit ? ['canonical-bbox-intersection'] : [],
          directedSources: faceHit ? ['directed-interval-index', ...new Set(edgeHits.flatMap((e) => e.candidateSources.map((s) => s.region)))] : ['excluded-by-directed-lift'],
          edgeCandidateCount: edgeHits.length,
          faceCandidate: faceHit
        };
      })
    };
  };

  return { before: snapshot('before'), after: snapshot('after') };
}

export function measureFalseOcclusionCull(options = { refineIterations: 4 }) {
  const guard = makeFalseSeamGuardRing('before');
  const definition = { outer: { id: 'outer-domain', points: DOMAIN_RING }, holes: [guard] };
  const fullPlan = planTrimming(definition, { densifyStep: 0.01 });
  const basePlan = planTrimming({ outer: { id: 'outer-domain', points: DOMAIN_RING } });
  const surface = new CylinderSurface();
  const baseMesh = buildTrimmedMesh(basePlan, surface, { refineIterations: options.refineIterations ?? 4 });
  const index = CandidateIndex.fromMesh(baseMesh);
  const classification = classifyDirectedSeamLoop(guard.points);

  let rectangleOccludedTriangleCount = 0;
  let rectangleOccludedArea = 0;
  let correctRemovedTriangleCount = 0;
  let correctRemovedArea = 0;
  let falseCulledTriangleCount = 0;
  let falseCulledArea = 0;
  const falseCulledTriangleIds = [];

  for (const face of index.faces) {
    const c = face.centroidUV;
    const rectangleOccluded =
      c.u >= classification.bbox.minU && c.u <= classification.bbox.maxU &&
      c.v >= classification.bbox.minV && c.v <= classification.bbox.maxV;
    const correctVisible = pointInEffectiveRegion(
      c,
      fullPlan.effectivePolygons.map((poly) => poly.rings.map((r) => r.points)),
      { boundary: false, tolerance: 1e-7 }
    );
    if (rectangleOccluded) {
      rectangleOccludedTriangleCount++;
      rectangleOccludedArea += face.area;
    }
    if (!correctVisible) {
      correctRemovedTriangleCount++;
      correctRemovedArea += face.area;
    }
    if (rectangleOccluded && correctVisible) {
      falseCulledTriangleCount++;
      falseCulledArea += face.area;
      if (falseCulledTriangleIds.length < 30) falseCulledTriangleIds.push(face.faceId);
    }
  }

  return {
    guardId: guard.id,
    classification,
    fullReclipArea: fullPlan.area.parameterPolygons,
    baseTriangleCount: index.faces.length,
    rectangleOccludedTriangleCount,
    rectangleOccludedArea,
    correctRemovedTriangleCount,
    correctRemovedArea,
    falseCulledTriangleCount,
    falseCulledArea,
    falseCulledTriangleIds,
    rule: 'Only rectangle-occluded triangles that remain visible in the full reclip are counted as erroneous culling.'
  };
}

export function makeAdversarialIntersectionInput() {
  const tinyHole = { id: 'tiny-hole', points: rectPoints(0.49994, 0.49994, 0.50006, 0.50006) };
  const tangentA = { id: 'tangent-a', points: rectPoints(0.18, 0.18, 0.30, 0.30) };
  const tangentB = { id: 'tangent-b', points: rectPoints(0.30, 0.30, 0.42, 0.42) };
  const sharedA = { id: 'shared-a', points: rectPoints(0.58, 0.18, 0.70, 0.30) };
  const sharedRight = { id: 'shared-right', points: rectPoints(0.70, 0.18, 0.82, 0.30) };
  const sharedTop = { id: 'shared-top', points: rectPoints(0.58, 0.30, 0.70, 0.42) };
  return {
    outer: { id: 'outer-domain', points: DOMAIN_RING },
    holes: [tinyHole, tangentA, tangentB, sharedA, sharedRight, sharedTop],
    coincidentEdgePairs: [
      [
        { u: 0.70, v: 0.18 }, { u: 0.70, v: 0.30 },
        { u: 0.70, v: 0.30 }, { u: 0.70, v: 0.18 }
      ],
      [
        { u: 0.58, v: 0.30 }, { u: 0.70, v: 0.30 },
        { u: 0.70, v: 0.30 }, { u: 0.58, v: 0.30 }
      ]
    ]
  };
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Number(process.hrtime.bigint() / 1000000n);
}

export function makeMovedInnerRingScenario() {
  const before = {
    outer: { id: 'outer-domain', points: DOMAIN_RING },
    holes: [{ id: 'moved-inner-ring', points: rectPoints(0.20, 0.42, 0.28, 0.58) }]
  };
  const after = {
    outer: { id: 'outer-domain', points: DOMAIN_RING },
    holes: [{ id: 'moved-inner-ring', points: rectPoints(0.30, 0.42, 0.38, 0.58) }]
  };
  return {
    before,
    after,
    movedHoleId: 'moved-inner-ring',
    delta: { u: 0.1, v: 0 },
    movePoint(point) {
      return { ...point, u: point.u + 0.1 };
    }
  };
}

export function benchmarkMovedInnerRing(options = {}) {
  const iterations = options.iterations ?? 25;
  const refineIterations = options.refineIterations ?? 3;
  const scenario = makeMovedInnerRingScenario();
  const beforeDefinition = scenario.before;
  const afterDefinition = scenario.after;
  const beforePlan = planTrimming(beforeDefinition, { densifyStep: 0.012 });
  const beforeMesh = buildTrimmedMesh(beforePlan, new CylinderSurface(), { refineIterations });
  const index = CandidateIndex.fromMesh(beforeMesh);
  const afterRing = afterDefinition.holes[0].points;

  const locality = evaluateClipLocality(afterRing, index, { periodic: false });
  const completeness = verifyCandidateCompleteness(afterRing, index, locality, { periodic: false });

  let globalStart = nowMs();
  let globalChecksum = 0;
  for (let i = 0; i < iterations; i++) {
    const plan = planTrimming(afterDefinition, { densifyStep: 0.012 });
    globalChecksum += plan.area.parameterPolygons;
  }
  const globalMs = nowMs() - globalStart;

  let localStart = nowMs();
  let localChecksum = 0;
  for (let i = 0; i < iterations; i++) {
    const result = evaluateClipLocality(afterRing, index, { periodic: false });
    localChecksum += result.candidateEdgeCount + result.exactIntersectionCount;
  }
  const localMs = nowMs() - localStart;

  const afterPlan = planTrimming(afterDefinition, { densifyStep: 0.012 });
  const afterMesh = buildTrimmedMesh(afterPlan, new CylinderSurface(), { refineIterations });
  const skipAudit = auditSkippedFaces({ mesh: beforeMesh, index, ring: afterRing, plan: afterPlan });

  return {
    iterations,
    timing: {
      globalFullClipMs: Number(globalMs.toFixed(3)),
      localInvalidationMs: Number(localMs.toFixed(3)),
      globalAverageMs: Number((globalMs / iterations).toFixed(4)),
      localAverageMs: Number((localMs / iterations).toFixed(4)),
      speedup: Number((globalMs / Math.max(localMs, 1e-9)).toFixed(2)),
      globalChecksum,
      localChecksum
    },
    candidateEdgeCount: locality.candidateEdgeCount,
    indexedEdgeCount: index.edges.length,
    exactIntersectionCount: locality.exactIntersectionCount,
    candidatePairCount: locality.candidatePairCount,
    completeness,
    skipAudit,
    falseDeletionArea: skipAudit.erroneousExclusionArea,
    erroneousDeletionArea: skipAudit.erroneousExclusionArea,
    generatedTriangleCount: afterMesh.stats.triangleCount,
    generatedTriangleArea: afterMesh.faces.reduce((sum, face) => sum + faceArea(afterMesh, face), 0),
    fullReclipArea: afterPlan.area.parameterPolygons,
    areaDifference: Math.abs(
      afterMesh.faces.reduce((sum, face) => sum + faceArea(afterMesh, face), 0) - afterPlan.area.parameterPolygons
    )
  };
}

function faceArea(mesh, face) {
  const [ia, ib, ic] = face.sourceVertices;
  const a = mesh.vertices[ia];
  const b = mesh.vertices[ib];
  const c = mesh.vertices[ic];
  return 0.5 * Math.abs((b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v));
}

export function compareGlobalAndLocal(options = {}) {
  return benchmarkMovedInnerRing(options);
}

export const SeamIntervalIndex = CandidateIndex;
export const EdgeCandidateIndex = CandidateIndex;
export const createSeamIndex = buildCandidateIndex;
export const queryDirectedClipLocality = evaluateClipLocality;
export const compareFullClipAndLocalInvalidation = compareGlobalAndLocal;
export const benchmarkIntervalIndex = compareGlobalAndLocal;
export const measureAccelerationFalseDeletion = measureFalseOcclusionCull;
export const measureRectangleBBoxFalseCull = measureFalseOcclusionCull;
export const verifyAccelerationWithFullReclip = benchmarkMovedInnerRing;
