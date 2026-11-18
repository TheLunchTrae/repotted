import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Profiles } from '../../app/profiles/profiles.js';
import { FolderSettings } from '../../app/repositories/folder-settings.js';
import type { Repositories } from '../../app/repositories/repositories.js';
import type { RepositoryProfiles } from '../../app/repositories/repository-profiles.js';
import { useMenuPanelKeptOnPage } from '../layout/menu-placement.js';
import { PendingButton } from '../layout/pending-button.js';
import { run } from '../layout/run.js';
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
  const settings = useMemo(() => new FolderSettings(name, repositories), [name, repositories]);
  useEffect(() => () => settings.close(), [settings]);
  const saving = settings.saving.value;
  const count = settings.count.value;
  const dirty = settings.dirty.value;
  const applyHint =
    count === 0
      ? 'No repositories in this folder yet. You can still save your folder settings.'
      : settings.layers.value.length === 0
        ? 'Add a profile to apply it. You can still save your folder settings.'
        : dirty
          ? `Save keeps your folder settings. Applying opens a review for the ${count === 1 ? 'repository' : `${count} repositories`} already here.`
          : 'No unsaved changes. Apply opens a review using this folder’s saved profiles.';
  return (
    <dialog
      class="dialog dialog-profiles"
      ref={dialog}
      aria-labelledby="folder-profiles-heading"
      onCancel={(event) => {
        if (saving !== undefined) {
          event.preventDefault();
        }
      }}
      onClose={() => {
        settings.close();
        onClose(name);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!(event.submitter instanceof HTMLButtonElement) || saving !== undefined) {
            return;
          }
          const action = event.submitter.value;
          if (action === 'apply' && settings.apply()) {
            dialog.current?.close();
          } else if (action === 'save' || action === 'save-and-apply') {
            run(
              settings.save(action === 'save-and-apply').then((finished) => {
                if (finished) {
                  dialog.current?.close();
                }
              }),
            );
          }
        }}
      >
        <header>
          <div class="folder-settings-heading">
            <h2 id="folder-profiles-heading">Profiles for {name}</h2>
            <span class={dirty ? 'pill pill-drift' : 'pill'}>{dirty ? 'Unsaved changes' : 'Saved'}</span>
          </div>
          <p class="muted small">
            {count} {count === 1 ? 'repository' : 'repositories'} in this folder
          </p>
        </header>
        <fieldset class="folder-settings-fields" disabled={saving !== undefined}>
          <div>
            <h3>Profiles</h3>
            <p class="muted small">
              These apply in order, before each repository's own profiles. Later profiles override earlier ones.
            </p>
          </div>
          <ProfileLayers
            profiles={profiles}
            assignments={assignments}
            list={settings.layers.value}
            onChange={(layers) => {
              settings.layers.value = layers;
            }}
          />
          <div class="folder-settings-moves">
            <label class="check">
              <input
                type="checkbox"
                checked={settings.applyOnMove.value}
                onChange={(event) => {
                  settings.applyOnMove.value = event.currentTarget.checked;
                }}
              />
              Apply profiles to repositories moved here
            </label>
            <p class="muted small">Moving repositories here opens a review before applying.</p>
          </div>
        </fieldset>
        {settings.error.value !== undefined && (
          <p class="notice notice-problem" role="alert">
            {settings.error.value}
          </p>
        )}
        <footer class="folder-settings-footer">
          <p class="muted small">{applyHint}</p>
          <div class="form-actions folder-settings-actions">
            <button
              class="button button-quiet folder-settings-cancel"
              type="button"
              disabled={saving !== undefined}
              onClick={() => {
                dialog.current?.close();
              }}
            >
              {dirty ? 'Cancel' : 'Close'}
            </button>
            <button
              class="button"
              type="submit"
              value="apply"
              disabled={!settings.canApply.value}
              title={dirty ? 'Save changes first, or choose Save and apply.' : undefined}
            >
              Apply
            </button>
            <PendingButton
              class="button"
              type="submit"
              value="save"
              pending={saving === 'save'}
              disabled={!settings.canSave.value}
            >
              Save
            </PendingButton>
            <PendingButton
              class="button button-primary"
              type="submit"
              value="save-and-apply"
              pending={saving === 'save-and-apply'}
              disabled={!settings.canSaveAndApply.value}
            >
              Save and apply
            </PendingButton>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
