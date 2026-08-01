import "server-only";

/**
 * Race a bounded application operation without leaking its timer. Callers that
 * own an AbortController should abort the underlying operation as well; Mongo
 * queries are separately bounded with maxTimeMS at the store boundary.
 */
export async function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
