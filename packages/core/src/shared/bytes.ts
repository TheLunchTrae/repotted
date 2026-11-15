// Web platform APIs only, which Node has too, so the engine runs the same in a browser.

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hexDigest(algorithm: 'SHA-1' | 'SHA-256', content: Uint8Array | string): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  // A copy, since a view on shared memory is not something digest takes.
  return hex(new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(bytes))));
}

export function randomHex(byteCount: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

// String.fromCharCode takes each byte as an argument, and a large file would overflow the argument list.
const base64EncodingChunkByteLength = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += base64EncodingChunkByteLength) {
    binary += String.fromCharCode(...bytes.subarray(start, start + base64EncodingChunkByteLength));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}
