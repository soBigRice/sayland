import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace } from 'three';

/** Shared by the viewport and FBX export, so the subtle grid texture stays identical. */
export function makeEdgeTexture(): DataTexture {
  const size = 64;
  const bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.min(x, y, size - 1 - x, size - 1 - y);
    const tone = distance === 0 ? 222 : distance === 1 ? 244 : 255;
    const offset = (y * size + x) * 4;
    bytes[offset] = bytes[offset + 1] = bytes[offset + 2] = tone; bytes[offset + 3] = 255;
  }
  const texture = new DataTexture(bytes, size, size, RGBAFormat);
  texture.name = 'Sayland voxel edge';
  texture.colorSpace = SRGBColorSpace; texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}
