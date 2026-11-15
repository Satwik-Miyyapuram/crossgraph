/**
 * A baseline lists the dead code and broken links a repository already has,
 * so a check fails only on new ones. Keys leave out line numbers, which move
 * with every edit above them.
 */

import { dead, missing, unlinked } from "./query.mjs";

export function findings(db) {
  return [
    ...dead(db).map((n) => `dead ${n.file} ${n.name}`),
    ...missing(db).map((m) => `missing ${m.via} ${m.file} ${m.name}`),
    ...unlinked(db).map((u) => `unlinked ${u.via} ${u.file} ${u.name}`),
  ].sort();
}

/** What is in `current` but not the baseline, and what the baseline no longer needs. */
export function compare(current, baseline) {
  const now = new Set(current);
  const known = new Set(baseline);
  return { added: current.filter((k) => !known.has(k)), fixed: baseline.filter((k) => !now.has(k)) };
}
