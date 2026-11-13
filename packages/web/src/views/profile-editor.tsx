import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { ProfileEditor, SettingRow } from '../app/profile-editor.js';
import type { Profiles } from '../app/profiles.js';
import { run } from './run.js';

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function Control({ row, editor }: { readonly row: SettingRow; readonly editor: ProfileEditor }): JSX.Element {
  const { field, value, invalid } = row;
  const id = `setting-${field.path.join('-')}`;
  if (field.kind === 'choice') {
    return (
      <div class="segments" role="radiogroup" aria-labelledby={`${id}-label`}>
        {field.options.map((option) => (
          <label key={option.label}>
            <input
              type="radio"
              name={id}
              checked={sameValue(option.value, value)}
              disabled={row.off}
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
        disabled={row.off}
        value={invalid?.text ?? (Array.isArray(value) ? value.join('\n') : '')}
        onChange={(event) => {
          typed(event.currentTarget.value);
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
      disabled={row.off}
      placeholder={value === undefined ? 'Not managed' : undefined}
      value={invalid?.text ?? (typeof value === 'string' || typeof value === 'number' ? String(value) : '')}
      onChange={(event) => {
        typed(event.currentTarget.value);
      }}
    />
  );
}

function Setting({ row, editor }: { readonly row: SettingRow; readonly editor: ProfileEditor }): JSX.Element {
  const { field } = row;
  const id = `setting-${field.path.join('-')}`;
  const managed = row.value !== undefined;
  return (
    <div class={`setting${field.nested ? ' setting-nested' : ''}${row.unsaved ? ' setting-unsaved' : ''}`}>
      <div class="setting-head">
        <div class="setting-text">
          <strong id={`${id}-label`}>{field.label}</strong>
          <span class="muted small">
            {!managed
              ? 'Not managed: each repository keeps its own.'
              : row.source === 'here'
                ? 'Set in this profile.'
                : row.source === undefined
                  ? 'Set in this profile, not saved yet.'
                  : `From ${row.source}.`}
            {row.unsaved && managed && row.source !== undefined && ' Not saved yet.'}
            {row.off && ' Off on GitHub for the setting above.'}
          </span>
        </div>
        <Control row={row} editor={editor} />
        <div class="setting-actions">
          {row.unsaved || row.invalid !== undefined ? (
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
      {row.invalid !== undefined && (
        <p class="problem small" role="alert">
          {row.invalid.problem}
        </p>
      )}
      {row.hiddenNamed > 0 && (
        <p class="muted small">
          The profile still names {row.hiddenNamed} {row.hiddenNamed === 1 ? 'setting' : 'settings'} that GitHub hides
          for this value.
        </p>
      )}
      {field.note !== undefined && <p class="muted small">{field.note}</p>}
    </div>
  );
}

/** The open profile's settings, a tab for each section, with the footer that saves them. */
export function ProfileSettings({
  editor,
  profiles,
}: {
  readonly editor: ProfileEditor;
  readonly profiles: Profiles;
}): JSX.Element {
  const sections = editor.sections.value;
  const [tab, setTab] = useState(sections[0]?.section.section ?? '');
  const shown = sections.find((item) => item.section.section === tab) ?? sections[0];
  const problem = editor.problem.value;
  return (
    <>
      <div class="tabs" role="tablist" aria-label="Settings">
        {sections.map(({ section, groups }) => {
          const unsaved = groups.some((group) => group.rows.some((row) => row.unsaved || row.invalid !== undefined));
          return (
            <button
              key={section.section}
              class="tab"
              type="button"
              role="tab"
              id={`tab-${section.section}`}
              aria-selected={shown?.section === section}
              aria-controls="settings-panel"
              onClick={() => {
                setTab(section.section);
              }}
            >
              {section.name}
              {unsaved && <span class="dot" aria-label="not saved yet" />}
            </button>
          );
        })}
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
              ? 'Everything is saved.'
              : editor.canSave.value || problem !== undefined
                ? 'You have changes that are not saved.'
                : 'Correct what is marked, or reset it, to save.'}
        </span>
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
        <button
          class="button button-primary"
          type="button"
          disabled={!editor.canSave.value}
          onClick={() => {
            run(profiles.save());
          }}
        >
          Save
        </button>
      </div>
    </>
  );
}
