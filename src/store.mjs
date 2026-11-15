/**
 * Write a graph to a SQLite file, replacing what was there. The schema is
 * small on purpose so it can be queried by hand with `sqlite3` too.
 */

import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, symbol TEXT, name TEXT NOT NULL,
  lang TEXT, file TEXT, line INTEGER, kind TEXT NOT NULL, test INTEGER NOT NULL, entry INTEGER NOT NULL
);
CREATE TABLE edges (src INTEGER NOT NULL, dst INTEGER NOT NULL, file TEXT, line INTEGER, via TEXT NOT NULL);
CREATE TABLE missing (via TEXT, name TEXT, file TEXT, line INTEGER);
CREATE TABLE unlinked (via TEXT, name TEXT, file TEXT, line INTEGER);
CREATE INDEX nodes_name ON nodes(name);
CREATE INDEX edges_src ON edges(src);
CREATE INDEX edges_dst ON edges(dst);
`;

/**
 * @param {string} file
 * @param {{ nodes: object[], edges: object[], missing: object[], unlinked: object[] }} graph
 * @param {{ isEntry?: (path: string) => boolean }} [options]
 */
export function writeDb(file, { nodes, edges, missing, unlinked }, { isEntry = () => false } = {}) {
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.exec("BEGIN");
  const ids = new Map();
  const node = db.prepare("INSERT INTO nodes (key, symbol, name, lang, file, line, kind, test, entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const n of nodes) {
    const { lastInsertRowid } = node.run(n.key, n.symbol, n.name, n.lang, n.file, n.line, n.kind, n.test ? 1 : 0, n.file && isEntry(n.file) ? 1 : 0);
    ids.set(n.key, lastInsertRowid);
  }
  const edge = db.prepare("INSERT INTO edges (src, dst, file, line, via) VALUES (?, ?, ?, ?, ?)");
  for (const e of edges) edge.run(ids.get(e.src), ids.get(e.dst), e.file, e.line, e.via);
  for (const [table, rows] of [["missing", missing], ["unlinked", unlinked]]) {
    const insert = db.prepare(`INSERT INTO ${table} (via, name, file, line) VALUES (?, ?, ?, ?)`);
    for (const r of rows) insert.run(r.via, r.name, r.file, r.line);
  }
  db.exec("COMMIT");
  db.close();
}
