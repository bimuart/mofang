import * as THREE from 'three';
import type { FaceId } from './types';
import { stickerCenter } from './stickerLayout';

const LAYER_THRESHOLD = 0.45;

/** 与 cubejs 单步顺时针面转一致的旋转：axis · angle 为右手系 */
const FACE_TURN_SIGN: Record<FaceId, { axis: THREE.Vector3; sign: number }> = {
  U: { axis: new THREE.Vector3(0, 1, 0), sign: -1 },
  D: { axis: new THREE.Vector3(0, 1, 0), sign: 1 },
  R: { axis: new THREE.Vector3(1, 0, 0), sign: -1 },
  L: { axis: new THREE.Vector3(1, 0, 0), sign: 1 },
  F: { axis: new THREE.Vector3(0, 0, 1), sign: -1 },
  B: { axis: new THREE.Vector3(0, 0, 1), sign: 1 },
};

export function indicesForFaceLayer(face: FaceId): number[] {
  const out: number[] = [];
  for (let g = 0; g < 54; g++) {
    const fi = Math.floor(g / 9);
    const rem = g % 9;
    const row = Math.floor(rem / 3);
    const col = rem % 3;
    const [x, y, z] = stickerCenter(fi, row, col);
    let ok = false;
    switch (face) {
      case 'U':
        ok = y > LAYER_THRESHOLD;
        break;
      case 'D':
        ok = y < -LAYER_THRESHOLD;
        break;
      case 'R':
        ok = x > LAYER_THRESHOLD;
        break;
      case 'L':
        ok = x < -LAYER_THRESHOLD;
        break;
      case 'F':
        ok = z > LAYER_THRESHOLD;
        break;
      case 'B':
        ok = z < -LAYER_THRESHOLD;
        break;
    }
    if (ok) out.push(g);
  }
  return out;
}

/** cubejs：`power` 0 = 顺时针 90°，1 = 180°，2 = 逆时针 90°（即 '） */
export function angleForFaceTurn(face: FaceId, power: 0 | 1 | 2): number {
  const { sign } = FACE_TURN_SIGN[face];
  const q = Math.PI / 2;
  if (power === 1) return sign * Math.PI;
  if (power === 2) return -sign * q;
  return sign * q;
}

export function axisForFaceTurn(face: FaceId): THREE.Vector3 {
  return FACE_TURN_SIGN[face].axis.clone();
}

export type ParsedMove = {
  face: FaceId;
  /** 0 | 1 | 2 同 cubejs parseAlg */
  power: 0 | 1 | 2;
};

export function parseMoveToken(token: string): ParsedMove | null {
  const t = token.trim();
  if (!t) return null;
  const face = t[0] as FaceId;
  if (!['U', 'D', 'L', 'R', 'F', 'B'].includes(face)) return null;
  let power: 0 | 1 | 2 = 0;
  if (t.length === 1) power = 0;
  else if (t[1] === '2') power = 1;
  else if (t[1] === "'") power = 2;
  else return null;
  return { face, power };
}

export function splitAlgorithm(alg: string): string[] {
  return alg
    .trim()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 单步 token 的逆（与 cubejs 面转一致） */
export function invertMoveToken(token: string): string {
  const p = parseMoveToken(token.trim());
  if (!p) throw new Error(`Invalid move token: ${JSON.stringify(token)}`);
  if (p.power === 0) return `${p.face}'`;
  if (p.power === 1) return `${p.face}2`;
  return `${p.face}`;
}

/**
 * 若 `moves` 为「当前态 → 还原态」的依次转动，则返回「还原态 → 当前态」的依次转动（逐步逆元并逆序）。
 */
export function invertAlgorithmMoves(moves: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = moves.length - 1; i >= 0; i--) {
    out.push(invertMoveToken(moves[i]!));
  }
  return out;
}

function vecForGlobalIndex(g: number): THREE.Vector3 {
  const fi = Math.floor(g / 9);
  const rem = g % 9;
  const row = Math.floor(rem / 3);
  const col = rem % 3;
  return new THREE.Vector3(...stickerCenter(fi, row, col));
}

/**
 * 将图层绕原点旋转 q 后，原 `oldIdx` 贴纸落到的新槽位 `newSlot` 的逆映射：
 * `pieceAtNewSlot[newSlot] = oldIdx`。
 */
export function remapSlotsAfterLayerRotation(
  layerIndices: readonly number[],
  q: THREE.Quaternion,
): number[] {
  const layerSet = new Set(layerIndices);
  const used = new Set<number>();
  const pieceAtNewSlot: number[] = [];
  for (let newSlot = 0; newSlot < 54; newSlot++) {
    const target = vecForGlobalIndex(newSlot);
    if (!layerSet.has(newSlot)) {
      pieceAtNewSlot[newSlot] = newSlot;
      continue;
    }
    let best = -1;
    let bestD = Infinity;
    for (const oldIdx of layerIndices) {
      if (used.has(oldIdx)) continue;
      const p = vecForGlobalIndex(oldIdx).clone().applyQuaternion(q);
      const d = p.distanceTo(target);
      if (d < bestD) {
        bestD = d;
        best = oldIdx;
      }
    }
    pieceAtNewSlot[newSlot] = best;
    used.add(best);
  }
  return pieceAtNewSlot;
}
