// A Worker on a custom domain gets a Cloudflare 525 from fetch() to
// github.com, while connect() to the same host works:
// https://github.com/cloudflare/workerd/issues/7042. This sends one HTTP/1.1
// POST over connect() and answers with a Response, as fetch() would, so
// reverting the change that added it takes the Worker back to fetch() once
// Cloudflare fixes it.

import { connect } from 'cloudflare:sockets';

interface PostOverTlsInit {
  headers: Record<string, string>;
  body: URLSearchParams;
  signal: AbortSignal;
}

// GitHub's token answers are under a kilobyte; this bounds what the Worker holds.
const maxAnswerBytes = 64 * 1024;
const crlf = new Uint8Array([13, 10]);
const headEnd = new Uint8Array([13, 10, 13, 10]);
const headerName = /^[!#$%&'*+.^`|~\w-]+$/u;
const nullBodyStatuses = new Set([204, 205, 304]);

function concatenated(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function indexOf(bytes: Uint8Array, sought: Uint8Array, from = 0): number {
  for (let start = from; start + sought.length <= bytes.length; start += 1) {
    if (sought.every((byte, offset) => bytes[start + offset] === byte)) {
      return start;
    }
  }
  return -1;
}

// HTTP's head is bytes, not UTF-8, and Headers takes only byte strings.
function asByteString(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

interface AnswerHead {
  status: number;
  headers: Headers;
  bodyStart: number;
}

/** The final head, past any interim 1xx ones, or undefined while it is still coming. */
function readHead(bytes: Uint8Array): AnswerHead | undefined {
  let headStart = 0;
  for (;;) {
    const end = indexOf(bytes, headEnd, headStart);
    if (end === -1) {
      return undefined;
    }
    const [statusLine = '', ...headerLines] = asByteString(bytes.subarray(headStart, end)).split('\r\n');
    const status = /^HTTP\/1\.[01] ([1-5]\d\d)(?: |$)/u.exec(statusLine)?.[1];
    if (status === undefined) {
      throw new Error('The answer was not HTTP.');
    }
    headStart = end + headEnd.length;
    if (status.startsWith('1')) {
      continue;
    }
    const headers = new Headers();
    for (const line of headerLines) {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon);
      if (colon > 0 && headerName.test(name)) {
        headers.append(name, line.slice(colon + 1).trim());
      }
    }
    return { status: Number(status), headers, bodyStart: headStart };
  }
}

function isChunked(head: AnswerHead): boolean {
  const transferEncoding = head.headers.get('Transfer-Encoding');
  if (transferEncoding === null) {
    return false;
  }
  if (transferEncoding.trim().toLowerCase() !== 'chunked') {
    throw new Error('The answer used a transfer coding other than chunked.');
  }
  return true;
}

/** The whole body once its last chunk is in, or undefined while it isn't. */
function dechunked(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | undefined {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const sizeEnd = indexOf(bytes, crlf, offset);
    if (sizeEnd === -1) {
      return undefined;
    }
    const sizeField = (asByteString(bytes.subarray(offset, sizeEnd)).split(';')[0] ?? '').trim();
    if (!/^[\da-f]{1,8}$/iu.test(sizeField)) {
      throw new Error('The answer had a malformed chunk.');
    }
    const size = Number.parseInt(sizeField, 16);
    const chunkStart = sizeEnd + crlf.length;
    if (size === 0) {
      return concatenated(chunks);
    }
    const chunkEnd = chunkStart + size;
    if (bytes.length < chunkEnd + crlf.length) {
      return undefined;
    }
    if (bytes[chunkEnd] !== crlf[0] || bytes[chunkEnd + 1] !== crlf[1]) {
      throw new Error('The answer had a malformed chunk.');
    }
    chunks.push(bytes.subarray(chunkStart, chunkEnd));
    offset = chunkEnd + crlf.length;
  }
}

function contentLength(head: AnswerHead): number | undefined {
  const value = head.headers.get('Content-Length');
  if (value === null) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error('The answer had a malformed length.');
  }
  return Number(value);
}

/** The whole body once it is in, or undefined while more is to come. */
function completeBody(head: AnswerHead, received: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | undefined {
  if (isChunked(head)) {
    return dechunked(received);
  }
  const length = contentLength(head);
  if (length === undefined) {
    return undefined;
  }
  return received.length >= length ? received.subarray(0, length) : undefined;
}

function bodyThatFails(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      controller.error(error);
    },
  });
}

/** The body once the connection closed before completeBody found it whole. */
function bodyAtClose(head: AnswerHead, received: Uint8Array<ArrayBuffer>): BodyInit {
  // Only a body with no length and no chunks runs to the close.
  return isChunked(head) || contentLength(head) !== undefined
    ? bodyThatFails(new Error('The answer broke off.'))
    : received;
}

function abortReason(signal: AbortSignal): Error {
  // An aborted signal's reason is a DOMException, an Error, unless a caller
  // aborts with something else; the rejection below has to be an Error.
  return signal.reason instanceof Error ? signal.reason : new Error('The request was aborted.');
}

export async function postOverTls(url: string, init: PostOverTlsInit): Promise<Response> {
  const target = new URL(url);
  const requestBody = new TextEncoder().encode(init.body.toString());
  const requestHead = [
    `POST ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    ...Object.entries(init.headers).map(([name, value]) => `${name}: ${value}`),
    // fetch() decodes compressed answers; this reads only plain ones.
    'Accept-Encoding: identity',
    `Content-Length: ${requestBody.length}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');

  init.signal.throwIfAborted();
  const socket = connect({ hostname: target.hostname, port: 443 }, { secureTransport: 'on' });
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const rejectOnAbort = (): void => {
    reject(abortReason(init.signal));
  };
  init.signal.addEventListener('abort', rejectOnAbort, { once: true });
  const untilAborted = <T>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);

  try {
    const writer = socket.writable.getWriter();
    await untilAborted(writer.write(concatenated([new TextEncoder().encode(requestHead), requestBody])));
    writer.releaseLock();

    const reader = socket.readable.getReader();
    let bytes = new Uint8Array(0);
    let head: AnswerHead | undefined;
    let body: BodyInit | undefined;
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await untilAborted(reader.read());
      } catch (error) {
        if (head === undefined) {
          throw error;
        }
        body = bodyThatFails(error);
        break;
      }
      if (read.done) {
        break;
      }
      bytes = concatenated([bytes, read.value]);
      head ??= readHead(bytes);
      if (head === undefined) {
        if (bytes.length > maxAnswerBytes) {
          throw new Error('The answer was too long.');
        }
        continue;
      }
      const received = bytes.subarray(head.bodyStart);
      if (received.length > maxAnswerBytes) {
        body = bodyThatFails(new Error('The answer was too long.'));
        break;
      }
      try {
        body = completeBody(head, received);
      } catch (error) {
        body = bodyThatFails(error);
      }
      if (body !== undefined) {
        break;
      }
    }

    if (head === undefined) {
      throw new Error('The connection closed before an answer.');
    }
    // completeBody already threw for any framing bodyAtClose would throw on.
    body ??= bodyAtClose(head, bytes.subarray(head.bodyStart));
    // The body is in hand, so its framing headers no longer apply.
    head.headers.delete('Transfer-Encoding');
    head.headers.delete('Content-Length');
    return new Response(nullBodyStatuses.has(head.status) ? null : body, {
      status: head.status,
      headers: head.headers,
    });
  } finally {
    init.signal.removeEventListener('abort', rejectOnAbort);
    void socket.close().catch(() => undefined);
  }
}
