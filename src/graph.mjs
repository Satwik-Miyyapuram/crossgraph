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
 *   testLines?: { file: string, from: number, to: number }[],
 *   exclude?: (path: string) => boolean,
 * }} input
 */
export function buildGraph({ documents, links = [], isTest = () => false, testLines = [], exclude = () => false }) {
  const docs = uniqueDocuments(documents.filter((d) => !exclude(d.path)));
  // Test code a path cannot tell apart, such as a Rust `#[cfg(test)]` module.
  const testsIn = Map.groupBy(testLines, (t) => t.file);
  const onTestLine = (file, line) => testsIn.get(file)?.some((t) => t.from <= line && line <= t.to) ?? false;

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
        test: isTest(d.path) || inTestModule(occ.symbol) || onTestLine(d.path, occ.range[0] + 1),
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
          // Both ways: a call through the declaration reaches the implementation,
          // and the implementation needs the declaration to exist.
          for (const src of targets(rel.symbol, d.path)) {
            edge(src, dst, d.path, nodes.get(dst).line, "impl");
            edge(dst, src, d.path, nodes.get(dst).line, "impl");
          }
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

  // rust-analyzer emits no relationships, so a trait method and its impls are
  // linked by name: `impl#[Type][Trait]m().` implements `Trait#m().` in the same
  // crate. A same-named trait elsewhere in the crate links too, which can only
  // hide dead code, never invent it.
  const traitMethods = new Map();
  for (const n of nodes.values()) {
    if (n.lang !== "rust" || n.file === null || n.kind !== "function") continue;
    const m = /(?:^|\/)([^/#[\]`]+)#([^#/.()]+)\(\)\.$/.exec(descriptors(n.symbol));
    if (!m) continue;
    const key = `${crateOf(n.symbol)} ${m[1]} ${m[2]}`;
    traitMethods.has(key) ? traitMethods.get(key).push(n.key) : traitMethods.set(key, [n.key]);
  }
  for (const n of nodes.values()) {
    if (n.lang !== "rust" || n.file === null) continue;
    const m = /impl#\[[^\]]*\]\[`?([^\]`<]+)[^\]]*\]([^#/.()]+)\(\)\.$/.exec(n.symbol);
    for (const trait of (m && traitMethods.get(`${crateOf(n.symbol)} ${m[1]} ${m[2]}`)) ?? []) {
      edge(trait, n.key, n.file, n.line, "impl");
      edge(n.key, trait, n.file, n.line, "impl");
    }
  }

  // TS types match by shape: a call through an interface names the interface's
  // member, never the class whose instance it holds. Link each used member of a
  // type to the same member of every used class that has all the type's members.
  const used = new Set(edges.map((e) => e.dst));
  const shapes = new Map();
  for (const n of nodes.values()) {
    const owner = n.lang === "ts" && n.symbol && n.file !== null && n.name !== "<constructor>" && ownerOf(n.symbol);
    if (!owner || !nodes.has(keyOf(owner, n.file))) continue;
    const members = shapes.get(keyOf(owner, n.file)) ?? new Map();
    members.set(n.name, n.key);
    shapes.set(keyOf(owner, n.file), members);
  }
  const having = new Map();
  for (const [type, members] of shapes) {
    for (const name of members.keys()) having.has(name) ? having.get(name).push(type) : having.set(name, [type]);
  }
  for (const [type, members] of shapes) {
    const calls = [...members].filter(([, key]) => used.has(key));
    if (!calls.length) continue;
    const rarest = [...members.keys()].reduce((a, b) => (having.get(a).length <= having.get(b).length ? a : b));
    for (const other of having.get(rarest)) {
      const theirs = shapes.get(other);
      if (other === type || !used.has(other) || [...members.keys()].some((name) => !theirs.has(name))) continue;
      for (const [name, key] of calls) edge(key, theirs.get(name), nodes.get(theirs.get(name)).file, nodes.get(theirs.get(name)).line, "structural");
    }
  }

  const missing = [];
  for (const link of links) {
    const dst = link.to && rustDefinitionAt(docs, link.to);
    const target = dst && keyOf(dst, link.to.file);
    if (link.via === "wasm" || link.package) {
      // Every TS symbol that names this export of the package: a method of
      // the link's class, or a free name when the link has no class.
      const prefix = ` ${link.package} `;
      const uses = new Set();
      for (const d of docs) {
        for (const occ of d.occurrences) {
          if (!occ.symbol.includes(prefix) || nameOf(occ.symbol) !== link.name) continue;
          const parent = parentOf(occ.symbol);
          if (link.owner ? parent.endsWith(`/${link.owner}#`) : !parent.endsWith("#")) uses.add(occ.symbol);
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
        if (link.via === "tauri" && !isTest(link.from.file)) missing.push({ via: link.via, name: link.name, file: link.from.file, line: link.from.line });
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

/** `scheme manager package version`: the crate or package a symbol is in. */
const crateOf = (symbol) => symbol.slice(0, symbol.length - descriptors(symbol).length);

/** The descriptors before the last one; ends in `#` for a member of a type. */
function parentOf(symbol) {
  const match = LAST.exec(descriptors(symbol));
  return match ? descriptors(symbol).slice(0, match.index) : "";
}

/** The symbol of the type a member belongs to, or null if it is no member. */
function ownerOf(symbol) {
  const parent = parentOf(symbol);
  return parent.endsWith("#") ? symbol.slice(0, symbol.length - descriptors(symbol).length + parent.length) : null;
}

function kindOf(symbol) {
  const match = LAST.exec(descriptors(symbol));
  if (!match) return "other";
  if (match[2] !== undefined) return "function";
  // A type inside a type is a Rust enum variant: a member, like a field.
  if (match[3] === "#" && descriptors(symbol).slice(0, match.index).endsWith("#")) return "term";
  return { "#": "type", ".": "term", ":": "term", "/": "namespace", "!": "macro" }[match[3]];
}

const langOf = (symbol) => {
  const scheme = symbol.slice(0, symbol.indexOf(" "));
  return LANG[scheme] ?? scheme;
};

/** A Rust `mod tests` (or `mod test`) inside a source file. */
const inTestModule = (symbol) => /(^|\/)tests?\//.test(descriptors(symbol));
