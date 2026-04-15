<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Cube from 'cubejs';
import ColorCandidateBar from './components/ColorCandidateBar.vue';
import Cube3DView from './components/Cube3DView.vue';
import { computeQuantityOnlyCandidates } from './cube/candidateConstraints';
import { EMPTY_FACELET, isEmptyCell } from './cube/cellValue';
import { CENTER_INDICES } from './cube/faceletGeometry';
import { buildCube } from './cube/buildCube';
import {
  buildConstraintRows,
  solvedString,
  validateLegality,
  type ConstraintGroupId,
} from './cube/legality';
import { splitAlgorithm } from './cube/layerTurn';
import type { FaceId } from './cube/types';

/** 六个中心格不可改色（与轴固定） */
const LOCKED_CENTER = new Set<number>(CENTER_INDICES);

const MAX_UNDO = 80;
/** 每次改色 / 载入 / 演示步 之前压入的 54 位串；撤销弹出上一帧（含撤销自动填充） */
const undoStack = ref<string[]>([]);
const isUndoing = ref(false);
/** 选「空」清除某格后，本轮不跑唯一候选自动填充 */
const skipUniquePropagationOnce = ref(false);

const facelets = ref(solvedString());

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

/** 当前选中格的候选色条：空格为数量约束下的子集；已填格为当前色 +「空」以清除 */
const pickerBarCandidates = computed((): readonly (FaceId | null)[] => {
  const idx = selectedCell.value;
  if (idx === null) return [];
  const all = computeQuantityOnlyCandidates(facelets.value);
  const row = all[idx];
  if (!row) return [];
  const ch = facelets.value[idx]!;
  if (!isEmptyCell(ch)) return [...row, null];
  return [...row];
});

const canAutoFillUnique = computed(() => {
  const all = computeQuantityOnlyCandidates(facelets.value);
  for (let i = 0; i < 54; i++) {
    if (LOCKED_CENTER.has(i)) continue;
    if (!isEmptyCell(facelets.value[i]!)) continue;
    if (all[i]!.length === 1) return true;
  }
  return false;
});

/**
 * 将「候选仅 1 色」的空格递归填上；每轮只填一格，再重算候选。
 * 若一轮内同时填多格，两条棱可能各自唯一候选同色，会同时落成同一棱身份（usedEK 尚来不及反映另一条）。
 */
function runUniquePropagation(): boolean {
  let any = false;
  let s = facelets.value;
  let changed = true;
  while (changed) {
    changed = false;
    const all = computeQuantityOnlyCandidates(s);
    const arr = s.split('');
    for (let i = 0; i < 54; i++) {
      if (LOCKED_CENTER.has(i)) continue;
      if (!isEmptyCell(arr[i]!)) continue;
      const c = all[i];
      if (c && c.length === 1) {
        arr[i] = c[0]!;
        changed = true;
        any = true;
        break;
      }
    }
    if (changed) s = arr.join('');
  }
  if (any && s !== facelets.value) {
    facelets.value = s;
  }
  return any;
}

watch(facelets, () => {
  if (isUndoing.value) {
    invalidateSolutionAndReset3D();
    return;
  }
  if (skipUniquePropagationOnce.value) {
    skipUniquePropagationOnce.value = false;
    invalidateSolutionAndReset3D();
    return;
  }
  runUniquePropagation();
  invalidateSolutionAndReset3D();
});

function autoFillUniqueCandidates() {
  if (!canAutoFillUnique.value) return;
  pushUndoSnapshot();
  runUniquePropagation();
}

const FACE_COLORS: Record<FaceId, string> = {
  U: '#ffffff',
  D: '#ffd400',
  L: '#ff7a1a',
  R: '#ff3333',
  F: '#00c853',
  B: '#1e90ff',
};

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

const HIDDEN_CONSTRAINT_IDS = new Set<ConstraintGroupId>(['len', 'charset', 'incomplete']);
const visibleConstraintRows = computed(() =>
  constraintRows.value.filter((r) => !HIDDEN_CONSTRAINT_IDS.has(r.id)),
);

/** 选中右侧某一约束时仅高亮该约束涉及的格；未选中时高亮全部违规格 */
const selectedConstraintId = ref<ConstraintGroupId | null>(null);

const highlightIndices = computed(() => {
  const id = selectedConstraintId.value;
  if (id === null) return report.value.illegalCellIndices;
  const row = constraintRows.value.find((r) => r.id === id);
  if (!row || row.status === 'skipped') return new Set<number>();
  return new Set(row.cellIndices);
});

function toggleConstraintHighlight(id: ConstraintGroupId) {
  const row = constraintRows.value.find((r) => r.id === id);
  if (!row || row.status === 'skipped') return;
  if (selectedConstraintId.value === id) {
    selectedConstraintId.value = null;
    return;
  }
  selectedConstraintId.value = id;
}

function onStickerClick(globalIdx: number) {
  if (LOCKED_CENTER.has(globalIdx)) return;
  if (selectedCell.value === globalIdx) {
    selectedCell.value = null;
    return;
  }
  selectedCell.value = globalIdx;
}

function applyPick(value: FaceId | null) {
  if (selectedCell.value === null) return;
  if (LOCKED_CENTER.has(selectedCell.value)) return;
  if (value === null) {
    skipUniquePropagationOnce.value = true;
  }
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

function exampleCornerTwist() {
  pushUndoSnapshot();
  const s = solvedString().split('');
  s[8] = 'F';
  s[10] = 'U';
  s[20] = 'R';
  facelets.value = s.join('');
}

/** 除六个中心外全部置为未填 */
function clearExceptCenters() {
  pushUndoSnapshot();
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

const solverInitialized = ref(false);
const solverLoading = ref(false);
const solverError = ref<string | null>(null);
const solverBanner = ref<string | null>(null);
const solutionMoves = ref<string[]>([]);
const solutionStepIndex = ref(0);
const nextHintMove = computed(() => {
  if (solutionMoves.value.length === 0) return null;
  if (solutionStepIndex.value >= solutionMoves.value.length) return null;
  return solutionMoves.value[solutionStepIndex.value] ?? null;
});

function clearSolutionState() {
  solutionMoves.value = [];
  solutionStepIndex.value = 0;
  solverError.value = null;
  solverBanner.value = null;
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
      solverBanner.value = '当前已是标准还原态，无需转动步骤。';
      return;
    }
    const alg = c.solve();
    solutionMoves.value = splitAlgorithm(alg);
    solutionStepIndex.value = 0;
  } catch (e) {
    solverError.value = e instanceof Error ? e.message : String(e);
    solutionMoves.value = [];
    solutionStepIndex.value = 0;
  } finally {
    solverLoading.value = false;
  }
}

async function nextSolutionStep() {
  if (solutionMoves.value.length === 0) return;
  if (solutionStepIndex.value >= solutionMoves.value.length) return;
  const move = solutionMoves.value[solutionStepIndex.value]!;
  const view = cube3dRef.value;
  if (!view) return;
  try {
    const before = facelets.value;
    await view.animateMove(move);
    pushUndoSnapshot();
    const c = Cube.fromString(before);
    c.move(move);
    facelets.value = c.asString();
    solutionStepIndex.value += 1;
  } catch (e) {
    solverError.value = e instanceof Error ? e.message : String(e);
  }
}

const semiTransparent = ref(false);
/** 半透明模式下贴纸与黑缝边框共用不透明度（0.1–1） */
const stickerOpacity = ref(0.42);

const opacityPercent = computed(() => Math.round(stickerOpacity.value * 100));

/** 用户改色或载入新状态后：清空已算好的还原序列，并把 3D 贴纸位姿恢复为与索引一致 */
function invalidateSolutionAndReset3D() {
  clearSolutionState();
  void nextTick(() => {
    cube3dRef.value?.resetLayout();
  });
}
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>3×3 魔方合法性校验</h1>
      <p class="lead">
        依据色数守恒、中心唯一、棱/角块身份与唯一性、几何一致（手性/朝向）、以及角扭转 mod 3、棱翻转偶性、置换奇偶（约束 A–D）检验；全局项由 `buildCube` 解析（未决为 -1）。右侧可逐项查看状态，点击某项可单独高亮相关贴纸。
      </p>
    </header>

    <div class="toolbar">
      <button type="button" @click="setSolved">还原态</button>
      <button type="button" @click="setRandomLegal">随机合法态</button>
      <button type="button" class="muted" @click="clearExceptCenters">清空</button>
      <button
        type="button"
        class="muted"
        :disabled="!canUndo"
        title="撤销上一步改色、载入或演示步；自动填充的唯一候选一并还原"
        @click="undoFacelets"
      >
        撤销 ↩️
      </button>
      <button
        type="button"
        class="toolbar__primary"
        :disabled="!canAutoFillUnique"
        title="按色数与棱/角块约束填满唯一候选空格（改色后也会自动传播，可点此再跑一轮）"
        @click="autoFillUniqueCandidates"
      >
        填充唯一候选
      </button>
      <button type="button" class="muted" @click="exampleCornerTwist">示例：角块乱向</button>
      <button
        type="button"
        class="toolbar__primary"
        :disabled="solverLoading || !faceletsComplete || !report.ok"
        @click="fetchSolution"
      >
        {{ solverLoading ? '正在初始化求解器…' : '获取解法' }}
      </button>
      <button
        type="button"
        class="toolbar__primary"
        :disabled="!nextHintMove || solverLoading"
        @click="nextSolutionStep"
      >
        下一步
      </button>
    </div>
    <p v-if="solverError" class="solver-err">{{ solverError }}</p>
    <p v-else-if="solverBanner" class="solver-banner">{{ solverBanner }}</p>
    <p v-else-if="solutionMoves.length > 0" class="solver-info">
      还原步骤：已执行 {{ solutionStepIndex }} / {{ solutionMoves.length }}；下一步
      <strong v-if="nextHintMove">{{ nextHintMove }}</strong>
      <span v-else>（已完成）</span>
    </p>
    <p v-else-if="faceletsComplete && report.ok" class="solver-hint muted">
      填色完整且校验通过时可点击「获取解法」（首次需数秒加载两阶段算法表）。
    </p>

    <div class="layout">
      <section class="view-3d" aria-label="三维魔方">
        <div class="view-3d__head">
          <p class="hint">
            <strong>拖拽</strong>旋转视角（仅移动相机）；<strong>点击</strong>非中心贴纸后在下方选色（含「空」）；中心块固定不可改。填齐后可「获取解法」并按「下一步」播放单层旋转（含中心块随动）；蓝色箭头提示下一步转动方向。
          </p>
          <div class="semi-controls">
            <button
              type="button"
              class="btn-semi"
              :class="{ 'btn-semi--active': semiTransparent }"
              :aria-pressed="semiTransparent"
              @click="semiTransparent = !semiTransparent"
            >{{ semiTransparent ? '不透明' : '半透明' }}</button>
            <label v-if="semiTransparent" class="semi-opacity">
              <span class="semi-opacity__label">透明度</span>
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
                aria-label="贴纸与黑框不透明度"
              />
              <span class="semi-opacity__value" aria-hidden="true">{{ opacityPercent }}</span>
            </label>
          </div>
        </div>
        <Cube3DView
          ref="cube3dRef"
          :facelets="facelets"
          :face-colors="FACE_COLORS"
          :highlight-indices="highlightIndices"
          :locked-indices="LOCKED_CENTER"
          :selected-index="selectedCell"
          :next-hint-move="nextHintMove"
          :semi-transparent="semiTransparent"
          :sticker-opacity="stickerOpacity"
          @sticker-click="onStickerClick"
        />

        <div v-if="selectedCell !== null" class="picker card">
          <div class="picker__head">
            <span>已选格 <strong>#{{ selectedCell }}</strong></span>
            <button type="button" class="picker__close" @click="clearSelection">关闭</button>
          </div>
          <p class="picker__sub">候选颜色（「空」= 未填，灰色）</p>
          <ColorCandidateBar
            :candidates="pickerBarCandidates"
            :face-colors="FACE_COLORS"
            @pick="applyPick"
          />
        </div>
      </section>

      <aside class="panel panel--constraints">
        <div class="status" :class="report.ok ? 'status--ok' : 'status--bad'">
          {{ report.ok ? '当前状态：合法（可解必要条件均满足）' : '当前状态：存在非法项或未填色' }}
        </div>
        <p class="constraint-hint">点击某项：仅高亮不满足该约束的贴纸；再点一次取消筛选。</p>
        <ul class="constraints" role="list">
          <li v-for="row in visibleConstraintRows" :key="row.id">
            <div
              v-if="row.id === 'center_multiset' || row.id === 'facelet_match'"
              class="constraint-row"
            >
              <label
                v-if="row.id === 'center_multiset'"
                class="constraint-switch"
                @click.stop
              >
                <input
                  v-model="checkCenterMultiset"
                  type="checkbox"
                  class="constraint-switch__input"
                />
                <span class="constraint-switch__lbl">检测</span>
              </label>
              <label
                v-else-if="row.id === 'facelet_match'"
                class="constraint-switch"
                @click.stop
              >
                <input
                  v-model="checkFaceletMismatch"
                  type="checkbox"
                  class="constraint-switch__input"
                />
                <span class="constraint-switch__lbl">检测</span>
              </label>
              <button
                type="button"
                class="constraint constraint-row__btn"
                :class="{
                  'constraint--pass': row.status === 'pass',
                  'constraint--fail': row.status === 'fail',
                  'constraint--skip': row.status === 'skipped',
                  'constraint--active': selectedConstraintId === row.id,
                }"
                :disabled="row.status === 'skipped'"
                :aria-pressed="selectedConstraintId === row.id"
                @click="toggleConstraintHighlight(row.id)"
              >
                <span class="constraint__status" :data-status="row.status">{{
                  row.status === 'pass' ? '通过' : row.status === 'fail' ? '未通过' : '未校验'
                }}</span>
                <span class="constraint__title">{{ row.title }}</span>
                <span class="constraint__desc">{{ row.description }}</span>
              </button>
            </div>
            <button
              v-else
              type="button"
              class="constraint"
              :class="{
                'constraint--pass': row.status === 'pass',
                'constraint--fail': row.status === 'fail',
                'constraint--skip': row.status === 'skipped',
                'constraint--active': selectedConstraintId === row.id,
              }"
              :disabled="row.status === 'skipped'"
              :aria-pressed="selectedConstraintId === row.id"
              @click="toggleConstraintHighlight(row.id)"
            >
              <span class="constraint__status" :data-status="row.status">{{
                row.status === 'pass' ? '通过' : row.status === 'fail' ? '未通过' : '未校验'
              }}</span>
              <span class="constraint__title">{{ row.title }}</span>
              <span class="constraint__desc">{{ row.description }}</span>
            </button>
          </li>
        </ul>
        <p class="footnote">
          Facelet 顺序：<strong>U R F D L B</strong>，与
          <a href="https://github.com/ldez/cubejs" target="_blank" rel="noreferrer">cubejs</a>
          一致。未填位用字符 <strong>{{ EMPTY_FACELET }}</strong>。几何与可解性说明见
          <code>docs/GEOMETRIC_CONSTRAINTS.md</code>。
        </p>
      </aside>
    </div>

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
  </div>
</template>

<style scoped>
.page {
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
  background: #fafafa;
  min-height: 100vh;
}

.header h1 {
  font-size: 1.5rem;
  font-weight: 650;
  margin: 0 0 0.5rem;
}

.lead {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.55;
  color: #444;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1.25rem 0;
}

.toolbar button {
  padding: 0.45rem 0.85rem;
  border-radius: 8px;
  border: 1px solid #ccc;
  background: #fff;
  cursor: pointer;
  font-size: 0.875rem;
}

.toolbar button:hover {
  background: #f0f0f0;
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
  background: #eff6ff !important;
}

.toolbar__primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.solver-info,
.solver-err,
.solver-hint {
  margin: 0.35rem 0 0;
  font-size: 0.88rem;
  line-height: 1.45;
}

.solver-banner {
  color: #166534;
}

.solver-info {
  color: #1e3a5f;
}

.solver-err {
  color: #a8281e;
}

.solver-hint.muted {
  color: #666;
}

.layout {
  display: grid;
  grid-template-columns: 1fr minmax(300px, 420px);
  gap: 1.5rem;
  align-items: start;
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.hint {
  font-size: 0.85rem;
  color: #555;
  margin: 0 0 0.75rem;
  line-height: 1.5;
}

.view-3d {
  min-width: 0;
}

.view-3d__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.65rem 1rem;
  margin-bottom: 0.75rem;
}

.view-3d__head .hint {
  flex: 1 1 14rem;
  margin: 0;
}

.semi-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.85rem;
}

.semi-opacity {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.78rem;
  color: #555;
  user-select: none;
}

.semi-opacity__label {
  white-space: nowrap;
}

.semi-opacity__range {
  width: min(9rem, 32vw);
  vertical-align: middle;
  accent-color: #6366f1;
}

.semi-opacity__value {
  min-width: 2.25rem;
  font-variant-numeric: tabular-nums;
  color: #444;
}

.btn-semi {
  flex-shrink: 0;
  padding: 0.38rem 0.8rem;
  border-radius: 8px;
  border: 1px solid #c0c4cc;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(4px);
  cursor: pointer;
  font-size: 0.82rem;
  color: #444;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}

.btn-semi:hover {
  background: rgba(240, 242, 248, 0.9);
  border-color: #a0a8be;
}

.btn-semi--active {
  border-color: #6366f1;
  color: #4338ca;
  background: rgba(238, 238, 255, 0.85);
}

.picker {
  margin-top: 1rem;
}

.picker.card {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 0.85rem 1rem 1rem;
}

.picker__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.35rem;
  font-size: 0.9rem;
}

.picker__close {
  padding: 0.25rem 0.55rem;
  font-size: 0.8rem;
  border-radius: 6px;
  border: 1px solid #ccc;
  background: #fafafa;
  cursor: pointer;
}

.picker__close:hover {
  background: #eee;
}

.picker__sub {
  margin: 0 0 0.65rem;
  font-size: 0.78rem;
  color: #666;
}

.panel {
  background: #fff;
  border-radius: 12px;
  padding: 1rem 1.1rem;
  border: 1px solid #e5e5e5;
}

.panel--constraints {
  position: sticky;
  top: 1rem;
  max-height: calc(100vh - 2rem);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.status {
  font-weight: 600;
  padding: 0.5rem 0.65rem;
  border-radius: 8px;
  font-size: 0.9rem;
}

.status--ok {
  background: #e8f8ef;
  color: #1e7a45;
}

.status--bad {
  background: #fdecea;
  color: #a8281e;
}

.constraint-hint {
  margin: 0.65rem 0 0.5rem;
  font-size: 0.75rem;
  color: #666;
  line-height: 1.45;
}

.constraint-row {
  display: flex;
  align-items: stretch;
  gap: 0.35rem;
}

.constraint-switch {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2.5rem;
  padding: 0.35rem 0.2rem;
  border-radius: 10px;
  border: 1px solid #e0e0e0;
  background: #f8f8f8;
  cursor: pointer;
  font-size: 0.65rem;
  font-weight: 650;
  color: #555;
  user-select: none;
}

.constraint-switch:hover {
  background: #f0f0f0;
}

.constraint-switch__input {
  margin: 0 0 0.2rem;
  cursor: pointer;
}

.constraint-switch__lbl {
  line-height: 1.2;
  text-align: center;
}

.constraint-row__btn {
  flex: 1;
  min-width: 0;
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
  border: 1px solid #e8e8e8;
  background: #fafafa;
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
  background: #f3f4f6;
  border-color: #d8d8d8;
}

.constraint:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.constraint--active:not(:disabled) {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px #2563eb;
  background: #eff6ff;
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

.footnote {
  font-size: 0.75rem;
  color: #777;
  line-height: 1.5;
  margin: 1rem 0 0;
}

.footnote code {
  font-size: 0.72rem;
  background: #f4f4f4;
  padding: 0.1rem 0.25rem;
  border-radius: 4px;
}

.footnote a {
  color: #2563eb;
}

.cube-json.card {
  margin-top: 1.5rem;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  padding: 1rem 1.1rem 1.15rem;
}

.cube-json__title {
  margin: 0 0 0.65rem;
  font-size: 0.9rem;
  font-weight: 650;
  color: #333;
}

.cube-json__title code {
  font-size: 0.82rem;
  background: #f4f4f4;
  padding: 0.15rem 0.35rem;
  border-radius: 6px;
}

.cube-json__pre {
  margin: 0;
  padding: 0.75rem 0.9rem;
  background: #f6f7f9;
  border-radius: 8px;
  border: 1px solid #e8e9ec;
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
</style>
