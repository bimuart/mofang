import type { FaceId } from './types';
import { FACES } from './types';
import { isEmptyCell } from './cellValue';

function isFaceId(c: string): c is FaceId {
  return (FACES as readonly string[]).includes(c);
}

/**
 * 对 54 格返回每格可选颜色列表。
 *
 * 不做色数 / 棱角局部等推断：未填格（空占位）候选为 **全部六种面色**；已填且为有效面色者为 `[该色]`；非法或未知字符为 `[]`。
 * 长度非 54 时返回 54 个空数组。
 */
export function computeQuantityOnlyCandidates(facelets: string): readonly (readonly FaceId[])[] {
  if (facelets.length !== 54) {
    return Array.from({ length: 54 }, () => [] as readonly FaceId[]);
  }
  return Array.from({ length: 54 }, (_, i) => {
    const ch = facelets[i]!;
    if (isEmptyCell(ch)) return FACES;
    if (isFaceId(ch)) return [ch] as const;
    return [] as readonly FaceId[];
  });
}

/** @deprecated 使用 {@link computeQuantityOnlyCandidates} */
export const computeAllCandidates = computeQuantityOnlyCandidates;
