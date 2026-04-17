<script setup lang="ts">
import { computed, inject } from 'vue';
import type { FaceId } from '../cube/types';

const t = inject<(k: string) => string>('i18nT', (k: string) => k);

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
  <div class="bar" role="group" :aria-label="t('picker.candidates')">
    <button
      v-for="(c, i) in candidates"
      :key="i"
      type="button"
      class="chip"
      :class="{
        'chip--empty': c === null,
        'chip--constraint-muted': isChipConstraintMuted(c),
      }"
      :style="
        c === null
          ? { background: '#52525b', color: '#f4f4f5' }
          : { background: faceColors[c], color: '#111' }
      "
      @click="$emit('pick', c)"
    >
      <span class="chip__lbl">{{ c === null ? t('picker.empty') : c }}</span>
      <span v-if="isChipConstraintMuted(c)" class="chip__badge" aria-hidden="true">
        <svg class="chip__badge-svg" viewBox="0 0 16 16" width="18" height="18" focusable="false">
          <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" stroke-width="1.5" />
          <line
            x1="4.25"
            y1="11.75"
            x2="11.75"
            y2="4.25"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </span>
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

/** 仅移动端：双列等分；chip 撑满格宽，避免格内右侧空一截像「底板右宽」 */
@media (max-width: 900px) {
  .bar {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: auto;
    column-gap: 0.5rem;
    row-gap: 0.4rem;
    width: 100%;
    max-width: 100%;
    min-width: calc(2 * 2.75rem + 0.5rem);
    justify-items: stretch;
    align-items: stretch;
    box-sizing: border-box;
  }

  .chip {
    display: inline-flex;
    width: 100%;
    max-width: none;
    min-width: 0;
    justify-self: stretch;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    text-align: center;
  }
}

.chip {
  position: relative;
  min-width: 2.4rem;
  padding: 0.35rem 0.55rem;
  border-radius: 8px;
  border: 1px solid var(--hairline-strong, rgba(0, 0, 0, 0.14));
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 650;
  box-shadow: inset 0 0 0 1px var(--chip-inset, rgba(255, 255, 255, 0.2));
  transition:
    transform 0.1s,
    color 0.45s ease,
    border-color 0.45s ease,
    box-shadow 0.45s ease;
}

.chip:hover {
  transform: scale(1.06);
}

.chip--empty {
  border-color: var(--hairline-strong, rgba(0, 0, 0, 0.14));
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
  top: -0.32rem;
  right: -0.32rem;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  color: #dc2626;
  filter: drop-shadow(0 0 1px rgba(255, 255, 255, 0.85));
  pointer-events: none;
}

.chip__badge-svg {
  display: block;
}
</style>
