import { describeFoundAction } from '@repotted/core';
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';

import type { ActionSearch } from '../app/action-search.js';
import type { ProfileEditor } from '../app/profile-editor.js';
import { run } from './run.js';

interface ActionSearchProps {
  readonly editor: ProfileEditor;
  readonly search: ActionSearch;
}

/** The search under the allowed action patterns: repositories from GitHub, each with a way to allow its actions. */
export function ActionSearchBox({ editor, search }: ActionSearchProps): JSX.Element {
  const state = search.state.value;
  const box = useRef<HTMLInputElement>(null);
  return (
    <div
      class="action-search"
      role="search"
      aria-label="Actions on GitHub"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && state.kind !== 'closed') {
          // A search box empties itself on Escape; this one puts its results away first and keeps the text.
          event.preventDefault();
          event.stopPropagation();
          search.close();
        }
      }}
      onFocusOut={(event) => {
        // The results go when the keyboard or the pointer leaves the search, as a popup's would.
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          search.close();
        }
      }}
    >
      <input
        class="field"
        type="search"
        ref={box}
        placeholder="Find an action on GitHub"
        aria-label="Find an action on GitHub"
        value={search.text.value}
        onInput={(event) => {
          search.type(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            search.enter();
          }
        }}
      />
      {/* The message's place is there before it has anything to say, so a screen reader announces what it comes to say. */}
      <p
        class={state.kind === 'searching' || state.kind === 'message' ? 'muted small' : 'visually-hidden'}
        role="status"
      >
        {state.kind === 'searching' ? 'Searching GitHub…' : state.kind === 'message' ? state.text : ''}
      </p>
      {state.kind === 'results' && (
        <ul class="rows" role="list" aria-label="Repositories found">
          {state.found.map((found) => {
            const added = editor.allowsRepository(found.repository);
            // The engine says it in one line after the repository's name, which the row shows by itself.
            const [notes = '', ...description] = describeFoundAction(found)
              .slice(found.repository.length + 1)
              .split(': ');
            return (
              <li key={found.repository} class="found-action">
                <span>
                  <strong class="mono">{found.repository}</strong>{' '}
                  <span class="muted small">{notes.replace(/^\((.*)\)$/u, '$1')}</span>
                  {description.length > 0 && (
                    <span class="muted small found-description">{description.join(': ')}</span>
                  )}
                </span>
                {added ? (
                  <span class="muted small">Added</span>
                ) : (
                  <button
                    class="button button-small"
                    type="button"
                    aria-label={`Add ${found.repository}`}
                    onClick={() => {
                      // The button goes once its repository is added, so the keyboard goes back to the box and the results stay.
                      box.current?.focus();
                      run(editor.allowRepository(found.repository));
                    }}
                  >
                    Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
