/** Limites locais: nenhum decodificador ou serviço externo é chamado. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES + 64 * 1024;
export const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif",
};

/** Valida a assinatura do contêiner; não substitui a decodificação da imagem. */
export function hasImageSignature(bytes: Uint8Array, type: string): boolean {
  const matches = (offset: number, values: number[]) =>
    values.every((value, index) => bytes[offset + index] === value);
  const text = (offset: number, value: string) => matches(offset, [...value].map(c => c.charCodeAt(0)));
  if (type === "image/jpeg") return bytes.length >= 4 && matches(0, [255, 216, 255]);
  if (type === "image/png") return bytes.length >= 24 && matches(0, [137, 80, 78, 71, 13, 10, 26, 10]) && text(12, "IHDR");
  if (type === "image/webp") return bytes.length >= 20 && text(0, "RIFF") && text(8, "WEBP") &&
    (text(12, "VP8 ") || text(12, "VP8L") || text(12, "VP8X"));
  if (type === "image/avif" && bytes.length >= 16 && text(4, "ftyp")) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size < 16 || size > bytes.length || size % 4 !== 0) return false;
    if (text(8, "avif") || text(8, "avis")) return true;
    for (let offset = 16; offset < size; offset += 4) {
      if (text(offset, "avif") || text(offset, "avis")) return true;
    }
  }
  return false;
}

/** Confere bytes reais, inclusive sem Content-Length ou com valor subestimado. */
export async function readUploadBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
