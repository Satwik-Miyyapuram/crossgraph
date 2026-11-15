/**
 * Read `crossgraph.config.json` from a repository root. Paths in it are
 * relative to that root and use forward slashes; globs follow
 * `path.matchesGlob`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

export const CONFIG_FILE = "crossgraph.config.json";

export function loadConfig(root) {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`crossgraph: no ${CONFIG_FILE} in ${root}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const config = {
    root,
    out: raw.out ?? ".crossgraph",
    ts: { projects: raw.ts?.projects ?? [], extraProjects: raw.ts?.extraProjects ?? [], indexer: raw.ts?.indexer },
    rust: raw.rust ?? null,
    exclude: raw.exclude ?? [],
    tests: raw.tests ?? [],
    entries: raw.entries ?? [],
    wasm: raw.wasm ?? [],
    tauri: raw.tauri ?? null,
  };
  return {
    ...config,
    isExcluded: matcher(config.exclude),
    isTest: matcher(config.tests),
    isEntry: matcher(config.entries),
  };
}

/** `**\/x` also matches `x` at the root, as in .gitignore. */
function matcher(globs) {
  const all = globs.flatMap((g) => (g.startsWith("**/") ? [g, g.slice(3)] : [g]));
  return (path) => all.some((g) => matchesGlob(path, g));
}

/**
 * Write a tsconfig for each `ts.extraProjects` entry into the output dir, so
 * files no project of the repo covers (tests, scripts) get indexed too.
 * Returns their paths.
 */
export function generatedProjects(config) {
  const dir = join(config.root, config.out);
  mkdirSync(dir, { recursive: true });
  const abs = (p) => join(config.root, p).replaceAll("\\", "/");
  return config.ts.extraProjects.map((p) => {
    const tsconfig = {
      ...(p.extends ? { extends: abs(p.extends) } : {}),
      compilerOptions: { ...p.compilerOptions, noEmit: true },
      include: p.include.map(abs),
      exclude: [],
    };
    const path = join(dir, `tsconfig.${p.name}.json`);
    writeFileSync(path, `${JSON.stringify(tsconfig, null, 2)}\n`);
    return path;
  });
}
