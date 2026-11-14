/**
 * Growable little-endian binary writer and bounds-checked reader. Every packet
 * in the game goes through these two classes; there is no JSON on the wire.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ByteWriter {
  private buf: Uint8Array<ArrayBuffer>;
  private view: DataView;
  private off = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.off;
  }

  private ensure(n: number): void {
    if (this.off + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.off + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this { this.ensure(1); this.view.setUint8(this.off, v); this.off += 1; return this; }
  u16(v: number): this { this.ensure(2); this.view.setUint16(this.off, v, true); this.off += 2; return this; }
  i8(v: number): this { this.ensure(1); this.view.setInt8(this.off, v); this.off += 1; return this; }
  i16(v: number): this { this.ensure(2); this.view.setInt16(this.off, v, true); this.off += 2; return this; }
  f32(v: number): this { this.ensure(4); this.view.setFloat32(this.off, v, true); this.off += 4; return this; }
  u32(v: number): this { this.ensure(4); this.view.setUint32(this.off, v, true); this.off += 4; return this; }
  f64(v: number): this { this.ensure(8); this.view.setFloat64(this.off, v, true); this.off += 8; return this; }

  /** UTF-8 string with a one-byte length prefix (truncated to 255 bytes). */
  str(s: string): this {
    const bytes = encoder.encode(s).subarray(0, 255);
    this.u8(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.off);
    this.off += bytes.length;
    return this;
  }

  /** Overwrite a u16 written earlier, for counts known only after the body. */
  patchU16(at: number, v: number): void {
    this.view.setUint16(at, v, true);
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.off);
  }
}

/** Reads throw RangeError past the end, which callers treat as a malformed packet. */
export class ByteReader {
  private readonly view: DataView;
  private off = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.byteLength - this.off;
  }

  u8(): number { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i8(): number { const v = this.view.getInt8(this.off); this.off += 1; return v; }
  i16(): number { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  f32(): number { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  u32(): number { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  f64(): number { const v = this.view.getFloat64(this.off, true); this.off += 8; return v; }

  str(): string {
    const n = this.u8();
    if (n > this.remaining) throw new RangeError('string overruns packet');
    const s = decoder.decode(this.data.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
}
