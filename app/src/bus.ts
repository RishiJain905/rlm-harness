// KV cache: none
// A typed in-process event bus (architecture §7.1, §7.3). A throwing listener is logged on
// stderr, and the other listeners still run.

type Listener<P> = (payload: P) => void;

export class Bus<E> {
  private readonly listeners = new Map<keyof E, Set<Listener<any>>>();

  /** Returns an unsubscribe function. */
  on<K extends keyof E>(k: K, fn: (p: E[K]) => void): () => void {
    let set = this.listeners.get(k);
    if (!set) {
      set = new Set();
      this.listeners.set(k, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit<K extends keyof E>(k: K, p: E[K]): void {
    for (const fn of [...(this.listeners.get(k) ?? [])]) {
      try {
        fn(p);
      } catch (err) {
        const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        process.stderr.write(`rlmh: listener for ${String(k)} failed: ${text}\n`);
      }
    }
  }
}
