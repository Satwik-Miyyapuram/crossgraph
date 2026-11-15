import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generatedProjects, loadConfig } from "../src/config.mjs";

function repo(config) {
  const root = mkdtempSync(join(tmpdir(), "crossgraph-"));
  if (config) writeFileSync(join(root, "crossgraph.config.json"), JSON.stringify(config));
  return root;
}

describe("loadConfig", () => {
  it("fills defaults and builds path matchers", () => {
    const config = loadConfig(repo({ exclude: ["vendor/**"], tests: ["**/*.test.ts"], entries: ["app/**/page.tsx"] }));
    assert.equal(config.out, ".crossgraph");
    assert.deepEqual(config.ts.projects, []);
    assert.equal(config.rust, null);
    assert.equal(config.isExcluded("vendor/x/y.ts"), true);
    assert.equal(config.isExcluded("src/y.ts"), false);
    assert.equal(config.isTest("src/a.test.ts"), true);
    assert.equal(config.isTest("a.test.ts"), true);
    assert.equal(config.isEntry("app/notes/page.tsx"), true);
    assert.equal(config.isEntry("app/notes/view.tsx"), false);
  });

  it("says which file is missing", () => {
    assert.throws(() => loadConfig(repo()), /crossgraph\.config\.json/);
  });
});

describe("generatedProjects", () => {
  it("writes each extra project as a tsconfig with absolute paths", () => {
    const root = repo({
      ts: { extraProjects: [{ name: "scripts", extends: "tsconfig.base.json", compilerOptions: { allowJs: true }, include: ["scripts/**/*"] }] },
    });
    const config = loadConfig(root);
    const [path] = generatedProjects(config);
    assert.equal(path, join(root, ".crossgraph", "tsconfig.scripts.json"));
    const written = JSON.parse(readFileSync(path, "utf8"));
    const abs = (p) => join(root, p).replaceAll("\\", "/");
    assert.deepEqual(written, {
      extends: abs("tsconfig.base.json"),
      compilerOptions: { allowJs: true, noEmit: true },
      include: [abs("scripts/**/*")],
      // A base that excludes tests must not drop the files this project is for.
      exclude: [],
    });
  });
});
