#!/usr/bin/env node
/**
 * crossgraph: one code graph across TypeScript and Rust.
 * Run from a repository holding crossgraph.config.json.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compare, findings } from "../src/baseline.mjs";
import { build } from "../src/build.mjs";
import { loadConfig } from "../src/config.mjs";
import { callees, callers, dead, find, missing, openDb, path, testOnly, unlinked } from "../src/query.mjs";

const HELP = `usage: crossgraph <command> [args] [--json]

  build [--no-index]     index the repo and write <out>/graph.db
  find NAME              definitions called NAME (or FILE:NAME)
  callers NAME           what uses NAME
  callees NAME           what NAME uses
  path FROM TO           shortest chain of uses from FROM to TO
  dead                   definitions nothing outside tests uses
  test-only              definitions only tests use
  missing                TS-to-Rust calls with no Rust end
  unlinked               Rust commands nothing calls
  check [--update]       fail on findings not in crossgraph.baseline.json`;

const BASELINE = "crossgraph.baseline.json";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const [command, ...args] = argv.filter((a) => !a.startsWith("--"));
const root = process.cwd();

function print(rows) {
  if (json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log("(none)");
  for (const r of rows) {
    const where = r.at ? `${r.at}:${r.atLine}` : r.file ? `${r.file}:${r.line ?? ""}` : "(external)";
    const tags = [r.kind, r.via && r.via !== "ref" ? `via ${r.via}` : null, r.test ? "test" : null].filter(Boolean).join(", ");
    console.log(`${where}  ${r.name}${tags ? `  (${tags})` : ""}`);
  }
}

function db() {
  const file = join(root, loadConfig(root).out, "graph.db");
  if (!existsSync(file)) throw new Error("crossgraph: no graph yet; run `crossgraph build`");
  return openDb(file);
}

function need(n) {
  if (args.length < n) throw new Error(`crossgraph: ${command} takes ${n} argument${n > 1 ? "s" : ""}\n\n${HELP}`);
}

try {
  switch (command) {
    case "build": {
      const summary = build(root, { index: !argv.includes("--no-index"), log: (l) => console.error(`crossgraph: ${l}`) });
      console.log(json ? JSON.stringify(summary) : `${summary.nodes} nodes, ${summary.edges} edges, ${summary.links} links, ${summary.missing} missing, ${summary.unlinked} unlinked -> ${summary.db}`);
      break;
    }
    case "find": need(1); print(find(db(), args[0])); break;
    case "callers": need(1); print(callers(db(), args[0])); break;
    case "callees": need(1); print(callees(db(), args[0])); break;
    case "path": need(2); print(path(db(), args[0], args[1])); break;
    case "dead": print(dead(db())); break;
    case "test-only": print(testOnly(db())); break;
    case "missing": print(missing(db())); break;
    case "unlinked": print(unlinked(db())); break;
    case "check": {
      const file = join(root, BASELINE);
      const current = findings(db());
      if (argv.includes("--update")) {
        writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
        console.log(`crossgraph: baseline holds ${current.length} findings`);
        break;
      }
      const { added, fixed } = compare(current, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
      for (const k of added) console.log(`new: ${k}`);
      if (fixed.length) console.log(`crossgraph: ${fixed.length} baseline findings are gone; run \`crossgraph check --update\``);
      if (added.length) process.exitCode = 1;
      else console.log("crossgraph: no new findings");
      break;
    }
    default:
      console.log(HELP);
      if (command && command !== "help") process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
