import type { FaceId } from './types';
import { FACES } from './types';

/** 未填色格在 facelet 串中的占位符 */
export const EMPTY_FACELET = '.' as const;

export type CellChar = FaceId | typeof EMPTY_FACELET;

export function isEmptyCell(ch: string): boolean {
  return ch === EMPTY_FACELET;
}

export function isFaceletChar(ch: string): ch is CellChar {
  return isEmptyCell(ch) || (FACES as readonly string[]).includes(ch);
}

/** 默认候选：六面记号 + 清空 */
export function defaultCandidates(): readonly (FaceId | null)[] {
  return [...FACES, null];
}
