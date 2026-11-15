/**
 * A tiny SCIP *writer* for tests: builds index bytes from plain objects so the
 * reader can be checked without running an indexer.
 */

function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

const key = (field, wire) => varint(field * 8 + wire);
const bytes = (field, payload) => [...key(field, 2), ...varint(payload.length), ...payload];
const str = (field, s) => bytes(field, [...Buffer.from(s, "utf8")]);
const num = (field, n) => [...key(field, 0), ...varint(n)];
const packed = (field, list) => bytes(field, list.flatMap(varint));

function occurrence({ range, symbol, roles = 0, enclosing }) {
  return [
    ...packed(1, range),
    ...str(2, symbol),
    ...(roles ? num(3, roles) : []),
    ...(enclosing ? packed(7, enclosing) : []),
  ];
}

function relationship({ symbol, reference = false, implementation = false }) {
  return [...str(1, symbol), ...(reference ? num(2, 1) : []), ...(implementation ? num(3, 1) : [])];
}

function symbolInfo({ symbol, kind = 0, name, relationships = [] }) {
  return [
    ...str(1, symbol),
    ...relationships.flatMap((r) => bytes(4, relationship(r))),
    ...(kind ? num(5, kind) : []),
    ...(name ? str(6, name) : []),
  ];
}

/** @param {{ documents: { path: string, occurrences?: object[], symbols?: object[] }[] }} index */
export function encodeScip({ documents }) {
  const out = [];
  for (const doc of documents) {
    const body = [
      ...str(1, doc.path),
      ...(doc.occurrences ?? []).flatMap((o) => bytes(2, occurrence(o))),
      ...(doc.symbols ?? []).flatMap((s) => bytes(3, symbolInfo(s))),
    ];
    out.push(...bytes(2, body));
  }
  return Uint8Array.from(out);
}
