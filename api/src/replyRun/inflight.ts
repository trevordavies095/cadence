/**
 * Background reply runs that have started but not finished. The API never needs
 * to wait on these; tests use it to let a run settle before they reset the
 * database or issue a request that would collide with it.
 */
const inflight = new Set<Promise<unknown>>();

export function trackReplyRun<T>(work: Promise<T>): Promise<T> {
  inflight.add(work);
  const done = () => inflight.delete(work);
  work.then(done, done);
  return work;
}

export async function waitForReplyRunsIdle(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}
