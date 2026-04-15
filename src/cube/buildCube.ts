import { CENTER_INDICES, CORNER_FACELETS, EDGE_FACELETS } from './faceletGeometry';
import type { FaceId } from './types';
import { FACES } from './types';

/**
 * 与 `import Cube from 'cubejs'; Cube.prototype.toJSON()` 返回结构一致。
 * 约定：无法从当前贴纸确定的项用 **-1**（center 某面中心未填或非法；角/棱槽位未定块或未定朝向）。
 */
export type CubeStateJSON = {
  center: number[];
  cp: number[];
  co: number[];
  ep: number[];
  eo: number[];
};

/** cubejs `centerColor`：面索引 0–5（U,R,F,D,L,B）上中心贴纸对应的「颜色编号」 */
const CENTER_LETTER_TO_INDEX: Record<FaceId, number> = {
  U: 0,
  R: 1,
  F: 2,
  D: 3,
  L: 4,
  B: 5,
};

/** 与 cubejs `cornerColor` / cubeConstraints `REF_CORNER` 一致 */
const REF_CORNER: readonly (readonly FaceId[])[] = [
  ['U', 'R', 'F'],
  ['U', 'F', 'L'],
  ['U', 'L', 'B'],
  ['U', 'B', 'R'],
  ['D', 'F', 'R'],
  ['D', 'L', 'F'],
  ['D', 'B', 'L'],
  ['D', 'R', 'B'],
] as const;

/** 与 cubejs `edgeColor` / cubeConstraints `REF_EDGE` 一致 */
const REF_EDGE: readonly (readonly FaceId[])[] = [
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
] as const;

function isFaceId(c: string): c is FaceId {
  return (FACES as readonly string[]).includes(c);
}

/** 槽位顺序下三色是否为角块 j 的合法循环扭转（与 cubejs / cubeConstraints 一致） */
function isCornerCyclicTwist(t: readonly [FaceId, FaceId, FaceId], pieceJ: number): boolean {
  const ref = REF_CORNER[pieceJ]!;
  for (let ori = 0; ori < 3; ori++) {
    let ok = true;
    for (let m = 0; m < 3; m++) {
      if (t[m] !== ref[(m - ori + 3) % 3]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function sortedCornerKey(a: FaceId, b: FaceId, c: FaceId): string {
  return [a, b, c].sort().join('');
}

/** 三色 multiset 对应的角块身份下标，非法组合返回 null */
function cornerPieceIndexFromThreeColors(a: FaceId, b: FaceId, c: FaceId): number | null {
  const key = sortedCornerKey(a, b, c);
  for (let j = 0; j < 8; j++) {
    const ref = REF_CORNER[j]!;
    if (sortedCornerKey(ref[0]!, ref[1]!, ref[2]!) === key) return j;
  }
  return null;
}

/**
 * cubejs `fromString` 角逻辑：槽位顺序下 `full`，先找第一个 U/D 定下标 `ori`，
 * 再要求 `full[(ori+1)%3]===ref[j][1]`、`full[(ori+2)%3]===ref[j][2]`，且为合法循环扭转。
 * 返回 `co` 即该 `ori`，失败返回 null。
 */
function cornerPieceAndOriFromFullSlotOrder(
  full: readonly [FaceId, FaceId, FaceId],
  j: number,
): number | null {
  const ref = REF_CORNER[j]!;
  let ori = 0;
  for (; ori <= 2; ori++) {
    if (full[ori] === 'U' || full[ori] === 'D') break;
  }
  if (ori > 2) return null;
  const col1 = full[(ori + 1) % 3]!;
  const col2 = full[(ori + 2) % 3]!;
  if (col1 !== ref[1] || col2 !== ref[2]) return null;
  if (!isCornerCyclicTwist(full, j)) return null;
  return ori % 3;
}

/**
 * 解析单角槽 `slotIndex`：至少两格为有效面色时可唯一确定（两格时第三色由块身份推出）。
 * 无法唯一确定或非法时返回 null。
 */
export function resolveCornerSlot(facelets54: string, slotIndex: number): { j: number; ori: number } | null {
  const [ia, ib, ic] = CORNER_FACELETS[slotIndex]!;
  const raw = [facelets54[ia]!, facelets54[ib]!, facelets54[ic]!] as const;

  const filledColors: FaceId[] = [];
  for (let m = 0; m < 3; m++) {
    const ch = raw[m]!;
    if (isFaceId(ch)) {
      filledColors.push(ch);
    }
  }
  const n = filledColors.length;
  if (n < 2) return null;

  if (n === 3) {
    const full = [filledColors[0]!, filledColors[1]!, filledColors[2]!] as [FaceId, FaceId, FaceId];
    const j = cornerPieceIndexFromThreeColors(full[0]!, full[1]!, full[2]!);
    if (j === null) return null;
    const ori = cornerPieceAndOriFromFullSlotOrder(full, j);
    return ori === null ? null : { j, ori };
  }

  const nullIdx = raw.findIndex((ch) => !isFaceId(ch));
  if (nullIdx < 0) return null;
  const [v0, v1] = filledColors;

  const solutions: { j: number; ori: number }[] = [];
  for (let j = 0; j < 8; j++) {
    const ref = REF_CORNER[j]!;
    if (!ref.includes(v0) || !ref.includes(v1)) continue;
    const z = ref.find((c) => c !== v0 && c !== v1) as FaceId | undefined;
    if (z === undefined) continue;
    const full: [FaceId, FaceId, FaceId] = [
      nullIdx === 0 ? z : (raw[0] as FaceId),
      nullIdx === 1 ? z : (raw[1] as FaceId),
      nullIdx === 2 ? z : (raw[2] as FaceId),
    ];
    const ori = cornerPieceAndOriFromFullSlotOrder(full, j);
    if (ori === null) continue;
    solutions.push({ j, ori });
  }

  if (solutions.length !== 1) return null;
  return solutions[0]!;
}

/**
 * 从 54 位 facelet 串解析与 cubejs 相同的内部数组；未填位（`.` 等）或无法唯一对应时填 **-1**。
 * 角块：同一槽位 **任意两格** 为有效面色且可唯一补成合法扭转时即可定 `cp`/`co`。
 * 不要求 54 格均为面色；长度须为 54。
 */
export function buildCube(facelets54: string): CubeStateJSON {
  if (facelets54.length !== 54) {
    throw new Error(`buildCube: 须恰好 54 个字符，当前 ${facelets54.length}`);
  }

  const center = Array.from({ length: 6 }, () => -1);
  const cp = Array.from({ length: 8 }, () => -1);
  const co = Array.from({ length: 8 }, () => -1);
  const ep = Array.from({ length: 12 }, () => -1);
  const eo = Array.from({ length: 12 }, () => -1);

  for (let i = 0; i < 6; i++) {
    const ch = facelets54[CENTER_INDICES[i]!]!;
    if (isFaceId(ch)) {
      center[i] = CENTER_LETTER_TO_INDEX[ch];
    }
  }

  for (let i = 0; i < 8; i++) {
    const r = resolveCornerSlot(facelets54, i);
    if (r === null) continue;
    cp[i] = r.j;
    co[i] = r.ori;
  }

  for (let i = 0; i < 12; i++) {
    const [a, b] = EDGE_FACELETS[i]!;
    const ca = facelets54[a]!;
    const cb = facelets54[b]!;
    if (!isFaceId(ca) || !isFaceId(cb)) {
      continue;
    }
    let found = false;
    for (let j = 0; j < 12; j++) {
      const ref = REF_EDGE[j]!;
      if (ca === ref[0] && cb === ref[1]) {
        ep[i] = j;
        eo[i] = 0;
        found = true;
        break;
      }
      if (ca === ref[1] && cb === ref[0]) {
        ep[i] = j;
        eo[i] = 1;
        found = true;
        break;
      }
    }
    if (!found) {
      ep[i] = -1;
      eo[i] = -1;
    }
  }

  clearDuplicatePieceAssignments(cp, co, 8);
  clearDuplicatePieceAssignments(ep, eo, 12);

  return { center, cp, co, ep, eo };
}

/** 同一物理块被多个槽位标到则全部标为未知（贴纸与几何矛盾或解析歧义） */
function clearDuplicatePieceAssignments(perm: number[], ori: number[], nPieces: number): void {
  const count = new Uint8Array(nPieces);
  for (let i = 0; i < perm.length; i++) {
    const v = perm[i]!;
    if (v >= 0 && v < nPieces) count[v]++;
  }
  for (let j = 0; j < nPieces; j++) {
    if (count[j]! <= 1) continue;
    for (let i = 0; i < perm.length; i++) {
      if (perm[i] === j) {
        perm[i] = -1;
        ori[i] = -1;
      }
    }
  }
}

/** 与 cubejs `centerColor` 顺序一致 */
const CENTER_INDEX_TO_LETTER: readonly FaceId[] = ['U', 'R', 'F', 'D', 'L', 'B'];

/** 无 -1 且各分量在合法范围内（尚未校验 cp/ep 是否为置换） */
export function isCubeStateFullyDetermined(s: CubeStateJSON): boolean {
  return (
    s.center.every((x) => x >= 0 && x <= 5) &&
    s.cp.every((x) => x >= 0 && x <= 7) &&
    s.co.every((x) => x >= 0 && x <= 2) &&
    s.ep.every((x) => x >= 0 && x <= 11) &&
    s.eo.every((x) => x >= 0 && x <= 1)
  );
}

/** `p` 须为 `0..n-1` 的一个排列（无 -1） */
export function isPermutationCube(p: readonly number[], n: number): boolean {
  const seen = new Uint8Array(n);
  for (const x of p) {
    if (x < 0 || x >= n || seen[x]) return false;
    seen[x] = 1;
  }
  return true;
}

/**
 * 由内部状态生成 54 位面串（与 cubejs `asString` 一致）。
 * 若存在 -1、或 cp/ep 非置换则返回 `null`。
 */
export function faceletsFromCubeState(state: CubeStateJSON): string | null {
  if (!isCubeStateFullyDetermined(state)) return null;
  if (!isPermutationCube(state.cp, 8) || !isPermutationCube(state.ep, 12)) return null;

  const result: string[] = new Array(54);
  for (let i = 0; i < 6; i++) {
    result[9 * i + 4] = CENTER_INDEX_TO_LETTER[state.center[i]!]!;
  }
  for (let i = 0; i < 8; i++) {
    const corner = state.cp[i]!;
    const ori = state.co[i]!;
    for (let n = 0; n < 3; n++) {
      result[CORNER_FACELETS[i]![(n + ori) % 3]!] = REF_CORNER[corner]![n]!;
    }
  }
  for (let i = 0; i < 12; i++) {
    const edge = state.ep[i]!;
    const ori = state.eo[i]!;
    for (let n = 0; n < 2; n++) {
      result[EDGE_FACELETS[i]![(n + ori) % 2]!] = REF_EDGE[edge]![n]!;
    }
  }
  return result.join('');
}

/** 角块位置置换的奇偶（与 cubejs `cornerParity` 一致） */
export function cornerPermutationParity(cp: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < i; j++) {
      if (cp[j]! > cp[i]!) s++;
    }
  }
  return s % 2;
}

/** 棱块位置置换的奇偶（与 cubejs `edgeParity` 一致） */
export function edgePermutationParity(ep: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < i; j++) {
      if (ep[j]! > ep[i]!) s++;
    }
  }
  return s % 2;
}

/** 是否为 `buildCube` 出参中的「未知」占位 */
export function isUnknownSlot(v: number): boolean {
  return v === -1;
}
