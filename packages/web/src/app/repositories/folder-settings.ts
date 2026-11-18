import { computed, type Signal, signal } from '@preact/signals';

import { repositoryFoldersKey } from '../preferences/preference-changes.js';
import type { Repositories } from './repositories.js';

interface Configuration {
  readonly layers: readonly string[];
  readonly applyOnMove: boolean;
}

export class FolderSettings {
  readonly layers: Signal<readonly string[]>;
  readonly applyOnMove: Signal<boolean>;
  readonly saving = signal<'save' | 'save-and-apply' | undefined>(undefined);
  readonly error = signal<string | undefined>(undefined);

  readonly #name: string;
  readonly #repositories: Repositories;
  readonly #saved: Signal<Configuration>;
  readonly #closed = signal(false);

  constructor(name: string, repositories: Repositories) {
    this.#name = name;
    this.#repositories = repositories;
    const saved = repositories.folder(name);
    this.layers = signal<readonly string[]>(saved?.profiles ?? []);
    this.applyOnMove = signal(saved?.applyProfilesOnMove ?? false);
    this.#saved = signal({ layers: this.layers.value, applyOnMove: this.applyOnMove.value });
  }

  readonly count = computed(() => this.#repositories.folder(this.#name)?.repositories.length ?? 0);
  readonly dirty = computed(() => {
    const current = this.#repositories.folder(this.#name);
    const configurations = [
      this.#saved.value,
      {
        layers: current?.profiles ?? [],
        applyOnMove: current?.applyProfilesOnMove ?? false,
      },
    ];
    return (
      this.#repositories.preferences.hasPending(repositoryFoldersKey) ||
      configurations.some(
        (saved) =>
          this.applyOnMove.value !== saved.applyOnMove ||
          this.layers.value.length !== saved.layers.length ||
          this.layers.value.some((layer, index) => layer !== saved.layers[index]),
      )
    );
  });
  readonly canSave = computed(() => !this.#closed.value && this.saving.value === undefined && this.dirty.value);
  readonly canSaveAndApply = computed(() => this.canSave.value && this.count.value > 0 && this.layers.value.length > 0);
  readonly canApply = computed(
    () =>
      !this.#closed.value &&
      this.saving.value === undefined &&
      !this.dirty.value &&
      this.count.value > 0 &&
      this.layers.value.length > 0,
  );

  async save(andApply: boolean): Promise<boolean> {
    if (!(andApply ? this.canSaveAndApply.value : this.canSave.value)) {
      return false;
    }
    this.saving.value = andApply ? 'save-and-apply' : 'save';
    this.error.value = undefined;
    const configuration = { layers: [...this.layers.value], applyOnMove: this.applyOnMove.value };
    try {
      const saved = await this.#repositories.setFolderProfiles(
        this.#name,
        configuration.layers,
        configuration.applyOnMove,
      );
      if (this.#closed.value) {
        return false;
      }
      if (!saved) {
        this.error.value =
          this.#repositories.preferences.error.value ?? "Couldn't save your folder settings. Try again.";
        return false;
      }
      this.#saved.value = configuration;
      if (this.#repositories.folder(this.#name) === undefined) {
        this.error.value = 'This folder no longer exists.';
        return false;
      }
      if (andApply && this.dirty.value) {
        this.error.value = 'Folder settings changed while saving. Save the displayed settings again before applying.';
        return false;
      }
      return andApply ? this.#review() : true;
    } finally {
      this.saving.value = undefined;
    }
  }

  apply(): boolean {
    return this.canApply.value && this.#review();
  }

  close(): void {
    this.#closed.value = true;
  }

  #review(): boolean {
    this.error.value = this.#repositories.reviewFolderProfiles(this.#name);
    return this.error.value === undefined;
  }
}
