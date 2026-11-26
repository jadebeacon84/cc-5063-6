import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IntervalIndex1D,
  CandidateIndex,
  classifyDirectedSeamLoop,
  makeSameBBoxSeamPair,
  makeFalseSeamGuardRing,
  guardCandidateSourceAudit,
  measureFalseOcclusionCull,
  makeAdversarialIntersectionInput,
  evaluateClipLocality,
  verifyCandidateCompleteness,
  benchmarkMovedInnerRing
} from '../src/acceleration.js';
import { planTrimming, DOMAIN_RING } from '../src/trim.js';
import { buildTrimmedMesh } from '../src/mesh.js';
import { CylinderSurface } from '../src/surface.js';
import { meshToOBJ, parseOBJMesh } from '../src/serialize.js';
import { rayFirstHit } from '../src/raycast.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'deliverables');
fs.mkdirSync(outDir, { recursive: true });

const pair = makeSameBBoxSeamPair();
const pairReport = {
  bbox: pair.bbox,
  crossing: classifyDirectedSeamLoop(pair.crossing.points),
  foldback: classifyDirectedSeamLoop(pair.foldback.points)
};

const pickRing = pair.crossing.points;
const pickPlan = planTrimming({
  outer: { id: 'outer-domain', points: DOMAIN_RING },
  holes: [{ id: 'seam-pick-hole', points: pickRing }]
}, { densifyStep: 0.008 });
const surface = new CylinderSurface();
const pickMesh = buildTrimmedMesh(pickPlan, surface, { refineIterations: 2 });
const obj = meshToOBJ(pickMesh, { objectName: 'seam_interval_pick' });
const parsedOBJ = parseOBJMesh(obj);
const pickAt = (u, v) => {
  const ray = surface.radialRay(u, (v - 0.5) * surface.height);
  const hit = rayFirstHit(parsedOBJ.positions, parsedOBJ.indices, ray.origin, ray.direction);
  return hit ? { triangleIndex: hit.triangleIndex, t: hit.t } : null;
};
const seamPicking = {
  exportedOBJVertices: parsedOBJ.positions.length,
  exportedOBJTriangles: parsedOBJ.indices.length / 3,
  insideHoleAtUV: { u: 0, v: 0.47, firstHit: pickAt(0, 0.47) },
  outsideHoleAtUV: { u: 0, v: 0.2, firstHit: pickAt(0, 0.2) }
};

const adversarialInput = makeAdversarialIntersectionInput();
const adversarialPlan = planTrimming(adversarialInput, { densifyStep: 0.01 });
const adversarialChecks = adversarialInput.holes.map((hole) => {
  const targetIndex = CandidateIndex.fromRings([
    adversarialInput.outer,
    ...adversarialInput.holes.filter((other) => other.id !== hole.id)
  ]);
  const locality = evaluateClipLocality(hole.points, targetIndex, { periodic: false });
  const completeness = verifyCandidateCompleteness(hole.points, targetIndex, locality, { periodic: false });
  return {
    holeId: hole.id,
    candidateEdgeCount: locality.candidateEdgeCount,
    exactIntersectionCount: locality.exactIntersectionCount,
    coincidentIntersectionCount: locality.coincidentIntersectionCount,
    tangentIntersectionCount: locality.tangentIntersectionCount,
    missedIntersectionCount: completeness.missedIntersectionCount,
    complete: completeness.complete
  };
});

const movedRing = benchmarkMovedInnerRing({ iterations: 40, refineIterations: 3 });
const falseOcclusion = measureFalseOcclusionCull({ refineIterations: 5 });
const candidateSources = guardCandidateSourceAudit();

const report = {
  schema: 'seam-interval-index-report/v1',
  generatedAt: new Date().toISOString(),
  policies: {
    broadPhase: '1D interval trees on U and V; AABB intersection is necessary but not sufficient for seam routing',
    seamDecision: 'Shortest lifted traversal, directed seam passages, and directed seam-edge interior side decide one tile versus two jointly queried sides',
    staleComputation: 'CommitGuard generation plus AbortSignal; stale resolutions are reported stale and cannot commit',
    falseCull: 'A triangle is erroneous culling only when bbox occlusion removes it but full-sheet reclip keeps it'
  },
  equalBBoxPair: {
    bbox: pairReport.bbox,
    crossing: {
      directedClass: pairReport.crossing.directedClass,
      locality: pairReport.crossing.locality,
      indexDecision: pairReport.crossing.indexDecision,
      passages: pairReport.crossing.passages.length,
      queryRegions: pairReport.crossing.queryRegions.map((r) => ({ id: r.id, side: r.side, uInterval: r.uInterval, vInterval: r.vInterval }))
    },
    foldback: {
      directedClass: pairReport.foldback.directedClass,
      locality: pairReport.foldback.locality,
      indexDecision: pairReport.foldback.indexDecision,
      seamEdges: pairReport.foldback.seamEdges.length,
      queryRegions: pairReport.foldback.queryRegions.map((r) => ({ id: r.id, side: r.side, uInterval: r.uInterval, vInterval: r.vInterval }))
    }
  },
  seamPicking,
  adversarial: {
    ok: adversarialPlan.ok,
    parameterArea: adversarialPlan.area.parameterPolygons,
    holes: adversarialChecks,
    prepared: {
      tinyHole: '1.2e-4 UV square',
      tangentEdges: 'corner tangent pair',
      coincidentEdgePairs: adversarialInput.coincidentEdgePairs.length
    }
  },
  movedInnerRing: {
    timing: movedRing.timing,
    indexedEdgeCount: movedRing.indexedEdgeCount,
    candidateEdgeCount: movedRing.candidateEdgeCount,
    exactIntersectionCount: movedRing.exactIntersectionCount,
    completeness: {
      bruteForceIntersectionCount: movedRing.completeness.bruteForceIntersectionCount,
      missedIntersectionCount: movedRing.completeness.missedIntersectionCount,
      complete: movedRing.completeness.complete
    },
    faceInvalidation: movedRing.skipAudit,
    falseDeletionArea: movedRing.falseDeletionArea,
    generatedTriangleCount: movedRing.generatedTriangleCount,
    generatedTriangleArea: movedRing.generatedTriangleArea,
    fullReclipArea: movedRing.fullReclipArea,
    areaDifference: movedRing.areaDifference
  },
  falseBBoxGuard: {
    ring: makeFalseSeamGuardRing('before'),
    candidateSources,
    culling: {
      baseTriangleCount: falseOcclusion.baseTriangleCount,
      rectangleOccludedTriangleCount: falseOcclusion.rectangleOccludedTriangleCount,
      rectangleOccludedArea: falseOcclusion.rectangleOccludedArea,
      correctRemovedTriangleCount: falseOcclusion.correctRemovedTriangleCount,
      correctRemovedArea: falseOcclusion.correctRemovedArea,
      falseCulledTriangleCount: falseOcclusion.falseCulledTriangleCount,
      falseCulledArea: falseOcclusion.falseCulledArea,
      falseCulledTriangleIds: falseOcclusion.falseCulledTriangleIds,
      rule: falseOcclusion.rule
    }
  }
};

const outFile = path.join(outDir, 'seam-interval-index-report.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outFile,
  pair: [report.equalBBoxPair.crossing.locality, report.equalBBoxPair.foldback.locality],
  pick: [seamPicking.insideHoleAtUV.firstHit, seamPicking.outsideHoleAtUV.firstHit?.triangleIndex ?? null],
  moved: {
    candidateEdges: movedRing.candidateEdgeCount,
    exact: movedRing.exactIntersectionCount,
    missed: movedRing.completeness.missedIntersectionCount,
    erroneousExclusionArea: movedRing.skipAudit.erroneousExclusionArea,
    speedup: movedRing.timing.speedup
  },
  falseCull: {
    count: falseOcclusion.falseCulledTriangleCount,
    area: Number(falseOcclusion.falseCulledArea.toFixed(6))
  }
}, null, 2));
