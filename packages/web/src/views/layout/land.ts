/**
 * Takes the user to a place a link sent them to: scrolls it into view, gives
 * it the keyboard, and marks `marked` until its animation ends, so the eye
 * finds it. Marking again restarts the animation.
 */
export function land(target: HTMLElement, marked: HTMLElement = target): void {
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
  marked.classList.remove('landed');
  // Reading the layout ends the removed animation, so the one added next starts over.
  void marked.offsetWidth;
  marked.classList.add('landed');
  const ended = (event: AnimationEvent): void => {
    // An animation inside the marked place, such as a spinner's, ends there too.
    if (event.target === marked) {
      marked.classList.remove('landed');
      marked.removeEventListener('animationend', ended);
    }
  };
  marked.addEventListener('animationend', ended);
}
