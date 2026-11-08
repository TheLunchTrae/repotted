import { z } from 'zod';

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
 *   its `enabled` field. A 404 means off for a `presence` toggle, and for an
 *   `enabled` one marked `missingIsOff`; for any other it means the
 *   repository does not have the feature.
 * - A `field` is one field of an endpoint, kept under the field's name. One
 *   GitHub leaves out of its answer is unset.
 * - An `object` is an endpoint's fields, kept together under the endpoint's
 *   name. A write sends what the profile names and the `carries` fields,
 *   taking any the profile leaves out from the live value.
 */
export type Endpoint =
  | (EndpointBase & {
      readonly kind: 'toggle';
      readonly reads: 'presence' | 'enabled';
      readonly missingIsOff?: true;
    })
  | (EndpointBase & { readonly kind: 'field'; readonly method: 'PUT' | 'PATCH' })
  | (EndpointBase & ObjectEndpoint);

/** What GitHub ties together in an object setting, so a plan matches what GitHub keeps. */
interface ObjectEndpoint {
  readonly kind: 'object';
  readonly method: 'PUT' | 'PATCH';
  /** The endpoint's object in the profile schema, which names its fields. */
  readonly schema: z.ZodObject;
  /**
   * The fields a write takes from the live value when the profile leaves
   * them out: by default every field for a PUT, which replaces what it is
   * sent, and none for a PATCH.
   */
  readonly carries?: readonly string[];
  /** Fields that describe one repository, which a capture leaves out. */
  readonly identifying?: readonly string[];
  /** Puts what GitHub reports in the form a profile and a write use. */
  readonly fromGitHub?: (value: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Makes what the profile names into what GitHub will keep, given the live
   * value: fills in fields GitHub ties to the ones named, and leaves out,
   * with the reason, fields GitHub drops with the option chosen.
   */
  readonly adjust?: (
    desired: Record<string, unknown>,
    live: Record<string, unknown>,
  ) => {
    readonly desired: Record<string, unknown>;
    readonly dropped?: { readonly fields: readonly string[]; readonly reason: string };
  };
  /** Changes the body a write sends, as dropping fields GitHub refuses with the option chosen. */
  readonly body?: (body: Record<string, unknown>) => Record<string, unknown>;
}

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
    endpoint.kind === 'toggle' && (endpoint.reads === 'presence' || endpoint.missingIsOff === true) ? off : undefined,
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
    return { available: true, value: data[endpoint.key] };
  }
  const reported = endpoint.fromGitHub?.(data) ?? data;
  // GitHub sends null for a field it leaves unset, which reads as unset
  // unless the profile can hold null there.
  const value = Object.fromEntries(
    Object.entries(endpoint.schema.shape)
      .filter(
        ([field, schema]: [string, z.ZodType]) =>
          reported[field] !== undefined && (reported[field] !== null || schema.safeParse(null).success),
      )
      .map(([field]) => [field, reported[field]]),
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
  const warnings: string[] = [];
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
    const adjusted = endpoint.adjust?.(desired, current) ?? { desired };
    if (adjusted.dropped !== undefined) {
      for (const field of adjusted.dropped.fields) {
        warnings.push(`Skipped ${section}.${endpoint.key}.${field}: ${adjusted.dropped.reason}`);
      }
    }
    const wanted = adjusted.desired;
    const fields = fieldChanges(wanted, current);
    if (fields.length > 0) {
      // GitHub takes no null for a field it leaves unset, so one stays out.
      const carries = endpoint.carries ?? (endpoint.method === 'PUT' ? Object.keys(endpoint.schema.shape) : []);
      const carried = Object.fromEntries(
        carries
          .filter((field) => current[field] !== undefined && current[field] !== null)
          .map((field) => [field, current[field]]),
      );
      const body = { ...carried, ...wanted };
      changes.push({
        section,
        action: 'update',
        target: endpoint.target,
        fields: fields.map((field) => ({ ...field, field: `${endpoint.key}.${field.field}` })),
        request: { method: endpoint.method, path, body: endpoint.body?.(body) ?? body },
      });
    }
  }
  return { changes, warnings };
}

/**
 * Why a profile cannot hold a value GitHub reports, naming each part that
 * fails and where it is, or undefined when it can.
 */
export function unloadable(schema: z.ZodType, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  if (result.success) {
    return undefined;
  }
  const problems = result.error.issues.map((issue) => {
    const reported: unknown = issue.path.reduce<unknown>(
      (inner, part) => (typeof inner === 'object' && inner !== null ? Reflect.get(inner, part) : undefined),
      value,
    );
    const at = z.core.toDotPath(issue.path);
    return `${JSON.stringify(reported)}${at === '' ? '' : ` at ${at}`} (${issue.message})`;
  });
  return `a profile cannot hold ${problems.join('; ')}`;
}

/**
 * The captured settings that a profile can hold. GitHub may report a value
 * that no profile takes, such as an option newer than the schema, so a
 * setting that fails its schema is left out with a warning, and the capture
 * still loads.
 */
export function loadable(
  name: string,
  schema: z.ZodObject,
  settings: Readonly<Record<string, unknown>>,
  warnings: string[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    const field: unknown = schema.shape[key];
    const problem = unloadable(field instanceof z.ZodType ? field : z.never(), value);
    if (problem === undefined) {
      kept[key] = value;
    } else {
      warnings.push(`Skipped ${name}.${key}: ${problem}`);
    }
  }
  return kept;
}

/** A captured section: the settings it could read, and a warning for each it could not. */
export function captureEndpoints(
  section: Section,
  endpoints: readonly Endpoint[],
  values: ReadonlyMap<string, EndpointValue>,
): { settings: Record<string, unknown>; warnings: string[] } {
  const settings: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const endpoint of endpoints) {
    const value = values.get(endpoint.key);
    if (value === undefined) {
      continue;
    }
    if (value.available) {
      // An object's fields are checked one by one, so one GitHub reports in a
      // form a profile cannot hold leaves out only that field.
      const identifying = endpoint.kind === 'object' ? (endpoint.identifying ?? []) : [];
      const kept =
        endpoint.kind === 'object' && isRecord(value.value)
          ? loadable(
              `${section}.${endpoint.key}`,
              endpoint.schema,
              Object.fromEntries(Object.entries(value.value).filter(([field]) => !identifying.includes(field))),
              warnings,
            )
          : value.value;
      // A setting GitHub reports as unset has nothing to capture.
      if (kept !== undefined && !(isRecord(kept) && Object.keys(kept).length === 0)) {
        settings[endpoint.key] = kept;
      }
    } else if (value.refused) {
      // A setting the repository does not have is no news; one GitHub hides is.
      warnings.push(`Skipped ${section}.${endpoint.key}: ${value.reason}`);
    }
  }
  return { settings, warnings };
}
