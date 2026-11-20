import { inflateSync } from "node:zlib";

export const MAX_PNG_BYTES = 4 * 1024 * 1024;
export const MAX_PNG_PIXELS = 8 * 1024 * 1024;
const signature = Buffer.from("89504e470d0a1a0a", "hex");
const format: Record<number, { channels: number; depths: readonly number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};
const adam7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export class PngInputError extends Error {
  constructor(readonly code: "HOST_PNG_INVALID" | "HOST_PNG_LIMIT", message: string) { super(message); }
}
const invalid = () => new PngInputError("HOST_PNG_INVALID", "Expected a complete, decodable static PNG");

function header(bytes: Buffer) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR") throw invalid();
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const depth = bytes[24], color = format[bytes[25]], interlace = bytes[28];
  if (!width || !height || !color?.depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) throw invalid();
  if (bytes.length > MAX_PNG_BYTES || width > 4096 || height > 4096 || width * height > MAX_PNG_PIXELS)
    throw new PngInputError("HOST_PNG_LIMIT", "PNG exceeds the supported byte or pixel limit");
  return { width, height, bitsPerPixel: depth * color.channels, interlace };
}

export function pngDimensions(bytes: Uint8Array) {
  const { width, height } = header(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { width, height };
}

/** Check the exact inflate bound before invoking the library's full pixel and CRC validation. */
export async function validateStaticPng(bytes: Buffer) {
  const { width, height, bitsPerPixel, interlace } = header(bytes);
  const payload: Buffer[] = [];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type) ||
        ["acTL", "fcTL", "fdAT"].includes(type) || (type === "IHDR" && offset !== 8)) throw invalid();
    if (type === "IDAT" && length > 0) payload.push(bytes.subarray(offset + 8, end - 4));
    offset = end;
    if (type === "IEND") { ended = length === 0; break; }
  }
  if (!ended || offset !== bytes.length || !payload.length) throw invalid();
  const passes = interlace ? adam7 : [[0, 0, 1, 1]];
  let rawBytes = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.ceil((width - x) / dx), rows = Math.ceil((height - y) / dy);
    if (columns > 0 && rows > 0) rawBytes += (Math.ceil(columns * bitsPerPixel / 8) + 1) * rows;
  }
  try {
    if (inflateSync(Buffer.concat(payload), { maxOutputLength: rawBytes }).length !== rawBytes) throw invalid();
    const { PNG } = await import("pngjs");
    PNG.sync.read(bytes, { checkCRC: true });
  } catch { throw invalid(); }
  return { width, height };
}
