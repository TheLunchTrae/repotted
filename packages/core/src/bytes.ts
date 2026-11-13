// Hashes, random names, and base64 on the web platform's own APIs, which
// Node has too, so the engine runs the same in a browser.

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The digest of `content`, in hex. Text is hashed as UTF-8. */
export async function hexDigest(algorithm: 'SHA-1' | 'SHA-256', content: Uint8Array | string): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  // A copy, since a view on shared memory is not something digest takes.
  return hex(new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(bytes))));
}

/** `count` random bytes, in hex. */
export function randomHex(count: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(count)));
}

// btoa and atob work on strings of one character a byte; a chunk keeps the
// argument list of fromCharCode short for a large file.
const chunk = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

/** Decodes base64 as GitHub sends it, with line breaks. */
export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}
