// Runs the built CLI under Node, the way npx would, and checks that it starts
// and answers an MCP handshake. Run it with Node after `bun run build`.
import { spawn, spawnSync } from 'node:child_process';
import { log } from 'node:console';
import { execPath, version as nodeVersion } from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const cli = fileURLToPath(new URL('../dist/repotted.js', import.meta.url));

if (typeof globalThis.Bun !== 'undefined') {
  throw new Error('node-smoke.mjs must run under Node, not Bun');
}

const version = spawnSync(execPath, [cli, '--version'], { encoding: 'utf8' });
if (version.status !== 0 || !/^\d+\.\d+\.\d+/u.test(version.stdout)) {
  throw new Error(`repotted --version failed: ${version.stderr}`);
}

const server = spawn(execPath, [cli, 'mcp', '--read-only'], { stdio: ['pipe', 'pipe', 'inherit'] });
const replies = new Map();
let buffer = '';
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let end = buffer.indexOf('\n');
  while (end !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    replies.get(message.id)?.(message);
    end = buffer.indexOf('\n');
  }
});

function send(message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No reply to ${method}`)), 10_000);
    replies.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

try {
  const init = await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'node-smoke', version: '0.0.0' },
  });
  if (init.result?.serverInfo?.name !== 'repotted') {
    throw new Error(`Unexpected initialize reply: ${JSON.stringify(init)}`);
  }
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await request(2, 'tools/list', {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name).toSorted();
  if (names.join(',') !== 'capture,plan') {
    throw new Error(`Unexpected tools: ${names.join(', ')}`);
  }
  log(`node ${nodeVersion}: repotted ${version.stdout.trim()} starts and serves ${names.join(', ')}`);
} finally {
  server.kill();
}
