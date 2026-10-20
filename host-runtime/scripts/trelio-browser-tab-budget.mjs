/** A process-lifetime budget, not just the current number of open tabs.
 * Closing a tab does not replenish it; reconnecting the private socket must
 * not let a short-lived provider CLI create another batch. The extension
 * counts all its owned profile tabs, including blanks and login popups.
 * Browser-created popups can only be observed AFTER creation: reject/remove
 * them immediately, never select them or mint an input token for them.
 */
export function createBrowserTabBudget() {
  const admitted = new Set(), active = new Set();
  const maximum = 5;
  return Object.freeze({
    get canCreate() { return admitted.size < maximum; },
    admit(id) {
      if (!Number.isInteger(id) || id < 0) return false;
      if (admitted.has(id)) return active.has(id);
      if (admitted.size >= maximum) return false;
      admitted.add(id); active.add(id); return true;
    },
    contains(id) { return active.has(id); },
    removed(id) { active.delete(id); },
    get counts() { return { maximum, opened: admitted.size, open: active.size }; },
  });
}
