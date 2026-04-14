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

/** 校验在何处提前结束（后续约束未执行） */
export type ValidationStop = 'LEN' | 'CHAR' | 'INCOMPLETE' | null;

export type LegalityReport = {
  ok: boolean;
  issues: LegalityIssue[];
  illegalCellIndices: Set<number>;
  /** 若非 null，仅该步及之前步骤对应的约束有效，其后为「未校验」 */
  validationStop: ValidationStop;
  /** 用户关闭的检测项（用于右侧展示为未检测） */
  disabledChecks?: {
    faceletMismatch?: boolean;
    centerMultiset?: boolean;
  };
};

/** `validateLegality` 可选参数 */
export type ValidateLegalityOptions = {
  /** 是否检测 FACELET_MISMATCH（几何一致）；默认 true */
  checkFaceletMismatch?: boolean;
  /** 是否检测 CENTER_DISTINCT 与 MULTISET（色数）；默认 true */
  checkCenterMultiset?: boolean;
};

export type ConstraintGroupId =
  | 'len'
  | 'charset'
  | 'incomplete'
  | 'center_multiset'
  | 'edge_local'
  | 'corner_local'
  | 'perm_a'
  | 'facelet_match'
  | 'twist_b'
  | 'flip_c'
  | 'parity_d';

export type ConstraintRow = {
  id: ConstraintGroupId;
  title: string;
  description: string;
  status: 'pass' | 'fail' | 'skipped';
  cellIndices: number[];
};

/** 固定顺序：与校验流程一致，用于右侧展示 */
export const CONSTRAINT_GROUPS: readonly {
  id: ConstraintGroupId;
  title: string;
  description: string;
  codes: readonly string[];
}[] = [
  {
    id: 'len',
    title: '长度',
    description: 'facelet 串须恰好 54 个字符。',
    codes: ['LEN'],
  },
  {
    id: 'charset',
    title: '字符集',
    description: '每位仅允许 U、D、L、R、F、B 或未填占位符。',
    codes: ['CHAR'],
  },
  {
    id: 'incomplete',
    title: '填色完整',
    description: '未填齐时仍可检测棱块、角块与色数（不超过约束）；填齐后可做 cubejs 完整校验。',
    codes: ['INCOMPLETE'],
  },
  {
    id: 'center_multiset',
    title: '色数',
    description: '六个中心两两不同（均已填时）；每种颜色在已填格中不得超过 9 次。',
    codes: ['CENTER_DISTINCT', 'MULTISET'],
  },
  {
    id: 'edge_local',
    title: '棱块（局部）',
    description:
      '每条已填棱两贴纸须为异色且非对色；同一棱身份组合在已填棱上不得超过一次。',
    codes: ['EDGE_SAME', 'EDGE_OPP', 'EDGE_UNIQUE'],
  },
  {
    id: 'corner_local',
    title: '角块（局部）',
    description:
      '每个已填角三色互异且无对色对；同一角身份组合在已填角上不得超过一次；槽位上三色顺序须为合法扭转（手性/循环）。',
    codes: ['CORNER_DUP', 'CORNER_OPP', 'CORNER_TYPE', 'CORNER_CHIRALITY', 'CORNER_UNIQUE'],
  },
  {
    id: 'perm_a',
    title: '约束 A · 块归属',
    description: '贴纸与 12 棱、8 角块须能一一对应。',
    codes: ['PERM_ID'],
  },
  {
    id: 'facelet_match',
    title: '几何一致',
    description: '贴纸与 cubejs 唯一内部状态一致（含手性、棱/角朝向）。',
    codes: ['FACELET_MISMATCH'],
  },
  {
    id: 'twist_b',
    title: '约束 B · 角扭转',
    description: '八个角块扭转量之和须 ≡ 0 (mod 3)。',
    codes: ['TWIST_SUM'],
  },
  {
    id: 'flip_c',
    title: '约束 C · 棱翻转',
    description: '已翻转棱块个数须为偶数。',
    codes: ['EDGE_FLIP'],
  },
  {
    id: 'parity_d',
    title: '约束 D · 置换奇偶',
    description: '角块置换与棱块置换的奇偶性须一致。',
    codes: ['PARITY'],
  },
];

/** validationStop 之后的首个约束组 id（该组及之后均未执行） */
function firstSkippedGroupAfter(stop: ValidationStop): ConstraintGroupId | null {
  if (stop === 'LEN') return 'charset';
  if (stop === 'CHAR') return 'incomplete';
  /** 未填齐时仍执行色数与棱/角局部，从块归属起未执行 */
  if (stop === 'INCOMPLETE') return 'perm_a';
  return null;
}

function mergeCodesForGroup(issues: LegalityIssue[], codes: readonly string[]): number[] {
  const set = new Set<number>();
  for (const iss of issues) {
    if (!codes.includes(iss.code)) continue;
    for (const i of iss.cellIndices) set.add(i);
  }
  return [...set];
}

export function buildConstraintRows(report: LegalityReport): ConstraintRow[] {
  const { issues, validationStop, disabledChecks } = report;
  const skipFrom = firstSkippedGroupAfter(validationStop);
  let skipping = false;

  return CONSTRAINT_GROUPS.map((g) => {
    if (skipFrom !== null && g.id === skipFrom) skipping = true;
    if (
      g.id === 'facelet_match' &&
      disabledChecks?.faceletMismatch &&
      !skipping
    ) {
      return {
        id: g.id,
        title: g.title,
        description: g.description,
        status: 'skipped' as const,
        cellIndices: [],
      };
    }
    if (
      g.id === 'center_multiset' &&
      disabledChecks?.centerMultiset &&
      !skipping
    ) {
      return {
        id: g.id,
        title: g.title,
        description: g.description,
        status: 'skipped' as const,
        cellIndices: [],
      };
    }
    if (skipping) {
      return {
        id: g.id,
        title: g.title,
        description: g.description,
        status: 'skipped' as const,
        cellIndices: [],
      };
    }
    const cellIndices = mergeCodesForGroup(issues, g.codes);
    const failed = issues.some((iss) => g.codes.includes(iss.code));
    return {
      id: g.id,
      title: g.title,
      description: g.description,
      status: failed ? ('fail' as const) : ('pass' as const),
      cellIndices,
    };
  });
}

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

/** 由排序键定位角块身份下标 0..7（与 REF_CORNER 一致） */
function cornerPieceIndexFromSortedKey(key: string): number | null {
  for (let j = 0; j < 8; j++) {
    if (sortFaceKey(REF_CORNER[j]!) === key) return j;
  }
  return null;
}

/**
 * 槽位上三色顺序是否为该物理角块的合法扭转（仅 3 种循环置换）。
 * 与 cubejs 约定一致：cornerColor[j][(m−ori+3)%3] 贴在 CORNER_FACELETS 顺序的第 m 个面元上。
 * 若三色对但为镜像置换（如仅交换两色），返回 false。
 */
function isCornerCyclicTwist(t: readonly [FaceId, FaceId, FaceId], pieceJ: number): boolean {
  const ref = REF_CORNER[pieceJ]!;
  for (let ori = 0; ori < 3; ori++) {
    let ok = true;
    for (let m = 0; m < 3; m++) {
      if (t[m] !== (ref[(m - ori + 3) % 3] as FaceId)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

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
 * 对 54 位 facelet 串分层校验。未填色时仍可做色数（每种≤9）与棱/角局部；填齐后执行 cubejs（约束 A–D 等）。
 * `validationStop`：`INCOMPLETE` 时从「块归属」起标为未校验，色数与棱/角仍有效。
 */
export function validateLegality(
  facelets54: string,
  options?: ValidateLegalityOptions,
): LegalityReport {
  const checkFaceletMismatch = options?.checkFaceletMismatch !== false;
  const checkCenterMultiset = options?.checkCenterMultiset !== false;
  const disabledChecks: LegalityReport['disabledChecks'] =
    !checkFaceletMismatch || !checkCenterMultiset
      ? {
          ...(!checkFaceletMismatch ? { faceletMismatch: true as const } : {}),
          ...(!checkCenterMultiset ? { centerMultiset: true as const } : {}),
        }
      : undefined;

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
    return {
      ok: false,
      issues,
      illegalCellIndices: mergeIndices(issues),
      validationStop: 'LEN',
      disabledChecks,
    };
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
    return {
      ok: false,
      issues,
      illegalCellIndices: mergeIndices(issues),
      validationStop: 'CHAR',
      disabledChecks,
    };
  }

  const emptyCells: number[] = [];
  for (let i = 0; i < 54; i++) {
    if (isEmptyCell(facelets54[i]!)) emptyCells.push(i);
  }
  const incomplete = emptyCells.length > 0;
  if (incomplete) {
    push(
      'color',
      'INCOMPLETE',
      '存在未填色格；已检测色数（每种≤9）与已填棱/角；填齐后可做 cubejs 完整校验。',
      emptyCells,
    );
  }

  if (checkCenterMultiset) {
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
      if (counts[f] > 9) {
        const idx: number[] = [];
        for (let i = 0; i < 54; i++) {
          if (facelets54[i] === f) idx.push(i);
        }
        push(
          'color',
          'MULTISET',
          `颜色 ${f} 在已填格中不得超过 9 次（当前 ${counts[f]}）。`,
          idx,
        );
      }
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
    const cells = [a, b, d];
    const faceIds = t.filter((ch): ch is FaceId => isFaceId(ch));
    const nFace = faceIds.length;

    if (nFace === 0 || nFace === 1) {
      continue;
    }

    if (nFace === 2) {
      const [x, y] = faceIds;
      if (x === y) {
        push(
          'piece',
          'CORNER_DUP',
          `角位 ${c}：已填两格颜色相同，无法与第三格构成三种互异颜色。`,
          cells,
        );
        continue;
      }
      if (OPP[x] === y) {
        push(
          'piece',
          'CORNER_OPP',
          `角位 ${c}：已填两色为对色，无法构成合法角块（即使第三格未填）。`,
          cells,
        );
        continue;
      }
      continue;
    }

    const uniq = new Set(faceIds);
    if (uniq.size < 3) {
      push(
        'piece',
        'CORNER_DUP',
        `角位 ${c}：角块须为三种不同颜色。`,
        cells,
      );
      continue;
    }
    const [p, q, r] = faceIds as [FaceId, FaceId, FaceId];
    const pairs: [FaceId, FaceId][] = [
      [p, q],
      [q, r],
      [p, r],
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
    const key = sortFaceKey([p, q, r]);
    if (!VALID_CORNER_KEYS.has(key)) {
      push(
        'piece',
        'CORNER_TYPE',
        `角位 ${c}：三色组合不是任一物理角块身份。`,
        cells,
      );
      continue;
    }
    const pieceJ = cornerPieceIndexFromSortedKey(key);
    if (pieceJ === null) continue;
    const triple = [p, q, r] as readonly [FaceId, FaceId, FaceId];
    if (!isCornerCyclicTwist(triple, pieceJ)) {
      push(
        'piece',
        'CORNER_CHIRALITY',
        `角位 ${c}：三色在槽位上的顺序不是该物理角块的合法扭转（手性错误，如两色对调）。`,
        cells,
      );
    }
  }

  const edgeCount = new Map<string, number>();
  for (let e = 0; e < 12; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    const ca = facelets54[a];
    const cb = facelets54[b];
    if (!ca || !cb || !isFaceId(ca) || !isFaceId(cb)) continue;
    const k = sortFaceKey([ca, cb]);
    edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
  }
  for (const [k, n] of edgeCount) {
    if (n > 1 || !VALID_EDGE_KEYS.has(k)) {
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
        n > 1
          ? `棱块身份重复：组合「${k}」在已填棱上出现 ${n} 次（不得超过 1 次）。`
          : `棱块身份非法：组合「${k}」不是任一物理棱身份。`,
        cells,
      );
    }
  }

  const cornerCount = new Map<string, number>();
  for (let c = 0; c < 8; c++) {
    const [a, b, d] = CORNER_FACELETS[c]!;
    const t = [facelets54[a]!, facelets54[b]!, facelets54[d]!];
    if (!t.every(isFaceId)) continue;
    const k = sortFaceKey([t[0]!, t[1]!, t[2]!]);
    cornerCount.set(k, (cornerCount.get(k) ?? 0) + 1);
  }
  for (const [k, n] of cornerCount) {
    if (n > 1 || !VALID_CORNER_KEYS.has(k)) {
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
        n > 1
          ? `角块身份重复：组合「${k}」在已填角上出现 ${n} 次（不得超过 1 次）。`
          : `角块身份非法：组合「${k}」不是任一物理角身份。`,
        cells,
      );
    }
  }

  if (!incomplete) {
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
  if (checkFaceletMismatch && reconstructed !== facelets54) {
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
  }

  const ok = issues.length === 0;
  return {
    ok,
    issues,
    illegalCellIndices: mergeIndices(issues),
    validationStop: incomplete ? 'INCOMPLETE' : null,
    disabledChecks,
  };
}

export function solvedString(): string {
  return FACE_ORDER_URFDLB.map((f) => f.repeat(9)).join('');
}
