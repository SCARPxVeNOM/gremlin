/** Work to undo if Gremlin is stopped mid-run (Ctrl-C, a cancelled CI step, a killed hook). */
const cleanups = new Map<symbol, () => void>();
let installed = false;

/** Register cleanup for an interruption. Returns a function that unregisters it once the work finishes normally. */
export function onInterrupt(fn: () => void): () => void {
  install();
  const key = Symbol();
  cleanups.set(key, fn);
  return () => cleanups.delete(key);
}

function install() {
  if (installed) return;
  installed = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      // newest first: a fix restores its bug, then its app stops, then its job closes
      for (const fn of [...cleanups.values()].reverse()) {
        try {
          fn();
        } catch {}
      }
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}
