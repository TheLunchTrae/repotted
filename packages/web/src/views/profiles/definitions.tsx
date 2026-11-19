import type { DefinitionKind } from '@repotted/core';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Router } from '../../app/navigation/router.js';
import { definitionTypes } from '../../app/profiles/definition-types.js';
import type { Profiles } from '../../app/profiles/profiles.js';
import type { Repositories } from '../../app/repositories/repositories.js';
import { resolve } from '../../engine/path.js';
import { Link } from '../layout/link.js';
import { run } from '../layout/run.js';
import { NewProfileForm } from './new-profile.js';
import { Banners, DeleteProfiles, FolderNameDialog, Profile, type ProfilesDialog, SelectedPanel } from './profiles.js';

export function DefinitionsPage({
  kind,
  profiles,
  repositories,
  router,
}: {
  readonly kind: DefinitionKind;
  readonly profiles: Profiles;
  readonly repositories: Repositories;
  readonly router: Router;
}): JSX.Element {
  const library = definitionTypes.find((item) => item.kind === kind) ?? definitionTypes[0];
  if (library === undefined) {
    throw new Error('The definition library is not configured.');
  }
  const query = new URLSearchParams(router.search.value);
  const named = query.get('definition');
  const creating = query.has('new');
  const definitions = profiles.definitions.value.filter((listing) => listing.kind === kind);
  const batch = profiles.batch.value.filter((listing) => listing.kind === kind);
  const [dialog, setDialog] = useState<ProfilesDialog | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const listing = definitions.find((item) => item.file === resolve(profiles.folder.value, named ?? ''));
  useEffect(() => {
    if (listing !== undefined) {
      run(profiles.select(listing));
    }
  }, [profiles, listing?.file]);
  // Back on the list from a definition, the keyboard goes to that definition's row, or else to the heading.
  const openedBefore = useRef(named);
  useEffect(() => {
    const left = openedBefore.current;
    openedBefore.current = named;
    if (left === null || named !== null || creating) {
      return;
    }
    const row = document.querySelector<HTMLElement>(
      `a.row[href="${CSS.escape(`${library.path}?definition=${encodeURIComponent(left)}`)}"]`,
    );
    (row ?? heading.current)?.focus();
  }, [named, creating, library.path]);
  const users = listing === undefined ? [] : profiles.dependents(listing);
  const assignments =
    listing === undefined
      ? []
      : profiles.consumerNames(listing).filter((name) => !users.some((user) => user.name === name));
  return (
    <div class={`page${!creating && named === null && batch.length > 0 ? ' page-with-panel' : ''}`}>
      {creating ? (
        <div class="profiles-open">
          <div class="profiles-open-top">
            <Link router={router} to={library.path}>
              ← All {library.title.toLowerCase()}
            </Link>
            <Banners profiles={profiles} />
          </div>
          <NewProfileForm
            key={kind}
            profiles={profiles}
            repositories={repositories}
            router={router}
            repositoryToCapture={undefined}
            definitionKind={kind}
          />
        </div>
      ) : listing !== undefined ? (
        <div class="page-body">
          <p>
            <Link router={router} to={library.path}>
              ← All {library.title.toLowerCase()}
            </Link>
          </p>
          <Banners profiles={profiles} />
          <div class="definition-layout">
            {profiles.selected.value?.file === listing.file && (
              <Profile
                key={listing.file}
                listing={listing}
                profiles={profiles}
                router={router}
                standalone
                onSaved={() => {
                  // Only from the definition's own address: a save that ends after the page was left leaves it be.
                  if (
                    router.path.peek() === library.path &&
                    new URLSearchParams(router.search.peek()).get('definition') === named
                  ) {
                    router.go(library.path);
                  }
                }}
              />
            )}
            <aside class="definition-users">
              <span class="pill">Shared definition</span>
              <h2>
                Used by {users.length} {users.length === 1 ? 'profile' : 'profiles'}
              </h2>
              <ul>
                {users.map((profile) => (
                  <li key={profile.file}>
                    <button
                      class="link"
                      type="button"
                      onClick={() => {
                        run(profiles.select(profile));
                        router.go('/profiles');
                      }}
                    >
                      {profile.name}
                    </button>
                  </li>
                ))}
              </ul>
              {assignments.length > 0 && (
                <>
                  <h2>Assigned repositories</h2>
                  <ul>
                    {assignments.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                </>
              )}
              <p class="muted small">
                Saving updates linked profiles. Repository changes are reviewed and applied separately.
              </p>
              {users.length + assignments.length > 0 && (
                <p class="muted small">Remove its references and assignments before deleting this definition.</p>
              )}
            </aside>
          </div>
        </div>
      ) : named !== null ? (
        <div class="page-body">
          <Link router={router} to={library.path}>
            ← All {library.title.toLowerCase()}
          </Link>
          <p role={profiles.profileWorkUnderWay.value ? 'status' : 'alert'}>
            {profiles.profileWorkUnderWay.value
              ? 'Loading definitions…'
              : 'This definition is not in this library. Check where your profiles are kept in Settings.'}
          </p>
        </div>
      ) : (
        <section class="page-body">
          <div class="page-heading">
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {library.title}
              </h1>
              <p class="muted">
                {kind === 'actions-policy'
                  ? 'Control workflow execution with named policies. Reuse each policy across profiles.'
                  : 'Create a definition once and use it across profiles.'}
              </p>
            </div>
            <Link class="button button-primary" router={router} to={`${library.path}?new`}>
              New {kind === 'actions-policy' ? library.label : library.label.toLowerCase()}
            </Link>
          </div>
          <Banners profiles={profiles} />
          <ul class="rows">
            {definitions.map((definition) => {
              const count = profiles.dependents(definition).length;
              return (
                <li key={definition.file} class="selectable-row">
                  <input
                    class="select-box"
                    type="checkbox"
                    aria-label={`Select ${profiles.pathOf(definition).replace(/\.ya?ml$/iu, '')}`}
                    checked={profiles.isInBatch(definition)}
                    onChange={(event) => profiles.selectForBatch([definition], event.currentTarget.checked)}
                  />
                  <Link
                    class="row"
                    router={router}
                    to={`${library.path}?definition=${encodeURIComponent(profiles.pathOf(definition))}`}
                  >
                    <span class="row-name">{definition.name}</span>
                    <span class="muted small">
                      Used by {count} {count === 1 ? 'profile' : 'profiles'}
                    </span>
                    {profiles.unsaved.value.has(definition.file) && <span class="pill pill-drift">Not saved</span>}
                    {definition.problem !== null && <span class="pill pill-drift">Needs repair</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
          {definitions.length === 0 &&
            profiles.listed.value &&
            !profiles.profileWorkUnderWay.value &&
            profiles.listingError.value === undefined &&
            profiles.sync.value.status !== 'failed' && (
              <p class="muted">
                No {library.title.toLowerCase()} yet. Create one, then add it when creating or editing a profile.
              </p>
            )}
        </section>
      )}
      {!creating && named === null && batch.length > 0 && (
        <SelectedPanel
          profiles={profiles}
          selection={batch}
          onDialog={setDialog}
          onMoved={() => heading.current?.focus()}
          onDeselectAll={() => {
            profiles.selectForBatch(batch, false);
            heading.current?.focus();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteProfiles listings={dialog.listings} profiles={profiles} onClose={() => setDialog(undefined)} />
      )}
      {(dialog?.kind === 'new-folder' || dialog?.kind === 'rename') && (
        <FolderNameDialog profiles={profiles} dialog={dialog} onClose={() => setDialog(undefined)} />
      )}
    </div>
  );
}
