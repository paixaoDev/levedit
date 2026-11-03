// Pegada do level num raster XZ + campo de distância (chamfer 8 vizinhos).
// Sem dependência do three: dá para testar no node.

export class Footprint {
  /**
   * @param {{minX,minZ,maxX,maxZ}} bounds caixa da pegada (sem margem)
   * @param {number} pad margem do raster em volta da caixa (m)
   * @param {number} cell tamanho da célula (m)
   */
  constructor(bounds, pad, cell) {
    this.bounds = { ...bounds };
    this.cell = cell;
    this.x0 = bounds.minX - pad;
    this.z0 = bounds.minZ - pad;
    this.nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX + pad * 2) / cell));
    this.nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ + pad * 2) / cell));
    this.inside = new Uint8Array(this.nx * this.nz);
    this.dist = null;
  }

  /**
   * Monta a partir de triângulos projetados em XZ (arrays [x0,z0,x1,z1,x2,z2,...]).
   */
  static fromTriangles(list, bounds, { pad = 60, maxCells = 420, minCell = 0.5 } = {}) {
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) + pad * 2;
    const fp = new Footprint(bounds, pad, Math.max(minCell, span / maxCells));
    for (const arr of list) for (let i = 0; i + 5 < arr.length; i += 6) fp.addTriangle(arr[i], arr[i + 1], arr[i + 2], arr[i + 3], arr[i + 4], arr[i + 5]);
    fp.computeDistance();
    return fp;
  }

  mark(x, z) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell);
    if (i >= 0 && j >= 0 && i < this.nx && j < this.nz) this.inside[j * this.nx + i] = 1;
  }

  addSegment(ax, az, bx, bz) {
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / (this.cell * 0.5)));
    for (let k = 0; k <= n; k++) this.mark(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
  }

  addTriangle(ax, az, bx, bz, cx, cz) {
    const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    // faces verticais (paredes) não têm área em planta: marca as arestas
    this.addSegment(ax, az, bx, bz);
    this.addSegment(bx, bz, cx, cz);
    this.addSegment(cx, cz, ax, az);
    if (Math.abs(area) < 1e-6) return;
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - this.x0) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((Math.max(ax, bx, cx) - this.x0) / c));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - this.z0) / c));
    const j1 = Math.min(this.nz - 1, Math.floor((Math.max(az, bz, cz) - this.z0) / c));
    const sg = area > 0 ? 1 : -1;
    for (let j = j0; j <= j1; j++) {
      const pz = this.z0 + (j + 0.5) * c;
      for (let i = i0; i <= i1; i++) {
        const px = this.x0 + (i + 0.5) * c;
        const e0 = ((bx - ax) * (pz - az) - (bz - az) * (px - ax)) * sg;
        const e1 = ((cx - bx) * (pz - bz) - (cz - bz) * (px - bx)) * sg;
        const e2 = ((ax - cx) * (pz - cz) - (az - cz) * (px - cx)) * sg;
        if (e0 >= 0 && e1 >= 0 && e2 >= 0) this.inside[j * this.nx + i] = 1;
      }
    }
  }

  /** Distância (m) de cada célula até a célula ocupada mais próxima. */
  computeDistance() {
    const { nx, nz, cell } = this;
    const D = new Float32Array(nx * nz);
    for (let k = 0; k < D.length; k++) D[k] = this.inside[k] ? 0 : 1e9;
    const a = cell, b = cell * Math.SQRT2;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        let v = D[k];
        if (i > 0) v = Math.min(v, D[k - 1] + a);
        if (j > 0) {
          v = Math.min(v, D[k - nx] + a);
          if (i > 0) v = Math.min(v, D[k - nx - 1] + b);
          if (i < nx - 1) v = Math.min(v, D[k - nx + 1] + b);
        }
        D[k] = v;
      }
    }
    for (let j = nz - 1; j >= 0; j--) {
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i;
        let v = D[k];
        if (i < nx - 1) v = Math.min(v, D[k + 1] + a);
        if (j < nz - 1) {
          v = Math.min(v, D[k + nx] + a);
          if (i < nx - 1) v = Math.min(v, D[k + nx + 1] + b);
          if (i > 0) v = Math.min(v, D[k + nx - 1] + b);
        }
        D[k] = v;
      }
    }
    this.dist = D;
  }

  /** Distância aproximada (m) do ponto até a pegada; fora do raster soma a distância até a borda. */
  distAt(x, z) {
    const c = this.cell;
    const fi = (x - this.x0) / c - 0.5, fj = (z - this.z0) / c - 0.5;
    const ci = Math.max(0, Math.min(this.nx - 1, fi)), cj = Math.max(0, Math.min(this.nz - 1, fj));
    const out = Math.hypot((fi - ci) * c, (fj - cj) * c);
    // bilinear entre as 4 células
    const i = Math.min(this.nx - 2, Math.floor(ci)), j = Math.min(this.nz - 2, Math.floor(cj));
    if (i < 0 || j < 0) return this.dist[0] + out;
    const tx = ci - i, tz = cj - j;
    const D = this.dist, n = this.nx;
    const v = (D[j * n + i] * (1 - tx) + D[j * n + i + 1] * tx) * (1 - tz) + (D[(j + 1) * n + i] * (1 - tx) + D[(j + 1) * n + i + 1] * tx) * tz;
    return v + out;
  }

  /** Fora do espaço jogável (com tolerância em metros)? */
  blocked(x, z, tol = 0.6) {
    return this.distAt(x, z) > tol + this.cell * 0.75;
  }
}

/** Ruído de valor 2D suave em [-1, 1], com seed. */
export function noise2D(seed = 1) {
  const h = (i, j) => {
    let n = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return ((n >>> 0) / 4294967296) * 2 - 1;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, z) => {
    const i = Math.floor(x), j = Math.floor(z);
    const fx = sm(x - i), fz = sm(z - j);
    const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  };
}
