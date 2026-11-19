// Fetch's outstanding keepalive body limit is shared across requests. Reserve
// it across our analytics features; other scripts may still use browser capacity.
const MAX_KEEPALIVE_BYTES = 64 * 1024;
let outstandingBytes = 0;

export function reserveKeepalive(body: string | number, limit = MAX_KEEPALIVE_BYTES): (() => void) | null {
  const bytes = typeof body === "number" ? body : new TextEncoder().encode(body).byteLength;
  if (outstandingBytes + bytes > limit) return null;
  outstandingBytes += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    outstandingBytes -= bytes;
  };
}
