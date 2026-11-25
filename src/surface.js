export class CylinderSurface {
  constructor({ radius = 2, height = 2.4, theta0 = 0, vMin = 0, vMax = 1 } = {}) {
    this.type = 'cylinder';
    this.radius = radius;
    this.height = height;
    this.theta0 = theta0;
    this.vMin = vMin;
    this.vMax = vMax;
    this.periodicU = true;
  }

  normalizeU(u) {
    return ((u - this.theta0 / (Math.PI * 2)) % 1 + 1) % 1;
  }

  theta(u) {
    return this.theta0 + Math.PI * 2 * this.normalizeU(u);
  }

  mapUV(u, v) {
    const theta = this.theta(u);
    const y = (v - 0.5) * this.height;
    return [
      this.radius * Math.cos(theta),
      y,
      this.radius * Math.sin(theta)
    ];
  }

  normalUV(u, v) {
    const theta = this.theta(u);
    return [Math.cos(theta), 0, Math.sin(theta)];
  }

  metricScale() {
    return {
      uMetersPerUnit: Math.PI * 2 * this.radius,
      vMetersPerUnit: this.height,
      areaScale: Math.PI * 2 * this.radius * this.height
    };
  }

  radialRay(u, y = 0) {
    const theta = this.theta(u);
    return {
      origin: [0, y, 0],
      direction: [Math.cos(theta), 0, Math.sin(theta)]
    };
  }

  rayCylinderUV(ray, { requireInsideV = true } = {}) {
    const [ox, oy, oz] = ray.origin;
    const [dx, dy, dz] = ray.direction;
    const a = dx * dx + dz * dz;
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - this.radius * this.radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0 || a === 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    const candidates = [t1, t2].filter((t) => t > 1e-6).sort((x, y) => x - y);
    for (const t of candidates) {
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      let theta = Math.atan2(z, x) - this.theta0;
      if (theta < 0) theta += Math.PI * 2;
      if (theta >= Math.PI * 2) theta -= Math.PI * 2;
      const u = theta / (Math.PI * 2);
      const v = y / this.height + 0.5;
      if (!requireInsideV || (v >= this.vMin && v <= this.vMax)) return { u, v, t, point: [x, y, z] };
    }
    return null;
  }
}
