import type { ownerTypes } from '@repotted/core';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { NewProfileStart, Profiles } from '../app/profiles.js';
import type { Repositories } from '../app/repositories.js';
import type { Router } from '../app/router.js';
import { run } from './run.js';

type OwnerChoice = (typeof ownerTypes)[number] | 'any';

const ownerLabels: Readonly<Record<OwnerChoice, string>> = {
  user: 'Personal accounts',
  organization: 'Organizations',
  any: 'Any owner',
};

interface NewProfileProps {
  readonly profiles: Profiles;
  readonly repositories: Repositories;
  readonly router: Router;
  /** The repository to capture, when the form was opened from one. */
  readonly repository: string | undefined;
}

export function NewProfileForm({ profiles, repositories, router, repository }: NewProfileProps): JSX.Element {
  const listings = profiles.listings.value.filter((listing) => listing.problem === null);
  const captured = repositories.list.value?.repositories ?? [];
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(profiles.selected.value?.folder ?? '');
  const [kind, setKind] = useState<NewProfileStart['kind']>(repository === undefined ? 'empty' : 'repository');
  // What the user picked. Until they pick, or once their pick is gone, the first one listed stands.
  const [pickedBase, setBaseFile] = useState<string | undefined>(undefined);
  const [pickedFrom, setFrom] = useState(repository);
  const [owner, setOwner] = useState<OwnerChoice>('any');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Closing the form stops a capture from making its profile.
  const closed = useRef(new AbortController());
  useEffect(
    () => () => {
      closed.current.abort();
    },
    [],
  );

  const base = listings.find((listing) => listing.file === pickedBase) ?? listings[0];
  const baseFile = base?.file ?? '';
  const from =
    captured.find((item) => item.full_name === pickedFrom)?.full_name ?? pickedFrom ?? captured[0]?.full_name ?? '';
  const start: NewProfileStart | undefined =
    kind === 'empty'
      ? { kind }
      : kind === 'extends'
        ? base === undefined
          ? undefined
          : { kind, base }
        : from === ''
          ? undefined
          : { kind, repository: from };
  // The owner follows from a capture's repository and from a typed base.
  const fixedOwner =
    kind === 'repository'
      ? "The repository's owner sets the type."
      : kind === 'extends' && base !== undefined && base.owner_type !== null
        ? `${base.name} is for ${ownerLabels[base.owner_type].toLowerCase()}, so this one is too.`
        : undefined;
  // While it works, the name it holds is its own.
  const problem = working || name.trim() === '' ? undefined : profiles.nameProblem(name, folder);

  const create = async (): Promise<void> => {
    if (start === undefined) {
      return;
    }
    setWorking(true);
    setError(undefined);
    const failure = await profiles.create(
      { name, folder, start, ownerType: owner === 'any' ? undefined : owner },
      closed.current.signal,
    );
    if (closed.current.signal.aborted) {
      return;
    }
    setWorking(false);
    if (failure === undefined) {
      router.go('/profiles');
    } else {
      setError(failure);
    }
  };

  return (
    <form
      class="page-body form-page"
      aria-labelledby="new-profile-heading"
      onSubmit={(event) => {
        event.preventDefault();
        run(create());
      }}
    >
      <div class="page-heading">
        <div>
          <h1 id="new-profile-heading">New profile</h1>
          <p class="muted">Repotted never replaces a profile that is already there.</p>
        </div>
      </div>

      <div class="form-field">
        <label for="new-profile-name">Name</label>
        <input
          id="new-profile-name"
          class="field"
          required
          disabled={working}
          value={name}
          aria-invalid={problem !== undefined}
          aria-describedby="new-profile-file"
          onInput={(event) => {
            setName(event.currentTarget.value);
          }}
        />
        <span
          id="new-profile-file"
          class={problem === undefined ? 'muted small mono' : 'problem small'}
          aria-live="polite"
        >
          {problem ?? `${folder === '' ? '' : `${folder}/`}${name.trim() === '' ? 'name' : name.trim()}.yaml`}
        </span>
      </div>

      {profiles.folders.value.length > 1 && (
        <label class="form-field">
          <span>Folder</span>
          <select
            class="field"
            disabled={working}
            value={folder}
            onChange={(event) => {
              setFolder(event.currentTarget.value);
            }}
          >
            {profiles.folders.value.map((path) => (
              <option key={path} value={path}>
                {path === '' ? 'Profiles folder' : path}
              </option>
            ))}
          </select>
        </label>
      )}

      <fieldset class="choices" disabled={working}>
        <legend>Start from</legend>
        <label class="choice">
          <input
            type="radio"
            name="start"
            checked={kind === 'empty'}
            onChange={() => {
              setKind('empty');
            }}
          />
          <span>
            <strong>Nothing</strong>
            <span class="muted small">An empty profile, which manages nothing until you set something.</span>
          </span>
        </label>
        <label class="choice">
          <input
            type="radio"
            name="start"
            checked={kind === 'extends'}
            disabled={listings.length === 0}
            onChange={() => {
              setKind('extends');
            }}
          />
          <span>
            <strong>Another profile</strong>
            <span class="muted small">
              {listings.length > 0
                ? 'Extends it, so it gets every setting the other one sets.'
                : 'There is no other profile to extend yet.'}
            </span>
            {kind === 'extends' && (
              <select
                class="field"
                aria-label="Profile to extend"
                value={baseFile}
                onChange={(event) => {
                  setBaseFile(event.currentTarget.value);
                }}
              >
                {listings.map((listing) => (
                  <option key={listing.file} value={listing.file}>
                    {profiles.pathOf(listing)}
                  </option>
                ))}
              </select>
            )}
          </span>
        </label>
        <label class="choice">
          <input
            type="radio"
            name="start"
            checked={kind === 'repository'}
            disabled={captured.length === 0}
            onChange={() => {
              setKind('repository');
            }}
          />
          <span>
            <strong>A repository</strong>
            <span class="muted small">
              {captured.length > 0
                ? 'Captures its settings, rulesets, environments, and labels as they are on GitHub now. This only reads from GitHub.'
                : 'No repositories are listed. Add the Repotted App to one first.'}
            </span>
            {kind === 'repository' && (
              <select
                class="field mono"
                aria-label="Repository to capture"
                value={from}
                onChange={(event) => {
                  setFrom(event.currentTarget.value);
                }}
              >
                {captured.map((item) => (
                  <option key={item.full_name} value={item.full_name}>
                    {item.full_name}
                  </option>
                ))}
              </select>
            )}
          </span>
        </label>
      </fieldset>

      <fieldset class="choices" disabled={working || fixedOwner !== undefined}>
        <legend>For repositories owned by</legend>
        {fixedOwner === undefined ? (
          <div class="segments">
            {(['user', 'organization', 'any'] as const).map((choice) => (
              <label key={choice}>
                <input
                  type="radio"
                  name="owner"
                  checked={owner === choice}
                  onChange={() => {
                    setOwner(choice);
                  }}
                />
                <span>{ownerLabels[choice]}</span>
              </label>
            ))}
          </div>
        ) : (
          <p class="muted small">{fixedOwner}</p>
        )}
      </fieldset>

      {error !== undefined && (
        <p class="notice notice-problem" role="alert">
          {error}
        </p>
      )}
      <div class="form-actions">
        <button
          class="button button-primary"
          type="submit"
          disabled={working || problem !== undefined || start === undefined}
        >
          {kind === 'repository' ? 'Capture' : 'Create'}
        </button>
        <button
          class="button button-quiet"
          type="button"
          onClick={() => {
            router.go('/profiles');
          }}
        >
          Cancel
        </button>
        {working && (
          <span class="muted small" role="status">
            {kind === 'repository' ? `Reading ${from} from GitHub…` : 'Creating…'}
          </span>
        )}
      </div>
    </form>
  );
}
