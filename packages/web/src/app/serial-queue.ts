/** Runs pieces of work one at a time, in the order they were added, whether or not the ones before failed. */
export class SerialQueue {
  #last: Promise<unknown> = Promise.resolve();

  run<Result>(work: () => Promise<Result>): Promise<Result> {
    const result = this.#last.then(work, work);
    this.#last = result.catch(() => undefined);
    return result;
  }
}
