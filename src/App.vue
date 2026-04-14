<script setup lang="ts">
import { computed, ref } from 'vue';
import Cube from 'cubejs';
import ColorCandidateBar from './components/ColorCandidateBar.vue';
import Cube3DView from './components/Cube3DView.vue';
import { defaultCandidates, EMPTY_FACELET } from './cube/cellValue';
import { validateLegality, solvedString } from './cube/legality';
import type { FaceId } from './cube/types';

const facelets = ref(solvedString());

const selectedCell = ref<number | null>(null);
const candidates = defaultCandidates();

const FACE_COLORS: Record<FaceId, string> = {
  U: '#ffffff',
  D: '#ffd400',
  L: '#ff7a1a',
  R: '#ff3333',
  F: '#00c853',
  B: '#1e90ff',
};

const report = computed(() => validateLegality(facelets.value));
const illegal = computed(() => report.value.illegalCellIndices);

function onStickerClick(globalIdx: number) {
  selectedCell.value = globalIdx;
}

function applyPick(value: FaceId | null) {
  if (selectedCell.value === null) return;
  const arr = facelets.value.split('');
  arr[selectedCell.value] = value === null ? EMPTY_FACELET : value;
  facelets.value = arr.join('');
}

function clearSelection() {
  selectedCell.value = null;
}

function setSolved() {
  facelets.value = solvedString();
  selectedCell.value = null;
}

function setRandomLegal() {
  const c = Cube.random();
  facelets.value = c.asString();
  selectedCell.value = null;
}

function exampleBadCenters() {
  const s = solvedString().split('');
  [s[4], s[13]] = [s[13]!, s[4]!];
  facelets.value = s.join('');
}

function exampleCornerTwist() {
  const s = solvedString().split('');
  s[8] = 'F';
  s[10] = 'U';
  s[20] = 'R';
  facelets.value = s.join('');
}
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>3×3 魔方合法性校验</h1>
      <p class="lead">
        依据色数守恒、中心唯一、棱/角块身份与唯一性、几何一致（手性/朝向）、以及角扭转 mod 3、棱翻转偶性、置换奇偶（约束 A–D）检验；不通过项对应贴纸已高亮。
      </p>
    </header>

    <div class="toolbar">
      <button type="button" @click="setSolved">还原态</button>
      <button type="button" @click="setRandomLegal">随机合法态</button>
      <button type="button" class="muted" @click="exampleBadCenters">示例：坏中心</button>
      <button type="button" class="muted" @click="exampleCornerTwist">示例：角块乱向</button>
    </div>

    <div class="layout">
      <section class="view-3d" aria-label="三维魔方">
        <p class="hint">
          <strong>拖拽</strong>旋转视角（仅移动相机）；<strong>点击</strong>贴纸后在下方选择候选颜色（含「空」清空）；未填格为灰色。禁止自由拧层。
        </p>
        <Cube3DView
          :facelets="facelets"
          :face-colors="FACE_COLORS"
          :illegal="illegal"
          @sticker-click="onStickerClick"
        />

        <div v-if="selectedCell !== null" class="picker card">
          <div class="picker__head">
            <span>已选格 <strong>#{{ selectedCell }}</strong></span>
            <button type="button" class="picker__close" @click="clearSelection">关闭</button>
          </div>
          <p class="picker__sub">候选颜色（「空」= 未填，灰色）</p>
          <ColorCandidateBar
            :candidates="candidates"
            :face-colors="FACE_COLORS"
            @pick="applyPick"
          />
        </div>
      </section>

      <aside class="panel">
        <div class="status" :class="report.ok ? 'status--ok' : 'status--bad'">
          {{ report.ok ? '当前状态：合法（可解必要条件均满足）' : '当前状态：存在非法项或未填色' }}
        </div>
        <ul class="issues">
          <li v-for="(iss, i) in report.issues" :key="i" class="issue">
            <span class="issue-cat">{{ iss.category }}</span>
            <span class="issue-msg">{{ iss.message }}</span>
          </li>
          <li v-if="report.issues.length === 0" class="issue issue--empty">无违规项</li>
        </ul>
        <p class="footnote">
          Facelet 顺序：<strong>U R F D L B</strong>，与
          <a href="https://github.com/ldez/cubejs" target="_blank" rel="noreferrer">cubejs</a>
          一致。未填位用字符 <strong>{{ EMPTY_FACELET }}</strong>。几何与可解性说明见
          <code>docs/GEOMETRIC_CONSTRAINTS.md</code>。
        </p>
      </aside>
    </div>
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

.layout {
  display: grid;
  grid-template-columns: 1fr minmax(260px, 340px);
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

.issues {
  list-style: none;
  padding: 0.75rem 0 0;
  margin: 0;
  max-height: 420px;
  overflow: auto;
}

.issue {
  font-size: 0.82rem;
  line-height: 1.45;
  padding: 0.35rem 0;
  border-bottom: 1px solid #eee;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.issue-cat {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #888;
}

.issue--empty {
  border: none;
  color: #888;
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
</style>
