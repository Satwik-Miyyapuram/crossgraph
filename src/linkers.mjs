/**
 * Find the calls that cross from TS into Rust. Indexers cannot see them: a
 * wasm-bindgen export is renamed by an attribute, and a Tauri command is
 * called by a string. Each finder reads source text and returns plain links
 * for `buildGraph`.
 */

const FN = /^(pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern\s+"[^"]*")\s+)*fn\s+([A-Za-z_]\w*)/;
const IMPL = /^(?:unsafe\s+)?impl\b(?:\s*<[^{]*?>)?\s+(?:[^{]*\bfor\s+)?(?:\w+::)*([A-Za-z_]\w*)/;
const EXTERN = /^(?:unsafe\s+)?extern\s+"[^"]*"\s*(?:\{|$)/;
const MOD = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/;
const MACRO = /^macro_rules!\s*\w+\s*\{/;
const TEST = /^#\[(?:(?:\w+::)*test\b|cfg\(test\))/;
const SERDE_FN = /\b(?:default|skip_serializing_if|serialize_with|deserialize_with)\s*=\s*"(?:\w+::)*(\w+)"/g;
const SERDE = "#[serde(";
const newBraces = () => ({ depth: 0, comment: false, string: false, raw: null });
const inText = (state) => state.comment || state.string || state.raw !== null;

/**
 * Every `fn` in Rust source, with the outer attributes stacked above it and
 * the `impl` or `extern` block it sits directly in. Comments and blank lines
 * may sit between attributes and their item; any other item clears the stack.
 * @param {string} text
 * @returns {{ name: string, line: number, pub: boolean, attrs: string[],
 *   block: { kind: "impl" | "extern", name: string | null, attrs: string[] } | null }[]}
 */
export function attributedFunctions(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const blocks = [];
  const braces = newBraces();
  let attrs = [];
  // An impl or extern header whose `{` is on a later line, after a `where`.
  let pending = null;
  for (let i = 0; i < lines.length; i++) {
    let rest = lines[i].trim();
    while (rest.startsWith("#[")) {
      const [attr, endLine, after] = readAttribute(lines, i, lines[i].indexOf("#["));
      attrs.push(attr);
      i = endLine;
      rest = after.trim();
    }
    const depth = braces.depth;
    const skipped = inText(braces);
    countBraces(rest, braces);
    while (blocks.length && braces.depth <= blocks.at(-1).depth) blocks.pop();
    if (pending && braces.depth > pending.depth) (blocks.push(pending), (pending = null));
    if (skipped || rest === "" || rest.startsWith("//") || rest.startsWith("/*")) continue;
    const top = blocks.at(-1);
    const block = top && top.depth === depth - 1 ? top.block : null;
    const fn = FN.exec(rest);
    const impl = !fn && IMPL.exec(rest);
    if (fn) out.push({ name: fn[2], line: i + 1, pub: fn[1]?.trim() === "pub", attrs, block });
    else if (impl || EXTERN.test(rest)) {
      const opened = { depth, block: { kind: impl ? "impl" : "extern", name: impl ? impl[1] : null, attrs } };
      if (braces.depth > depth) blocks.push(opened);
      // Not `impl Trait` in a parameter list or a return type.
      else if (!/[,;)]$/.test(rest)) pending = opened;
    }
    attrs = [];
  }
  return out;
}

/** `mod` and `macro_rules!` blocks in Rust source, with their attributes and first and last lines. */
function rustBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const open = [];
  const braces = newBraces();
  let attrs = [];
  for (let i = 0; i < lines.length; i++) {
    let rest = lines[i].trim();
    while (rest.startsWith("#[")) {
      const [attr, endLine, after] = readAttribute(lines, i, lines[i].indexOf("#["));
      attrs.push(attr);
      i = endLine;
      rest = after.trim();
    }
    const depth = braces.depth;
    const skipped = inText(braces);
    countBraces(rest, braces);
    while (open.length && braces.depth <= open.at(-1).depth) open.pop().end = i + 1;
    if (skipped || rest === "" || rest.startsWith("//") || rest.startsWith("/*")) continue;
    const kind = MOD.test(rest) ? "mod" : MACRO.test(rest) ? "macro" : null;
    if (kind && braces.depth > depth) {
      const block = { kind, line: i + 1, end: lines.length, attrs, depth };
      out.push(block);
      open.push(block);
    }
    attrs = [];
  }
  return out;
}

/**
 * Track `{` `}` nesting through a line, skipping strings, raw strings, chars
 * and comments. A string or block comment left open carries to the next line.
 */
function countBraces(s, state) {
  for (let c = 0; c < s.length; c++) {
    const ch = s[c];
    if (state.raw !== null) {
      if (ch === '"' && s.startsWith("#".repeat(state.raw), c + 1)) (c += state.raw), (state.raw = null);
    } else if (state.string) {
      if (ch === "\\") c++;
      else if (ch === '"') state.string = false;
    } else if (state.comment) {
      if (ch === "*" && s[c + 1] === "/") (state.comment = false), c++;
    } else if (ch === "/" && s[c + 1] === "/") return;
    else if (ch === "/" && s[c + 1] === "*") (state.comment = true), c++;
    else if (ch === '"') state.string = true;
    else if ((ch === "r" || ch === "b") && !/\w/.test(s[c - 1] ?? "") && /^b?r#*"/.test(s.slice(c))) {
      const open = /^b?r(#*)"/.exec(s.slice(c));
      state.raw = open[1].length;
      c += open[0].length - 1;
    } else if (ch === "'") {
      // A char literal; a lifetime such as 'a has no closing quote.
      if (s[c + 1] === "\\") c = s.indexOf("'", c + 2);
      else if (s[c + 2] === "'") c += 2;
    } else if (ch === "{") state.depth++;
    else if (ch === "}") state.depth--;
  }
}

/** The attribute starting at `lines[i][col]`, its last line and what follows it. */
function readAttribute(lines, i, col) {
  let depth = 0;
  let quoted = false;
  let text = "";
  for (let line = i; line < lines.length; line++) {
    const s = lines[line];
    for (let c = line === i ? col : 0; c < s.length; c++) {
      const ch = s[c];
      text += ch;
      if (quoted) {
        if (ch === "\\") text += s[++c] ?? "";
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) return [text, line, s.slice(c + 1)];
    }
    text += "\n";
  }
  return [text, lines.length - 1, ""];
}

const bindgen = (attrs) => attrs.find((a) => /^#\[wasm_bindgen\b/.test(a));
const option = (attr, key) => (attr ? new RegExp(String.raw`\b${key}\s*=\s*"?([\w$]+)"?`).exec(attr)?.[1] : undefined);
const flag = (attr, key) => Boolean(attr) && new RegExp(String.raw`[(,]\s*${key}\s*[,)]`).test(attr);

/**
 * One link per function wasm-bindgen exports: the name JS sees and where the
 * Rust function is. A free function is exported by its own attribute; a
 * method by a `pub` in a `#[wasm_bindgen] impl`, and its link names the JS
 * class as `owner`. A constructor links the class itself. Functions in an
 * `extern` block are imports from JS, not exports.
 * @param {{ path: string, text: string }[]} files
 * @param {string} pkg the npm package the bindings are published as
 */
export function wasmLinks(files, pkg) {
  const links = [];
  for (const { path, text } of files) {
    for (const fn of attributedFunctions(text)) {
      const attr = bindgen(fn.attrs);
      const to = { file: path, line: fn.line };
      if (!fn.block) {
        if (attr) links.push({ via: "wasm", package: pkg, name: option(attr, "js_name") ?? fn.name, to });
        continue;
      }
      const block = bindgen(fn.block.attrs);
      if (fn.block.kind !== "impl" || !block || !fn.pub || flag(attr, "skip")) continue;
      const owner = option(block, "js_class") ?? fn.block.name;
      if (flag(attr, "constructor")) {
        links.push({ via: "wasm", package: pkg, name: owner, to });
        continue;
      }
      const name =
        option(attr, "getter") ??
        option(attr, "setter") ??
        option(attr, "js_name") ??
        (flag(attr, "setter") ? fn.name.replace(/^set_/, "") : fn.name);
      links.push({ via: "wasm", package: pkg, owner, name, to });
    }
  }
  return links;
}

/**
 * Indexed TS files that import `pkg` yet name none of its symbols: the import
 * did not resolve, so every use of it is missing from the graph.
 * @param {{ path: string, occurrences: { symbol: string }[] }[]} documents
 * @param {{ path: string, text: string }[]} files
 * @param {string} pkg
 */
export function unresolvedImports(documents, files, pkg) {
  const quoted = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `import "pkg"` alone runs the module for its effects and names nothing.
  const imports = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*)["']${quoted}["']`);
  const byPath = new Map(documents.map((d) => [d.path, d]));
  return files
    .filter((f) => imports.test(f.text) && byPath.has(f.path))
    .filter((f) => !byPath.get(f.path).occurrences.some((o) => o.symbol.includes(` ${pkg} `)))
    .map((f) => f.path);
}

/**
 * Links from each TS invoke of a command name to its `#[tauri::command]`, and
 * the commands nothing invokes.
 * @param {{ path: string, text: string }[]} rustFiles
 * @param {{ path: string, text: string }[]} tsFiles
 * @param {string[]} invokers function names that take the command name first
 */
export function tauriLinks(rustFiles, tsFiles, invokers) {
  const commands = new Map();
  for (const { path, text } of rustFiles) {
    for (const fn of attributedFunctions(text)) {
      if (fn.attrs.some((a) => /^#\[tauri::command\b/.test(a)) && !commands.has(fn.name)) {
        commands.set(fn.name, { file: path, line: fn.line });
      }
    }
  }
  const names = invokers.map((n) => n.replace(/[$]/g, "\\$&")).join("|");
  const call = new RegExp(String.raw`(?<![\w$])(?:${names})\s*(?:<[^>()]*>)?\s*\(\s*(["'` + "`" + String.raw`])([\w:-]+)\1`, "g");
  const links = [];
  const used = new Set();
  for (const { path, text } of tsFiles) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(call)) {
        const name = m[2];
        used.add(name);
        links.push({ via: "tauri", name, from: { file: path, line: i + 1 }, to: commands.get(name) ?? null });
      }
    });
  }
  const unlinked = [...commands].filter(([name]) => !used.has(name)).map(([name, at]) => ({ via: "tauri", name, ...at }));
  return { links, unlinked };
}

/**
 * Each Cargo package's Rust name (`-` as `_`) mapped to its directory, from
 * the `name` in its `[package]` table.
 * @param {{ path: string, text: string }[]} tomls
 */
export function crateDirs(tomls) {
  const dirs = new Map();
  for (const { path, text } of tomls) {
    if (!/(^|\/)Cargo\.toml$/.test(path)) continue;
    const pkg = /^\[package\](?:(?!^\s*\[)[\s\S])*?^\s*name\s*=\s*["']([^"']+)["']/m.exec(text);
    if (pkg) dirs.set(pkg[1].replaceAll("-", "_"), path.slice(0, -"Cargo.toml".length));
  }
  return dirs;
}

const CFG = /^\s*#\[cfg\(/;
const PATH_CALL = /(?<![\w:])(\w+)((?:::\w+)*)::(\w+)\s*\(/g;

/**
 * The lines of the item or statement whose attributes start at `lines[line]`
 * with `rest`: through its closing brace, `;` or `,`, or the end of the block
 * around it.
 */
function itemAfter(lines, line, rest) {
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("#[")) [, line, rest] = readAttribute(lines, line, lines[line].length - rest.length);
    else if (rest === "" || rest.startsWith("//")) {
      if (++line >= lines.length) return null;
      rest = lines[line];
    } else break;
  }
  const from = line;
  const braces = newBraces();
  for (;;) {
    countBraces(rest, braces);
    if (braces.depth < 0 || (braces.depth === 0 && !inText(braces) && /[;,}]$/.test(rest.trimEnd()))) return { from, to: line };
    if (++line >= lines.length) return { from, to: line - 1 };
    rest = lines[line];
  }
}

/**
 * Uses of Rust functions no indexer records, and test code no path names.
 * A `#[serde(...)]` attribute names a function by string (`default = "yes"`);
 * it links to the functions of that name in its file, else to every one so
 * named. A `macro_rules!` body links to the functions of its file it calls.
 * An item or statement under `#[cfg(...)]` links its `some_crate::f()` and
 * `some_crate::module::f()` calls into the workspace crates in `crates` (see
 * `crateDirs`), since rust-analyzer skips code whose cfg is off.
 * `tests` are the lines of `#[test]` functions and `#[cfg(test)]` modules.
 * @param {{ path: string, text: string }[]} files
 * @param {Map<string, string>} [crates]
 */
export function rustLinks(files, crates = new Map()) {
  // Per file, each free function name and every line one so named is on.
  const free = new Map();
  for (const { path, text } of files) {
    const fns = new Map();
    for (const f of attributedFunctions(text)) if (!f.block) fns.set(f.name, [...(fns.get(f.name) ?? []), f.line]);
    free.set(path, fns);
  }
  const links = [];
  const tests = [];
  for (const { path, text } of files) {
    const mine = free.get(path);
    for (const fn of attributedFunctions(text)) {
      if (fn.attrs.some((a) => TEST.test(a))) tests.push({ file: path, from: fn.line, to: fn.line });
    }
    const lines = text.split(/\r?\n/);
    for (const block of rustBlocks(text)) {
      if (block.kind === "mod" && block.attrs.some((a) => TEST.test(a))) tests.push({ file: path, from: block.line, to: block.end });
      if (block.kind !== "macro") continue;
      const body = lines.slice(block.line, block.end).join("\n");
      for (const [name, at] of mine) {
        if (!new RegExp(String.raw`(?<![.\w])${name}\s*\(`).test(body)) continue;
        for (const line of at) links.push({ via: "macro", name, from: { file: path, line: block.line }, to: { file: path, line } });
      }
    }
    for (let i = 0; i < lines.length; i++) {
      for (let col = lines[i].indexOf(SERDE); col >= 0; col = lines[i].indexOf(SERDE, col + 1)) {
        const [attr] = readAttribute(lines, i, col);
        for (const m of attr.matchAll(SERDE_FN)) {
          const name = m[1];
          const at = mine.has(name) ? [[path, mine]] : [...free].filter(([, fns]) => fns.has(name));
          for (const [file, fns] of at) {
            for (const line of fns.get(name)) links.push({ via: "serde", name, from: { file: path, line: i + 1 }, to: { file, line } });
          }
        }
      }
    }
    for (let i = 0; i < lines.length; i++) {
      if (!CFG.test(lines[i])) continue;
      const [, end, after] = readAttribute(lines, i, lines[i].indexOf("#["));
      const item = itemAfter(lines, end, after);
      if (!item) break;
      for (let at = item.from; at <= item.to; at++) {
        for (const m of lines[at].matchAll(PATH_CALL)) {
          const [, crate, modules, name] = m;
          const dir = crates.get(crate);
          // `crate::Type::f(` calls an associated function, not a free one.
          if (dir === undefined || /::[A-Z]/.test(modules)) continue;
          for (const [file, fns] of free) {
            if (!file.startsWith(dir) || !fns.has(name)) continue;
            for (const line of fns.get(name)) links.push({ via: "cfg", name, from: { file: path, line: at + 1 }, to: { file, line } });
          }
        }
      }
      // A cfg inside the item is covered by this one.
      i = item.to;
    }
  }
  tests.sort((a, b) => a.file.localeCompare(b.file) || a.from - b.from);
  return { links, tests };
}
