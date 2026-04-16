<script setup lang="ts">
import { computed } from 'vue';
import type { FaceId } from '../cube/types';

const props = defineProps<{
  candidates: readonly (FaceId | null)[];
  faceColors: Record<FaceId, string>;
  /** 若给出，集合外的面色仍可选，仅显示「禁」样式与灰显（约束链提示） */
  constraintAllowedFaces?: readonly FaceId[] | null;
  /** 为 true 时「空」仅灰显与「禁」标，仍可点击 */
  disableEmptyChip?: boolean;
}>();

const allowedSet = computed(() => {
  if (props.constraintAllowedFaces == null) return null;
  return new Set(props.constraintAllowedFaces);
});

/** 是否显示约束链外的灰显与「禁」标（仍可点击选色） */
function isChipConstraintMuted(c: FaceId | null): boolean {
  if (c === null) return props.disableEmptyChip === true;
  if (allowedSet.value === null) return false;
  return !allowedSet.value.has(c);
}

defineEmits<{
  pick: [value: FaceId | null];
}>();
</script>

<template>
  <div class="bar" role="group" aria-label="候选颜色">
    <button
      v-for="(c, i) in candidates"
      :key="i"
      type="button"
      class="chip"
      :class="{
        'chip--empty': c === null,
        'chip--constraint-muted': isChipConstraintMuted(c),
      }"
      :title="
        isChipConstraintMuted(c)
          ? c === null
            ? '当前约束链下置空可能不通过，仍可点击'
            : '不在约束链候选集合内，仍可点击选择'
          : undefined
      "
      :style="
        c === null
          ? { background: '#52525b', color: '#f4f4f5' }
          : { background: faceColors[c], color: '#111' }
      "
      @click="$emit('pick', c)"
    >
      <span class="chip__lbl">{{ c === null ? '空' : c }}</span>
      <span v-if="isChipConstraintMuted(c)" class="chip__badge" aria-hidden="true">禁</span>
    </button>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  align-items: center;
}

.chip {
  position: relative;
  min-width: 2.4rem;
  padding: 0.35rem 0.55rem;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 650;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
  transition: transform 0.1s;
}

.chip:hover {
  transform: scale(1.06);
}

.chip--empty {
  border-color: rgba(0, 0, 0, 0.22);
}

.chip--constraint-muted {
  cursor: pointer;
  opacity: 0.45;
  filter: grayscale(0.35);
}

.chip--constraint-muted .chip__lbl {
  opacity: 0.85;
}

.chip__lbl {
  pointer-events: none;
}

.chip__badge {
  position: absolute;
  top: -0.28rem;
  right: -0.28rem;
  font-size: 0.58rem;
  font-weight: 700;
  line-height: 1;
  padding: 0.12rem 0.2rem;
  border-radius: 4px;
  background: #52525b;
  color: #fafafa;
  border: 1px solid rgba(255, 255, 255, 0.35);
  pointer-events: none;
}
</style>
