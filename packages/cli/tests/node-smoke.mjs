// Runs the built CLI under Node, the way npx would: it starts, answers an MCP
// handshake, and loads and validates profiles from disk. It never reaches
// GitHub, because the profile it plans with is invalid. Run it with Node after
// `pnpm run build`, or pass the path of the desktop app's compiled CLI to run
// the same checks against that executable.
import { spawn, spawnSync } from 'node:child_process';
import { log } from 'node:console';
import { argv, execPath, version as nodeVersion } from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const compiled = argv[2];
const [command, ...prefix] =
  compiled === undefined ? [execPath, fileURLToPath(new URL('../dist/repotted.js', import.meta.url))] : [compiled];
const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));

const version = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
if (version.status !== 0 || !/^\d+\.\d+\.\d+/u.test(version.stdout)) {
  throw new Error(`repotted --version failed: ${version.stderr}`);
}

const server = spawn(command, [...prefix, 'mcp', '--read-only'], { cwd: examples, stdio: ['pipe', 'pipe', 'inherit'] });
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
  if (names.join(',') !== 'capture,check_actions,find_actions,plan') {
    throw new Error(`Unexpected tools: ${names.join(', ')}`);
  }
  const planned = await request(3, 'tools/call', {
    name: 'plan',
    arguments: {
      repository: 'octo-org/app',
      profile: 'extends: repotted.yaml\nmerge: { allow_rebase_merge: false }\n',
    },
  });
  const text = planned.result?.content?.[0]?.text ?? '';
  if (planned.result?.isError !== true || !text.includes('Every merge method is off')) {
    throw new Error(`Unexpected plan reply: ${JSON.stringify(planned)}`);
  }
  const runtime = compiled === undefined ? `node ${nodeVersion}` : compiled;
  log(`${runtime}: repotted ${version.stdout.trim()} starts, serves ${names.join(', ')} and validates profiles`);
} finally {
  server.kill();
}
