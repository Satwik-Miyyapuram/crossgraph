/**
 * Questions asked of a graph database. A target is a name (`draw`) or a file
 * and a name (`src/draw.ts:draw`); every node that matches is used.
 */

import { DatabaseSync } from "node:sqlite";

export const openDb = (file) => new DatabaseSync(file, { readOnly: true });

const COLUMNS = "n.id, n.name, n.kind, n.lang, n.file, n.line, n.test";

export function find(db, target) {
  const colon = target.lastIndexOf(":");
  if (colon > 0 && /[./]/.test(target.slice(0, colon))) {
    return db.prepare(`SELECT ${COLUMNS} FROM nodes n WHERE name = ? AND file = ?`).all(target.slice(colon + 1), target.slice(0, colon));
  }
  return db.prepare(`SELECT ${COLUMNS} FROM nodes n WHERE name = ?`).all(target);
}

/** What uses the target, one row per use site. */
export function callers(db, target) {
  const q = db.prepare(`SELECT DISTINCT ${COLUMNS}, e.via, e.file AS at, e.line AS atLine FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ?`);
  return find(db, target).flatMap((t) => q.all(t.id));
}

/** What the target uses. */
export function callees(db, target) {
  const q = db.prepare(`SELECT DISTINCT ${COLUMNS}, e.via, e.file AS at, e.line AS atLine FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ?`);
  return find(db, target).flatMap((t) => q.all(t.id));
}

/** The shortest chain of uses from one target to another, or []. */
export function path(db, from, to) {
  const goals = new Set(find(db, to).map((n) => n.id));
  const next = db.prepare("SELECT DISTINCT dst FROM edges WHERE src = ?");
  const prev = new Map();
  let frontier = find(db, from).map((n) => n.id);
  for (const id of frontier) prev.set(id, null);
  while (frontier.length) {
    const hit = frontier.find((id) => goals.has(id));
    if (hit !== undefined) {
      const chain = [];
      for (let id = hit; id !== null; id = prev.get(id)) chain.unshift(id);
      const node = db.prepare(`SELECT ${COLUMNS} FROM nodes n WHERE id = ?`);
      return chain.map((id) => node.get(id));
    }
    const after = [];
    for (const id of frontier) {
      for (const { dst } of next.all(id)) {
        if (!prev.has(dst)) {
          prev.set(dst, id);
          after.push(dst);
        }
      }
    }
    frontier = after;
  }
  return [];
}

// Definitions whose use cannot show up as a reference: entry files a framework
// loads, ambient declarations, trait methods Rust dispatches, `main`.
const CANDIDATE = `
  n.kind IN ('function', 'type') AND n.test = 0 AND n.entry = 0
  AND n.file NOT LIKE '%.d.ts' AND n.name NOT IN ('main', '<constructor>')
  AND n.symbol NOT LIKE '%impl#[%][%]%'
`;
// Some edges only pass a use along, so they count only while their source is
// used: a wasm export's .d.ts declaration, and an interface member linked by
// shape to a class member. Chains of them are followed a few hops.
const PASSES = (e, s) => `(${e}.via = 'structural' OR (${e}.via = 'wasm' AND COALESCE(${s}.file, '') LIKE '%.d.ts'))`;
function used(src, target = "n", hops = 3) {
  const [e, s] = [`e${hops}`, `s${hops}`];
  const passed = hops ? used(src, s, hops - 1) : "0";
  return `EXISTS (SELECT 1 FROM edges ${e} JOIN nodes ${s} ON ${s}.id = ${e}.src WHERE ${e}.dst = ${target}.id AND ${src(s)}
    AND (NOT ${PASSES(e, s)} OR ${passed}))`;
}
const USED_OUTSIDE_TESTS = used((s) => `${s}.test = 0`);
const USED = used(() => "1");

/** Definitions nothing outside tests uses. */
export function dead(db) {
  return db.prepare(`SELECT ${COLUMNS} FROM nodes n WHERE ${CANDIDATE} AND NOT ${USED} ORDER BY n.file, n.line`).all();
}

/** Definitions only tests use. */
export function testOnly(db) {
  return db.prepare(`SELECT ${COLUMNS} FROM nodes n WHERE ${CANDIDATE} AND ${USED} AND NOT ${USED_OUTSIDE_TESTS} ORDER BY n.file, n.line`).all();
}

export const missing = (db) => db.prepare("SELECT * FROM missing ORDER BY file, line").all();
export const unlinked = (db) => db.prepare("SELECT * FROM unlinked ORDER BY file, line").all();
