import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { ComparedProfile } from '../../app/apply/comparison.js';
import type { Profiles } from '../../app/profiles/profiles.js';
import type { Repository } from '../../app/repositories/repositories.js';
import type { AssignmentStatus, RepositoryProfiles } from '../../app/repositories/repository-profiles.js';
import { useModal } from '../layout/shell.js';

/** As the list names a profile: by its path, without `.yaml`, which tells two of one name apart. */
function shownName(profilePath: string): string {
  return profilePath.replace(/\.ya?ml$/iu, '');
}

function inProse(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join('');
  }
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

export function statusSentence(status: AssignmentStatus): string | undefined {
  switch (status.kind) {
    case 'missing': {
      const gone = status.missing.map(shownName);
      const broken = status.unreadable.map(shownName);
      return [
        gone.length > 0 ? `${inProse(gone)} ${gone.length === 1 ? 'is' : 'are'} no longer in your profiles.` : '',
        broken.length > 0
          ? `${inProse(broken)} can't be read as ${broken.length === 1 ? 'a profile' : 'profiles'}.`
          : '',
        'Remove or put back each one before applying.',
      ]
        .filter((sentence) => sentence !== '')
        .join(' ');
    }
    case 'not-applied': {
      return 'None of these has been applied here yet.';
    }
    case 'changed': {
      const changed = status.changed.map(shownName);
      const notApplied = status.notApplied.map(shownName);
      const removed = status.removed.map(shownName);
      return [
        changed.length > 0 ? `${inProse(changed)} changed since the last apply.` : '',
        notApplied.length > 0
          ? `${inProse(notApplied)} ${notApplied.length === 1 ? "hasn't" : "haven't"} been applied here yet.`
          : '',
        removed.length > 0
          ? `${inProse(removed)} ${removed.length === 1 ? 'was' : 'were'} removed since the last apply.`
          : '',
        status.reordered ? 'Their order changed since the last apply.' : '',
      ]
        .filter((sentence) => sentence !== '')
        .join(' ');
    }
    case 'none':
    case 'checking':
    case 'current': {
      return undefined;
    }
  }
}

function statusPill(status: AssignmentStatus, phone: boolean): JSX.Element | undefined {
  switch (status.kind) {
    case 'missing': {
      return <span class="pill pill-remove">Missing profile</span>;
    }
    case 'changed': {
      return <span class="pill pill-drift">{phone ? 'Changed' : 'Profile changed'}</span>;
    }
    case 'not-applied': {
      return <span class="pill">Not applied</span>;
    }
    case 'none':
    case 'checking':
    case 'current': {
      return undefined;
    }
  }
}

interface RowTagsProps {
  readonly repository: Repository;
  readonly assignments: RepositoryProfiles;
  readonly phone: boolean;
}

/**
 * Up to three tags, or two on a phone, and otherwise how many, with the
 * whole list on hover. On a phone the row opens the details, which list them.
 */
export function RowProfileTags({ repository, assignments, phone }: RowTagsProps): JSX.Element | null {
  const profiles = assignments.profilesOf(repository.full_name);
  if (profiles.length === 0) {
    return null;
  }
  const status = assignments.status(repository.full_name);
  const shown = phone ? 2 : 3;
  return (
    <>
      {statusPill(status, phone)}
      <span class="visually-hidden">Profiles: {profiles.map(shownName).join(', ')}</span>
      <span class="tags" aria-hidden="true">
        {profiles.length <= shown ? (
          profiles.map((profilePath) => (
            <span key={profilePath} class="tag">
              {assignments.tagOf(profilePath)}
            </span>
          ))
        ) : (
          <span class="tag tag-count">
            {profiles.length} profiles
            <span class="tag-list">
              <span class="muted small">Profiles, in order</span>
              <ol>
                {profiles.map((profilePath) => (
                  <li key={profilePath}>{shownName(profilePath)}</li>
                ))}
              </ol>
            </span>
          </span>
        )}
      </span>
    </>
  );
}

interface PanelProfilesProps {
  readonly repository: Repository;
  readonly assignments: RepositoryProfiles;
  readonly folder: string;
  readonly onApplyProfiles: (repository: string, profiles: readonly ComparedProfile[]) => void;
  readonly onEdit: () => void;
}

export function PanelProfiles({
  repository,
  assignments,
  folder,
  onApplyProfiles,
  onEdit,
}: PanelProfilesProps): JSX.Element {
  const profiles = assignments.profilesOf(repository.full_name);
  const status = assignments.status(repository.full_name);
  const sentence = statusSentence(status);
  const canApply = profiles.length > 0 && status.kind !== 'missing' && status.kind !== 'checking';
  const reviewApply = (
    <button
      class={status.kind === 'current' ? 'button' : 'button button-small'}
      type="button"
      disabled={!canApply}
      onClick={() => {
        onApplyProfiles(
          repository.full_name,
          profiles.map((profilePath) => ({
            file: assignments.fileOf(profilePath),
            name: shownName(profilePath),
            folder,
          })),
        );
      }}
    >
      Review apply
    </button>
  );
  return (
    <section class="panel-profiles" aria-labelledby="repository-profiles-heading">
      <div class="panel-profiles-heading">
        <h3 id="repository-profiles-heading">Profiles</h3>
        <button
          class="button button-quiet button-small"
          type="button"
          aria-label={`Edit the profiles of ${repository.full_name}`}
          onClick={onEdit}
        >
          Edit
        </button>
      </div>
      {profiles.length === 0 ? (
        <p class="muted small">None yet. Apply a profile to add it, or choose some with Edit.</p>
      ) : (
        <>
          <ol class="layers">
            {profiles.map((profilePath) => (
              <li key={profilePath} class={assignments.isListed(profilePath) ? undefined : 'layer-missing'}>
                <span class="layer-name mono">{shownName(profilePath)}</span>
                {assignments.inheritedProfilesOf(repository.full_name).includes(profilePath) && (
                  <span class="muted small">From folder</span>
                )}
                <span class="tag">{assignments.tagOf(profilePath)}</span>
              </li>
            ))}
          </ol>
          {profiles.length > 1 && <p class="muted small">Later profiles override earlier ones.</p>}
          {sentence === undefined ? (
            reviewApply
          ) : (
            <div class={status.kind === 'missing' ? 'notice notice-problem' : 'notice notice-drift'}>
              <p>{sentence}</p>
              {status.kind !== 'missing' && <p class="notice-actions">{reviewApply}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function ProfileLayers({
  profiles,
  assignments,
  list,
  onChange,
}: {
  readonly profiles: Profiles;
  readonly assignments: RepositoryProfiles;
  readonly list: readonly string[];
  readonly onChange: (list: readonly string[]) => void;
}): JSX.Element {
  const choices = profiles.listings.value
    .filter((listing) => listing.problem === null)
    .map((listing) => profiles.pathOf(listing))
    .filter((profilePath) => !list.includes(profilePath));
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const adding = choices.find((profilePath) => profilePath === picked) ?? choices[0];
  const moved = (from: number, to: number): void => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    if (item !== undefined) {
      next.splice(to, 0, item);
      onChange(next);
    }
  };
  return (
    <>
      {list.length === 0 ? (
        <p class="muted">No profiles. Add one below.</p>
      ) : (
        <ol class="layers">
          {list.map((profilePath, index) => {
            const name = shownName(profilePath);
            const listed = assignments.isListed(profilePath);
            return (
              <li key={profilePath} class={listed ? undefined : 'layer-missing'}>
                <span class="layer-name">
                  <span class="mono">{name}</span>
                  {!listed && <span class="muted small"> Missing</span>}
                </span>
                <button
                  class="button button-quiet button-small"
                  type="button"
                  aria-label={`Move ${name} up`}
                  disabled={index === 0}
                  onClick={() => {
                    moved(index, index - 1);
                  }}
                >
                  ↑
                </button>
                <button
                  class="button button-quiet button-small"
                  type="button"
                  aria-label={`Move ${name} down`}
                  disabled={index === list.length - 1}
                  onClick={() => {
                    moved(index, index + 1);
                  }}
                >
                  ↓
                </button>
                <button
                  class="button button-quiet button-small"
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    onChange(list.filter((other) => other !== profilePath));
                  }}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {choices.length > 0 && (
        <div class="panel-form">
          <label for="add-profile">Add a profile</label>
          <div class="add-profile">
            <select
              id="add-profile"
              class="field"
              value={adding}
              onChange={(event) => {
                setPicked(event.currentTarget.value);
              }}
            >
              {choices.map((profilePath) => (
                <option key={profilePath} value={profilePath}>
                  {shownName(profilePath)}
                </option>
              ))}
            </select>
            <button
              class="button"
              type="button"
              onClick={() => {
                if (adding !== undefined) {
                  onChange([...list, adding]);
                  setPicked(undefined);
                }
              }}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </>
  );
}

interface EditDialogProps {
  readonly repository: Repository;
  readonly assignments: RepositoryProfiles;
  readonly profiles: Profiles;
  readonly onClose: () => void;
}

/** Saving changes the list alone: nothing is applied until an apply is reviewed. */
export function EditProfilesDialog({ repository, assignments, profiles, onClose }: EditDialogProps): JSX.Element {
  const dialog = useModal();
  const [list, setList] = useState<readonly string[]>(() => assignments.ownProfilesOf(repository.full_name));
  const inherited = assignments.inheritedProfilesOf(repository.full_name);
  return (
    <dialog class="dialog dialog-profiles" ref={dialog} aria-labelledby="edit-profiles-heading" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'save') {
            assignments.setProfiles(repository.full_name, list);
          }
        }}
      >
        <div>
          <h2 id="edit-profiles-heading">
            Profiles for <span class="mono">{repository.full_name}</span>
          </h2>
          <p class="muted small">They apply in this order. A later profile overrides what an earlier one sets.</p>
        </div>
        {inherited.length > 0 && (
          <div>
            <h3>From its folder</h3>
            <ol class="layers">
              {inherited.map((path) => (
                <li key={path} class="mono">
                  {shownName(path)}
                </li>
              ))}
            </ol>
            <p class="muted small">These apply first. Edit the folder's settings to change them.</p>
          </div>
        )}
        {inherited.length > 0 && <h3>Own profiles</h3>}
        <ProfileLayers profiles={profiles} assignments={assignments} list={list} onChange={setList} />
        <p class="muted small">
          Saving changes which profiles this repository uses. Nothing is applied until you review an apply.
        </p>
        <div class="form-actions">
          <button class="button button-primary" type="submit" value="save">
            Save
          </button>
          <button class="button button-quiet" type="submit" value="cancel">
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
