import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributedFunctions, crateDirs, rustLinks, tauriLinks, unresolvedImports, wasmLinks } from "../src/linkers.mjs";

const lib = `//! #[wasm_bindgen] in a doc comment is not an attribute
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen(typescript_custom_section)]
const TS: &str = "x";

/// Docs.
#[wasm_bindgen(js_name = coreInfo, unchecked_return_type = "B.CoreInfo")]
pub fn core_info() -> u32 { 1 }

#[wasm_bindgen]
#[allow(
    clippy::too_many_arguments,
    reason = "a [bracket] inside"
)]
pub fn plain_name() {}

fn helper() {}

#[wasm_bindgen(js_name = "quoted")]
pub async fn quoted_js() {}
`;

describe("attributedFunctions", () => {
  it("finds each fn with the attributes stacked above it", () => {
    const fns = attributedFunctions(lib);
    assert.deepEqual(
      fns.map((f) => [f.name, f.line, f.attrs.length]),
      [
        ["core_info", 9, 1],
        ["plain_name", 16, 2],
        ["helper", 18, 0],
        ["quoted_js", 21, 1],
      ],
    );
    assert.match(fns[1].attrs[1], /^#\[allow\(/);
  });

  it("finds the block of an impl whose `{` follows a where clause", () => {
    const text = `impl<T> Show for Wrap<T>
where
    T: Clone,
{
    fn show(&self) {}
}
extern "C"
{
    fn imported();
}
fn free() {}
`;
    assert.deepEqual(
      attributedFunctions(text).map((f) => [f.name, f.block?.kind ?? null, f.block?.name ?? null]),
      [
        ["show", "impl", "Wrap"],
        ["imported", "extern", null],
        ["free", null, null],
      ],
    );
  });

  it("ignores braces and fns inside strings that span lines, and raw strings", () => {
    const text = `impl A {
    const S: &str = "{
fn not_a_fn() {}
";
    const B: &str = r"C:\\";
    const C: &str = r#"he said "}" "#;
    fn method() {}
}
fn free() {}
`;
    assert.deepEqual(
      attributedFunctions(text).map((f) => [f.name, f.block?.name ?? null]),
      [
        ["method", "A"],
        ["free", null],
      ],
    );
  });
});

describe("wasmLinks", () => {
  it("names each export by js_name, else the Rust name unchanged", () => {
    const links = wasmLinks([{ path: "crates/w/src/lib.rs", text: lib }], "@app/wasm");
    assert.deepEqual(links, [
      { via: "wasm", package: "@app/wasm", name: "coreInfo", to: { file: "crates/w/src/lib.rs", line: 9 } },
      { via: "wasm", package: "@app/wasm", name: "plain_name", to: { file: "crates/w/src/lib.rs", line: 16 } },
      { via: "wasm", package: "@app/wasm", name: "quoted", to: { file: "crates/w/src/lib.rs", line: 21 } },
    ]);
  });
});

describe("wasmLinks on classes", () => {
  const cls = `#[wasm_bindgen(js_name = Sweep)]
pub struct SweepState { n: u32 }

#[wasm_bindgen(js_class = Sweep)]
impl SweepState {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self { Self { n: 0 } }

    /// A "}" in a string does not close the block.
    pub fn owns(&self) -> bool { let _ = "}"; true }

    #[wasm_bindgen(js_name = endSweep)]
    pub fn end(&mut self) {}

    #[wasm_bindgen(getter = count)]
    pub fn n(&self) -> u32 { self.n }

    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 { 1 }

    #[wasm_bindgen(setter)]
    pub fn set_size(&mut self, _v: u32) {}

    fn private_helper(&self) {}

    #[wasm_bindgen(skip)]
    pub fn hidden(&self) {}
}

impl SweepState {
    pub fn rust_only(&self) {}
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(method, getter, js_name = altKey)]
    fn alt_key(this: &Event) -> bool;
}

#[wasm_bindgen]
pub fn after_blocks() {}
`;

  it("links exported methods to their class and skips imports and plain impls", () => {
    const links = wasmLinks([{ path: "w.rs", text: cls }], "@app/wasm");
    assert.deepEqual(
      links.map((l) => [l.owner ?? null, l.name, l.to.line]),
      [
        [null, "Sweep", 7],
        ["Sweep", "owns", 10],
        ["Sweep", "endSweep", 13],
        ["Sweep", "count", 16],
        ["Sweep", "size", 19],
        ["Sweep", "size", 22],
        [null, "after_blocks", 41],
      ],
    );
  });
});

describe("tauriLinks", () => {
  const rust = [
    {
      path: "shell/src/cmd.rs",
      text: "#[tauri::command]\npub fn db_query() {}\n\n#[tauri::command]\n#[specta::specta]\npub async fn never_called() {}\n\n#[tauri::command(rename_all = \"snake_case\")]\nfn local_api_call() {}\n",
    },
  ];
  const ts = [
    {
      path: "bridge/bindings.ts",
      text: 'export const commands = {\n\tdbQuery: () => __TAURI_INVOKE("db_query", { sql }),\n\tcall: () => invoke<string>(\'local_api_call\'),\n\tgone: () => __TAURI_INVOKE("removed_cmd"),\n\tother: () => fetch("db_query"),\n};\n',
    },
  ];

  it("links each invoke to its command and lists the rest", () => {
    const { links, unlinked } = tauriLinks(rust, ts, ["__TAURI_INVOKE", "invoke"]);
    assert.deepEqual(links, [
      { via: "tauri", name: "db_query", from: { file: "bridge/bindings.ts", line: 2 }, to: { file: "shell/src/cmd.rs", line: 2 } },
      { via: "tauri", name: "local_api_call", from: { file: "bridge/bindings.ts", line: 3 }, to: { file: "shell/src/cmd.rs", line: 9 } },
      { via: "tauri", name: "removed_cmd", from: { file: "bridge/bindings.ts", line: 4 }, to: null },
    ]);
    assert.deepEqual(unlinked, [{ via: "tauri", name: "never_called", file: "shell/src/cmd.rs", line: 6 }]);
  });
});

describe("unresolvedImports", () => {
  const files = [
    { path: "web/ok.ts", text: 'import { coreInfo } from "@app/wasm";' },
    { path: "web/lost.ts", text: 'const core = await import("@app/wasm");' },
    { path: "web/other.ts", text: 'import x from "left-pad";' },
    { path: "web/unindexed.ts", text: 'import { a } from "@app/wasm";' },
    { path: "web/effect.ts", text: 'import "@app/wasm";' },
  ];
  const documents = [
    { path: "web/ok.ts", occurrences: [{ symbol: "scip-typescript npm @app/wasm 1.0.0 `index.d.ts`/coreInfo()." }] },
    { path: "web/lost.ts", occurrences: [{ symbol: "scip-typescript npm web 1.0.0 `lost.ts`/core." }] },
    { path: "web/other.ts", occurrences: [] },
    { path: "web/effect.ts", occurrences: [] },
  ];

  it("lists indexed files that import the package but use none of its symbols", () => {
    assert.deepEqual(unresolvedImports(documents, files, "@app/wasm"), ["web/lost.ts"]);
  });
});

describe("crateDirs", () => {
  it("maps each package's Rust name to its directory", () => {
    const tomls = [
      { path: "Cargo.toml", text: '[workspace]\nmembers = ["plugins/*"]\n' },
      { path: "plugins/ink/Cargo.toml", text: '[package]\nname = "tauri-plugin-ink"\nversion = "0.1.0"\n\n[dependencies]\nname = "x"\n' },
      { path: "core/Cargo.toml", text: '[package]\nversion = "1.0.0"\nname = "core"\n' },
      { path: "core/notes.toml", text: '[package]\nname = "no"\n' },
      { path: "quoted/Cargo.toml", text: "[package]\nauthors = [\"a\"]\n  name = 'single-quoted'\n" },
      { path: "virtual/Cargo.toml", text: '[workspace]\n\n[dependencies]\nname = "dep"\n' },
    ];
    assert.deepEqual(
      [...crateDirs(tomls)],
      [
        ["tauri_plugin_ink", "plugins/ink/"],
        ["core", "core/"],
        ["single_quoted", "quoted/"],
      ],
    );
  });
});

describe("rustLinks", () => {
  const model = `use serde::Deserialize;

#[derive(Deserialize)]
pub struct Settings {
    #[serde(default = "yes", skip_serializing_if = "is_false")]
    pub on: bool,
    #[serde(deserialize_with = "crate::util::lenient")]
    pub n: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub o: Option<u32>,
}

const fn yes() -> bool { true }
fn is_false(v: &bool) -> bool { !v }

macro_rules! re {
    ($src:expr) => { compile(&pat($src)) };
}
fn pat(s: &str) -> String { s.into() }
fn compile(s: &str) {}

#[test]
fn top_level_check() {}

#[cfg(test)]
mod create_tests {
    fn helper() {}
    #[test]
    fn works() { helper() }
}
`;
  const util = "pub fn lenient() -> u32 { 0 }\n";
  const { links, tests } = rustLinks([
    { path: "src/model.rs", text: model },
    { path: "src/util.rs", text: util },
  ]);

  it("links a serde attribute naming a function to that function, in its file or else by name", () => {
    assert.deepEqual(
      links.filter((l) => l.via === "serde").map((l) => [l.name, l.from.line, l.to.file, l.to.line]),
      [
        ["yes", 5, "src/model.rs", 13],
        ["is_false", 5, "src/model.rs", 14],
        ["lenient", 7, "src/util.rs", 1],
      ],
    );
  });

  it("links a macro_rules! body to the functions it calls", () => {
    assert.deepEqual(
      links.filter((l) => l.via === "macro").map((l) => [l.name, l.from.line, l.to.line]),
      [
        ["pat", 16, 19],
        ["compile", 16, 20],
      ],
    );
  });

  it("links a cfg-gated call into a workspace crate, which rust-analyzer skips when the cfg is off", () => {
    const app = `pub fn run() {
    #[cfg(mobile)]
    let b = b.plugin(my_plugin::init());
    #[cfg(mobile)]
    let c = other_crate::init();
    let d = my_plugin::init();
}
`;
    const plugin = "fn helper() {}\npub fn init() {}\n";
    const { links } = rustLinks(
      [
        { path: "app/src/lib.rs", text: app },
        { path: "plugins/mine/src/lib.rs", text: plugin },
      ],
      new Map([["my_plugin", "plugins/mine/"]]),
    );
    assert.deepEqual(links, [{ via: "cfg", name: "init", from: { file: "app/src/lib.rs", line: 3 }, to: { file: "plugins/mine/src/lib.rs", line: 2 } }]);
  });

  it("follows a cfg over attribute lines and a whole item, through modules but not types", () => {
    const app = `#[cfg(all(
    mobile,
    not(test)
))]
#[allow(unused)]
fn setup() {
    my_plugin::sub::init();
    my_plugin::Point::init();
}
fn after() { my_plugin::init(); }
`;
    const plugin = "pub fn init() {}\nmod sub {\n    pub fn init() {}\n}\n";
    const { links } = rustLinks(
      [
        { path: "app/src/lib.rs", text: app },
        { path: "plugins/mine/src/lib.rs", text: plugin },
      ],
      new Map([["my_plugin", "plugins/mine/"]]),
    );
    assert.deepEqual(
      links.map((l) => [l.from.line, l.to.line]),
      [
        [7, 1],
        [7, 3],
      ],
    );
  });

  it("links serde names only from serde attributes, also split over lines, to each fn so named", () => {
    const text = `mod a {
    pub fn yes() -> bool { true }
}
mod b {
    pub fn yes() -> bool { false }
}
pub struct S {
    #[serde(
        default = "a::yes"
    )]
    pub x: bool,
}
const NOT: &str = "default = \\"yes\\"";
`;
    const { links } = rustLinks([{ path: "s.rs", text }]);
    assert.deepEqual(
      links.map((l) => [l.via, l.from.line, l.to.line]),
      [
        ["serde", 8, 2],
        ["serde", 8, 5],
      ],
    );
  });

  it("marks #[test] functions and #[cfg(test)] modules as test lines", () => {
    assert.deepEqual(tests, [
      { file: "src/model.rs", from: 23, to: 23 },
      { file: "src/model.rs", from: 26, to: 30 },
      { file: "src/model.rs", from: 29, to: 29 },
    ]);
  });
});
