import { tangentAt } from "@sample/wasm";

export function draw(x: number): number {
  return tangentAt(x);
}

export function helper(): number {
  return 1;
}

export function orphan(): number {
  return 2;
}
