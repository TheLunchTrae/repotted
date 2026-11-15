import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { ConfigDiscovery, FoundRepository } from '../../app/profiles/config-discovery.js';
import { configTopic } from '../../app/profiles/config-marker.js';
import type { Profiles } from '../../app/profiles/profiles.js';
import { run } from '../layout/run.js';

interface FoundConfigProps {
  readonly discovery: ConfigDiscovery;
  readonly profiles: Profiles;
}

function folderText(folder: string | undefined): string {
  if (folder === undefined) {
    return 'No .repotted.json names its profiles folder';
  }
  return folder === '' ? "Profiles in the repository's root" : `Profiles in the folder ${folder}`;
}

/** Above every page, since a new browser shows a list of repositories before anyone opens Settings. */
export function FoundConfig({ discovery, profiles }: FoundConfigProps): JSX.Element | null {
  const state = discovery.state.value;
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [typedFolder, setTypedFolder] = useState('');
  const [addBrowserProfiles, setAddBrowserProfiles] = useState(false);

  const source = profiles.source.value;
  const stillThere =
    state.status === 'found' &&
    source.kind === 'repository' &&
    source.repository.toLowerCase() === state.repository.toLowerCase();
  if (state.status === 'found' && stillThere) {
    return (
      <div class="notice shell-notice found-config" role="status">
        <strong>
          Your profiles are in <span class="mono found-config-name">{state.repository}</span>
        </strong>
        <p class="small">Repotted found it by its {configTopic} topic. Change where profiles are kept in Settings.</p>
        <div class="notice-actions">
          <button
            class="button button-quiet"
            type="button"
            onClick={() => {
              discovery.dismiss();
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  // A choice made in Settings meanwhile answers the question.
  if (state.status !== 'asking' || profiles.chosen.value) {
    return null;
  }

  const [first] = state.found;
  const chosen: FoundRepository | undefined =
    state.found.find((found) => found.repository === picked) ?? (state.found.length === 1 ? first : undefined);
  const folder = chosen?.folder ?? typedFolder;
  const single = state.found.length === 1 ? first : undefined;
  const count = state.browserProfiles;

  return (
    <form
      class="notice shell-notice found-config"
      aria-labelledby="found-config-heading"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen !== undefined) {
          run(discovery.use(chosen.repository, folder, addBrowserProfiles));
        }
      }}
    >
      {single === undefined ? (
        <>
          <strong id="found-config-heading">Which config repository holds your profiles?</strong>
          <p class="small">
            {state.found.length} of your repositories have the {configTopic} topic. Pick the one this browser keeps your
            profiles in.
          </p>
          <fieldset class="choices found-config-list" disabled={state.busy}>
            <legend class="visually-hidden">Config repository</legend>
            {state.found.map((found) => (
              <label class="choice" key={found.repository}>
                <input
                  type="radio"
                  name="found-config"
                  checked={found.repository === picked}
                  onChange={() => {
                    setPicked(found.repository);
                  }}
                />
                <span>
                  <strong class="mono found-config-name">{found.repository}</strong>
                  <span class="muted small">{folderText(found.folder)}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </>
      ) : (
        <>
          <strong id="found-config-heading">
            Use <span class="mono found-config-name">{single.repository}</span> for your profiles?
          </strong>
          <p class="small">
            {single.folder === undefined
              ? `It has the ${configTopic} topic, but no .repotted.json says which folder holds the profiles.`
              : `It has the ${configTopic} topic. ${folderText(single.folder)}.`}
          </p>
        </>
      )}
      {chosen !== undefined && chosen.folder === undefined && (
        <label class="form-field">
          <span>Folder in the repository</span>
          <input
            class="field mono"
            placeholder="The repository's root"
            value={typedFolder}
            disabled={state.busy}
            onInput={(event) => {
              setTypedFolder(event.currentTarget.value);
            }}
          />
        </label>
      )}
      {count > 0 && (
        <label class="check small">
          <input
            type="checkbox"
            checked={addBrowserProfiles}
            disabled={state.busy}
            onChange={(event) => {
              setAddBrowserProfiles(event.currentTarget.checked);
            }}
          />
          <span>Add the {count === 1 ? 'profile' : `${count} profiles`} from this browser</span>
        </label>
      )}
      {state.error !== undefined && (
        <p class="notice notice-problem" role="alert">
          {state.error}
        </p>
      )}
      <div class="notice-actions">
        <button class="button button-primary" type="submit" disabled={state.busy || chosen === undefined}>
          Use this repository
        </button>
        <button
          class="button button-quiet"
          type="button"
          disabled={state.busy}
          onClick={() => {
            run(discovery.keepInBrowser());
          }}
        >
          Keep profiles in this browser
        </button>
        <button
          class="button button-quiet"
          type="button"
          disabled={state.busy}
          onClick={() => {
            discovery.dismiss();
          }}
        >
          Not now
        </button>
        {state.busy && (
          <span class="muted small" role="status">
            Syncing with GitHub…
          </span>
        )}
      </div>
    </form>
  );
}
