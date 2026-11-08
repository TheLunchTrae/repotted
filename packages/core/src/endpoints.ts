import type { Change, Section, SectionPlan } from './change.js';
import { type GitHub, GitHubError, type Method, repoPath, type RepoRef } from './github.js';
import { fieldChanges } from './match.js';
import { requiredPermission } from './permissions.js';

interface EndpointBase {
  /** The setting's key in its profile section. */
  readonly key: string;
  /** The endpoint's path under the repository, as `/vulnerability-alerts`. */
  readonly path: string;
  /** What the setting is called in a plan. */
  readonly target: string;
}

/**
 * A setting GitHub keeps at an endpoint of its own under the repository.
 *
 * - A `toggle` is on while a GET finds it: PUT turns it on and DELETE turns
 *   it off. `reads` says whether a found one is on (`presence`) or says so in
 *   its `enabled` field.
 * - A `field` is one field of an endpoint, kept under the field's name.
 * - An `object` is an endpoint's fields, kept together under the endpoint's
 *   name. A write sends what the profile names and the `carries` fields,
 *   taking any the profile leaves out from the live value; `body` adjusts
 *   that, as dropping fields GitHub refuses with the option chosen.
 */
export type Endpoint =
  | (EndpointBase & { readonly kind: 'toggle'; readonly reads: 'presence' | 'enabled' })
  | (EndpointBase & { readonly kind: 'field'; readonly method: 'PUT' | 'PATCH' })
  | (EndpointBase & {
      readonly kind: 'object';
      readonly method: 'PUT' | 'PATCH';
      readonly fields: readonly string[];
      readonly carries: readonly string[];
      readonly body?: (body: Record<string, unknown>) => Record<string, unknown>;
    });

/**
 * A setting as the repository holds it, or why it cannot be read there:
 * `refused` when GitHub hides it, as from a token without the permission,
 * rather than not offering it on the repository.
 */
export type EndpointValue =
  | { readonly available: true; readonly value: unknown }
  | { readonly available: false; readonly refused: boolean; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why GitHub refused a request, in words that name the permission it needs. */
export function refusal(error: GitHubError, method: Method, path: string, what: string): string {
  const permission = requiredPermission(method, path);
  const verb = method === 'GET' ? 'read' : 'change';
  return `GitHub refused to ${verb} ${what} (${error.message}); that needs the ${permission} permission`;
}

/**
 * Reads a resource under the repository, such as `/pages`. One that GitHub
 * does not offer on the repository, or refuses to show, reads as
 * unavailable with the reason, so a capture or plan can go on without it;
 * `missing` stands in for a resource whose 404 means it is off or absent.
 */
export async function readResource(
  github: GitHub,
  repo: RepoRef,
  relative: string,
  target: string,
  missing?: unknown,
): Promise<EndpointValue> {
  const path = `${repoPath(repo)}${relative}`;
  try {
    return { available: true, value: await github.request('GET', path) };
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    if (error.status === 404 && missing !== undefined) {
      return { available: true, value: missing };
    }
    if (error.status === 403) {
      return { available: false, refused: true, reason: refusal(error, 'GET', path, target) };
    }
    // 404 for a feature the repository's plan or owner lacks; 405, 409 and
    // 422 for one that does not apply to it, such as fork settings on a
    // public repository.
    if ([404, 405, 409, 422].includes(error.status)) {
      return {
        available: false,
        refused: false,
        reason: `GitHub does not offer ${target} on this repository (${error.message})`,
      };
    }
    throw error;
  }
}

const off = Symbol('off');

/** Reads one setting. */
export async function readEndpoint(github: GitHub, repo: RepoRef, endpoint: Endpoint): Promise<EndpointValue> {
  const read = await readResource(
    github,
    repo,
    endpoint.path,
    endpoint.target,
    // A 404 means off only for a toggle found by its presence; elsewhere it
    // means the repository does not have the feature.
    endpoint.kind === 'toggle' && endpoint.reads === 'presence' ? off : undefined,
  );
  if (!read.available) {
    return read;
  }
  const data = read.value;
  if (endpoint.kind === 'toggle') {
    const on = data !== off && (endpoint.reads === 'presence' || (isRecord(data) && data['enabled'] === true));
    return { available: true, value: on };
  }
  if (!isRecord(data)) {
    return { available: false, refused: false, reason: `GitHub sent no ${endpoint.target} settings` };
  }
  if (endpoint.kind === 'field') {
    return data[endpoint.key] === undefined
      ? { available: false, refused: false, reason: `GitHub sent no ${endpoint.key}` }
      : { available: true, value: data[endpoint.key] };
  }
  const value = Object.fromEntries(
    endpoint.fields.filter((field) => data[field] !== undefined).map((field) => [field, data[field]]),
  );
  return { available: true, value };
}

/** Reads several settings, in order, by key. */
export async function readEndpoints(
  github: GitHub,
  repo: RepoRef,
  endpoints: readonly Endpoint[],
): Promise<Map<string, EndpointValue>> {
  const values = new Map<string, EndpointValue>();
  for (const endpoint of endpoints) {
    values.set(endpoint.key, await readEndpoint(github, repo, endpoint));
  }
  return values;
}

/** The change that brings one setting in line, if it needs one. */
export function planEndpoint(
  section: Section,
  endpoint: Endpoint,
  desired: unknown,
  live: EndpointValue,
  repo: RepoRef,
): SectionPlan {
  if (!live.available) {
    return { changes: [], warnings: [`Skipped ${section}.${endpoint.key}: ${live.reason}`] };
  }
  const path = `${repoPath(repo)}${endpoint.path}`;
  const changes: Change[] = [];
  if (endpoint.kind === 'toggle') {
    if (desired !== live.value) {
      changes.push({
        section,
        action: 'update',
        target: endpoint.target,
        fields: [{ field: endpoint.key, from: live.value, to: desired }],
        request: { method: desired === true ? 'PUT' : 'DELETE', path },
      });
    }
  } else if (endpoint.kind === 'field') {
    const fields = fieldChanges({ [endpoint.key]: desired }, { [endpoint.key]: live.value });
    if (fields.length > 0) {
      changes.push({
        section,
        action: 'update',
        target: endpoint.target,
        fields,
        request: { method: endpoint.method, path, body: { [endpoint.key]: desired } },
      });
    }
  } else if (isRecord(desired)) {
    const current = isRecord(live.value) ? live.value : {};
    const fields = fieldChanges(desired, current);
    if (fields.length > 0) {
      const carried = Object.fromEntries(
        endpoint.carries.filter((field) => current[field] !== undefined).map((field) => [field, current[field]]),
      );
      const body = { ...carried, ...desired };
      changes.push({
        section,
        action: 'update',
        target: endpoint.target,
        fields: fields.map((field) => ({ ...field, field: `${endpoint.key}.${field.field}` })),
        request: { method: endpoint.method, path, body: endpoint.body?.(body) ?? body },
      });
    }
  }
  return { changes, warnings: [] };
}

/** A captured section: the settings it could read, and a warning for each it could not. */
export function captureEndpoints(
  section: Section,
  values: ReadonlyMap<string, EndpointValue>,
): { settings: Record<string, unknown>; warnings: string[] } {
  const settings: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [key, value] of values) {
    if (value.available) {
      settings[key] = value.value;
    } else if (value.refused) {
      // A setting the repository does not have is no news; one GitHub hides is.
      warnings.push(`Skipped ${section}.${key}: ${value.reason}`);
    }
  }
  return { settings, warnings };
}
