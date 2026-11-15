import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readScip, ROLE } from "../src/scip.mjs";
import { encodeScip } from "./encode.mjs";

describe("readScip", () => {
  it("reads documents, occurrences and symbols", () => {
    const buf = encodeScip({
      documents: [
        {
          path: "src/a.ts",
          occurrences: [
            { range: [1, 2, 3, 4], symbol: "pkg a/f().", roles: ROLE.definition, enclosing: [1, 0, 5, 1] },
            { range: [7, 2, 9], symbol: "pkg b/g()." },
          ],
          symbols: [
            { symbol: "pkg a/f().", kind: 17, name: "f", relationships: [{ symbol: "pkg a/I#f().", implementation: true }] },
          ],
        },
      ],
    });
    assert.deepEqual(readScip(buf), {
      documents: [
        {
          path: "src/a.ts",
          occurrences: [
            { range: [1, 2, 3, 4], symbol: "pkg a/f().", roles: 1, enclosing: [1, 0, 5, 1] },
            // Three numbers mean one line: [line, startChar, endChar].
            { range: [7, 2, 7, 9], symbol: "pkg b/g().", roles: 0, enclosing: null },
          ],
          symbols: [
            {
              symbol: "pkg a/f().",
              kind: 17,
              name: "f",
              relationships: [{ symbol: "pkg a/I#f().", reference: false, implementation: true }],
            },
          ],
        },
      ],
    });
  });

  it("writes paths with forward slashes whatever the platform", () => {
    const buf = encodeScip({ documents: [{ path: "crates\\core\\src\\lib.rs" }] });
    assert.equal(readScip(buf).documents[0].path, "crates/core/src/lib.rs");
  });

  it("decodes multi-byte varints and UTF-8 text", () => {
    const buf = encodeScip({
      documents: [{ path: "ü.ts", occurrences: [{ range: [70000, 200, 300], symbol: "pkg é/x." }] }],
    });
    const [occ] = readScip(buf).documents[0].occurrences;
    assert.deepEqual(occ.range, [70000, 200, 70000, 300]);
    assert.equal(occ.symbol, "pkg é/x.");
  });

  it("skips fields it does not read, of every wire type", () => {
    // metadata (field 1, a message), a fixed64 and a fixed32 field, then a document.
    const extra = [0x0a, 0x01, 0x00, 0x29, 1, 2, 3, 4, 5, 6, 7, 8, 0x2d, 1, 2, 3, 4];
    const doc = encodeScip({ documents: [{ path: "x.ts" }] });
    const buf = Uint8Array.from([...extra, ...doc]);
    assert.deepEqual(readScip(buf).documents.map((d) => d.path), ["x.ts"]);
  });

  it("reads an empty index", () => {
    assert.deepEqual(readScip(new Uint8Array()), { documents: [] });
  });

  it("rejects a truncated index instead of looping or inventing data", () => {
    const buf = encodeScip({ documents: [{ path: "x.ts" }] });
    assert.throws(() => readScip(buf.subarray(0, buf.length - 1)), /scip:/);
    assert.throws(() => readScip(Uint8Array.from([0x80])), /truncated varint/);
  });

  it("rejects a wire type it cannot skip", () => {
    assert.throws(() => readScip(Uint8Array.from([0x0b])), /wire type 3/);
  });
});
