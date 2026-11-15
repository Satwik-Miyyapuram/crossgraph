import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { build } from "../src/build.mjs";

function repo(config) {
  const root = mkdtempSync(join(tmpdir(), "crossgraph-build-"));
  writeFileSync(join(root, "crossgraph.config.json"), JSON.stringify(config));
  return root;
}

describe("build", () => {
  it("refuses to build while a required generated file is missing", () => {
    const root = repo({ requires: [{ path: "pkg/app.d.ts", hint: "npm run build:wasm" }] });
    assert.throws(() => build(root, { index: false }), /pkg\/app\.d\.ts.*npm run build:wasm/s);
  });

  it("builds once the required file exists", () => {
    const root = repo({ requires: [{ path: "pkg/app.d.ts", hint: "npm run build:wasm" }] });
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", "app.d.ts"), "");
    assert.equal(build(root, { index: false }).nodes, 0);
  });
});
