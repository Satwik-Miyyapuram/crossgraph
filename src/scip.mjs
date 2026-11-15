/**
 * Read a SCIP index (https://github.com/sourcegraph/scip, scip.proto).
 *
 * Both indexers we run, scip-typescript and `rust-analyzer scip`, write this
 * protobuf format. Only the handful of fields the code graph needs are read,
 * so a small wire-format decoder does the job without a protobuf dependency.
 */

/** Occurrence role bits (scip.proto SymbolRole). */
export const ROLE = { definition: 1, import: 2, write: 4, read: 8, generated: 16, test: 32 };

/**
 * Decode an index into `{ documents: [{ path, occurrences, symbols }] }`.
 *
 * - `path` uses `/` whatever the indexing platform wrote.
 * - Each occurrence is `{ range, symbol, roles, enclosing }`, ranges as
 *   `[startLine, startChar, endLine, endChar]`, zero-based. `enclosing` is the
 *   whole body of a definition, when the indexer reports it.
 * - Each symbol is `{ symbol, kind, name, relationships }`; `name` is empty
 *   when the indexer leaves out `display_name` (scip-typescript does). A
 *   relationship is `{ symbol, reference, implementation }`: this symbol
 *   implements, or overrides, the one it names.
 *
 * @param {Uint8Array} buf
 */
export function readScip(buf) {
  const documents = [];
  for (const [field, span] of fields(buf, 0, buf.length)) {
    if (field === 2) documents.push(readDocument(buf, span));
  }
  return { documents };
}

function readDocument(buf, [start, end]) {
  const doc = { path: "", occurrences: [], symbols: [] };
  for (const [field, value] of fields(buf, start, end)) {
    if (field === 1) doc.path = text(buf, value).replaceAll("\\", "/");
    else if (field === 2) doc.occurrences.push(readOccurrence(buf, value));
    else if (field === 3) doc.symbols.push(readSymbol(buf, value));
  }
  return doc;
}

function readOccurrence(buf, [start, end]) {
  const occ = { range: [], symbol: "", roles: 0, enclosing: null };
  for (const [field, value] of fields(buf, start, end)) {
    if (field === 1) occ.range = range(buf, value);
    else if (field === 2) occ.symbol = text(buf, value);
    else if (field === 3) occ.roles = value;
    else if (field === 7) occ.enclosing = range(buf, value);
  }
  return occ;
}

function readSymbol(buf, [start, end]) {
  const sym = { symbol: "", kind: 0, name: "", relationships: [] };
  for (const [field, value] of fields(buf, start, end)) {
    if (field === 1) sym.symbol = text(buf, value);
    else if (field === 4) sym.relationships.push(readRelationship(buf, value));
    else if (field === 5) sym.kind = value;
    else if (field === 6) sym.name = text(buf, value);
  }
  return sym;
}

function readRelationship(buf, [start, end]) {
  const rel = { symbol: "", reference: false, implementation: false };
  for (const [field, value] of fields(buf, start, end)) {
    if (field === 1) rel.symbol = text(buf, value);
    else if (field === 2) rel.reference = value === 1;
    else if (field === 3) rel.implementation = value === 1;
  }
  return rel;
}

/** A packed int32 range; the three-number form means one line. */
function range(buf, span) {
  const r = packed(buf, span);
  return r.length === 3 ? [r[0], r[1], r[0], r[2]] : r;
}

const text = (buf, [start, end]) => Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString("utf8");

function packed(buf, [start, end]) {
  const out = [];
  const at = { i: start };
  while (at.i < end) out.push(varint(buf, at));
  return out;
}

function varint(buf, at) {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (at.i >= buf.length) throw new Error("scip: truncated varint");
    const byte = buf[at.i++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
    scale *= 128;
  }
}

/**
 * Walk one message's fields as `[number, value]`: a number for varints, a
 * `[start, end]` span for length-delimited fields. Fixed-width fields are
 * skipped; nothing we read uses them.
 */
function* fields(buf, start, end) {
  const at = { i: start };
  while (at.i < end) {
    const key = varint(buf, at);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) yield [field, varint(buf, at)];
    else if (wire === 2) {
      const length = varint(buf, at);
      if (at.i + length > end) throw new Error("scip: field runs past its message");
      yield [field, [at.i, at.i + length]];
      at.i += length;
    } else if (wire === 1) at.i += 8;
    else if (wire === 5) at.i += 4;
    else throw new Error(`scip: unsupported wire type ${wire}`);
  }
}
