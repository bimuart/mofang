/**
 * 基于已填贴纸，为每个空格推断可选颜色候选集。
 *
 * 当前实现：`computeQuantityOnlyCandidates` 仅使用「数量/局部」约束：
 *  1. 色数上限     每种颜色至多 9 次（全体贴纸）
 *     棱贴纸       每种颜色至多 4 次（24 个棱位）
 *     角贴纸       每种颜色至多 4 次（24 个角位）
 *  2. 棱块         两格不同色、不对色；合法棱身份；已出现棱身份不重复
 *  3. 角块         三格互异、无对色；合法角身份；手性；已出现角身份不重复
 *
 * 以下五个函数对应全局可解性约束（角扭转和、棱翻转奇偶、置换奇偶等），
 * 暂不用于候选剪枝，保留供后续接入：
 *  `cornerOri`、`edgeOri`、`permParity`、`isValidComplete`（内部用 cubejs 读 cp/co/ep/eo）。
 */

import Cube from 'cubejs';
import type { FaceId } from './types';
import { FACES, FACE_ORDER_URFDLB } from './types';
import { CORNER_FACELETS, EDGE_FACELETS } from './faceletGeometry';
import { isEmptyCell } from './cellValue';

// ── 常量 ─────────────────────────────────────────────────────────────

const OPP: Record<FaceId, FaceId> = { U: 'D', D: 'U', L: 'R', R: 'L', F: 'B', B: 'F' };

/** 8 个角块的参考顺序（与 legality.ts / cubejs 一致） */
const REF_CORNER: readonly (readonly [FaceId, FaceId, FaceId])[] = [
  ['U', 'R', 'F'], ['U', 'F', 'L'], ['U', 'L', 'B'], ['U', 'B', 'R'],
  ['D', 'F', 'R'], ['D', 'L', 'F'], ['D', 'B', 'L'], ['D', 'R', 'B'],
];

/** 12 条棱的参考顺序（与 legality.ts / cubejs 一致） */
const REF_EDGE: readonly (readonly [FaceId, FaceId])[] = [
  ['U', 'R'], ['U', 'F'], ['U', 'L'], ['U', 'B'],
  ['D', 'R'], ['D', 'F'], ['D', 'L'], ['D', 'B'],
  ['F', 'R'], ['F', 'L'], ['B', 'L'], ['B', 'R'],
];

const VALID_CORNER_KEYS = new Set(REF_CORNER.map(r => [...r].sort().join('')));
const VALID_EDGE_KEYS   = new Set(REF_EDGE  .map(r => [...r].sort().join('')));

/** 每种颜色在棱贴纸 / 角贴纸上出现次数的上限（与实体魔方一致：各 4） */
const MAX_PER_COLOR_ON_EDGES = 4;
const MAX_PER_COLOR_ON_CORNERS = 4;

// ── 工具函数（含全局约束用，候选计算当前未调用）────────────────────────

function sortKey(cs: readonly string[]) { return [...cs].sort().join(''); }
function isFaceId(c: string): c is FaceId { return (FACES as readonly string[]).includes(c); }

/**
 * 返回角块三元组 t 相对于角块 j 参考顺序的扭转量（0/1/2），若非合法循环置换则返回 null。
 * 约定：t[m] = ref[(m − ori + 3) mod 3]（与 legality.ts isCornerCyclicTwist 一致）。
 */
function cornerOri(t: readonly [FaceId, FaceId, FaceId], j: number): number | null {
  const ref = REF_CORNER[j]!;
  for (let ori = 0; ori < 3; ori++) {
    if (
      t[0] === ref[(3 - ori) % 3] &&
      t[1] === ref[(4 - ori) % 3] &&
      t[2] === ref[(5 - ori) % 3]
    ) return ori;
  }
  return null;
}

/**
 * 按 CORNER_FACELETS 槽位顺序 (0,1,2) 校验手性：至少两格已有颜色时可判定。
 * - 三格齐全：须为某一角块身份的合法循环置换，且 multiset 未被其它已填角占用。
 * - 恰两格有颜色：第三格用该角块身份唯一确定，若存在某身份 j 使补全后 `cornerOri(full,j) !== null` 则通过。
 * - 少于一格：无法由手性单独约束，返回 true（由调用方做其它过滤）。
 */
function cornerSlotChiralityOk(
  slotTriple: readonly [FaceId | null, FaceId | null, FaceId | null],
  usedCK: ReadonlySet<string>,
): boolean {
  let n = 0;
  for (let m = 0; m < 3; m++) {
    const x = slotTriple[m];
    if (x !== null && isFaceId(x)) n++;
  }
  if (n < 2) return true;

  if (n === 3) {
    const t = [slotTriple[0]!, slotTriple[1]!, slotTriple[2]!] as [FaceId, FaceId, FaceId];
    const key = sortKey(t);
    if (!VALID_CORNER_KEYS.has(key)) return false;
    if (usedCK.has(key)) return false;
    const j = REF_CORNER.findIndex((r) => sortKey([...r]) === key);
    if (j < 0) return false;
    return cornerOri(t, j) !== null;
  }

  const nullIdx = slotTriple.findIndex((x) => x === null || !isFaceId(x as string));
  const vals = [slotTriple[0], slotTriple[1], slotTriple[2]].filter(
    (x): x is FaceId => x !== null && isFaceId(x),
  );
  if (vals.length !== 2 || nullIdx < 0) return true;

  const [v0, v1] = vals;
  for (let j = 0; j < 8; j++) {
    const ref = REF_CORNER[j]!;
    if (!ref.includes(v0) || !ref.includes(v1)) continue;
    const z = ref.find((c) => c !== v0 && c !== v1) as FaceId | undefined;
    if (z === undefined) continue;
    const full: [FaceId, FaceId, FaceId] = [
      nullIdx === 0 ? z : (slotTriple[0] as FaceId),
      nullIdx === 1 ? z : (slotTriple[1] as FaceId),
      nullIdx === 2 ? z : (slotTriple[2] as FaceId),
    ];
    const key = sortKey(full);
    if (usedCK.has(key)) continue;
    if (cornerOri(full, j) !== null) return true;
  }
  return false;
}

/**
 * 棱块翻转量：0 = 未翻转（good），1 = 已翻转（bad）。
 * 与 cubejs eo 约定一致：
 *   - U/D 层棱位（面 0 为 U/D）：槽 0 贴纸为 U/D 色时为 0
 *   - 赤道层棱位（面 0 为 F/B）：槽 0 贴纸为 F/B 色时为 0
 * @param e   棱位索引 0–11
 * @param ca  EDGE_FACELETS[e][0] 处的贴纸颜色
 */
function edgeOri(e: number, ca: FaceId): 0 | 1 {
  const face0 = FACE_ORDER_URFDLB[Math.floor(EDGE_FACELETS[e]![0]! / 9)]!;
  if (face0 === 'U' || face0 === 'D') return (ca === 'U' || ca === 'D') ? 0 : 1;
  return (ca === 'F' || ca === 'B') ? 0 : 1;
}

/** 置换奇偶性：0 = 偶置换，1 = 奇置换。 */
function permParity(p: number[]): 0 | 1 {
  const vis = new Uint8Array(p.length);
  let par = 0;
  for (let i = 0; i < p.length; i++) {
    if (vis[i]) continue;
    let len = 0, j = i;
    while (!vis[j]) { vis[j] = 1; j = p[j]!; len++; }
    if (len % 2 === 0) par ^= 1;
  }
  return par as 0 | 1;
}

/** 用 cubejs 验证完整 54 格串是否满足约束 A–D（角扭转和、棱翻转数、置换奇偶）。 */
function isValidComplete(s: string): boolean {
  try {
    const cube = Cube.fromString(s);
    const { cp, co, ep, eo } = cube.toJSON();
    return (
      permParity([...cp]) === permParity([...ep]) &&
      (co as number[]).reduce((a: number, b: number) => a + b, 0) % 3 === 0 &&
      (eo as number[]).reduce((a: number, b: number) => a + b, 0) % 2 === 0
    );
  } catch {
    return false;
  }
}

// ── 主函数 ───────────────────────────────────────────────────────────

/**
 * 对 54 个贴纸位置，基于色数与棱/角块局部约束推断每格可选颜色（不含全局扭转/翻转/奇偶剪枝）。
 *
 * - 已填格：仅返回其当前颜色（`[currentColor]`）。
 * - 空格：返回满足约束的颜色子集（可能为空，代表已矛盾）。
 * - 棱格候选另受「该色在全部棱贴纸上已出现次数少于 4」限制；角格同理。
 */
export function computeQuantityOnlyCandidates(facelets: string): readonly (readonly FaceId[])[] {
  if (facelets.length !== 54) return Array.from({ length: 54 }, () => [...FACES]);

  // ── 1. 统计各色已用次数（全体 / 仅棱位 / 仅角位）──
  const cnt: Record<FaceId, number> = { U: 0, D: 0, L: 0, R: 0, F: 0, B: 0 };
  const cntEdge: Record<FaceId, number> = { U: 0, D: 0, L: 0, R: 0, F: 0, B: 0 };
  const cntCorner: Record<FaceId, number> = { U: 0, D: 0, L: 0, R: 0, F: 0, B: 0 };
  for (let i = 0; i < 54; i++) {
    const c = facelets[i]!;
    if (isFaceId(c)) cnt[c]++;
  }
  for (let e = 0; e < 12; e++) {
    for (const idx of EDGE_FACELETS[e]!) {
      const c = facelets[idx]!;
      if (isFaceId(c)) cntEdge[c]++;
    }
  }
  for (let k = 0; k < 8; k++) {
    for (const idx of CORNER_FACELETS[k]!) {
      const c = facelets[idx]!;
      if (isFaceId(c)) cntCorner[c]++;
    }
  }

  // ── 2. 建立全局下标 → 块归属映射 ──
  const cornerOf = new Map<number, [number, number]>(); // [角位, 槽位]
  for (let c = 0; c < 8; c++)
    for (let s = 0; s < 3; s++) cornerOf.set(CORNER_FACELETS[c]![s]!, [c, s]);
  const edgeOf = new Map<number, [number, number]>(); // [棱位, 槽位]
  for (let e = 0; e < 12; e++) {
    edgeOf.set(EDGE_FACELETS[e]![0]!, [e, 0]);
    edgeOf.set(EDGE_FACELETS[e]![1]!, [e, 1]);
  }

  // ── 3. 已完全确定的角块（三格全填）→ 占用身份键 ──
  const usedCK = new Set<string>();
  for (let c = 0; c < 8; c++) {
    const [a, b, d] = CORNER_FACELETS[c]!;
    const t = [facelets[a]!, facelets[b]!, facelets[d]!];
    if (!t.every(isFaceId)) continue;
    const triple = t as [FaceId, FaceId, FaceId];
    usedCK.add(sortKey(triple));
  }

  // ── 4. 已完全确定的棱块（两格全填）→ 占用身份键 ──
  const usedEK = new Set<string>();
  for (let e = 0; e < 12; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    const ca = facelets[a]!, cb = facelets[b]!;
    if (!isFaceId(ca) || !isFaceId(cb)) continue;
    usedEK.add(sortKey([ca, cb]));
  }

  // ── 5. 逐格计算候选（仅局部 + 色数）──
  const result: (readonly FaceId[])[] = [];

  for (let i = 0; i < 54; i++) {
    const ch = facelets[i]!;

    if (!isEmptyCell(ch)) {
      result.push(isFaceId(ch) ? [ch as FaceId] : []);
      continue;
    }

    let cands: FaceId[] = FACES.filter((c) => cnt[c] < 9);

    const ci = cornerOf.get(i);
    const ei = edgeOf.get(i);

    if (ci) {
      cands = cands.filter((c) => cntCorner[c] < MAX_PER_COLOR_ON_CORNERS);
      const [cPos, cSlot] = ci;
      const tri = CORNER_FACELETS[cPos]!;
      const readSlot = (slot: number): FaceId | null => {
        const ch = facelets[tri[slot]!]!;
        return isFaceId(ch) ? ch : null;
      };

      cands = cands.filter((c) => {
        for (let s = 0; s < 3; s++) {
          if (s === cSlot) continue;
          const k = readSlot(s);
          if (k === c) return false;
          if (k !== null && OPP[k] === c) return false;
        }

        const slotTriple: [FaceId | null, FaceId | null, FaceId | null] = [
          cSlot === 0 ? c : readSlot(0),
          cSlot === 1 ? c : readSlot(1),
          cSlot === 2 ? c : readSlot(2),
        ];

        let filled = 0;
        for (let m = 0; m < 3; m++) {
          if (slotTriple[m] !== null && isFaceId(slotTriple[m]!)) filled++;
        }
        if (filled < 2 && !REF_CORNER[cPos].includes(c)) return false;

        return cornerSlotChiralityOk(slotTriple, usedCK);
      });
    } else if (ei) {
      cands = cands.filter((c) => cntEdge[c] < MAX_PER_COLOR_ON_EDGES);
      const [ePos, eSlot] = ei;
      const pair = EDGE_FACELETS[ePos]!;
      const otherVal = facelets[pair[eSlot === 0 ? 1 : 0]!]!;

      if (isFaceId(otherVal)) {
        cands = cands.filter((c) => {
          if (c === otherVal) return false;
          if (OPP[otherVal] === c) return false;
          const key = sortKey([c, otherVal]);
          if (!VALID_EDGE_KEYS.has(key)) return false;
          if (usedEK.has(key)) return false;
          return true;
        });
      }
    }

    result.push(cands);
  }

  return result;
}

/** @deprecated 使用 {@link computeQuantityOnlyCandidates} */
export const computeAllCandidates = computeQuantityOnlyCandidates;

/** 全局约束工具（角扭转 / 棱翻转 / 置换奇偶 / cubejs 校验），当前未参与候选剪枝。 */
export { edgeOri, permParity, isValidComplete };
