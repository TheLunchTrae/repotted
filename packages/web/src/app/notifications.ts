import { signal } from '@preact/signals';

export interface Confirmation {
  readonly message: string;
  readonly detail?: string;
}

/** A replacement gets its own five seconds; a previous timer cannot dismiss it. */
export class Notifications {
  readonly current = signal<(Confirmation & { readonly id: number }) | undefined>(undefined);
  readonly #paused = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #remaining = 5000;
  #started = 0;
  #disposed = false;
  #sequence = 0;

  show(confirmation: Confirmation): void {
    if (this.#disposed) {
      return;
    }
    this.#stop();
    this.#sequence += 1;
    this.current.value = { ...confirmation, id: this.#sequence };
    this.#remaining = 5000;
    this.#start();
  }

  pause(reason: string): void {
    this.#stop();
    this.#paused.add(reason);
  }

  resume(reason: string): void {
    this.#paused.delete(reason);
    this.#start();
  }

  dismiss(): void {
    this.#stop();
    this.current.value = undefined;
    this.#paused.delete('hover');
    this.#paused.delete('focus');
  }

  dispose(): void {
    this.dismiss();
    this.#disposed = true;
  }

  #start(): void {
    if (this.#timer !== undefined || this.#paused.size > 0 || this.current.value === undefined) {
      return;
    }
    this.#started = Date.now();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.current.value = undefined;
    }, this.#remaining);
  }

  #stop(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#remaining = Math.max(0, this.#remaining - (Date.now() - this.#started));
    }
  }
}
