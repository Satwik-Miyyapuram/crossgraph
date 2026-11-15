# crossgraph

One code graph across TypeScript and Rust. It answers "who calls this?",
"is this dead?" and "how does this TS function reach that Rust one?" even when
the call crosses the language gap through wasm-bindgen or a Tauri command.

It reads [SCIP](https://github.com/sourcegraph/scip) indexes from
`scip-typescript` and `rust-analyzer`, adds the edges neither indexer can see,
and writes everything to one SQLite file you can query from the CLI or with
plain SQL.

## Needs

- Node 22.13 or newer (`node:sqlite`, `path.matchesGlob`)
- `rust-analyzer` on `PATH`, if the repo has Rust
- `npx`, which fetches `@sourcegraph/scip-typescript` on first run
- Generated code in place, such as wasm-bindgen output. An import
  that does not resolve leaves its uses out of the graph, so whatever they
  reach looks dead. List such files under `requires` and `build` refuses
  to run without them. `build` also refuses when a file imports a `wasm`
  package the TS indexer could not resolve, such as an unlinked workspace
  package.

## Use

Add `crossgraph.config.json` at the repository root, then:

```sh
npx crossgraph build            # index and write .crossgraph/graph.db
npx crossgraph build --no-index # rebuild the graph from the last indexes
npx crossgraph callers save_note
npx crossgraph path draw tangent
npx crossgraph dead
npx crossgraph check            # fail on findings not in the baseline
```

| Command | Answers |
| --- | --- |
| `find NAME` | where `NAME` is defined; `FILE:NAME` narrows to one file |
| `callers NAME` | what uses it, with the file and line of each use |
| `callees NAME` | what it uses |
| `path FROM TO` | the shortest chain of uses from one to the other |
| `dead` | functions and types nothing uses |
| `test-only` | functions and types only tests use |
| `missing` | TS calls into Rust whose Rust end does not exist |
| `unlinked` | Tauri commands nothing invokes |
| `check [--update]` | fails on dead code or broken links not in `crossgraph.baseline.json`; `--update` rewrites it |

Add `--json` to any command for machine-readable output. Add `.crossgraph/` to
`.gitignore`; commit `crossgraph.baseline.json`.

## Config

```json
{
  "ts": {
    "projects": ["tsconfig.json"],
    "extraProjects": [{ "name": "tests", "extends": "tsconfig.json", "include": ["test/**/*"] }]
  },
  "requires": [{ "path": "pkg/app.d.ts", "hint": "npm run build:wasm" }],
  "rust": { "root": "." },
  "exclude": ["third_party/**"],
  "tests": ["**/*.test.ts", "**/tests/**"],
  "entries": ["src/main.ts", "app/**/page.tsx"],
  "wasm": [{ "crate": "crates/wasm/src", "package": "@my/wasm" }],
  "tauri": { "commands": "src-tauri/src", "callers": ["src"], "invoke": ["invoke"] }
}
```

All paths are relative to the root and use forward slashes. Globs follow
Node's `path.matchesGlob`; a `**/x` glob also matches `x` at the root.

- `ts.projects`: tsconfigs to index.
- `ts.extraProjects`: files no tsconfig covers, such as tests, scripts or
  generated declarations. The TS indexer reads only the files a tsconfig
  includes, so uses inside a file that is merely imported are lost.
  crossgraph writes a tsconfig for each into `.crossgraph/`. Takes `name`,
  `include`, and optionally `extends` and `compilerOptions`. As in any
  tsconfig, path options in `compilerOptions` (such as `rootDir`) resolve
  from the written file, so `"../src"` means `src` at the root.
- `ts.indexer`: the npx package to index with; defaults to a pinned
  `@sourcegraph/scip-typescript`.
- `requires`: generated files that must exist before a build, each with a
  `hint` saying how to make it.
- `rust.root`: the Cargo workspace root. Leave `rust` out for a TS-only repo.
- `exclude`: files left out of the graph, such as vendored code. Uses of their
  symbols still show, as external nodes.
- `tests`: test files. Code only they use is reported by `test-only`, not
  `dead`. Rust `#[test]` functions, `#[cfg(test)]` modules and items in a
  `tests` module count as tests too.
- `entries`: files whose definitions are used from outside the code, such as
  framework routes. They are never reported dead.
- `wasm`: crates exported with `#[wasm_bindgen]`, and the npm package name
  their bindings are published under. A `js_name` sets the TS name. Methods
  in a `#[wasm_bindgen] impl` link through their JS class (`js_class`, else
  the type name), constructors to the class itself, and `getter`/`setter`
  names are followed. Functions in an `extern` block are imports, not
  exports, and are not linked.
- `tauri`: where `#[tauri::command]` functions live, which dirs call them, and
  the names of the functions that invoke a command by its string name.

## What it cannot see

- A Tauri command named by a variable rather than a string literal is not
  linked.
- Code reached only by reflection, dynamic import with a computed path, or
  framework conventions not listed in `entries` looks dead.
- Rust enum variants count as members of their enum, like fields, and are
  not reported on their own.
- Trait implementations, `main`, `.d.ts` declarations and tests are never
  reported dead, since their callers are outside the index.

## How it works

1. `scip-typescript` and `rust-analyzer scip` index each language.
2. Each use becomes an edge from the innermost definition around it to the
   definition it names. Implementations and the interface or trait member
   they implement link both ways, so a declaration that only dispatches is
   not dead.
3. A source scan finds `#[wasm_bindgen]` and `#[tauri::command]` functions and
   the TS calls that reach them, and adds those edges. It also links serde
   attributes that name a function by string (`default = "yes"`) and
   `macro_rules!` bodies to the functions they call, since rust-analyzer
   records neither. A statement under `#[cfg(...)]` links its
   `some_crate::f()` calls into workspace crates, as rust-analyzer skips
   code whose cfg is off on the indexing machine.
4. TS types match by shape, so a call through an interface names the
   interface's member, never the class behind it. A used member of a type
   links to the same member of every used class that has all the type's
   members. Such an edge, and a wasm export's `.d.ts` declaration, only pass
   a use along: they count while their own source is used.
5. Nodes and edges go into SQLite (`nodes`, `edges`, `missing`, `unlinked`).

## Develop

```sh
npm test
```

`test/e2e.test.mjs` runs both indexers on `test/fixture/sample` and is skipped
when `rust-analyzer` is missing.
