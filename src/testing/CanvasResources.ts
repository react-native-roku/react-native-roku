/** Shared, bounded registrations for exact (URI, family) font identities.
 * A factory returns an independently releasable registration token. Native and
 * browser Canvas hosts supply their own IO and keep their asset/URI policies. */
export function createCanvasFontRegistry<Key>(options: {
  register(uri: string, family: string): Key | Promise<Key>;
  unregister(key: Key): void;
  limit?: number;
}) {
  const limit = options.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1) throw Error("Invalid Canvas font budget");
  interface Entry {
    owners: Set<object>;
    pending: Promise<void>;
    key?: Key;
    ready: boolean;
    retired: boolean;
    released: boolean;
    failed: boolean;
  }
  const entries = new Map<string, Entry>();
  const retiring = new Set<Entry>();
  const retire = (name: string, entry: Entry) => {
    if (entry.owners.size) return;
    entry.retired = true;
    if (entries.get(name) === entry) entries.delete(name);
    if (entry.failed || entry.released) return;
    retiring.add(entry);
    if (entry.ready) {
      options.unregister(entry.key!);
      entry.released = true;
      retiring.delete(entry);
    }
  };
  const retireUnused = () => {
    const failures: unknown[] = [];
    const work: Array<[string, Entry]> = [
      ...entries,
      ...[...retiring].map((entry): [string, Entry] => ["", entry]),
    ];
    for (const [name, entry] of work) {
      try {
        retire(name, entry);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  };
  return {
    retireUnused,
    snapshot: () => ({
      registrations: entries.size + retiring.size,
      pending: [...entries.values(), ...retiring].filter((entry) => !entry.ready).length,
      owners: [...entries.values()].reduce((sum, entry) => sum + entry.owners.size, 0),
      limit,
    }),
    createOwner() {
      const token = {},
        owned = new Map<string, { entry: Entry; pending: number; ready: boolean }>();
      let retired = false;
      return {
        async ready(uri: string, family: string, signal?: AbortSignal): Promise<void> {
          if (retired) throw Error("Canvas font owner retired");
          if (signal?.aborted) throw signal.reason;
          const name = JSON.stringify([uri, family]);
          let entry = entries.get(name);
          if (!entry) {
            if (entries.size + retiring.size >= limit) retireUnused();
            if (entries.size + retiring.size >= limit)
              throw Error("The Canvas font-family budget was exceeded");
            entry = {
              owners: new Set(),
              pending: Promise.resolve(),
              ready: false,
              retired: false,
              released: false,
              failed: false,
            };
            // Reserve before invoking a factory that can reenter this owner.
            entries.set(name, entry);
            const current = entry;
            current.pending = Promise.resolve()
              .then(() => {
                if (current.retired) throw Error("Canvas font preparation retired");
                return options.register(uri, family);
              })
              .then(
                (key) => {
                  current.key = key;
                  current.ready = true;
                  if (current.retired) retire(name, current);
                },
                (error) => {
                  current.failed = true;
                  retiring.delete(current);
                  if (entries.get(name) === current) entries.delete(name);
                  throw error;
                },
              );
          }
          entry.owners.add(token);
          let lease = owned.get(name);
          if (!lease || lease.entry !== entry) {
            lease = { entry, pending: 0, ready: false };
            owned.set(name, lease);
          }
          lease.pending++;
          try {
            await entry.pending;
            if (retired) throw Error("Canvas font owner retired");
            if (signal?.aborted) throw signal.reason;
            lease.ready = true;
          } finally {
            lease.pending--;
            if (!lease.pending && !lease.ready) {
              entry.owners.delete(token);
              if (owned.get(name) === lease) owned.delete(name);
              // Preparation/abort remains authoritative; failed unregisters
              // remain charged and retryable through retireUnused().
              try {
                retire(name, entry);
              } catch {
                /* Retained for retry. */
              }
            }
          }
        },
        dispose() {
          if (retired) return;
          retired = true;
          for (const [name, { entry }] of owned) {
            entry.owners.delete(token);
            // Pending completion cannot register an unowned, retired font.
            if (!entry.ready && !entry.owners.size) retire(name, entry);
          }
          owned.clear();
        },
      };
    },
  };
}
