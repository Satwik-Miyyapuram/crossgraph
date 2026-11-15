import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { buildGraph } from "../src/graph.mjs";
import { callees, callers, dead, find, openDb, path, testOnly } from "../src/query.mjs";
import { ROLE } from "../src/scip.mjs";
import { writeDb } from "../src/store.mjs";

const def = (line, symbol, end = line + 2) => ({ range: [line, 4, line, 8], symbol, roles: ROLE.definition, enclosing: [line, 0, end, 1] });
const ref = (line, symbol) => ({ range: [line, 4, line, 8], symbol, roles: 0, enclosing: null });
const doc = (p, occurrences) => ({ path: p, occurrences, symbols: [] });
const TS = "scip-typescript npm app 1.0.0 src/";
const RS = "rust-analyzer cargo core 0.1.0 ";
const ts = (file, name) => `${TS}\`${file}\`/${name}().`;

// page -> draw -> tangentAt (wasm) -> tangent_at_js -> tangent
// helper is used only by a test; orphan by nothing; fmt is a trait impl.
let db;
before(() => {
  const graph = buildGraph({
    documents: [
      doc("src/app/page.tsx", [def(0, ts("page.tsx", "Page"), 5), ref(1, ts("draw.ts", "draw"))]),
      doc("src/draw.ts", [
        def(0, ts("draw.ts", "draw"), 4),
        ref(2, "scip-typescript npm @app/wasm 0.1.0 pkg/`app.d.ts`/tangentAt()."),
        ref(2, "scip-typescript npm @app/wasm 0.1.0 pkg/`app.d.ts`/tangentAt()."),
        def(6, ts("draw.ts", "helper")),
        def(10, ts("draw.ts", "orphan")),
      ]),
      doc("src/draw.test.ts", [def(0, ts("draw.test.ts", "case"), 4), ref(1, ts("draw.ts", "helper")), ref(2, ts("draw.ts", "draw"))]),
      doc("crates/wasm/src/lib.rs", [def(0, `${RS}tangent_at_js().`, 3), ref(1, `${RS}geo/tangent().`), def(5, `${RS}impl#[Pen][Display]fmt().`), def(9, `${RS}main().`)]),
      doc("crates/geo/src/lib.rs", [def(0, `${RS}geo/tangent().`), def(4, `${RS}geo/unused().`)]),
      doc("src/types.d.ts", [def(0, `${TS}\`types.d.ts\`/Ambient#`)]),
    ],
    links: [{ via: "wasm", package: "@app/wasm", name: "tangentAt", to: { file: "crates/wasm/src/lib.rs", line: 1 } }],
    isTest: (p) => p.includes(".test."),
  });
  const file = join(mkdtempSync(join(tmpdir(), "crossgraph-")), "graph.db");
  writeDb(file, { ...graph, unlinked: [] }, { isEntry: (p) => p.startsWith("src/app/") });
  db = openDb(file);
});

const names = (rows) => rows.map((r) => r.name).sort();

describe("queries", () => {
  it("finds nodes by name, or by file:name", () => {
    assert.equal(find(db, "draw").length, 1);
    assert.equal(find(db, "src/draw.ts:helper")[0].line, 7);
    assert.deepEqual(find(db, "nope"), []);
  });

  it("lists callers and callees, across the language gap", () => {
    assert.deepEqual(names(callers(db, "draw")), ["Page", "case"]);
    // Two uses on one line are one row.
    assert.deepEqual(names(callees(db, "draw")), ["tangentAt"]);
    assert.deepEqual(names(callees(db, "draw")), ["tangentAt"]);
  });

  it("finds a path from TS into Rust", () => {
    assert.deepEqual(path(db, "Page", "tangent").map((n) => n.name), ["Page", "draw", "tangentAt", "tangent_at_js", "tangent"]);
    assert.deepEqual(path(db, "tangent", "Page"), []);
  });

  it("reports dead code, skipping entries, tests, trait impls, main and .d.ts", () => {
    assert.deepEqual(names(dead(db)), ["orphan", "unused"]);
  });

  it("reports code only tests use", () => {
    assert.deepEqual(names(testOnly(db)), ["helper"]);
  });
});
