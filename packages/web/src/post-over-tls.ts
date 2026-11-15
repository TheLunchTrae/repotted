// A Worker on a custom domain gets a Cloudflare 525 from fetch() to
// github.com, while connect() to the same host works:
// https://github.com/cloudflare/workerd/issues/7042. This sends one HTTP/1.1
// POST over connect() and answers with a Response, as fetch() would, so the
// Worker can go back to fetch() by changing one call once Cloudflare fixes it.

import { connect } from 'cloudflare:sockets';

interface PostOverTlsInit {
  headers: Record<string, string>;
  body: URLSearchParams;
  signal: AbortSignal;
}

// GitHub's token answers are well under a kilobyte; a longer one is not one.
const maxAnswerBytes = 64 * 1024;
const headEnd = new Uint8Array([13, 10, 13, 10]);

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

interface AnswerHead {
  status: number;
  headers: Headers;
  bodyStart: number;
}

function readHead(bytes: Uint8Array): AnswerHead | undefined {
  const end = indexOf(bytes, headEnd);
  if (end === -1) {
    return undefined;
  }
  const [statusLine = '', ...headerLines] = new TextDecoder().decode(bytes.subarray(0, end)).split('\r\n');
  const status = /^HTTP\/1\.[01] ([2-5]\d\d)(?: |$)/u.exec(statusLine)?.[1];
  if (status === undefined) {
    throw new Error('The answer was not HTTP.');
  }
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }
  return { status: Number(status), headers, bodyStart: end + headEnd.length };
}

const crlf = new Uint8Array([13, 10]);

/** The whole body once its last chunk is in, or undefined while it isn't. */
function dechunked(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | undefined {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const sizeEnd = indexOf(bytes, crlf, offset);
    if (sizeEnd === -1) {
      return undefined;
    }
    const sizeField = (new TextDecoder().decode(bytes.subarray(offset, sizeEnd)).split(';')[0] ?? '').trim();
    if (!/^[\da-f]{1,8}$/iu.test(sizeField)) {
      throw new Error('The answer had a malformed chunk.');
    }
    const size = Number.parseInt(sizeField, 16);
    const chunkStart = sizeEnd + crlf.length;
    if (size === 0) {
      return concatenated(chunks);
    }
    if (bytes.length < chunkStart + size + crlf.length) {
      return undefined;
    }
    chunks.push(bytes.subarray(chunkStart, chunkStart + size));
    offset = chunkStart + size + crlf.length;
  }
}

function bodyThatFails(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      controller.error(error);
    },
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The request was aborted.');
}

function isChunked(head: AnswerHead): boolean {
  return head.headers.get('Transfer-Encoding')?.toLowerCase().includes('chunked') === true;
}

/** The whole body once it is in, or undefined while more is to come. */
function completeBody(head: AnswerHead, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | undefined {
  if (isChunked(head)) {
    return dechunked(body);
  }
  const contentLength = head.headers.get('Content-Length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    return body.length >= length ? body.subarray(0, length) : undefined;
  }
  return undefined;
}

/** Whether the body is in, or is malformed so that more can't mend it. */
function bodyIsOver(head: AnswerHead, received: Uint8Array<ArrayBuffer>): boolean {
  try {
    return completeBody(head, received) !== undefined;
  } catch {
    return true;
  }
}

/** The body as it stands once reading stopped. */
function bodyAtClose(
  head: AnswerHead,
  received: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> {
  try {
    const complete = completeBody(head, received);
    if (complete !== undefined) {
      return complete;
    }
  } catch (error) {
    return bodyThatFails(error);
  }
  // Without a length or chunks, the body is whatever came before the close.
  const isDelimited = isChunked(head) || head.headers.get('Content-Length') !== null;
  return isDelimited ? bodyThatFails(new Error('The answer broke off.')) : received;
}

export async function postOverTls(url: string, init: PostOverTlsInit): Promise<Response> {
  const target = new URL(url);
  const body = new TextEncoder().encode(init.body.toString());
  const head = [
    `POST ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    ...Object.entries(init.headers).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${body.length}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');

  init.signal.throwIfAborted();
  const socket = connect({ hostname: target.hostname, port: 443 }, { secureTransport: 'on' });
  const aborted = new Promise<never>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(abortReason(init.signal)), { once: true });
  });
  // The race below reads the rejection; this only stops it counting as unhandled.
  aborted.catch(() => undefined);
  const untilAborted = <T>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);

  try {
    const writer = socket.writable.getWriter();
    await untilAborted(writer.write(concatenated([new TextEncoder().encode(head), body])));
    writer.releaseLock();

    const reader = socket.readable.getReader();
    const received: Uint8Array[] = [];
    let answerHead: AnswerHead | undefined;
    let bodyError: unknown;
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await untilAborted(reader.read());
      } catch (error) {
        if (answerHead === undefined) {
          throw error;
        }
        bodyError = error;
        break;
      }
      if (read.done) {
        break;
      }
      received.push(read.value);
      const bytes = concatenated(received);
      if (bytes.length > maxAnswerBytes) {
        if (answerHead === undefined) {
          throw new Error('The answer was too long.');
        }
        bodyError = new Error('The answer was too long.');
        break;
      }
      answerHead ??= readHead(bytes);
      if (answerHead !== undefined && bodyIsOver(answerHead, bytes.subarray(answerHead.bodyStart))) {
        break;
      }
    }

    const bytes = concatenated(received);
    answerHead ??= readHead(bytes);
    if (answerHead === undefined) {
      throw new Error('The connection closed before an answer.');
    }
    const answerBody =
      bodyError === undefined
        ? bodyAtClose(answerHead, bytes.subarray(answerHead.bodyStart))
        : bodyThatFails(bodyError);
    // The body is in hand, so these describe it no longer.
    answerHead.headers.delete('Transfer-Encoding');
    answerHead.headers.delete('Content-Length');
    return new Response(answerBody, { status: answerHead.status, headers: answerHead.headers });
  } finally {
    void socket.close().catch(() => undefined);
  }
}
