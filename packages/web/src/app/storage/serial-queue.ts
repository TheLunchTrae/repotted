/** Work still runs, in order, when the work before it failed. */
export class SerialQueue {
  #last: Promise<unknown> = Promise.resolve();

  run<Result>(work: () => Promise<Result>): Promise<Result> {
    const result = this.#last.then(work, work);
    this.#last = result.catch(() => undefined);
    return result;
  }
}
