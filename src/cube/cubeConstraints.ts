import type { FaceId } from './types';
import {
  buildCube,
  cornerPermutationParity,
  edgePermutationParity,
  faceletsFromCubeState,
  isCubeStateFullyDetermined,
  isPermutationCube,
  resolveCornerSlot,
  type CubeStateJSON,
} from './buildCube';
import { EMPTY_FACELET, isEmptyCell } from './cellValue';
import { FACES, FACE_ORDER_URFDLB } from './types';
import {
  CENTER_INDICES,
  CORNER_FACELETS,
  EDGE_FACELETS,
} from './faceletGeometry';

/**
 * 本模块集中：合法性分层校验（`validateLegality`）、约束行展示、棱/角补全枚举，
 * 以及约束 C（棱翻转偶数）等可复用判定。
 */

export type LegalityIssue = {
  /** 分类：color | piece | orientation | group */
  category: 'color' | 'piece' | 'orientation' | 'group';
  code: string;
  message: string;
  /** 需高亮的贴纸全局下标 0–53 */
  cellIndices: number[];
};

/** 校验在何处提前结束（后续约束未执行） */
export type ValidationStop = 'LEN' | 'CHAR' | null;

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
  /** 棱块（局部）匹配项通过时：活跃槽数 `a` 与完整指派方案数 `c`（无活跃槽或两格同色/对色时不设） */
  edgeLocalPassSummary?: { a: number; c: number };
  /** 角块（局部）匹配项通过时：活跃槽数 `a` 与完整指派方案数 `c`（无活跃槽或结构错误未进入匹配时不设） */
  cornerLocalPassSummary?: { a: number; c: number };
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
  /** 本组 `codes` 命中的 `LegalityIssue.message`，与 push 文案一致 */
  messages: readonly string[];
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
    description:
      '未填格由 `buildCube` 在对应分量上记为 -1；约束 A、几何一致、B/C/D 仅在全部槽位已解析且为合法置换时执行。',
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
      '至少一面已填的棱槽须能与 `REF_EDGE` 中 12 条物理棱建立一一对应：槽位已填颜色须为该棱颜色的子集（两面均填则须与该棱无序色一致）。以最大匹配检验。',
    codes: ['EDGE_SAME', 'EDGE_OPP', 'EDGE_UNIQUE'],
  },
  {
    id: 'corner_local',
    title: '角块（局部）',
    description:
      '至少一面已填的角槽须能与 `REF_CORNER` 中 8 个物理角建立一一对应：已填格须与某块在某扭转 `ori` 下的三面颜色一致（几何位置敏感，非仅 multiset）；以最大匹配检验。',
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
    description:
      '已填格与由 `buildCube` 状态展开的面串一致（与 cubejs `asString` 同规则）；未决槽位为 -1 时不做此项。',
    codes: ['FACELET_MISMATCH'],
  },
  {
    id: 'twist_b',
    title: '约束 B · 角扭转',
    description:
      '八个角槽各三格均为有效面色且 `cp`/`co` 可解出时：扭转量之和须 ≡ 0 (mod 3)；若尚存在整角三格均未填，则不判该项违反。每个角槽至少一格为有效色且尚未全部三格填齐时：须存在至少一种合法角补全（`enumerateCornerFillCubeStates`，含 mod 3 过滤）；未满足「每角至少一格」时本项通过。',
    codes: ['TWIST_SUM_FULL', 'TWIST_SUM_PARTIAL'],
  },
  {
    id: 'flip_c',
    title: '约束 C · 棱翻转',
    description:
      '十二条棱两格均为有效面色且 `ep`/`eo` 可解出时：已翻转棱条数须为偶数；若尚存在整棱两格均未填，则不判该项违反。每条棱槽至少一格为有效色且尚未全部两格填齐时：须存在至少一种合法棱补全（`enumerateEdgeFillCubeStates`，含偶翻转过滤）；未满足「每槽至少一格」时本项通过。',
    codes: ['EDGE_FLIP_FULL', 'EDGE_FLIP_PARTIAL'],
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

function messagesForGroup(issues: LegalityIssue[], codes: readonly string[]): string[] {
  const out: string[] = [];
  for (const iss of issues) {
    if (!codes.includes(iss.code)) continue;
    out.push(iss.message);
  }
  return out;
}

function edgeLocalHasTwoStickerSameOrOpposite(facelets54: string): boolean {
  for (let e = 0; e < EDGE_FACELETS.length; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    const ca = facelets54[a]!;
    const cb = facelets54[b]!;
    if (!isFaceId(ca) || !isFaceId(cb)) continue;
    if (ca === cb || OPP[ca] === cb) return true;
  }
  return false;
}

/** 无两格同色/对色前提下：活跃槽与 `a,b,c`；若无活跃槽返回 null。 */
function edgeLocalComputeAbc(facelets54: string): { a: number; b: number; c: number } | null {
  const activeSlots: number[] = [];
  for (let e = 0; e < 12; e++) {
    if (edgeSlotHasAtLeastOneFaceColor(facelets54, e)) activeSlots.push(e);
  }
  const a = activeSlots.length;
  if (a === 0) return null;
  const adj: boolean[][] = activeSlots.map((e) =>
    Array.from({ length: 12 }, (_, j) => edgeSlotCompatibleWithRefPiece(facelets54, e, j)),
  );
  const b = maxMatchingBipartite(adj, 12);
  const c = b < a ? 0 : countSaturatingInjections(adj, 12);
  return { a, b, c };
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
        messages: [],
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
        messages: [],
      };
    }
    if (skipping) {
      return {
        id: g.id,
        title: g.title,
        description: g.description,
        status: 'skipped' as const,
        cellIndices: [],
        messages: [],
      };
    }
    const cellIndices = mergeCodesForGroup(issues, g.codes);
    const failed = issues.some((iss) => g.codes.includes(iss.code));
    const fromIssues = messagesForGroup(issues, g.codes);
    let messages = fromIssues;
    if (g.id === 'edge_local' && !failed && report.edgeLocalPassSummary) {
      messages = [
        `棱块（局部）通过：活跃棱槽 a=${report.edgeLocalPassSummary.a}；每条活跃槽到互异 REF 下标的完整指派方案数 c=${report.edgeLocalPassSummary.c}。`,
        ...fromIssues,
      ];
    } else if (g.id === 'corner_local' && !failed && report.cornerLocalPassSummary) {
      messages = [
        `角块（局部）通过：活跃角槽 a=${report.cornerLocalPassSummary.a}；每条活跃槽到互异 REF 下标的完整指派方案数 c=${report.cornerLocalPassSummary.c}。`,
        ...fromIssues,
      ];
    }
    return {
      id: g.id,
      title: g.title,
      description: g.description,
      status: failed ? ('fail' as const) : ('pass' as const),
      cellIndices,
      messages,
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

/**
 * 是否存在某条几何棱槽 **两格均未填** 有效面色（`.` 等）。
 * 此时约束 C 的「偶翻转」严检不执行：末棱取向未定，总翻转奇偶仍可能通过该棱两种贴法之一凑成偶数（与十二条棱槽均已填有效面色互斥）。
 */
export function hasGeometricEdgeWithBothStickersEmpty(facelets54: string): boolean {
  if (facelets54.length !== 54) return false;
  for (let e = 0; e < EDGE_FACELETS.length; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    const ca = facelets54[a]!;
    const cb = facelets54[b]!;
    if (!isFaceId(ca) && !isFaceId(cb)) return true;
  }
  return false;
}

/**
 * 十二条几何棱槽各自至少有一格为有效面色（另一格可为空）。
 * 用于约束 C 非完全填充分支是否进入枚举判断。
 */
export function allEdgeSlotsAtLeastOneFaceletFilled(facelets54: string): boolean {
  if (facelets54.length !== 54) return false;
  for (let e = 0; e < EDGE_FACELETS.length; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    const ca = facelets54[a]!;
    const cb = facelets54[b]!;
    if (!isFaceId(ca) && !isFaceId(cb)) return false;
  }
  return true;
}

/**
 * 十二条几何棱槽两格均为有效面色（「棱完全填充」）。
 * 用于 `satisfiesEdgeFlipConstraint` 与约束 C 非完全填充分支的互斥判断。
 */
export function allEdgeSlotsBothFaceletsFilled(facelets54: string): boolean {
  if (facelets54.length !== 54) return false;
  for (let e = 0; e < EDGE_FACELETS.length; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    if (!isFaceId(facelets54[a]!) || !isFaceId(facelets54[b]!)) return false;
  }
  return true;
}

/** 八个角槽各自至少有一格为有效面色（另一格或两格可为空）。 */
export function allCornerSlotsAtLeastOneFaceletFilled(facelets54: string): boolean {
  if (facelets54.length !== 54) return false;
  for (let c = 0; c < CORNER_FACELETS.length; c++) {
    const [a, b, d] = CORNER_FACELETS[c]!;
    const ca = facelets54[a]!;
    const cb = facelets54[b]!;
    const cd = facelets54[d]!;
    if (!isFaceId(ca) && !isFaceId(cb) && !isFaceId(cd)) return false;
  }
  return true;
}

/** 八个角槽三格均为有效面色（「角完全填充」）。 */
export function allCornerSlotsThreeFaceletsFilled(facelets54: string): boolean {
  if (facelets54.length !== 54) return false;
  for (let c = 0; c < CORNER_FACELETS.length; c++) {
    const [a, b, d] = CORNER_FACELETS[c]!;
    if (!isFaceId(facelets54[a]!) || !isFaceId(facelets54[b]!) || !isFaceId(facelets54[d]!)) return false;
  }
  return true;
}

/**
 * 是否与「约束 B · 角扭转」在 **完全填充** 情形下的 mod 3 判定一致（供 `TWIST_SUM_FULL` 与枚举过滤共用）。
 * 若存在整角三格均未填、或尚未三格均填、或尚不能从贴纸解出完整 `co`，则不据此判失败，返回 `true`。
 */
export function satisfiesCornerTwistConstraint(
  state: { cp: readonly number[]; co: readonly number[] },
  facelets54: string,
): boolean {
  if (facelets54.length !== 54) return false;

  for (let c = 0; c < CORNER_FACELETS.length; c++) {
    const [a, b, d] = CORNER_FACELETS[c]!;
    const ca = facelets54[a]!;
    const cb = facelets54[b]!;
    const cd = facelets54[d]!;
    if (!isFaceId(ca) && !isFaceId(cb) && !isFaceId(cd)) return true;
  }

  if (
    !allCornerSlotsThreeFaceletsFilled(facelets54) ||
    !isPermutationCube(state.cp, 8) ||
    state.co.some((x) => x < 0)
  ) {
    return true;
  }

  const sumCo = state.co.reduce((acc, x) => acc + x, 0);
  return sumCo % 3 === 0;
}

/**
 * 是否与「约束 C ·       」在 **完全填充** 情形下的偶数翻转判定一致（供 `EDGE_FLIP_FULL` 与枚举过滤共用）。
 * 若存在整棱两格均未填、或尚未两格均填、或尚不能从贴纸解出完整 `eo`，则不据此判失败，返回 `true`。
 * @returns 可严检且 `sum(eo)` 为奇时 `false`，否则 `true`（含不适用）。
 */
export function satisfiesEdgeFlipConstraint(
  state: { ep: readonly number[]; eo: readonly number[] },
  facelets54: string,
): boolean {
  if (facelets54.length !== 54) return false;

  for (let e = 0; e < EDGE_FACELETS.length; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    const ca = facelets54[a]!;
    const cb = facelets54[b]!;
    if (!isFaceId(ca) && !isFaceId(cb)) return true;
  }

  if (
    !allEdgeSlotsBothFaceletsFilled(facelets54) ||
    !isPermutationCube(state.ep, 12) ||
    state.eo.some((x) => x < 0)
  ) {
    return true;
  }

  const flipCount = state.eo.reduce((acc, x) => acc + x, 0);
  return flipCount % 2 === 0;
}

function enumerateResolveEdgeSlotFromColors(ca: FaceId, cb: FaceId): { j: number; eo: number } | null {
  for (let j = 0; j < 12; j++) {
    const ref = REF_EDGE[j]!;
    if (ca === ref[0] && cb === ref[1]) return { j, eo: 0 };
    if (ca === ref[1] && cb === ref[0]) return { j, eo: 1 };
  }
  return null;
}

function enumeratePartnerFaceIdsForEdge(c: FaceId): FaceId[] {
  const out: FaceId[] = [];
  for (const f of FACES) {
    if (VALID_EDGE_KEYS.has(sortFaceKey([c, f]))) out.push(f);
  }
  return out;
}

/** 棱补全枚举的一项：内部状态与补全后的 54 位面串（非棱格与输入一致） */
export type EdgeFillEnumerationEntry = {
  state: CubeStateJSON;
  facelets54: string;
};

/**
 * 在「每个棱槽（`EDGE_FACELETS`）至少已有一格为有效面色」的前提下，枚举补全另一格的所有合法方式，
 * 并对每种补全后的 54 串调用 `buildCube`，收集无棱矛盾（`ep` 为置换、无 -1）的项。
 *
 * 非棱格与输入一致；返回前按完全填充情形下的棱翻转偶性过滤（与 `satisfiesEdgeFlipConstraint` 一致）。
 */
export function enumerateEdgeFillCubeStates(facelets54: string): EdgeFillEnumerationEntry[] {
  if (facelets54.length !== 54) {
    throw new Error(`enumerateEdgeFillCubeStates: 须恰好 54 个字符，当前 ${facelets54.length}`);
  }

  const chars = [...facelets54];
  const occupiedKeys = new Set<string>();
  type Gap = { slot: number; fillIdx: 0 | 1; otherColor: FaceId };
  const gaps: Gap[] = [];

  for (let slot = 0; slot < EDGE_FACELETS.length; slot++) {
    const [ia, ib] = EDGE_FACELETS[slot]!;
    const ca = chars[ia]!;
    const cb = chars[ib]!;
    const fa = isFaceId(ca);
    const fb = isFaceId(cb);
    if (!fa && !fb) return [];
    if (fa && fb) {
      const r = enumerateResolveEdgeSlotFromColors(ca, cb);
      if (r === null) return [];
      const k = sortFaceKey([ca, cb]);
      if (occupiedKeys.has(k)) return [];
      occupiedKeys.add(k);
      continue;
    }
    if (fa) {
      gaps.push({ slot, fillIdx: 1, otherColor: ca });
    } else {
      if (!isFaceId(cb)) return [];
      gaps.push({ slot, fillIdx: 0, otherColor: cb });
    }
  }

  const results: EdgeFillEnumerationEntry[] = [];
  const seen = new Set<string>();

  const dfs = (gi: number): void => {
    if (gi >= gaps.length) {
      const joined = chars.join('');
      const s = buildCube(joined);
      if (!s.ep.every((v) => v >= 0) || !s.eo.every((v) => v >= 0)) return;
      if (!isPermutationCube(s.ep, 12)) return;
      const key = JSON.stringify(s);
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ state: s, facelets54: joined });
      return;
    }

    const { slot, fillIdx, otherColor } = gaps[gi]!;
    const [ia, ib] = EDGE_FACELETS[slot]!;
    const fillGlobal = fillIdx === 0 ? ia : ib;
    const prev = chars[fillGlobal]!;

    for (const cand of enumeratePartnerFaceIdsForEdge(otherColor)) {
      const ca = fillIdx === 0 ? cand : otherColor;
      const cb = fillIdx === 1 ? cand : otherColor;
      const k = sortFaceKey([ca, cb]);
      if (occupiedKeys.has(k)) continue;
      occupiedKeys.add(k);
      chars[fillGlobal] = cand;
      dfs(gi + 1);
      chars[fillGlobal] = prev;
      occupiedKeys.delete(k);
    }
  };

  dfs(0);
  return results.filter((entry) =>
    satisfiesEdgeFlipConstraint(entry.state, entry.facelets54),
  );
}

/** 角补全枚举的一项：内部状态与补全后的 54 位面串（非角格与输入一致）。 */
export type CornerFillEnumerationEntry = {
  state: CubeStateJSON;
  facelets54: string;
};

/**
 * 在「每个角槽（`CORNER_FACELETS`）至少已有一格为有效面色」的前提下，枚举补全空格：
 * 已填三格者须可 `resolveCornerSlot`；已填两格者唯一补第三格；仅填一格者 DFS 尝试 8×3 种 (块, 扭转)。
 * 对每种补全后的 54 串调用 `buildCube`，收集 `cp`/`ep` 均为置换且 `co`/`eo` 无 -1 的项；返回前按完全填充情形下的角扭转 mod 3 过滤（与 `satisfiesCornerTwistConstraint` 一致）。
 */
export function enumerateCornerFillCubeStates(facelets54: string): CornerFillEnumerationEntry[] {
  if (facelets54.length !== 54) {
    throw new Error(`enumerateCornerFillCubeStates: 须恰好 54 个字符，当前 ${facelets54.length}`);
  }

  const chars = [...facelets54];
  const occupiedKeys = new Set<string>();
  const oneFilledSlots: number[] = [];

  function writeThirdFromResolved(slot: number, j: number, ori: number): void {
    const [ia, ib, ic] = CORNER_FACELETS[slot]!;
    const ref = REF_CORNER[j]!;
    const ids = [ia, ib, ic];
    for (let m = 0; m < 3; m++) {
      const g = ids[m]!;
      if (!isFaceId(chars[g]!)) chars[g] = ref[(m - ori + 3) % 3]!;
    }
  }

  for (let slot = 0; slot < 8; slot++) {
    const [ia, ib, ic] = CORNER_FACELETS[slot]!;
    const ca = chars[ia]!;
    const cb = chars[ib]!;
    const cc = chars[ic]!;
    const fa = isFaceId(ca);
    const fb = isFaceId(cb);
    const fc = isFaceId(cc);
    const n = (fa ? 1 : 0) + (fb ? 1 : 0) + (fc ? 1 : 0);
    if (n === 0) return [];
    if (n === 3) {
      const r = resolveCornerSlot(chars.join(''), slot);
      if (r === null) return [];
      const k = sortFaceKey([ca, cb, cc]);
      if (occupiedKeys.has(k)) return [];
      occupiedKeys.add(k);
      continue;
    }
    if (n === 2) {
      const r = resolveCornerSlot(chars.join(''), slot);
      if (r === null) return [];
      writeThirdFromResolved(slot, r.j, r.ori);
      const k = sortFaceKey([chars[ia]!, chars[ib]!, chars[ic]!]);
      if (occupiedKeys.has(k)) return [];
      occupiedKeys.add(k);
      continue;
    }
    oneFilledSlots.push(slot);
  }

  const results: CornerFillEnumerationEntry[] = [];
  const seen = new Set<string>();

  const dfs = (gi: number): void => {
    if (gi >= oneFilledSlots.length) {
      const joined = chars.join('');
      const s = buildCube(joined);
      if (!s.cp.every((v) => v >= 0) || !s.co.every((v) => v >= 0)) return;
      if (!isPermutationCube(s.cp, 8) || !isPermutationCube(s.ep, 12)) return;
      if (!s.eo.every((v) => v >= 0)) return;
      const key = JSON.stringify(s);
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ state: s, facelets54: joined });
      return;
    }

    const slot = oneFilledSlots[gi]!;
    const [ia, ib, ic] = CORNER_FACELETS[slot]!;
    const ids = [ia, ib, ic] as const;
    const prev: [string, string, string] = [chars[ia]!, chars[ib]!, chars[ic]!];

    let knownM = -1;
    let knownC = 'U' as FaceId;
    for (let m = 0; m < 3; m++) {
      const ch = chars[ids[m]!]!;
      if (isFaceId(ch)) {
        knownM = m;
        knownC = ch;
        break;
      }
    }
    if (knownM < 0) return;

    for (let j = 0; j < 8; j++) {
      const ref = REF_CORNER[j]!;
      for (let ori = 0; ori < 3; ori++) {
        if (ref[(knownM - ori + 3) % 3] !== knownC) continue;
        for (let m = 0; m < 3; m++) {
          chars[ids[m]!] = ref[(m - ori + 3) % 3]!;
        }

        const k = sortFaceKey([ref[0]!, ref[1]!, ref[2]!]);
        if (occupiedKeys.has(k)) {
          for (let m = 0; m < 3; m++) chars[ids[m]!] = prev[m]!;
          continue;
        }
        occupiedKeys.add(k);
        dfs(gi + 1);
        occupiedKeys.delete(k);
        for (let m = 0; m < 3; m++) chars[ids[m]!] = prev[m]!;
      }
    }
  };

  dfs(0);
  return results.filter((entry) =>
    satisfiesCornerTwistConstraint(entry.state, entry.facelets54),
  );
}

/** 十二条棱共 24 个贴纸的全局下标（用于约束 C 等问题的高亮范围）。 */
function allEdgeFaceletGlobalIndices(): number[] {
  const cells: number[] = [];
  for (const pair of EDGE_FACELETS) {
    for (const i of pair) cells.push(i);
  }
  return cells;
}

/** 八个角槽共 24 个贴纸的全局下标（用于约束 B 等问题的高亮范围）。 */
function allCornerFaceletGlobalIndices(): number[] {
  const cells: number[] = [];
  for (const tri of CORNER_FACELETS) {
    for (const i of tri) cells.push(i);
  }
  return cells;
}

/** 向当前校验 `issues` 追加一条违规记录（由 `validateLegality` 注入闭包）。 */
type LegalityPush = (
  category: LegalityIssue['category'],
  code: string,
  message: string,
  cellIndices: number[],
) => void;

/**
 * 约束 C · 棱翻转（**完全填充**分支，issue：`EDGE_FLIP_FULL`）。
 * 十二条棱两格均为有效面色且 `ep`/`eo` 已可解出时，已翻转棱数须为偶；未满棱或不可判 `eo` 时不写入 issue。
 */
function pushEdgeFlipIssuesWhenFullyFilled(
  facelets54: string,
  state: CubeStateJSON,
  pushIssue: LegalityPush,
): void {
  if (satisfiesEdgeFlipConstraint(state, facelets54)) return;
  pushIssue(
    'group',
    'EDGE_FLIP_FULL',
    '已翻转棱块数须为偶数（约束 C）。',
    allEdgeFaceletGlobalIndices(),
  );
}

/**
 * 约束 C · 棱翻转（**非完全填充**分支，issue：`EDGE_FLIP_PARTIAL`）。
 * 每槽至少一格有效色且尚未全部两格填齐时，须存在至少一种通过 `enumerateEdgeFillCubeStates`（含完全填充偶翻转过滤）的补全；否则写入 issue。
 */
function pushEdgeFlipIssuesWhenPartiallyFilled(facelets54: string, pushIssue: LegalityPush): void {
  if (!allEdgeSlotsAtLeastOneFaceletFilled(facelets54) || allEdgeSlotsBothFaceletsFilled(facelets54)) {
    return;
  }
  if (enumerateEdgeFillCubeStates(facelets54).length > 0) return;
  pushIssue(
    'group',
    'EDGE_FLIP_PARTIAL',
    '每条棱至少一侧为有效色时，须存在至少一种合法棱补全（枚举为空，约束 C）。',
    allEdgeFaceletGlobalIndices(),
  );
}

/** 收集面串中为未填占位符（如 `.`）的格下标，供 `INCOMPLETE` 使用。 */
function emptyFaceletIndices(facelets54: string): number[] {
  const emptyCells: number[] = [];
  for (let i = 0; i < 54; i++) {
    if (isEmptyCell(facelets54[i]!)) emptyCells.push(i);
  }
  return emptyCells;
}

/**
 * 约束组 **长度**（`LEN`）：面串须恰好 54 字符。
 * @returns 违反时带 `validationStop: 'LEN'` 的完整报告；否则 `null` 表示继续后续校验。
 */
function legalityValidateLength(
  facelets54: string,
  issues: LegalityIssue[],
  push: LegalityPush,
  disabledChecks: LegalityReport['disabledChecks'],
): LegalityReport | null {
  if (facelets54.length !== 54) {
    push('color', 'LEN', '须恰好 54 个贴纸。', []);
    return {
      ok: false,
      issues,
      illegalCellIndices: mergeIndices(issues),
      validationStop: 'LEN',
      disabledChecks,
      edgeLocalPassSummary: undefined,
      cornerLocalPassSummary: undefined,
    };
  }
  return null;
}

/**
 * 约束组 **字符集**（`CHAR`）并统计六种面色出现次数（供色数 `MULTISET` 使用）。
 * @returns 非法字符时带 `validationStop: 'CHAR'` 的报告；否则 `{ counts }`。
 */
function legalityValidateCharsetAndCountColors(
  facelets54: string,
  issues: LegalityIssue[],
  push: LegalityPush,
  disabledChecks: LegalityReport['disabledChecks'],
): LegalityReport | { counts: Record<FaceId, number> } {
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
    if (isEmptyCell(ch)) continue;
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
      edgeLocalPassSummary: undefined,
      cornerLocalPassSummary: undefined,
    };
  }
  return { counts };
}

/**
 * 约束组 **填色完整**（`INCOMPLETE`）：存在未填格时提示后续全局项依赖 `buildCube` 全解析。
 * 不终止校验流程。
 */
function legalityPushIncomplete(facelets54: string, push: LegalityPush): void {
  const emptyCells = emptyFaceletIndices(facelets54);
  if (emptyCells.length === 0) return;
  push(
    'color',
    'INCOMPLETE',
    '存在未填色格；约束 C 在 12 棱均填且 `ep`/`eo` 合法时可检；A、几何一致、B、D 仍须 `buildCube` 全槽可解且 cp/ep 为合法置换。',
    emptyCells,
  );
}

/**
 * 约束组 **色数**（`CENTER_DISTINCT`、`MULTISET`）：六中心须两两不同；每种颜色在已填格中不得超过 9。
 * `checkCenterMultiset` 为 false 时跳过（与 UI 开关一致）。
 */
function legalityPushCenterMultiset(
  facelets54: string,
  counts: Record<FaceId, number>,
  checkCenterMultiset: boolean,
  push: LegalityPush,
): void {
  if (!checkCenterMultiset) return;
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
    if (counts[f]! > 9) {
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

function edgeSlotHasAtLeastOneFaceColor(facelets54: string, e: number): boolean {
  const [a, b] = EDGE_FACELETS[e]!;
  return isFaceId(facelets54[a]!) || isFaceId(facelets54[b]!);
}

/** 槽位已填颜色是否为 `REF_EDGE[j]` 所允许（一面为子集、两面为无序一致）。 */
function edgeSlotCompatibleWithRefPiece(facelets54: string, e: number, j: number): boolean {
  const [a, b] = EDGE_FACELETS[e]!;
  const ca = facelets54[a]!;
  const cb = facelets54[b]!;
  const fa = isFaceId(ca);
  const fb = isFaceId(cb);
  if (!fa && !fb) return false;
  const ref = REF_EDGE[j]!;
  if (fa && fb) {
    return sortFaceKey([ca, cb]) === sortFaceKey(ref);
  }
  const c = (fa ? ca : cb) as FaceId;
  return c === ref[0] || c === ref[1];
}

/**
 * 二分图最大匹配：左部行 `adj[li][j]`，右部顶点数 `nR`。
 * @returns 最大匹配大小（饱和左部当且仅当返回值等于左部顶点数）。
 */
function maxMatchingBipartite(adj: boolean[][], nR: number): number {
  const nL = adj.length;
  const pairR = new Array<number>(nR).fill(-1);

  function dfs(li: number, seen: boolean[]): boolean {
    for (let j = 0; j < nR; j++) {
      if (!adj[li]![j]) continue;
      if (seen[j]) continue;
      seen[j] = true;
      if (pairR[j] < 0 || dfs(pairR[j]!, seen)) {
        pairR[j] = li;
        return true;
      }
    }
    return false;
  }

  let match = 0;
  for (let li = 0; li < nL; li++) {
    if (dfs(li, new Array<boolean>(nR).fill(false))) match++;
  }
  return match;
}

/**
 * 左部 `a` 行、右部 `nR` 列；统计将每行指派到互不相同列且 `adj[li][j]` 为真的方案数 `c`（DP，右部至多 12）。
 * `a=0` 时勿调用；`b<a` 时结果为 0。
 */
function countSaturatingInjections(adj: boolean[][], nR: number): number {
  const nL = adj.length;
  if (nL === 0) return 1;
  const nMask = 1 << nR;
  const memo = new Map<number, number>();

  function key(li: number, mask: number): number {
    return li * nMask + mask;
  }

  function dp(li: number, mask: number): number {
    if (li === nL) return 1;
    const k = key(li, mask);
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let sum = 0;
    for (let j = 0; j < nR; j++) {
      if (mask & (1 << j)) continue;
      if (!adj[li]![j]) continue;
      sum += dp(li + 1, mask | (1 << j));
    }
    memo.set(k, sum);
    return sum;
  }

  return dp(0, 0);
}

/**
 * 约束组 **棱块（局部）**：两格均填时先报同色/对色；再以「活跃棱槽数 a」与「到 REF 的最大匹配 b」检验 a=b；`c` 为饱和左部的指派方案数。
 */
function legalityPushEdgeLocal(facelets54: string, push: LegalityPush): void {
  let twoStickerLocalBad = false;
  for (let e = 0; e < EDGE_FACELETS.length; e++) {
    const [a, b] = EDGE_FACELETS[e]!;
    const ca = facelets54[a]!;
    const cb = facelets54[b]!;
    if (!isFaceId(ca) || !isFaceId(cb)) continue;
    const cells = [a, b];
    if (ca === cb) {
      push('piece', 'EDGE_SAME', `棱位 ${e}：同一棱上两贴纸颜色相同，非法。`, cells);
      twoStickerLocalBad = true;
      continue;
    }
    if (OPP[ca] === cb) {
      push(
        'piece',
        'EDGE_OPP',
        `棱位 ${e}：两色为对色，物理上不存在该棱块。`,
        cells,
      );
      twoStickerLocalBad = true;
    }
  }
  if (twoStickerLocalBad) return;

  const abc = edgeLocalComputeAbc(facelets54);
  if (!abc) return;
  const { a, b, c } = abc;
  if (a === b) return;

  const cells: number[] = [];
  for (let e = 0; e < 12; e++) {
    if (!edgeSlotHasAtLeastOneFaceColor(facelets54, e)) continue;
    const [ia, ib] = EDGE_FACELETS[e]!;
    cells.push(ia, ib);
  }
  push(
    'piece',
    'EDGE_UNIQUE',
    `棱块（局部）：至少一面已填的棱槽 a=${a}；与 REF 的最大一一分配数 b=${b}（须 a=b）；每条活跃槽到互异 REF 下标的完整指派方案数 c=${c}（b<a 时为 0）。`,
    cells,
  );
}

function cornerSlotHasAtLeastOneFaceColor(facelets54: string, c: number): boolean {
  const [a, b, d] = CORNER_FACELETS[c]!;
  return isFaceId(facelets54[a]!) || isFaceId(facelets54[b]!) || isFaceId(facelets54[d]!);
}

/**
 * 是否存在 `ori`，使物理角 `j` 按 cubejs 约定贴在槽位 `c` 上时，每个**已填**面元与 `REF_CORNER[j][(m−ori+3)%3]` 一致。
 * 与 `isCornerCyclicTwist` 一致；已填 2 格时不能用「两色都在 ref 集合里」否则会误通过（如 URF 槽见 U+F 同时匹配 URF 与 UFL）。
 */
function cornerSlotCompatibleWithRefPiece(facelets54: string, c: number, j: number): boolean {
  const [a, b, d] = CORNER_FACELETS[c]!;
  const slot = [facelets54[a]!, facelets54[b]!, facelets54[d]!] as const;
  const ref = REF_CORNER[j]!;

  for (let ori = 0; ori < 3; ori++) {
    let ok = true;
    let sawFace = false;
    for (let m = 0; m < 3; m++) {
      const ch = slot[m]!;
      if (!isFaceId(ch)) continue;
      sawFace = true;
      if (ch !== (ref[(m - ori + 3) % 3] as FaceId)) {
        ok = false;
        break;
      }
    }
    if (ok && sawFace) return true;
  }
  return false;
}

/**
 * 角块（局部）三面/两格结构项；`push` 为 null 时不写入 issue，仅返回是否违规。
 */
function cornerLocalStructuralViolations(
  facelets54: string,
  push: LegalityPush | null,
): boolean {
  let bad = false;
  for (let c = 0; c < CORNER_FACELETS.length; c++) {
    const [a, b, d] = CORNER_FACELETS[c]!;
    const t = [facelets54[a]!, facelets54[b]!, facelets54[d]!];
    const cells = [a, b, d];
    const faceIds = t.filter((ch): ch is FaceId => isFaceId(ch));
    const nFace = faceIds.length;

    if (nFace === 0 || nFace === 1) continue;

    if (nFace === 2) {
      const [x, y] = faceIds;
      if (x === y) {
        if (push) {
          push(
            'piece',
            'CORNER_DUP',
            `角位 ${c}：已填两格颜色相同，无法与第三格构成三种互异颜色。`,
            cells,
          );
        }
        bad = true;
        continue;
      }
      if (OPP[x] === y) {
        if (push) {
          push(
            'piece',
            'CORNER_OPP',
            `角位 ${c}：已填两色为对色，无法构成合法角块（即使第三格未填）。`,
            cells,
          );
        }
        bad = true;
      }
      continue;
    }

    const uniq = new Set(faceIds);
    if (uniq.size < 3) {
      if (push) {
        push(
          'piece',
          'CORNER_DUP',
          `角位 ${c}：角块须为三种不同颜色。`,
          cells,
        );
      }
      bad = true;
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
      if (push) {
        push(
          'piece',
          'CORNER_OPP',
          `角位 ${c}：存在对色同时出现，非法。`,
          cells,
        );
      }
      bad = true;
      continue;
    }
    const key = sortFaceKey([p, q, r]);
    if (!VALID_CORNER_KEYS.has(key)) {
      if (push) {
        push(
          'piece',
          'CORNER_TYPE',
          `角位 ${c}：三色组合不是任一物理角块身份。`,
          cells,
        );
      }
      bad = true;
      continue;
    }
    const pieceJ = cornerPieceIndexFromSortedKey(key);
    if (pieceJ === null) continue;
    const triple = [p, q, r] as readonly [FaceId, FaceId, FaceId];
    if (!isCornerCyclicTwist(triple, pieceJ)) {
      if (push) {
        push(
          'piece',
          'CORNER_CHIRALITY',
          `角位 ${c}：三色在槽位上的顺序不是该物理角块的合法扭转（手性错误，如两色对调）。`,
          cells,
        );
      }
      bad = true;
    }
  }
  return bad;
}

/** 无结构违规前提下：活跃角槽与 `a,b,c`；若无活跃槽返回 null。 */
function cornerLocalComputeAbc(facelets54: string): { a: number; b: number; c: number } | null {
  const activeSlots: number[] = [];
  for (let c = 0; c < 8; c++) {
    if (cornerSlotHasAtLeastOneFaceColor(facelets54, c)) activeSlots.push(c);
  }
  const a = activeSlots.length;
  if (a === 0) return null;
  const adj: boolean[][] = activeSlots.map((c) =>
    Array.from({ length: 8 }, (_, j) => cornerSlotCompatibleWithRefPiece(facelets54, c, j)),
  );
  const b = maxMatchingBipartite(adj, 8);
  const c = b < a ? 0 : countSaturatingInjections(adj, 8);
  return { a, b, c };
}

/**
 * 约束组 **角块（局部）**：结构项后匹配；`a,b,c` 与棱局部同构。
 */
function legalityPushCornerLocal(facelets54: string, push: LegalityPush): void {
  if (cornerLocalStructuralViolations(facelets54, push)) return;

  const abc = cornerLocalComputeAbc(facelets54);
  if (!abc) return;
  const { a, b, c } = abc;
  if (a === b) return;

  const cells: number[] = [];
  for (let c = 0; c < 8; c++) {
    if (!cornerSlotHasAtLeastOneFaceColor(facelets54, c)) continue;
    const [ia, ib, id] = CORNER_FACELETS[c]!;
    cells.push(ia, ib, id);
  }
  push(
    'piece',
    'CORNER_UNIQUE',
    `角块（局部）：至少一面已填的角槽 a=${a}；与 REF 的最大一一分配数 b=${b}（须 a=b）；每条活跃槽到互异 REF 下标的完整指派方案数 c=${c}（b<a 时为 0）。`,
    cells,
  );
}

/**
 * 约束组 **约束 A · 块归属**（`PERM_ID`）：`buildCube` 已全解析且无 `-1` 时，`cp` 须为 8 阶、`ep` 须为 12 阶置换。
 */
function legalityPushPermutationPieces(state: CubeStateJSON, push: LegalityPush): void {
  if (
    !isCubeStateFullyDetermined(state) ||
    (isPermutationCube(state.cp, 8) && isPermutationCube(state.ep, 12))
  ) {
    return;
  }
  push(
    'piece',
    'PERM_ID',
    '棱/角块与贴纸无法一一对应（约束 A：块归属）。',
    [...Array(54).keys()],
  );
}

/**
 * 约束组 **几何一致**（`FACELET_MISMATCH`）：状态可完全展开为面串时，已填格须与展开结果一致。
 * `checkFaceletMismatch` 为 false 时跳过。
 */
function legalityPushFaceletMismatch(
  facelets54: string,
  state: CubeStateJSON,
  checkFaceletMismatch: boolean,
  push: LegalityPush,
): void {
  if (!checkFaceletMismatch) return;
  const reconstructed = faceletsFromCubeState(state);
  if (reconstructed === null) return;
  const diff: number[] = [];
  for (let i = 0; i < 54; i++) {
    if (isFaceId(facelets54[i]!) && reconstructed[i] !== facelets54[i]) {
      diff.push(i);
    }
  }
  if (diff.length === 0) return;
  push(
    'orientation',
    'FACELET_MISMATCH',
    '已填格与由 `buildCube` 状态展开的面串不一致（含角块手性/棱方向与几何矛盾）。',
    diff,
  );
}

/**
 * 约束 B · 角扭转（**完全填充**分支，issue：`TWIST_SUM_FULL`）。
 * 八角三格均为有效面色且 `cp`/`co` 已可解出时，扭转之和须 ≡ 0 (mod 3)。
 */
function pushCornerTwistIssuesWhenFullyFilled(
  facelets54: string,
  state: CubeStateJSON,
  pushIssue: LegalityPush,
): void {
  if (satisfiesCornerTwistConstraint(state, facelets54)) return;
  pushIssue(
    'group',
    'TWIST_SUM_FULL',
    '角块扭转量之和须 ≡ 0 (mod 3)（约束 B）。',
    allCornerFaceletGlobalIndices(),
  );
}

/**
 * 约束 B · 角扭转（**非完全填充**分支，issue：`TWIST_SUM_PARTIAL`）。
 * 每角槽至少一格有效色且尚未全部三格填齐时，须存在至少一种通过 `enumerateCornerFillCubeStates`（含完全填充 mod 3 过滤）的补全。
 */
function pushCornerTwistIssuesWhenPartiallyFilled(facelets54: string, pushIssue: LegalityPush): void {
  if (!allCornerSlotsAtLeastOneFaceletFilled(facelets54) || allCornerSlotsThreeFaceletsFilled(facelets54)) {
    return;
  }
  if (enumerateCornerFillCubeStates(facelets54).length > 0) return;
  pushIssue(
    'group',
    'TWIST_SUM_PARTIAL',
    '每个角槽至少一格为有效色时，须存在至少一种合法角补全（枚举为空，约束 B）。',
    allCornerFaceletGlobalIndices(),
  );
}

/**
 * 约束组 **约束 D · 置换奇偶**（`PARITY`）：全解析且 `cp`/`ep` 均为置换时，角置换奇偶须与棱置换奇偶相同。
 */
function legalityPushPermutationParity(state: CubeStateJSON, push: LegalityPush): void {
  if (
    !isCubeStateFullyDetermined(state) ||
    !isPermutationCube(state.cp, 8) ||
    !isPermutationCube(state.ep, 12)
  ) {
    return;
  }
  if (cornerPermutationParity(state.cp) === edgePermutationParity(state.ep)) return;
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

/**
 * 对 54 位 facelet 串分层校验；结果用于右侧约束列表与 `buildConstraintRows`。
 *
 * 流程概要：`LEN` → `CHAR`+计数 → 局部与色数 → `buildCube` → 约束 A / 几何一致 / B（完全+非完全）/ C（完全+非完全）/ D。
 * 未填色时仍可做色数与棱/角局部；全局项依赖 `buildCube`（未决为 `-1`）。
 * @returns `validationStop` 仅在为 `'LEN'` 或 `'CHAR'` 时提前结束；其余为 `null`。
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

  const push: LegalityPush = (category, code, message, cellIndices) => {
    issues.push({ category, code, message, cellIndices });
  };

  const lenStop = legalityValidateLength(facelets54, issues, push, disabledChecks);
  if (lenStop) return lenStop;

  const charsetOrCounts = legalityValidateCharsetAndCountColors(facelets54, issues, push, disabledChecks);
  if ('ok' in charsetOrCounts && charsetOrCounts.ok === false) return charsetOrCounts;
  const { counts } = charsetOrCounts as { counts: Record<FaceId, number> };

  legalityPushIncomplete(facelets54, push);
  legalityPushCenterMultiset(facelets54, counts, checkCenterMultiset, push);
  legalityPushEdgeLocal(facelets54, push);
  const edgeLocalIssueCodes = new Set(['EDGE_SAME', 'EDGE_OPP', 'EDGE_UNIQUE']);
  const edgeLocalFailed = issues.some((i) => edgeLocalIssueCodes.has(i.code));
  let edgeLocalPassSummary: { a: number; c: number } | undefined = undefined;
  if (!edgeLocalFailed && !edgeLocalHasTwoStickerSameOrOpposite(facelets54)) {
    const abc = edgeLocalComputeAbc(facelets54);
    if (abc !== null && abc.a === abc.b) {
      edgeLocalPassSummary = { a: abc.a, c: abc.c };
    }
  }

  legalityPushCornerLocal(facelets54, push);
  const cornerLocalIssueCodes = new Set([
    'CORNER_DUP',
    'CORNER_OPP',
    'CORNER_TYPE',
    'CORNER_CHIRALITY',
    'CORNER_UNIQUE',
  ]);
  const cornerLocalFailed = issues.some((i) => cornerLocalIssueCodes.has(i.code));
  let cornerLocalPassSummary: { a: number; c: number } | undefined = undefined;
  if (!cornerLocalFailed && !cornerLocalStructuralViolations(facelets54, null)) {
    const cab = cornerLocalComputeAbc(facelets54);
    if (cab !== null && cab.a === cab.b) {
      cornerLocalPassSummary = { a: cab.a, c: cab.c };
    }
  }

  const state = buildCube(facelets54);

  legalityPushPermutationPieces(state, push);
  legalityPushFaceletMismatch(facelets54, state, checkFaceletMismatch, push);
  pushCornerTwistIssuesWhenFullyFilled(facelets54, state, push);
  pushCornerTwistIssuesWhenPartiallyFilled(facelets54, push);
  pushEdgeFlipIssuesWhenFullyFilled(facelets54, state, push);
  pushEdgeFlipIssuesWhenPartiallyFilled(facelets54, push);
  legalityPushPermutationParity(state, push);

  const ok = issues.length === 0;
  return {
    ok,
    issues,
    illegalCellIndices: mergeIndices(issues),
    validationStop: null,
    disabledChecks,
    edgeLocalPassSummary,
    cornerLocalPassSummary,
  };
}

export function solvedString(): string {
  return FACE_ORDER_URFDLB.map((f) => f.repeat(9)).join('');
}
