// Minimal ZIP reader (stored + deflate) — enough for EDINET's XBRL→CSV
// archives and the EDINET code list, without adding a dependency.
//
// Reads the central directory (authoritative sizes, works when the local
// header uses a data descriptor) and inflates each entry with node:zlib.

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  // EOCD is 22 bytes + up to 65535 bytes of comment, at the end of the file.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('zip: end-of-central-directory record not found (not a zip file?)');
}

/**
 * @param {Buffer} buf
 * @returns {{name: string, data: () => Buffer}[]}
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('zip: bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    // Bit 11 = UTF-8 names. EDINET archives use ASCII names, so latin1 is a
    // safe fallback for anything else.
    const name = rawName.toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.push({
      name,
      data() {
        if (buf.readUInt32LE(localOff) !== LOC_SIG) throw new Error(`zip: bad local header for ${name}`);
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`zip: unsupported compression method ${method} for ${name}`);
      },
    });
  }
  return entries;
}
