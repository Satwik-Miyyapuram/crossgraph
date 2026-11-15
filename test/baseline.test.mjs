import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compare, findings } from "../src/baseline.mjs";
import { buildGraph } from "../src/graph.mjs";
import { openDb } from "../src/query.mjs";
import { ROLE } from "../src/scip.mjs";
import { writeDb } from "../src/store.mjs";

const TS = "scip-typescript npm app 1.0.0 src/";
const def = (line, name) => ({ range: [line, 4, line, 8], symbol: `${TS}\`a.ts\`/${name}().`, roles: ROLE.definition, enclosing: [line, 0, line + 2, 1] });

describe("baseline", () => {
  it("keys findings by kind, file and name, without lines", () => {
    const graph = buildGraph({
      documents: [{ path: "src/a.ts", occurrences: [def(0, "orphan")], symbols: [] }],
      links: [{ via: "tauri", from: { file: "src/a.ts", line: 1 }, to: null, name: "gone" }],
    });
    const file = join(mkdtempSync(join(tmpdir(), "crossgraph-")), "graph.db");
    writeDb(file, { ...graph, unlinked: [{ via: "tauri", name: "idle", file: "shell/cmd.rs", line: 9 }] }, { isEntry: () => false });
    assert.deepEqual(findings(openDb(file)), ["dead src/a.ts orphan", "missing tauri src/a.ts gone", "unlinked tauri shell/cmd.rs idle"]);
  });

  it("reports only what is new, and what the baseline can drop", () => {
    assert.deepEqual(compare(["dead a f", "dead a g"], ["dead a g", "dead a h"]), { added: ["dead a f"], fixed: ["dead a h"] });
  });
});
