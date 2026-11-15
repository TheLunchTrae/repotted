import { useEffect, useState } from 'preact/hooks';

/** The width at and under which the page is laid out for a phone, as in app.css. */
const phone = '(max-width: 760px)';

/** Whether the window is phone-sized now, following it as it changes. */
export function usePhone(): boolean {
  const [matches, setMatches] = useState(() => matchMedia(phone).matches);
  useEffect(() => {
    const query = matchMedia(phone);
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
