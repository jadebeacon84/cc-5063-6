export function auditToReport(audit) {
  if (!audit?.ok) {
    return { ok: false, errors: audit?.errors ?? ['audit-failed'] };
  }
  return {
    ok: true,
    phase: audit.phase,
    holeCount: audit.holeCount,
    counts: audit.counts,
    stats: audit.stats,
    seamReport: audit.seamReport,
    identity: {
      ...audit.identity,
      periodicPairs: audit.identity.periodicPairs.slice(0, 24),
      projectionPairs: audit.identity.projectionPairs.slice(0, 24)
    },
    validation: audit.validation,
    rays: audit.rays.map((ray) => ({
      name: ray.name,
      u: ray.u,
      v: ray.v,
      rayOrigin: ray.rayOrigin,
      rayDirection: ray.rayDirection,
      firstHit: ray.firstHit ? {
        triangleIndex: ray.firstHit.triangleIndex,
        faceId: ray.firstHit.faceId,
        regionId: ray.firstHit.regionId,
        distance: ray.firstHit.t,
        point: ray.firstHit.point,
        centroidUV: ray.firstHit.centroidUV
      } : null
    })),
    lightRays: (audit.lightRays ?? []).map((ray) => ({
      name: ray.name,
      u: ray.u,
      alignedU: ray.alignedU,
      v: ray.v,
      rayOrigin: ray.rayOrigin,
      rayDirection: ray.rayDirection,
      transmitsLight: ray.firstHit === null,
      firstHit: ray.firstHit ? {
        triangleIndex: ray.firstHit.triangleIndex,
        faceId: ray.firstHit.faceId,
        regionId: ray.firstHit.regionId,
        distance: ray.firstHit.t,
        point: ray.firstHit.point,
        centroidUV: ray.firstHit.centroidUV
      } : null
    }))
  };
}
