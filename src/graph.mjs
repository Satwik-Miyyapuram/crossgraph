/**
 * Turn SCIP documents into a symbol graph: one node per definition, one edge
 * per use, attributed to the innermost definition the use sits in.
 *
 * Indexers stop at their language's edge. `links` bridge it: each one says a
 * TS symbol or line reaches a Rust function, and becomes an edge like any
 * other, so callers and paths cross the gap.
 */

import { ROLE } from "./scip.mjs";

const LANG = { "scip-typescript": "ts", "rust-analyzer": "rust" };

/**
 * @param {{
 *   documents: { path: string, occurrences: object[], symbols: object[] }[],
 *   links?: object[],
 *   isTest?: (path: string) => boolean,
 *   exclude?: (path: string) => boolean,
 * }} input
 */
export function buildGraph({ documents, links = [], isTest = () => false, exclude = () => false }) {
  const docs = uniqueDocuments(documents.filter((d) => !exclude(d.path)));

  // Where each symbol is defined. A symbol defined in more than one file is
  // ambiguous (rust-analyzer names every test crate root `crate/`), so its
  // nodes are keyed by file as well.
  const defsOf = new Map();
  for (const d of docs) {
    for (const occ of d.occurrences) {
      if (!(occ.roles & ROLE.definition) || !isNode(occ.symbol)) continue;
      const seen = defsOf.get(occ.symbol) ?? new Set();
      seen.add(d.path);
      defsOf.set(occ.symbol, seen);
    }
  }
  const keyOf = (symbol, file) => (defsOf.get(symbol)?.size > 1 ? `${symbol} @${file}` : symbol);

  const nodes = new Map();
  const add = (node) => {
    if (!nodes.has(node.key)) nodes.set(node.key, node);
    return node.key;
  };
  const external = (symbol) => add({ key: symbol, symbol, name: nameOf(symbol), lang: langOf(symbol), file: null, line: null, kind: "external", test: false });

  // Definitions, and the bodies a use can sit in, per document.
  const containers = new Map();
  for (const d of docs) {
    const fileKey = add({ key: `file:${d.path}`, symbol: null, name: d.path, lang: null, file: d.path, line: null, kind: "file", test: isTest(d.path) });
    const bodies = [];
    for (const occ of d.occurrences) {
      if (!(occ.roles & ROLE.definition) || !isNode(occ.symbol)) continue;
      const key = add({
        key: keyOf(occ.symbol, d.path),
        symbol: occ.symbol,
        name: nameOf(occ.symbol),
        lang: langOf(occ.symbol),
        file: d.path,
        line: occ.range[0] + 1,
        kind: kindOf(occ.symbol),
        test: isTest(d.path) || inTestModule(occ.symbol),
      });
      if (occ.enclosing) bodies.push({ key, range: occ.enclosing });
    }
    nodes.get(fileKey).lang = [...nodes.values()].find((n) => n.file === d.path && n.lang)?.lang ?? null;
    containers.set(d.path, { fileKey, bodies });
  }

  /** The innermost definition around a position, else the file itself. */
  const around = (file, line, char) => {
    const { fileKey, bodies } = containers.get(file);
    let best = null;
    for (const b of bodies) {
      if (!contains(b.range, line, char)) continue;
      if (!best || contains(best.range, b.range[0], b.range[1])) best = b;
    }
    return best?.key ?? fileKey;
  };

  const edges = [];
  const edge = (src, dst, file, line, via) => {
    if (src !== dst) edges.push({ src, dst, file, line, via });
  };

  for (const d of docs) {
    for (const occ of d.occurrences) {
      if (occ.roles & (ROLE.definition | ROLE.import) || !isNode(occ.symbol)) continue;
      const src = around(d.path, occ.range[0], occ.range[1]);
      for (const dst of targets(occ.symbol, d.path)) edge(src, dst, d.path, occ.range[0] + 1, "ref");
    }
    for (const sym of d.symbols) {
      for (const rel of sym.relationships ?? []) {
        if (!(rel.implementation || rel.reference) || !isNode(rel.symbol) || !defsOf.has(sym.symbol)) continue;
        for (const dst of targets(sym.symbol, d.path)) {
          for (const src of targets(rel.symbol, d.path)) edge(src, dst, d.path, nodes.get(dst).line, "impl");
        }
      }
    }
  }

  /** Node keys a use of `symbol` in `file` points at. */
  function targets(symbol, file) {
    const files = defsOf.get(symbol);
    if (!files) return [external(symbol)];
    if (files.size === 1) return [symbol];
    return files.has(file) ? [keyOf(symbol, file)] : [...files].map((f) => keyOf(symbol, f));
  }

  const missing = [];
  for (const link of links) {
    const dst = link.to && rustDefinitionAt(docs, link.to);
    const target = dst && keyOf(dst, link.to.file);
    if (link.via === "wasm" || link.package) {
      // Every TS symbol that names this export of the package.
      const prefix = ` ${link.package} `;
      const uses = new Set();
      for (const d of docs) {
        for (const occ of d.occurrences) {
          if (occ.symbol.includes(prefix) && nameOf(occ.symbol) === link.name) uses.add(occ.symbol);
        }
      }
      if (!target) {
        if (uses.size) missing.push({ via: link.via, name: link.name, file: link.to?.file ?? null, line: link.to?.line ?? null });
        continue;
      }
      // The package's .d.ts may be indexed too; then its declaration is the node.
      for (const symbol of uses) edge(targets(symbol, null)[0], target, link.to.file, link.to.line, link.via);
    } else {
      if (!target || !containers.has(link.from.file)) {
        // Tests invoke commands their fakes answer; only app code can miss one.
        if (!isTest(link.from.file)) missing.push({ via: link.via, name: link.name, file: link.from.file, line: link.from.line });
        continue;
      }
      edge(around(link.from.file, link.from.line - 1, Number.MAX_SAFE_INTEGER), target, link.from.file, link.from.line, link.via);
    }
  }

  return { nodes: [...nodes.values()], edges, missing };
}

/** The function a Rust attribute scan found at a 1-based line, as a symbol. */
function rustDefinitionAt(docs, { file, line }) {
  const doc = docs.find((d) => d.path === file);
  const occ = doc?.occurrences.find((o) => o.roles & ROLE.definition && o.range[0] === line - 1 && o.symbol.endsWith(").") && isNode(o.symbol));
  return occ?.symbol ?? null;
}

/** One document per path; overlapping projects index some files twice. */
function uniqueDocuments(documents) {
  const byPath = new Map();
  for (const d of documents) if (!byPath.has(d.path)) byPath.set(d.path, d);
  return [...byPath.values()];
}

function contains([sl, sc, el, ec], line, char) {
  if (line < sl || line > el) return false;
  if (line === sl && char < sc) return false;
  if (line === el && char > ec) return false;
  return true;
}

/** Locals, parameters and type parameters are not nodes. */
const isNode = (symbol) => Boolean(symbol) && !symbol.startsWith("local ") && !symbol.endsWith(")") && !symbol.endsWith("]");

/** The descriptors: what follows `scheme manager package version`. */
function descriptors(symbol) {
  let rest = symbol;
  for (let i = 0; i < 4; i++) {
    const space = rest.indexOf(" ");
    if (space < 0) return symbol;
    rest = rest.slice(space + 1);
  }
  return rest;
}

const LAST = /(`(?:[^`]|``)+`|[^/#.:!`()[\]]+)(\([^)]*\))?([./#:!])$/;

export function nameOf(symbol) {
  const match = LAST.exec(descriptors(symbol));
  return match ? match[1].replace(/^`|`$/g, "") : symbol;
}

function kindOf(symbol) {
  const match = LAST.exec(descriptors(symbol));
  if (!match) return "other";
  if (match[2] !== undefined) return "function";
  return { "#": "type", ".": "term", ":": "term", "/": "namespace", "!": "macro" }[match[3]];
}

const langOf = (symbol) => {
  const scheme = symbol.slice(0, symbol.indexOf(" "));
  return LANG[scheme] ?? scheme;
};

/** A Rust `mod tests` (or `mod test`) inside a source file. */
const inTestModule = (symbol) => /(^|\/)tests?\//.test(descriptors(symbol));
