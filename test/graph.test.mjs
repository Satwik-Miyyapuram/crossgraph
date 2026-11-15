import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGraph } from "../src/graph.mjs";
import { ROLE } from "../src/scip.mjs";

const DEF = ROLE.definition;
const def = (line, symbol, end = line + 2) => ({ range: [line, 4, line, 8], symbol, roles: DEF, enclosing: [line, 0, end, 1] });
const ref = (line, symbol, roles = 0) => ({ range: [line, 4, line, 8], symbol, roles, enclosing: null });
const doc = (path, occurrences, symbols = []) => ({ path, occurrences, symbols });

const TS = "scip-typescript npm app 1.0.0 src/";
const RS = "rust-analyzer cargo core 0.1.0 ";

/** Edges as readable "src -> dst" strings, by node name. */
function arrows(graph, via) {
  const name = new Map(graph.nodes.map((n) => [n.key, n.name]));
  return graph.edges.filter((e) => !via || e.via === via).map((e) => `${name.get(e.src)} -> ${name.get(e.dst)}`).sort();
}

describe("buildGraph", () => {
  it("attributes each reference to the innermost definition around it", () => {
    const g = buildGraph({
      documents: [
        doc("src/a.ts", [
          def(0, `${TS}\`a.ts\`/outer().`, 10),
          def(2, `${TS}\`a.ts\`/inner().`, 4),
          ref(3, `${TS}\`b.ts\`/leaf().`),
          ref(6, `${TS}\`b.ts\`/leaf().`),
          ref(12, `${TS}\`b.ts\`/leaf().`),
        ]),
        doc("src/b.ts", [def(0, `${TS}\`b.ts\`/leaf().`)]),
      ],
    });
    assert.deepEqual(arrows(g), ["inner -> leaf", "outer -> leaf", "src/a.ts -> leaf"]);
  });

  it("names, kinds and locates definitions", () => {
    const g = buildGraph({
      documents: [
        doc("src/a.ts", [def(0, `${TS}\`a.ts\`/run().`), def(5, `${TS}\`a.ts\`/Thing#`), def(9, `${TS}\`a.ts\`/LIMIT.`)]),
        doc("src/lib.rs", [def(3, `${RS}ink/impl#[Pen][Display]fmt().`)], [
          { symbol: `${RS}ink/impl#[Pen][Display]fmt().`, kind: 0, name: "fmt", relationships: [] },
        ]),
      ],
    });
    const pick = (n) => [n.name, n.kind, n.lang, n.file, n.line];
    assert.deepEqual(
      g.nodes.filter((n) => n.kind !== "file").map(pick),
      [
        ["run", "function", "ts", "src/a.ts", 1],
        ["Thing", "type", "ts", "src/a.ts", 6],
        ["LIMIT", "term", "ts", "src/a.ts", 10],
        ["fmt", "function", "rust", "src/lib.rs", 4],
      ],
    );
  });

  it("skips locals, parameters, type parameters and self-references", () => {
    const g = buildGraph({
      documents: [
        doc("src/a.ts", [
          def(0, `${TS}\`a.ts\`/f().`, 9),
          def(1, `${TS}\`a.ts\`/f().(x)`),
          def(1, `${TS}\`a.ts\`/f().[T]`),
          def(2, "local 4"),
          ref(3, "local 4"),
          ref(4, `${TS}\`a.ts\`/f().`),
        ]),
      ],
    });
    assert.deepEqual(g.nodes.map((n) => n.name), ["src/a.ts", "f"]);
    assert.deepEqual(g.edges, []);
  });

  it("does not count an import as a use", () => {
    const g = buildGraph({
      documents: [
        doc("src/a.ts", [ref(0, `${TS}\`b.ts\`/leaf().`, ROLE.import)]),
        doc("src/b.ts", [def(0, `${TS}\`b.ts\`/leaf().`)]),
      ],
    });
    assert.deepEqual(g.edges, []);
  });

  it("keeps symbols that two crate roots define apart, by file", () => {
    // rust-analyzer names every integration-test root `crate/`, so two test
    // files that each define `helper` produce the same symbol.
    const helper = `${RS}helper().`;
    const g = buildGraph({
      documents: [
        doc("tests/one.rs", [def(0, helper), def(5, `${RS}one_test().`), ref(6, helper)]),
        doc("tests/two.rs", [def(0, helper), def(5, `${RS}two_test().`), ref(6, helper)]),
      ],
    });
    const helpers = g.nodes.filter((n) => n.name === "helper");
    assert.deepEqual(helpers.map((n) => n.file), ["tests/one.rs", "tests/two.rs"]);
    const byKey = new Map(g.nodes.map((n) => [n.key, n]));
    assert.deepEqual(
      g.edges.map((e) => `${byKey.get(e.src).file}:${byKey.get(e.src).name} -> ${byKey.get(e.dst).file}`).sort(),
      ["tests/one.rs:one_test -> tests/one.rs", "tests/two.rs:two_test -> tests/two.rs"],
    );
  });

  it("merges a document that two projects both indexed", () => {
    const a = doc("src/a.ts", [def(0, `${TS}\`a.ts\`/f().`)]);
    const g = buildGraph({ documents: [a, structuredClone(a)] });
    assert.equal(g.nodes.filter((n) => n.name === "f").length, 1);
  });

  it("makes an external node for a symbol defined outside the index", () => {
    const g = buildGraph({ documents: [doc("src/a.ts", [def(0, `${TS}\`a.ts\`/f().`), ref(1, "scip-typescript npm react 18.0.0 `index.d.ts`/useState().")])] });
    const ext = g.nodes.find((n) => n.kind === "external");
    assert.deepEqual([ext.name, ext.file, ext.line], ["useState", null, null]);
    assert.deepEqual(arrows(g), ["f -> useState"]);
  });

  it("drops excluded documents but keeps references into them as external", () => {
    const vendored = `${TS}\`vendor.ts\`/lib().`;
    const g = buildGraph({
      documents: [doc("vendor/v.ts", [def(0, vendored), ref(1, `${TS}\`a.ts\`/f().`)]), doc("src/a.ts", [def(0, `${TS}\`a.ts\`/f().`), ref(1, vendored)])],
      exclude: (path) => path.startsWith("vendor/"),
    });
    assert.deepEqual(arrows(g), ["f -> lib"]);
    assert.equal(g.nodes.find((n) => n.name === "lib").kind, "external");
    assert.equal(g.nodes.some((n) => n.file === "vendor/v.ts"), false);
  });

  it("marks test code: test files and Rust `tests` modules", () => {
    const g = buildGraph({
      documents: [
        doc("src/a.test.ts", [def(0, `${TS}\`a.test.ts\`/case().`)]),
        doc("src/lib.rs", [def(0, `${RS}ink/tests/case().`), def(5, `${RS}ink/real().`)]),
      ],
      isTest: (path) => path.includes(".test."),
    });
    const flag = Object.fromEntries(g.nodes.filter((n) => n.kind !== "file").map((n) => [`${n.file}:${n.name}`, n.test]));
    assert.deepEqual(flag, { "src/a.test.ts:case": true, "src/lib.rs:case": true, "src/lib.rs:real": false });
  });

  it("links an implementation to what it implements", () => {
    const iface = `${TS}\`a.ts\`/Store#get().`;
    const impl = `${TS}\`a.ts\`/MemStore#get().`;
    const g = buildGraph({
      documents: [
        doc("src/a.ts", [def(0, iface), def(5, impl)], [{ symbol: impl, kind: 0, name: "", relationships: [{ symbol: iface, implementation: true, reference: false }] }]),
      ],
    });
    assert.deepEqual(arrows(g, "impl"), ["get -> get"]);
    const [edge] = g.edges;
    assert.equal(g.nodes.find((n) => n.key === edge.dst).symbol, impl);
  });

  it("links a TS reference to a Rust function across the language gap", () => {
    const g = buildGraph({
      documents: [
        doc("web/use.ts", [def(0, `${TS}\`use.ts\`/draw().`, 4), ref(2, "scip-typescript npm @app/wasm 0.1.0 pkg/`app.d.ts`/tangentAt().")]),
        doc("web/ipc.ts", [def(0, `${TS}\`ipc.ts\`/save().`, 4)]),
        doc("crates/wasm/src/lib.rs", [def(9, `${RS}tangent_at_js().`)]),
        doc("shell/src/cmd.rs", [def(20, `${RS}save_note().`)]),
      ],
      links: [
        { via: "wasm", package: "@app/wasm", name: "tangentAt", to: { file: "crates/wasm/src/lib.rs", line: 10 } },
        { via: "tauri", from: { file: "web/ipc.ts", line: 3 }, to: { file: "shell/src/cmd.rs", line: 21 }, name: "save_note" },
      ],
    });
    assert.deepEqual(arrows(g, "wasm"), ["tangentAt -> tangent_at_js"]);
    assert.deepEqual(arrows(g, "tauri"), ["save -> save_note"]);
    assert.deepEqual(g.missing, []);
  });

  it("links from the package declaration when its .d.ts is indexed", () => {
    const decl = "scip-typescript npm @app/wasm 0.1.0 pkg/`app.d.ts`/tangentAt().";
    const g = buildGraph({
      documents: [doc("pkg/app.d.ts", [def(0, decl)]), doc("web/use.ts", [def(0, `${TS}\`use.ts\`/draw().`, 4), ref(2, decl)]), doc("lib.rs", [def(9, `${RS}tangent_at_js().`)])],
      links: [{ via: "wasm", package: "@app/wasm", name: "tangentAt", to: { file: "lib.rs", line: 10 } }],
    });
    assert.deepEqual(arrows(g), ["draw -> tangentAt", "tangentAt -> tangent_at_js"]);
    assert.equal(g.nodes.find((n) => n.name === "tangentAt").file, "pkg/app.d.ts");
  });

  it("reports a link whose Rust end it cannot find", () => {
    const g = buildGraph({
      documents: [doc("web/ipc.ts", [def(0, `${TS}\`ipc.ts\`/save().`, 4)])],
      links: [{ via: "tauri", from: { file: "web/ipc.ts", line: 3 }, to: null, name: "gone" }],
    });
    assert.deepEqual(g.missing, [{ via: "tauri", name: "gone", file: "web/ipc.ts", line: 3 }]);
  });
});
