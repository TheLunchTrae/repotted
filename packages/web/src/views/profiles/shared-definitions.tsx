import type { ProfileReferences } from '@repotted/core';
import type { JSX } from 'preact';

import type { Router } from '../../app/navigation/router.js';
import { definitionTypes } from '../../app/profiles/definition-types.js';
import type { Profiles } from '../../app/profiles/profiles.js';
import { relative, resolve } from '../../engine/path.js';
import { Link } from '../layout/link.js';

interface SharedDefinitionProps {
  readonly section: string;
  readonly profiles: Profiles;
  readonly folder: string;
  readonly references: ProfileReferences;
  readonly onChange: (references: ProfileReferences) => void;
  readonly disabled: boolean;
  readonly router?: Router;
  readonly inherited?: readonly string[];
}

export function SharedDefinition({
  section,
  profiles,
  folder,
  references,
  onChange,
  disabled,
  router,
  inherited = [],
}: SharedDefinitionProps): JSX.Element | null {
  const library = definitionTypes.find((item) => item.section === section);
  if (library === undefined) {
    return null;
  }
  const kind = library.kind === 'actions-policy' ? 'actions' : library.kind === 'ruleset' ? 'rulesets' : 'environments';
  const noun = library.kind === 'actions-policy' ? library.label : library.label.toLowerCase();
  const named =
    kind === 'actions' ? (references.actions === undefined ? [] : [references.actions]) : (references[kind] ?? []);
  const available = profiles.definitions.value.filter((definition) => definition.kind === library.kind);
  const inheritedDefinitions = available.filter(
    (definition) =>
      inherited.includes(definition.file) && !named.some((name) => resolve(folder, name) === definition.file),
  );
  const change = (names: string[]): void => {
    const next = { ...references };
    if (kind === 'actions') {
      if (names[0] === undefined) {
        delete next.actions;
      } else {
        next.actions = names[0];
      }
    } else if (kind === 'rulesets') {
      if (names.length === 0) {
        delete next.rulesets;
      } else {
        next.rulesets = names;
      }
    } else if (names.length === 0) {
      delete next.environments;
    } else {
      next.environments = names;
    }
    onChange(next);
  };
  return (
    <fieldset class="shared-definition-group" disabled={disabled}>
      <legend>Use a reusable {noun}</legend>
      <p class="muted small">
        Linked definitions stay up to date with their library. Settings in this profile can override shared values.
      </p>
      {named.map((name) => {
        const definition = available.find((item) => item.file === resolve(folder, name));
        return (
          <div class="shared-definition-row" key={name}>
            <span>
              <strong>{definition?.name ?? name}</strong>
              <span class="pill">Linked</span>
            </span>
            {router !== undefined && definition !== undefined && (
              <Link
                router={router}
                to={`${library.path}?definition=${encodeURIComponent(profiles.pathOf(definition))}`}
              >
                Edit shared definition
              </Link>
            )}
            <button
              class="button button-quiet button-small"
              type="button"
              aria-label={`Remove ${definition?.name ?? name} reference`}
              onClick={() => change(named.filter((item) => item !== name))}
            >
              Remove
            </button>
          </div>
        );
      })}
      {inheritedDefinitions.map((definition) => (
        <div class="shared-definition-row" key={definition.file}>
          <span>
            <strong>{definition.name}</strong>
            <span class="muted small">From a base profile</span>
          </span>
          {router !== undefined && (
            <Link router={router} to={`${library.path}?definition=${encodeURIComponent(profiles.pathOf(definition))}`}>
              Edit shared definition
            </Link>
          )}
        </div>
      ))}
      <label class="form-field">
        <span class="visually-hidden">Use a reusable {noun}</span>
        <select
          class="field"
          value=""
          aria-label={`Use a reusable ${noun}`}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value !== '') {
              change(kind === 'actions' ? [value] : [...named, value]);
            }
          }}
        >
          <option value="">
            Select {library.kind === 'ruleset' ? 'a' : 'an'} {noun}…
          </option>
          {available
            .filter(
              (definition) =>
                definition.problem === null && !named.some((name) => resolve(folder, name) === definition.file),
            )
            .map((definition) => (
              <option key={definition.file} value={relative(folder, definition.file)}>
                {definition.name}
              </option>
            ))}
        </select>
      </label>
      {available.length === 0 && (
        <p class="muted small">
          No reusable {noun} is available yet.{' '}
          {kind === 'actions'
            ? 'Use the option below to save these settings as a reusable Actions policy.'
            : `Use New ${noun} and choose Also save as a reusable ${noun}.`}
        </p>
      )}
    </fieldset>
  );
}
