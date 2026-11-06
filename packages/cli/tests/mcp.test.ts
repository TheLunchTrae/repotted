import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { FakeGitHub } from '../../core/tests/fake-github.js';
import { createServer } from '../src/mcp.js';

const examples = path.join(import.meta.dir, '../../../examples');

async function connect(github: FakeGitHub, readOnly = false, onClient: () => void = () => undefined): Promise<Client> {
  const server = createServer({
    version: '0.0.0',
    github: () => {
      onClient();
      return Promise.resolve(github);
    },
    cwd: examples,
    readOnly,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((item: unknown) =>
    typeof item === 'object' && item !== null && 'text' in item ? String(item.text) : '',
  );
  return { text: text.join('\n'), isError: result.isError === true };
}

describe('MCP server', () => {
  test('plans without writing, then applies that plan by its id', async () => {
    const github = new FakeGitHub();
    const client = await connect(github);

    const planned = await call(client, 'plan', { repository: 'lunch/app', profile_path: 'repotted.yaml' });
    expect(planned.isError).toBe(false);
    expect(github.writes).toEqual([]);
    const id = /plan_id: (\S+)/u.exec(planned.text)?.[1];
    expect(id).toBeDefined();

    const applied = await call(client, 'apply', { plan_id: id });
    expect(applied).toEqual({ text: 'Applied 9 changes to lunch/app.', isError: false });

    const again = await call(client, 'plan', { repository: 'lunch/app', profile_path: 'repotted.yaml' });
    expect(again.text).toBe('lunch/app matches the profile.');
  });

  test('asks for a client on every call, so a refreshed token takes over', async () => {
    let clients = 0;
    const client = await connect(new FakeGitHub(), false, () => {
      clients += 1;
    });

    await call(client, 'capture', { repository: 'lunch/app' });
    await call(client, 'capture', { repository: 'lunch/app' });
    expect(clients).toBe(2);
  });

  test('accepts a profile as YAML text', async () => {
    const client = await connect(new FakeGitHub());
    const planned = await call(client, 'plan', { repository: 'lunch/app', profile: 'repository: { has_wiki: false }' });

    expect(planned.text).toContain('has_wiki: true -> false');
  });

  test('refuses a plan_id it did not hand out', async () => {
    const github = new FakeGitHub();
    const client = await connect(github);

    expect(await call(client, 'apply', { plan_id: 'made-up' })).toEqual({
      text: 'No plan has that plan_id. Call plan first.',
      isError: true,
    });
    expect(github.writes).toEqual([]);
  });

  test('keeps the plan when the sign-in fails at apply', async () => {
    let calls = 0;
    const client = await connect(new FakeGitHub(), false, () => {
      calls += 1;
      if (calls === 2) {
        throw new Error('The Repotted sign-in expired.');
      }
    });
    const planned = await call(client, 'plan', { repository: 'lunch/app', profile: 'repository: { has_wiki: false }' });
    const id = /plan_id: (\S+)/u.exec(planned.text)?.[1];

    expect(await call(client, 'apply', { plan_id: id })).toEqual({
      text: 'The Repotted sign-in expired.',
      isError: true,
    });
    expect((await call(client, 'apply', { plan_id: id })).isError).toBe(false);
  });

  test('applies a plan only once', async () => {
    const client = await connect(new FakeGitHub());
    const planned = await call(client, 'plan', { repository: 'lunch/app', profile: 'repository: { has_wiki: false }' });
    const id = /plan_id: (\S+)/u.exec(planned.text)?.[1];

    expect((await call(client, 'apply', { plan_id: id })).isError).toBe(false);
    expect((await call(client, 'apply', { plan_id: id })).isError).toBe(true);
  });

  test('applies a plan once even when two calls race', async () => {
    const github = new FakeGitHub();
    const client = await connect(github);
    const planned = await call(client, 'plan', { repository: 'lunch/app', profile: 'rulesets: [{ name: Main }]' });
    const id = /plan_id: (\S+)/u.exec(planned.text)?.[1];

    const results = await Promise.all([call(client, 'apply', { plan_id: id }), call(client, 'apply', { plan_id: id })]);
    expect(results.map((result) => result.isError).toSorted()).toEqual([false, true]);
    expect(github.state.rulesets).toHaveLength(1);
  });

  test('refuses a plan the repository has drifted from', async () => {
    const github = new FakeGitHub();
    const client = await connect(github);
    const planned = await call(client, 'plan', { repository: 'lunch/app', profile: 'repository: { has_wiki: false }' });
    github.state.repository['has_wiki'] = false;

    const applied = await call(client, 'apply', { plan_id: /plan_id: (\S+)/u.exec(planned.text)?.[1] });
    expect(applied.isError).toBe(true);
    expect(applied.text).toContain('changed since this plan was made');
    expect(github.writes).toEqual([]);
  });

  test('leaves out apply when read-only', async () => {
    const client = await connect(new FakeGitHub(), true);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).toSorted()).toEqual(['capture', 'plan']);
  });

  test('returns a captured profile as YAML', async () => {
    const client = await connect(new FakeGitHub());
    const captured = await call(client, 'capture', { repository: 'lunch/app' });

    expect(captured.isError).toBe(false);
    expect(captured.text).toContain('delete_branch_on_merge: false');
  });
});
