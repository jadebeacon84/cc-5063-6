import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeSeamDefinition,
  auditDefinition,
  LETTER_I
} from '../src/scenario.js';
import { planTrimming, validateDefinition, DOMAIN_RING } from '../src/trim.js';
import { buildTrimmedMesh } from '../src/mesh.js';
import { CylinderSurface } from '../src/surface.js';
import { firstHitWithFace } from '../src/raycast.js';
import { meshToOBJ } from '../src/serialize.js';
import { analyzeSeamRing } from '../src/topology.js';

function rectPoints(u0, v0, u1, v1) {
  return [
    { u: u0, v: v0 },
    { u: u1, v: v0 },
    { u: u1, v: v1 },
    { u: u0, v: v1 }
  ];
}

function rayAtUV(mesh, surface, u, v) {
  const y = (v - 0.5) * surface.height;
  return { firstHit: firstHitWithFace(mesh, surface.radialRay(u, y)) };
}

test('seam letter keeps one hole before and after dragging edge onto seam', () => {
  const before = auditDefinition(makeSeamDefinition('before'), { refineIterations: 4, parityGrid: 70 });
  const after = auditDefinition(makeSeamDefinition('after'), { refineIterations: 4, parityGrid: 70 });

  for (const audit of [before, after]) {
    assert.equal(audit.ok, true);
    assert.equal(audit.holeCount, 1);
    assert.equal(audit.stats.degenerateWeldFaceCount, 0);
    assert.ok(audit.stats.triangleCount > 100);
    assert.ok(audit.identity.weldCount > 0);
    assert.equal(audit.identity.redundantWeldCount, 0);

    const allPairs = audit.mesh.identity.periodicPairs;
    const weldKeys = new Set(allPairs.map((p) => [p.a, p.b].sort((x, y) => x - y).join(':')));
    assert.equal(weldKeys.size, allPairs.length);
    assert.equal(audit.identity.weldCount, allPairs.length);
    assert.equal(audit.identity.weldCount, audit.stats.weldCount);

    for (const p of audit.identity.projectionPairs) {
      assert.equal(p.weld, false);
      assert.notEqual(
        audit.mesh.vertices[p.a].spatialIndex,
        audit.mesh.vertices[p.b].spatialIndex
      );
      assert.ok(p.depthDistance > 0.01);
    }
  }

  const ray = (audit, name) => audit.rays.find((r) => r.name === name);
  assert.equal(ray(before, 'wrapped_hole_negative_side').firstHit, null);
  assert.equal(ray(before, 'positive_stem_side').firstHit, null);
  assert.ok(ray(before, 'safe_control_wall').firstHit.faceId);

  assert.equal(ray(after, 'wrapped_hole_negative_side').firstHit, null);
  assert.ok(ray(after, 'positive_stem_side').firstHit.faceId);
  assert.ok(ray(after, 'within_epsilon_of_seam').firstHit.faceId);
  assert.ok(ray(after, 'safe_control_wall').firstHit.faceId);

  assert.equal(before.lightRays.length, 4);
  for (const lightRay of before.lightRays) {
    assert.equal(lightRay.firstHit, null, `${lightRay.name} must pass through the projection-only gap`);
  }
  assert.ok(before.mesh.identity.projectionPairs.some((p) => {
    const au = before.mesh.vertices[p.a].u;
    const bu = before.mesh.vertices[p.b].u;
    return Math.abs(Math.min(au, bu) - 0.0375) < 1e-6 &&
      Math.abs(Math.max(au, bu) - 0.9625) < 1e-6 &&
      p.depthDistance > 0.5;
  }));
  for (const lightRay of after.lightRays) {
    if (lightRay.name.includes('stem')) {
      assert.ok(lightRay.firstHit, 'dragging the positive stem edge onto the seam seals this projection-aligned ray');
    } else {
      assert.equal(lightRay.firstHit, null, 'unwelded projection-only cap points must retain a light gap');
    }
  }
});

test('seam topology reports split and cross-seam tracing', () => {
  const beforeDef = makeSeamDefinition('before');
  const afterDef = makeSeamDefinition('after');
  const before = analyzeSeamRing(beforeDef.holes[0].points);
  const after = analyzeSeamRing(afterDef.holes[0].points);

  assert.equal(before.canonicalStrategy, 'split-at-seam');
  assert.equal(before.periodicStrategy, 'trace-across-seam');
  assert.ok(before.crossingCount >= 2);
  assert.equal(after.canonicalStrategy, 'split-at-seam');
  assert.ok(after.seamEdges.length >= 1);
});

test('triangle sum, ray parity, and boundary errors cross-validate', () => {
  const audit = auditDefinition(makeSeamDefinition('before'), { refineIterations: 4, parityGrid: 90 });
  assert.ok(audit.validation.triangleParamAreaError < 1e-9);
  assert.ok(audit.validation.parityAreaError < 0.004);
  assert.ok(audit.validation.area3dRelativeError < 0.06);
  assert.ok(audit.validation.parameterBoundaryError < 1e-6);
  assert.ok(audit.validation.surfaceBoundaryError3d < 0.012);
});

test('equal-area holes in different places have different first-hit faces', () => {
  const surface = new CylinderSurface();
  const make = (u0) => ({
    outer: { id: 'outer-domain', points: DOMAIN_RING },
    holes: [{ id: 'same-area', points: rectPoints(u0, 0.42, u0 + 0.08, 0.58) }]
  });
  const left = buildTrimmedMesh(planTrimming(make(0.20)), surface, { refineIterations: 2 });
  const right = buildTrimmedMesh(planTrimming(make(0.70)), surface, { refineIterations: 2 });

  assert.ok(Math.abs(left.faces.length - right.faces.length) < 20);
  assert.equal(rayAtUV(left, surface, 0.24, 0.5).firstHit, null);
  assert.ok(rayAtUV(left, surface, 0.74, 0.5).firstHit);
  assert.equal(rayAtUV(right, surface, 0.74, 0.5).firstHit, null);
  assert.ok(rayAtUV(right, surface, 0.24, 0.5).firstHit);
});

test('hole close to outer boundary retains the thin valid strip', () => {
  const def = {
    outer: { id: 'outer-domain', points: DOMAIN_RING },
    holes: [{ id: 'near-rim', points: rectPoints(0.25, 0.006, 0.75, 0.22) }]
  };
  const plan = planTrimming(def);
  assert.equal(plan.ok, true);
  assert.ok(Math.abs(plan.area.parameterPolygons - (1 - 0.5 * 0.214)) < 1e-9);

  const surface = new CylinderSurface();
  const mesh = buildTrimmedMesh(plan, surface, { refineIterations: 3 });
  assert.equal(mesh.degenerateWeldFaces.length, 0);
  const stripHit = rayAtUV(mesh, surface, 0.5, 0.003).firstHit;
  const holeMiss = rayAtUV(mesh, surface, 0.5, 0.11).firstHit;
  assert.ok(stripHit, 'thin strip between hole and outer boundary must exist');
  assert.equal(holeMiss, null);
});

test('slender valid region between holes remains ray-hittable', () => {
  const def = {
    outer: { id: 'outer-domain', points: DOMAIN_RING },
    holes: [
      { id: 'left-big', points: rectPoints(0.08, 0.12, 0.4985, 0.88) },
      { id: 'right-big', points: rectPoints(0.5015, 0.12, 0.92, 0.88) }
    ]
  };
  const plan = planTrimming(def);
  assert.equal(plan.ok, true);
  const mesh = buildTrimmedMesh(plan, new CylinderSurface(), { refineIterations: 3 });
  assert.ok(mesh.stats.triangleCount > 100);
  const hit = rayAtUV(mesh, mesh.surface, 0.5, 0.5).firstHit;
  assert.ok(hit);
  assert.ok(hit.t < mesh.surface.radius + 1e-5);
});

test('degenerate and self-intersecting loops are rejected, not silently untrimmed', () => {
  const degenerate = validateDefinition({
    holes: [{ id: 'bad', points: [{ u: .2, v: .2 }, { u: .3, v: .2 }, { u: .25, v: .2 }] }]
  });
  assert.equal(degenerate.valid, false);
  assert.ok(degenerate.errors.length);
  assert.equal(planTrimming({ holes: [{ points: [{ u: 0, v: 0 }, { u: 1, v: 0 }] }] }).ok, false);

  const bowtie = [
    { u: .2, v: .2 }, { u: .8, v: .8 },
    { u: .8, v: .2 }, { u: .2, v: .8 }
  ];
  const check = validateDefinition({ holes: [{ id: 'bow', points: bowtie }] });
  assert.equal(check.valid, false);
  assert.ok(JSON.stringify(check.errors).includes('self-intersecting'));
});

test('orientation and nesting parity are explicit', () => {
  const def = {
    outer: { id: 'outer', points: rectPoints(0, 0, 1, 1).reverse() },
    holes: [{ id: 'h', points: rectPoints(.2, .2, .8, .8) }]
  };
  const result = validateDefinition(def);
  assert.equal(result.valid, true);
  assert.ok(result.outer.points);
  const outerArea = result.outer.normalized.reduce((a, p, i, arr) => {
    const q = arr[(i + 1) % arr.length];
    return a + p.u * q.v - q.u * p.v;
  }, 0) / 2;
  const holeArea = result.holes[0].normalized.reduce((a, p, i, arr) => {
    const q = arr[(i + 1) % arr.length];
    return a + p.u * q.v - q.u * p.v;
  }, 0) / 2;
  assert.ok(outerArea > 0);
  assert.ok(holeArea < 0);
});

test('uv and 3d distances are separate and anisotropic cylinder stretch is large', () => {
  const surface = new CylinderSurface({ radius: 2, height: 2.4 });
  const du = 0.01;
  const uvDistance = du;
  const p0 = surface.mapUV(0.3, 0.5);
  const p1 = surface.mapUV(0.3 + du, 0.5);
  const d3 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  assert.ok(Math.abs(d3 / uvDistance - surface.metricScale().uMetersPerUnit) < 0.01);
  assert.ok(d3 > 0.12);
});

test('OBJ export contains the actual trimmed faces', () => {
  const audit = auditDefinition(makeSeamDefinition('after'), { refineIterations: 2, parityGrid: 30 });
  const obj = meshToOBJ(audit.mesh);
  const faceLines = obj.split('\n').filter((line) => line.startsWith('f '));
  assert.equal(faceLines.length, audit.mesh.faces.length);
  assert.ok(obj.includes(`o trimmed_cylinder_letter`));
  assert.ok(audit.mesh.faces.length < 5000);
});
