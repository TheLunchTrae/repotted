import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { entryLists, type SaveMode } from '../../app/profile-editor/entry-edits.js';
import type { ProfileEditor, SettingFilter, SettingRow } from '../../app/profile-editor/profile-editor.js';
import { sameValue } from '../../app/profile-editor/same-value.js';
import { BarActions } from '../layout/action-bar.js';
import { run } from '../layout/run.js';
import { ActionSearchBox } from './action-search.js';
import { Entries } from './entries.js';
import { PatternChecks } from './pattern-checks.js';
import { SavePreviewDialog } from './save-preview.js';

function Control({ row, editor }: { readonly row: SettingRow; readonly editor: ProfileEditor }): JSX.Element {
  const { field, value, typedTextProblem: invalid, textBeingTyped: text } = row;
  const id = `setting-${field.path.join('-')}`;
  if (field.kind === 'choice') {
    return (
      <div class="segments" role="radiogroup" aria-labelledby={`${id}-label`}>
        {row.optionsForProfileOwnerType.map((option) => (
          <label key={option.label}>
            <input
              type="radio"
              name={id}
              checked={sameValue(option.value, value)}
              disabled={row.greyedOutOnGitHub}
              onChange={() => {
                run(editor.set(field, option.value));
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    );
  }
  const typed = (text: string): void => {
    run(editor.type(field, text));
  };
  if (field.kind === 'list') {
    return (
      <textarea
        id={id}
        class="field field-lines mono"
        rows={Math.max(3, Array.isArray(value) ? value.length + 1 : 3)}
        aria-labelledby={`${id}-label`}
        aria-invalid={invalid !== undefined}
        disabled={row.greyedOutOnGitHub}
        value={text ?? (Array.isArray(value) ? value.join('\n') : '')}
        onInput={(event) => {
          typed(event.currentTarget.value);
        }}
        onBlur={() => {
          editor.settle(field);
        }}
      />
    );
  }
  return (
    <input
      id={id}
      class={field.kind === 'number' ? 'field field-number' : 'field'}
      inputMode={field.kind === 'number' ? 'numeric' : undefined}
      aria-labelledby={`${id}-label`}
      aria-invalid={invalid !== undefined}
      disabled={row.greyedOutOnGitHub}
      placeholder={value === undefined ? 'Not managed' : undefined}
      value={text ?? (typeof value === 'string' || typeof value === 'number' ? String(value) : '')}
      onInput={(event) => {
        typed(event.currentTarget.value);
      }}
      onBlur={() => {
        editor.settle(field);
      }}
    />
  );
}

function describe(field: SettingRow['field'], value: unknown): string {
  if (value === undefined) {
    return 'not managed';
  }
  const option = field.options.find((item) => sameValue(item.value, value));
  if (option !== undefined) {
    return option.label;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? 'none' : value.join(', ');
  }
  return value === null || value === '' ? 'empty' : typeof value === 'string' ? value : JSON.stringify(value);
}

function Setting({ row, editor }: { readonly row: SettingRow; readonly editor: ProfileEditor }): JSX.Element {
  const { field } = row;
  const id = `setting-${field.path.join('-')}`;
  const managed = row.value !== undefined;
  // An apply's editor sets values in the apply, which a profile's sets in the profile.
  const here = editor.canHoldDrafts ? 'profile' : 'apply';
  return (
    <div
      class={`setting${field.indentedUnderPreviousSetting ? ' setting-nested' : ''}${row.unsaved ? ' setting-unsaved' : ''}`}
    >
      <div class="setting-head">
        <div class="setting-text">
          <span>
            <strong id={`${id}-label`}>{field.label}</strong>
            {row.valueShownIsFromDraft && <span class="pill pill-draft">Draft</span>}
            {row.ownerTag !== undefined && <span class="pill pill-owner">{row.ownerTag} only</span>}
          </span>
          <span class="muted small">
            {row.valueShownIsFromDraft
              ? `In the draft${managed ? '' : ': not managed'}. Applies now: ${describe(field, row.applied)}.`
              : !managed
                ? 'Not managed: each repository keeps its own.'
                : row.source === 'here'
                  ? `Set in this ${here}.`
                  : row.source === undefined
                    ? `Set in this ${here}, not saved yet.`
                    : `From ${row.source}.`}
            {row.unsaved && managed && row.source !== undefined && ' Not saved yet.'}
            {row.greyedOutOnGitHub && ' Off on GitHub for the setting above.'}
          </span>
        </div>
        <Control row={row} editor={editor} />
        <div class="setting-actions">
          {row.unsaved || row.typedTextProblem !== undefined ? (
            <button
              class="button button-quiet button-small"
              type="button"
              aria-label={`Reset ${field.label}`}
              onClick={() => {
                run(editor.reset(field));
              }}
            >
              Reset
            </button>
          ) : (
            row.source === 'here' && (
              <button
                class="button button-quiet button-small"
                type="button"
                aria-label={`Remove ${field.label}`}
                onClick={() => {
                  run(editor.set(field, undefined));
                }}
              >
                Remove
              </button>
            )
          )}
        </div>
      </div>
      {row.typedTextProblem !== undefined && (
        <p class="problem small" role="alert">
          {row.typedTextProblem}
        </p>
      )}
      {row.hiddenNamed > 0 && (
        <p class="muted small">
          The profile still names {row.hiddenNamed} {row.hiddenNamed === 1 ? 'setting' : 'settings'} that GitHub hides
          for this value.
        </p>
      )}
      {field.note !== undefined && <p class="muted small">{field.note}</p>}
      {field.kind === 'list' && field.key === 'selected_actions.patterns_allowed' && editor.patterns !== undefined && (
        <PatternChecks checks={editor.patterns} />
      )}
      {field.key === 'selected_actions.patterns_allowed' && editor.actionSearch !== undefined && (
        <ActionSearchBox editor={editor} search={editor.actionSearch} />
      )}
    </div>
  );
}

export interface EditorSaving {
  readonly save: (mode?: SaveMode) => Promise<void>;
  readonly discardDraft: () => Promise<void>;
  readonly onGitHub: boolean;
  readonly saveLabel?: string;
  readonly extraBarActions?: ComponentChildren;
  readonly primaryActionInsteadOfSave?: ComponentChildren;
}

interface DraftProps {
  readonly editor: ProfileEditor;
  readonly saving: EditorSaving;
}

function DiscardDraft({ saving, onClose }: DraftProps & { readonly onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog class="dialog" ref={dialog} aria-labelledby="discard-heading" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'discard') {
            run(saving.discardDraft());
          }
        }}
      >
        <h2 id="discard-heading">Discard the draft?</h2>
        <p>
          The profile goes back to what applies now. The changes in the draft can't be brought back
          {saving.onGitHub ? ", except from the repository's history" : ''}.
        </p>
        <div class="form-actions">
          <button class="button button-danger" type="submit" value="discard">
            Discard draft
          </button>
          {/* The dialog opens with the keyboard on Keep it, so Enter never discards by itself. */}
          <button class="button button-quiet" type="submit" value="keep" autofocus>
            Keep it
          </button>
        </div>
      </form>
    </dialog>
  );
}

function DraftBanner({ editor, saving }: DraftProps): JSX.Element | null {
  const [discarding, setDiscarding] = useState(false);
  const count = editor.draftCount.value;
  const warnings = editor.savedDraftWarnings.value;
  if (count === 0) {
    return null;
  }
  return (
    <div class="notice notice-drift">
      <p role="status">
        <strong>{count === 1 ? 'Draft: 1 change.' : `Draft: ${count} changes.`}</strong>{' '}
        {count === 1 ? "It doesn't" : "They don't"} apply yet: a plan leaves {count === 1 ? 'it' : 'them'} out until you
        save.
      </p>
      {warnings.length > 0 && (
        <ul>
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <div class="notice-actions">
        <button
          class="button button-small"
          type="button"
          disabled={!editor.canDiscardDraft.value}
          aria-describedby={editor.dirty.value ? 'discard-hint' : undefined}
          onClick={() => {
            setDiscarding(true);
          }}
        >
          Discard draft
        </button>
        {editor.dirty.value && (
          <span class="small" id="discard-hint">
            Save or reset your changes to discard the draft.
          </span>
        )}
      </div>
      {discarding && (
        <DiscardDraft
          editor={editor}
          saving={saving}
          onClose={() => {
            setDiscarding(false);
          }}
        />
      )}
    </div>
  );
}

const filterNames: readonly { readonly id: SettingFilter; readonly name: string }[] = [
  { id: 'managed', name: 'Managed' },
  { id: 'unsaved', name: 'Not saved yet' },
  { id: 'drafts', name: 'Drafts' },
];

const entryTitles = { rulesets: 'Rulesets', environments: 'Environments', labels: 'Labels' } as const;

interface ProfileSettingsProps {
  readonly name: string;
  readonly editor: ProfileEditor;
  readonly saving: EditorSaving;
  readonly ownerTypeHasPushRulesets: boolean;
}

export function ProfileSettings({ name, editor, saving, ownerTypeHasPushRulesets }: ProfileSettingsProps): JSX.Element {
  const sections = editor.sections.value;
  const [tab, setTab] = useState(sections[0]?.section.section ?? '');
  const entries = editor.entries.value;
  const list = entryLists.find((item) => item === tab);
  const shown = list === undefined ? (sections.find((item) => item.section.section === tab) ?? sections[0]) : undefined;
  const tabNames = [
    ...sections.map(({ section, groups }) => ({
      id: section.section,
      name: section.name,
      unsaved: groups.some((group) => group.rows.some((row) => row.unsaved || row.typedTextProblem !== undefined)),
      drafted: groups.some((group) => group.rows.some((row) => row.valueShownIsFromDraft)),
    })),
    ...entryLists.map((item) => ({
      id: item,
      name: entryTitles[item],
      unsaved: entries[item].some((row) => row.unsaved),
      drafted: entries[item].some((row) => row.inDraft !== undefined),
    })),
  ];
  const current = list ?? shown?.section.section ?? '';
  const filtering = editor.filtering.value;
  const preview = editor.preview.value;
  const search = useRef<HTMLInputElement>(null);
  const problem = editor.unsavedChangesProblem.value ?? editor.saveError.value;
  const tabs = useRef<HTMLDivElement>(null);
  // The arrow keys move between tabs, as in a tab list, and only the shown tab is a Tab stop.
  const move = (event: KeyboardEvent, index: number): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next = tabNames[(index + step + tabNames.length) % tabNames.length];
    if (step !== 0 && next !== undefined) {
      event.preventDefault();
      setTab(next.id);
      tabs.current?.querySelector<HTMLElement>(`#tab-${next.id}`)?.focus();
    }
  };
  const save = (
    <button
      class={saving.primaryActionInsteadOfSave === undefined ? 'button button-primary' : 'button'}
      type="button"
      disabled={!editor.canSave.value}
      onClick={() => {
        run(saving.save());
      }}
    >
      {saving.saveLabel ?? 'Save'}
    </button>
  );
  return (
    <>
      <DraftBanner editor={editor} saving={saving} />
      <div class="filters" role="search" aria-label="Settings">
        <input
          class="field"
          type="search"
          ref={search}
          placeholder="Find a setting"
          aria-label="Find a setting"
          value={editor.query.value}
          onInput={(event) => {
            editor.search(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              editor.search('');
            }
          }}
        />
        <div class="segments" role="group" aria-label="Show only">
          {filterNames
            .filter(({ id }) => id !== 'drafts' || editor.draftCount.value > 0 || editor.filters.value.has(id))
            .map(({ id, name }) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={editor.filters.value.has(id)}
                  onChange={(event) => {
                    editor.filter(id, event.currentTarget.checked);
                    // The Drafts filter goes once it is off on a profile with no draft, and takes the keyboard with it.
                    if (id === 'drafts' && !event.currentTarget.checked) {
                      search.current?.focus();
                    }
                  }}
                />
                <span>{name}</span>
              </label>
            ))}
        </div>
        {filtering && (
          <button
            class="button button-quiet button-small"
            type="button"
            onClick={() => {
              editor.clearFilters();
              search.current?.focus();
            }}
          >
            Show every setting
          </button>
        )}
        {/* The message is there before it has anything to say, so a screen reader announces what it comes to say. */}
        <p class={filtering ? 'muted small' : 'visually-hidden'} role="status">
          {filtering ? editor.foundSummary.value : ''}
        </p>
      </div>
      {editor.settingsHiddenForOwnerTypeCount.value > 0 && (
        <p class="muted small">
          {editor.settingsHiddenForOwnerTypeCount.value === 1
            ? '1 setting that only organizations have is hidden.'
            : `${editor.settingsHiddenForOwnerTypeCount.value} settings that only organizations have are hidden.`}
        </p>
      )}
      {filtering && (
        <div class="groups">
          {editor.found.value.map(({ tab: name, group, rows }) => (
            <section key={`${name} ${group.title}`} class="settings-group" aria-label={`${name}: ${group.title}`}>
              <div>
                <h2>
                  <span class="muted">{name}</span> {group.title}
                </h2>
                <p class="muted small">{group.description}</p>
              </div>
              <div class="settings">
                {rows.map((row) => (
                  <Setting key={row.field.key} row={row} editor={editor} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {!filtering && (
        <>
          <div class="tabs" role="tablist" aria-label="Settings" ref={tabs}>
            {tabNames.map(({ id, name, unsaved, drafted }, index) => (
              <button
                key={id}
                class="tab"
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-selected={current === id}
                aria-controls="settings-panel"
                tabIndex={current === id ? 0 : -1}
                onClick={() => {
                  setTab(id);
                }}
                onKeyDown={(event) => {
                  move(event, index);
                }}
              >
                {name}
                {drafted && <span class="pill pill-draft">Draft</span>}
                {unsaved && (
                  <>
                    <span class="dot" aria-hidden="true" />
                    <span class="visually-hidden">, not saved yet</span>
                  </>
                )}
              </button>
            ))}
          </div>
          {shown !== undefined && (
            <div id="settings-panel" class="groups" role="tabpanel" aria-labelledby={`tab-${shown.section.section}`}>
              {shown.groups.map(({ group, rows }) => (
                <section key={group.title} class="settings-group" aria-label={group.title}>
                  <div>
                    <h2>{group.title}</h2>
                    <p class="muted small">{group.description}</p>
                  </div>
                  <div class="settings">
                    {rows.map((row) => (
                      <Setting key={row.field.key} row={row} editor={editor} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          {list !== undefined && (
            <div id="settings-panel" role="tabpanel" aria-labelledby={`tab-${list}`}>
              <Entries key={list} editor={editor} list={list} ownerTypeHasPushRulesets={ownerTypeHasPushRulesets} />
            </div>
          )}
        </>
      )}
      {preview !== undefined && <SavePreviewDialog name={name} editor={editor} saving={saving} preview={preview} />}
      <div class="save-bar">
        {problem !== undefined && (
          <p class="problem" role="alert">
            {problem}
          </p>
        )}
        <span class="muted small" role="status">
          {editor.saving.value
            ? 'Saving…'
            : !editor.dirty.value
              ? editor.draftCount.value > 0
                ? 'Everything is saved, some of it as a draft. Save applies the draft.'
                : 'Everything is saved.'
              : editor.canSave.value || problem !== undefined
                ? (editor.draftProblem.value ?? 'You have changes that are not saved.')
                : editor.canSaveAsDraft.value
                  ? 'Correct what is marked to save, or keep it as a draft.'
                  : 'Correct what is marked, or reset it, to save.'}
        </span>
        <BarActions
          mainAction={saving.primaryActionInsteadOfSave ?? save}
          otherActions={
            <>
              <button
                class="button button-quiet"
                type="button"
                disabled={!editor.dirty.value || editor.saving.value}
                onClick={() => {
                  run(editor.resetAll());
                }}
              >
                Reset
              </button>
              {editor.canHoldDrafts && (
                <>
                  <button
                    class="button button-quiet"
                    type="button"
                    disabled={!editor.canSave.value}
                    onClick={() => {
                      run(editor.openPreview());
                    }}
                  >
                    Preview
                  </button>
                  <button
                    class="button"
                    type="button"
                    disabled={!editor.canSaveAsDraft.value}
                    onClick={() => {
                      run(saving.save('draft'));
                    }}
                  >
                    Save as draft
                  </button>
                </>
              )}
              {saving.primaryActionInsteadOfSave !== undefined && save}
              {saving.extraBarActions}
            </>
          }
        />
      </div>
    </>
  );
}
