<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  watchEffect,
} from 'vue';
import Cube from 'cubejs';
import ColorCandidateBar from './components/ColorCandidateBar.vue';
import Cube3DView from './components/Cube3DView.vue';
import { EMPTY_FACELET, isEmptyCell, isFaceletChar } from './cube/cellValue';
import { CENTER_INDICES } from './cube/faceletGeometry';
import { buildCube } from './cube/buildCube';
import {
  buildConstraintRows,
  computeConstraintChainBCandidates,
  enumerateCornerFillCubeStates,
  enumerateEdgeFillCubeStates,
  enumerateParityIncompleteFillCubeStates,
  randomFillRemainingByConstraintChainB,
  solvedString,
  validateConstraintChainA,
  validateLegality,
  type ConstraintGroupId,
  type ConstraintRow,
  type CornerFillEnumerationEntry,
  type EdgeFillEnumerationEntry,
  type ParityIncompleteFillEnumerationEntry,
} from './cube/cubeConstraints';
import { invertAlgorithmMoves, splitAlgorithm } from './cube/layerTurn';
import { FACES, type FaceId } from './cube/types';
import RandomFillPrewarmWorker from './workers/randomFillPrewarm.worker.ts?worker';

/** 六个中心格不可改色（与轴固定） */
const LOCKED_CENTER = new Set<number>(CENTER_INDICES);

/** 为 true 时显示下方「枚举 / buildCube JSON」开发面板；逻辑与函数仍保留，默认不向普通用户展示 */
const SHOW_DEV_CUBE_ENUM_JSON = false;

const MAX_UNDO = 80;
/** 每次改色 / 载入 / 演示步 之前压入的 54 位串；撤销弹出上一帧（含撤销自动填充） */
const undoStack = ref<string[]>([]);
const isUndoing = ref(false);
const facelets = ref(solvedString());

/** 与 `facelets` 同步，输入框聚焦时不覆盖正在编辑的内容 */
const facelets54Draft = ref(facelets.value);
const facelets54InputRef = ref<HTMLTextAreaElement | null>(null);
const facelets54ApplyError = ref<string | null>(null);

function compactFacelets54Input(raw: string): string {
  return raw.replace(/\s/g, '');
}

const facelets54CompactLen = computed(() => compactFacelets54Input(facelets54Draft.value).length);

function applyFacelets54FromInput() {
  facelets54ApplyError.value = null;
  const compact = compactFacelets54Input(facelets54Draft.value);
  if (compact.length !== 54) {
    facelets54ApplyError.value = `须恰好 54 个字符（忽略空白后当前 ${compact.length} 个）。`;
    return;
  }
  let out = '';
  for (let i = 0; i < 54; i++) {
    const ch = compact[i]!;
    if (!isFaceletChar(ch)) {
      facelets54ApplyError.value = `第 ${i + 1} 位非法字符 ${JSON.stringify(ch)}（仅允许 U、D、L、R、F、B 或未填 ${EMPTY_FACELET}）。`;
      return;
    }
    out += isEmptyCell(ch) ? EMPTY_FACELET : ch;
  }
  pushUndoSnapshot();
  facelets.value = out;
  selectedCell.value = null;
  facelets54Draft.value = facelets.value;
}

const canUndo = computed(() => undoStack.value.length > 0);

function pushUndoSnapshot() {
  if (isUndoing.value) return;
  const s = facelets.value;
  const st = undoStack.value;
  if (st.length > 0 && st[st.length - 1] === s) return;
  st.push(s);
  if (st.length > MAX_UNDO) st.shift();
}

function undoFacelets() {
  if (undoStack.value.length === 0) return;
  isUndoing.value = true;
  try {
    const prev = undoStack.value.pop()!;
    facelets.value = prev;
  } finally {
    isUndoing.value = false;
  }
}

const selectedCell = ref<number | null>(null);

/** 选色面板 `position:fixed` 锚点（最近一次点中贴纸的指针位置） */
const pickerPointerPos = ref({ x: 0, y: 0 });

const pickerFloatingStyle = computed(() => ({
  left: `${pickerPointerPos.value.x}px`,
  top: `${pickerPointerPos.value.y}px`,
}));

/** 选色条固定六种面色 +「空」；是否可选由 `computeConstraintChainBCandidates` + `validateConstraintChainA` 约束链决定 */
const pickerBarCandidates = computed((): readonly (FaceId | null)[] => {
  if (selectedCell.value === null) return [];
  return [...FACES, null];
});

/** 仅在打开选色条时计算，避免无选中格时整表 54×6 次校验 */
const constraintChainCandidatesPerCell = computed((): readonly (readonly FaceId[])[] | null => {
  if (selectedCell.value === null) return null;
  return computeConstraintChainBCandidates(facelets.value);
});

const constraintAllowedFacesForPicker = computed((): readonly FaceId[] | null => {
  const idx = selectedCell.value;
  const matrix = constraintChainCandidatesPerCell.value;
  if (idx === null || matrix === null) return null;
  return matrix[idx] ?? null;
});

const pickerDisableEmptyChip = computed(() => {
  const idx = selectedCell.value;
  if (idx === null) return false;
  if (isEmptyCell(facelets.value[idx]!)) return true;
  const arr = facelets.value.split('');
  arr[idx] = EMPTY_FACELET;
  return !validateConstraintChainA(arr.join(''));
});

/** 是否存在某一面（U→R→F→D→L→B）上至少一格未填且 `computeConstraintChainBCandidates` 在该格仅 1 色 */
const canFillFaceUniqueConstraint = computed(() => {
  const matrix = computeConstraintChainBCandidates(facelets.value);
  for (let fi = 0; fi < 6; fi++) {
    const base = fi * 9;
    for (let k = 0; k < 9; k++) {
      const i = base + k;
      if (LOCKED_CENTER.has(i)) continue;
      if (!isEmptyCell(facelets.value[i]!)) continue;
      if (matrix[i]!.length === 1) return true;
    }
  }
  return false;
});

/**
 * 按面顺序 U R F D L B：在第一个存在「未填格且约束链候选仅 1 色」的面上，将该面所有此类格一次性填入。
 */
function fillOneFaceUniqueConstraintCandidates() {
  const matrix = computeConstraintChainBCandidates(facelets.value);
  for (let fi = 0; fi < 6; fi++) {
    const base = fi * 9;
    const toFill: { i: number; color: FaceId }[] = [];
    for (let k = 0; k < 9; k++) {
      const i = base + k;
      if (LOCKED_CENTER.has(i)) continue;
      if (!isEmptyCell(facelets.value[i]!)) continue;
      const opts = matrix[i]!;
      if (opts.length === 1) {
        toFill.push({ i, color: opts[0]! });
      }
    }
    if (toFill.length === 0) continue;
    pushUndoSnapshot();
    const arr = facelets.value.split('');
    for (const { i, color } of toFill) {
      arr[i] = color;
    }
    facelets.value = arr.join('');
    return;
  }
}

/** 是否存在非中心的未填格（「随机其余」仅在这些格上尝试） */
const hasAnyNonCenterEmpty = computed(() => {
  for (let i = 0; i < 54; i++) {
    if (LOCKED_CENTER.has(i)) continue;
    if (isEmptyCell(facelets.value[i]!)) return true;
  }
  return false;
});

function isOnlyCentersString(s: string): boolean {
  if (s.length !== 54) return false;
  for (let i = 0; i < 54; i++) {
    if (LOCKED_CENTER.has(i)) continue;
    if (!isEmptyCell(s[i]!)) return false;
  }
  return true;
}

/** 仅中心块有面色、其余 48 格均为未填（与「清空」结果一致） */
const isOnlyCentersFacelets = computed(() => isOnlyCentersString(facelets.value));

/** 与 `facelets` 一致且有效时，点击「随机其余」可直接应用的预计算结果（`randomFillRemainingByConstraintChainB` 输出） */
const randomFillCacheSource = ref<string | null>(null);
const randomFillCacheResult = ref<string | null>(null);
const randomFillCachePending = ref(false);
let randomFillPrewarmGen = 0;
let randomFillWorker: Worker | null = null;
/** 为 true 时下一次 `facelets` 变更后不跑「随机其余」预计算（仅用于「清空」） */
const skipRandomFillPrewarmNext = ref(false);

type RandomFillPrewarmWorkerMsg =
  | { type: 'done'; gen: number; snapshot: string; out: string }
  | { type: 'error'; gen: number; message: string };

function tearDownRandomFillWorker() {
  if (randomFillWorker) {
    randomFillWorker.terminate();
    randomFillWorker = null;
  }
}

/** 在 Web Worker 中跑 `randomFillRemainingByConstraintChainB`；失败返回 false 以便主线程兜底 */
function postRandomFillPrewarmCompute(gen: number, snapshot: string): boolean {
  if (typeof Worker === 'undefined') return false;
  try {
    if (!randomFillWorker) {
      randomFillWorker = new RandomFillPrewarmWorker();
      randomFillWorker.addEventListener('message', (ev: MessageEvent<RandomFillPrewarmWorkerMsg>) => {
        const data = ev.data;
        if (!data || (data.type !== 'done' && data.type !== 'error')) return;
        if (data.gen !== randomFillPrewarmGen) return;
        if (data.type === 'error') {
          randomFillCachePending.value = false;
          return;
        }
        if (facelets.value !== data.snapshot) {
          randomFillCachePending.value = false;
          return;
        }
        randomFillCacheSource.value = data.snapshot;
        randomFillCacheResult.value = data.out;
        randomFillCachePending.value = false;
      });
      randomFillWorker.addEventListener('error', () => {
        randomFillCachePending.value = false;
        tearDownRandomFillWorker();
      });
    }
    randomFillWorker.postMessage({ type: 'compute', gen, snapshot });
    return true;
  } catch {
    tearDownRandomFillWorker();
    return false;
  }
}

onBeforeUnmount(() => {
  tearDownRandomFillWorker();
});

function scheduleRandomFillPrewarm() {
  const snapshot0 = facelets.value;
  if (snapshot0.length !== 54) {
    randomFillCacheSource.value = null;
    randomFillCacheResult.value = null;
    randomFillCachePending.value = false;
    return;
  }
  if (isOnlyCentersString(snapshot0)) {
    randomFillCacheSource.value = null;
    randomFillCacheResult.value = null;
    randomFillCachePending.value = false;
    return;
  }
  let hasEmptyNonCenter = false;
  for (let i = 0; i < 54; i++) {
    if (LOCKED_CENTER.has(i)) continue;
    if (isEmptyCell(snapshot0[i]!)) {
      hasEmptyNonCenter = true;
      break;
    }
  }
  if (!hasEmptyNonCenter) {
    randomFillCacheSource.value = snapshot0;
    randomFillCacheResult.value = snapshot0;
    randomFillCachePending.value = false;
    return;
  }

  randomFillCachePending.value = true;
  randomFillCacheSource.value = null;
  randomFillCacheResult.value = null;
  const gen = ++randomFillPrewarmGen;
  const snapshot = snapshot0;

  const runHeavyMainThread = () => {
    if (gen !== randomFillPrewarmGen) return;
    if (facelets.value !== snapshot) return;
    const out = randomFillRemainingByConstraintChainB(snapshot);
    if (gen !== randomFillPrewarmGen || facelets.value !== snapshot) return;
    randomFillCacheSource.value = snapshot;
    randomFillCacheResult.value = out;
    randomFillCachePending.value = false;
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (gen !== randomFillPrewarmGen) return;
      if (facelets.value !== snapshot) {
        randomFillCachePending.value = false;
        return;
      }
      if (postRandomFillPrewarmCompute(gen, snapshot)) return;
      const ric = typeof globalThis.requestIdleCallback === 'function' ? globalThis.requestIdleCallback : null;
      if (ric !== null) {
        ric.call(globalThis, runHeavyMainThread, { timeout: 4000 });
      } else {
        setTimeout(runHeavyMainThread, 0);
      }
    });
  });
}

const randomFillApplyReady = computed(() => {
  if (!hasAnyNonCenterEmpty.value) return false;
  if (randomFillCachePending.value) return false;
  if (randomFillCacheSource.value !== facelets.value) return false;
  return randomFillCacheResult.value !== null;
});

/** 对当前 `facelets` 应用预计算的「随机其余」；缓存未就绪时同步计算（兜底） */
function applyRandomFillRemainingByConstraintChain() {
  if (isOnlyCentersFacelets.value) {
    setRandomLegal();
    return;
  }
  if (!hasAnyNonCenterEmpty.value) return;
  pushUndoSnapshot();
  if (randomFillApplyReady.value && randomFillCacheResult.value !== null) {
    facelets.value = randomFillCacheResult.value;
  } else {
    facelets.value = randomFillRemainingByConstraintChainB(facelets.value);
  }
  selectedCell.value = null;
}

/** 六面贴纸显示色（与面串中 U/D/L/R/F/B 记号对应）；改色立即作用于 3D 与选色条 */
const DEFAULT_FACE_DISPLAY_COLORS: Record<FaceId, string> = {
  U: '#ffffff',
  D: '#ffd400',
  L: '#ff7a1a',
  R: '#ff3333',
  F: '#00c853',
  B: '#1e90ff',
};

const faceDisplayColors = ref<Record<FaceId, string>>({ ...DEFAULT_FACE_DISPLAY_COLORS });

function setFaceDisplayColor(face: FaceId, hex: string) {
  faceDisplayColors.value = { ...faceDisplayColors.value, [face]: hex };
}

function resetFaceDisplayColors() {
  faceDisplayColors.value = { ...DEFAULT_FACE_DISPLAY_COLORS };
}

/** 关闭时不检测对应项；总览与其它约束仍按当前规则 */
const checkCenterMultiset = ref(true);
const checkFaceletMismatch = ref(true);

const report = computed(() =>
  validateLegality(facelets.value, {
    checkCenterMultiset: checkCenterMultiset.value,
    checkFaceletMismatch: checkFaceletMismatch.value,
  }),
);
const constraintRows = computed(() => buildConstraintRows(report.value));

type UserConstraintId =
  | 'edge_position'
  | 'corner_position'
  | 'edge_flip'
  | 'corner_twist'
  | 'parity';

type UserConstraintRow = {
  id: UserConstraintId;
  title: string;
  intro: string;
  status: 'pass' | 'fail' | 'skipped';
};

type CheckStatus = 'pass' | 'fail' | 'skipped';

/** 用户向 5 条：文案固定；状态由底层校验行聚合；高亮合并对应组的 cellIndices */
const USER_CONSTRAINT_SPEC: readonly {
  id: UserConstraintId;
  title: string;
  intro: string;
  sourceIds: readonly ConstraintGroupId[];
}[] = [
  {
    id: 'edge_position',
    title: '棱块位置',
    intro: '12个棱块的排列位置。',
    sourceIds: ['edge_local', 'perm_a'],
  },
  {
    id: 'corner_position',
    title: '角块位置',
    intro: '8个角块的排列位置。',
    sourceIds: ['corner_local', 'perm_a'],
  },
  {
    id: 'edge_flip',
    title: '棱块翻转',
    intro: '棱块翻转的次数是偶数。',
    sourceIds: ['flip_c'],
  },
  {
    id: 'corner_twist',
    title: '角块扭转',
    intro: '角块扭转的次数是3的倍数。',
    sourceIds: ['twist_b'],
  },
  {
    id: 'parity',
    title: '棱角奇偶',
    intro: '棱块位置交换次数=角块位置交换次数，即同为奇数或偶数。',
    sourceIds: ['parity_incomplete', 'parity_d'],
  },
];

function statusOf(rows: readonly ConstraintRow[], id: ConstraintGroupId): CheckStatus {
  return rows.find((r) => r.id === id)?.status ?? 'skipped';
}

function combineTwo(a: CheckStatus, b: CheckStatus): CheckStatus {
  if (a === 'fail' || b === 'fail') return 'fail';
  if (a === 'skipped' && b === 'skipped') return 'skipped';
  if (a === 'skipped') return b;
  if (b === 'skipped') return a;
  return a === 'pass' && b === 'pass' ? 'pass' : 'fail';
}

function aggregateStatus(rows: readonly ConstraintRow[], ids: readonly ConstraintGroupId[]): CheckStatus {
  let acc: CheckStatus = 'skipped';
  for (const id of ids) {
    acc = combineTwo(acc, statusOf(rows, id));
  }
  return acc;
}

function mergeCellIndicesForSources(
  rows: readonly ConstraintRow[],
  ids: readonly ConstraintGroupId[],
): Set<number> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const s = new Set<number>();
  for (const id of ids) {
    const r = byId.get(id);
    if (r) for (const i of r.cellIndices) s.add(i);
  }
  return s;
}

const userConstraintRows = computed((): UserConstraintRow[] => {
  const rows = constraintRows.value;
  const base = USER_CONSTRAINT_SPEC.map((spec) => ({
    id: spec.id,
    title: spec.title,
    intro: spec.intro,
    status: aggregateStatus(rows, spec.sourceIds),
  }));
  const edgeFlip = base.find((r) => r.id === 'edge_flip');
  const cornerTwist = base.find((r) => r.id === 'corner_twist');
  if (edgeFlip?.status === 'fail' || cornerTwist?.status === 'fail') {
    return base.map((r) =>
      r.id === 'parity' ? { ...r, status: 'skipped' as const } : r,
    );
  }
  return base;
});

const constraintsPanelOpen = ref(false);

/** 仅当选中某一用户约束时在 3D 上高亮对应格；默认不高亮 */
const selectedUserConstraintId = ref<UserConstraintId | null>(null);

watch(constraintsPanelOpen, (open) => {
  if (!open) selectedUserConstraintId.value = null;
});

watch(
  () => userConstraintRows.value.find((r) => r.id === 'parity')?.status,
  (parityStatus) => {
    if (parityStatus === 'skipped' && selectedUserConstraintId.value === 'parity') {
      selectedUserConstraintId.value = null;
    }
  },
);

const highlightIndices = computed(() => {
  const uid = selectedUserConstraintId.value;
  if (uid === null) return new Set<number>();
  const spec = USER_CONSTRAINT_SPEC.find((s) => s.id === uid);
  const urow = userConstraintRows.value.find((r) => r.id === uid);
  if (!spec || !urow || urow.status === 'skipped') return new Set<number>();
  return mergeCellIndicesForSources(constraintRows.value, spec.sourceIds);
});

function toggleUserConstraintHighlight(id: UserConstraintId) {
  const urow = userConstraintRows.value.find((r) => r.id === id);
  if (!urow || urow.status === 'skipped') return;
  if (selectedUserConstraintId.value === id) {
    selectedUserConstraintId.value = null;
    return;
  }
  selectedUserConstraintId.value = id;
}

/** 点击约束抽屉内除约束条按钮外的区域时取消选中 */
function onConstraintsDrawerBackgroundClick(ev: MouseEvent) {
  const t = ev.target as HTMLElement | null;
  if (t?.closest('button.constraint')) return;
  selectedUserConstraintId.value = null;
}

function onStickerClick(globalIdx: number, clientX: number, clientY: number) {
  if (LOCKED_CENTER.has(globalIdx)) return;
  if (selectedCell.value === globalIdx) {
    selectedCell.value = null;
    return;
  }
  selectedCell.value = globalIdx;
  pickerPointerPos.value = { x: clientX, y: clientY };
}

function onStickerPointerMiss() {
  clearSelection();
}

watchEffect((onCleanup) => {
  if (selectedCell.value === null) return;
  const onDocPointerDown = (e: PointerEvent) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('.picker')) return;
    if (el?.closest('.cube-3d')) return;
    clearSelection();
  };
  document.addEventListener('pointerdown', onDocPointerDown, true);
  onCleanup(() => document.removeEventListener('pointerdown', onDocPointerDown, true));
});

function applyPick(value: FaceId | null) {
  if (selectedCell.value === null) return;
  if (LOCKED_CENTER.has(selectedCell.value)) return;
  pushUndoSnapshot();
  const arr = facelets.value.split('');
  arr[selectedCell.value] = value === null ? EMPTY_FACELET : value;
  facelets.value = arr.join('');
}

function clearSelection() {
  selectedCell.value = null;
}

function setSolved() {
  pushUndoSnapshot();
  facelets.value = solvedString();
  selectedCell.value = null;
}

function setRandomLegal() {
  pushUndoSnapshot();
  const c = Cube.random();
  facelets.value = c.asString();
  selectedCell.value = null;
}

/** 除六个中心外全部置为未填 */
function clearExceptCenters() {
  pushUndoSnapshot();
  skipRandomFillPrewarmNext.value = true;
  const solved = solvedString();
  const arr: string[] = Array.from({ length: 54 }, () => EMPTY_FACELET);
  for (const i of CENTER_INDICES) {
    arr[i] = solved[i]!;
  }
  facelets.value = arr.join('');
  selectedCell.value = null;
}

/** 与校验一致：`buildCube` → 与 cubejs `toJSON()` 同形（未决为 -1） */
const cubeJsonState = computed(() => {
  const s = facelets.value;
  if (s.length !== 54) {
    return { type: 'unavailable' as const, text: '须恰好 54 个字符。' };
  }
  try {
    return { type: 'json' as const, value: buildCube(s) };
  } catch (e) {
    return {
      type: 'error' as const,
      text: e instanceof Error ? e.message : String(e),
    };
  }
});

const cube3dRef = ref<{
  animateMove: (m: string) => Promise<void>;
  resetLayout: () => void;
} | null>(null);

const faceletsComplete = computed(() => {
  const s = facelets.value;
  if (s.length !== 54) return false;
  for (let i = 0; i < 54; i++) {
    if (isEmptyCell(s[i]!)) return false;
  }
  return true;
});

const randomPopoverOpen = ref(false);

const canUseRandomButton = computed(() => facelets.value.length === 54);

function onRandomMainButtonClick() {
  if (!canUseRandomButton.value) return;
  if (faceletsComplete.value || isOnlyCentersFacelets.value) {
    randomPopoverOpen.value = false;
    setRandomLegal();
    return;
  }
  if (randomPopoverOpen.value) {
    randomPopoverOpen.value = false;
    return;
  }
  randomPopoverOpen.value = true;
}

function onRandomPopoverPickAll() {
  randomPopoverOpen.value = false;
  setRandomLegal();
}

function onRandomPopoverPickRest() {
  randomPopoverOpen.value = false;
  applyRandomFillRemainingByConstraintChain();
}

watchEffect((onCleanup) => {
  if (!randomPopoverOpen.value) return;
  const onDoc = (e: PointerEvent) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('.toolbar__random-wrap')) return;
    randomPopoverOpen.value = false;
  };
  document.addEventListener('pointerdown', onDoc, true);
  onCleanup(() => document.removeEventListener('pointerdown', onDoc, true));
});

/** 「随机」主按钮尺寸：浮层宽与按钮同宽（原 w-2 再加宽 2px）；次行「未选」等高叠在下方；left/top 4px/4px */
const randomBtnRef = ref<HTMLButtonElement | null>(null);
const randomBtnPx = ref({ w: 0, h: 0 });

function measureRandomBtnSize() {
  const el = randomBtnRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  randomBtnPx.value = { w: r.width, h: r.height };
}

const randomPopoverBoxStyle = computed(() => {
  const { w, h } = randomBtnPx.value;
  if (w <= 0 || h <= 0) {
    return { left: '4px', top: '4px', boxSizing: 'border-box' as const };
  }
  const row = h - 2;
  return {
    left: '4px',
    top: '4px',
    width: `${w}px`,
    height: `${row * 2}px`,
    boxSizing: 'border-box' as const,
  };
});

const randomBtnResizeObserver = new ResizeObserver(() => measureRandomBtnSize());

watch(
  randomBtnRef,
  (el) => {
    randomBtnResizeObserver.disconnect();
    if (el) {
      randomBtnResizeObserver.observe(el);
      void nextTick(() => measureRandomBtnSize());
    }
  },
  { immediate: true, flush: 'post' },
);

onBeforeUnmount(() => {
  randomBtnResizeObserver.disconnect();
});

const solverInitialized = ref(false);
const solverLoading = ref(false);
const solverError = ref<string | null>(null);
const solverBanner = ref<string | null>(null);
const solutionMoves = ref<string[]>([]);
const solutionStepIndex = ref(0);
/** 逆向演示：尚未执行首次「下一步」复位时为 true，之后每步施转列表中一步 */
const reverseAwaitingFirstNext = ref(false);
const solutionIsReverse = ref(false);
const reverseDemoTargetFacelets = ref<string | null>(null);
const solutionAnimating = ref(false);
/** 为 true 时下一次 `facelets` 变更来自「下一步」演示，不应清空解法或 reset 3D */
const skipInvalidationForSolutionStep = ref(false);
const nextHintMove = computed(() => {
  if (solutionMoves.value.length === 0) return null;
  if (solutionIsReverse.value) {
    if (reverseAwaitingFirstNext.value) return null;
    if (solutionStepIndex.value >= solutionMoves.value.length) return null;
    return solutionMoves.value[solutionStepIndex.value] ?? null;
  }
  if (solutionStepIndex.value >= solutionMoves.value.length) return null;
  return solutionMoves.value[solutionStepIndex.value] ?? null;
});

const canAdvanceSolutionStep = computed(() => {
  if (solutionMoves.value.length === 0) return false;
  if (solutionIsReverse.value) {
    if (reverseAwaitingFirstNext.value) return true;
    return solutionStepIndex.value < solutionMoves.value.length;
  }
  return solutionStepIndex.value < solutionMoves.value.length;
});

function clearSolutionState() {
  solutionMoves.value = [];
  solutionStepIndex.value = 0;
  solverError.value = null;
  solverBanner.value = null;
  solutionIsReverse.value = false;
  reverseAwaitingFirstNext.value = false;
  reverseDemoTargetFacelets.value = null;
}

async function fetchSolution() {
  solverError.value = null;
  solverBanner.value = null;
  if (!faceletsComplete.value) {
    solverError.value = '请先填满 54 格。';
    return;
  }
  if (!report.value.ok) {
    solverError.value = '当前染色不满足可解条件，无法计算还原步骤。';
    return;
  }
  solverLoading.value = true;
  try {
    if (!solverInitialized.value) {
      Cube.initSolver();
      solverInitialized.value = true;
    }
    const c = Cube.fromString(facelets.value);
    if (c.isSolved()) {
      solutionMoves.value = [];
      solutionStepIndex.value = 0;
      solutionIsReverse.value = false;
      reverseAwaitingFirstNext.value = false;
      reverseDemoTargetFacelets.value = null;
      solverBanner.value = '当前已是标准还原态，无需转动步骤。';
      return;
    }
    const alg = c.solve();
    solutionIsReverse.value = false;
    reverseAwaitingFirstNext.value = false;
    reverseDemoTargetFacelets.value = null;
    solutionMoves.value = splitAlgorithm(alg);
    solutionStepIndex.value = 0;
  } catch (e) {
    solverError.value = e instanceof Error ? e.message : String(e);
    solutionMoves.value = [];
    solutionStepIndex.value = 0;
    solutionIsReverse.value = false;
    reverseAwaitingFirstNext.value = false;
    reverseDemoTargetFacelets.value = null;
  } finally {
    solverLoading.value = false;
  }
}

async function fetchReverseSolution() {
  solverError.value = null;
  solverBanner.value = null;
  if (!faceletsComplete.value) {
    solverError.value = '请先填满 54 格。';
    return;
  }
  if (!report.value.ok) {
    solverError.value = '当前染色不满足可解条件，无法计算步骤。';
    return;
  }
  solverLoading.value = true;
  try {
    if (!solverInitialized.value) {
      Cube.initSolver();
      solverInitialized.value = true;
    }
    const snapshot = facelets.value;
    const c = Cube.fromString(snapshot);
    if (c.isSolved()) {
      solutionMoves.value = [];
      solutionStepIndex.value = 0;
      solutionIsReverse.value = false;
      reverseAwaitingFirstNext.value = false;
      reverseDemoTargetFacelets.value = null;
      solverBanner.value = '当前已是标准还原态，从还原态到当前态无转动步骤。';
      return;
    }
    const alg = c.solve();
    reverseDemoTargetFacelets.value = snapshot;
    solutionIsReverse.value = true;
    reverseAwaitingFirstNext.value = true;
    solutionMoves.value = invertAlgorithmMoves(splitAlgorithm(alg));
    solutionStepIndex.value = 0;
  } catch (e) {
    solverError.value = e instanceof Error ? e.message : String(e);
    solutionMoves.value = [];
    solutionStepIndex.value = 0;
    solutionIsReverse.value = false;
    reverseAwaitingFirstNext.value = false;
    reverseDemoTargetFacelets.value = null;
  } finally {
    solverLoading.value = false;
  }
}

async function nextSolutionStep() {
  if (solutionAnimating.value) return;
  const view = cube3dRef.value;
  if (!view) return;

  if (solutionIsReverse.value) {
    if (solutionMoves.value.length === 0) return;
    if (!reverseAwaitingFirstNext.value && solutionStepIndex.value >= solutionMoves.value.length) {
      return;
    }
    solutionAnimating.value = true;
    try {
      if (reverseAwaitingFirstNext.value) {
        pushUndoSnapshot();
        skipInvalidationForSolutionStep.value = true;
        facelets.value = solvedString();
        await nextTick();
        view.resetLayout();
        reverseAwaitingFirstNext.value = false;
      } else {
        const move = solutionMoves.value[solutionStepIndex.value]!;
        const before = facelets.value;
        await view.animateMove(move);
        pushUndoSnapshot();
        const c = Cube.fromString(before);
        c.move(move);
        skipInvalidationForSolutionStep.value = true;
        facelets.value = c.asString();
        solutionStepIndex.value += 1;
        const target = reverseDemoTargetFacelets.value;
        if (
          target &&
          solutionStepIndex.value === solutionMoves.value.length &&
          facelets.value !== target
        ) {
          solverError.value =
            '逆向演示结束态与目标不一致（内部错误）；请重新获取逆向步骤。';
        }
      }
    } catch (e) {
      solverError.value = e instanceof Error ? e.message : String(e);
    } finally {
      solutionAnimating.value = false;
    }
    return;
  }

  if (solutionMoves.value.length === 0) return;
  if (solutionStepIndex.value >= solutionMoves.value.length) return;
  const move = solutionMoves.value[solutionStepIndex.value]!;
  solutionAnimating.value = true;
  try {
    const before = facelets.value;
    await view.animateMove(move);
    pushUndoSnapshot();
    const c = Cube.fromString(before);
    c.move(move);
    skipInvalidationForSolutionStep.value = true;
    facelets.value = c.asString();
    solutionStepIndex.value += 1;
  } catch (e) {
    solverError.value = e instanceof Error ? e.message : String(e);
  } finally {
    solutionAnimating.value = false;
  }
}

/** 3D 贴纸与黑框不透明度（0.1–1），始终生效 */
const stickerOpacity = ref(1);

const opacityPercent = computed(() => Math.round(stickerOpacity.value * 100));

/** 用户改色或载入新状态后：清空已算好的还原序列，并把 3D 贴纸位姿恢复为与索引一致 */
function invalidateSolutionAndReset3D() {
  clearSolutionState();
  void nextTick(() => {
    cube3dRef.value?.resetLayout();
  });
}

watch(facelets, () => {
  if (skipRandomFillPrewarmNext.value) {
    skipRandomFillPrewarmNext.value = false;
    randomFillPrewarmGen += 1;
    randomFillCacheSource.value = null;
    randomFillCacheResult.value = null;
    randomFillCachePending.value = false;
  } else {
    scheduleRandomFillPrewarm();
  }
  if (skipInvalidationForSolutionStep.value) {
    skipInvalidationForSolutionStep.value = false;
    return;
  }
  if (isUndoing.value) {
    invalidateSolutionAndReset3D();
    return;
  }
  invalidateSolutionAndReset3D();
}, { flush: 'post', immediate: true });

watch(facelets, (v) => {
  if (facelets54InputRef.value === document.activeElement) return;
  facelets54Draft.value = v;
  facelets54ApplyError.value = null;
});

const edgeEnumEntries = ref<EdgeFillEnumerationEntry[]>([]);
const edgeEnumError = ref<string | null>(null);
const selectedEdgeEnumIndex = ref<number | null>(null);

const edgeEnumDisplayText = computed(() => {
  if (edgeEnumError.value) return edgeEnumError.value;
  const list = edgeEnumEntries.value;
  const n = list.length;
  if (n === 0) {
    return '（尚无枚举结果：点击「枚举棱补全」；须每个棱槽至少一格为有效面色。）';
  }
  let out = `枚举数量: ${n}\n\n`;
  for (let i = 0; i < n; i++) {
    const e = list[i]!;
    out += `--- #${i} ---\n${JSON.stringify({ state: e.state, facelets54: e.facelets54 }, null, 2)}\n\n`;
  }
  return out;
});

function runEdgeEnumeration() {
  edgeEnumError.value = null;
  try {
    const out = enumerateEdgeFillCubeStates(facelets.value);
    edgeEnumEntries.value = out;
    selectedEdgeEnumIndex.value = out.length > 0 ? 0 : null;
  } catch (e) {
    edgeEnumEntries.value = [];
    selectedEdgeEnumIndex.value = null;
    edgeEnumError.value = e instanceof Error ? e.message : String(e);
  }
}

function applySelectedEdgeEnumeration() {
  const idx = selectedEdgeEnumIndex.value;
  const list = edgeEnumEntries.value;
  if (idx === null || idx < 0 || idx >= list.length) return;
  pushUndoSnapshot();
  facelets.value = list[idx]!.facelets54;
  selectedCell.value = null;
}

const cornerEnumEntries = ref<CornerFillEnumerationEntry[]>([]);
const cornerEnumError = ref<string | null>(null);
const selectedCornerEnumIndex = ref<number | null>(null);

const cornerEnumDisplayText = computed(() => {
  if (cornerEnumError.value) return cornerEnumError.value;
  const list = cornerEnumEntries.value;
  const n = list.length;
  if (n === 0) {
    return '（尚无枚举结果：点击「枚举角补全」；须每个角槽至少一格为有效面色。）';
  }
  let out = `枚举数量: ${n}\n\n`;
  for (let i = 0; i < n; i++) {
    const e = list[i]!;
    out += `--- #${i + 1} ---\n${JSON.stringify({ state: e.state, facelets54: e.facelets54 }, null, 2)}\n\n`;
  }
  return out;
});

function runCornerEnumeration() {
  cornerEnumError.value = null;
  try {
    const out = enumerateCornerFillCubeStates(facelets.value);
    cornerEnumEntries.value = out;
    selectedCornerEnumIndex.value = out.length > 0 ? 0 : null;
  } catch (e) {
    cornerEnumEntries.value = [];
    selectedCornerEnumIndex.value = null;
    cornerEnumError.value = e instanceof Error ? e.message : String(e);
  }
}

function applySelectedCornerEnumeration() {
  const idx = selectedCornerEnumIndex.value;
  const list = cornerEnumEntries.value;
  if (idx === null || idx < 0 || idx >= list.length) return;
  pushUndoSnapshot();
  facelets.value = list[idx]!.facelets54;
  selectedCell.value = null;
}

const parityIncompleteEnumEntries = ref<ParityIncompleteFillEnumerationEntry[]>([]);
const parityIncompleteEnumError = ref<string | null>(null);
const selectedParityIncompleteEnumIndex = ref<number | null>(null);

const parityIncompleteEnumDisplayText = computed(() => {
  if (parityIncompleteEnumError.value) return parityIncompleteEnumError.value;
  const list = parityIncompleteEnumEntries.value;
  const n = list.length;
  if (n === 0) {
    return '（尚无枚举结果：点击「枚举置换奇偶-非完全填充」；须先满足 `enumerateEdgeFillCubeStates` 与 `enumerateCornerFillCubeStates` 各自前提，且两函数在「先棱后角」链路上有组合输出。）';
  }
  let out = `枚举数量: ${n}\n\n`;
  for (let i = 0; i < n; i++) {
    const e = list[i]!;
    out += `--- #${i + 1} ---\n${JSON.stringify({ state: e.state, facelets54: e.facelets54 }, null, 2)}\n\n`;
  }
  return out;
});

function runParityIncompleteEnumeration() {
  parityIncompleteEnumError.value = null;
  try {
    const out = enumerateParityIncompleteFillCubeStates(facelets.value);
    parityIncompleteEnumEntries.value = out;
    selectedParityIncompleteEnumIndex.value = out.length > 0 ? 0 : null;
  } catch (e) {
    parityIncompleteEnumEntries.value = [];
    selectedParityIncompleteEnumIndex.value = null;
    parityIncompleteEnumError.value = e instanceof Error ? e.message : String(e);
  }
}

function applySelectedParityIncompleteEnumeration() {
  const idx = selectedParityIncompleteEnumIndex.value;
  const list = parityIncompleteEnumEntries.value;
  if (idx === null || idx < 0 || idx >= list.length) return;
  pushUndoSnapshot();
  facelets.value = list[idx]!.facelets54;
  selectedCell.value = null;
}

</script>

<template>
  <div class="page">
    <div class="toolbar">
      <button type="button" @click="setSolved">还原</button>
      <div class="toolbar__random-wrap">
        <button
          ref="randomBtnRef"
          type="button"
          class="toolbar__primary"
          :disabled="!canUseRandomButton"
          :title="
            faceletsComplete
              ? '54 面均已填色：点击直接替换为 cubejs 随机合法态'
              : isOnlyCentersFacelets
                ? '六面仅中心有面色：点击直接整态随机'
                : '未填满：点击展开后可选「全部」整态随机或「未选」保留已填色补全'
          "
          @click="onRandomMainButtonClick"
        >
          随机
        </button>
        <Transition name="mac-float">
          <div
            v-if="randomPopoverOpen"
            class="random-popover mac-float-surface"
            :style="randomPopoverBoxStyle"
            role="menu"
            aria-label="随机方式"
          >
            <button
              type="button"
              class="random-popover__btn"
              role="menuitem"
              @click="onRandomPopoverPickAll"
            >
              全部
            </button>
            <button
              type="button"
              class="random-popover__btn"
              role="menuitem"
              @click="onRandomPopoverPickRest"
            >
              未选
            </button>
          </div>
        </Transition>
      </div>
      <button type="button" class="muted" @click="clearExceptCenters">清空</button>
      <button
        type="button"
        class="muted"
        :disabled="!canUndo"
        title="撤销上一步改色、载入或演示步"
        @click="undoFacelets"
      >
        撤销
      </button>
      <button
        type="button"
        class="toolbar__primary"
        :disabled="!canFillFaceUniqueConstraint"
        title="按 U R F D L B 面顺序，在第一个存在「未填格且约束链候选仅 1 色」的面上，将该面所有此类格填入该色（`computeConstraintChainBCandidates` + `validateConstraintChainA`）"
        @click="fillOneFaceUniqueConstraintCandidates"
      >
        填充唯一候选
      </button>
      <button
        type="button"
        class="toolbar__primary"
        :disabled="solverLoading || solutionAnimating || !faceletsComplete || !report.ok"
        @click="fetchSolution"
      >
        {{ solverLoading ? '正在初始化求解器…' : '步骤' }}
      </button>
      <button
        type="button"
        class="toolbar__primary"
        :disabled="solverLoading || solutionAnimating || !faceletsComplete || !report.ok"
        @click="fetchReverseSolution"
      >
        {{ solverLoading ? '正在初始化求解器…' : '逆向步骤' }}
      </button>
      <button
        type="button"
        class="toolbar__primary"
        :disabled="!canAdvanceSolutionStep || solverLoading || solutionAnimating"
        @click="nextSolutionStep"
      >
        下一步
      </button>
    </div>
    <p v-if="solverError" class="solver-err">{{ solverError }}</p>
    <p v-else-if="solverBanner" class="solver-banner">{{ solverBanner }}</p>
    <div v-else-if="solutionMoves.length > 0" class="solver-info">
      <p class="solver-info__lead">
        <template v-if="solutionIsReverse">
          逆向步骤（还原态 → 获取时的状态）：列表步已执行 {{ solutionStepIndex }} /
          {{ solutionMoves.length }}；首次「下一步」仅恢复还原态，之后每步施转一字。
          <template v-if="reverseAwaitingFirstNext">下一步将<strong>恢复还原态</strong>。</template>
          <template v-else-if="nextHintMove">
            当前步 <strong>{{ nextHintMove }}</strong>
          </template>
          <template v-else>（已完成）</template>
        </template>
        <template v-else>
          还原步骤：已执行 {{ solutionStepIndex }} / {{ solutionMoves.length }}；点击「下一步」按序演示；当前步
          <strong v-if="nextHintMove">{{ nextHintMove }}</strong>
          <span v-else>（已完成）</span>
        </template>
      </p>
      <ol
        class="solver-steps"
        :aria-label="solutionIsReverse ? '从还原态到目标态的转动序列' : '完整还原步骤序列'"
      >
        <li
          v-for="(m, i) in solutionMoves"
          :key="`${i}-${m}`"
          class="solver-steps__item"
          :class="{
            'solver-steps__item--done':
              solutionIsReverse
                ? !reverseAwaitingFirstNext && i < solutionStepIndex
                : i < solutionStepIndex,
            'solver-steps__item--current':
              solutionIsReverse
                ? !reverseAwaitingFirstNext &&
                  i === solutionStepIndex &&
                  solutionStepIndex < solutionMoves.length
                : i === solutionStepIndex,
            'solver-steps__item--pending':
              solutionIsReverse
                ? reverseAwaitingFirstNext ||
                  i > solutionStepIndex ||
                  (i === solutionStepIndex && solutionStepIndex >= solutionMoves.length)
                : i > solutionStepIndex,
          }"
        >
          <span class="solver-steps__move">{{ m }}</span>
        </li>
      </ol>
    </div>
    <section class="facelets54 card" aria-label="编辑 54 位面串">
      <p v-if="facelets54ApplyError" class="facelets54__err">{{ facelets54ApplyError }}</p>
      <div class="facelets54__row">
        <div class="facelets54__left">
          <div class="facelets54__input-wrap">
            <textarea
              ref="facelets54InputRef"
              v-model="facelets54Draft"
              class="facelets54__textarea"
              rows="1"
              spellcheck="false"
              wrap="off"
              :aria-label="`facelets54 文本输入，${facelets54CompactLen}/54 字符`"
            />
            <span class="facelets54__counter">{{ facelets54CompactLen }}/54</span>
          </div>
          <div class="facelets54__actions">
            <button type="button" class="toolbar__primary" @click="applyFacelets54FromInput">
              应用
            </button>
          </div>
        </div>
        <div class="facelets54__theme-side">
          <div class="face-theme" aria-label="六面显示色">
            <div class="face-theme__row" role="group">
              <label
                v-for="f in FACES"
                :key="f"
                class="face-theme__swatch"
                :title="`${f} 面显示色`"
              >
                <span class="face-theme__tile" :style="{ backgroundColor: faceDisplayColors[f] }" />
                <span class="face-theme__lbl">{{ f }}</span>
                <input
                  class="face-theme__color"
                  type="color"
                  :value="faceDisplayColors[f]"
                  @input="setFaceDisplayColor(f, ($event.target as HTMLInputElement).value)"
                />
              </label>
            </div>
            <button type="button" class="face-theme__reset" @click="resetFaceDisplayColors">
              重置
            </button>
          </div>
          <label class="semi-opacity">
            <span class="semi-opacity__label">3D 透明度</span>
            <input
              v-model.number="stickerOpacity"
              class="semi-opacity__range"
              type="range"
              min="0.1"
              max="1"
              step="0.02"
              aria-valuemin="0.1"
              aria-valuemax="1"
              :aria-valuenow="stickerOpacity"
              aria-label="三维魔方贴纸与黑框不透明度"
            />
            <span class="semi-opacity__value" aria-hidden="true">{{ opacityPercent }}%</span>
          </label>
        </div>
      </div>
    </section>

    <div class="layout">
      <section class="view-3d" aria-label="三维魔方">
        <Cube3DView
          ref="cube3dRef"
          :facelets="facelets"
          :face-colors="faceDisplayColors"
          :highlight-indices="highlightIndices"
          :locked-indices="LOCKED_CENTER"
          :selected-index="selectedCell"
          :next-hint-move="nextHintMove"
          :semi-transparent="true"
          :sticker-opacity="stickerOpacity"
          @sticker-click="onStickerClick"
          @sticker-pointer-miss="onStickerPointerMiss"
        />

        <Transition name="mac-float">
          <div
            v-if="selectedCell !== null"
            class="picker-anchor"
            :style="pickerFloatingStyle"
          >
            <div class="picker picker--floating card mac-float-surface">
              <ColorCandidateBar
                :candidates="pickerBarCandidates"
                :face-colors="faceDisplayColors"
                :constraint-allowed-faces="constraintAllowedFacesForPicker"
                :disable-empty-chip="pickerDisableEmptyChip"
                @pick="applyPick"
              />
            </div>
          </div>
        </Transition>
      </section>

      <aside
        class="panel panel--constraints"
        :class="{ 'panel--constraints--collapsed': !constraintsPanelOpen }"
        aria-label="约束说明"
      >
        <button
          type="button"
          class="constraints-toggle"
          :aria-expanded="constraintsPanelOpen"
          @click="constraintsPanelOpen = !constraintsPanelOpen"
        >
          约束
        </button>
        <div
          v-show="constraintsPanelOpen"
          class="constraints-drawer"
          @click="onConstraintsDrawerBackgroundClick"
        >
          <div class="status" :class="report.ok ? 'status--ok' : 'status--bad'">
            {{ report.ok ? '当前状态：合法（可解必要条件均满足）' : '当前状态：存在非法项或未填色' }}
          </div>
          <ul class="constraints" role="list">
            <li v-for="row in userConstraintRows" :key="row.id">
              <button
                type="button"
                class="constraint"
                :class="{
                  'constraint--pass': row.status === 'pass',
                  'constraint--fail': row.status === 'fail',
                  'constraint--skip': row.status === 'skipped',
                  'constraint--active': selectedUserConstraintId === row.id,
                }"
                :disabled="row.status === 'skipped'"
                :aria-pressed="selectedUserConstraintId === row.id"
                @click.stop="toggleUserConstraintHighlight(row.id)"
              >
                <span class="constraint__status" :data-status="row.status">{{
                  row.status === 'pass' ? '通过' : row.status === 'fail' ? '未通过' : '未校验'
                }}</span>
                <span class="constraint__title">{{ row.title }}</span>
                <span class="constraint__desc">{{ row.intro }}</span>
              </button>
            </li>
          </ul>
        </div>
      </aside>
    </div>

    <template v-if="SHOW_DEV_CUBE_ENUM_JSON">
    <section class="edge-enum card" aria-label="棱块补全枚举">
      <h2 class="cube-json__title"><code>enumerateEdgeFillCubeStates</code></h2>
      <p class="edge-enum__hint">
        至少 10 个几何棱槽（两格）各至少一格为有效面色（至多两条棱两格均可未填）时枚举补全：仅缺一格的槽补另一格；整棱未填的槽各枚举
        <code>REF_EDGE</code> 上合法色对与翻转（多条未填棱递归组合）。结果会去掉违反「约束 C · 棱翻转偶数」的方案（与合法性校验一致）。下方为各方案的
        <code>CubeStateJSON</code> 与补全后的 54 位串。选择方案后可一键写回左侧贴纸（含 3D）。
      </p>
      <div class="edge-enum__actions">
        <button type="button" class="toolbar__primary" @click="runEdgeEnumeration">枚举棱补全</button>
        <label v-if="edgeEnumEntries.length > 0" class="edge-enum__select">
          <span class="edge-enum__select-label">选中方案</span>
          <select v-model.number="selectedEdgeEnumIndex" class="edge-enum__select-input">
            <option v-for="(_, i) in edgeEnumEntries" :key="i" :value="i">#{{ i + 1 }}</option>
          </select>
        </label>
        <button
          type="button"
          class="toolbar__primary"
          :disabled="selectedEdgeEnumIndex === null || edgeEnumEntries.length === 0"
          @click="applySelectedEdgeEnumeration"
        >
          应用
        </button>
      </div>
      <textarea
        class="edge-enum__textarea"
        readonly
        rows="14"
        spellcheck="false"
        aria-label="棱补全枚举结果"
        :value="edgeEnumDisplayText"
      />
    </section>

    <section class="edge-enum card" aria-label="角块补全枚举">
      <h2 class="cube-json__title"><code>enumerateCornerFillCubeStates</code></h2>
      <p class="edge-enum__hint">
        至少 6 个几何角槽（三格）各至少一格为有效面色（至多两个角三格均可未填）时枚举补全：已填两格/一格按原逻辑；三格均未填的角槽各枚举
        <code>REF_CORNER</code> 上 8×3 种 (块, 扭转)（多个未填角递归组合）。补全后须 <code>buildCube</code> 得 <code>cp</code> 为置换且
        <code>co</code> 无 -1（不要求 <code>ep</code>/<code>eo</code>）；结果再去掉违反「约束 B ·
        扭转之和 mod 3」的方案（与合法性校验一致）。选择方案后可一键写回左侧贴纸（含 3D）。
      </p>
      <div class="edge-enum__actions">
        <button type="button" class="toolbar__primary" @click="runCornerEnumeration">枚举角补全</button>
        <label v-if="cornerEnumEntries.length > 0" class="edge-enum__select">
          <span class="edge-enum__select-label">选中方案</span>
          <select v-model.number="selectedCornerEnumIndex" class="edge-enum__select-input">
            <option v-for="(_, i) in cornerEnumEntries" :key="i" :value="i">#{{ i + 1 }}</option>
          </select>
        </label>
        <button
          type="button"
          class="toolbar__primary"
          :disabled="selectedCornerEnumIndex === null || cornerEnumEntries.length === 0"
          @click="applySelectedCornerEnumeration"
        >
          应用
        </button>
      </div>
      <textarea
        class="edge-enum__textarea"
        readonly
        rows="14"
        spellcheck="false"
        aria-label="角补全枚举结果"
        :value="cornerEnumDisplayText"
      />
    </section>

    <section class="edge-enum card" aria-label="置换奇偶非完全填充枚举">
      <h2 class="cube-json__title"><code>enumerateParityIncompleteFillCubeStates</code></h2>
      <p class="edge-enum__hint">
        对每个 <code>enumerateEdgeFillCubeStates</code> 的补全结果再跑
        <code>enumerateCornerFillCubeStates</code>，仅保留补全后 <code>cp</code>/<code>ep</code> 均为置换且角、棱置换奇偶一致（与约束
        D）的方案；与合法性中「置换奇偶-非完全填充」在须枚举分支时所用集合一致。选择方案后可一键写回左侧贴纸（含 3D）。
      </p>
      <div class="edge-enum__actions">
        <button type="button" class="toolbar__primary" @click="runParityIncompleteEnumeration">
          枚举置换奇偶-非完全填充
        </button>
        <label v-if="parityIncompleteEnumEntries.length > 0" class="edge-enum__select">
          <span class="edge-enum__select-label">选中方案</span>
          <select
            v-model.number="selectedParityIncompleteEnumIndex"
            class="edge-enum__select-input"
          >
            <option v-for="(_, i) in parityIncompleteEnumEntries" :key="i" :value="i">
              #{{ i + 1 }}
            </option>
          </select>
        </label>
        <button
          type="button"
          class="toolbar__primary"
          :disabled="
            selectedParityIncompleteEnumIndex === null || parityIncompleteEnumEntries.length === 0
          "
          @click="applySelectedParityIncompleteEnumeration"
        >
          应用
        </button>
      </div>
      <textarea
        class="edge-enum__textarea"
        readonly
        rows="14"
        spellcheck="false"
        aria-label="置换奇偶非完全填充枚举结果"
        :value="parityIncompleteEnumDisplayText"
      />
    </section>

    <section class="cube-json card" aria-label="cubejs 内部状态">
      <h2 class="cube-json__title"><code>buildCube(facelets)</code>（与 cubejs <code>toJSON()</code> 同形，未决为 -1）</h2>
      <pre v-if="cubeJsonState.type === 'json'" class="cube-json__pre">{{
        JSON.stringify(cubeJsonState.value, null, 2)
      }}</pre>
      <p v-else-if="cubeJsonState.type === 'unavailable'" class="cube-json__muted">
        {{ cubeJsonState.text }}
      </p>
      <p v-else class="cube-json__err">{{ cubeJsonState.text }}</p>
    </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  --glass-bg: rgba(255, 255, 255, 0.42);
  --glass-bg-strong: rgba(255, 255, 255, 0.58);
  --glass-border: rgba(0, 0, 0, 0.1);
  --glass-blur: blur(16px);

  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    'Helvetica Neue',
    Arial,
    sans-serif;
  color: #1a1a1a;
  background: linear-gradient(165deg, #e4e9f2 0%, #f0f2f7 45%, #e8eaee 100%);
  min-height: 100vh;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1.25rem 0;
  padding: 0.65rem 0.85rem;
  border-radius: 12px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.45) inset;
}

.toolbar__random-wrap {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: stretch;
  vertical-align: top;
}

.toolbar__random-wrap > .toolbar__primary {
  width: 100%;
}

.random-popover {
  position: absolute;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 0;
  gap: 0;
  overflow: hidden;
  box-sizing: border-box;
}

.random-popover__btn {
  flex: 1 1 0;
  min-height: 0;
  margin: 0;
  padding: 0 0.28rem;
  border: none;
  border-radius: 0;
  background: transparent;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 650;
  color: #1a1a1a;
  text-align: center;
  cursor: pointer;
  transition: background 0.12s;
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: center;
  line-height: 1.2;
  white-space: nowrap;
  writing-mode: horizontal-tb;
}

.random-popover__btn + .random-popover__btn {
  border-top: 1px solid rgba(0, 0, 0, 0.07);
}

.random-popover__btn:hover {
  background: rgba(0, 0, 0, 0.05);
}

.mac-float-surface {
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.48);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.06),
    0 2px 8px rgba(0, 0, 0, 0.06),
    0 12px 28px rgba(0, 0, 0, 0.1);
  border-radius: 10px;
}

.mac-float-enter-active,
.mac-float-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.mac-float-enter-from,
.mac-float-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}

.toolbar button {
  padding: 0.45rem 0.85rem;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
  font-size: 0.875rem;
}

.toolbar button:hover {
  background: rgba(255, 255, 255, 0.78);
}

.toolbar .muted {
  color: #555;
}

.toolbar__primary {
  border-color: #2563eb !important;
  color: #1e40af;
  font-weight: 600;
}

.toolbar__primary:hover:not(:disabled) {
  background: rgba(239, 246, 255, 0.92) !important;
}

.toolbar__primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.solver-info,
.solver-err {
  margin: 0.35rem 0 0;
  font-size: 0.88rem;
  line-height: 1.45;
}

.solver-banner {
  margin: 0.35rem 0 0;
  padding: 0.45rem 0.85rem;
  border-radius: 10px;
  border: 1px solid rgba(22, 101, 52, 0.18);
  color: #166534;
  background: rgba(232, 248, 239, 0.42);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.solver-info {
  color: #1e3a5f;
  padding: 0.5rem 0.85rem;
  border-radius: 10px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.solver-info__lead {
  margin: 0 0 0.4rem;
}

.solver-steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.5rem;
  align-items: center;
}

.solver-steps__item {
  margin: 0;
  padding: 0.12rem 0.45rem;
  border-radius: 4px;
  border: 1px solid rgba(191, 219, 254, 0.65);
  background: rgba(248, 250, 252, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
}

.solver-steps__item--done {
  color: #64748b;
  border-color: rgba(203, 213, 225, 0.75);
  background: rgba(241, 245, 249, 0.5);
}

.solver-steps__item--current {
  border-color: rgba(37, 99, 235, 0.65);
  background: rgba(239, 246, 255, 0.65);
  font-weight: 700;
  color: #1e40af;
}

.solver-steps__item--pending {
  color: #475569;
}

.solver-err {
  color: #a8281e;
  padding: 0.45rem 0.85rem;
  border-radius: 10px;
  border: 1px solid rgba(168, 40, 30, 0.22);
  background: rgba(253, 236, 234, 0.45);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.layout {
  display: grid;
  grid-template-columns: 1fr minmax(min-content, 420px);
  gap: 1.5rem;
  align-items: start;
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.view-3d {
  min-width: 0;
}

.semi-opacity {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem 0.55rem;
  font-size: 0.78rem;
  color: #3a3d47;
  user-select: none;
}

.semi-opacity__label {
  white-space: nowrap;
  font-weight: 600;
}

.semi-opacity__range {
  width: min(10rem, 36vw);
  vertical-align: middle;
  accent-color: #6366f1;
}

.semi-opacity__value {
  min-width: 2.75rem;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  color: #2d3140;
}

.picker-anchor {
  position: fixed;
  z-index: 50;
  pointer-events: none;
}

.picker.card {
  background: rgba(255, 255, 255, 0.45);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(0, 0, 0, 0.09);
  border-radius: 12px;
  padding: 0.65rem 0.75rem;
}

.picker.card.mac-float-surface {
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.4);
}

.picker--floating {
  margin: 0;
  max-width: min(96vw, 22rem);
  transform: translate(14px, -10px) translateY(-100%);
  pointer-events: auto;
}

.panel {
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-radius: 12px;
  padding: 1rem 1.1rem;
  border: 1px solid var(--glass-border);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.4) inset;
}

.panel--constraints {
  position: sticky;
  top: 1rem;
  max-height: calc(100vh - 2rem);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.55rem;
  min-height: 0;
}

.panel--constraints--collapsed {
  max-height: none;
  width: max-content;
  max-width: 100%;
  align-self: start;
}

.constraints-toggle {
  flex-shrink: 0;
  padding: 0.45rem 0.85rem;
  border-radius: 8px;
  border: 1px solid rgba(37, 99, 235, 0.45);
  background: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #1e40af;
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
  align-self: flex-end;
}

.constraints-toggle:hover {
  background: rgba(239, 246, 255, 0.75);
}

.panel--constraints--collapsed .constraints-toggle {
  align-self: stretch;
}

.constraints-drawer {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  min-width: min(100vw - 2rem, 280px);
}

.panel--constraints:not(.panel--constraints--collapsed) .constraints-drawer .constraints {
  flex: 1;
  min-height: 0;
}

.status {
  font-weight: 600;
  padding: 0.5rem 0.65rem;
  border-radius: 8px;
  font-size: 0.9rem;
}

.status--ok {
  background: rgba(232, 248, 239, 0.65);
  color: #1e7a45;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.status--bad {
  background: rgba(253, 236, 234, 0.65);
  color: #a8281e;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.constraints {
  list-style: none;
  padding: 0;
  margin: 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.constraint {
  width: 100%;
  text-align: left;
  padding: 0.55rem 0.65rem;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(250, 250, 250, 0.45);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
  font: inherit;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.2rem;
  transition:
    border-color 0.12s,
    box-shadow 0.12s,
    background 0.12s;
}

.constraint:hover:not(:disabled) {
  background: rgba(243, 244, 246, 0.72);
  border-color: rgba(0, 0, 0, 0.12);
}

.constraint:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.constraint--active:not(:disabled) {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px #2563eb;
  background: rgba(239, 246, 255, 0.72);
}

.constraint__status {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.constraint__status[data-status='pass'] {
  color: #1e7a45;
}

.constraint__status[data-status='fail'] {
  color: #b91c1c;
}

.constraint__status[data-status='skipped'] {
  color: #78716c;
}

.constraint__title {
  font-size: 0.84rem;
  font-weight: 650;
  color: #1a1a1a;
}

.constraint__desc {
  font-size: 0.72rem;
  line-height: 1.45;
  color: #5c5c5c;
}

.edge-enum.card {
  margin-top: 1.5rem;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 1rem 1.1rem 1.15rem;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.4) inset;
}

.edge-enum__hint {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  line-height: 1.5;
  color: #666;
}

.edge-enum__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.85rem;
  align-items: center;
  margin-bottom: 0.65rem;
}

.edge-enum__select {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.85rem;
  color: #333;
}

.edge-enum__select-label {
  white-space: nowrap;
}

.edge-enum__select-input {
  min-width: 5.5rem;
  padding: 0.38rem 0.55rem;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font-size: 0.85rem;
}

.edge-enum__textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 0.65rem 0.75rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.72rem;
  line-height: 1.4;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: rgba(246, 247, 249, 0.55);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #1a1a1a;
  resize: vertical;
  min-height: 12rem;
  max-height: min(50vh, 480px);
}

.cube-json.card {
  margin-top: 1.5rem;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 1rem 1.1rem 1.15rem;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.4) inset;
}

.cube-json__title {
  margin: 0 0 0.65rem;
  font-size: 0.9rem;
  font-weight: 650;
  color: #333;
}

.cube-json__title code {
  font-size: 0.82rem;
  background: rgba(244, 244, 244, 0.65);
  padding: 0.15rem 0.35rem;
  border-radius: 6px;
}

.cube-json__pre {
  margin: 0;
  padding: 0.75rem 0.9rem;
  background: rgba(246, 247, 249, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.09);
  font-size: 0.78rem;
  line-height: 1.45;
  overflow: auto;
  max-height: min(40vh, 360px);
}

.cube-json__muted {
  margin: 0;
  font-size: 0.85rem;
  color: #666;
}

.cube-json__err {
  margin: 0;
  font-size: 0.85rem;
  color: #a8281e;
}

.facelets54.card {
  margin-top: 1.5rem;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 0.85rem 1rem 1rem;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.4) inset;
}

.facelets54__row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 1rem 1.35rem;
}

.facelets54__theme-side {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.85rem 1.15rem;
  flex: 0 1 auto;
}

.facelets54__left {
  flex: 1 1 14rem;
  min-width: 0;
}

.facelets54__input-wrap {
  position: relative;
  width: fit-content;
  max-width: 100%;
}

.facelets54__textarea {
  box-sizing: border-box;
  display: block;
  width: 54ch;
  max-width: 100%;
  height: 2.05rem;
  min-height: 2.05rem;
  margin: 0 0 0.5rem;
  padding: 0.32rem 3.6rem 0.32rem 0.4rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.35;
  white-space: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  resize: none;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.52);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #1a1a1a;
}

.facelets54__textarea:focus {
  outline: none;
  border-color: #5b7cfa;
  box-shadow: 0 0 0 2px rgba(91, 124, 250, 0.2);
}

.facelets54__counter {
  position: absolute;
  right: 0.38rem;
  bottom: 0.42rem;
  pointer-events: none;
  font-size: 0.65rem;
  font-variant-numeric: tabular-nums;
  color: rgba(75, 78, 90, 0.95);
  line-height: 1;
  user-select: none;
}

.facelets54__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.facelets54__err {
  margin: 0 0 0.5rem;
  font-size: 0.82rem;
  color: #a8281e;
}

.face-theme {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.45rem;
  padding-top: 0.1rem;
}

.face-theme__row {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: center;
  gap: 0.22rem;
}

.face-theme__swatch {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.06rem;
  width: 1.72rem;
  flex-shrink: 0;
  cursor: pointer;
}

.face-theme__tile {
  width: 1.48rem;
  height: 1.48rem;
  border: 2px solid #141414;
  border-radius: 2px;
  box-sizing: border-box;
  flex-shrink: 0;
}

.face-theme__lbl {
  font-size: 0.6rem;
  font-weight: 700;
  color: #3a3a3a;
  line-height: 1;
  user-select: none;
}

.face-theme__color {
  position: absolute;
  left: 50%;
  top: 0;
  transform: translateX(-50%);
  width: 1.55rem;
  height: 1.48rem;
  margin: 0;
  padding: 0;
  border: 0;
  opacity: 0;
  cursor: pointer;
}

.face-theme__reset {
  padding: 0.32rem 0.65rem;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(250, 250, 250, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font-size: 0.78rem;
  color: #444;
  cursor: pointer;
}

.face-theme__reset:hover {
  background: rgba(238, 238, 238, 0.75);
}
</style>
