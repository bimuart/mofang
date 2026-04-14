<script setup lang="ts">
import type { FaceId } from '../cube/types';

defineProps<{
  candidates: readonly (FaceId | null)[];
  faceColors: Record<FaceId, string>;
}>();

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
      :class="{ 'chip--empty': c === null }"
      :style="
        c === null
          ? { background: '#9ca3af', color: '#1a1a1a' }
          : { background: faceColors[c], color: '#111' }
      "
      @click="$emit('pick', c)"
    >
      <span class="chip__lbl">{{ c === null ? '空' : c }}</span>
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

.chip__lbl {
  pointer-events: none;
}
</style>
