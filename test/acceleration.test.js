import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IntervalIndex1D,
  CandidateIndex,
  classifyDirectedSeamLoop,
  bboxesEqual,
  makeSameBBoxSeamPair,
  makeFalseSeamGuardRing,
  guardCandidateSourceAudit,
  measureFalseOcclusionCull,
  makeAdversarialIntersectionInput,
  evaluateClipLocality,
  verifyCandidateCompleteness,
  benchmarkMovedInnerRing
} from '../src/acceleration.js';
import { CommitGuard, createLatestTaskRunner } from '../src/commit.js';
import { planTrimming, DOMAIN_RING } from '../src/trim.js';
import { buildTrimmedMesh } from '../src/mesh.js';
import { CylinderSurface } from '../src/surface.js';
import { meshToOBJ, parseOBJMesh } from '../src/serialize.js';
import { rayFirstHit } from '../src/raycast.js';
import { segmentIntersectionDetails } from '../src/geometry2d.js';

test('directed loop information separates equal-bbox crossing and seam-fold rings', () => {
  const pair = makeSameBBoxSeamPair();
  assert.ok(bboxesEqual(
    { minU: 0, maxU: 0.9, minV: 0.4, maxV: 0.6 },
    pair.bbox
  ));

  const crossing = classifyDirectedSeamLoop(pair.crossing.points);
  const foldback = classifyDirectedSeamLoop(pair.foldback.points);

  assert.equal(crossing.directedClass, 'true-seam-crossing');
  assert.equal(crossing.locality, 'two-sided-joint');
  assert.equal(crossing.indexDecision, 'query-both-seam-sides-jointly');
  assert.equal(crossing.passages.length, 2);
  assert.deepEqual(crossing.queryRegions.map((r) => r.side).sort(), ['u=0', 'u=1']);

  assert.equal(foldback.directedClass, 'seam-foldback');
  assert.equal(foldback.locality, 'single-tile');
  assert.equal(foldback.indexDecision, 'query-one-directed-tile');
  assert.equal(foldback.passages.length, 0);
  assert.ok(foldback.seamEdges.length >= 1);
  assert.ok(foldback.queryRegions.some((r) => r.uInterval[0] >= 0.69));

  const crossingPlan = planTrimming({ holes: [pair.crossing] }, { densifyStep: 0.006 });
  const foldPlan = planTrimming({ holes: [pair.foldback] }, { densifyStep: 0.006 });
  assert.ok(crossingPlan.ok);
  assert.ok(foldPlan.ok);
  assert.ok(Math.abs((1 - crossingPlan.area.parameterPolygons) - Math.abs(crossing.liftedArea)) < 1e-9);
  assert.ok(Math.abs((1 - foldPlan.area.parameterPolygons) - Math.abs(foldback.liftedArea)) < 1e-9);
});

test('exported OBJ is pickable at one inside and one outside point on the seam', () => {
  const ring = makeSameBBoxSeamPair().crossing.points;
  const plan = planTrimming({
    outer: { id: 'outer-domain', points: DOMAIN_RING },
    holes: [{ id: 'seam-pick-hole', points: ring }]
  }, { densifyStep: 0.008 });
  const surface = new CylinderSurface();
  const mesh = buildTrimmedMesh(plan, surface, { refineIterations: 2 });
  const parsed = parseOBJMesh(meshToOBJ(mesh, { objectName: 'seam_pick' }));

  assert.ok(parsed.positions.length > 100);
  assert.equal(parsed.indices.length / 3, mesh.stats.triangleCount);

  const pick = (u, v) => {
    const y = (v - 0.5) * surface.height;
    const ray = surface.radialRay(u, y);
    return rayFirstHit(parsed.positions, parsed.indices, ray.origin, ray.direction);
  };

  assert.equal(pick(0, 0.47), null);
  assert.ok(pick(0, 0.2));
});

test('interval index finds every exact intersection for tiny, tangent, and coincident inputs', () => {
  const input = makeAdversarialIntersectionInput();
  const plan = planTrimming(input, { densifyStep: 0.01 });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));

  for (const [a, b, c, d] of input.coincidentEdgePairs) {
    assert.equal(segmentIntersectionDetails(a, b, c, d).type, 'coincident');
  }

  const tangent = segmentIntersectionDetails(
    { u: 0.18, v: 0.30 },
    { u: 0.30, v: 0.30 },
    { u: 0.30, v: 0.30 },
    { u: 0.30, v: 0.42 }
  );
  assert.equal(tangent.type, 'point');
  assert.equal(tangent.kind, 'tangent');

  for (const hole of input.holes) {
    const targetIndex = CandidateIndex.fromRings([
      input.outer,
      ...input.holes.filter((other) => other.id !== hole.id)
    ]);
    const locality = evaluateClipLocality(hole.points, targetIndex, { periodic: false });
    const completeness = verifyCandidateCompleteness(hole.points, targetIndex, locality, { periodic: false });
    assert.equal(completeness.complete, true, JSON.stringify(completeness.missed));
    assert.ok(locality.exactIntersectionCount <= locality.candidateEdgeCount * hole.points.length);
  }
});

test('moved inner ring local invalidation matches full reclip with zero erroneous exclusion', () => {
  const report = benchmarkMovedInnerRing({ iterations: 3, refineIterations: 2 });

  assert.ok(report.indexedEdgeCount > report.candidateEdgeCount);
  assert.ok(report.candidateEdgeCount > 0);
  assert.ok(report.exactIntersectionCount > 0);
  assert.equal(report.completeness.complete, true);
  assert.equal(report.completeness.missedIntersectionCount, 0);
  assert.equal(report.skipAudit.erroneouslyExcludedFaceCount, 0);
  assert.ok(report.skipAudit.erroneousExclusionArea < 1e-12);
  assert.ok(report.generatedTriangleArea > 0.9);
  assert.ok(report.areaDifference < 1e-9);
  assert.equal(typeof report.timing.globalFullClipMs, 'number');
  assert.equal(typeof report.timing.localInvalidationMs, 'number');
});

test('bbox-only seam guard records directed candidate sources and false cull area', () => {
  const sources = guardCandidateSourceAudit();
  for (const phase of ['before', 'after']) {
    const distant = sources[phase].targets.find((t) => t.target === 'distant-central-face');
    const positive = sources[phase].targets.find((t) => t.target === 'positive-seam-side-face');
    assert.ok(distant.rectangleSource.length > 0);
    assert.equal(distant.faceCandidate, false);
    assert.deepEqual(distant.directedSources, ['excluded-by-directed-lift']);
    assert.equal(positive.faceCandidate, true);
  }
  assert.ok(sources.after.movedPoint);

  const cull = measureFalseOcclusionCull({ refineIterations: 4 });
  assert.ok(cull.falseCulledTriangleCount > 5);
  assert.ok(cull.falseCulledArea > 0.02);
  assert.equal(cull.classification.directedClass, 'true-seam-crossing');
  assert.ok(cull.falseCulledTriangleIds.length > 0);
});

test('seam-directed query regions keep both seam boundaries complete', () => {
  const pair = makeSameBBoxSeamPair();
  for (const key of ['crossing', 'foldback']) {
    const ring = pair[key].points;
    const plan = planTrimming({
      outer: { id: 'outer-domain', points: DOMAIN_RING },
      holes: [{ id: key, points: ring }]
    }, { densifyStep: 0.02 });
    const mesh = buildTrimmedMesh(plan, new CylinderSurface(), { refineIterations: 1 });
    const index = CandidateIndex.fromMesh(mesh);
    const locality = evaluateClipLocality(ring, index, { periodic: true });
    const completeness = verifyCandidateCompleteness(ring, index, locality, { periodic: true });
    assert.equal(completeness.complete, true, JSON.stringify(completeness.missed));
    assert.ok(locality.exactIntersectionCount > 0);
  }
});

test('stale commit tokens cannot let an old mesh overwrite a newer selection', async () => {
  const guard = new CommitGuard();
  const oldToken = guard.begin('old-drag');
  const newToken = guard.begin('new-drag');

  assert.equal(oldToken.isCurrent(), false);
  assert.equal(newToken.isCurrent(), true);
  assert.equal(guard.commit(oldToken, { mesh: 'old' }).accepted, false);
  const accepted = guard.commit(newToken, { mesh: 'new' });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.value.mesh, 'new');

  let resolveOld;
  const runLatest = createLatestTaskRunner((label) => {
    if (label === 'old') {
      return new Promise((resolve) => { resolveOld = resolve; });
    }
    return Promise.resolve('new-result');
  });

  const oldRun = runLatest('old');
  const newRun = runLatest('new');
  const newResult = await newRun;
  assert.equal(newResult.accepted, true);
  assert.equal(newResult.result, 'new-result');

  resolveOld('old-result');
  const oldResult = await oldRun;
  assert.equal(oldResult.stale, true);
  assert.equal(oldResult.accepted, false);
});

test('one-dimensional interval tree returns all overlapping intervals', () => {
  const index = new IntervalIndex1D([
    { id: 'a', start: 0, end: 2 },
    { id: 'b', start: 1.5, end: 4 },
    { id: 'c', start: 5, end: 6 }
  ]);
  assert.deepEqual([...index.queryRange(1.8, 2.2)].sort(), ['a', 'b']);
  assert.deepEqual([...index.queryPoint(5.5)], ['c']);
  assert.equal(index.queryRange(10, 11).size, 0);
});
