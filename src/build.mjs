/**
 * Index a repository and write its graph: run the SCIP indexers, find the
 * TS-to-Rust links in source, join them, store the result.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { generatedProjects, loadConfig } from "./config.mjs";
import { buildGraph } from "./graph.mjs";
import { tauriLinks, wasmLinks } from "./linkers.mjs";
import { readScip } from "./scip.mjs";
import { writeDb } from "./store.mjs";

const TS_INDEXER = "@sourcegraph/scip-typescript@0.6.2";
const SKIP_DIRS = new Set(["node_modules", "target", ".git"]);

/**
 * @param {string} root repository root holding crossgraph.config.json
 * @param {{ index?: boolean, log?: (line: string) => void }} [options]
 *   `index: false` reuses the .scip files of the last run
 */
export function build(root, { index = true, log = () => {} } = {}) {
  const config = loadConfig(root);
  // Without generated code, imports of it do not resolve and what they reach looks dead.
  const absent = config.requires.filter((r) => !existsSync(join(root, r.path)));
  if (absent.length) {
    throw new Error(`crossgraph: generate these first:\n${absent.map((r) => `  ${r.path}${r.hint ? ` (${r.hint})` : ""}`).join("\n")}`);
  }
  const out = join(root, config.out);
  mkdirSync(out, { recursive: true });
  const tsScip = join(out, "ts.scip");
  const rustScip = join(out, "rust.scip");

  if (index) {
    const projects = [...config.ts.projects.map((p) => join(root, p)), ...generatedProjects(config)];
    if (projects.length) {
      log(`indexing TypeScript (${projects.length} projects)`);
      run("npx", ["--yes", config.ts.indexer ?? TS_INDEXER, "index", "--cwd", root, "--output", tsScip, ...projects], root);
    }
    if (config.rust) {
      log("indexing Rust");
      run("rust-analyzer", ["scip", join(root, config.rust.root ?? "."), "--output", rustScip], root);
    }
  }

  const documents = [];
  if (existsSync(tsScip)) documents.push(...readScip(readFileSync(tsScip)).documents);
  if (config.rust && existsSync(rustScip)) {
    // rust-analyzer writes paths relative to the Cargo root.
    const prefix = config.rust.root && config.rust.root !== "." ? `${config.rust.root.replace(/\/$/, "")}/` : "";
    for (const d of readScip(readFileSync(rustScip)).documents) documents.push({ ...d, path: prefix + d.path });
  }

  const sources = (dirs, exts) => dirs.flatMap((dir) => readSources(root, dir, exts, config.isExcluded));
  const links = config.wasm.flatMap((w) => wasmLinks(sources([w.crate], [".rs"]), w.package));
  let unlinked = [];
  if (config.tauri) {
    const tauri = tauriLinks(sources([config.tauri.commands], [".rs"]), sources(config.tauri.callers ?? ["."], [".ts", ".tsx", ".js", ".mjs"]), config.tauri.invoke ?? ["invoke"]);
    links.push(...tauri.links);
    unlinked = tauri.unlinked;
  }

  log("building graph");
  const graph = buildGraph({ documents, links, isTest: config.isTest, exclude: config.isExcluded });
  const db = join(out, "graph.db");
  writeDb(db, { ...graph, unlinked }, { isEntry: config.isEntry });
  return { db, nodes: graph.nodes.length, edges: graph.edges.length, links: links.length, missing: graph.missing.length, unlinked: unlinked.length };
}

function run(cmd, args, cwd) {
  // Windows runs npx through a .cmd shim, which needs a shell and one quoted line.
  const options = { cwd, stdio: ["ignore", "inherit", "inherit"] };
  const result =
    process.platform === "win32"
      ? spawnSync([cmd, ...args.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a))].join(" "), { ...options, shell: true })
      : spawnSync(cmd, args, options);
  if (result.status !== 0) throw new Error(`crossgraph: ${cmd} exited with ${result.status ?? result.error}`);
}

/** Source files under a repo-relative dir, as repo-relative posix paths. */
function readSources(root, dir, exts, isExcluded) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(abs, entry.name);
      const path = relative(root, full).replaceAll("\\", "/");
      if (isExcluded(path)) continue;
      if (entry.isDirectory()) walk(full);
      else if (exts.includes(extname(entry.name))) out.push({ path, text: readFileSync(full, "utf8") });
    }
  };
  walk(join(root, dir));
  return out;
}
