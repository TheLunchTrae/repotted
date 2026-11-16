import { gitHubAppSlug } from '@repotted/core';
import type { JSX } from 'preact';
import { useId, useState } from 'preact/hooks';

import {
  builtInRepositoryRoleIds,
  bypassActorKey,
  bypassActorProblem,
  bypassActors,
  bypassModeFits,
  type BypassMode,
  bypassModes,
  deployKeysBypassActor,
  describeBypassActor,
  type GitHubAppLookup,
  hasBypassActor,
  type NewBypassActor,
  organizationAdminBypassActor,
  parseBypassActorId,
  withBypassActorAdded,
  withBypassActorsRemoved,
  withBypassListManaged,
  withBypassMode,
} from '../../app/profile-editor/bypass-actors.js';
import type { Entry } from '../../app/profile-editor/entry-forms.js';
import { useMenuPanelKeptOnPage } from '../layout/menu-placement.js';
import { run } from '../layout/run.js';
import { useDismissibleMenu } from '../layout/shell.js';

type AddForm = 'app' | 'team' | 'custom-role';

interface BypassListProps {
  readonly entry: Entry;
  readonly saved: Entry | undefined;
  readonly change: (entry: Entry) => void;
  readonly appLookup: GitHubAppLookup | undefined;
  readonly organizationActorsOffered: boolean;
}

function isBypassMode(value: string): value is BypassMode {
  return bypassModes.some(([mode]) => mode === value);
}

interface AddMenuProps {
  readonly entry: Entry;
  readonly organizationActorsOffered: boolean;
  readonly onAdd: (actor: NewBypassActor) => void;
  readonly onOpenForm: (form: AddForm) => void;
}

function AddMenu({ entry, organizationActorsOffered, onAdd, onOpenForm }: AddMenuProps): JSX.Element {
  const menu = useDismissibleMenu();
  useMenuPanelKeptOnPage(menu);
  const close = (): void => {
    if (menu.current !== null) {
      menu.current.open = false;
    }
  };
  const quickAdd = (label: string, actor: NewBypassActor): JSX.Element => {
    const added = hasBypassActor(entry, actor);
    return (
      <button
        key={bypassActorKey(actor)}
        class="menu-item"
        type="button"
        disabled={added}
        onClick={() => {
          close();
          onAdd(actor);
        }}
      >
        {label}
        {added && <span class="muted small"> Added</span>}
      </button>
    );
  };
  const formItem = (label: string, form: AddForm): JSX.Element => (
    <button
      class="menu-item"
      type="button"
      onClick={() => {
        close();
        onOpenForm(form);
      }}
    >
      {label}
    </button>
  );
  return (
    <details class="menu" ref={menu}>
      <summary class="button button-small">Add bypass</summary>
      <div class="menu-panel">
        <span class="menu-section">Roles</span>
        {builtInRepositoryRoleIds.map((id) => {
          const actor = { actor_type: 'RepositoryRole', actor_id: id };
          return quickAdd(describeBypassActor(actor, new Map()).name, actor);
        })}
        {organizationActorsOffered && quickAdd('Organization admin', organizationAdminBypassActor)}
        {organizationActorsOffered && formItem('Custom role by ID…', 'custom-role')}
        <span class="menu-section">Others</span>
        {quickAdd('Deploy keys', deployKeysBypassActor)}
        {formItem('GitHub App…', 'app')}
        {organizationActorsOffered && formItem('Team by ID…', 'team')}
      </div>
    </details>
  );
}

interface AddAppProps {
  readonly appLookup: GitHubAppLookup | undefined;
  readonly onAdd: (actor: NewBypassActor) => void;
  readonly onClose: () => void;
}

/** With no way to look an app up, as when applying to one repository, its ID is typed instead. */
function AddApp({ appLookup, onAdd, onClose }: AddAppProps): JSX.Element {
  const id = useId();
  const [typed, setTyped] = useState('');
  const state = appLookup?.state.value ?? { kind: 'idle' };
  const typedId = parseBypassActorId(typed);
  const slug = gitHubAppSlug(typed);
  const problem =
    typed.trim() === '' || typedId !== undefined || (appLookup !== undefined && slug !== undefined)
      ? undefined
      : appLookup === undefined
        ? 'An app’s ID is a whole number.'
        : 'Type the app’s name as its address has it, such as dependabot, or its ID.';
  const find = (): void => {
    if (typedId !== undefined) {
      onAdd({ actor_type: 'Integration', actor_id: typedId });
      return;
    }
    if (slug !== undefined && appLookup !== undefined) {
      run(appLookup.find(slug));
    }
  };
  return (
    <form
      class="bypass-add"
      onSubmit={(event) => {
        event.preventDefault();
        find();
      }}
    >
      <label for={id}>
        <strong>GitHub App</strong>
      </label>
      <span id={`${id}-note`} class="muted small">
        {appLookup === undefined
          ? 'The app’s ID, from its settings page on GitHub.'
          : 'The name in its address, such as dependabot for github.com/apps/dependabot, or its ID.'}
      </span>
      <div class="bypass-add-row">
        <input
          id={id}
          class="field mono"
          autoComplete="off"
          aria-describedby={`${id}-note ${id}-problem`}
          aria-invalid={problem !== undefined}
          value={typed}
          onInput={(event) => {
            setTyped(event.currentTarget.value);
            appLookup?.reset();
          }}
        />
        <button
          class="button button-small"
          type="submit"
          disabled={typedId === undefined && (slug === undefined || appLookup === undefined)}
        >
          {typedId === undefined ? 'Find' : 'Add'}
        </button>
        <button class="button button-quiet button-small" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
      <p id={`${id}-problem`} class="problem small" role={problem === undefined ? undefined : 'alert'}>
        {problem ??
          (state.kind === 'missing'
            ? `GitHub has no app at github.com/apps/${state.slug} that you can see.`
            : state.kind === 'failed'
              ? state.message
              : undefined)}
      </p>
      {state.kind === 'finding' && <p class="muted small">Finding it on GitHub…</p>}
      {state.kind === 'found' && (
        <div class="bypass-found">
          <span>
            {state.app.name}, app {state.app.id}
          </span>
          <button
            class="button button-small"
            type="button"
            onClick={() => {
              onAdd({ actor_type: 'Integration', actor_id: state.app.id });
            }}
          >
            Add
          </button>
        </div>
      )}
    </form>
  );
}

interface AddByIdProps {
  readonly form: 'team' | 'custom-role';
  readonly onAdd: (actor: NewBypassActor) => void;
  readonly onClose: () => void;
}

function AddById({ form, onAdd, onClose }: AddByIdProps): JSX.Element {
  const id = useId();
  const [typed, setTyped] = useState('');
  const parsed = parseBypassActorId(typed);
  const problem = typed.trim() !== '' && parsed === undefined ? 'An ID is a whole number.' : undefined;
  return (
    <form
      class="bypass-add"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed !== undefined) {
          onAdd({ actor_type: form === 'team' ? 'Team' : 'RepositoryRole', actor_id: parsed });
        }
      }}
    >
      <label for={id}>
        <strong>{form === 'team' ? 'Team ID' : 'Custom role ID'}</strong>
      </label>
      <span id={`${id}-note`} class="muted small">
        {form === 'team'
          ? 'Repotted can’t list your teams, since that needs the Members permission the Repotted App doesn’t ask for. GitHub gives a team’s ID at /orgs/ORGANIZATION/teams/TEAM in its API.'
          : 'GitHub gives each custom role’s ID at /orgs/ORGANIZATION/custom-repository-roles in its API.'}
      </span>
      <div class="bypass-add-row">
        <input
          id={id}
          class="field mono"
          inputMode="numeric"
          autoComplete="off"
          aria-describedby={`${id}-note ${id}-problem`}
          aria-invalid={problem !== undefined}
          value={typed}
          onInput={(event) => {
            setTyped(event.currentTarget.value);
          }}
        />
        <button class="button button-small" type="submit" disabled={parsed === undefined}>
          Add
        </button>
        <button class="button button-quiet button-small" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
      <p id={`${id}-problem`} class="problem small" role={problem === undefined ? undefined : 'alert'}>
        {problem}
      </p>
    </form>
  );
}

/**
 * Who can bypass the ruleset. Leaving it to GitHub keeps each repository's
 * own list; managing it makes the list exactly this on each repository.
 */
export function BypassList({
  entry,
  saved,
  change,
  appLookup,
  organizationActorsOffered,
}: BypassListProps): JSX.Element {
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [openForm, setOpenForm] = useState<AddForm | undefined>(undefined);
  const selectAllId = useId();
  const managed = entry['bypass_actors'] !== undefined;
  const actors = bypassActors(entry);
  const appNames = appLookup?.namesById.value ?? new Map<number, string>();
  const listedKeys = new Set(actors.map((actor) => bypassActorKey(actor)));
  const selected = new Set([...selectedKeys].filter((key) => listedKeys.has(key)));
  const everySelected = actors.length > 0 && selected.size === actors.length;
  const add = (actor: NewBypassActor): void => {
    setOpenForm(undefined);
    appLookup?.reset();
    change(withBypassActorAdded(entry, actor));
  };
  const closeForm = (): void => {
    setOpenForm(undefined);
    appLookup?.reset();
  };
  const select = (key: string, on: boolean): void => {
    const next = new Set(selected);
    if (on) {
      next.add(key);
    } else {
      next.delete(key);
    }
    setSelectedKeys(next);
  };
  const remove = (keys: ReadonlySet<string>): void => {
    setSelectedKeys(new Set([...selected].filter((key) => !keys.has(key))));
    change(withBypassActorsRemoved(entry, keys));
  };
  return (
    <section class="settings-group" aria-label="Bypass list" data-entry-field="bypass-list" tabIndex={-1}>
      <div>
        <h2>Bypass list</h2>
        <p class="muted small">
          {!managed
            ? 'Not set here, so each repository keeps its own.'
            : actors.length === 0
              ? 'Nobody bypasses it. Applying removes every bypass each repository has.'
              : 'Exactly these bypass it on each repository. Applying removes every other bypass.'}
        </p>
      </div>
      <div class="settings">
        {!managed ? (
          <div class="setting">
            <button
              class="button button-small"
              type="button"
              onClick={() => {
                change(withBypassListManaged(entry, true, saved));
              }}
            >
              Manage the bypass list
            </button>
          </div>
        ) : (
          <>
            {selected.size > 0 && (
              <div class="bypass-selection">
                <strong>{selected.size} selected</strong>
                <select
                  class="field"
                  aria-label="Set when the selected ones can bypass"
                  value=""
                  onChange={(event) => {
                    const mode = event.currentTarget.value;
                    if (isBypassMode(mode)) {
                      change(withBypassMode(entry, selected, mode));
                    }
                  }}
                >
                  <option value="">Set mode…</option>
                  {bypassModes.map(([mode, label]) => (
                    <option key={mode} value={mode}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  class="button button-small"
                  type="button"
                  onClick={() => {
                    remove(selected);
                  }}
                >
                  Remove selected
                </button>
                <button
                  class="button button-quiet button-small"
                  type="button"
                  onClick={() => {
                    setSelectedKeys(new Set());
                  }}
                >
                  Deselect all
                </button>
              </div>
            )}
            {actors.length > 0 && (
              <div class="bypass-select-all">
                <label class="check small" for={selectAllId}>
                  <input
                    id={selectAllId}
                    type="checkbox"
                    checked={everySelected}
                    onChange={() => {
                      setSelectedKeys(everySelected ? new Set() : listedKeys);
                    }}
                  />
                  {everySelected ? 'Deselect all' : 'Select all'}
                </label>
              </div>
            )}
            {actors.map((actor) => {
              const key = bypassActorKey(actor);
              const { name, kind } = describeBypassActor(actor, appNames);
              const problem = bypassActorProblem(actor, entry['target']);
              const mode = typeof actor['bypass_mode'] === 'string' ? actor['bypass_mode'] : 'always';
              return (
                <div class="bypass-row" key={key}>
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    aria-label={`Select ${name}`}
                    onChange={(event) => {
                      select(key, event.currentTarget.checked);
                    }}
                  />
                  <div class="bypass-who">
                    <strong>{name}</strong>
                    <span class="muted small">{kind}</span>
                    {problem !== undefined && (
                      <span class="problem small" role="alert">
                        {problem}
                      </span>
                    )}
                  </div>
                  <select
                    class="field"
                    aria-label={`When ${name} can bypass`}
                    aria-invalid={problem !== undefined}
                    value={mode}
                    onChange={(event) => {
                      const chosen = event.currentTarget.value;
                      if (isBypassMode(chosen)) {
                        change(withBypassMode(entry, new Set([key]), chosen));
                      }
                    }}
                  >
                    {bypassModes.map(([option, label]) => (
                      <option
                        key={option}
                        value={option}
                        disabled={option !== mode && !bypassModeFits(actor, option, entry['target'])}
                      >
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    class="button button-quiet button-small"
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => {
                      remove(new Set([key]));
                    }}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            {openForm === 'app' && <AddApp appLookup={appLookup} onAdd={add} onClose={closeForm} />}
            {(openForm === 'team' || openForm === 'custom-role') && (
              <AddById key={openForm} form={openForm} onAdd={add} onClose={closeForm} />
            )}
            <div class="bypass-tools">
              <AddMenu
                entry={entry}
                organizationActorsOffered={organizationActorsOffered}
                onAdd={add}
                onOpenForm={(form) => {
                  appLookup?.reset();
                  setOpenForm(form);
                }}
              />
              {actors.length > 0 && (
                <button
                  class="button button-quiet button-small"
                  type="button"
                  onClick={() => {
                    remove(listedKeys);
                  }}
                >
                  Remove all
                </button>
              )}
              <button
                class="button button-quiet button-small bypass-leave"
                type="button"
                onClick={() => {
                  setSelectedKeys(new Set());
                  closeForm();
                  change(withBypassListManaged(entry, false, saved));
                }}
              >
                Leave it to GitHub
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
