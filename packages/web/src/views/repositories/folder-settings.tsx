import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { Profiles } from '../../app/profiles/profiles.js';
import type { Repositories } from '../../app/repositories/repositories.js';
import type { RepositoryProfiles } from '../../app/repositories/repository-profiles.js';
import { useModal } from '../layout/shell.js';
import { ProfileLayers } from './repository-profiles.js';

export function FolderSettingsDialog({
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
  return (
    <dialog
      class="dialog dialog-profiles"
      ref={dialog}
      aria-labelledby="folder-settings-heading"
      onClose={() => {
        onClose(name);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'save') {
            repositories.setFolderSettings(name, layers, applyOnMove);
          }
        }}
      >
        <h2 id="folder-settings-heading">Settings for {name}</h2>
        <div>
          <h3>Profiles</h3>
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
        <p class="muted small">Saving settings applies nothing to repositories already here.</p>
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
