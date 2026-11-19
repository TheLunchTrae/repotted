import { gitHubAppSlug } from '@repotted/core';
import type { JSX, RefObject } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { PendingButton } from '../layout/pending-button.js';

import {
  builtInRepositoryRoleIds,
  bypassActorKey,
  bypassActorNote,
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

function closeMenu(menu: RefObject<HTMLDetailsElement | null>): void {
  if (menu.current !== null) {
    menu.current.open = false;
  }
}

function closeMenuAndFocusItsButton(menu: RefObject<HTMLDetailsElement | null>): void {
  closeMenu(menu);
  menu.current?.querySelector('summary')?.focus();
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
  const rolesHeadingId = useId();
  const othersHeadingId = useId();
  const quickAdd = (label: string, actor: NewBypassActor): JSX.Element => {
    const added = hasBypassActor(entry, actor);
    return (
      <button
        key={bypassActorKey(actor)}
        class="menu-item"
        type="button"
        disabled={added}
        onClick={() => {
          closeMenuAndFocusItsButton(menu);
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
        closeMenu(menu);
        onOpenForm(form);
      }}
    >
      {label}
    </button>
  );
  return (
    <details class="menu" ref={menu}>
      <summary class="button button-small" data-bypass-focus="add">
        Add bypass
      </summary>
      <div class="menu-panel">
        <div class="menu-group" role="group" aria-labelledby={rolesHeadingId}>
          <span id={rolesHeadingId} class="menu-section">
            Roles
          </span>
          {builtInRepositoryRoleIds.map((id) => {
            const actor = { actor_type: 'RepositoryRole', actor_id: id };
            return quickAdd(describeBypassActor(actor, new Map()).name, actor);
          })}
          {organizationActorsOffered && quickAdd('Organization admin', organizationAdminBypassActor)}
          {organizationActorsOffered && formItem('Custom role by ID…', 'custom-role')}
        </div>
        <div class="menu-group" role="group" aria-labelledby={othersHeadingId}>
          <span id={othersHeadingId} class="menu-section">
            Others
          </span>
          {quickAdd('Deploy keys', deployKeysBypassActor)}
          {formItem('GitHub App…', 'app')}
          {organizationActorsOffered && formItem('Team by ID…', 'team')}
        </div>
      </div>
    </details>
  );
}

interface SetModeMenuProps {
  readonly onSet: (mode: BypassMode) => void;
}

function SetModeMenu({ onSet }: SetModeMenuProps): JSX.Element {
  const menu = useDismissibleMenu();
  useMenuPanelKeptOnPage(menu);
  return (
    <details class="menu" ref={menu}>
      <summary class="button button-small" aria-label="Set when the selected ones can bypass">
        Set mode
      </summary>
      <div class="menu-panel">
        {bypassModes.map(([mode, label]) => (
          <button
            key={mode}
            class="menu-item"
            type="button"
            onClick={() => {
              closeMenuAndFocusItsButton(menu);
              onSet(mode);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </details>
  );
}

function useFocusOnOpen(): RefObject<HTMLInputElement | null> {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return input;
}

const alreadyListed = 'Already in the bypass list.';

interface AddAppProps {
  readonly appLookup: GitHubAppLookup | undefined;
  readonly isListed: (actor: NewBypassActor) => boolean;
  readonly onAdd: (actor: NewBypassActor) => void;
  readonly onClose: () => void;
}

/** With no way to look an app up, as when applying to one repository, its ID is typed instead. */
function AddApp({ appLookup, isListed, onAdd, onClose }: AddAppProps): JSX.Element {
  const id = useId();
  const input = useFocusOnOpen();
  const [typed, setTyped] = useState('');
  const state = appLookup?.state.value ?? { kind: 'idle' };
  const typedId = parseBypassActorId(typed);
  const slug = gitHubAppSlug(typed);
  const ready: NewBypassActor | undefined =
    typedId !== undefined
      ? { actor_type: 'Integration', actor_id: typedId }
      : state.kind === 'found'
        ? { actor_type: 'Integration', actor_id: state.app.id }
        : undefined;
  const readyIsListed = ready !== undefined && isListed(ready);
  const problem =
    typed.trim() === ''
      ? undefined
      : readyIsListed
        ? alreadyListed
        : typedId !== undefined || (appLookup !== undefined && slug !== undefined)
          ? state.kind === 'missing'
            ? `GitHub has no app at github.com/apps/${state.slug} that you can see.`
            : state.kind === 'failed'
              ? state.message
              : undefined
          : appLookup === undefined
            ? 'An app’s ID is a whole number.'
            : 'Type the app’s name as its address has it, such as dependabot, or its ID.';
  const status =
    state.kind === 'finding'
      ? 'Finding it on GitHub…'
      : state.kind === 'found'
        ? `Found ${state.app.name}, app ${state.app.id}.`
        : undefined;
  const submit = (): void => {
    if (ready !== undefined) {
      if (!readyIsListed) {
        onAdd(ready);
      }
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
        submit();
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
          ref={input}
          id={id}
          class="field mono"
          autoComplete="off"
          aria-describedby={`${id}-note ${id}-problem ${id}-status`}
          aria-invalid={problem !== undefined}
          value={typed}
          onInput={(event) => {
            setTyped(event.currentTarget.value);
            appLookup?.reset();
          }}
        />
        <PendingButton
          pending={appLookup?.state.value.kind === 'finding'}
          class="button button-small"
          type="submit"
          disabled={
            readyIsListed ||
            state.kind === 'finding' ||
            (ready === undefined && (slug === undefined || appLookup === undefined))
          }
        >
          {ready === undefined ? 'Find' : 'Add'}
        </PendingButton>
        <button class="button button-quiet button-small" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
      <div class="bypass-add-messages">
        <p id={`${id}-problem`} class="problem small" role="alert">
          {problem}
        </p>
        <p id={`${id}-status`} class="muted small" role="status">
          {status}
        </p>
      </div>
    </form>
  );
}

interface AddByIdProps {
  readonly form: 'team' | 'custom-role';
  readonly isListed: (actor: NewBypassActor) => boolean;
  readonly onAdd: (actor: NewBypassActor) => void;
  readonly onClose: () => void;
}

function AddById({ form, isListed, onAdd, onClose }: AddByIdProps): JSX.Element {
  const id = useId();
  const input = useFocusOnOpen();
  const [typed, setTyped] = useState('');
  const parsed = parseBypassActorId(typed);
  const actor: NewBypassActor | undefined =
    parsed === undefined ? undefined : { actor_type: form === 'team' ? 'Team' : 'RepositoryRole', actor_id: parsed };
  const listed = actor !== undefined && isListed(actor);
  const problem =
    typed.trim() !== '' && parsed === undefined ? 'An ID is a whole number.' : listed ? alreadyListed : undefined;
  return (
    <form
      class="bypass-add"
      onSubmit={(event) => {
        event.preventDefault();
        if (actor !== undefined && !listed) {
          onAdd(actor);
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
          ref={input}
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
        <button class="button button-small" type="submit" disabled={actor === undefined || listed}>
          Add
        </button>
        <button class="button button-quiet button-small" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
      <div class="bypass-add-messages">
        <p id={`${id}-problem`} class="problem small" role="alert">
          {problem}
        </p>
      </div>
    </form>
  );
}

type FocusAfterChange = (section: HTMLElement) => HTMLElement | null | undefined;

const focusAddButton: FocusAfterChange = (section) => section.querySelector<HTMLElement>('[data-bypass-focus="add"]');

function rowCheckboxes(section: HTMLElement): HTMLInputElement[] {
  return [...section.querySelectorAll<HTMLInputElement>('input[data-bypass-row]')];
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
  const section = useRef<HTMLElement>(null);
  const pendingFocus = useRef<{ readonly pick: FocusAfterChange; readonly entryBefore: Entry | undefined } | undefined>(
    undefined,
  );
  // The control that was used is often gone after the change, so the keyboard
  // is handed to the nearest one left once the list shows the change.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === undefined || pending.entryBefore === entry || section.current === null) {
      return;
    }
    pendingFocus.current = undefined;
    pending.pick(section.current)?.focus();
  });
  const focusAfterRender = (pick: FocusAfterChange): void => {
    pendingFocus.current = { pick, entryBefore: undefined };
  };
  const focusAfterEntryChange = (pick: FocusAfterChange): void => {
    pendingFocus.current = { pick, entryBefore: entry };
  };
  const selectAllId = useId();
  const managed = entry['bypass_actors'] !== undefined;
  const actors = bypassActors(entry);
  const appNames = appLookup?.namesById.value ?? new Map<number, string>();
  const listedKeys = new Set(actors.map((actor) => bypassActorKey(actor)));
  const selected = new Set([...selectedKeys].filter((key) => listedKeys.has(key)));
  const everySelected = actors.length > 0 && selected.size === listedKeys.size;
  const isListed = (actor: NewBypassActor): boolean => hasBypassActor(entry, actor);
  const add = (actor: NewBypassActor): void => {
    focusAfterEntryChange(focusAddButton);
    setOpenForm(undefined);
    appLookup?.reset();
    change(withBypassActorAdded(entry, actor));
  };
  const closeForm = (): void => {
    focusAfterRender(focusAddButton);
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
  const remove = (keys: ReadonlySet<string>, firstRemovedIndex: number): void => {
    focusAfterEntryChange((element) => {
      const rows = rowCheckboxes(element);
      return rows[firstRemovedIndex] ?? rows.at(-1) ?? focusAddButton(element);
    });
    setSelectedKeys(new Set([...selected].filter((key) => !keys.has(key))));
    change(withBypassActorsRemoved(entry, keys));
  };
  return (
    <section class="settings-group" aria-label="Bypass list" data-entry-field="bypass-list" tabIndex={-1} ref={section}>
      <div>
        <h2>Bypass list</h2>
        <p class="muted small">
          {!managed
            ? 'Not set here, so each repository keeps its own.'
            : actors.length === 0
              ? 'Nobody bypasses it. Applying removes every bypass each repository has.'
              : 'Exactly these bypass it on each repository. Applying removes every other bypass.'}
        </p>
        {managed && (
          <p class="muted small">
            Always and Pull requests only record each bypass on GitHub. Exempt skips the rules without recording one.
          </p>
        )}
      </div>
      <div class="settings">
        {!managed ? (
          <div class="setting">
            <button
              class="button button-small"
              type="button"
              data-bypass-focus="manage"
              onClick={() => {
                focusAfterEntryChange(focusAddButton);
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
                <SetModeMenu
                  onSet={(mode) => {
                    change(withBypassMode(entry, selected, mode));
                  }}
                />
                <button
                  class="button button-small"
                  type="button"
                  onClick={() => {
                    remove(
                      selected,
                      actors.findIndex((actor) => selected.has(bypassActorKey(actor))),
                    );
                  }}
                >
                  Remove selected
                </button>
                <button
                  class="button button-quiet button-small"
                  type="button"
                  onClick={() => {
                    focusAfterRender((element) => element.querySelector<HTMLElement>(`[id="${selectAllId}"]`));
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
                    indeterminate={selected.size > 0 && !everySelected}
                    onChange={() => {
                      setSelectedKeys(everySelected ? new Set() : listedKeys);
                    }}
                  />
                  Select all
                </label>
              </div>
            )}
            {actors.map((actor, index) => {
              const key = bypassActorKey(actor);
              const { name, kind } = describeBypassActor(actor, appNames);
              const problem = bypassActorProblem(actor, entry['target']);
              const note = bypassActorNote(actor, entry['target']);
              const mode = typeof actor['bypass_mode'] === 'string' ? actor['bypass_mode'] : 'always';
              return (
                <div class="bypass-row" key={`${key}#${String(index)}`}>
                  <input
                    type="checkbox"
                    data-bypass-row={index}
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
                    {note !== undefined && <span class="muted small">{note}</span>}
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
                      remove(new Set([key]), index);
                    }}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            {openForm === 'app' && <AddApp appLookup={appLookup} isListed={isListed} onAdd={add} onClose={closeForm} />}
            {(openForm === 'team' || openForm === 'custom-role') && (
              <AddById key={openForm} form={openForm} isListed={isListed} onAdd={add} onClose={closeForm} />
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
                    remove(listedKeys, 0);
                  }}
                >
                  Remove all
                </button>
              )}
              <button
                class="button button-quiet button-small bypass-leave"
                type="button"
                onClick={() => {
                  focusAfterEntryChange((element) =>
                    element.querySelector<HTMLElement>('[data-bypass-focus="manage"]'),
                  );
                  setSelectedKeys(new Set());
                  setOpenForm(undefined);
                  appLookup?.reset();
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
