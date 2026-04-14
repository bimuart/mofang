/**
 * 将 URFDLB 顺序、每面 row-major 的 (faceIndex, row, col) 映射到世界坐标。
 * 与 cubejs README 展开图一致：U 在上，中间行 L–F–R–B，D 在下；+Y 为上、+Z 为前、+X 为右。
 */

/** 外表面略鼓出，避免共面 z-fighting */
const EPS = 0.012;
const STEP = 2 / 3;
const H = 1;

/** 相邻贴纸之间的缝宽（世界单位），缝中露黑底 */
export const STICKER_GAP = 0.036;

/**
 * 单格贴纸边长：3 列 + 2 道缝 = 2（面宽）
 */
export const STICKER_SIZE = (2 - 2 * STICKER_GAP) / 3;

/** 整面黑色衬底边长（略大于 2 防止边缘露白） */
export const FACE_BACKING_SIZE = 2.002;

/** 黑底相对贴纸平面向立方体内部缩进，避免与贴纸 z-fighting */
export const FACE_BACKING_INSET = 0.022;

/** 每面对应的欧拉角，使默认 XY 平面（法线 +Z）贴到立方体各外表面 */
export const FACE_EULER = [
  [-Math.PI / 2, 0, 0],
  [0, Math.PI / 2, 0],
  [0, 0, 0],
  [Math.PI / 2, 0, 0],
  [0, -Math.PI / 2, 0],
  [0, Math.PI, 0],
] as const;

/** 贴纸中心（世界坐标），立方体半棱长 H=1 */
export function stickerCenter(
  faceIndex: number,
  row: number,
  col: number,
): [number, number, number] {
  switch (faceIndex) {
    case 0:
      return [(col - 1) * STEP, H + EPS, (row - 1) * STEP];
    case 1:
      return [H + EPS, (1 - row) * STEP, (1 - col) * STEP];
    case 2:
      return [(col - 1) * STEP, (1 - row) * STEP, H + EPS];
    case 3:
      return [(col - 1) * STEP, -H - EPS, (1 - row) * STEP];
    case 4:
      return [-H - EPS, (1 - row) * STEP, (col - 1) * STEP];
    case 5:
      return [-(col - 1) * STEP, (1 - row) * STEP, -H - EPS];
    default:
      throw new Error(`invalid faceIndex ${faceIndex}`);
  }
}

/**
 * 该面整面黑色衬底中心（沿外法线略向体内缩进）
 */
export function faceBackingCenter(faceIndex: number): [number, number, number] {
  const d = FACE_BACKING_INSET;
  switch (faceIndex) {
    case 0:
      return [0, H + EPS - d, 0];
    case 1:
      return [H + EPS - d, 0, 0];
    case 2:
      return [0, 0, H + EPS - d];
    case 3:
      return [0, -H - EPS + d, 0];
    case 4:
      return [-H - EPS + d, 0, 0];
    case 5:
      return [0, 0, -H - EPS + d];
    default:
      throw new Error(`invalid faceIndex ${faceIndex}`);
  }
}
