import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributedFunctions, tauriLinks, wasmLinks } from "../src/linkers.mjs";

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
