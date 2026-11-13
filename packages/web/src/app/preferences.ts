/**
 * Small choices the app remembers in this browser, such as which owners'
 * repositories are hidden. A browser that refuses storage, as some do in
 * private windows, keeps them for the visit only.
 */
export interface Preferences {
  read(key: string): unknown;
  write(key: string, value: unknown): void;
}

const prefix = 'repotted:';

export function browserPreferences(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): Preferences {
  return {
    read(key) {
      try {
        const text = storage.getItem(prefix + key);
        const value: unknown = text === null ? undefined : JSON.parse(text);
        return value;
      } catch {
        return undefined;
      }
    },
    write(key, value) {
      try {
        if (value === undefined) {
          storage.removeItem(prefix + key);
        } else {
          storage.setItem(prefix + key, JSON.stringify(value));
        }
      } catch {
        // The choice still holds for this visit.
      }
    },
  };
}
