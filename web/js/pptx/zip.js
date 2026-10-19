// Reads a zip archive (a .pptx is one) in the browser. Small files are
// fetched whole; big ones (decks with videos) stay on the server and only
// the parts that are needed come over, with HTTP Range requests. Deflate
// goes through the browser's own DecompressionStream.

const utf8 = new TextDecoder();
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

const TAIL = 65536 + 22;   // the end record plus the longest comment
const WHOLE = 24 << 20;    // fetch smaller files in one go
const GAP = 256 << 10;     // merge part requests separated by less than this
const SPAN = 8 << 20;      // …into requests of at most this much

export class ZipError extends Error {}

async function failure(r) {
  let msg = r.statusText || `HTTP ${r.status}`;
  try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
  return new ZipError(msg);
}

export class Zip {
  constructor(url, signal) {
    this.url = url;
    this.signal = signal;
    this.buf = null;          // the whole file, when it was fetched whole
    this.raw = new Map();     // name → compressed bytes fetched ahead
    this.entries = new Map();
    this.lower = new Map();   // lowercase name → name (part names ignore case)
  }

  /** Open the archive at `url`: reads its directory, and the whole file if it's small. */
  static async open(url, { signal } = {}) {
    const z = new Zip(url, signal);
    let { bytes, total } = await z.fetch(-TAIL);
    if (bytes.length === total) z.buf = bytes;
    else if (total <= WHOLE) { z.buf = (await z.fetch(0, total)).bytes; bytes = z.buf; }
    z.size = total;
    z.readDirectory(bytes, total - bytes.length);
    if (!z.buf) await z.readDirectoryRemote();
    return z;
  }

  async fetch(start, end) {
    const range = start < 0 ? `bytes=${start}` : `bytes=${start}-${end - 1}`;
    const r = await fetch(this.url, { headers: { Range: range }, signal: this.signal, cache: 'no-store' });
    if (!r.ok) throw await failure(r);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (r.status !== 206) return { bytes, total: bytes.length };  // the server sent the whole file
    const m = /\/(\d+)\s*$/.exec(r.headers.get('Content-Range') || '');
    return { bytes, total: m ? +m[1] : bytes.length };
  }

  /** Find the end-of-directory record in `tail` (which starts at file offset `at`). */
  readDirectory(tail, at) {
    let e = -1;
    for (let i = tail.length - 22; i >= Math.max(0, tail.length - TAIL); i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { e = i; break; }
    }
    if (e < 0) {
      // An OLE file: a password-protected deck, or the old binary .ppt format.
      if (at === 0 && tail.length >= 8 && u32(tail, 0) === 0xe011cfd0) throw new ZipError('ole');
      throw new ZipError('not a zip');
    }
    let count = u16(tail, e + 10), size = u32(tail, e + 12), offset = u32(tail, e + 16);
    // Zip64: the real numbers are in a second record the locator points at.
    if ((offset === 0xffffffff || count === 0xffff) && e >= 20 && u32(tail, e - 20) === 0x07064b50) {
      const z = u64(tail, e - 12) - at;
      if (z >= 0 && u32(tail, z) === 0x06064b50) {
        count = u64(tail, z + 32);
        size = u64(tail, z + 40);
        offset = u64(tail, z + 48);
      }
    }
    this.count = count;
    this.dirAt = offset;
    this.dirSize = size;
    if (offset >= at && offset + size <= at + tail.length) this.parseDirectory(tail.subarray(offset - at, offset - at + size));
  }

  async readDirectoryRemote() {
    if (this.entries.size || !this.count) return;
    const { bytes } = await this.fetch(this.dirAt, this.dirAt + this.dirSize);
    this.parseDirectory(bytes);
  }

  parseDirectory(d) {
    let p = 0;
    for (let i = 0; i < this.count && p + 46 <= d.length; i++) {
      if (u32(d, p) !== 0x02014b50) throw new ZipError('damaged zip');
      let csize = u32(d, p + 20), usize = u32(d, p + 24), off = u32(d, p + 42);
      const nlen = u16(d, p + 28), xlen = u16(d, p + 30), clen = u16(d, p + 32);
      const name = utf8.decode(d.subarray(p + 46, p + 46 + nlen));
      if (csize === 0xffffffff || usize === 0xffffffff || off === 0xffffffff) {
        for (let x = p + 46 + nlen; x + 4 <= p + 46 + nlen + xlen;) {
          const id = u16(d, x), n = u16(d, x + 2);
          if (id === 1) {
            let q = x + 4;
            if (usize === 0xffffffff) { usize = u64(d, q); q += 8; }
            if (csize === 0xffffffff) { csize = u64(d, q); q += 8; }
            if (off === 0xffffffff) off = u64(d, q);
            break;
          }
          x += 4 + n;
        }
      }
      this.entries.set(name, { name, flags: u16(d, p + 8), method: u16(d, p + 10), csize, usize, off, nlen });
      this.lower.set(name.toLowerCase(), name);
      p += 46 + nlen + xlen + clen;
    }
  }

  entry(name) {
    return this.entries.get(name) || this.entries.get(this.lower.get(name.toLowerCase()));
  }

  has(name) { return !!this.entry(name); }
  sizeOf(name) { const e = this.entry(name); return e ? e.usize : 0; }

  /** Fetch the compressed data of several entries ahead, in as few requests as sensible. */
  async prefetch(names) {
    if (this.buf) return;
    const list = names.map(n => this.entry(n)).filter(e => e && !this.raw.has(e.name)).sort((a, b) => a.off - b.off);
    const groups = [];
    let g = null;
    for (const e of list) {
      const end = Math.min(this.size, e.off + 30 + e.nlen + 512 + e.csize);
      if (g && e.off - g.end <= GAP && end - g.start <= SPAN) { g.items.push(e); g.end = Math.max(g.end, end); }
      else groups.push(g = { start: e.off, end, items: [e] });
    }
    let next = 0;
    const worker = async () => {
      while (next < groups.length) {
        const grp = groups[next++];
        const { bytes } = await this.fetch(grp.start, grp.end);
        for (const e of grp.items) {
          const o = e.off - grp.start;
          if (o + 30 > bytes.length || u32(bytes, o) !== 0x04034b50) continue;
          const s = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
          if (s + e.csize <= bytes.length) this.raw.set(e.name, bytes.slice(s, s + e.csize));
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  async compressed(e) {
    if (this.buf) {
      const b = this.buf;
      if (u32(b, e.off) !== 0x04034b50) throw new ZipError('damaged zip');
      const s = e.off + 30 + u16(b, e.off + 26) + u16(b, e.off + 28);
      return b.subarray(s, s + e.csize);
    }
    if (this.raw.has(e.name)) {
      const r = this.raw.get(e.name);
      this.raw.delete(e.name);
      return r;
    }
    let { bytes } = await this.fetch(e.off, Math.min(this.size, e.off + 30 + e.nlen + 512 + e.csize));
    if (u32(bytes, 0) !== 0x04034b50) throw new ZipError('damaged zip');
    const s = 30 + u16(bytes, 26) + u16(bytes, 28);
    if (s + e.csize > bytes.length) bytes = (await this.fetch(e.off, e.off + s + e.csize)).bytes;
    return bytes.subarray(s, s + e.csize);
  }

  /** The contents of an entry, as bytes. */
  async bytes(name) {
    const e = this.entry(name);
    if (!e) throw new ZipError(`missing ${name}`);
    if (e.flags & 1) throw new ZipError('encrypted');
    const raw = await this.compressed(e);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new ZipError(`unsupported compression in ${name}`);
    const out = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(out).arrayBuffer());
  }

  async text(name) { return utf8.decode(await this.bytes(name)); }
}
