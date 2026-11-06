/** node:crypto for the extension: only the random bytes msp's random.ts asks for. */
export function randomFillSync<T extends Uint8Array>(buf: T): T {
  for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(buf.length, i + 65536)));
  return buf;
}
