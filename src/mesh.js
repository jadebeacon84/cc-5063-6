import earcut from '../vendor/earcut.js';
import { pointInPolygonWithHoles, distancePointToEdges, ringEdges } from './geometry2d.js';
import { findPeriodicPairs, findProjectionCoincidences } from './topology.js';

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Uint8Array(n);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
    return true;
  }
}

function minBoundaryDistance(p, rings) {
  let d = Infinity;
  for (const ring of rings) {
    for (const [a, b] of ringEdges(ring)) {
      const du = b.u - a.u;
      const dv = b.v - a.v;
      const l2 = du * du + dv * dv;
      let t = l2 ? ((p.u - a.u) * du + (p.v - a.v) * dv) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      d = Math.min(d, Math.hypot(p.u - (a.u + t * du), p.v - (a.v + t * dv)));
    }
  }
  return d;
}

function triangulatePolygon(polygon, options) {
  const vertices = [];
  const keyMap = new Map();
  const coords = [];
  const holeIndices = [];
  const localToGlobal = [];

  const add = (p, provenance = 'boundary') => {
    const key = `${Math.round(p.u * 1e9)}:${Math.round(p.v * 1e9)}`;
    if (keyMap.has(key)) return keyMap.get(key);
    const id = vertices.length;
    vertices.push({ id, u: p.u, v: p.v, provenance });
    keyMap.set(key, id);
    return id;
  };

  polygon.rings.forEach((ring, ringIndex) => {
    if (ringIndex > 0 || coords.length > 0) holeIndices.push(coords.length / 2);
    for (const p of ring.points) {
      coords.push(p.u, p.v);
      localToGlobal.push(add(p, ring.role === 'hole' ? 'hole-boundary' : 'outer-boundary'));
    }
  });

  const earIndices = earcut(coords, holeIndices);
  const triangles = [];
  for (let i = 0; i < earIndices.length; i += 3) {
    triangles.push({
      vertices: [
        localToGlobal[earIndices[i]],
        localToGlobal[earIndices[i + 1]],
        localToGlobal[earIndices[i + 2]]
      ],
      regionId: polygon.id
    });
  }

  let allVertices = vertices;
  let allTriangles = triangles;
  for (let round = 0; round < (options.refineIterations ?? 1); round++) {
    const midCache = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (midCache.has(key)) return midCache.get(key);
      const va = allVertices[a];
      const vb = allVertices[b];
      const id = allVertices.length;
      allVertices.push({
        id,
        u: (va.u + vb.u) * 0.5,
        v: (va.v + vb.v) * 0.5,
        provenance: 'midpoint'
      });
      midCache.set(key, id);
      return id;
    };
    const next = [];
    for (const tri of allTriangles) {
      const [a, b, c] = tri.vertices;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push({ vertices: [a, ab, ca], regionId: tri.regionId });
      next.push({ vertices: [ab, b, bc], regionId: tri.regionId });
      next.push({ vertices: [ca, bc, c], regionId: tri.regionId });
      next.push({ vertices: [ab, bc, ca], regionId: tri.regionId });
    }
    allTriangles = next;
  }

  return { vertices: allVertices, triangles: allTriangles };
}

export function buildTrimmedMesh(plan, surface, options = {}) {
  const opts = { refineIterations: 3, weldPeriodic: true, ...options };
  const vertices = [];
  const idMap = new Map();
  const triangles = [];

  for (const polygon of plan.effectivePolygons) {
    const part = triangulatePolygon(polygon, opts);
    const remap = new Map();
    for (const v of part.vertices) {
      const key = `${Math.round(v.u * 1e9)}:${Math.round(v.v * 1e9)}`;
      let id = idMap.get(key);
      if (id === undefined) {
        id = vertices.length;
        idMap.set(key, id);
        vertices.push({ ...v, id });
      }
      remap.set(v.id, id);
    }
    for (const tri of part.triangles) {
      triangles.push({ ...tri, vertices: tri.vertices.map((id) => remap.get(id)) });
    }
  }

  for (const v of vertices) {
    v.xyz = surface.mapUV(v.u, v.v);
    v.normal = surface.normalUV(v.u, v.v);
    v.projected = [v.xyz[0], v.xyz[1]];
    v.surfaceKey = `cylinder:${v.xyz.map((x) => x.toFixed(7)).join(',')}`;
  }

  const periodicPairs = findPeriodicPairs(vertices, { tolerance: options.seamTolerance ?? 2e-6 });
  const boundaryVertices = vertices.filter((v) => v.provenance.includes('boundary'));
  const projectionPairs = findProjectionCoincidences(boundaryVertices, { tolerance: 1e-6 });

  const dsu = new UnionFind(vertices.length);
  const welds = [];
  const redundantWelds = [];
  if (opts.weldPeriodic) {
    for (const pair of periodicPairs) {
      const merged = dsu.union(pair.a, pair.b);
      if (merged) welds.push({ ...pair, operation: 'union-periodic-pair' });
      else redundantWelds.push(pair);
    }
  }

  const rootToSpatial = new Map();
  const spatialVertices = [];
  for (let i = 0; i < vertices.length; i++) {
    const root = dsu.find(i);
    if (!rootToSpatial.has(root)) {
      const spatialIndex = spatialVertices.length;
      rootToSpatial.set(root, spatialIndex);
      const source = vertices[root];
      spatialVertices.push({
        spatialIndex,
        sourceId: root,
        xyz: source.xyz,
        normal: source.normal,
        periodicKey: periodicPairs.find((p) => p.a === root || p.b === root)?.key ?? null
      });
    }
    vertices[i].spatialIndex = rootToSpatial.get(root);
  }

  const indices = [];
  const faces = triangles.map((tri, faceIndex) => {
    const spatial = tri.vertices.map((id) => vertices[id].spatialIndex);
    indices.push(...spatial);
    const a = vertices[tri.vertices[0]];
    const b = vertices[tri.vertices[1]];
    const c = vertices[tri.vertices[2]];
    return {
      faceId: `F${String(faceIndex + 1).padStart(6, '0')}`,
      faceIndex,
      regionId: tri.regionId,
      sourceVertices: tri.vertices,
      spatialVertices: spatial,
      centroidUV: { u: (a.u + b.u + c.u) / 3, v: (a.v + b.v + c.v) / 3 }
    };
  });

  const degenerateWeldFaces = faces.filter((f) => new Set(f.spatialVertices).size < 3).map((f) => f.faceIndex);
  const positions = spatialVertices.map((v) => v.xyz);
  const normals = spatialVertices.map((v) => v.normal);

  const edgeIncidence = new Map();
  triangles.forEach((tri, faceIndex) => {
    const ids = tri.vertices;
    for (let i = 0; i < 3; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!edgeIncidence.has(key)) edgeIncidence.set(key, { a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      edgeIncidence.get(key).faces.push(faceIndex);
    }
  });
  const boundaryEdges = [...edgeIncidence.values()].filter((e) => e.faces.length === 1);

  return {
    ok: degenerateWeldFaces.length === 0,
    surface,
    vertices,
    spatialVertices,
    positions,
    normals,
    indices,
    triangles,
    faces,
    boundaryEdges,
    identity: {
      periodicPairs,
      welds,
      redundantWelds,
      projectionPairs,
      projectionOnlyKeptSeparate: projectionPairs.length,
      unionFind: dsu
    },
    stats: {
      sourceVertexCount: vertices.length,
      spatialVertexCount: spatialVertices.length,
      triangleCount: triangles.length,
      periodicPairCount: periodicPairs.length,
      weldCount: welds.length,
      projectionOnlyPairCount: projectionPairs.length,
      boundaryEdgeCount: boundaryEdges.length,
      degenerateWeldFaceCount: degenerateWeldFaces.length
    },
    degenerateWeldFaces
  };
}
