import { useEffect, useState } from 'preact/hooks';

// The phone breakpoint in app.css.
const phoneMediaQuery = '(max-width: 760px)';

export function usePhone(): boolean {
  const [matches, setMatches] = useState(() => matchMedia(phoneMediaQuery).matches);
  useEffect(() => {
    const query = matchMedia(phoneMediaQuery);
    const change = (): void => {
      setMatches(query.matches);
    };
    change();
    query.addEventListener('change', change);
    return () => {
      query.removeEventListener('change', change);
    };
  }, []);
  return matches;
}
