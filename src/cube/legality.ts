import Cube from 'cubejs';
import type { FaceId } from './types';
import { EMPTY_FACELET, isEmptyCell } from './cellValue';
import { FACES, FACE_ORDER_URFDLB } from './types';
import {
  CENTER_INDICES,
  CORNER_FACELETS,
  EDGE_FACELETS,
} from './faceletGeometry';

export type LegalityIssue = {
  /** 分类：color | piece | orientation | group */
  category: 'color' | 'piece' | 'orientation' | 'group';
  code: string;
  message: string;
  /** 需高亮的贴纸全局下标 0–53 */
  cellIndices: number[];
};

export type LegalityReport = {
  ok: boolean;
  issues: LegalityIssue[];
  illegalCellIndices: Set<number>;
};

const OPP: Record<FaceId, FaceId> = {
  U: 'D',
  D: 'U',
  L: 'R',
  R: 'L',
  F: 'B',
  B: 'F',
};

function isFaceId(c: string): c is FaceId {
  return (FACES as readonly string[]).includes(c);
}

function sortFaceKey(chars: string[]): string {
  return [...chars].sort().join('');
}

/** cubejs 还原态下 12 棱、8 角的身份（颜色为面记号） */
const REF_EDGE: string[][] = [
  ['U', 'R'],
  ['U', 'F'],
  ['U', 'L'],
  ['U', 'B'],
  ['D', 'R'],
  ['D', 'F'],
  ['D', 'L'],
  ['D', 'B'],
  ['F', 'R'],
  ['F', 'L'],
  ['B', 'L'],
  ['B', 'R'],
];

const REF_CORNER: string[][] = [
  ['U', 'R', 'F'],
  ['U', 'F', 'L'],
  ['U', 'L', 'B'],
  ['U', 'B', 'R'],
  ['D', 'F', 'R'],
  ['D', 'L', 'F'],
  ['D', 'B', 'L'],
  ['D', 'R', 'B'],
];

const VALID_EDGE_KEYS = new Set(REF_EDGE.map((e) => sortFaceKey(e)));
const VALID_CORNER_KEYS = new Set(REF_CORNER.map((c) => sortFaceKey(c)));

function mergeIndices(issues: LegalityIssue[]): Set<number> {
  const s = new Set<number>();
  for (const iss of issues) {
    for (const i of iss.cellIndices) s.add(i);
  }
  return s;
}

function isPermutation(p: readonly number[], n: number): boolean {
  const seen = new Uint8Array(n);
  for (const x of p) {
    if (x < 0 || x >= n || seen[x]) return false;
    seen[x] = 1;
  }
  return true;
}

/**
 * 对完整 54 字符串做分层校验，并汇总需高亮的贴纸下标。
 * 与 docs/GEOMETRIC_CONSTRAINTS.md 中约束 A–D 及需求中的色数、中心、块唯一性、手性（由 cube 一致性体现）对齐。
 */
export function validateLegality(facelets54: string): LegalityReport {
  const issues: LegalityIssue[] = [];

  const push = (
    category: LegalityIssue['category'],
    code: string,
    message: string,
    cellIndices: number[],
  ) => {
    issues.push({ category, code, message, cellIndices });
  };

  if (facelets54.length !== 54) {
    push('color', 'LEN', '须恰好 54 个贴纸。', []);
    return { ok: false, issues, illegalCellIndices: mergeIndices(issues) };
  }

  const counts: Record<FaceId, number> = {
    U: 0,
    D: 0,
    L: 0,
    R: 0,
    F: 0,
    B: 0,
  };
  const badCharCells: number[] = [];
  for (let i = 0; i < 54; i++) {
    const ch = facelets54[i]!;
    if (isEmptyCell(ch)) {
      continue;
    }
    if (!isFaceId(ch)) {
      badCharCells.push(i);
      continue;
    }
    counts[ch]++;
  }
  if (badCharCells.length) {
    push(
      'color',
      'CHAR',
      '存在非法字符（仅允许 U、D、L、R、F、B 或空位 ' + EMPTY_FACELET + '）。',
      badCharCells,
    );
    return { ok: false, issues, illegalCellIndices: mergeIndices(issues) };
  }

  const emptyCells: number[] = [];
  for (let i = 0; i < 54; i++) {
    if (isEmptyCell(facelets54[i]!)) emptyCells.push(i);
  }
  if (emptyCells.length > 0) {
    push(
      'color',
      'INCOMPLETE',
      '存在未填色格；全部填色后可进行完整合法性校验。',
      [],
    );
    return { ok: false, issues, illegalCellIndices: new Set<number>() };
  }

  const centerVals = CENTER_INDICES.map((i) => facelets54[i]!);
  const centerSet = new Set(centerVals);
  if (centerSet.size !== 6) {
    push(
      'color',
      'CENTER_DISTINCT',
      '六个面的中心块颜色必须两两不同（决定基准坐标系）。',
      [...CENTER_INDICES],
    );
  }

  for (const f of FACES) {
    if (counts[f] !== 9) {
      const idx: number[] = [];
      for (let i = 0; i < 54; i++) {
        if (facelets54[i] === f) idx.push(i);
      }
      push(
        'color',
        'MULTISET',
        `颜色 ${f} 须恰好出现 9 次（当前 ${counts[f]}）。`,
        idx,
      );
    }
  }

  for (let e = 0; e < EDGE_FACELETS.length; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    const ca = facelets54[a]!;
    const cb = facelets54[b]!;
    if (!isFaceId(ca) || !isFaceId(cb)) continue;
    const cells = [a, b];
    if (ca === cb) {
      push('piece', 'EDGE_SAME', `棱位 ${e}：同一棱上两贴纸颜色相同，非法。`, cells);
      continue;
    }
    if (OPP[ca] === cb) {
      push(
        'piece',
        'EDGE_OPP',
        `棱位 ${e}：两色为对色，物理上不存在该棱块。`,
        cells,
      );
    }
  }

  for (let c = 0; c < CORNER_FACELETS.length; c++) {
    const [a, b, d] = CORNER_FACELETS[c]!;
    const t = [facelets54[a]!, facelets54[b]!, facelets54[d]!];
    if (!t.every(isFaceId)) continue;
    const cells = [a, b, d];
    const uniq = new Set(t);
    if (uniq.size < 3) {
      push(
        'piece',
        'CORNER_DUP',
        `角位 ${c}：角块须为三种不同颜色。`,
        cells,
      );
      continue;
    }
    const pairs: [FaceId, FaceId][] = [
      [t[0]!, t[1]!],
      [t[1]!, t[2]!],
      [t[0]!, t[2]!],
    ];
    let oppPair = false;
    for (const [x, y] of pairs) {
      if (OPP[x] === y) oppPair = true;
    }
    if (oppPair) {
      push(
        'piece',
        'CORNER_OPP',
        `角位 ${c}：存在对色同时出现，非法。`,
        cells,
      );
      continue;
    }
    const key = sortFaceKey([t[0]!, t[1]!, t[2]!]);
    if (!VALID_CORNER_KEYS.has(key)) {
      push(
        'piece',
        'CORNER_TYPE',
        `角位 ${c}：三色组合不是任一物理角块身份。`,
        cells,
      );
    }
  }

  const edgeKeys: string[] = [];
  for (let e = 0; e < 12; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    const ca = facelets54[a];
    const cb = facelets54[b];
    if (!ca || !cb || !isFaceId(ca) || !isFaceId(cb)) continue;
    edgeKeys.push(sortFaceKey([ca, cb]));
  }
  if (edgeKeys.length === 12) {
    const edgeCount = new Map<string, number>();
    for (const k of edgeKeys) edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    for (const [k, n] of edgeCount) {
      if (n !== 1 || !VALID_EDGE_KEYS.has(k)) {
        const cells: number[] = [];
        for (let e = 0; e < 12; e++) {
          const [a, b] = EDGE_FACELETS[e]!;
          const ca = facelets54[a]!;
          const cb = facelets54[b]!;
          if (!isFaceId(ca) || !isFaceId(cb)) continue;
          if (sortFaceKey([ca, cb]) === k) {
            cells.push(a, b);
          }
        }
        push(
          'piece',
          'EDGE_UNIQUE',
          `棱块身份重复或非法：组合「${k}」出现 ${n} 次（应为每种棱块恰 1 个）。`,
          cells,
        );
      }
    }
  }

  const cornerKeys: string[] = [];
  for (let c = 0; c < 8; c++) {
    const [a, b, d] = CORNER_FACELETS[c]!;
    const t = [facelets54[a]!, facelets54[b]!, facelets54[d]!];
    if (!t.every(isFaceId)) continue;
    cornerKeys.push(sortFaceKey([t[0]!, t[1]!, t[2]!]));
  }
  if (cornerKeys.length === 8) {
    const cornerCount = new Map<string, number>();
    for (const k of cornerKeys) cornerCount.set(k, (cornerCount.get(k) ?? 0) + 1);
    for (const [k, n] of cornerCount) {
      if (n !== 1 || !VALID_CORNER_KEYS.has(k)) {
        const cells: number[] = [];
        for (let c = 0; c < 8; c++) {
          const [a, b, d] = CORNER_FACELETS[c]!;
          const t = [facelets54[a]!, facelets54[b]!, facelets54[d]!];
          if (!t.every(isFaceId)) continue;
          if (sortFaceKey([t[0]!, t[1]!, t[2]!]) === k) {
            cells.push(a, b, d);
          }
        }
        push(
          'piece',
          'CORNER_UNIQUE',
          `角块身份重复或非法：组合「${k}」出现 ${n} 次（应为每种角块恰 1 个）。`,
          cells,
        );
      }
    }
  }

  const cube = Cube.fromString(facelets54);

  const { cp, co, ep, eo } = cube.toJSON();
  if (!isPermutation(cp, 8) || !isPermutation(ep, 12)) {
    push(
      'piece',
      'PERM_ID',
      '棱/角块与贴纸无法一一对应（约束 A：块归属）。',
      [...Array(54).keys()],
    );
  }

  const reconstructed = cube.asString();
  if (reconstructed !== facelets54) {
    const diff: number[] = [];
    for (let i = 0; i < 54; i++) {
      if (facelets54[i] !== reconstructed[i]) diff.push(i);
    }
    push(
      'orientation',
      'FACELET_MISMATCH',
      '贴纸与唯一魔方状态不一致（含角块手性/棱方向与几何矛盾）。',
      diff.length ? diff : [...Array(54).keys()],
    );
  }

  const sumCo = co.reduce((a: number, b: number) => a + b, 0);
  if (sumCo % 3 !== 0) {
    const cells: number[] = [];
    for (const tri of CORNER_FACELETS) {
      for (const i of tri) cells.push(i);
    }
    push(
      'group',
      'TWIST_SUM',
      '角块扭转之和须 ≡ 0 (mod 3)（约束 B）。',
      cells,
    );
  }

  const flipCount = eo.reduce((a: number, b: number) => a + b, 0);
  if (flipCount % 2 !== 0) {
    const cells: number[] = [];
    for (const pair of EDGE_FACELETS) {
      for (const i of pair) cells.push(i);
    }
    push(
      'group',
      'EDGE_FLIP',
      '已翻转棱块数须为偶数（约束 C）。',
      cells,
    );
  }

  if (cube.cornerParity() !== cube.edgeParity()) {
    const cells: number[] = [];
    for (const tri of CORNER_FACELETS) {
      for (const i of tri) cells.push(i);
    }
    for (const pair of EDGE_FACELETS) {
      for (const i of pair) cells.push(i);
    }
    push(
      'group',
      'PARITY',
      '角块置换与棱块置换奇偶须一致（约束 D）。',
      cells,
    );
  }

  const ok = issues.length === 0;
  return { ok, issues, illegalCellIndices: mergeIndices(issues) };
}

export function solvedString(): string {
  return FACE_ORDER_URFDLB.map((f) => f.repeat(9)).join('');
}
