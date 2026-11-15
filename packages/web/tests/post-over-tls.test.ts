import { connect } from 'cloudflare:sockets';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { postOverTls } from '../src/post-over-tls.js';

const connectToGitHub = vi.mocked(connect);
const url = 'https://github.com/login/oauth/access_token';

interface FakeSocket {
  written(): string;
  closed: boolean;
}

/** A socket that answers with these pieces, then closes or fails with `failure`. */
function gitHubAnswers(pieces: readonly string[], ending: { failure?: unknown; staysOpen?: boolean } = {}): FakeSocket {
  const writtenBytes: Uint8Array[] = [];
  const fake: FakeSocket = {
    written: () => writtenBytes.map((bytes) => new TextDecoder().decode(bytes)).join(''),
    closed: false,
  };
  let next = 0;
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[next];
      next += 1;
      if (piece !== undefined) {
        controller.enqueue(new TextEncoder().encode(piece));
      } else if (ending.failure !== undefined) {
        controller.error(ending.failure);
      } else if (ending.staysOpen !== true) {
        controller.close();
      } else {
        return new Promise(() => undefined);
      }
      return undefined;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      writtenBytes.push(chunk);
    },
  });
  connectToGitHub.mockReturnValue({
    readable,
    writable,
    close: () => {
      fake.closed = true;
      return Promise.resolve();
    },
  });
  return fake;
}

function post(signal = AbortSignal.timeout(10_000)): Promise<Response> {
  return postOverTls(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'repotted' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'ghr_refresh' }),
    signal,
  });
}

beforeEach(() => {
  connectToGitHub.mockReset();
});

describe('the request', () => {
  test('goes to GitHub over TLS as one HTTP/1.1 POST that closes the connection', async () => {
    const socket = gitHubAnswers(['HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}']);

    await post();

    expect(connectToGitHub).toHaveBeenCalledWith({ hostname: 'github.com', port: 443 }, { secureTransport: 'on' });
    const body = 'grant_type=refresh_token&refresh_token=ghr_refresh';
    expect(socket.written()).toBe(
      [
        'POST /login/oauth/access_token HTTP/1.1',
        'Host: github.com',
        'Accept: application/json',
        'User-Agent: repotted',
        'Accept-Encoding: identity',
        `Content-Length: ${body.length}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );
    expect(socket.closed).toBe(true);
  });
});

describe('the answer', () => {
  test('keeps its status, headers and body', async () => {
    gitHubAnswers(['HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{"a":', '"bc"}']);

    const response = await post();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.text()).toBe('{"a":"bc"}');
  });

  test('ends at its length without waiting for the connection to close', async () => {
    gitHubAnswers(['HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'], { staysOpen: true });

    expect(await (await post()).text()).toBe('{}');
  });

  test('joins a chunked body', async () => {
    gitHubAnswers(
      ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"a"\r\n', '6;x=y\r\n:"bc"}\r\n0\r\n\r\n'],
      {
        staysOpen: true,
      },
    );

    const response = await post();

    expect(await response.text()).toBe('{"a":"bc"}');
    expect(response.headers.has('Transfer-Encoding')).toBe(false);
  });

  test('without a length or chunks, runs until the connection closes', async () => {
    gitHubAnswers(['HTTP/1.1 200 OK\r\n\r\n{"a":', '"bc"}']);

    expect(await (await post()).text()).toBe('{"a":"bc"}');
  });

  test('keeps a status that is not a success', async () => {
    gitHubAnswers(['HTTP/1.1 502 \r\nContent-Length: 0\r\n\r\n']);

    expect((await post()).status).toBe(502);
  });

  test('skips an interim 1xx answer', async () => {
    gitHubAnswers(['HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}']);

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{}');
  });

  test('reads chunks when an answer also has a length', async () => {
    gitHubAnswers(['HTTP/1.1 200 OK\r\nContent-Length: 99\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n']);

    const response = await post();

    expect(await response.text()).toBe('{}');
    expect(response.headers.has('Content-Length')).toBe(false);
  });

  test('has no body for a status that has none', async () => {
    gitHubAnswers(['HTTP/1.1 204 No Content\r\n\r\n']);

    const response = await post();

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  test.each([
    ['in its own read', ['HTTP/1.1 503 \r\nContent-Length: 70000\r\n\r\n', 'x'.repeat(70_000)]],
    ['in one read with its body', [`HTTP/1.1 503 \r\nContent-Length: 70000\r\n\r\n${'x'.repeat(70_000)}`]],
  ])('past 64 KiB, keeps the status of a head that came %s and fails its body', async (_case, pieces) => {
    gitHubAnswers(pieces, { staysOpen: true });

    const response = await post();

    expect(response.status).toBe(503);
    await expect(response.text()).rejects.toThrow();
  });

  test('has a body that fails with the timeout when GitHub stops after the headers', async () => {
    gitHubAnswers(['HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{"a":'], { staysOpen: true });
    const timeout = new AbortController();
    const answer = post(timeout.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    timeout.abort(new DOMException('The operation timed out.', 'TimeoutError'));

    const response = await answer;
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  test.each([
    ['closes short of its length', ['HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{"a":'], {}],
    ['closes before its last chunk', ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"a"\r\n'], {}],
    ['has a malformed chunk', ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n'], {}],
    [
      'has a chunk longer than its size',
      ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{}\r\n0\r\n\r\n'],
      {},
    ],
    [
      'has a transfer coding other than chunked',
      ['HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n'],
      {},
    ],
    ['has a malformed length', ['HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n{}'], {}],
    [
      'fails after the headers',
      ['HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{"a":'],
      { failure: new Error('reset') },
    ],
  ])('with headers that arrived, has a body that fails when it %s', async (_case, pieces, ending) => {
    gitHubAnswers(pieces, ending);

    const response = await post();

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });
});

describe('no answer', () => {
  test.each([
    ['the connection closes before an answer', [], {}],
    ['the connection fails before an answer', [], { failure: new Error('TLS handshake failed') }],
    ['the answer is not HTTP', ['SSH-2.0-OpenSSH\r\n\r\n'], {}],
    ['the answer has a status no server sends', ['HTTP/1.1 999 Odd\r\n\r\n'], {}],
    [
      'the answer runs past 64 KiB before its headers end',
      ['HTTP/1.1 200 OK\r\n', 'X: '.padEnd(70_000, 'x')],
      { staysOpen: true },
    ],
  ])('rejects when %s', async (_case, pieces, ending) => {
    const socket = gitHubAnswers(pieces, ending);

    await expect(post()).rejects.toThrow();
    expect(socket.closed).toBe(true);
  });

  test('rejects with the timeout when GitHub stays silent', async () => {
    const socket = gitHubAnswers([], { staysOpen: true });
    const timeout = new AbortController();
    const answer = post(timeout.signal);

    timeout.abort(new DOMException('The operation timed out.', 'TimeoutError'));

    await expect(answer).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(socket.closed).toBe(true);
  });
});
