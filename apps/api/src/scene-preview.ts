import { crc32, inflateSync } from 'node:zlib';
import { ApiError } from './errors.ts';

/** Accept only bounded, non-interlaced RGB/RGBA PNGs produced by the canvas capture. */
export function previewPng(dataUrl: string): Buffer {
  const image = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  const invalid = () => new ApiError('INVALID_PREVIEW', 400, '场景缩略图格式不完整，请重新退出保存。');
  if (image.length < 57 || image.length > 1_048_576 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid();
  let offset = 8, width = 0, height = 0, channels = 0, ended = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset), type = image.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > image.length) throw invalid();
    if (crc32(image.subarray(offset + 4, offset + 8 + length)) !== image.readUInt32BE(offset + 8 + length)) throw invalid();
    const chunk = image.subarray(offset + 8, offset + 8 + length);
    if (offset === 8 && type !== 'IHDR') throw invalid();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw invalid();
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); channels = chunk[9] === 6 ? 4 : chunk[9] === 2 ? 3 : 0;
      if (!width || !height || width > 640 || height > 384 || chunk[8] !== 8 || !channels || chunk[10] || chunk[11] || chunk[12]) throw invalid();
    } else if (type === 'IDAT') compressed.push(chunk);
    else if (type === 'IEND') { if (length || offset + 12 !== image.length) throw invalid(); ended = true; }
    else if (type === 'acTL') throw invalid();
    offset += length + 12;
  }
  if (!ended || !compressed.length || offset !== image.length) throw invalid();
  try {
    const rowBytes = width * channels + 1, expected = height * rowBytes;
    const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
    if (pixels.length !== expected) throw invalid();
    for (let y = 0; y < height; y++) if (pixels[y * rowBytes] > 4) throw invalid();
  } catch { throw invalid(); }
  return image;
}
