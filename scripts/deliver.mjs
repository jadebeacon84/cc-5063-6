import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeSeamDefinition, auditDefinition } from '../src/scenario.js';
import { meshToOBJ } from '../src/serialize.js';
import { auditToReport } from '../src/report.js';
import { planTrimming, DOMAIN_RING } from '../src/trim.js';
import { buildTrimmedMesh } from '../src/mesh.js';
import { CylinderSurface } from '../src/surface.js';
import { firstHitWithFace } from '../src/raycast.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'deliverables');
fs.mkdirSync(outDir, { recursive: true });

const phaseReports = {};
for (const phase of ['before', 'after']) {
  const definition = makeSeamDefinition(phase);
  const audit = auditDefinition(definition, { refineIterations: 5, parityGrid: 120 });
  if (!audit.ok) {
    console.error(audit.errors);
    throw new Error(`audit failed for ${phase}`);
  }
  fs.writeFileSync(path.join(outDir, `letter-I-seam.${phase}.trim.json`), JSON.stringify(definition, null, 2));
  fs.writeFileSync(path.join(outDir, `letter-I-seam.${phase}.obj`), meshToOBJ(audit.mesh, { objectName: `letter_I_${phase}` }));
  phaseReports[phase] = auditToReport(audit);
}

function rect(u0, v0, u1, v1) {
  return [
    { u: u0, v: v0 }, { u: u1, v: v0 },
    { u: u1, v: v1 }, { u: u0, v: v1 }
  ];
}
const surface = new CylinderSurface();
const equalA = buildTrimmedMesh(
  planTrimming({ outer: { id: 'outer-domain', points: DOMAIN_RING }, holes: [{ id: 'at-u25', points: rect(.20, .42, .28, .58) }] }),
  surface,
  { refineIterations: 3 }
);
const equalB = buildTrimmedMesh(
  planTrimming({ outer: { id: 'outer-domain', points: DOMAIN_RING }, holes: [{ id: 'at-u72', points: rect(.70, .42, .78, .58) }] }),
  surface,
  { refineIterations: 3 }
);
const y = (.5 - .5) * surface.height;
const hit = (mesh, u) => firstHitWithFace(mesh, surface.radialRay(u, y))?.faceId ?? null;

const report = {
  schema: 'parametric-trim-delivery-report/v1',
  generatedAt: new Date().toISOString(),
  policies: {
    orientation: 'outer CCW and holes CW after normalization; even-odd nesting parity',
    selfIntersection: 'reject; no automatic repair or full-surface export',
    periodicEdges: 'canonical UV jumps longer than 0.5 use shortest periodic unwrap before densification; near-seam rings are split canonically and traced in lifted coordinates',
    seam: 'u=0 and u=1 are periodic identities welded once; screen-projection coincidences are never welded',
    classification: 'boolean effective polygons + earcut boundary triangulation + ray parity and area cross-validation'
  },
  seamDrag: {
    description: 'Capital I stem edges begin at u=0.9625 and u=0.0375 across the seam; the positive-side edge is dragged to u=0.',
    before: phaseReports.before,
    after: phaseReports.after
  },
  equalAreaGuard: {
    areas: [0.08 * 0.16, 0.08 * 0.16],
    comment: 'Equal hole area does not imply equal topology; first inside-out radial hit differs.',
    holeAtU25: { rayU: .24, firstFace: hit(equalA, .24) },
    wallAtU74ForFirstModel: { rayU: .74, firstFace: hit(equalA, .74) },
    holeAtU74: { rayU: .74, firstFace: hit(equalB, .74) },
    wallAtU24ForSecondModel: { rayU: .24, firstFace: hit(equalB, .24) }
  }
};
fs.writeFileSync(path.join(outDir, 'seam-drag-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outDir,
  before: { holes: report.seamDrag.before.holeCount, rays: report.seamDrag.before.rays.map((r) => [r.name, r.firstHit?.faceId ?? null]) },
  after: { holes: report.seamDrag.after.holeCount, rays: report.seamDrag.after.rays.map((r) => [r.name, r.firstHit?.faceId ?? null]) }
}, null, 2));
