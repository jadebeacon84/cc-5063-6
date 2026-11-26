import { makeSeamDefinition, auditDefinition, letterIPoints, LETTER_I } from '../src/scenario.js';
import { validateDefinition } from '../src/trim.js';
import { meshToOBJ, downloadBlob } from '../src/serialize.js';
import { auditToReport } from '../src/report.js';
import { CommitGuard } from '../src/commit.js';
import { CandidateIndex, classifyDirectedSeamLoop, evaluateClipLocality } from '../src/acceleration.js';
import { triangleUVArea } from '../src/metrics.js';

const paramCanvas = document.querySelector('#paramCanvas');
const paramCtx = paramCanvas.getContext('2d');
const viewCanvas = document.querySelector('#viewCanvas');
const viewCtx = viewCanvas.getContext('2d');

const state = {
  definition: makeSeamDefinition('before'),
  audit: null,
  yaw: -0.72,
  pitch: 0.16,
  edit3D: false,
  drag: null,
  frame: 0,
  valid: true,
  selectedEdge: { contourIndex: 0, edgeIndex: 3 },
  commitGuard: new CommitGuard(),
  dragToken: null,
  faceIndex: null,
  contourIndex: null,
  locality: null
};

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function yieldForCancellation(token) {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    const handle = requestAnimationFrame(() => {
      token.signal.removeEventListener('abort', onAbort);
      resolve();
    });
    const onAbort = () => {
      cancelAnimationFrame(handle);
      resolve();
    };
    token.signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function rebuild(options = { refineIterations: 4, parityGrid: 80 }) {
  const token = options.token ?? state.commitGuard.begin(options.reason ?? 'rebuild');
  const validation = validateDefinition(state.definition);
  const status = document.querySelector('#paramStatus');
  const meshStatus = document.querySelector('#meshStatus');
  if (!validation.valid) {
    state.valid = false;
    status.textContent = `无效：${JSON.stringify(validation.errors[0]?.errors ?? validation.errors)}`;
    status.classList.add('error');
    meshStatus.textContent = '当前环无效：已阻止 OBJ / 审计导出';
    meshStatus.classList.add('error');
    if (token.isCurrent()) renderParameter();
    return { stale: false, valid: false };
  }
  if (options.yield !== false) await yieldForCancellation(token);
  if (!token.isCurrent()) return { stale: true, accepted: false };

  status.classList.remove('error');
  meshStatus.classList.remove('error');
  status.textContent = '有效';
  state.valid = true;
  const audit = auditDefinition(state.definition, options);
  if (!token.isCurrent()) return { stale: true, accepted: false };
  if (!audit.ok) {
    state.valid = false;
    status.textContent = '几何构建失败';
    status.classList.add('error');
    meshStatus.textContent = '几何构建失败：已阻止导出';
    meshStatus.classList.add('error');
    return { stale: false, valid: false };
  }
  const receipt = state.commitGuard.commit(token, audit);
  if (!receipt.accepted) return { stale: true, accepted: false };

  state.audit = audit;
  state.faceIndex = CandidateIndex.fromMesh(audit.mesh);
  state.contourIndex = CandidateIndex.fromRings([
    state.definition.outer ?? { id: 'outer-domain', points: [] },
    ...(state.definition.holes ?? [])
  ].filter(Boolean));
  meshStatus.textContent = `${audit.stats.triangleCount} 三角片 · ${audit.stats.spatialVertexCount} 空间顶点`;
  renderParameter();
  renderView();
  renderReport();
  return { stale: false, accepted: true, audit };
}

function scheduleRebuild() {
  state.dragToken = state.commitGuard.begin('drag-preview');
  if (state.frame) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    rebuild({ refineIterations: 3, parityGrid: 50, token: state.dragToken });
  });
}

function cancelScheduledRebuild() {
  if (state.frame) {
    cancelAnimationFrame(state.frame);
    state.frame = 0;
  }
  state.commitGuard.cancel();
  state.dragToken = null;
}

const padding = 46;
function uvToXY(u, v) {
  const w = paramCanvas.width;
  const h = paramCanvas.height;
  return {
    x: padding + u * (w - padding * 2),
    y: h - padding - v * (h - padding * 2)
  };
}
function xyToUV(x, y) {
  const w = paramCanvas.width;
  const h = paramCanvas.height;
  return {
    u: clamp((x - padding) / (w - padding * 2), -0.05, 1.05),
    v: clamp(1 - (y - padding) / (h - padding * 2), -0.05, 1.05)
  };
}
function eventCanvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height
  };
}

function canonicalEdgePieces(a, b) {
  const rawDelta = b.u - a.u;
  if (Math.abs(rawDelta) <= 0.5 + 1e-12) return [[a, b]];
  const delta = rawDelta - Math.round(rawDelta);
  const liftedBU = a.u + delta;
  const seamU = delta > 0 ? Math.floor(liftedBU) : Math.ceil(liftedBU);
  const t = (seamU - a.u) / delta;
  const cut = { u: seamU, v: a.v + (b.v - a.v) * t };
  if (delta > 0) {
    return [
      [a, { u: 1, v: cut.v }],
      [{ u: 0, v: cut.v }, b]
    ];
  }
  return [
    [a, { u: 0, v: cut.v }],
    [{ u: 1, v: cut.v }, b]
  ];
}

function traceContourEdges(ctx, points) {
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (const [p, q] of canonicalEdgePieces(a, b)) {
      const A = uvToXY(p.u, p.v);
      const B = uvToXY(q.u, q.v);
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
    }
  }
}

function addRingPath(ctx, ring) {
  ring.forEach((p, i) => {
    const xy = uvToXY(p.u, p.v);
    if (i === 0) ctx.moveTo(xy.x, xy.y);
    else ctx.lineTo(xy.x, xy.y);
  });
  ctx.closePath();
}

function renderParameter() {
  const ctx = paramCtx;
  const W = paramCanvas.width;
  const H = paramCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);

  const d0 = uvToXY(0, 0);
  const d1 = uvToXY(1, 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(d0.x, d1.y, d1.x - d0.x, d0.y - d1.y);

  if (state.audit?.plan?.effectivePolygons) {
    for (const poly of state.audit.plan.effectivePolygons) {
      ctx.beginPath();
      for (const ring of poly.rings) addRingPath(ctx, ring.points);
      ctx.fillStyle = 'rgba(34,197,94,0.28)';
      ctx.fill('evenodd');
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(21,128,61,0.9)';
      for (const ring of poly.rings) {
        ctx.beginPath();
        addRingPath(ctx, ring.points);
        ctx.stroke();
      }
    }
  }

  if (state.audit?.mesh?.boundaryEdges) {
    ctx.beginPath();
    for (const e of state.audit.mesh.boundaryEdges) {
      const a = state.audit.mesh.vertices[e.a];
      const b = state.audit.mesh.vertices[e.b];
      const pa = uvToXY(a.u, a.v);
      const pb = uvToXY(b.u, b.v);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.strokeStyle = 'rgba(15,23,42,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.save();
  ctx.setLineDash([9, 7]);
  ctx.strokeStyle = 'rgba(220,38,38,0.85)';
  ctx.lineWidth = 2;
  for (const u of [0, 1]) {
    const a = uvToXY(u, 0);
    const b = uvToXY(u, 1);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = '#b91c1c';
  ctx.font = '18px sans-serif';
  ctx.fillText('seam u=0 / u=1', padding + 8, padding - 16);

  state.definition.holes?.forEach((contour, ci) => {
    const pts = contour.points;
    ctx.beginPath();
    traceContourEdges(ctx, pts);
    ctx.strokeStyle = '#ea580c';
    ctx.lineWidth = 3;
    ctx.stroke();

    if (state.selectedEdge.contourIndex === ci) {
      const ei = state.selectedEdge.edgeIndex;
      const a = pts[ei];
      const bPoint = pts[(ei + 1) % pts.length];
      ctx.beginPath();
      for (const [p, q] of canonicalEdgePieces(a, bPoint)) {
        const A = uvToXY(p.u, p.v);
        const B = uvToXY(q.u, q.v);
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
      }
      ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 6; ctx.stroke();
    }

    pts.forEach((p) => {
      const xy = uvToXY(p.u, p.v);
      ctx.beginPath(); ctx.arc(xy.x, xy.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.strokeStyle = '#7c2d12'; ctx.lineWidth = 2; ctx.stroke();
    });
  });

  renderIndexStats();
}

function renderIndexStats() {
  const el = document.querySelector('#indexStats');
  if (!el) return;
  const contourIndex = state.selectedEdge.contourIndex;
  const ring = state.definition.holes?.[contourIndex]?.points;
  if (!ring || !state.faceIndex) {
    el.innerHTML = '<div class="metric"><span class="k">区间索引</span><span class="v">等待网格</span></div>';
    return;
  }

  const classification = classifyDirectedSeamLoop(ring);
  const candidateFaces = state.faceIndex.queryFaces(classification.queryRegions);
  const targetRings = [
    state.definition.outer,
    ...(state.definition.holes ?? []).filter((_, i) => i !== contourIndex)
  ].filter(Boolean);
  const targetIndex = CandidateIndex.fromRings(targetRings);
  let locality = null;
  try {
    locality = evaluateClipLocality(ring, targetIndex, { periodic: true });
  } catch {
    locality = null;
  }
  const totalFaces = state.faceIndex.faces.length;
  const area = state.audit ? triangleUVArea(state.audit.mesh) : 0;
  el.innerHTML = [
    metric('有向绕行', classification.directedClass),
    metric('求交决策', classification.indexDecision),
    metric('候选面片', `${candidateFaces.length} / ${totalFaces}`),
    metric('排除远处面片', totalFaces - candidateFaces.length),
    metric('候选边 / 精确求交', `${locality?.candidateEdgeCount ?? 0} / ${locality?.exactIntersectionCount ?? 0}`),
    metric('生成三角面积', area.toFixed(6)),
    metric('提交代数', String(state.commitGuard.generation))
  ].join('');
}

function pixelDistanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

paramCanvas.addEventListener('pointerdown', (event) => {
  const p = eventCanvasPoint(paramCanvas, event);
  const uv = xyToUV(p.x, p.y);
  paramCanvas.setPointerCapture(event.pointerId);
  const contourIndex = 0;
  const pts = state.definition.holes[contourIndex].points;
  for (let i = 0; i < pts.length; i++) {
    const q = uvToXY(pts[i].u, pts[i].v);
    if (Math.hypot(p.x - q.x, p.y - q.y) < 11) {
      state.drag = { mode: 'vertex', contourIndex, pointIndex: i };
      return;
    }
  }
  for (let i = 0; i < pts.length; i++) {
    const aPoint = pts[i];
    const bPoint = pts[(i + 1) % pts.length];
    for (const [uvA, uvB] of canonicalEdgePieces(aPoint, bPoint)) {
      const a = uvToXY(uvA.u, uvA.v);
      const b = uvToXY(uvB.u, uvB.v);
      if (pixelDistanceToSegment(p, a, b) < 10) {
        state.selectedEdge = { contourIndex, edgeIndex: i };
        state.drag = {
          mode: 'edge',
          contourIndex,
          edgeIndex: i,
          startUV: uv,
          original: [
            { ...pts[i] },
            { ...pts[(i + 1) % pts.length] }
          ]
        };
        renderParameter();
        return;
      }
    }
  }
});

paramCanvas.addEventListener('pointermove', (event) => {
  if (!state.drag) return;
  const p = eventCanvasPoint(paramCanvas, event);
  const uv = xyToUV(p.x, p.y);
  const drag = state.drag;
  const contour = state.definition.holes[drag.contourIndex];
  if (drag.mode === 'vertex') {
    const point = contour.points[drag.pointIndex];
    point.u = clamp(uv.u, 0, 1);
    point.v = clamp(uv.v, 0, 1);
  } else {
    const du = uv.u - drag.startUV.u;
    const dv = uv.v - drag.startUV.v;
    const i = drag.edgeIndex;
    const j = (i + 1) % contour.points.length;
    contour.points[i] = { ...drag.original[0], u: clamp(drag.original[0].u + du, 0, 1), v: clamp(drag.original[0].v + dv, 0, 1) };
    contour.points[j] = { ...drag.original[1], u: clamp(drag.original[1].u + du, 0, 1), v: clamp(drag.original[1].v + dv, 0, 1) };
  }
  scheduleRebuild();
  renderIndexStats();
});

async function endDrag(event) {
  if (!state.drag) return;
  state.drag = null;
  cancelScheduledRebuild();
  try { paramCanvas.releasePointerCapture(event.pointerId); } catch {}
  try { viewCanvas.releasePointerCapture(event.pointerId); } catch {}
  await rebuild({ refineIterations: 4, parityGrid: 90 });
}
paramCanvas.addEventListener('pointerup', endDrag);
paramCanvas.addEventListener('pointercancel', endDrag);

function project3D(point) {
  const [x0, y0, z0] = point;
  const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
  const x1 = x0 * cy + z0 * sy;
  const z1 = -x0 * sy + z0 * cy;
  const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
  const y1 = y0 * cp - z1 * sp;
  const z2 = y0 * sp + z1 * cp;
  const cameraZ = 7.2;
  const focal = 760;
  const depth = cameraZ - z2;
  const scale = focal / depth;
  return {
    x: viewCanvas.width / 2 + x1 * scale,
    y: viewCanvas.height / 2 + 20 - y1 * scale,
    z: z2,
    scale
  };
}

function renderView() {
  const ctx = viewCtx;
  const W = viewCanvas.width;
  const H = viewCanvas.height;
  ctx.clearRect(0, 0, W, H);
  const audit = state.audit;
  if (!audit) return;
  const mesh = audit.mesh;

  const projected = mesh.vertices.map((v) => project3D(v.xyz));
  const drawList = mesh.faces.map((face) => {
    const ps = face.sourceVertices.map((id) => projected[id]);
    return { face, ps, z: ps.reduce((s, p) => s + p.z, 0) / 3 };
  }).sort((a, b) => a.z - b.z);

  for (const item of drawList) {
    const { face, ps } = item;
    const n = mesh.vertices[face.sourceVertices[0]].normal;
    const light = [0.35, 0.72, 0.60];
    const nl = Math.hypot(...n) || 1;
    const intensity = 0.34 + 0.56 * Math.max(0, (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / nl);
    ctx.beginPath();
    ps.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = `hsl(193 62% ${Math.round(24 + intensity * 34)}%)`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(4,20,32,0.20)';
    ctx.lineWidth = 0.55;
    ctx.stroke();
  }

  ctx.lineWidth = 2.2;
  ctx.strokeStyle = '#ffb000';
  ctx.beginPath();
  for (const e of mesh.boundaryEdges) {
    const a = projected[e.a];
    const b = projected[e.b];
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  for (const ray of [...audit.rays, ...(audit.lightRays ?? [])]) {
    const o = ray.rayOrigin;
    const d = ray.rayDirection;
    const endT = ray.firstHit?.t ?? 8;
    const a = project3D(o);
    const b = project3D([o[0] + d[0] * endT, o[1] + d[1] * endT, o[2] + d[2] * endT]);
    ctx.save();
    ctx.setLineDash(ray.firstHit ? [] : [7, 6]);
    ctx.strokeStyle = ray.firstHit ? '#ff6b6b' : '#fde047';
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
    if (ray.firstHit) {
      const p = project3D(ray.firstHit.point);
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ff4d4d'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  if (state.edit3D) {
    for (const p of state.definition.holes[0].points) {
      const q = project3D(audit.surface.mapUV(p.u, p.v));
      ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2; ctx.stroke();
    }
  }
}

function screenRayToCylinder(event) {
  const rect = viewCanvas.getBoundingClientRect();
  const px = (event.clientX - rect.left) * viewCanvas.width / rect.width;
  const py = (event.clientY - rect.top) * viewCanvas.height / rect.height;
  const dx = (px - viewCanvas.width / 2) / 760;
  const dy = (viewCanvas.height / 2 + 20 - py) / 760;
  const camZ = 7.2;
  const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
  const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);

  const originView = [0, sp * camZ, cp * camZ];
  const dirView = [dx, cp * dy - sp, -sp * dy - cp];
  const inverseYaw = (x, y, z) => [cy * x - sy * z, y, sy * x + cy * z];
  const origin = inverseYaw(...originView);
  const d0 = inverseYaw(...dirView);
  const len = Math.hypot(...d0);
  return { origin, direction: d0.map((x) => x / len) };
}

viewCanvas.addEventListener('pointerdown', (event) => {
  const p = eventCanvasPoint(viewCanvas, event);
  viewCanvas.setPointerCapture(event.pointerId);
  if (state.edit3D && state.audit) {
    const points = state.definition.holes[0].points;
    let best = null;
    points.forEach((uv, i) => {
      const q = project3D(state.audit.surface.mapUV(uv.u, uv.v));
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < 14 && (!best || d < best.d)) best = { i, d };
    });
    if (best) {
      state.drag = { mode: 'view-vertex', pointIndex: best.i };
      return;
    }
  }
  state.drag = { mode: 'orbit', x: event.clientX, y: event.clientY };
});

viewCanvas.addEventListener('pointermove', (event) => {
  const drag = state.drag;
  if (!drag) return;
  if (drag.mode === 'orbit') {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    state.yaw += dx * 0.008;
    state.pitch = clamp(state.pitch + dy * 0.006, -1.15, 1.15);
    drag.x = event.clientX; drag.y = event.clientY;
    renderView();
  } else if (drag.mode === 'view-vertex' && state.edit3D) {
    const ray = screenRayToCylinder(event);
    const hit = state.audit.surface.rayCylinderUV(ray, { requireInsideV: false });
    if (hit) {
      const point = state.definition.holes[0].points[drag.pointIndex];
      point.u = clamp(hit.u, 0, 1);
      point.v = clamp(hit.v, 0, 1);
      scheduleRebuild();
      renderIndexStats();
    }
  }
});

viewCanvas.addEventListener('pointerup', async (event) => {
  const mode = state.drag?.mode;
  state.drag = null;
  try { viewCanvas.releasePointerCapture(event.pointerId); } catch {}
  if (mode === 'view-vertex') {
    cancelScheduledRebuild();
    await rebuild({ refineIterations: 4, parityGrid: 90 });
  }
});

function metric(k, v) {
  return `<div class="metric"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function renderReport() {
  const a = state.audit;
  if (!a) return;
  const v = a.validation;
  document.querySelector('#metrics').innerHTML = [
    metric('孔数', a.holeCount),
    metric('有效参数面积', `${(v.parameterArea * 100).toFixed(2)}%`),
    metric('奇偶面积误差', v.parityAreaError.toExponential(2)),
    metric('UV三角面积误差', v.triangleParamAreaError.toExponential(2)),
    metric('3D面积相对误差', `${(v.area3dRelativeError * 100).toFixed(2)}%`),
    metric('参数边界误差', v.parameterBoundaryError.toExponential(3)),
    metric('3D边界误差', v.surfaceBoundaryError3D?.toFixed(5) ?? v.surfaceBoundaryError3d?.toFixed(5)),
    metric('u向拉伸', `${v.stretch.uMetersPerUnit.toFixed(2)} m/uv`)
  ].join('');

  const insideRays = a.rays.map((r) => `
    <div class="ray ${r.firstHit ? 'hit' : 'light'}">
      <div class="name">${r.name} · u=${r.u.toFixed(4)}</div>
      ${r.firstHit
        ? `<div>首命中 <b>${r.firstHit.faceId}</b></div><div class="face">t=${r.firstHit.t.toFixed(4)} · centroid=(${r.firstHit.centroidUV.u.toFixed(3)}, ${r.firstHit.centroidUV.v.toFixed(3)})</div>`
        : '<div class="face">无命中：透光 / 未封错孔</div>'}
    </div>`).join('');
  const lightRays = (a.lightRays ?? []).map((r) => `
    <div class="ray ${r.firstHit ? 'hit' : 'light'}">
      <div class="name">${r.name}</div>
      ${r.firstHit
        ? `<div>投影对齐射线被 <b>${r.firstHit.faceId}</b> 阻挡</div><div class="face">t=${r.firstHit.t.toFixed(4)}</div>`
        : `<div class="face">无命中：u=${r.u.toFixed(4)} 与 u=${r.alignedU.toFixed(4)} 只是投影重合，间隙透光</div>`}
    </div>`).join('');
  document.querySelector('#rays').innerHTML = insideRays +
    '<div class="light-separator">投影重合点透光测试</div>' + lightRays;

  document.querySelector('#identity').textContent = JSON.stringify({
    periodicPairs: a.identity.periodicPairCount,
    welds: a.identity.weldCount,
    redundantWelds: a.identity.redundantWeldCount,
    projectionOnlyKeptSeparate: a.identity.projectionOnlyPairCount,
    seamStrategy: a.seamReport.hole
  }, null, 2);
}

document.querySelector('#resetBefore').addEventListener('click', () => {
  state.definition = makeSeamDefinition('before');
  rebuild();
});

document.querySelector('#animateDrag').addEventListener('click', async () => {
  state.definition = makeSeamDefinition('before');
  await rebuild({ refineIterations: 2, parityGrid: 30 });
  const start = performance.now();
  const duration = 850;
  const base = LETTER_I.stemWidth / 2;
  await new Promise((resolve) => {
    function frame(now) {
      const t = clamp((now - start) / duration, 0, 1);
      const eased = t < .5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
      state.definition.holes[0].points = letterIPoints({ rightStem: base * (1 - eased) });
      if (Math.random() < 0.55) rebuild({ refineIterations: 2, parityGrid: 20 });
      renderParameter();
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  state.definition = makeSeamDefinition('after');
  await rebuild({ refineIterations: 4, parityGrid: 90 });
});

document.querySelector('#edit3D').addEventListener('change', (e) => {
  state.edit3D = e.target.checked;
});
document.querySelector('#saveDefinition').addEventListener('click', () => {
  downloadBlob('parametric-trim.definition.json', JSON.stringify(state.definition, null, 2), 'application/json');
});
document.querySelector('#saveOBJ').addEventListener('click', () => {
  if (!state.audit || !state.valid) {
    document.querySelector('#meshStatus').textContent = '请先恢复有效裁环，再导出 OBJ';
    document.querySelector('#meshStatus').classList.add('error');
    return;
  }
  downloadBlob('trimmed-cylinder-letter.obj', meshToOBJ(state.audit.mesh), 'text/plain');
});
document.querySelector('#saveReport').addEventListener('click', () => {
  if (!state.audit || !state.valid) return;
  downloadBlob('trim-audit-report.json', JSON.stringify(auditToReport(state.audit), null, 2), 'application/json');
});

rebuild();
