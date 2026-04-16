<script setup lang="ts">
import { computed } from 'vue';
import type { FaceId } from '../cube/types';

const props = defineProps<{
  candidates: readonly (FaceId | null)[];
  faceColors: Record<FaceId, string>;
  /** 若给出，仅集合内的面色为「约束链」允许；不在集合内的面色按钮带禁用样式且不可点 */
  constraintAllowedFaces?: readonly FaceId[] | null;
  /** 为 true 时「空」按钮禁用 */
  disableEmptyChip?: boolean;
}>();

const allowedSet = computed(() => {
  if (props.constraintAllowedFaces == null) return null;
  return new Set(props.constraintAllowedFaces);
});

function isChipDisabled(c: FaceId | null): boolean {
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
        'chip--disabled': isChipDisabled(c),
      }"
      :disabled="isChipDisabled(c)"
      :style="
        c === null
          ? { background: '#52525b', color: '#f4f4f5' }
          : { background: faceColors[c], color: '#111' }
      "
      @click="$emit('pick', c)"
    >
      <span class="chip__lbl">{{ c === null ? '空' : c }}</span>
      <span v-if="isChipDisabled(c)" class="chip__badge" aria-hidden="true">禁</span>
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

.chip:hover:not(:disabled) {
  transform: scale(1.06);
}

.chip--empty {
  border-color: rgba(0, 0, 0, 0.22);
}

.chip--disabled {
  cursor: not-allowed;
  opacity: 0.45;
  filter: grayscale(0.35);
}

.chip--disabled .chip__lbl {
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
