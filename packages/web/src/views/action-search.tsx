import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

import { type ActionSearch, foundNotes } from '../app/action-search.js';
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
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The results go when the pointer is pressed outside the search, as a popup's would. A press inside,
    // on a row's text or its button, leaves them, whatever the browser does with the focus.
    const pressed = (event: PointerEvent): void => {
      if (event.target instanceof Node && container.current?.contains(event.target) !== true) {
        search.close();
      }
    };
    document.addEventListener('pointerdown', pressed);
    return () => {
      document.removeEventListener('pointerdown', pressed);
      // A search taken away with its row leaves no pause or answer behind.
      search.close();
    };
  }, [search]);
  return (
    <div
      class="action-search"
      role="search"
      aria-label="Actions on GitHub"
      ref={container}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && state.kind !== 'closed') {
          // A search box empties itself on Escape; this one puts its results away first and keeps the text.
          event.preventDefault();
          event.stopPropagation();
          search.close();
        }
      }}
      onFocusOut={(event) => {
        // The keyboard moved on to another control. Focus that goes nowhere, as when the window loses it, changes nothing.
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
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
            // A key held down is one search, however fast its answers land.
            if (!event.repeat) {
              search.enter();
            }
          }
        }}
      />
      {/* The message's place is there before it has anything to say, so a screen reader announces what it comes to say. */}
      <p
        class={state.kind === 'searching' || state.kind === 'message' ? 'muted small' : 'visually-hidden'}
        role="status"
      >
        {state.kind === 'searching'
          ? 'Searching GitHub…'
          : state.kind === 'message'
            ? state.text
            : state.kind === 'results'
              ? state.found.length === 1
                ? '1 repository found.'
                : `${state.found.length} repositories found.`
              : ''}
      </p>
      {state.kind === 'results' && (
        <ul class="rows" role="list" aria-label="Repositories found">
          {state.found.map((found) => (
            <li key={found.repository} class="found-action">
              <span>
                <strong class="mono">{found.repository}</strong> <span class="muted small">{foundNotes(found)}</span>
                {found.description !== null && found.description !== '' && (
                  <span class="muted small found-description">{found.description}</span>
                )}
              </span>
              {editor.allowsRepository(found.repository) ? (
                <span class="muted small">Added</span>
              ) : (
                <button
                  class="button button-small"
                  type="button"
                  aria-label={`Add ${found.repository}`}
                  onClick={() => {
                    // The button goes once its repository is added, so the keyboard goes back to the box.
                    box.current?.focus();
                    run(editor.allowRepository(found.repository));
                  }}
                >
                  Add
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
