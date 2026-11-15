import { type AppAccess, permissionsMissingToManage } from '../github/permissions.js';
import type { Endpoint } from './endpoints.js';
import { actionsEndpoints } from './sections/actions.js';
import { repositoryEndpoints } from './sections/repository.js';
import { securityEndpoints } from './sections/security.js';

const endpointsBySection: Readonly<Partial<Record<string, readonly Endpoint[]>>> = {
  actions: actionsEndpoints,
  repository: repositoryEndpoints,
  security: securityEndpoints,
};

/** Where a section's parts live when no endpoint of their own holds them. */
const pathsBySection: Readonly<Partial<Record<string, string>>> = {
  actions: '/actions/permissions',
  pages: '/pages',
  rulesets: '/rulesets',
  environments: '/environments',
  labels: '/labels',
};

/**
 * The installation's permissions that managing a part of a profile needs and
 * it lacks, by the names GitHub gives them: a section, or a key in it.
 */
export function permissionsMissingForProfilePart(app: AppAccess, section: string, key?: string): readonly string[] {
  const endpoint = endpointsBySection[section]?.find((candidate) => candidate.key === key);
  return permissionsMissingToManage(app, endpoint?.path ?? pathsBySection[section] ?? '');
}
