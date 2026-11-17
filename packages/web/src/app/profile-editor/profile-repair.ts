import { computed, signal } from '@preact/signals';
import { readProfileForEditing, withoutUnknownProfileFields } from '@repotted/core';

import { readFile, writeFile } from '../../engine/files.js';
import { basename } from '../../engine/path.js';

export class ProfileRepair {
  readonly file: string;
  readonly text;
  readonly problem;
  readonly checking = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal<string | undefined>(undefined);
  readonly #original;
  #check = 0;

  constructor(file: string, text: string, problem: string) {
    this.file = file;
    this.text = signal(text);
    this.#original = signal(text);
    this.problem = signal<string | undefined>(problem);
  }

  readonly dirty = computed(() => this.text.value !== this.#original.value);
  readonly canSave = computed(
    () => this.dirty.value && !this.checking.value && this.problem.value === undefined && !this.saving.value,
  );

  async type(text: string): Promise<void> {
    this.text.value = text;
    this.saveError.value = undefined;
    await this.check();
  }

  async check(): Promise<void> {
    const turn = (this.#check += 1);
    this.checking.value = true;
    try {
      await readProfileForEditing(this.file, this.text.value);
      if (turn === this.#check) {
        this.problem.value = undefined;
      }
    } catch (error) {
      if (turn === this.#check) {
        this.problem.value = this.#reason(error);
      }
    } finally {
      if (turn === this.#check) {
        this.checking.value = false;
      }
    }
  }

  async save(write: (work: () => Promise<void>) => Promise<void>): Promise<void> {
    if (!this.canSave.value) {
      return;
    }
    const text = this.text.value;
    this.saving.value = true;
    this.saveError.value = undefined;
    try {
      await write(async () => {
        await readProfileForEditing(this.file, text);
        if ((await readFile(this.file, 'utf8')) !== this.#original.value) {
          throw new Error('The profile changed elsewhere. Copy your corrections, then reload before editing again.');
        }
        const cleaned = withoutUnknownProfileFields(text);
        await writeFile(this.file, cleaned);
        this.#original.value = cleaned;
        if (this.text.value === text) {
          this.text.value = cleaned;
        }
      });
    } catch (error) {
      this.saveError.value = this.#reason(error);
    } finally {
      this.saving.value = false;
    }
    await this.check();
  }

  #reason(error: unknown): string {
    return (error instanceof Error ? error.message : String(error))
      .replaceAll(this.file, basename(this.file))
      .replaceAll('✖ ', '')
      .replaceAll(/\s*→ at /gu, ', at ');
  }
}
