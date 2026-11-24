/** Stop awaiting a promise on cancellation while observing any late rejection. */
export async function abortable<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const work = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return start();
  });
  try { return await Promise.race([aborted, work]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
