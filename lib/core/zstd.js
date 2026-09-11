/**
 * Multi-frame zstd decoding for DSH session logs.
 *
 * A DSH session log (<home>/sessions/<ws>/<session>/session*.jsonl.zstd) is a
 * container of independently compressed zstd frames concatenated together, one
 * frame per append batch. Node's zlib decodes only the first frame, so we walk
 * the frame structure ourselves to find every frame boundary and decompress the
 * frames one by one.
 */
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';

const ZSTD_MAGIC = 0xFD2FB528; // bytes 28 B5 2F FD on disk (little-endian read)
const DICT_ID_SIZE = [0, 1, 2, 4];
const FCS_SIZE = [0, 2, 4, 8];

/**
 * Byte length of the zstd frame starting at `offset`, or null when the bytes
 * there are not a well-formed frame header plus block sequence.
 */
export function frameSizeAt(buf, offset) {
  if (offset + 4 > buf.length) return null;
  if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return null;
  let p = offset + 4;
  if (p >= buf.length) return null;
  const descriptor = buf[p++];
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;
  const dictFlag = descriptor & 3;
  if (!singleSegment) p += 1; // Window_Descriptor
  p += DICT_ID_SIZE[dictFlag]; // Dictionary_ID
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : FCS_SIZE[fcsFlag]; // Frame_Content_Size
  for (;;) {
    if (p + 3 > buf.length) return null;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 0) p += size; // Raw_Block
    else if (type === 1) p += 1; // RLE_Block
    else if (type === 2) p += size; // Compressed_Block
    else return null; // reserved block type
    if (last) break;
    if (p > buf.length) return null;
  }
  if (hasChecksum) p += 4;
  if (p > buf.length) return null;
  return p - offset;
}

/** Offsets of every well-formed zstd frame found in `buf` (best effort). */
export function splitZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const size = frameSizeAt(buf, offset);
    if (size == null || size <= 0) break;
    frames.push({ offset, size });
    offset += size;
  }
  return frames;
}

/** Decode concatenated zstd frames into a UTF-8 string. */
export function decodeZstdMultiFrame(buf) {
  const parts = [];
  let offset = 0;
  while (offset < buf.length) {
    const size = frameSizeAt(buf, offset);
    if (size == null || size <= 0) break;
    parts.push(zlib.zstdDecompressSync(buf.subarray(offset, offset + size)));
    offset += size;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Decode a session log file into its JSONL text. */
export function decodeZstdFile(path) {
  return decodeZstdMultiFrame(readFileSync(path));
}
