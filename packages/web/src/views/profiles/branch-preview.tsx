import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { ComparedProfile } from '../../app/apply/comparison.js';
import type { Router } from '../../app/navigation/router.js';
import { diffLines, foldUnchanged } from '../../app/profile-editor/line-diff.js';
import type { BranchPreview, PreviewedProfile, PreviewRow, PreviewStatus } from '../../app/profiles/branch-preview.js';
import type { Repositories } from '../../app/repositories/repositories.js';
import { run } from '../layout/run.js';
import { Diff } from '../profile-editor/save-preview.js';

export function previewAddress(branch: string): string {
  return `/profiles?preview=${encodeURIComponent(branch)}`;
}

const statuses: Readonly<Record<PreviewStatus, { readonly label: string; readonly pill: string }>> = {
  added: { label: 'Added', pill: 'pill pill-add' },
  removed: { label: 'Removed', pill: 'pill pill-remove' },
  changed: { label: 'Changed', pill: 'pill pill-drift' },
  renamed: { label: 'Moved', pill: 'pill pill-drift' },
  'through-base': { label: 'Changed by its base', pill: 'pill' },
};

const kinds = { changes: 'Changes', adds: 'Adds', removes: 'Removes' } as const;

function count(amount: number, noun: string, nouns = `${noun}s`): string {
  return `${amount} ${amount === 1 ? noun : nouns}`;
}

interface PickerProps {
  readonly preview: BranchPreview;
  readonly repository: string;
  readonly onPick: (branch: string) => void;
  readonly onClose: () => void;
}

export function PreviewPicker({ preview, repository, onPick, onClose }: PickerProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    run(preview.listBranches(repository));
  }, [preview, repository]);
  const list = preview.branches.value;
  const pick = (branch: string): void => {
    dialog.current?.close();
    onPick(branch);
  };
  return (
    <dialog class="dialog" ref={dialog} aria-labelledby="preview-pick" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'typed') {
            event.preventDefault();
            if (typed.trim() !== '') {
              pick(typed.trim());
            }
          }
        }}
      >
        <h2 id="preview-pick">Preview a branch</h2>
        <p>
          See what a branch of <span class="mono">{repository}</span> changes in the profiles, before it is merged.
          Previewing only reads from GitHub.
        </p>
        {list.kind === 'loading' && (
          <p class="muted" role="status">
            Reading the branches…
          </p>
        )}
        {list.kind === 'failed' && (
          <p class="notice notice-problem" role="alert">
            Couldn't list the branches: {list.message}
          </p>
        )}
        {list.kind === 'listed' &&
          (list.branches.length === 0 ? (
            <p class="muted">
              <span class="mono">{repository}</span> has no branch besides{' '}
              <span class="mono">{list.defaultBranch}</span>.
            </p>
          ) : (
            <ul class="rows preview-branches" role="list" aria-label="Branches">
              {list.branches.map((branch) => (
                <li key={branch}>
                  <button
                    class="tree-item"
                    type="button"
                    onClick={() => {
                      pick(branch);
                    }}
                  >
                    <span class="tree-name mono">{branch}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
        {list.kind === 'listed' && list.moreBranchesThanListed && (
          <p class="muted small">GitHub lists the first 100 branches. Type the name of any other.</p>
        )}
        <label for="preview-branch">Branch name</label>
        <div class="preview-typed">
          <input
            id="preview-branch"
            class="field mono"
            type="text"
            autocomplete="off"
            spellcheck={false}
            value={typed}
            onInput={(event) => {
              setTyped(event.currentTarget.value);
            }}
          />
          <button class="button" type="submit" value="typed" disabled={typed.trim() === ''}>
            Preview
          </button>
        </div>
        <div class="form-actions">
          <button class="button button-quiet" type="submit" value="cancel">
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Row({ row, base }: { readonly row: PreviewRow; readonly base: string }): JSX.Element {
  return (
    <li class="compare-row">
      <span class="compare-what">
        <strong>{row.label}</strong>
        <span class="mono small muted">{row.key}</span>
        {row.fromExtendedProfile !== undefined && <span class="muted small">From {row.fromExtendedProfile}</span>}
      </span>
      <span class="compare-values">
        <span class="visually-hidden">
          {kinds[row.kind]}: on {base},
        </span>
        <span class={row.kind === 'adds' ? 'muted' : 'compare-now'}>{row.before}</span>
        <span aria-hidden="true">→</span>
        <span class="visually-hidden">; on the branch, </span>
        <span class={row.kind === 'removes' ? 'compare-removed' : 'compare-wanted'}>{row.after}</span>
      </span>
    </li>
  );
}

interface ChangedProfileProps {
  readonly profile: PreviewedProfile;
  readonly indexInList: number;
  readonly base: string;
  readonly repositories: readonly string[];
  readonly onCompare: (repository: string, profile: PreviewedProfile) => void;
}

function ChangedProfile({
  profile,
  indexInList: index,
  base,
  repositories,
  onCompare,
}: ChangedProfileProps): JSX.Element {
  const [yaml, setYaml] = useState(false);
  const [picked, setPicked] = useState('');
  // The repository list can arrive after the profile shows, so the first one stands in until one is picked.
  const repository = picked !== '' && repositories.includes(picked) ? picked : (repositories[0] ?? '');
  const status = statuses[profile.status];
  const rows = profile.sections.reduce((sum, section) => sum + section.rows.length, 0);
  const lines =
    yaml && profile.changedFileText !== undefined
      ? foldUnchanged(
          diffLines(
            profile.changedFileText.before === '' ? [] : profile.changedFileText.before.replace(/\n$/u, '').split('\n'),
            profile.changedFileText.after === '' ? [] : profile.changedFileText.after.replace(/\n$/u, '').split('\n'),
          ),
        )
      : [];
  const heading = `preview-profile-${index}`;
  return (
    <section class="preview-profile" aria-labelledby={heading}>
      <div class="preview-profile-heading">
        <h2 id={heading} class="mono">
          {profile.folder === '' ? '' : <span class="muted">{profile.folder}/</span>}
          {profile.name}
        </h2>
        <span class={status.pill}>{status.label}</span>
      </div>
      {profile.movedFromPath !== undefined && <p class="muted small">Moved from {profile.movedFromPath}.</p>}
      {profile.problemOnBranch !== undefined && (
        <p class="notice notice-problem">On the branch this profile doesn't load: {profile.problemOnBranch}</p>
      )}
      {profile.problemFixedByBranch !== undefined && (
        <p class="muted small">
          It doesn't load here ({profile.problemFixedByBranch}), so everything it applies on the branch shows as added.
        </p>
      )}
      {profile.status === 'removed' ? (
        <p class="muted">The branch deletes this profile.</p>
      ) : (
        profile.problemOnBranch === undefined &&
        (rows === 0 ? (
          <p class="muted">
            {profile.status === 'renamed'
              ? 'It applies the same as before.'
              : 'Nothing it applies changes: the branch changes only its drafts, comments or layout.'}
          </p>
        ) : (
          profile.sections.map((section) => (
            <div key={section.section} class="preview-section">
              <h3>{section.title}</h3>
              <ul class="rows" role="list">
                {section.rows.map((row, index) => (
                  // A preview's rows are made once and never move, so each is known by its place.
                  <Row key={index} row={row} base={base} />
                ))}
              </ul>
            </div>
          ))
        ))
      )}
      <div class="preview-profile-actions">
        {profile.changedFileText !== undefined && (
          <button
            class="button button-quiet button-small"
            type="button"
            aria-expanded={yaml}
            onClick={() => {
              setYaml(!yaml);
            }}
          >
            {yaml ? 'Hide YAML' : 'Show YAML'}
          </button>
        )}
      </div>
      {yaml && <Diff lines={lines} label={`${profile.name}: ${base} against the branch`} />}
      {profile.fileOnBranch !== undefined && profile.problemOnBranch === undefined && repositories.length > 0 && (
        <form
          class="preview-compare"
          onSubmit={(event) => {
            event.preventDefault();
            if (repository !== '') {
              onCompare(repository, profile);
            }
          }}
        >
          <label for={`${heading}-repository`}>Compare with a repository</label>
          <div class="preview-typed">
            <select
              id={`${heading}-repository`}
              class="field"
              value={repository}
              onChange={(event) => {
                setPicked(event.currentTarget.value);
              }}
            >
              {repositories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button class="button" type="submit">
              Compare
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

interface PreviewPageProps {
  readonly preview: BranchPreview;
  readonly repositories: Repositories;
  readonly router: Router;
  readonly branch: string;
  readonly onCompare: (repository: string, profile: ComparedProfile) => void;
}

export function BranchPreviewPage({ preview, repositories, router, branch, onCompare }: PreviewPageProps): JSX.Element {
  const state = preview.state.value;
  const names = (repositories.list.value?.repositories ?? []).map((repository) => repository.full_name);
  const exit = (
    <button
      class="button"
      type="button"
      onClick={() => {
        run(preview.close());
        router.go('/profiles');
      }}
    >
      Exit preview
    </button>
  );
  const base = state.kind === 'ready' ? state.defaultBranch : 'the default branch';
  return (
    <div class="page">
      <article class="page-body branch-preview" aria-labelledby="preview-heading">
        <div class="notice preview-banner">
          <p>
            Previewing <span class="mono">{branch}</span> against{' '}
            {state.kind === 'ready' ? <span class="mono">{state.defaultBranch}</span> : 'the default branch'}. Nothing
            here is saved or synced.
          </p>
          <div class="notice-actions">
            <button
              class="button"
              type="button"
              disabled={state.kind === 'loading'}
              onClick={() => {
                run(preview.refresh());
              }}
            >
              Refresh
            </button>
            {exit}
          </div>
        </div>
        <div class="page-heading">
          <div>
            <h1 id="preview-heading">
              Changes on <span class="mono">{branch}</span>
            </h1>
            <p class="muted" role="status">
              {state.kind === 'loading' || state.kind === 'idle'
                ? 'Reading the branch from GitHub…'
                : state.kind === 'failed'
                  ? "The branch couldn't be read."
                  : state.changedProfiles.length === 0
                    ? 'The branch changes no profile.'
                    : `${count(state.changedProfiles.length, 'profile changes', 'profiles change')}${
                        state.unchangedProfileCount === 0
                          ? ''
                          : `, ${count(state.unchangedProfileCount, 'stays', 'stay')} the same`
                      }.`}
            </p>
          </div>
        </div>
        {state.kind === 'failed' && (
          <p class="notice notice-problem" role="alert">
            {state.message}
          </p>
        )}
        {state.kind === 'ready' &&
          (state.profilesChangedSinceLastSync.length > 0 ||
            state.localProfilesOlderThanDefaultBranch ||
            state.commitsBehindDefaultBranch > 0 ||
            state.changedFilesTruncated ||
            state.changesSharedPreferences) && (
            <div class="notice notice-drift">
              <ul>
                {state.profilesChangedSinceLastSync.length > 0 && (
                  <li>
                    {state.profilesChangedSinceLastSync.length === 1 ? (
                      <>
                        <span class="mono">{state.profilesChangedSinceLastSync[0]}</span> has changes here that aren't
                        synced
                      </>
                    ) : (
                      <>
                        {state.profilesChangedSinceLastSync.length} profiles have changes here that aren't synced:{' '}
                        <span class="mono">{state.profilesChangedSinceLastSync.join(', ')}</span>
                      </>
                    )}
                    . The preview starts from the profiles here, so where the branch changes the same profiles, it shows
                    those changes as undone. Sync, then refresh, to leave them out.
                  </li>
                )}
                {state.localProfilesOlderThanDefaultBranch && (
                  <li>
                    The profiles here are older than <span class="mono">{state.defaultBranch}</span>, so the preview
                    starts from them. Sync, then refresh, to start from <span class="mono">{state.defaultBranch}</span>{' '}
                    as it is now.
                  </li>
                )}
                {state.commitsBehindDefaultBranch > 0 && (
                  <li>
                    The branch is {count(state.commitsBehindDefaultBranch, 'commit')} behind{' '}
                    <span class="mono">{state.defaultBranch}</span>. A profile both changed shows as the branch has it.
                  </li>
                )}
                {state.changedFilesTruncated && (
                  <li>
                    The branch changes more files than GitHub lists at once, so some profiles it changes may be missing
                    here.
                  </li>
                )}
                {state.changesSharedPreferences && (
                  <li>The branch also changes the hidden repositories or folders, which the preview doesn't show.</li>
                )}
              </ul>
            </div>
          )}
        {state.kind === 'ready' && (
          <div class="preview-profiles">
            {state.changedProfiles.map((profile, index) => (
              <ChangedProfile
                key={`${state.branchCommit}:${profile.path}`}
                profile={profile}
                indexInList={index}
                base={base}
                repositories={names}
                onCompare={(repository, changed) => {
                  if (changed.fileOnBranch !== undefined) {
                    onCompare(repository, {
                      file: changed.fileOnBranch,
                      name: `${changed.name} on ${branch}`,
                      folder: state.branchProfilesFolder,
                      backLink: { to: previewAddress(branch), label: 'Back to the preview' },
                    });
                  }
                }}
              />
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
