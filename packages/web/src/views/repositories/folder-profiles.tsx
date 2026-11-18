import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { Profiles } from '../../app/profiles/profiles.js';
import type { Repositories } from '../../app/repositories/repositories.js';
import type { RepositoryProfiles } from '../../app/repositories/repository-profiles.js';
import { useMenuPanelKeptOnPage } from '../layout/menu-placement.js';
import { useDismissibleMenu, useModal } from '../layout/shell.js';
import { ProfileLayers } from './repository-profiles.js';

export function FolderProfileTags({
  name,
  repositories,
  profiles,
  assignments,
  phone,
  onEdit,
}: {
  readonly name: string;
  readonly repositories: Repositories;
  readonly profiles: Profiles;
  readonly assignments: RepositoryProfiles;
  readonly phone: boolean;
  readonly onEdit: () => void;
}): JSX.Element {
  const menu = useDismissibleMenu();
  const container = useRef<HTMLDivElement>(null);
  const tagNames = useRef<HTMLSpanElement>(null);
  const tagCount = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
  useMenuPanelKeptOnPage(menu);
  const layers = repositories.folder(name)?.profiles ?? [];
  const choices = profiles.listings.value
    .filter((listing) => listing.problem === null && listing.kind === undefined)
    .map((listing) => profiles.pathOf(listing))
    .filter((path) => !layers.includes(path));
  const names = layers.map((path) => path.replace(/\.ya?ml$/iu, '')).join(', ');
  useLayoutEffect(() => {
    const element = container.current;
    const tags = tagNames.current;
    const count = tagCount.current;
    const adding = menu.current;
    if (element === null || adding === null) {
      return;
    }
    if (tags === null || count === null) {
      element.style.minWidth = '';
      element.style.removeProperty('--folder-profiles-full-width');
      setFits(true);
      return;
    }
    const measure = (): void => {
      const style = getComputedStyle(element);
      const namesWidth = tags.getBoundingClientRect().width;
      const controlsWidth = adding.getBoundingClientRect().width + Number.parseFloat(style.columnGap);
      element.style.minWidth = `${Math.min(namesWidth, count.getBoundingClientRect().width) + controlsWidth}px`;
      // Keep the phone width budget independent of the collapsed badge.
      element.style.setProperty('--folder-profiles-full-width', `${namesWidth + controlsWidth}px`);
      const available = element.getBoundingClientRect().width;
      setFits(namesWidth <= available - controlsWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(tags);
    observer.observe(count);
    observer.observe(adding);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [layers.length]);
  const close = (): void => {
    if (menu.current !== null) {
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    }
  };
  return (
    <div class="folder-profiles" ref={container}>
      {layers.length > 0 && (
        <button
          class={
            !fits || (!phone && layers.length > 3)
              ? 'folder-profile-tags folder-profile-tags-compact'
              : 'folder-profile-tags'
          }
          type="button"
          aria-label={`Profiles for ${name}: ${names}`}
          title={names}
          onClick={onEdit}
        >
          <span class="folder-profile-names" ref={tagNames} aria-hidden="true">
            {layers.map((path) => (
              <span class="tag" key={path}>
                {assignments.tagOf(path)}
              </span>
            ))}
          </span>
          <span class="tag folder-profile-count" ref={tagCount} aria-hidden="true">
            {layers.length} {layers.length === 1 ? 'profile' : 'profiles'}
          </span>
        </button>
      )}
      <details class="menu folder-profile-add" ref={menu}>
        <summary class="folder-profile-plus" aria-label={`Add a profile to ${name}`} title="Add a profile">
          <span class="tag" aria-hidden="true">
            +
          </span>
        </summary>
        <div class="menu-panel">
          <p class="menu-heading">Add a profile to {name}</p>
          {choices.length === 0 && (
            <p class="muted small">
              {layers.length > 0 ? 'Every available profile is already assigned.' : 'No profiles available.'}
            </p>
          )}
          {choices.map((path) => (
            <button
              key={path}
              class="menu-item"
              type="button"
              onClick={() => {
                repositories.addFolderProfile(name, path);
                close();
              }}
            >
              {path.replace(/\.ya?ml$/iu, '')}
            </button>
          ))}
          <div class="menu-actions">
            <button
              class="menu-item"
              type="button"
              onClick={() => {
                close();
                onEdit();
              }}
            >
              Manage profiles…
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

export function FolderProfilesDialog({
  name,
  repositories,
  profiles,
  assignments,
  onClose,
}: {
  readonly name: string;
  readonly repositories: Repositories;
  readonly profiles: Profiles;
  readonly assignments: RepositoryProfiles;
  readonly onClose: (folderToFocus: string) => void;
}): JSX.Element {
  const dialog = useModal();
  const saved = repositories.folder(name);
  const [layers, setLayers] = useState<readonly string[]>(saved?.profiles ?? []);
  const [applyOnMove, setApplyOnMove] = useState(saved?.applyProfilesOnMove ?? false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const count = saved?.repositories.length ?? 0;
  return (
    <dialog
      class="dialog dialog-profiles"
      ref={dialog}
      aria-labelledby="folder-profiles-heading"
      onClose={() => {
        onClose(name);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && ['save', 'review'].includes(event.submitter.value)) {
            repositories.setFolderProfiles(name, layers, applyOnMove);
            if (event.submitter.value === 'review') {
              const refused = repositories.reviewFolderProfiles(name);
              if (refused !== undefined) {
                event.preventDefault();
                setProblem(refused);
              }
            }
          }
        }}
      >
        <div>
          <h2 id="folder-profiles-heading">Profiles for {name}</h2>
          <p class="muted small">
            These apply in order, before each repository's own profiles. Later profiles override earlier ones.
          </p>
        </div>
        <ProfileLayers profiles={profiles} assignments={assignments} list={layers} onChange={setLayers} />
        <label class="check">
          <input
            type="checkbox"
            checked={applyOnMove}
            onChange={(event) => {
              setApplyOnMove(event.currentTarget.checked);
            }}
          />
          Apply profiles to repositories moved here
        </label>
        <p class="muted small">
          Moving a repository here opens a review of its profiles. Moving several opens one batch review. Nothing is
          written until you review and apply.
        </p>
        <p class="muted small">
          Save only updates the folder.{' '}
          {count === 0
            ? 'Move repositories into it before reviewing an apply.'
            : `To apply these profiles to the ${count === 1 ? 'repository' : `${count} repositories`} already here, save and review ${count === 1 ? 'its' : 'their'} changes.`}
        </p>
        {problem !== undefined && (
          <p class="problem small" role="alert">
            {problem}
          </p>
        )}
        <div class="form-actions">
          <button
            class="button button-primary"
            type="submit"
            value="review"
            disabled={count === 0 || layers.length === 0}
          >
            Save and review apply
          </button>
          <button class="button" type="submit" value="save">
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
