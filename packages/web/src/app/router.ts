import { signal } from '@preact/signals';

/** A path without the slashes at its end, so `/profiles/` is the page `/profiles` is. */
function clean(path: string): string {
  return path.replace(/(?<=.)\/+$/u, '');
}

/** The page's address within the app, which follows the browser's history. */
export class Router {
  readonly path = signal('/');

  readonly #history: Pick<History, 'pushState'>;

  constructor(
    location: Pick<Location, 'pathname'>,
    history: Pick<History, 'pushState'>,
    window: { addEventListener(type: 'popstate', listener: () => void): void },
  ) {
    this.#history = history;
    this.path.value = clean(location.pathname);
    window.addEventListener('popstate', () => {
      this.path.value = clean(location.pathname);
    });
  }

  go(path: string): void {
    if (path !== this.path.value) {
      this.#history.pushState(null, '', path);
      this.path.value = path;
    }
  }
}
