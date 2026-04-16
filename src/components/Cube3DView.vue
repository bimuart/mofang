<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { isEmptyCell } from '../cube/cellValue';
import type { FaceId } from '../cube/types';
import {
  angleForFaceTurn,
  axisForFaceTurn,
  indicesForFaceLayer,
  parseMoveToken,
  remapSlotsAfterLayerRotation,
} from '../cube/layerTurn';
import {
  FACE_EULER,
  STICKER_EDGE_GAP,
  STICKER_SIZE,
  STICKER_THICKNESS,
  stickerCenter,
} from '../cube/stickerLayout';

const props = defineProps<{
  facelets: string;
  faceColors: Record<FaceId, string>;
  /** 需红框高亮的贴纸（全部违规或当前选中约束） */
  highlightIndices: Set<number>;
  /** 不可点击编辑的格（如六个中心） */
  lockedIndices?: ReadonlySet<number>;
  /** 当前选中的贴纸索引，铺半透明天蓝壳 */
  selectedIndex?: number | null;
  /** 下一步还原转动提示，如 U 或 R2 */
  nextHintMove?: string | null;
  /** 贴纸与边框半透明模式 */
  semiTransparent?: boolean;
  /** 半透明开启时贴纸面与黑框的不透明度（0–1），默认与原先贴纸一致 */
  stickerOpacity?: number;
}>();

function clamp01(n: number): number {
  return Math.min(1, Math.max(0.05, n));
}

const emit = defineEmits<{
  stickerClick: [index: number];
}>();

const containerRef = ref<HTMLDivElement | null>(null);

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let raf = 0;

const stickerMeshes: THREE.Mesh[] = [];
const borderRoots: THREE.Group[] = [];
const selectionShells: THREE.Mesh[] = [];
const cellRoots: THREE.Group[] = [];
const disposableGeometries: THREE.BufferGeometry[] = [];

let cubeRoot: THREE.Group | null = null;
let hintRoot: THREE.Group | null = null;

const shellPlaneGeometry = new THREE.PlaneGeometry(STICKER_SIZE, STICKER_SIZE);
const stickerBodyGeometry = new THREE.BoxGeometry(STICKER_SIZE, STICKER_SIZE, STICKER_THICKNESS);

/** 贴纸四周常驻黑框 */
let stickerBlackFrameMaterial: THREE.MeshBasicMaterial | null = null;
let borderFlashMaterial: THREE.MeshBasicMaterial | null = null;
let selectionShellMaterial: THREE.MeshBasicMaterial | null = null;

let disposeThree: (() => void) | null = null;

const half = STICKER_SIZE / 2;
const frameT = Math.max(0.02, STICKER_SIZE * 0.042);
/** 黑框线宽 = 贴纸间实际缝宽的一半，铺在缝内、不盖住贴纸 */
const gapHalf = STICKER_EDGE_GAP / 2;
/** 局部 +Z：缝内黑框与贴片同厚，中心与贴纸盒对齐；选中壳、红框在贴纸前 */
const zBlackGapFrame = -STICKER_THICKNESS / 2;
const zSelectionShell = 0.0036;
const zBorder = 0.006;

const FACE_CENTER: Record<FaceId, THREE.Vector3> = {
  U: new THREE.Vector3(0, 1.22, 0),
  D: new THREE.Vector3(0, -1.22, 0),
  R: new THREE.Vector3(1.22, 0, 0),
  L: new THREE.Vector3(-1.22, 0, 0),
  F: new THREE.Vector3(0, 0, 1.22),
  B: new THREE.Vector3(0, 0, -1.22),
};

function pushGeom(g: THREE.BufferGeometry) {
  disposableGeometries.push(g);
  return g;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 贴在贴纸外侧缝里的黑框：线宽 `gapHalf`，不占彩色面；条带外沿跨一格中心距 `STICKER_SIZE + STICKER_EDGE_GAP`。
 * 沿外法线深度与 `STICKER_THICKNESS` 一致，与彩色贴片厚度对齐。
 */
function buildGapBlackFrame(mat: THREE.MeshBasicMaterial, zOffset: number): THREE.Group {
  const root = new THREE.Group();
  const span = STICKER_SIZE + STICKER_EDGE_GAP;
  const dz = STICKER_THICKNESS;

  const geoH = pushGeom(new THREE.BoxGeometry(span, gapHalf, dz));
  const geoV = pushGeom(new THREE.BoxGeometry(gapHalf, span, dz));

  const top = new THREE.Mesh(geoH, mat);
  top.position.set(0, half + gapHalf / 2, zOffset);
  const bottom = new THREE.Mesh(geoH, mat);
  bottom.position.set(0, -half - gapHalf / 2, zOffset);
  const left = new THREE.Mesh(geoV, mat);
  left.position.set(-half - gapHalf / 2, 0, zOffset);
  const right = new THREE.Mesh(geoV, mat);
  right.position.set(half + gapHalf / 2, 0, zOffset);

  root.add(top, bottom, left, right);
  for (const m of root.children) {
    if (m instanceof THREE.Mesh) m.raycast = () => {};
  }
  return root;
}

/** 四边条边框（违规红框），压在贴纸外沿上 */
function buildEdgeFrame(mat: THREE.MeshBasicMaterial, zOffset: number): THREE.Group {
  const root = new THREE.Group();
  const full = STICKER_SIZE;
  const midV = full - 2 * frameT;
  const dz = frameT * 0.85;

  const geoH = pushGeom(new THREE.BoxGeometry(full, frameT, dz));
  const geoV = pushGeom(new THREE.BoxGeometry(frameT, midV, dz));

  const top = new THREE.Mesh(geoH, mat);
  top.position.set(0, half - frameT / 2, zOffset);
  const bottom = new THREE.Mesh(geoH, mat);
  bottom.position.set(0, -half + frameT / 2, zOffset);
  const left = new THREE.Mesh(geoV, mat);
  left.position.set(-half + frameT / 2, 0, zOffset);
  const right = new THREE.Mesh(geoV, mat);
  right.position.set(half - frameT / 2, 0, zOffset);

  root.add(top, bottom, left, right);
  for (const m of root.children) {
    if (m instanceof THREE.Mesh) m.raycast = () => {};
  }
  return root;
}

function hexToRgb(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

function applyStickerAppearance(globalIdx: number) {
  const mesh = stickerMeshes[globalIdx];
  if (!mesh?.material) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const mat = mats[0];
  if (!(mat instanceof THREE.MeshLambertMaterial)) return;

  const ch = props.facelets[globalIdx] ?? '';
  const semi = props.semiTransparent ?? false;
  const alpha = semi ? clamp01(props.stickerOpacity ?? 0.42) : 1;
  const newSide = semi ? THREE.DoubleSide : THREE.FrontSide;

  if (isEmptyCell(ch)) {
    mat.color.setHex(0x52525b);
  } else {
    const fid = ch as FaceId;
    const base = props.faceColors[fid] ?? '#888888';
    mat.color.copy(hexToRgb(base));
  }

  if (mat.side !== newSide || mat.transparent !== semi) {
    mat.side = newSide;
    mat.transparent = semi;
    mat.needsUpdate = true;
  }
  mat.opacity = semi ? alpha : 1;
  mat.depthWrite = !semi;

  const br = borderRoots[globalIdx];
  if (br) {
    br.visible = props.highlightIndices.has(globalIdx);
  }

  const shell = selectionShells[globalIdx];
  if (shell) {
    shell.visible = props.selectedIndex === globalIdx;
  }
}

/** 黑框、选中天蓝壳、红框条等共享材质（贴纸面在 applyStickerAppearance 中保持不透明） */
function syncAuxiliaryMaterials() {
  const semi = props.semiTransparent ?? false;
  const alpha = semi ? clamp01(props.stickerOpacity ?? 0.42) : 1;
  if (borderFlashMaterial) {
    borderFlashMaterial.transparent = true;
    borderFlashMaterial.depthWrite = true;
  }
  if (selectionShellMaterial) {
    selectionShellMaterial.transparent = true;
    selectionShellMaterial.opacity = 0.4;
    selectionShellMaterial.depthWrite = false;
  }
  if (stickerBlackFrameMaterial) {
    if (stickerBlackFrameMaterial.transparent !== semi) {
      stickerBlackFrameMaterial.transparent = semi;
      stickerBlackFrameMaterial.needsUpdate = true;
    }
    stickerBlackFrameMaterial.opacity = alpha;
    /** 缝内黑线始终写深度：半透明贴纸不写深度时，若此处也不写会被错误地「盖没」；写深度后仍可被更近的面正确遮挡 */
    stickerBlackFrameMaterial.depthWrite = true;
  }
}

function resetCellTransforms() {
  for (let g = 0; g < 54; g++) {
    const face = Math.floor(g / 9);
    const rem = g % 9;
    const row = Math.floor(rem / 3);
    const col = rem % 3;
    const [x, y, z] = stickerCenter(face, row, col);
    const euler = new THREE.Euler(
      FACE_EULER[face]![0],
      FACE_EULER[face]![1],
      FACE_EULER[face]![2],
    );
    const cell = cellRoots[g];
    if (!cell) continue;
    cell.position.set(x, y, z);
    cell.rotation.copy(euler);
    cell.scale.set(1, 1, 1);
  }
}

function permuteAfterMove(pieceAtNewSlot: number[]) {
  const newCells: THREE.Group[] = [];
  const newMeshes: THREE.Mesh[] = [];
  const newBorders: THREE.Group[] = [];
  const newShells: THREE.Mesh[] = [];
  for (let s = 0; s < 54; s++) {
    const j = pieceAtNewSlot[s]!;
    newCells[s] = cellRoots[j]!;
    newMeshes[s] = stickerMeshes[j]!;
    newBorders[s] = borderRoots[j]!;
    newShells[s] = selectionShells[j]!;
    newMeshes[s]!.userData.faceletIndex = s;
  }
  for (let i = 0; i < 54; i++) {
    cellRoots[i] = newCells[i]!;
    stickerMeshes[i] = newMeshes[i]!;
    borderRoots[i] = newBorders[i]!;
    selectionShells[i] = newShells[i]!;
  }
}

function clearHint() {
  if (!hintRoot) return;
  let sharedMat: THREE.MeshBasicMaterial | null = null;
  while (hintRoot.children.length) {
    const o = hintRoot.children[0]!;
    hintRoot.remove(o);
    if (o instanceof THREE.Mesh) {
      if (!sharedMat) sharedMat = o.material as THREE.MeshBasicMaterial;
      o.geometry.dispose();
    }
  }
  sharedMat?.dispose();
}

/**
 * 与 layer 动画一致：绕 `axis` 转 `deltaPhi`（弧度）的圆弧。
 * P(φ) = C + R*(cos φ u0 + sin φ v0)，v0 = ω×u0，故 dP/dφ = ω×(P-C)，与右手系转角一致。
 */
class RotationHintArcCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    readonly center: THREE.Vector3,
    readonly radius: number,
    readonly u0: THREE.Vector3,
    readonly v0: THREE.Vector3,
    readonly phi0: number,
    readonly deltaPhi: number,
  ) {
    super();
  }

  override getPoint(t: number, optionalTarget = new THREE.Vector3()) {
    const phi = this.phi0 + this.deltaPhi * t;
    return optionalTarget
      .copy(this.center)
      .addScaledVector(this.u0, this.radius * Math.cos(phi))
      .addScaledVector(this.v0, this.radius * Math.sin(phi));
  }

  override getTangent(t: number, optionalTarget = new THREE.Vector3()) {
    const phi = this.phi0 + this.deltaPhi * t;
    return optionalTarget
      .copy(this.u0)
      .multiplyScalar(-this.radius * Math.sin(phi) * this.deltaPhi)
      .addScaledVector(this.v0, this.radius * Math.cos(phi) * this.deltaPhi);
  }
}

/** 在过该面中心、垂直于转动轴的平面内，取与 ω 正交的右手基 u0,v0（v0 = ω×u0） */
function hintArcBasis(face: FaceId, omega: THREE.Vector3): {
  center: THREE.Vector3;
  u0: THREE.Vector3;
  v0: THREE.Vector3;
} {
  const center = FACE_CENTER[face].clone();
  const w = omega.clone().normalize();
  const aux = Math.abs(w.x) < 0.55 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u0 = new THREE.Vector3().crossVectors(aux, w).normalize();
  const v0 = new THREE.Vector3().crossVectors(w, u0).normalize();
  return { center, u0, v0 };
}

const HINT_ARC_RADIUS = 0.72;
const HINT_TUBE_RADIUS = 0.058;
/** 提示弧与箭头（深蓝） */
const HINT_DEEP_BLUE = 0x0d47a1;
const CONE_HEIGHT = 0.32;
const CONE_RADIUS = 0.15;

function buildHintArrows(face: FaceId, power: 0 | 1 | 2) {
  clearHint();
  if (!hintRoot) return;

  const omega = axisForFaceTurn(face);
  const deltaPhi = angleForFaceTurn(face, power);
  const { center, u0, v0 } = hintArcBasis(face, omega);
  const phi0 = Math.PI * 0.35;
  const segments = power === 1 ? 64 : 40;

  const arcCurve = new RotationHintArcCurve(
    center,
    HINT_ARC_RADIUS,
    u0,
    v0,
    phi0,
    deltaPhi,
  );

  const tubeGeom = new THREE.TubeGeometry(arcCurve, segments, HINT_TUBE_RADIUS, 12, false);

  /** 与普通网格一致：参与深度缓冲，随视角被魔方体面正常遮挡 */
  const hintMat = new THREE.MeshBasicMaterial({
    color: HINT_DEEP_BLUE,
    side: THREE.DoubleSide,
  });

  const tubeMesh = new THREE.Mesh(tubeGeom, hintMat);
  hintRoot.add(tubeMesh);

  /**
   * ConeGeometry：局部 +Y 为从底圆指向锥尖。锥底（锥尾）贴在弧端点，锥尖沿 `tan` 朝外。
   * `flip`：对 180° 起点反向，使两端锥尖均背离弧段朝外。
   */
  function addConeAtCurveT(tAnchor: number, flip: boolean) {
    const g = new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 20);
    const cone = new THREE.Mesh(g, hintMat);
    const arcPoint = arcCurve.getPoint(tAnchor);
    let tan = arcCurve.getTangent(tAnchor);
    if (tan.lengthSq() < 1e-10) return;
    tan.normalize();
    if (flip) tan.multiplyScalar(-1);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan);
    cone.position.copy(arcPoint.clone().add(tan.clone().multiplyScalar(CONE_HEIGHT / 2)));
    hintRoot!.add(cone);
  }

  addConeAtCurveT(1, false);
  if (power === 1) {
    addConeAtCurveT(0, true);
  }
}

function updateTurnHint() {
  const raw = props.nextHintMove?.trim();
  if (!raw || !hintRoot) {
    clearHint();
    return;
  }
  const parsed = parseMoveToken(raw);
  if (!parsed) {
    clearHint();
    return;
  }
  buildHintArrows(parsed.face, parsed.power);
}

function buildCube(root: THREE.Group) {
  const blackFrameMat = new THREE.MeshBasicMaterial({
    color: 0x0a0a0a,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -0.5,
  });
  stickerBlackFrameMaterial = blackFrameMat;

  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xff0520,
    transparent: true,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
  });
  borderFlashMaterial = flashMat;

  const shellMat = new THREE.MeshBasicMaterial({
    color: 0x87ceeb,
    transparent: true,
    opacity: 0.4,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  selectionShellMaterial = shellMat;

  for (let face = 0; face < 6; face++) {
    const euler = new THREE.Euler(
      FACE_EULER[face]![0],
      FACE_EULER[face]![1],
      FACE_EULER[face]![2],
    );
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const g = face * 9 + row * 3 + col;
        /** 薄盒六面共用同一材质，半透明时侧面与正面同色 */
        const stickerMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const mesh = new THREE.Mesh(stickerBodyGeometry, [
          stickerMat,
          stickerMat,
          stickerMat,
          stickerMat,
          stickerMat,
          stickerMat,
        ]);
        mesh.position.z = -STICKER_THICKNESS / 2;
        mesh.userData.faceletIndex = g;

        const blackFrame = buildGapBlackFrame(blackFrameMat, zBlackGapFrame);

        const border = buildEdgeFrame(flashMat, zBorder);
        border.visible = false;

        const shell = new THREE.Mesh(shellPlaneGeometry, shellMat);
        shell.position.z = zSelectionShell;
        shell.visible = false;
        shell.raycast = () => {};

        const cell = new THREE.Group();
        cell.add(mesh);
        cell.add(blackFrame);
        cell.add(shell);
        cell.add(border);

        const [x, y, z] = stickerCenter(face, row, col);
        cell.position.set(x, y, z);
        cell.rotation.copy(euler);

        mesh.renderOrder = 1;

        root.add(cell);
        stickerMeshes[g] = mesh;
        borderRoots[g] = border;
        selectionShells[g] = shell;
        cellRoots[g] = cell;
        applyStickerAppearance(g);
      }
    }
  }
}

function syncAllStickers() {
  for (let i = 0; i < 54; i++) {
    applyStickerAppearance(i);
  }
  syncAuxiliaryMaterials();
}

let animating = false;

function animateMove(move: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!scene || !cubeRoot) {
      reject(new Error('scene not ready'));
      return;
    }
    const parsed = parseMoveToken(move.trim());
    if (!parsed) {
      reject(new Error('bad move'));
      return;
    }
    if (animating) {
      reject(new Error('busy'));
      return;
    }
    animating = true;
    const { face, power } = parsed;
    const indices = indicesForFaceLayer(face);
    const axis = axisForFaceTurn(face).normalize();
    const angle = angleForFaceTurn(face, power);
    const qEnd = new THREE.Quaternion().setFromAxisAngle(axis, angle);

    const pivot = new THREE.Group();
    scene.add(pivot);

    for (const i of indices) {
      const cell = cellRoots[i];
      if (cell) pivot.attach(cell);
    }

    const t0 = performance.now();
    const duration = 420;

    function frame() {
      if (!pivot.parent || !scene || !cubeRoot) {
        animating = false;
        return;
      }
      const t = Math.min(1, (performance.now() - t0) / duration);
      const e = easeInOutCubic(t);
      pivot.quaternion.slerpQuaternions(new THREE.Quaternion(), qEnd, e);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        finish();
      }
    }

    function finish() {
      pivot.quaternion.copy(qEnd);
      for (const i of indices) {
        const cell = cellRoots[i];
        if (cell) cubeRoot!.attach(cell);
      }
      scene!.remove(pivot);

      const pieceAtNew = remapSlotsAfterLayerRotation(indices, qEnd);
      permuteAfterMove(pieceAtNew);
      animating = false;
      resolve();
    }

    frame();
  });
}

function resetLayout() {
  resetCellTransforms();
  for (let i = 0; i < 54; i++) {
    stickerMeshes[i]!.userData.faceletIndex = i;
  }
  syncAllStickers();
}

defineExpose({
  animateMove,
  resetLayout,
});

onMounted(() => {
  const el = containerRef.value;
  if (!el) return;

  const w = el.clientWidth;
  const h = el.clientHeight || 480;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf2f3f7);

  camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
  camera.position.set(3.4, 2.5, 4.6);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  el.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 2.8;
  controls.maxDistance = 14;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.05));
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c0d0, 0.55));

  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(5, 8, 6);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xf8f9ff, 0.55);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffeedd, 0.35);
  rim.position.set(0, -4, 5);
  scene.add(rim);

  cubeRoot = new THREE.Group();
  cubeRoot.renderOrder = 0;
  buildCube(cubeRoot);
  syncAuxiliaryMaterials();
  scene.add(cubeRoot);

  hintRoot = new THREE.Group();
  scene.add(hintRoot);
  updateTurnHint();

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let downX = 0;
  let downY = 0;

  function onPointerDown(ev: PointerEvent) {
    downX = ev.clientX;
    downY = ev.clientY;
  }

  function onPointerUp(ev: PointerEvent) {
    const dx = ev.clientX - downX;
    const dy = ev.clientY - downY;
    if (dx * dx + dy * dy > 36) return;
    if (!renderer || !camera) return;
    if (animating) return;

    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(stickerMeshes, false);
    if (hits.length > 0) {
      const idx = hits[0]!.object.userData.faceletIndex;
      if (typeof idx === 'number') {
        if (props.lockedIndices?.has(idx)) return;
        emit('stickerClick', idx);
      }
    }
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  const ro = new ResizeObserver(() => {
    if (!containerRef.value || !renderer || !camera) return;
    const cw = containerRef.value.clientWidth;
    const ch = containerRef.value.clientHeight || 480;
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    renderer.setSize(cw, ch);
  });
  ro.observe(el);

  /** 周期约 1s：违规红框透明度正弦闪烁 */
  function tick() {
    raf = requestAnimationFrame(tick);
    controls?.update();

    if (borderFlashMaterial) {
      if (props.highlightIndices.size > 0) {
        const phase = (performance.now() / 1000) * Math.PI * 2;
        borderFlashMaterial.opacity =
          0.3 + 0.7 * (0.5 + 0.5 * Math.sin(phase));
      } else {
        borderFlashMaterial.opacity = 1;
      }
    }
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }
  tick();

  disposeThree = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    renderer?.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer?.domElement.removeEventListener('pointerup', onPointerUp);
    controls?.dispose();
    shellPlaneGeometry.dispose();
    stickerBodyGeometry.dispose();
    stickerBlackFrameMaterial?.dispose();
    stickerBlackFrameMaterial = null;
    borderFlashMaterial?.dispose();
    borderFlashMaterial = null;
    selectionShellMaterial?.dispose();
    selectionShellMaterial = null;

    clearHint();

    for (const m of stickerMeshes) {
      const mat = m.material;
      if (Array.isArray(mat)) {
        mat[0]?.dispose();
      } else {
        (mat as THREE.Material | undefined)?.dispose();
      }
    }
    stickerMeshes.length = 0;
    borderRoots.length = 0;
    selectionShells.length = 0;
    cellRoots.length = 0;

    for (const g of disposableGeometries) {
      g.dispose();
    }
    disposableGeometries.length = 0;

    renderer?.dispose();
    if (renderer?.domElement.parentElement === el) {
      el.removeChild(renderer.domElement);
    }
    renderer = null;
    scene = null;
    camera = null;
    controls = null;
    cubeRoot = null;
    hintRoot = null;
    disposeThree = null;
  };
});

onBeforeUnmount(() => {
  disposeThree?.();
});

watch(
  () =>
    [
      props.facelets,
      [...props.highlightIndices].sort().join(','),
      props.selectedIndex ?? '',
    ] as const,
  () => {
    syncAllStickers();
  },
);

watch(
  () => props.nextHintMove,
  () => {
    updateTurnHint();
  },
);

watch(
  () => [props.semiTransparent, props.stickerOpacity] as const,
  () => {
    syncAllStickers();
  },
);
</script>

<template>
  <div
    ref="containerRef"
    class="cube-3d"
    role="img"
    aria-label="三阶魔方三维视图，拖拽旋转视角，点击贴纸换色"
  />
</template>

<style scoped>
.cube-3d {
  width: 100%;
  min-height: min(72vh, 560px);
  border-radius: 12px;
  overflow: hidden;
  background: #e8e9ee;
  touch-action: none;
}
</style>
