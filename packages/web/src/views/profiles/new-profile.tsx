import type { DefinitionKind, ownerTypes } from '@repotted/core';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PendingButton, usePendingAction } from '../layout/pending-button.js';

import type { Router } from '../../app/navigation/router.js';
import { definitionTypes } from '../../app/profiles/definition-types.js';
import type { NewProfileStart, Profiles } from '../../app/profiles/profiles.js';
import type { Repositories } from '../../app/repositories/repositories.js';
import { useProfileConfirmation } from '../layout/notifications.js';
import { run } from '../layout/run.js';

type OwnerChoice = (typeof ownerTypes)[number] | 'any';

const ownerLabels: Readonly<Record<OwnerChoice, string>> = {
  user: 'Personal accounts',
  organization: 'Organizations',
  any: 'Any owner',
};

interface NewProfileProps {
  readonly definitionKind?: DefinitionKind;
  readonly profiles: Profiles;
  readonly repositories: Repositories;
  readonly router: Router;
  readonly repositoryToCapture: string | undefined;
}

export function NewProfileForm({
  profiles,
  repositories,
  router,
  repositoryToCapture,
  definitionKind,
}: NewProfileProps): JSX.Element {
  const confirm = useProfileConfirmation(profiles);
  const listings = profiles.listings.value.filter(
    (listing) => listing.problem === null && listing.kind === definitionKind,
  );
  const captured = repositories.list.value?.repositories ?? [];
  const library = definitionTypes.find((item) => item.kind === definitionKind);
  const [targetName, setTargetName] = useState('');
  const [importText, setImportText] = useState('');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(profiles.selected.value?.folder ?? '');
  const [kind, setKind] = useState<NewProfileStart['kind']>(repositoryToCapture === undefined ? 'empty' : 'repository');
  const [pickedBase, setBaseFile] = useState<string | undefined>(undefined);
  const [pickedFrom, setFrom] = useState(repositoryToCapture);
  const [owner, setOwner] = useState<OwnerChoice>('any');
  const [readingFile, setReadingFile] = useState(false);
  const [creating, createProfile] = usePendingAction();
  const working = readingFile || creating;
  const [error, setError] = useState<string | undefined>(undefined);
  const formClosed = useRef(new AbortController());
  const importRead = useRef(0);
  useEffect(
    () => () => {
      formClosed.current.abort();
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
      : kind === 'import'
        ? { kind, text: importText }
        : kind === 'duplicate'
          ? base === undefined
            ? undefined
            : { kind, source: base }
          : kind === 'extends'
            ? base === undefined
              ? undefined
              : { kind, base }
            : from === ''
              ? undefined
              : { kind, repository: from };
  const fixedOwner =
    kind === 'repository'
      ? "The repository's owner sets the type."
      : kind === 'extends' && base !== undefined && base.owner_type !== null
        ? `${base.name} is for ${ownerLabels[base.owner_type].toLowerCase()}, so this one is too.`
        : undefined;
  // While it works, the name that already exists is the profile's own.
  const problem = working || name.trim() === '' ? undefined : profiles.nameProblem(name, folder);

  const create = async (): Promise<void> => {
    if (working || start === undefined) {
      return;
    }
    setError(undefined);
    const failure = await profiles.create(
      {
        name,
        folder,
        start,
        ...(definitionKind === undefined ? {} : { definitionKind, targetName }),
        ownerType: owner === 'any' ? undefined : owner,
      },
      formClosed.current.signal,
    );
    const closed = formClosed.current.signal.aborted;
    // Ordinary creation finishes after the form closes; a capture is canceled on close.
    if (failure === undefined && (start.kind !== 'repository' || !closed)) {
      confirm(`${name.trim()} created.`);
    }
    if (closed) {
      return;
    }
    if (failure === undefined) {
      const created = profiles.selected.value;
      const destination = definitionTypes.find((item) => item.kind === created?.kind);
      router.go(
        destination === undefined || created === undefined
          ? '/profiles'
          : `${destination.path}?definition=${encodeURIComponent(profiles.pathOf(created))}`,
      );
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
        run(createProfile(create));
      }}
    >
      <div class="page-heading">
        <div>
          <h1 id="new-profile-heading">
            {library === undefined
              ? 'New profile'
              : `New ${library.kind === 'actions-policy' ? library.label : library.label.toLowerCase()}`}
          </h1>
          <p class="muted">
            Repotted never replaces {library === undefined ? 'a profile' : 'a definition'} that is already there.
          </p>
        </div>
      </div>

      {library !== undefined && (kind === 'empty' || kind === 'repository') && (
        <label class="form-field">
          <span>Target name</span>
          <input
            class="field"
            required
            disabled={working}
            value={targetName}
            onInput={(event) => {
              setTargetName(event.currentTarget.value);
            }}
          />
          <span class="muted small">The name on GitHub. For a capture, enter its existing name.</span>
        </label>
      )}

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
            disabled={listings.length === 0 || definitionKind !== undefined}
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
                ? library === undefined
                  ? 'Captures its settings, Actions policies, rulesets, environments, and labels as they are on GitHub now. This only reads from GitHub.'
                  : `Captures the ${library.kind === 'actions-policy' ? library.label : library.label.toLowerCase()} named above. This only reads from GitHub.`
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

      <label class="form-field">
        <span>Or reuse a saved file</span>
        <select
          class="field"
          disabled={working}
          value={kind === 'duplicate' ? baseFile : ''}
          onChange={(event) => {
            setBaseFile(event.currentTarget.value);
            setKind('duplicate');
          }}
        >
          <option value="" disabled>
            Duplicate a profile or definition
          </option>
          {listings.map((item) => (
            <option key={item.file} value={item.file}>
              {profiles.pathOf(item)}
            </option>
          ))}
        </select>
      </label>
      <label class="form-field">
        <span>Import YAML file</span>
        <input
          type="file"
          accept=".yaml,.yml"
          disabled={working}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file !== undefined) {
              const request = ++importRead.current;
              setReadingFile(true);
              setKind('import');
              setImportText('');
              run(
                file.text().then(
                  (text) => {
                    if (formClosed.current.signal.aborted || importRead.current !== request) {
                      return;
                    }
                    setImportText(text);
                    setReadingFile(false);
                  },
                  (error: unknown) => {
                    if (formClosed.current.signal.aborted || importRead.current !== request) {
                      return;
                    }
                    setError(error instanceof Error ? error.message : String(error));
                    setReadingFile(false);
                  },
                ),
              );
            }
          }}
        />
      </label>
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
        <PendingButton
          pending={creating}
          class="button button-primary"
          type="submit"
          disabled={working || (kind === 'import' && importText === '') || problem !== undefined || start === undefined}
        >
          {kind === 'repository' ? 'Capture' : library === undefined ? 'Create' : 'Create definition'}
        </PendingButton>
        <button
          class="button button-quiet"
          type="button"
          onClick={() => {
            router.go(library?.path ?? '/profiles');
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
