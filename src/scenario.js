import { DOMAIN_RING, planTrimming } from './trim.js';
import { CylinderSurface } from './surface.js';
import { buildTrimmedMesh } from './mesh.js';
import { firstHitWithFace } from './raycast.js';
import { crossValidate } from './metrics.js';

export const LETTER_I = Object.freeze({
  width: 0.24,
  height: 0.52,
  capHeight: 0.082,
  stemWidth: 0.075,
  centerV: 0.52
});

function canonicalU(s) {
  return ((s % 1) + 1) % 1;
}

export function letterIPoints({ rightStem = LETTER_I.stemWidth / 2 } = {}) {
  const W = LETTER_I.width;
  const H = LETTER_I.height;
  const cap = LETTER_I.capHeight;
  const t = LETTER_I.stemWidth;
  const cy = LETTER_I.centerV;
  const raw = [
    [-W / 2, -H / 2],
    [ W / 2, -H / 2],
    [ W / 2, -H / 2 + cap],
    [ rightStem, -H / 2 + cap],
    [ rightStem,  H / 2 - cap],
    [ W / 2,  H / 2 - cap],
    [ W / 2,  H / 2],
    [-W / 2,  H / 2],
    [-W / 2,  H / 2 - cap],
    [-t / 2,  H / 2 - cap],
    [-t / 2, -H / 2 + cap],
    [-W / 2, -H / 2 + cap]
  ];
  return raw.map(([s, y]) => ({ u: canonicalU(s), v: cy + y }));
}

export function seamDragValue(phase) {
  return phase === 'after' ? 0 : LETTER_I.stemWidth / 2;
}

export function makeSeamDefinition(phase = 'before') {
  const rightStem = seamDragValue(phase);
  const points = letterIPoints({ rightStem });
  return {
    format: 'parametric-trim-definition/v1',
    name: `cylinder-letter-I-${phase}-drag`,
    createdAt: '2026-11-25T00:00:00Z',
    surface: { type: 'cylinder', radius: 2, height: 2.4, periodicU: true },
    parameterDomain: { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
    seam: { u: 0, twinU: 1 },
    orientationPolicy: 'outer CCW, holes CW after normalization; even-odd nesting parity; self-intersecting loops are rejected',
    periodicEdgePolicy: 'u-period=1; canonical jumps longer than 0.5 are unwrapped by the shortest periodic delta, then split-at-seam in canonical UV and traced across the lifted seam',
    outer: {
      id: 'outer-domain',
      role: 'outer',
      points: DOMAIN_RING.map((p) => ({ ...p }))
    },
    holes: [
      {
        id: 'letter-I-hole',
        role: 'hole',
        letter: 'I',
        points
      }
    ],
    editHandles: {
      dragEdge: {
        contourId: 'letter-I-hole',
        edgeIndex: 3,
        meaning: 'right stem edge; starts across seam from left stem edge and is dragged exactly to u=0',
        beforeLiftU: LETTER_I.stemWidth / 2,
        afterLiftU: 0
      }
    },
    phase
  };
}

export function auditDefinition(definition, options = {}) {
  const plan = planTrimming(definition, { densifyStep: options.densifyStep ?? 0.012 });
  if (!plan.ok) {
    return { ok: false, errors: plan.errors, validation: plan };
  }
  const surface = new CylinderSurface(definition.surface ?? {});
  const mesh = buildTrimmedMesh(plan, surface, {
    refineIterations: options.refineIterations ?? 3
  });
  const validation = crossValidate(definition, plan, mesh, surface, { parityGrid: options.parityGrid ?? 120 });
  const y = (LETTER_I.centerV - 0.5) * surface.height;
  const t4 = LETTER_I.stemWidth / 4;
  const rays = [
    { name: 'wrapped_hole_negative_side', u: 1 - t4, v: LETTER_I.centerV },
    { name: 'positive_stem_side', u: t4, v: LETTER_I.centerV },
    { name: 'within_epsilon_of_seam', u: 0.0025, v: LETTER_I.centerV },
    { name: 'safe_control_wall', u: 0.38, v: LETTER_I.centerV }
  ].map((r) => {
    const ray = surface.radialRay(r.u, y);
    const hit = firstHitWithFace(mesh, ray);
    return { ...r, rayOrigin: ray.origin, rayDirection: ray.direction, firstHit: hit };
  });

  const makeProjectionLightPair = (name, u, v) => {
    const p = surface.mapUV(u, v);
    return [
      {
        name: `${name}_front_to_back`,
        u,
        alignedU: 1 - u,
        v,
        rayOrigin: [p[0], p[1], surface.radius + 1.2],
        rayDirection: [0, 0, -1]
      },
      {
        name: `${name}_back_to_front`,
        u: 1 - u,
        alignedU: u,
        v,
        rayOrigin: [p[0], p[1], -surface.radius - 1.2],
        rayDirection: [0, 0, 1]
      }
    ];
  };
  const lightRays = [
    ...makeProjectionLightPair('projection_overlap_stem_gap', t4, LETTER_I.centerV),
    ...makeProjectionLightPair('projection_overlap_cap_gap', 0.06, 0.30)
  ].map((r) => ({ ...r, firstHit: firstHitWithFace(mesh, { origin: r.rayOrigin, direction: r.rayDirection }) }));

  return {
    ok: mesh.ok,
    phase: definition.phase ?? 'custom',
    holeCount: plan.counts.topologicalHoles,
    counts: plan.counts,
    stats: mesh.stats,
    seamReport: {
      hole: plan.seamReport.holes[0] ? {
        touchesSeam: plan.seamReport.holes[0].touchesSeam,
        crossingCount: plan.seamReport.holes[0].crossingCount,
        canonicalStrategy: plan.seamReport.holes[0].canonicalStrategy,
        periodicStrategy: plan.seamReport.holes[0].periodicStrategy,
        seamEdgeCount: plan.seamReport.holes[0].seamEdges.length
      } : null
    },
    identity: {
      periodicPairCount: mesh.identity.periodicPairs.length,
      weldCount: mesh.identity.welds.length,
      redundantWeldCount: mesh.identity.redundantWelds.length,
      projectionOnlyPairCount: mesh.identity.projectionPairs.length,
      periodicPairs: mesh.identity.periodicPairs.slice(0, 12),
      projectionPairs: mesh.identity.projectionPairs.slice(0, 12)
    },
    validation: {
      parameterArea: validation.exactParamArea,
      triangleParamAreaError: validation.triangleAreaError,
      parityArea: validation.parityArea,
      parityAreaError: validation.parityAreaError,
      area3d: validation.area3d,
      area3dRelativeError: validation.area3dRelativeError,
      parameterBoundaryError: validation.parameterBoundaryError,
      surfaceBoundaryError3d: validation.surfaceBoundaryError3D,
      stretch: validation.stretch
    },
    rays,
    lightRays,
    mesh,
    plan,
    surface
  };
}
