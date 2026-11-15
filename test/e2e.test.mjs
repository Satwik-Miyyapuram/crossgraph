// Runs the real indexers on test/fixture/sample: a TS app calling a Rust
// crate through wasm-bindgen and Tauri. Needs rust-analyzer and network
// access for npx the first time.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { compare, findings } from "../src/baseline.mjs";
import { build } from "../src/build.mjs";
import { callers, dead, missing, openDb, path, testOnly, unlinked } from "../src/query.mjs";

const FIXTURE = join(import.meta.dirname, "fixture", "sample");
const hasRustAnalyzer = spawnSync("rust-analyzer", ["--version"]).status === 0;

describe("sample project", { skip: !hasRustAnalyzer && "rust-analyzer is not installed" }, () => {
  let db;
  before(() => {
    // rust-analyzer writes target/ next to the crate; keep the fixture clean.
    const root = mkdtempSync(join(tmpdir(), "crossgraph-e2e-"));
    cpSync(FIXTURE, root, { recursive: true });
    db = openDb(build(root).db);
  });

  const names = (rows) => rows.map((r) => r.name);

  it("follows a call from TS through wasm-bindgen into Rust", () => {
    assert.deepEqual(names(path(db, "draw", "tangent")), ["draw", "tangentAt", "tangent_at_js", "tangent"]);
  });

  it("links a Tauri invoke to its command", () => {
    assert.deepEqual(
      callers(db, "save_note").map((r) => [r.name, r.via]),
      [["save", "tauri"]],
    );
  });

  it("finds dead code in both languages, and code only tests use", () => {
    assert.deepEqual(names(dead(db)).sort(), ["idle_command", "orphan", "unused"]);
    assert.deepEqual(names(testOnly(db)), ["helper"]);
  });

  it("reports invokes with no command, and commands with no invoke", () => {
    assert.deepEqual(missing(db).map((m) => [m.name, m.file]), [["load_note", "web/ipc.ts"]]);
    assert.deepEqual(unlinked(db).map((u) => [u.name, u.file]), [["idle_command", "rust/src/lib.rs"]]);
  });

  it("passes a check against its own baseline", () => {
    assert.deepEqual(compare(findings(db), findings(db)).added, []);
  });
});
