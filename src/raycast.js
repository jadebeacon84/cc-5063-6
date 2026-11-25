export function rayFirstHit(positions, indices, origin, direction, { epsilon = 1e-9 } = {}) {
  let best = null;
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const dx = direction[0], dy = direction[1], dz = direction[2];
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;
    const v0 = positions[indices[i]] ?? positions[ia / 3];
    const v1 = positions[indices[i + 1]] ?? positions[ib / 3];
    const v2 = positions[indices[i + 2]] ?? positions[ic / 3];
    const a = Array.isArray(v0) ? v0 : [positions[ia], positions[ia + 1], positions[ia + 2]];
    const b = Array.isArray(v1) ? v1 : [positions[ib], positions[ib + 1], positions[ib + 2]];
    const c = Array.isArray(v2) ? v2 : [positions[ic], positions[ic + 1], positions[ic + 2]];

    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [
      dy * e2[2] - dz * e2[1],
      dz * e2[0] - dx * e2[2],
      dx * e2[1] - dy * e2[0]
    ];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < epsilon) continue;
    const inv = 1 / det;
    const tv = [ox - a[0], oy - a[1], oz - a[2]];
    const u = inv * (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]);
    if (u < 0 || u > 1) continue;
    const q = [
      tv[1] * e1[2] - tv[2] * e1[1],
      tv[2] * e1[0] - tv[0] * e1[2],
      tv[0] * e1[1] - tv[1] * e1[0]
    ];
    const v = inv * (dx * q[0] + dy * q[1] + dz * q[2]);
    if (v < 0 || u + v > 1) continue;
    const t = inv * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
    if (t > epsilon && (!best || t < best.t)) {
      best = {
        triangleIndex: i / 3,
        t,
        barycentric: { u, v, w: 1 - u - v },
        point: [ox + dx * t, oy + dy * t, oz + dz * t]
      };
    }
  }
  return best;
}

export function firstHitWithFace(mesh, ray) {
  const hit = rayFirstHit(mesh.positions, mesh.indices, ray.origin, ray.direction);
  if (!hit) return null;
  const face = mesh.faces[hit.triangleIndex];
  return {
    ...hit,
    faceId: face.faceId,
    regionId: face.regionId,
    centroidUV: face.centroidUV,
    spatialVertices: face.spatialVertices
  };
}
