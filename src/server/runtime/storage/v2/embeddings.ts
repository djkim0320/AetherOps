export function float32EmbeddingToBlob(vector: Float32Array | readonly number[]): Buffer {
  const source = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  const buffer = Buffer.allocUnsafe(source.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let index = 0; index < source.length; index += 1) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, source[index], true);
  }
  return buffer;
}

export function blobToFloat32Embedding(blob: Uint8Array): Float32Array {
  if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`Invalid Float32 embedding BLOB length: ${blob.byteLength}`);
  }
  const source = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const output = new Float32Array(source.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return output;
}

export function normalizeFloat32Embedding(vector: Float32Array | readonly number[]): Float32Array {
  const normalized = vector instanceof Float32Array ? new Float32Array(vector) : Float32Array.from(vector);
  for (const value of normalized) {
    if (!Number.isFinite(value)) {
      throw new Error("Float32 embedding contains a non-finite value.");
    }
  }
  return normalized;
}
