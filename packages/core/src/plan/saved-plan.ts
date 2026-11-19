import { z } from 'zod';

import { repoPattern } from '../github/client.js';
import { profile } from '../profiles/schema.js';
import { listSections, sections, skipCauses, type Warning } from './change.js';
import { authoritativeSchema } from './ownership.js';
import type { Plan } from './plan.js';

const planSource = z.union([
  z.object({ profile: z.string().min(1) }),
  z.object({ text: z.string(), directory: z.string().min(1) }),
  z.object({ staged: z.string().min(1) }),
]);

// A saved plan's changes are never executed: apply re-plans from `desired`
// and only compares, so a hand-edited file cannot smuggle in other requests.
// It compares each change whole, and an object drops keys it doesn't name,
// so every member of a change must be named here.
const savedWrite = {
  action: z.enum(['create', 'update', 'delete']),
  target: z.string(),
  fields: z.array(z.object({ field: z.string(), from: z.unknown().optional(), to: z.unknown().optional() })),
  request: z.object({
    method: z.enum(['GET', 'PATCH', 'POST', 'PUT', 'DELETE']),
    path: z.string(),
    body: z.unknown().optional(),
  }),
};

const savedChange = z.union([
  z.object({
    section: z.enum(sections).extract(listSections),
    // Plans saved before changes named their entry have none. No entry has
    // an empty name, so such a plan never matches a new one and reads as stale.
    entry: z
      .object({
        name: z.string(),
        branch_policy: z.object({ name: z.string(), type: z.enum(['branch', 'tag']) }).exactOptional(),
      })
      .default({ name: '' }),
    ...savedWrite,
  }),
  z.object({ section: z.enum(sections).exclude(listSections), ...savedWrite }),
]);

const savedPlan = z.object({
  source: planSource.optional(),
  authoritative: authoritativeSchema.exactOptional(),
  exclude: z.array(z.string()).exactOptional(),
  repository: z.string().regex(repoPattern),
  desired: profile,
  changes: z.array(savedChange),
  // Plans saved before drafts existed have none.
  skipped: z
    .array(z.object({ section: z.enum(sections), target: z.string(), unset: z.literal(true).optional() }))
    .default([]),
  warnings: z.array(
    z.union([
      z.object({
        section: z.enum(sections).exactOptional(),
        key: z.string().exactOptional(),
        field: z.string().exactOptional(),
        cause: z.enum(skipCauses).exactOptional(),
        remedy: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('permission'), permission: z.string() }),
            z.object({ kind: z.literal('admin_role') }),
            z.object({ kind: z.literal('payment_method') }),
          ])
          .exactOptional(),
        exclusion: z.string().exactOptional(),
        inactive_while: z.object({ key: z.string(), values: z.array(z.unknown()) }).exactOptional(),
        message: z.string(),
      }),
      // Plans saved before warnings were data give each as text. Apply
      // compares only changes, so such a warning is kept as its message.
      z.string().transform((message): Warning => ({ message })),
    ]),
  ),
});

export function parsePlan(data: unknown): Plan {
  return savedPlan.parse(data);
}
