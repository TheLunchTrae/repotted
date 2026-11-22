import type { DefinitionKind } from '@repotted/core';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Router } from '../../app/navigation/router.js';
import type { SaveMode } from '../../app/profile-editor/entry-edits.js';
import type { EditorPlace } from '../../app/profile-editor/profile-editor.js';
import { definitionTypes } from '../../app/profiles/definition-types.js';
import type { BundledChoice, ImportedDefinition } from '../../app/profiles/profile-import.js';
import type { ProfileListing, Profiles } from '../../app/profiles/profiles.js';
import { useLeaveQuestion } from '../layout/leave-question.js';
import { Link } from '../layout/link.js';
import { Loading } from '../layout/loading.js';
import { useProfileConfirmation } from '../layout/notifications.js';
import { PendingButton, usePendingAction } from '../layout/pending-button.js';
import { run } from '../layout/run.js';
import { InvalidProfile } from '../profile-editor/invalid-profile.js';
import { ProfileSettings } from '../profile-editor/profile-editor.js';

const kindNames: Readonly<Record<DefinitionKind, string>> = {
  'actions-policy': 'an Actions policy',
  ruleset: 'a ruleset',
  environment: 'an environment',
};

/** The page an import opens on: the profiles page or a library, with `?import`. */
export function importAddress(kind: DefinitionKind | undefined): string {
  return `${definitionTypes.find((item) => item.kind === kind)?.path ?? '/profiles'}?import`;
}

function landingOf(kind: DefinitionKind | undefined): string {
  return definitionTypes.find((item) => item.kind === kind)?.path ?? '/profiles';
}

function ImportProblem({ problem, onClose }: { readonly problem: string; readonly onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog class="dialog" ref={dialog} aria-labelledby="import-problem-heading" onClose={onClose}>
      <form method="dialog">
        <h2 id="import-problem-heading">Couldn't import the file</h2>
        <p class="problem">{problem}</p>
        <div class="form-actions">
          <button class="button button-primary" type="submit" autofocus>
            Close
          </button>
        </div>
      </form>
    </dialog>
  );
}

function ReusableChoice({ profiles, onChosen }: { readonly profiles: Profiles; readonly onChosen: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const importing = profiles.importing.value;
  const bundled = importing?.imported.bundled ?? [];
  const [choice, setChoice] = useState<BundledChoice>('reusable');
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});
  const [placed, setPlaced] = useState<readonly ImportedDefinition[]>([]);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [continuing, carryOn] = usePendingAction();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let current = true;
    profiles.importedDefinitions(names).then(
      (found) => {
        if (current) {
          setPlaced(found);
          setProblem(undefined);
        }
      },
      (error: unknown) => {
        if (current) {
          setProblem(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [profiles, names]);
  const there = placed.filter((item) => item.state !== 'new');
  const taken = placed.some((item) => item.state === 'taken');
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-labelledby="reusable-choice-heading"
      onCancel={() => {
        run(profiles.cancelImport());
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          run(
            carryOn(async () => {
              const failure = await profiles.chooseImport(choice, names);
              if (failure === undefined) {
                dialog.current?.close();
                onChosen();
              } else {
                setProblem(failure);
              }
            }),
          );
        }}
      >
        <h2 id="reusable-choice-heading">Save its reusable items separately?</h2>
        <p>
          <span class="mono">{importing?.file}</span> includes{' '}
          {bundled.length === 1 ? '1 reusable item' : `${bundled.length} reusable items`}:
        </p>
        <ul>
          {bundled.map((item) => (
            <li key={item.reference}>
              <strong>{item.name}</strong>, {kindNames[item.kind]}
            </li>
          ))}
        </ul>
        <fieldset class="choices" disabled={continuing}>
          <legend class="visually-hidden">Keep the reusable items</legend>
          <label class="choice">
            <input
              type="radio"
              name="bundled"
              checked={choice === 'reusable'}
              onChange={() => {
                setChoice('reusable');
              }}
            />
            <span>
              <strong>Save as reusable</strong>
              <span class="muted small">
                Each one goes to its library, and the profile uses it from there, as other profiles can.
              </span>
            </span>
          </label>
          <label class="choice">
            <input
              type="radio"
              name="bundled"
              checked={choice === 'inside'}
              onChange={() => {
                setChoice('inside');
              }}
            />
            <span>
              <strong>Keep in the profile</strong>
              <span class="muted small">
                Their settings are written into this profile, and nothing is added to the libraries.
              </span>
            </span>
          </label>
        </fieldset>
        {choice === 'reusable' && there.length > 0 && (
          <div class="notice small">
            <p>Already in your libraries:</p>
            <ul>
              {there.map((item) => (
                <li key={item.bundled.reference}>
                  {item.state === 'same' ? (
                    <>
                      <strong>{item.name}</strong> has the same settings, so the profile uses the one you have.
                    </>
                  ) : (
                    <label class="form-field">
                      <span>
                        <strong>{item.bundled.name}</strong> is a different{' '}
                        {kindNames[item.bundled.kind].replace(/^an? /u, '')}. Save this one as:
                      </span>
                      <input
                        class="field"
                        value={names[item.bundled.reference] ?? item.name}
                        onInput={(event) => {
                          setNames({ ...names, [item.bundled.reference]: event.currentTarget.value });
                        }}
                      />
                    </label>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {problem !== undefined && (
          <p class="problem" role="alert">
            {problem}
          </p>
        )}
        <div class="form-actions">
          <PendingButton
            pending={continuing}
            class="button button-primary"
            type="submit"
            disabled={choice === 'reusable' && (taken || problem !== undefined)}
          >
            Continue
          </PendingButton>
          <button
            class="button button-quiet"
            type="button"
            onClick={() => {
              dialog.current?.close();
              run(profiles.cancelImport());
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Reads the file chosen into `kind`'s library, or the profiles for none.
 * A profile carrying reusable definitions asks how to keep them first;
 * anything else opens on its import page.
 */
export function ImportButton({
  profiles,
  router,
  kind,
}: {
  readonly profiles: Profiles;
  readonly router: Router;
  readonly kind: DefinitionKind | undefined;
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [reading, read] = usePendingAction();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const importing = profiles.importing.value;
  return (
    <>
      <PendingButton
        pending={reading}
        class="button"
        type="button"
        onClick={() => {
          input.current?.click();
        }}
      >
        Import
      </PendingButton>
      <input
        ref={input}
        class="visually-hidden"
        type="file"
        accept=".yaml,.yml,.json"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const chosen = event.currentTarget;
          const file = chosen.files?.[0];
          // The same file can be chosen again after a problem or a cancel.
          chosen.value = '';
          if (file === undefined) {
            return;
          }
          setProblem(undefined);
          run(
            read(async () => {
              const failure = await profiles.startImport(file.name, await file.text(), kind);
              setProblem(failure);
              if (failure === undefined && profiles.importing.peek()?.editor !== undefined) {
                router.go(importAddress(kind));
              }
            }),
          );
        }}
      />
      {problem !== undefined && (
        <ImportProblem
          problem={problem}
          onClose={() => {
            setProblem(undefined);
          }}
        />
      )}
      {importing !== undefined && importing.editor === undefined && importing.imported.bundled.length > 0 && (
        <ReusableChoice
          profiles={profiles}
          onChosen={() => {
            router.go(importAddress(kind));
          }}
        />
      )}
    </>
  );
}

/** The page of a file being imported, which it edits until Save adds it. */
export function ImportPage({
  profiles,
  router,
  kind,
}: {
  readonly profiles: Profiles;
  readonly router: Router;
  readonly kind: DefinitionKind | undefined;
}): JSX.Element {
  const confirm = useProfileConfirmation(profiles);
  const importing = profiles.importing.value;
  const library = definitionTypes.find((item) => item.kind === kind);
  const landing = landingOf(kind);
  const [name, setName] = useState(importing?.name ?? '');
  const [folder, setFolder] = useState(library === undefined ? '' : `definitions/${library.kind}`);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [showYaml, setShowYaml] = useState(false);
  const [yaml, setYaml] = useState<string | undefined>(undefined);
  const [landOn, setLandOn] = useState<EditorPlace | undefined>(undefined);
  const saved = useRef(false);
  const editor = importing?.editor;
  useLeaveQuestion(router, () =>
    importing === undefined || saved.current ? undefined : { kind: 'import', name: name.trim() },
  );
  // Leaving the page drops the import, as its question says.
  useEffect(
    () => () => {
      if (!saved.current) {
        run(profiles.cancelImport());
      }
    },
    [profiles],
  );
  useEffect(() => {
    if (showYaml && importing?.staged !== undefined) {
      run(profiles.importedText().then(setYaml));
    }
  }, [showYaml, importing?.staged, editor?.dirty.value, profiles]);
  const back = (
    <p>
      <Link router={router} to={landing}>
        ← All {library === undefined ? 'profiles' : library.title.toLowerCase()}
      </Link>
    </p>
  );
  if (importing === undefined || editor === undefined) {
    return (
      <div class="page-body">
        {back}
        <p>
          Nothing is being imported. Choose <strong>Import</strong> to pick a file.
        </p>
      </div>
    );
  }
  const folders = [...new Set(['', ...profiles.folders.value, folder])].sort();
  const reused = importing.staged?.definitions ?? [];
  const added = reused.filter((item) => item.state === 'new');
  const kept = reused.filter((item) => item.state === 'same');
  const nameProblem = name.trim() === '' ? 'Give it a name.' : profiles.nameProblem(name, folder);
  const save = async (mode: SaveMode = 'applies'): Promise<void> => {
    if (nameProblem !== undefined) {
      setProblem(nameProblem);
      return;
    }
    setProblem(undefined);
    const failure = await profiles.saveImport(name, folder, mode);
    if (failure !== undefined) {
      setProblem(failure);
      return;
    }
    saved.current = true;
    confirm(`${name.trim()} imported${mode === 'draft' ? ' as a draft' : ''}.`);
    router.go(landing, { withoutAsking: true });
  };
  return (
    <div class="page-body">
      {back}
      <article class="import-page" aria-labelledby="import-heading">
        <div class="page-heading">
          <div>
            <h1 id="import-heading">{name.trim() === '' ? importing.name : name.trim()}</h1>
            <p class="mono small muted">{[folder, `${name.trim()}.yaml`].filter((part) => part !== '').join('/')}</p>
          </div>
          <div class="page-actions">
            <button
              class="button"
              type="button"
              onClick={() => {
                setShowYaml(!showYaml);
              }}
            >
              {showYaml ? 'Hide YAML' : 'Show YAML'}
            </button>
          </div>
        </div>
        <div class="notice" role="status">
          <p>
            <strong>Imported from {importing.file}.</strong> Nothing is added until you click <strong>Save</strong>.
            Change anything first if you want to.
          </p>
          <div class="import-place">
            <label class="form-field">
              <span>Name</span>
              <input
                class="field"
                value={name}
                aria-invalid={nameProblem !== undefined}
                onInput={(event) => {
                  setName(event.currentTarget.value);
                }}
              />
            </label>
            <label class="form-field">
              <span>Folder</span>
              <select
                class="field"
                value={folder}
                onChange={(event) => {
                  setFolder(event.currentTarget.value);
                }}
              >
                {folders.map((item) => (
                  <option key={item} value={item}>
                    {item === '' ? 'Profiles folder' : item}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {nameProblem !== undefined && name.trim() !== '' && <p class="problem small">{nameProblem}</p>}
          {(added.length > 0 || kept.length > 0) && (
            <p class="small muted">
              {added.length > 0 &&
                `With ${added.length === 1 ? '1 new reusable item' : `${added.length} new reusable items`}: ${added
                  .map((item) => `${item.name} (${kindNames[item.bundled.kind].replace(/^an? /u, '')})`)
                  .join(', ')}. `}
              {kept.length > 0 && `It uses your ${kept.map((item) => item.name).join(', ')}.`}
            </p>
          )}
        </div>
        {problem !== undefined && (
          <p class="notice notice-problem" role="alert">
            {problem}
          </p>
        )}
        {editor.loadError.value !== undefined && (
          <p class="notice notice-problem" role="alert">
            {editor.loadError.value}
          </p>
        )}
        {editor.loaded.value && editor.configurationProblems.value.length > 0 && (
          <InvalidProfile
            editor={editor}
            onGoTo={(place) => {
              setLandOn({ ...place });
            }}
          />
        )}
        {!editor.loaded.value && editor.loadError.value === undefined && <Loading>Reading the file…</Loading>}
        {editor.loaded.value && (
          <ProfileSettings
            key={editor.file}
            name={name.trim()}
            editor={editor}
            saving={{
              save,
              newFile: true,
              discardDraft: () => editor.discardDraft((write) => write()),
              onGitHub: profiles.source.value.kind === 'repository',
            }}
            ownerTypeHasPushRulesets={editor.ownerType.value !== 'user'}
            landOn={landOn}
            onLanded={() => {
              setLandOn(undefined);
            }}
          />
        )}
        {showYaml && yaml !== undefined && (
          <pre class="code" role="region" tabIndex={0} aria-label={`${name.trim()} as YAML`}>
            {yaml}
          </pre>
        )}
      </article>
    </div>
  );
}

/** Downloads the listing as an export: a profile with its reusable definitions, or a definition as it is. */
export async function exportListing(profiles: Profiles, listing: ProfileListing): Promise<number> {
  const text = await profiles.exported(listing);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${listing.name}.yaml`;
  link.click();
  URL.revokeObjectURL(url);
  return listing.references?.length ?? 0;
}
