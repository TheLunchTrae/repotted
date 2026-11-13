/**
 * Starts work a control asked for. The app's state reports its own failures,
 * so a rejection here is a defect, and goes where the browser reports
 * uncaught errors.
 */
export function run(work: Promise<unknown>): void {
  work.catch(reportError);
}
