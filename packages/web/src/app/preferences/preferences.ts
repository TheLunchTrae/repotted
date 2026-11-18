export interface Preferences {
  read(key: string): unknown;
  write(key: string, value: unknown): void;
}

export interface BrowserPreferences extends Preferences {
  write(key: string, value: unknown): boolean;
}

const prefix = 'repotted:';

/**
 * `storage` is asked for at each use, inside the same guard as the use
 * itself, since a browser that blocks a site's data throws when the page so
 * much as names `localStorage`.
 */
export function browserPreferences(
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): BrowserPreferences {
  return {
    read(key) {
      try {
        const text = storage().getItem(prefix + key);
        const value: unknown = text === null ? undefined : JSON.parse(text);
        return value;
      } catch {
        return undefined;
      }
    },
    write(key, value) {
      try {
        if (value === undefined) {
          storage().removeItem(prefix + key);
        } else {
          storage().setItem(prefix + key, JSON.stringify(value));
        }
        return true;
      } catch {
        // The choice still holds for this visit.
        return false;
      }
    },
  };
}
