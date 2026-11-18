import { useEffect, useState } from 'preact/hooks';

// The phone breakpoint in app.css.
export const phoneMediaQuery = '(max-width: 760px)';

export function usePhone(mediaQuery = phoneMediaQuery): boolean {
  const [matches, setMatches] = useState(() => matchMedia(mediaQuery).matches);
  useEffect(() => {
    const query = matchMedia(mediaQuery);
    const change = (): void => {
      setMatches(query.matches);
    };
    change();
    query.addEventListener('change', change);
    return () => {
      query.removeEventListener('change', change);
    };
  }, [mediaQuery]);
  return matches;
}
