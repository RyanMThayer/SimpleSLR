/**
 * Browser globals pdf.js references that Node runtimes lack. Text
 * extraction never renders, but depending on how the bundle is loaded
 * the rendering modules' top level code (e.g. `new DOMMatrix()`) can
 * still evaluate at import, so these must exist before pdf.js loads.
 * The matrix implements real 2D affine math in case any code path
 * uses it; Path2D and ImageData are inert placeholders.
 */

type MatrixLike = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

class NodeDOMMatrix implements MatrixLike {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | MatrixLike) {
    if (Array.isArray(init) && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    } else if (init && typeof init === "object" && "a" in init) {
      Object.assign(this, {
        a: init.a,
        b: init.b,
        c: init.c,
        d: init.d,
        e: init.e,
        f: init.f,
      });
    }
  }

  static fromMatrix(o?: Partial<MatrixLike>): NodeDOMMatrix {
    const m = new NodeDOMMatrix();
    Object.assign(m, {
      a: o?.a ?? 1,
      b: o?.b ?? 0,
      c: o?.c ?? 0,
      d: o?.d ?? 1,
      e: o?.e ?? 0,
      f: o?.f ?? 0,
    });
    return m;
  }

  multiplySelf(o: MatrixLike): this {
    const { a, b, c, d, e, f } = this;
    this.a = o.a * a + o.b * c;
    this.b = o.a * b + o.b * d;
    this.c = o.c * a + o.d * c;
    this.d = o.c * b + o.d * d;
    this.e = o.e * a + o.f * c + e;
    this.f = o.e * b + o.f * d + f;
    return this;
  }

  multiply(o: MatrixLike): NodeDOMMatrix {
    return new NodeDOMMatrix(this).multiplySelf(o);
  }

  translateSelf(tx = 0, ty = 0): this {
    this.e += this.a * tx + this.c * ty;
    this.f += this.b * tx + this.d * ty;
    return this;
  }

  translate(tx = 0, ty = 0): NodeDOMMatrix {
    return new NodeDOMMatrix(this).translateSelf(tx, ty);
  }

  scaleSelf(sx = 1, sy = sx): this {
    this.a *= sx;
    this.b *= sx;
    this.c *= sy;
    this.d *= sy;
    return this;
  }

  scale(sx = 1, sy = sx): NodeDOMMatrix {
    return new NodeDOMMatrix(this).scaleSelf(sx, sy);
  }

  invertSelf(): this {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) {
      this.a = this.b = this.c = this.d = this.e = this.f = NaN;
      return this;
    }
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  inverse(): NodeDOMMatrix {
    return new NodeDOMMatrix(this).invertSelf();
  }

  toString(): string {
    return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
  }
}

class NodePath2D {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  rect(): void {}
  arc(): void {}
  ellipse(): void {}
}

class NodeImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
}

/** Install the shims once; safe to call repeatedly. */
export function installPdfNodeShims(): void {
  const g = globalThis as Record<string, unknown>;
  g.DOMMatrix ??= NodeDOMMatrix;
  g.Path2D ??= NodePath2D;
  g.ImageData ??= NodeImageData;
}
