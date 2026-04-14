/**
 * 与 cubejs 一致：面顺序 U → R → F → D → L → B；每面 9 格行优先，索引自该面左上角起。
 * 中心格在面内下标 4 → 全局下标见 CENTER_INDICES。
 */

const U = (x: number) => x - 1;
const R = (x: number) => U(9) + x;
const F = (x: number) => R(9) + x;
const D = (x: number) => F(9) + x;
const L = (x: number) => D(9) + x;
const B = (x: number) => L(9) + x;

/** 六个面中心贴纸的全局下标（0–53） */
export const CENTER_INDICES = [4, 13, 22, 31, 40, 49] as const;

/** 8 个角位，每个 3 个全局贴纸下标（与 cubejs cornerFacelet 一致） */
export const CORNER_FACELETS: readonly (readonly [number, number, number])[] = [
  [U(9), R(1), F(3)],
  [U(7), F(1), L(3)],
  [U(1), L(1), B(3)],
  [U(3), B(1), R(3)],
  [D(3), F(9), R(7)],
  [D(1), L(9), F(7)],
  [D(7), B(9), L(7)],
  [D(9), R(9), B(7)],
];

/** 12 条棱，每个 2 个全局贴纸下标 */
export const EDGE_FACELETS: readonly (readonly [number, number])[] = [
  [U(6), R(2)],
  [U(8), F(2)],
  [U(4), L(2)],
  [U(2), B(2)],
  [D(6), R(8)],
  [D(2), F(8)],
  [D(4), L(8)],
  [D(8), B(8)],
  [F(6), R(4)],
  [F(4), L(6)],
  [B(6), L(4)],
  [B(4), R(6)],
];

export function faceStartIndex(faceIndex: number): number {
  return faceIndex * 9;
}
