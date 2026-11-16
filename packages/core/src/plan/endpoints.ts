import { z } from 'zod';

import { type GitHub, GitHubError, repoPath, type RepoRef } from '../github/client.js';
import { requiredPermission } from '../github/permissions.js';
import { activeSettings } from '../profiles/setting-dependencies.js';
import type { Change, RefusalRemedy, Section, SectionPlan, SettingsSection, Warning } from './change.js';
import { fieldChanges } from './match.js';

interface EndpointBase {
  readonly key: string;
  readonly path: string;
  readonly target: string;
}

/**
 * A `toggle` is on while a GET finds it: PUT turns it on and DELETE turns it
 * off. A 404 means off for a `presence` toggle, and for an `enabled` one marked
 * `missingIsOff`; for any other it means the repository does not have the
 * feature.
 * - A `field` that GitHub leaves out of its answer is unset.
 */
export type Endpoint =
  | (EndpointBase & {
      readonly kind: 'toggle';
      readonly reads: 'presence' | 'enabled';
      readonly missingIsOff?: true;
    })
  | (EndpointBase & { readonly kind: 'field'; readonly method: 'PUT' | 'PATCH' })
  | (EndpointBase & ObjectEndpoint);

interface ObjectEndpoint {
  readonly kind: 'object';
  readonly method: 'PUT' | 'PATCH';
  readonly schema: z.ZodObject;
  /**
   * The fields a write takes from the live value when the profile leaves them
   * out. Defaults to every field for a PUT, which replaces what it is sent, and
   * none for a PATCH.
   */
  readonly carries?: readonly string[];
  readonly repositorySpecificFields?: readonly string[];
  readonly fromGitHub?: (value: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Fills in fields GitHub ties to the ones named, and leaves out, with the
   * reason, fields GitHub drops with the option chosen.
   */
  readonly adjust?: (
    desired: Record<string, unknown>,
    live: Record<string, unknown>,
  ) => {
    readonly desired: Record<string, unknown>;
    readonly dropped?: { readonly fields: readonly string[]; readonly reason: string };
  };
  readonly adjustWriteBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * `refused`: GitHub hides it, as from a token without the permission or an
 * account without a payment method on file. `unavailable`: GitHub does not
 * offer it on the repository.
 */
export type Unavailable =
  | { readonly available: false; readonly cause: 'refused'; readonly reason: string; readonly remedy: RefusalRemedy }
  | { readonly available: false; readonly cause: 'unavailable'; readonly reason: string };

export type EndpointValue = { readonly available: true; readonly value: unknown } | Unavailable;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function refusedRead(error: GitHubError, path: string, what: string): Unavailable {
  const permission = requiredPermission('GET', path);
  return {
    available: false,
    cause: 'refused',
    reason: `GitHub refused to read ${what} (${error.message}); that needs the ${permission} permission`,
    remedy: { kind: 'permission', permission },
  };
}

export function warningForUnavailable(unavailable: Unavailable): Pick<Warning, 'cause' | 'message' | 'remedy'> {
  return unavailable.cause === 'refused'
    ? { cause: unavailable.cause, message: unavailable.reason, remedy: unavailable.remedy }
    : { cause: unavailable.cause, message: unavailable.reason };
}

export async function readResource(
  github: GitHub,
  repo: RepoRef,
  relative: string,
  target: string,
  valueWhen404MeansOffOrAbsent?: unknown,
): Promise<EndpointValue> {
  const path = `${repoPath(repo)}${relative}`;
  try {
    return { available: true, value: await github.request('GET', path) };
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    if (error.status === 404 && valueWhen404MeansOffOrAbsent !== undefined) {
      return { available: true, value: valueWhen404MeansOffOrAbsent };
    }
    if (error.status === 403) {
      return refusedRead(error, path, target);
    }
    // 402 for a billed feature, such as the Actions cache retention limit,
    // on an account with no payment method on file. Adding one lifts it, so
    // a capture says so, as it does for a missing permission.
    if (error.status === 402) {
      return {
        available: false,
        cause: 'refused',
        reason: `GitHub refused to read ${target} without a payment method on file (${error.message})`,
        remedy: { kind: 'payment_method' },
      };
    }
    // 404 for a feature the repository's plan or owner lacks; 405, 409 and
    // 422 for one that does not apply to it, such as fork settings on a
    // public repository.
    if ([404, 405, 409, 422].includes(error.status)) {
      return {
        available: false,
        cause: 'unavailable',
        reason: `GitHub does not offer ${target} on this repository (${error.message})`,
      };
    }
    throw error;
  }
}

const off = Symbol('off');

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
    return { available: false, cause: 'unavailable', reason: `GitHub sent no ${endpoint.target} settings` };
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

export function activeSettingsForPlan<T extends object>(
  section: SettingsSection,
  desired: T,
  live: object,
  warnings: Warning[],
): T {
  const { settings, inactive } = activeSettings(section, desired, live);
  for (const { key: path, reason } of inactive) {
    const [key, ...field] = path.split('.');
    warnings.push({
      section,
      ...(key === undefined ? {} : { key }),
      ...(field.length === 0 ? {} : { field: field.join('.') }),
      cause: 'not_applicable',
      message: reason,
    });
  }
  return settings;
}

export function planEndpoint(
  section: SettingsSection,
  endpoint: Endpoint,
  desired: unknown,
  live: EndpointValue,
  repo: RepoRef,
): SectionPlan {
  if (!live.available) {
    return { changes: [], warnings: [{ section, key: endpoint.key, ...warningForUnavailable(live) }] };
  }
  const path = `${repoPath(repo)}${endpoint.path}`;
  const changes: Change[] = [];
  const warnings: Warning[] = [];
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
        warnings.push({
          section,
          key: endpoint.key,
          field,
          cause: 'not_applicable',
          message: adjusted.dropped.reason,
        });
      }
    }
    const active = activeSettingsForPlan(
      section,
      { [endpoint.key]: adjusted.desired },
      { [endpoint.key]: current },
      warnings,
    );
    const wanted = active[endpoint.key];
    if (!isRecord(wanted)) {
      return { changes, warnings };
    }
    const fields = fieldChanges(wanted, current);
    if (fields.length > 0) {
      // GitHub takes no null for a field it leaves unset, so one stays out.
      const carries = endpoint.carries ?? (endpoint.method === 'PUT' ? Object.keys(endpoint.schema.shape) : []);
      const carried = Object.fromEntries(
        carries
          .filter((field) => current[field] !== undefined && current[field] !== null)
          .map((field) => [field, current[field]]),
      );
      const body =
        activeSettings(section, { [endpoint.key]: { ...carried, ...wanted } }, { [endpoint.key]: current }).settings[
          endpoint.key
        ] ?? {};
      changes.push({
        section,
        action: 'update',
        target: endpoint.target,
        fields: fields.map((field) => ({ ...field, field: `${endpoint.key}.${field.field}` })),
        request: { method: endpoint.method, path, body: endpoint.adjustWriteBody?.(body) ?? body },
      });
    }
  }
  return { changes, warnings };
}

export function unloadableReason(schema: z.ZodType, value: unknown): string | undefined {
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
 * GitHub may report a value that no profile takes, such as an option newer than
 * the schema, so a setting that fails its schema is left out with a warning,
 * and the capture still loads.
 */
export function loadable(
  at: { readonly section: Section; readonly key?: string },
  schema: z.ZodObject,
  settings: Readonly<Record<string, unknown>>,
  warnings: Warning[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    const field: unknown = schema.shape[key];
    const problem = unloadableReason(field instanceof z.ZodType ? field : z.never(), value);
    if (problem === undefined) {
      kept[key] = value;
    } else {
      warnings.push({
        section: at.section,
        ...(at.key === undefined ? { key } : { key: at.key, field: key }),
        cause: 'unloadable',
        message: problem,
      });
    }
  }
  return kept;
}

export function captureEndpoints(
  section: Section,
  endpoints: readonly Endpoint[],
  values: ReadonlyMap<string, EndpointValue>,
): { settings: Record<string, unknown>; warnings: Warning[] } {
  const settings: Record<string, unknown> = {};
  const warnings: Warning[] = [];
  for (const endpoint of endpoints) {
    const value = values.get(endpoint.key);
    if (value === undefined) {
      continue;
    }
    if (value.available) {
      // An object's fields are checked one by one, so one GitHub reports in a
      // form a profile cannot hold leaves out only that field.
      const repositorySpecificFields = endpoint.kind === 'object' ? (endpoint.repositorySpecificFields ?? []) : [];
      const kept =
        endpoint.kind === 'object' && isRecord(value.value)
          ? loadable(
              { section, key: endpoint.key },
              endpoint.schema,
              Object.fromEntries(
                Object.entries(value.value).filter(([field]) => !repositorySpecificFields.includes(field)),
              ),
              warnings,
            )
          : value.value;
      if (kept !== undefined && !(isRecord(kept) && Object.keys(kept).length === 0)) {
        settings[endpoint.key] = kept;
      }
    } else if (value.cause === 'refused') {
      // A setting the repository does not have is no news; one GitHub hides is.
      warnings.push({ section, key: endpoint.key, ...warningForUnavailable(value) });
    }
  }
  return { settings, warnings };
}
