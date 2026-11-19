import {
  type Document,
  isAlias,
  isMap,
  isNode,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
  visit,
  YAMLMap,
} from 'yaml';
import { z } from 'zod';

import { settleIgnoredBypassActorIds } from './bypass-actors.js';
import { actionPolicyEntry, autolinkEntry, environmentEntry, labelEntry, profileFile, rulesetEntry } from './schema.js';

type FieldPath = readonly (string | number)[];
const entries = {
  autolinks: autolinkEntry,
  actions_policies: actionPolicyEntry,
  rulesets: rulesetEntry,
  environments: environmentEntry,
  labels: labelEntry,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function acceptsDiscriminator(schema: z.core.$ZodType, key: string, value: unknown): boolean {
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return schema.options.some((option) => acceptsDiscriminator(option, key, value));
  }
  const field: unknown = schema instanceof z.ZodObject ? schema.shape[key] : undefined;
  return field instanceof z.ZodType && field.safeParse(value).success;
}

/** Drafts keep unfinished known values, using the same field names as applying configuration. */
function schemaAt(schema: z.core.$ZodType, path: FieldPath): z.core.$ZodType {
  const [section, key] = path;
  if (section === 'drafts' && path.length === 2 && key !== 'unset' && typeof key === 'string') {
    const field: unknown = Reflect.get(profileFile.shape, key);
    return field instanceof z.ZodType ? field : schema;
  }
  if (path.length === 2 && typeof section === 'string' && typeof key === 'number') {
    const entry: unknown = Reflect.get(entries, section);
    return entry instanceof z.ZodType ? entry : schema;
  }
  return schema;
}

function schemaForValue(schema: z.core.$ZodType, value: unknown): z.core.$ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return schemaForValue(schema.unwrap(), value);
  }
  if (schema instanceof z.ZodDiscriminatedUnion && isRecord(value)) {
    const key = schema.def.discriminator;
    const branch =
      schema.options.find((option) => acceptsDiscriminator(option, key, value[key])) ??
      schema.options.find((option) => acceptsDiscriminator(option, key, undefined));
    return branch === undefined ? schema : schemaForValue(branch, value);
  }
  return schema;
}

export function profileFields(value: unknown): { readonly known: unknown; readonly unknown: readonly FieldPath[] } {
  const unknown: FieldPath[] = [];
  const read = (schema: z.core.$ZodType, value: unknown, path: FieldPath): unknown => {
    // References are instructions to load another file; a misspelled kind must not silently stop managing it.
    if (path.length === 1 && path[0] === 'references') {
      return value;
    }
    const field = schemaForValue(schemaAt(schema, path), value);
    if (field instanceof z.ZodObject && isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          const child: unknown = field.shape[key];
          if (child instanceof z.ZodType) {
            return [[key, read(child, item, [...path, key])]];
          }
          if (field.def.catchall instanceof z.ZodUnknown) {
            return [[key, item]];
          }
          unknown.push([...path, key]);
          return [];
        }),
      );
    }
    if (field instanceof z.ZodArray && Array.isArray(value)) {
      return value.map((item, index) => read(field.element, item, [...path, index]));
    }
    return value;
  };
  return { known: read(profileFile, value, []), unknown };
}

export function moveLeadingCommentAndBlankLine(from: Node, to: Node): void {
  if (from.commentBefore !== undefined && from.commentBefore !== null) {
    // A comment the key already has stays, under the one that moves.
    to.commentBefore =
      to.commentBefore === undefined || to.commentBefore === null
        ? from.commentBefore
        : `${from.commentBefore}\n${to.commentBefore}`;
    from.commentBefore = null;
  }
  if (from.spaceBefore === true) {
    to.spaceBefore = true;
    from.spaceBefore = false;
  }
}

/** Only keys go; known values, their comments, and list positions stay. */
export function removeUnknownProfileFields(document: Document): void {
  const { known, unknown } = profileFields(document.toJS());
  if (unknown.length === 0) {
    return;
  }
  const keys = new Map<Pair, string>();
  // Use YAML's conversion for alias, complex, null, and newly inserted keys too.
  visit(document, {
    Map: (_, map) => {
      for (const pair of map.items) {
        const single = new YAMLMap();
        single.items = [pair];
        const converted: unknown = single.toJS(document);
        const [key] = isRecord(converted) ? Object.keys(converted) : [];
        if (key !== undefined) {
          keys.set(pair, key);
        }
      }
    },
  });
  const replacementFor = (node: Node, value: unknown): Node => {
    const replacement = document.createNode(value);
    if (node.comment !== undefined) {
      replacement.comment = node.comment;
    }
    if (node.commentBefore !== undefined) {
      replacement.commentBefore = node.commentBefore;
    }
    return replacement;
  };
  const retain = (node: unknown, value: unknown): unknown => {
    if (isAlias(node)) {
      // An anchor can serve different sections. Each alias keeps the fields known at its own use.
      return replacementFor(node, value);
    }
    if (isMap(node) && isRecord(value)) {
      const first = node.items[0]?.key;
      node.items = node.items.filter((pair) => {
        const key = keys.get(pair);
        return key !== undefined && Object.hasOwn(value, key);
      });
      const kept = node.items[0]?.key;
      if (first !== kept && isNode(first)) {
        moveLeadingCommentAndBlankLine(first, isNode(kept) ? kept : node);
      }
      for (const pair of node.items) {
        const key = keys.get(pair);
        if (key !== undefined) {
          if (isAlias(pair.key) || isMap(pair.key) || isSeq(pair.key)) {
            pair.key = replacementFor(pair.key, key);
          }
          pair.value = retain(pair.value, value[key]);
        }
      }
    } else if (isSeq(node) && Array.isArray(value)) {
      node.items = node.items.map((item, index) => retain(item, value[index]));
    }
    return node;
  };
  retain(document.contents, known);
}

export function tidyProfileDocument(document: Document): void {
  removeUnknownProfileFields(document);
  settleIgnoredBypassActorIds(document);
}

export function tidiedProfileText(text: string): string {
  const document: Document = parseDocument(text);
  const [error] = document.errors;
  if (error !== undefined) {
    throw error;
  }
  const hasUnknownFields = profileFields(document.toJS()).unknown.length > 0;
  removeUnknownProfileFields(document);
  const settledBypassActorIds = settleIgnoredBypassActorIds(document);
  if (!hasUnknownFields && !settledBypassActorIds) {
    return text;
  }
  const indent = /^( +)\S/mu.exec(text)?.[1]?.length ?? 2;
  const result = document.toString({ lineWidth: 0, indent });
  return text.includes('\r\n') ? result.replaceAll('\n', '\r\n') : result;
}
