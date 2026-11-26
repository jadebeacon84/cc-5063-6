export function meshToOBJ(mesh, { objectName = 'trimmed_cylinder_letter' } = {}) {
  const lines = [];
  lines.push(`# Seam-aware trimmed parametric model`);
  lines.push(`o ${objectName}`);
  for (const p of mesh.spatialVertices) {
    lines.push(`v ${p.xyz[0].toFixed(8)} ${p.xyz[1].toFixed(8)} ${p.xyz[2].toFixed(8)}`);
  }
  for (const n of mesh.spatialVertices) {
    lines.push(`vn ${n.normal[0].toFixed(8)} ${n.normal[1].toFixed(8)} ${n.normal[2].toFixed(8)}`);
  }
  let vtIndex = 0;
  for (const face of mesh.faces) {
    const tokens = [];
    for (const sourceId of face.sourceVertices) {
      const v = mesh.vertices[sourceId];
      vtIndex++;
      lines.push(`vt ${v.u.toFixed(8)} ${v.v.toFixed(8)}`);
      const spatial = v.spatialIndex + 1;
      tokens.push(`${spatial}/${vtIndex}/${spatial}`);
    }
    lines.push(`f ${tokens.join(' ')}`);
  }
  lines.push(`# faces=${mesh.faces.length} spatial_vertices=${mesh.spatialVertices.length} welds=${mesh.stats.weldCount}`);
  return lines.join('\n') + '\n';
}

export function parseOBJMesh(text) {
  const positions = [];
  const indices = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('v ')) {
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      positions.push([parts[0], parts[1], parts[2]]);
    } else if (line.startsWith('f ')) {
      const tokens = line.trim().split(/\s+/).slice(1);
      const faceIndices = tokens.map((token) => {
        const vertexToken = token.split('/')[0];
        const parsed = Number(vertexToken);
        return parsed < 0 ? positions.length + parsed : parsed - 1;
      });
      for (let i = 1; i < faceIndices.length - 1; i++) {
        indices.push(faceIndices[0], faceIndices[i], faceIndices[i + 1]);
      }
    }
  }
  return { positions, indices };
}

export const parseOBJ = parseOBJMesh;
export const importOBJ = parseOBJMesh;

export function downloadBlob(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
