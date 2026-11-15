/**
 * Find the calls that cross from TS into Rust. Indexers cannot see them: a
 * wasm-bindgen export is renamed by an attribute, and a Tauri command is
 * called by a string. Each finder reads source text and returns plain links
 * for `buildGraph`.
 */

const FN = /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern\s+"[^"]*")\s+)*fn\s+([A-Za-z_]\w*)/;

/**
 * Every `fn` in Rust source, with the outer attributes stacked above it.
 * Comments and blank lines may sit between them; any other item clears the
 * stack.
 * @param {string} text
 * @returns {{ name: string, line: number, attrs: string[] }[]}
 */
export function attributedFunctions(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let attrs = [];
  for (let i = 0; i < lines.length; i++) {
    let rest = lines[i].trim();
    while (rest.startsWith("#[")) {
      const [attr, endLine, after] = readAttribute(lines, i, lines[i].indexOf("#["));
      attrs.push(attr);
      i = endLine;
      rest = after.trim();
    }
    if (rest === "" || rest.startsWith("//")) continue;
    const fn = FN.exec(rest);
    if (fn) out.push({ name: fn[1], line: i + 1, attrs });
    attrs = [];
  }
  return out;
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

/**
 * One link per `#[wasm_bindgen]` function: the name JS sees (its `js_name`,
 * else the Rust name as written) and where the Rust function is.
 * @param {{ path: string, text: string }[]} files
 * @param {string} pkg the npm package the bindings are published as
 */
export function wasmLinks(files, pkg) {
  const links = [];
  for (const { path, text } of files) {
    for (const fn of attributedFunctions(text)) {
      const attr = fn.attrs.find((a) => /^#\[wasm_bindgen\b/.test(a));
      if (!attr) continue;
      const jsName = /\bjs_name\s*=\s*"?([\w$]+)"?/.exec(attr)?.[1];
      links.push({ via: "wasm", package: pkg, name: jsName ?? fn.name, to: { file: path, line: fn.line } });
    }
  }
  return links;
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
