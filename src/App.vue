<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
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
import { invertAlgorithmMoves, invertMoveToken, splitAlgorithm } from './cube/layerTurn';
import { FACES, type FaceId } from './cube/types';
import RandomFillPrewarmWorker from './workers/randomFillPrewarm.worker.ts?worker';
import { useAppChrome } from './i18n/useAppI18n';
import type { Locale } from './i18n/messages';
import { VALIDATION_TREE_DOC_EN, VALIDATION_TREE_DOC_ZH } from './constraints/validationTreeDoc';

/** 六个中心格不可改色（与轴固定） */
const LOCKED_CENTER = new Set<number>(CENTER_INDICES);

/** 为 true 时显示下方「枚举 / buildCube JSON」开发面板；逻辑与函数仍保留，默认不向普通用户展示 */
const SHOW_DEV_CUBE_ENUM_JSON = false;

const { isDark, locale, t, toggleColorScheme, setLocale: setLocaleBase } = useAppChrome();
provide('i18nT', t);

/** 切换语言：先淡出再更新文案再淡入 */
const localeHidden = ref(false);
async function setLocale(next: Locale) {
  if (next === locale.value) return;
  localeHidden.value = true;
  await new Promise((r) => setTimeout(r, 580));
  setLocaleBase(next);
  await nextTick();
  localeHidden.value = false;
}

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
    facelets54ApplyError.value = t('facelets.err.len', { n: compact.length });
    return;
  }
  let out = '';
  for (let i = 0; i < 54; i++) {
    const ch = compact[i]!;
    if (!isFaceletChar(ch)) {
      facelets54ApplyError.value = t('facelets.err.char', {
        i: i + 1,
        ch: JSON.stringify(ch),
        empty: EMPTY_FACELET,
      });
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

/** 已向「下一步」推进过至少一次时，撤销回退演示步并保留步骤条 */
const shouldSyncSolutionOnUndo = computed(() => {
  if (solutionMoves.value.length === 0) return false;
  if (solutionIsReverse.value) return !reverseAwaitingFirstNext.value;
  return solutionStepIndex.value > 0;
});

function syncSolutionAfterUndo(prevFacelets: string) {
  if (solutionMoves.value.length === 0) return;
  if (solutionIsReverse.value) {
    const target = reverseDemoTargetFacelets.value;
    if (target && prevFacelets === target) {
      reverseAwaitingFirstNext.value = true;
      solutionStepIndex.value = 0;
      return;
    }
    if (prevFacelets === solvedString()) {
      reverseAwaitingFirstNext.value = false;
      solutionStepIndex.value = 0;
      return;
    }
    let c = Cube.fromString(solvedString());
    for (let i = 0; i < solutionMoves.value.length; i++) {
      c.move(solutionMoves.value[i]!);
      if (c.asString() === prevFacelets) {
        solutionStepIndex.value = i + 1;
        reverseAwaitingFirstNext.value = false;
        return;
      }
    }
    return;
  }
  const start = solutionPlaybackStartFacelets.value;
  if (!start) return;
  if (prevFacelets === start) {
    solutionStepIndex.value = 0;
    return;
  }
  let c = Cube.fromString(start);
  for (let i = 0; i < solutionMoves.value.length; i++) {
    c.move(solutionMoves.value[i]!);
    if (c.asString() === prevFacelets) {
      solutionStepIndex.value = i + 1;
      return;
    }
  }
}

async function undoFacelets() {
  if (undoStack.value.length === 0) return;
  if (solutionAnimating.value) return;
  const syncSol = shouldSyncSolutionOnUndo.value;
  const view = cube3dRef.value;
  const prevPeek = undoStack.value[undoStack.value.length - 1]!;
  const target = reverseDemoTargetFacelets.value;
  const revSolvedToX =
    syncSol &&
    solutionIsReverse.value &&
    solutionStepIndex.value === 0 &&
    !reverseAwaitingFirstNext.value &&
    target !== null &&
    prevPeek === target;

  if (syncSol && view && (revSolvedToX || solutionStepIndex.value > 0)) {
    const prev = undoStack.value.pop()!;
    solutionAnimating.value = true;
    try {
      if (revSolvedToX) {
        let c = Cube.fromString(solvedString());
        for (const m of solutionMoves.value) {
          await view.animateMove(m);
          c.move(m);
          skipInvalidationForSolutionStep.value = true;
          facelets.value = c.asString();
        }
        syncSolutionAfterUndo(prev);
      } else {
        const lastMove = solutionMoves.value[solutionStepIndex.value - 1]!;
        await view.animateMove(invertMoveToken(lastMove));
        isUndoing.value = true;
        try {
          skipInvalidationForSolutionStep.value = true;
          facelets.value = prev;
          syncSolutionAfterUndo(prev);
        } finally {
          isUndoing.value = false;
        }
      }
    } finally {
      solutionAnimating.value = false;
    }
    return;
  }

  isUndoing.value = true;
  try {
    const prev = undoStack.value.pop()!;
    const syncSol2 = shouldSyncSolutionOnUndo.value;
    if (syncSol2) skipInvalidationForSolutionStep.value = true;
    facelets.value = prev;
    if (syncSol2) {
      syncSolutionAfterUndo(prev);
      void nextTick(() => cube3dRef.value?.resetLayout());
    }
  } finally {
    isUndoing.value = false;
  }
}

const selectedCell = ref<number | null>(null);

/** 选色面板 `position:fixed` 锚点（最近一次点中贴纸的指针位置） */
const pickerPointerPos = ref({ x: 0, y: 0 });
const pickerPanelRef = ref<HTMLElement | null>(null);

const pickerFloatingStyle = computed(() => ({
  left: `${pickerPointerPos.value.x}px`,
  top: `${pickerPointerPos.value.y}px`,
}));

/** 浮窗选色条贴边后仍可能超出视口，按面板包围盒把锚点平移进可视区域（含 visualViewport） */
function clampPickerPanelIntoView() {
  const panel = pickerPanelRef.value;
  if (!panel || selectedCell.value === null) return;
  const rect = panel.getBoundingClientRect();
  const pad = 10;
  const vv = window.visualViewport;
  const vw = vv?.width ?? window.innerWidth;
  const vh = vv?.height ?? window.innerHeight;
  let dx = 0;
  let dy = 0;
  if (rect.left < pad) dx = pad - rect.left;
  if (rect.right > vw - pad) dx = vw - pad - rect.right;
  if (rect.top < pad) dy = pad - rect.top;
  if (rect.bottom > vh - pad) dy = vh - pad - rect.bottom;
  if (dx === 0 && dy === 0) return;
  const p = pickerPointerPos.value;
  pickerPointerPos.value = { x: p.x + dx, y: p.y + dy };
}

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
  titleKey: string;
  introKey: string;
  sourceIds: readonly ConstraintGroupId[];
}[] = [
  {
    id: 'edge_position',
    titleKey: 'constraints.edge_position.title',
    introKey: 'constraints.edge_position.intro',
    sourceIds: ['edge_local', 'perm_a'],
  },
  {
    id: 'corner_position',
    titleKey: 'constraints.corner_position.title',
    introKey: 'constraints.corner_position.intro',
    sourceIds: ['corner_local', 'perm_a'],
  },
  {
    id: 'edge_flip',
    titleKey: 'constraints.edge_flip.title',
    introKey: 'constraints.edge_flip.intro',
    sourceIds: ['flip_c'],
  },
  {
    id: 'corner_twist',
    titleKey: 'constraints.corner_twist.title',
    introKey: 'constraints.corner_twist.intro',
    sourceIds: ['twist_b'],
  },
  {
    id: 'parity',
    titleKey: 'constraints.parity.title',
    introKey: 'constraints.parity.intro',
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
    title: t(spec.titleKey),
    intro: t(spec.introKey),
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

/** 与右侧五条用户约束一致：任一条为「未通过」 */
const hasUserConstraintFailure = computed(() =>
  userConstraintRows.value.some((r) => r.status === 'fail'),
);

/** 仅当选中某一用户约束时在 3D 上高亮对应格；默认不高亮 */
const selectedUserConstraintId = ref<UserConstraintId | null>(null);

const constraintTreeModalOpen = ref(false);

const constraintValidationTreeBody = computed(() =>
  locale.value === 'en' ? VALIDATION_TREE_DOC_EN : VALIDATION_TREE_DOC_ZH,
);

function openConstraintTreeModal() {
  constraintTreeModalOpen.value = true;
}

function closeConstraintTreeModal() {
  constraintTreeModalOpen.value = false;
}

watchEffect((onCleanup) => {
  if (!constraintTreeModalOpen.value) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeConstraintTreeModal();
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));
});

const highlightIndices = computed(() => {
  const uid = selectedUserConstraintId.value;
  if (uid === null) return new Set<number>();
  const spec = USER_CONSTRAINT_SPEC.find((s) => s.id === uid);
  const urow = userConstraintRows.value.find((r) => r.id === uid);
  if (!spec || !urow) return new Set<number>();
  if (urow.status === 'skipped' && uid !== 'parity') return new Set<number>();
  return mergeCellIndicesForSources(constraintRows.value, spec.sourceIds);
});

function toggleUserConstraintHighlight(id: UserConstraintId) {
  const urow = userConstraintRows.value.find((r) => r.id === id);
  if (!urow || (urow.status === 'skipped' && id !== 'parity')) return;
  if (selectedUserConstraintId.value === id) {
    selectedUserConstraintId.value = null;
    return;
  }
  selectedUserConstraintId.value = id;
}

/** 点击约束抽屉内除约束条按钮外的区域时取消选中 */
function onConstraintsDrawerBackgroundClick(ev: MouseEvent) {
  const t = ev.target as HTMLElement | null;
  if (t?.closest('button.constraint') || t?.closest('.status')) return;
  selectedUserConstraintId.value = null;
}

async function onStickerClick(globalIdx: number, clientX: number, clientY: number) {
  if (LOCKED_CENTER.has(globalIdx)) return;
  if (selectedCell.value === globalIdx) {
    selectedCell.value = null;
    return;
  }
  selectedCell.value = globalIdx;
  pickerPointerPos.value = { x: clientX, y: clientY };
  await nextTick();
  requestAnimationFrame(() => {
    clampPickerPanelIntoView();
    requestAnimationFrame(() => clampPickerPanelIntoView());
  });
}

function onStickerPointerMiss() {
  clearSelection();
}

watchEffect((onCleanup) => {
  if (selectedCell.value === null) return;
  const onViewportChange = () => {
    requestAnimationFrame(() => {
      clampPickerPanelIntoView();
      requestAnimationFrame(() => clampPickerPanelIntoView());
    });
  };
  window.addEventListener('resize', onViewportChange);
  window.visualViewport?.addEventListener('resize', onViewportChange);
  window.visualViewport?.addEventListener('scroll', onViewportChange);
  onCleanup(() => {
    window.removeEventListener('resize', onViewportChange);
    window.visualViewport?.removeEventListener('resize', onViewportChange);
    window.visualViewport?.removeEventListener('scroll', onViewportChange);
  });
});

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
  if (hasUserConstraintFailure.value) return;
  randomPopoverOpen.value = false;
  applyRandomFillRemainingByConstraintChain();
}

watchEffect((onCleanup) => {
  if (!randomPopoverOpen.value) return;
  const onDoc = (e: PointerEvent) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('.toolbar__random-wrap') || el?.closest('.random-popover')) return;
    randomPopoverOpen.value = false;
  };
  document.addEventListener('pointerdown', onDoc, true);
  onCleanup(() => document.removeEventListener('pointerdown', onDoc, true));
});

/** 「随机」浮层：Teleport + fixed，避免侧栏 overflow 裁切；宽与按钮同；「全部 / 未选」叠在按钮右侧 */
const randomBtnRef = ref<HTMLButtonElement | null>(null);
const randomBtnPx = ref({ w: 0, h: 0 });
const randomBtnRect = ref({ left: 0, top: 0, right: 0, width: 0, height: 0 });

function measureRandomBtnSize() {
  const el = randomBtnRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  randomBtnPx.value = { w: r.width, h: r.height };
  randomBtnRect.value = {
    left: r.left,
    top: r.top,
    right: r.right,
    width: r.width,
    height: r.height,
  };
}

watchEffect((onCleanup) => {
  if (!randomPopoverOpen.value) return;
  const sync = () => measureRandomBtnSize();
  sync();
  window.addEventListener('scroll', sync, true);
  window.addEventListener('resize', sync);
  onCleanup(() => {
    window.removeEventListener('scroll', sync, true);
    window.removeEventListener('resize', sync);
  });
});

watch(randomPopoverOpen, (open) => {
  if (open) void nextTick(() => measureRandomBtnSize());
});

const randomPopoverBoxStyle = computed(() => {
  const { w, h } = randomBtnPx.value;
  const r = randomBtnRect.value;
  const base = {
    position: 'fixed' as const,
    left: `${r.right + 4}px`,
    top: `${r.top + 4}px`,
    boxSizing: 'border-box' as const,
    zIndex: 10000,
  };
  if (w <= 0 || h <= 0) {
    return {
      ...base,
      visibility: 'hidden' as const,
      pointerEvents: 'none' as const,
    };
  }
  const row = h - 2;
  return {
    ...base,
    width: `${w}px`,
    height: `${row * 2}px`,
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
  mobileLayoutMql?.removeEventListener('change', syncIsMobileLayout);
});

const solverInitialized = ref(false);
const solverLoading = ref(false);

function ensureSolverInitialized() {
  if (solverInitialized.value) return;
  Cube.initSolver();
  solverInitialized.value = true;
}

/** 首次点「步骤」前会卡：在首屏渲染后的空闲时段预加载 cubejs 求解表 */
function prewarmSolverWhenIdle() {
  const run = () => {
    if (solverInitialized.value) return;
    try {
      ensureSolverInitialized();
    } catch {
      /* 首次求步时会再试 */
    }
  };
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(run, { timeout: 4000 });
  } else {
    setTimeout(run, 0);
  }
}

/** 与 @media (max-width: 900px) 一致：窄屏时透明度滑块移到顶栏首行左侧 */
const isMobileLayout = ref(
  typeof window !== 'undefined' ? window.matchMedia('(max-width: 900px)').matches : false,
);
let mobileLayoutMql: MediaQueryList | null = null;
function syncIsMobileLayout() {
  if (typeof window === 'undefined') return;
  isMobileLayout.value = window.matchMedia('(max-width: 900px)').matches;
}

onMounted(() => {
  prewarmSolverWhenIdle();
  syncIsMobileLayout();
  mobileLayoutMql = window.matchMedia('(max-width: 900px)');
  mobileLayoutMql.addEventListener('change', syncIsMobileLayout);
});
const solverError = ref<string | null>(null);
const solverBanner = ref<string | null>(null);
const solutionMoves = ref<string[]>([]);
const solutionStepIndex = ref(0);
/** 逆向演示：尚未执行首次「下一步」复位时为 true，之后每步施转列表中一步 */
const reverseAwaitingFirstNext = ref(false);
const solutionIsReverse = ref(false);
const reverseDemoTargetFacelets = ref<string | null>(null);
/** 正系「步骤」演示：获取序列时的 54 位串，撤销时用于对齐步数 */
const solutionPlaybackStartFacelets = ref<string | null>(null);
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

/** 点击「步骤 / 逆向步骤」后有可展示内容时显示左上步骤条，否则不占位 */
const solverStripVisible = computed(
  () =>
    solverError.value != null ||
    solverBanner.value != null ||
    solutionMoves.value.length > 0,
);

function clearSolutionState() {
  solutionMoves.value = [];
  solutionStepIndex.value = 0;
  solverError.value = null;
  solverBanner.value = null;
  solutionIsReverse.value = false;
  reverseAwaitingFirstNext.value = false;
  reverseDemoTargetFacelets.value = null;
  solutionPlaybackStartFacelets.value = null;
}

async function fetchSolution() {
  solverError.value = null;
  solverBanner.value = null;
  if (!faceletsComplete.value) {
    solverError.value = t('solver.err.fill54');
    return;
  }
  if (!report.value.ok) {
    solverError.value = t('solver.err.notSolvableForward');
    return;
  }
  solverLoading.value = true;
  try {
    ensureSolverInitialized();
    const c = Cube.fromString(facelets.value);
    if (c.isSolved()) {
      solutionMoves.value = [];
      solutionStepIndex.value = 0;
      solutionIsReverse.value = false;
      reverseAwaitingFirstNext.value = false;
      reverseDemoTargetFacelets.value = null;
      solverBanner.value = t('solver.banner.alreadySolvedForward');
      return;
    }
    const alg = c.solve();
    solutionIsReverse.value = false;
    reverseAwaitingFirstNext.value = false;
    reverseDemoTargetFacelets.value = null;
    solutionMoves.value = splitAlgorithm(alg);
    solutionPlaybackStartFacelets.value = facelets.value;
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
    solverError.value = t('solver.err.fill54');
    return;
  }
  if (!report.value.ok) {
    solverError.value = t('solver.err.notSolvableReverse');
    return;
  }
  solverLoading.value = true;
  try {
    ensureSolverInitialized();
    const snapshot = facelets.value;
    const c = Cube.fromString(snapshot);
    if (c.isSolved()) {
      solutionMoves.value = [];
      solutionStepIndex.value = 0;
      solutionIsReverse.value = false;
      reverseAwaitingFirstNext.value = false;
      reverseDemoTargetFacelets.value = null;
      solverBanner.value = t('solver.banner.alreadySolvedReverse');
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
          solverError.value = t('solver.err.reverseMismatch');
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

/** 0–100：0% 不透明，100% 最透明（映射到贴纸/黑框 alpha 1 → 0.1） */
const transparencyPercent = ref(0);

const stickerOpacity = computed(() => {
  const t = Math.min(100, Math.max(0, transparencyPercent.value));
  return 1 - (t / 100) * 0.9;
});

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
    <div class="page-cube-layer">
      <section class="view-3d view-3d--fullscreen">
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
          :dark-scene="isDark"
          :view-aria-label="t('app.aria.cube3d')"
          @sticker-click="onStickerClick"
          @sticker-pointer-miss="onStickerPointerMiss"
        />
      </section>
    </div>
    <div class="page-ui">
    <div class="app-chrome" :aria-label="t('app.aria.chrome')">
      <label
        v-if="isMobileLayout"
        class="semi-opacity semi-opacity--chrome-mobile"
        :aria-label="t('theme.opacityAria')"
      >
        <input
          v-model.number="transparencyPercent"
          class="semi-opacity__range"
          :style="{ '--semi-opacity-pct': `${transparencyPercent}%` }"
          type="range"
          min="0"
          max="100"
          step="1"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="transparencyPercent"
        />
      </label>
      <div class="app-chrome__end">
        <button
          type="button"
          class="app-chrome__icon"
          :title="isDark ? t('chrome.themeToLight') : t('chrome.themeToDark')"
          @click="toggleColorScheme"
        >
          <span class="app-chrome__icon-inner" aria-hidden="true">
            <Transition name="chrome-ico" mode="out-in">
              <svg
                v-if="!isDark"
                key="sun"
                class="app-chrome__svg"
                viewBox="0 0 24 24"
                width="20"
                height="20"
              >
                <circle cx="12" cy="12" r="4.2" fill="currentColor" />
                <g stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none">
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </g>
              </svg>
              <svg
                v-else
                key="moon"
                class="app-chrome__svg"
                viewBox="0 0 24 24"
                width="20"
                height="20"
              >
                <defs>
                  <mask id="app-chrome-moon-mask">
                    <rect width="24" height="24" fill="white" />
                    <circle cx="16" cy="9" r="7.15" fill="black" />
                  </mask>
                </defs>
                <circle cx="13" cy="11" r="7.15" fill="currentColor" mask="url(#app-chrome-moon-mask)" />
              </svg>
            </Transition>
          </span>
        </button>
        <div class="app-chrome__lang" role="group" :aria-label="t('chrome.lang')">
          <button
            type="button"
            class="app-chrome__lang-btn"
            :class="{ 'app-chrome__lang-btn--on': locale === 'zh' }"
            @click="setLocale('zh')"
          >
            中
          </button>
          <button
            type="button"
            class="app-chrome__lang-btn"
            :class="{ 'app-chrome__lang-btn--on': locale === 'en' }"
            @click="setLocale('en')"
          >
            EN
          </button>
        </div>
      </div>
    </div>
    <div class="page-ui__locale-fade" :class="{ 'page-ui__locale-fade--hide': localeHidden }">
    <div class="page-ui-i18n">
    <!-- 面串输入固定左上宽区；输入框宽度单独限制，「应用」在下一行左对齐 -->
    <div class="app-io-layer">
        <div class="toolbar__io-block">
        <section
          v-if="!isMobileLayout"
          class="facelets54 card facelets54--corner"
          aria-label="facelets54"
        >
          <p v-if="facelets54ApplyError" class="facelets54__err">{{ facelets54ApplyError }}</p>
          <div class="facelets54__input-row">
            <div class="facelets54__input-wrap">
              <textarea
                ref="facelets54InputRef"
                v-model="facelets54Draft"
                class="facelets54__textarea"
                rows="1"
                spellcheck="false"
                wrap="off"
                :aria-label="t('facelets.label', { n: facelets54CompactLen })"
              />
              <span class="facelets54__counter">{{ t('facelets.counter', { n: facelets54CompactLen }) }}</span>
            </div>
            <button type="button" class="toolbar__btn-sm facelets54__apply" @click="applyFacelets54FromInput">
              {{ t('facelets.apply') }}
            </button>
          </div>
        </section>

        <div
          class="solver-strip"
          :class="{ 'solver-strip--visible': solverStripVisible }"
          :aria-hidden="!solverStripVisible"
        >
          <Transition name="solver-strip-t">
            <div v-if="solverStripVisible" class="solver-strip__content" key="solver-strip-body">
              <p v-if="solverError" class="solver-err solver-err--in-strip">{{ solverError }}</p>
              <template v-else-if="solutionMoves.length > 0">
                <div class="solver-strip__panel">
                  <div class="solver-strip__body">
                    <p class="solver-info__lead">
                      <template v-if="solutionIsReverse">
                        {{ t('solver.lead.reverse', { cur: solutionStepIndex, total: solutionMoves.length }) }}
                      </template>
                      <template v-else>
                        {{ t('solver.lead.forward', { cur: solutionStepIndex, total: solutionMoves.length }) }}
                      </template>
                    </p>
                    <ol
                      class="solver-steps"
                      :aria-label="solutionIsReverse ? t('solver.stepsAriaReverse') : t('solver.stepsAriaForward')"
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
                  <div class="solver-strip__footer">
                    <button
                      type="button"
                      class="toolbar__btn-sm solver-next-btn"
                      :disabled="!canAdvanceSolutionStep || solverLoading || solutionAnimating"
                      @click="nextSolutionStep"
                    >
                      {{ t('solver.next') }}
                    </button>
                  </div>
                </div>
              </template>
              <p v-else-if="solverBanner" class="solver-banner solver-banner--in-strip">{{ solverBanner }}</p>
              <div v-else class="solver-strip__placeholder" aria-hidden="true" />
            </div>
          </Transition>
        </div>
        </div>
    </div>
    </div>

    <div class="app-grid">
      <aside class="toolbar toolbar--left" :aria-label="t('app.aria.toolbar')">
        <button type="button" class="toolbar__primary" @click="setSolved">{{ t('toolbar.solved') }}</button>
        <div class="toolbar__random-wrap">
          <button
            ref="randomBtnRef"
            type="button"
            class="toolbar__primary"
            :disabled="!canUseRandomButton"
            @click="onRandomMainButtonClick"
          >
            {{ t('toolbar.random') }}
          </button>
          <Teleport to="body">
            <Transition name="mac-float">
              <div
                v-if="randomPopoverOpen"
                class="random-popover mac-float-surface"
                :style="randomPopoverBoxStyle"
                role="menu"
                :aria-label="t('toolbar.randomMenu')"
              >
                <button
                  type="button"
                  class="random-popover__btn"
                  role="menuitem"
                  @click="onRandomPopoverPickAll"
                >
                  {{ t('toolbar.randomAll') }}
                </button>
                <span
                  class="random-popover__rest-wrap"
                  :title="hasUserConstraintFailure ? t('toolbar.randomRestDisabledTip') : undefined"
                >
                  <button
                    type="button"
                    class="random-popover__btn"
                    role="menuitem"
                    :disabled="hasUserConstraintFailure"
                    @click="onRandomPopoverPickRest"
                  >
                    {{ t('toolbar.randomRest') }}
                  </button>
                </span>
              </div>
            </Transition>
          </Teleport>
        </div>
        <button type="button" class="toolbar__primary" @click="clearExceptCenters">{{ t('toolbar.clear') }}</button>
        <button
          type="button"
          class="toolbar__primary"
          :disabled="!canUndo || solutionAnimating"
          @click="undoFacelets"
        >
          {{ t('toolbar.undo') }}
        </button>
        <span class="toolbar__row-break" aria-hidden="true" />
        <button
          type="button"
          class="toolbar__primary"
          :disabled="!canFillFaceUniqueConstraint"
          @click="fillOneFaceUniqueConstraintCandidates"
        >
          {{ t('toolbar.fillUnique') }}
        </button>
        <button
          type="button"
          class="toolbar__primary"
          :disabled="solverLoading || solutionAnimating || !faceletsComplete || !report.ok"
          @click="fetchSolution"
        >
          {{ solverLoading ? t('toolbar.solverLoading') : t('toolbar.steps') }}
        </button>
        <button
          type="button"
          class="toolbar__primary"
          :disabled="solverLoading || solutionAnimating || !faceletsComplete || !report.ok"
          @click="fetchReverseSolution"
        >
          {{ solverLoading ? t('toolbar.solverLoading') : t('toolbar.reverseSteps') }}
        </button>
      </aside>

      <aside class="app-side-column" :aria-label="t('app.aria.side')">
        <section class="header-theme card" :aria-label="t('theme.faceColors')">
          <div class="header-theme__inner">
            <div class="face-theme face-theme--inline">
              <div class="face-theme__palette" role="group" :aria-label="t('theme.faceSwatches')">
                <div class="face-theme__swatches">
                  <label
                    v-for="f in FACES"
                    :key="f"
                    class="face-theme__swatch"
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
                <button type="button" class="toolbar__btn-sm face-theme__reset" @click="resetFaceDisplayColors">
                  {{ t('theme.reset') }}
                </button>
              </div>
            </div>
            <label v-if="!isMobileLayout" class="semi-opacity">
              <input
                v-model.number="transparencyPercent"
                class="semi-opacity__range"
                :style="{ '--semi-opacity-pct': `${transparencyPercent}%` }"
                type="range"
                min="0"
                max="100"
                step="1"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="transparencyPercent"
                :aria-label="t('theme.opacityAria')"
              />
            </label>
          </div>
        </section>

        <section
          v-if="isMobileLayout"
          class="facelets54 card facelets54--corner facelets54--between-theme-constraints"
          aria-label="facelets54"
        >
          <p v-if="facelets54ApplyError" class="facelets54__err">{{ facelets54ApplyError }}</p>
          <div class="facelets54__input-row">
            <div class="facelets54__input-wrap">
              <textarea
                ref="facelets54InputRef"
                v-model="facelets54Draft"
                class="facelets54__textarea"
                rows="1"
                spellcheck="false"
                wrap="off"
                :aria-label="t('facelets.label', { n: facelets54CompactLen })"
              />
            </div>
            <div class="facelets54__apply-row">
              <button type="button" class="toolbar__btn-sm facelets54__apply" @click="applyFacelets54FromInput">
                {{ t('facelets.apply') }}
              </button>
              <span class="facelets54__counter facelets54__counter--beside-apply">{{ t('facelets.counter', { n: facelets54CompactLen }) }}</span>
            </div>
          </div>
        </section>

        <div class="panel panel--constraints" :aria-label="t('constraints.panel')">
          <div class="constraints-drawer" @click="onConstraintsDrawerBackgroundClick">
            <div
              class="status"
              :class="report.ok ? 'status--ok' : 'status--bad'"
              :title="t('constraints.validationTreeDblclickHint')"
              @dblclick.stop="openConstraintTreeModal"
            >
              {{ report.ok ? t('constraints.statusOk') : t('constraints.statusBad') }}
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
                  :disabled="row.status === 'skipped' && row.id !== 'parity'"
                  :aria-pressed="selectedUserConstraintId === row.id"
                  @click.stop="toggleUserConstraintHighlight(row.id)"
                >
                  <span class="constraint__status" :data-status="row.status">{{
                    row.status === 'pass'
                      ? t('constraints.pass')
                      : row.status === 'fail'
                        ? t('constraints.fail')
                        : t('constraints.skipped')
                  }}</span>
                  <span class="constraint__title">{{ row.title }}</span>
                  <span class="constraint__desc">{{ row.intro }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
      </aside>
    </div>
    </div>

    <Transition name="mac-float">
      <div
        v-if="selectedCell !== null"
        class="picker-anchor"
        :style="pickerFloatingStyle"
      >
        <div ref="pickerPanelRef" class="picker picker--floating card mac-float-surface">
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

    <Teleport to="body">
      <Transition name="constraint-tree-fade">
        <div
          v-if="constraintTreeModalOpen"
          class="constraint-tree-doc-overlay"
          role="dialog"
          aria-modal="true"
          :aria-label="t('constraints.validationTreeAria')"
          @click="closeConstraintTreeModal"
        >
          <pre class="constraint-tree-doc">{{ constraintValidationTreeBody }}</pre>
        </div>
      </Transition>
    </Teleport>

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
  </div>
</template>

<style scoped>
.page {
  --glass-blur: blur(16px);

  position: relative;
  min-height: 100vh;
  margin: 0;
  padding: 0;
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    'Helvetica Neue',
    Arial,
    sans-serif;
  color: var(--ui-text);
  background: transparent;
  transition: color 0.45s ease;
}

.page-cube-layer {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: auto;
  background: transparent;
  overflow: hidden;
}

.page-cube-layer::before,
.page-cube-layer::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  transition: opacity 1.2s ease;
}

.page-cube-layer::before {
  opacity: 1;
  background-color: #f4e8dc;
  background-image:
    radial-gradient(ellipse 100% 68% at 50% 16%, rgba(255, 248, 235, 0.72) 0%, transparent 54%),
    radial-gradient(ellipse 70% 45% at 80% 20%, rgba(255, 220, 190, 0.35) 0%, transparent 50%),
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 3px,
      rgba(120, 80, 40, 0.028) 3px,
      rgba(120, 80, 40, 0.028) 6px
    ),
    repeating-linear-gradient(
      90deg,
      transparent,
      transparent 3px,
      rgba(120, 80, 40, 0.028) 3px,
      rgba(120, 80, 40, 0.028) 6px
    ),
    linear-gradient(168deg, #fff9f2 0%, #f5e6d6 38%, #e9d8c8 72%, #dec9b8 100%);
  background-attachment: fixed;
}

.page-cube-layer::after {
  opacity: 0;
  background-color: #0a0c10;
  background-image:
    radial-gradient(ellipse 90% 55% at 50% 12%, rgba(96, 165, 250, 0.22) 0%, transparent 55%),
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 4px,
      rgba(255, 255, 255, 0.016) 4px,
      rgba(255, 255, 255, 0.016) 8px
    ),
    linear-gradient(168deg, #0c0e14 0%, #141a2d 42%, #0a0d12 100%);
  background-attachment: fixed;
}

.page-cube-layer > * {
  position: relative;
  z-index: 1;
}

.view-3d--fullscreen {
  width: 100%;
  height: 100%;
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.page-cube-layer :deep(.cube-3d) {
  width: 100%;
  height: 100%;
  min-height: min(100vh, 100dvh);
  max-width: none;
  border-radius: 0;
}

.page-ui {
  /** 与 .app-io-layer 共用，避免 fixed 相对视口而主内容在 body margin 内导致左右错位 */
  --page-ui-pad-x: clamp(0.75rem, 2vw, 1.25rem);
  position: relative;
  z-index: 1;
  pointer-events: none;
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 1.5rem var(--page-ui-pad-x) 3rem;
  min-height: 100vh;
  box-sizing: border-box;
}

.page-ui > * {
  pointer-events: auto;
}

/** 勿对含 fixed 子元素的祖先使用 filter，否则 fixed 会相对该层定位导致跳动 */
.page-ui > .page-ui__locale-fade {
  pointer-events: none;
  /** 去掉 --hide 后由 0→1 淡入，时长主要调这里 */
  transition: opacity 1.15s ease;
}

.page-ui > .page-ui__locale-fade.page-ui__locale-fade--hide {
  /** 加上 --hide 后由 1→0 淡出，可与淡入不同 */
  transition: opacity 0.55s ease;
}

.page-ui__locale-fade > * {
  pointer-events: auto;
}

.page-ui__locale-fade--hide {
  opacity: 0;
  pointer-events: none;
}

.page-ui__locale-fade--hide > * {
  pointer-events: none;
}

.app-chrome {
  position: fixed;
  z-index: 60;
  top: 1rem;
  right: clamp(0.75rem, 2vw, 1.25rem);
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.45rem;
  pointer-events: auto;
}

.app-chrome__end {
  display: inline-flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.45rem;
}

.app-chrome__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border-radius: 0.45rem;
  border: 1px solid var(--hairline);
  background: var(--glass-bg);
  color: var(--ui-text);
  cursor: pointer;
  backdrop-filter: var(--glass-blur);
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.07);
  transition:
    background 0.45s ease,
    color 0.45s ease,
    border-color 0.45s ease,
    box-shadow 0.45s ease,
    transform 0.15s ease;
}

.app-chrome__icon:hover {
  background: var(--accent-soft);
  border-color: var(--hairline-strong);
}

.app-chrome__icon:active {
  transform: scale(0.96);
}

.app-chrome__svg {
  display: block;
}

.app-chrome__lang {
  display: inline-flex;
  flex-direction: row;
  border-radius: 0.45rem;
  border: 1px solid var(--hairline);
  background: var(--glass-bg);
  color: var(--ui-text);
  overflow: hidden;
  backdrop-filter: var(--glass-blur);
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.07);
  transition: background 0.45s ease, border-color 0.45s ease, box-shadow 0.45s ease;
}

.app-chrome__lang-btn {
  margin: 0;
  padding: 0.38rem 0.72rem;
  border: none;
  background: transparent;
  color: var(--ui-muted);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer;
  opacity: 0.62;
  transition: background 0.4s ease, color 0.4s ease, opacity 0.4s ease, font-weight 0.4s ease;
}

.app-chrome__lang-btn--on {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 650;
  opacity: 1;
}

.app-chrome__lang-btn:not(.app-chrome__lang-btn--on):hover {
  background: var(--chrome-hover);
  opacity: 0.88;
}

.chrome-ico-enter-active,
.chrome-ico-leave-active {
  transition: opacity 0.28s ease, transform 0.28s ease;
}

.chrome-ico-enter-from,
.chrome-ico-leave-to {
  opacity: 0;
  transform: rotate(-18deg) scale(0.85);
}

/** 输入 + 步骤：与窄按钮栏分离，固定左上，宽可达 70ch，不拉长左侧命中条 */
.app-io-layer {
  position: fixed;
  z-index: 2;
  left: var(--page-ui-pad-x);
  top: 1.5rem;
  max-width: min(70ch, calc(100vw - 280px));
  width: min(53ch, calc(100vw - 2 * var(--page-ui-pad-x)));
  box-sizing: border-box;
  pointer-events: none;
}

.app-io-layer > * {
  pointer-events: auto;
}

.app-io-layer .toolbar__io-block {
  max-height: min(60vh, 28rem);
  overflow-y: auto;
}

.app-grid {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem 1.5rem;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  pointer-events: none;
}

.toolbar--left,
.app-side-column {
  pointer-events: auto;
}

.toolbar__io-block {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
  min-width: 0;
}

.app-side-column {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.75rem;
  min-width: 0;
  width: min(260px, 100%);
  max-width: 260px;
  position: sticky;
  top: 1rem;
  align-self: flex-start;
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  text-align: left;
  /** 为右上角主题/语言控件留出空间 */
  padding-top: 2.6rem;
  box-sizing: border-box;
}

.app-side-column .semi-opacity {
  width: 100%;
}

.app-side-column .semi-opacity__range {
  width: min(10rem, 100%);
  max-width: 100%;
}

.app-side-column .header-theme.card {
  margin-top: 0;
}

.header-theme__inner {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.55rem;
  padding-left: 0.52rem;
  padding-right: 0.72rem;
  box-sizing: border-box;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

/** 桌面隐藏；移动端 flex 内占满一行以强制换行（前 4 钮 / 后 3 钮） */
.toolbar__row-break {
  display: none;
}

.toolbar--left {
  flex: 0 1 auto;
  flex-direction: column;
  flex-wrap: nowrap;
  align-items: stretch;
  position: sticky;
  top: 1rem;
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  min-width: 0;
  /** 仅按钮列：约 9em 字宽 + 边距，不再与输入区同宽 */
  width: min(100%, 11.5rem);
  max-width: min(11.5rem, max(10rem, 28vw));
  /** 只把左侧按钮列下移，避免与固定输入区重叠；勿写在 .app-grid 上，否则右侧栏会一起被顶下去 */
  margin-top: clamp(10rem, 28vh, 20rem);
}

/** 左栏按钮统一为约九字宽（1em≈一个汉字宽），超出省略 */
.toolbar--left > button,
.toolbar--left > .toolbar__random-wrap {
  align-self: flex-start;
  width: 9em;
  min-width: 9em;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}

.toolbar--left .toolbar__random-wrap > .toolbar__primary {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
}

.toolbar__io-block .toolbar__primary {
  align-self: flex-start;
  width: 9em;
  min-width: 9em;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}

.toolbar__io-block .toolbar__btn-sm {
  align-self: center;
  width: auto;
  min-width: 0;
  max-width: 100%;
  white-space: nowrap;
}

/** 面串「应用」在窄 `input-row` 内须左对齐，避免被上行 `align-self: center` 居中 */
.toolbar__io-block .facelets54__apply {
  align-self: flex-start;
}

.toolbar__random-wrap {
  position: relative;
  /** 与 .toolbar button 同字号，否则 9em 相对继承的 1rem 算，会比子按钮（0.875rem）上 9em 更宽 */
  font-size: 0.875rem;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
}

.toolbar__random-wrap > .toolbar__primary {
  width: 100%;
}

.random-popover {
  position: fixed;
  z-index: 10000;
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
  color: var(--ui-text);
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

.random-popover__rest-wrap {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid rgba(0, 0, 0, 0.07);
}

.random-popover__rest-wrap .random-popover__btn {
  width: 100%;
}

/** 禁用时不接收指针，悬停落在父级 `span` 上以触发原生 `title` */
.random-popover__rest-wrap:has(.random-popover__btn:disabled) .random-popover__btn:disabled {
  pointer-events: none;
}

.random-popover__btn:disabled {
  opacity: 0.45;
  filter: grayscale(0.35);
}

.random-popover__btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.05);
}

.mac-float-surface {
  border: 1px solid var(--hairline);
  background: var(--glass-bg);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.07);
  border-radius: 8px;
  transition:
    background 0.45s ease,
    border-color 0.45s ease,
    box-shadow 0.45s ease;
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
  padding: 0.38rem 0.72rem;
  border-radius: 6px;
  border: 1px solid var(--hairline);
  background: transparent;
  cursor: pointer;
  font-size: 0.875rem;
}

.toolbar button.toolbar__btn-sm {
  padding: 0.22rem 0.42rem;
  font-size: 0.78rem;
  border-color: var(--accent);
  color: var(--accent-text);
  font-weight: 600;
}

.toolbar button:hover {
  background: rgba(255, 255, 255, 0.55);
  border-color: var(--hairline-strong);
}

.toolbar button.toolbar__btn-sm:hover:not(:disabled) {
  background: var(--accent-soft);
  border-color: var(--accent);
}

/** 小号主按钮：与主工具条同色线框，用于「应用」「重置」等 */
.toolbar__btn-sm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.22rem 0.42rem;
  font-size: 0.78rem;
  font-weight: 600;
  line-height: 1.2;
  border-radius: 5px;
  border: 1px solid var(--accent);
  color: var(--accent-text);
  background: transparent;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    background 0.45s ease,
    color 0.45s ease,
    border-color 0.45s ease;
}

.toolbar__btn-sm:hover:not(:disabled) {
  background: var(--accent-soft);
}

.toolbar__btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toolbar__primary {
  border-color: var(--accent) !important;
  color: var(--accent-text);
  font-weight: 600;
  transition:
    background 0.45s ease,
    color 0.45s ease,
    border-color 0.45s ease;
}

.toolbar__primary:hover:not(:disabled) {
  background: var(--accent-soft) !important;
}

.toolbar__primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/** 求解步骤条：有内容时淡入展开，无内容时淡出；移动端预留空位避免整列突然下跳 */
.solver-strip {
  display: block;
  overflow: hidden;
  font-size: 0.88rem;
  line-height: 1.45;
  box-sizing: border-box;
}

.solver-strip__content {
  box-sizing: border-box;
}

.solver-strip-t-enter-active,
.solver-strip-t-leave-active {
  transition:
    opacity 0.32s ease,
    max-height 0.42s cubic-bezier(0.33, 1, 0.68, 1),
    transform 0.32s ease;
  overflow: hidden;
}

.solver-strip-t-enter-from,
.solver-strip-t-leave-to {
  opacity: 0;
  max-height: 0;
  transform: translateY(-0.2rem);
}

.solver-strip-t-enter-to,
.solver-strip-t-leave-from {
  opacity: 1;
  max-height: 80rem;
  transform: translateY(0);
}

.solver-strip__placeholder {
  min-height: 3.25rem;
  border-radius: 0;
  border: none;
  border-bottom: 1px dashed var(--hairline);
  background: transparent;
}

.solver-strip__panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.35rem 0;
  border-radius: 0;
  border: none;
  background: transparent;
  color: var(--solver-text);
  box-shadow: none;
  transition: color 0.45s ease;
}

.solver-strip__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 0.5rem;
  width: 100%;
}

/** 与 facelets54「应用」同为 .toolbar__btn-sm，此处仅保证在步骤条里不收缩 */
.solver-next-btn {
  flex-shrink: 0;
}

.solver-strip__body {
  flex: 1;
  min-width: min(100%, 18rem);
}

.solver-err--in-strip,
.solver-banner--in-strip {
  margin: 0;
}

.solver-banner {
  padding: 0.25rem 0;
  border-radius: 0;
  border: none;
  color: var(--solver-banner);
  background: transparent;
  transition: color 0.45s ease;
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
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  border: 1px solid var(--hairline);
  background: transparent;
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
}

.solver-steps__item--done {
  color: #64748b;
  border-color: transparent;
  background: transparent;
}

.solver-steps__item--current {
  border-color: rgba(37, 99, 235, 0.45);
  background: rgba(239, 246, 255, 0.4);
  font-weight: 700;
  color: #1e40af;
}

.solver-steps__item--pending {
  color: #475569;
}

.solver-err {
  color: #a8281e;
  padding: 0.25rem 0;
  border-radius: 0;
  border: none;
  background: transparent;
}

@media (max-width: 900px) {
  /** 纵向：主题/语言 → 面串+应用+步骤 →（固定魔方可视区）→ 七钮 → 选色+重置 → 约束；cube 仍在 .page 下，用下边距为魔方留白；仅用 vh/rem，不用 vmin，避免随屏宽变化 */
  /**
   * vh：1vh = 视口高度的 1%（仅随窗口高度变，与屏宽无直接关系）。rem：1rem = 根元素 html 的 font-size（常见默认 16px），与视口无固定换算，随用户/站点根字号而变。
   * 用 min(54vh, 22rem) 同时表达「跟屏高成比例」与「再长也别超过约 22 字宽的排版上限」；min 取二者较小值，故只有较小的一侧在「生效」。
   */
  .page {
    --mobile-cube-stack-gap: min(55vh, 24rem);
  }

  .page-ui {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding-top: 0.75rem;
  }

  .app-chrome {
    position: static;
    align-self: stretch;
    width: 100%;
    max-width: 100%;
    justify-content: flex-start;
    align-items: center;
    margin: 0 0 0.55rem;
  }

  .app-chrome__end {
    margin-left: auto;
  }

  .semi-opacity--chrome-mobile {
    flex: 0 1 auto;
    min-width: 0;
    margin: 0;
  }

  .semi-opacity--chrome-mobile .semi-opacity__range {
    width: min(12.5rem, 46vw);
    max-width: 100%;
  }

  .page-ui-i18n {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.55rem;
    width: 100%;
    margin-bottom: var(--mobile-cube-stack-gap);
  }

  .app-io-layer {
    position: static;
    left: auto;
    top: auto;
    z-index: auto;
    width: 100%;
    max-width: none;
    margin-bottom: 0;
  }

  .app-io-layer .toolbar__io-block {
    max-height: none;
    overflow-y: visible;
  }

  /** 步骤行：无内容时仍占一条固定高度，避免下方区域突然下跳；虚线提示可展开区域 */
  .solver-strip {
    min-height: 10rem;
  }

  .solver-strip:not(.solver-strip--visible) {
    border-bottom: 1px dashed var(--hairline);
  }

  .solver-strip--visible {
    border-bottom: none;
  }

  .facelets54__input-wrap {
    width: 100%;
    max-width: 100%;
  }

  .app-grid {
    flex-direction: column;
    align-items: stretch;
  }

  .toolbar--left {
    position: static;
    max-height: none;
    width: 100%;
    max-width: none;
    margin-top: 0;
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: flex-start;
    align-items: flex-start;
    align-content: flex-start;
    gap: 0.45rem;
    box-sizing: border-box;
  }

  /** 两行各自从左依次排，不做跨行列对齐（与 grid 四列不同） */
  .toolbar--left > button,
  .toolbar--left > .toolbar__random-wrap {
    flex: 0 0 auto;
    width: max-content;
    max-width: none;
    min-width: 0;
    overflow: visible;
    text-overflow: clip;
  }

  .toolbar--left .toolbar__row-break {
    display: block;
    flex-basis: 100%;
    width: 0;
    height: 0;
    overflow: hidden;
    margin: 0;
    padding: 0;
    border: none;
    align-self: stretch;
  }

  .toolbar--left .toolbar__random-wrap {
    width: max-content;
  }

  .toolbar--left .toolbar__random-wrap > .toolbar__primary {
    width: max-content;
    min-width: 0;
    max-width: none;
  }

  .app-side-column {
    position: static;
    max-height: none;
    overflow: visible;
    max-width: none;
    width: 100%;
    padding-top: 0.35rem;
  }

  /**
   * 六格条：固定约宽 + 足够 min-height，避免 overflow-x 滚动条挤占高度出现「条/滑块」；
   * 横向滚动条在触控上仍可用，仅弱化显示（scrollbar-width / webkit）
   */
  .face-theme.face-theme--inline .face-theme__swatches {
    flex: 0 1 auto;
    width: 11.55rem;
    max-width: calc(100% - 4.75rem);
    min-width: 0;
    min-height: 2.85rem;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .face-theme.face-theme--inline .face-theme__swatches::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  /** 浮窗：逻辑四边等距，避免与桌面 0.55/0.65 混用造成左右视觉差 */
  .picker.picker--floating.card.mac-float-surface {
    padding-block: 0.5rem;
    padding-inline: 0.5rem;
    transform: translate(0.5rem, -0.5rem) translateY(-100%);
  }

  .picker--floating {
    width: max-content;
    min-width: calc(2 * 2.75rem + 0.5rem + 1rem);
    max-width: min(96vw, 22rem);
  }
}

.view-3d {
  min-width: 0;
}

.view-3d--centered {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
}

.semi-opacity {
  display: inline-flex;
  align-items: center;
  margin: 0;
  padding: 0;
  user-select: none;
}

/** 细线条轨道 + 圆形滑块，无描边；染色与滑块同色半透明，填充端止于圆前避免叠色发暗 */
.semi-opacity__range {
  --semi-opacity-pct: 0%;
  --semi-opacity-fill: color-mix(in srgb, var(--accent) 58%, transparent);
  --semi-opacity-thumb-bg: var(--semi-opacity-fill);
  width: min(10rem, 36vw);
  height: 1.35rem;
  margin: 0;
  padding: 0;
  vertical-align: middle;
  cursor: pointer;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
}

.semi-opacity__range:focus {
  outline: none;
}

.semi-opacity__range:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  border-radius: 4px;
}

.semi-opacity__range::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--semi-opacity-fill) 0,
    var(--semi-opacity-fill) max(0%, calc(var(--semi-opacity-pct) - 6px)),
    var(--semi-opacity-track) max(0%, calc(var(--semi-opacity-pct) - 6px)),
    var(--semi-opacity-track) 100%
  );
}

.semi-opacity__range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4.5px;
  border-radius: 50%;
  background: var(--semi-opacity-thumb-bg);
  border: none;
  box-shadow: none;
}

.semi-opacity__range::-moz-range-track {
  height: 3px;
  border-radius: 999px;
  background: var(--semi-opacity-track);
}

.semi-opacity__range::-moz-range-progress {
  height: 3px;
  border-radius: 999px;
  background: var(--semi-opacity-fill);
}

.semi-opacity__range::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--semi-opacity-thumb-bg);
  border: none;
  box-shadow: none;
}

.picker-anchor {
  position: fixed;
  z-index: 50;
  pointer-events: none;
}

.picker.card {
  background: var(--glass-bg);
  border: 1px solid var(--hairline);
  border-radius: 8px;
  padding: 0.55rem 0.65rem;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
  transition: background 0.45s ease, border-color 0.45s ease;
}

.picker.card.mac-float-surface {
  border: 1px solid var(--hairline);
  background: var(--glass-bg);
}

.picker--floating {
  margin: 0;
  max-width: min(96vw, 22rem);
  transform: translate(14px, -10px) translateY(-100%);
  pointer-events: auto;
}

.panel {
  background: transparent;
  backdrop-filter: none;
  border-radius: 0;
  padding: 0;
  border: none;
  box-shadow: none;
}

.panel--constraints {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.5rem;
  min-height: 0;
  flex: 1;
  min-width: 0;
  padding: 0;
  max-height: min(60vh, 520px);
  background: transparent;
}

.constraints-drawer {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  min-width: 0;
}

.panel--constraints .constraints-drawer .constraints {
  flex: 1;
  min-height: 0;
}

.status {
  position: relative;
  font-weight: 600;
  padding: 0 0.62rem 0.35rem;
  border-radius: 0;
  font-size: 0.82rem;
  border-bottom: none;
  margin-bottom: 0.15rem;
  box-sizing: border-box;
}

.status::after {
  content: '';
  position: absolute;
  left: 0.32rem;
  right: 0.32rem;
  bottom: 0;
  height: 1px;
  background: var(--hairline);
}

.status--ok {
  background: transparent;
  color: #1e7a45;
}

.status--bad {
  background: transparent;
  color: #a8281e;
}

.constraint-tree-doc-overlay {
  position: fixed;
  inset: 0;
  z-index: 10050;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: clamp(1rem, 3vw, 2rem) clamp(1rem, 3vw, 2rem) clamp(1rem, 3vw, 2rem)
    clamp(0.75rem, 2vw, 1.25rem);
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.2);
}

.constraint-tree-doc {
  margin: 0;
  max-width: min(52rem, calc(100vw - 2 * clamp(0.75rem, 2vw, 1.25rem)));
  max-height: min(78vh, 100%);
  overflow: auto;
  padding: 1rem 1.15rem;
  border-radius: 10px;
  border: 1px solid var(--hairline);
  background: var(--constraint-tree-panel-bg);
  color: var(--ui-text);
  font-size: 0.72rem;
  line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  white-space: pre;
  text-align: left;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  backdrop-filter: var(--glass-blur);
}

.constraint-tree-fade-enter-active,
.constraint-tree-fade-leave-active {
  transition: opacity 0.34s ease;
}

.constraint-tree-fade-enter-active .constraint-tree-doc,
.constraint-tree-fade-leave-active .constraint-tree-doc {
  transition:
    opacity 0.34s ease,
    transform 0.34s ease;
}

.constraint-tree-fade-enter-from,
.constraint-tree-fade-leave-to {
  opacity: 0;
}

.constraint-tree-fade-enter-from .constraint-tree-doc,
.constraint-tree-fade-leave-to .constraint-tree-doc {
  opacity: 0;
  transform: translateX(14px);
}

.constraint-tree-fade-enter-to .constraint-tree-doc,
.constraint-tree-fade-leave-from .constraint-tree-doc {
  opacity: 1;
  transform: translateX(0);
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
  position: relative;
  width: 100%;
  text-align: left;
  padding: 0.45rem 0.62rem;
  border-radius: 6px;
  border: 1px solid transparent;
  border-bottom: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.2rem;
  box-sizing: border-box;
  transition:
    border-color 0.2s ease,
    opacity 0.35s ease;
}

.constraints li:not(:last-child) .constraint::after {
  content: '';
  position: absolute;
  left: 0.32rem;
  right: 0.32rem;
  bottom: 0;
  height: 1px;
  background: var(--hairline);
}

.constraint:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.constraint--active:not(:disabled) {
  border: 1px solid transparent;
  border-bottom: none;
  background: var(--accent-soft);
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
  color: var(--ui-text);
  transition: color 0.35s ease;
}

.constraint--active:not(:disabled) .constraint__title {
  color: var(--accent-text);
}

.constraint__desc {
  font-size: 0.72rem;
  line-height: 1.45;
  color: var(--constraint-desc);
  transition: color 0.35s ease;
}

.edge-enum.card {
  margin-top: 1.5rem;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 1rem 0 0;
  box-shadow: none;
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
  border-radius: 6px;
  border: 1px solid var(--hairline);
  background: rgba(255, 255, 255, 0.45);
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
  border-radius: 6px;
  border: 1px solid var(--hairline);
  background: rgba(255, 255, 255, 0.45);
  color: #1a1a1a;
  resize: vertical;
  min-height: 12rem;
  max-height: min(50vh, 480px);
}

.cube-json.card {
  margin-top: 1.5rem;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 1rem 0 0;
  box-shadow: none;
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
  padding: 0.65rem 0.75rem;
  background: rgba(255, 255, 255, 0.5);
  border-radius: 6px;
  border: 1px solid var(--hairline);
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

.header-theme.card {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  box-shadow: none;
}

.facelets54.card {
  margin-top: 1.5rem;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  box-shadow: none;
}

.app-io-layer .facelets54.card {
  margin-top: 0;
}

/** 移动端：面串块在选色与约束之间，不占侧栏「顶距」以免与 column gap 叠出过大空隙 */
.app-side-column > .facelets54--between-theme-constraints.card {
  margin-top: 0;
  width: 100%;
  max-width: 100%;
  align-self: stretch;
}

.app-side-column > .facelets54--between-theme-constraints .facelets54__apply-row {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  align-self: stretch;
  width: 100%;
  min-width: 0;
  gap: 0.45rem;
}

.app-side-column > .facelets54--between-theme-constraints .facelets54__apply {
  flex-shrink: 0;
}

/** 计数已移到「应用」同行右侧，输入区不再为角标留 padding-right */
.app-side-column > .facelets54--between-theme-constraints .facelets54__textarea {
  padding-right: 0.38rem;
}

.app-side-column > .facelets54--between-theme-constraints .facelets54__counter--beside-apply {
  position: static;
  margin-left: auto;
  line-height: 1.2;
}

.facelets54__input-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.45rem;
}

.facelets54__input-wrap {
  position: relative;
  align-self: flex-start;
  width: min(100%, 45ch);
  max-width: 60ch;
  min-width: 0;
  box-sizing: border-box;
}

.facelets54__textarea {
  box-sizing: border-box;
  display: block;
  width: 100%;
  max-width: 100%;
  height: 2.05rem;
  min-height: 2.05rem;
  margin: 0;
  /** 单行在固定高度内靠下，与右下角计数区留出底边距 */
  padding-top: calc(2.05rem - 0.78rem * 1.35 - 0.18rem - 1px);
  padding-right: 3.6rem;
  padding-bottom: 0.18rem;
  padding-left: 0.15rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.35;
  white-space: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  resize: none;
  border-radius: 0;
  border: none;
  border-bottom: 1px solid var(--hairline-strong);
  background: transparent;
  color: var(--ui-text);
  transition: color 0.45s ease, border-color 0.45s ease;
}

.facelets54__textarea:focus {
  outline: none;
  border-bottom-color: #5b7cfa;
  box-shadow: none;
}

.facelets54__counter {
  position: absolute;
  right: 0.38rem;
  bottom: 0.42rem;
  pointer-events: none;
  font-size: 0.65rem;
  font-variant-numeric: tabular-nums;
  color: var(--ui-muted);
  line-height: 1;
  user-select: none;
}

.facelets54__apply {
  flex-shrink: 0;
  align-self: flex-start;
}

.facelets54__err {
  margin: 0 0 0.5rem;
  font-size: 0.82rem;
  color: #a8281e;
}

/** 侧栏六面 + 重置：一行 flex，仅色块区横向滚动，重置不被 overflow 裁切 */
.face-theme.face-theme--inline {
  flex: 0 0 auto;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.face-theme__palette {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 0.5rem;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.face-theme__swatches {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: flex-start;
  gap: 0.22rem;
  min-width: 0;
  flex: 1 1 0;
  overflow-x: auto;
  scrollbar-width: thin;
  -webkit-overflow-scrolling: touch;
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
  border: 2px solid var(--tile-border);
  border-radius: 2px;
  box-sizing: border-box;
  flex-shrink: 0;
  transition: border-color 0.45s ease;
}

.face-theme__lbl {
  font-size: 0.6rem;
  font-weight: 700;
  color: var(--face-lbl);
  line-height: 1;
  user-select: none;
  transition: color 0.45s ease;
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
  flex: 0 0 auto;
  flex-shrink: 0;
  margin: 0;
  align-self: flex-start;
  white-space: nowrap;
  /** 勿用 font:inherit，否则会盖掉 .toolbar__btn-sm 的 0.78rem，与「应用」不一致 */
}
</style>

<style>
/** fixed 的 .app-io-layer 相对视口定位；若 body 有默认 margin，会与 .page-ui 内流式内容错开 */
html,
body {
  margin: 0;
}

html[data-theme='light'] {
  color-scheme: light;
  --ui-text: #1a1a1a;
  --ui-muted: rgba(75, 78, 90, 0.95);
  --hairline: rgba(0, 0, 0, 0.09);
  --hairline-strong: rgba(0, 0, 0, 0.14);
  --glass-bg: rgba(255, 255, 255, 0.5);
  --glass-border: rgba(0, 0, 0, 0.1);
  --accent: #2563eb;
  --accent-text: #1e40af;
  --accent-soft: rgba(239, 246, 255, 0.65);
  --chrome-hover: rgba(0, 0, 0, 0.05);
  --solver-text: #1e3a5f;
  --solver-banner: #166534;
  --face-lbl: #3a3a3a;
  --tile-border: #141414;
  --chip-inset: rgba(255, 255, 255, 0.25);
  --constraint-desc: #5c5c5c;
  --semi-opacity-track: rgba(0, 0, 0, 0.11);
  /** 约束树浮窗：比通用 glass 更不透明，便于阅读 */
  --constraint-tree-panel-bg: rgba(255, 255, 255, 0.89);
}

html[data-theme='dark'] {
  color-scheme: dark;
  --ui-text: #e8eaed;
  --ui-muted: rgba(203, 213, 225, 0.88);
  --hairline: rgba(255, 255, 255, 0.1);
  --hairline-strong: rgba(255, 255, 255, 0.16);
  --glass-bg: rgba(28, 32, 42, 0.72);
  --glass-border: rgba(255, 255, 255, 0.08);
  --accent: #60a5fa;
  --accent-text: #bfdbfe;
  --accent-soft: rgba(59, 130, 246, 0.22);
  --chrome-hover: rgba(255, 255, 255, 0.08);
  --solver-text: #c7d2fe;
  --solver-banner: #86efac;
  --face-lbl: #cbd5e1;
  --tile-border: #1e293b;
  --chip-inset: rgba(255, 255, 255, 0.08);
  --constraint-desc: #94a3b8;
  --semi-opacity-track: rgba(255, 255, 255, 0.14);
  --constraint-tree-panel-bg: rgba(24, 28, 38, 0.57);
}

html[data-theme='dark'] .page-cube-layer::before {
  opacity: 0;
}

html[data-theme='dark'] .page-cube-layer::after {
  opacity: 1;
}
</style>
