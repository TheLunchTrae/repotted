import { signal } from '@preact/signals';

/** The page's address within the app, which follows the browser's history. */
export class Router {
  readonly path = signal('/');

  readonly #history: Pick<History, 'pushState'>;

  constructor(
    location: Pick<Location, 'pathname'>,
    history: Pick<History, 'pushState'>,
    window: Pick<Window, 'addEventListener'>,
  ) {
    this.#history = history;
    this.path.value = location.pathname;
    window.addEventListener('popstate', () => {
      this.path.value = location.pathname;
    });
  }

  go(path: string): void {
    if (path !== this.path.value) {
      this.#history.pushState(null, '', path);
      this.path.value = path;
    }
  }
}
