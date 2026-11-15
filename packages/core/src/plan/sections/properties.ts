import { z } from 'zod';

import { type GitHub, repoPath, type RepoRef } from '../../github/client.js';
import type { CustomProperties } from '../../profiles/schema.js';
import type { SectionPlan } from '../change.js';
import { readResource, type Unavailable } from '../endpoints.js';
import { matches } from '../match.js';

const liveValues = z.array(
  z.object({
    property_name: z.string(),
    value: z.union([z.string(), z.array(z.string()), z.null()]),
  }),
);

export type LiveProperties = { readonly available: true; readonly values: CustomProperties } | Unavailable;

// GitHub defines the properties on the owning organization, so a personal repository has none to read.
export async function readCustomProperties(github: GitHub, repo: RepoRef): Promise<LiveProperties> {
  const read = await readResource(github, repo, '/properties/values', 'custom properties');
  if (!read.available) {
    return read;
  }
  const values: CustomProperties = Object.fromEntries(
    liveValues.parse(read.value).map((entry) => [entry.property_name, entry.value]),
  );
  return { available: true, values };
}

export function planCustomProperties(desired: CustomProperties, live: LiveProperties, repo: RepoRef): SectionPlan {
  if (!live.available) {
    return { changes: [], warnings: [{ section: 'custom_properties', cause: live.cause, message: live.reason }] };
  }
  const current = live.values;
  const fields = Object.entries(desired)
    .filter(([name, value]) => !matches(value, current[name] ?? null))
    .map(([name, value]) => ({ field: name, from: current[name] ?? null, to: value }));
  if (fields.length === 0) {
    return { changes: [], warnings: [] };
  }
  return {
    changes: [
      {
        section: 'custom_properties',
        action: 'update',
        target: 'custom properties',
        fields,
        request: {
          method: 'PATCH',
          path: `${repoPath(repo)}/properties/values`,
          body: { properties: fields.map((field) => ({ property_name: field.field, value: field.to })) },
        },
      },
    ],
    warnings: [],
  };
}

export function captureCustomProperties(values: CustomProperties): CustomProperties {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}
