<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { isEmptyCell } from '../cube/cellValue';
import type { FaceId } from '../cube/types';
import {
  FACE_BACKING_SIZE,
  FACE_EULER,
  STICKER_SIZE,
  faceBackingCenter,
  stickerCenter,
} from '../cube/stickerLayout';

const props = defineProps<{
  facelets: string;
  faceColors: Record<FaceId, string>;
  illegal: Set<number>;
}>();

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
const disposableGeometries: THREE.BufferGeometry[] = [];

const planeGeometry = new THREE.PlaneGeometry(STICKER_SIZE, STICKER_SIZE);

/** 六面共用：整面黑底，缝内露黑 */
let faceBackingGeometry: THREE.PlaneGeometry | null = null;
let faceBackingMaterial: THREE.MeshBasicMaterial | null = null;

let borderFlashMaterial: THREE.MeshBasicMaterial | null = null;

let disposeThree: (() => void) | null = null;

const half = STICKER_SIZE / 2;
const frameT = Math.max(0.02, STICKER_SIZE * 0.042);
const zBorder = 0.006;

function pushGeom(g: THREE.BufferGeometry) {
  disposableGeometries.push(g);
  return g;
}

/** 四边红框，法线朝外略浮于贴纸之上；与非法状态 visibility 联动 */
function buildErrorFrame(mat: THREE.MeshBasicMaterial): THREE.Group {
  const root = new THREE.Group();
  const full = STICKER_SIZE;
  const midV = full - 2 * frameT;
  const dz = frameT * 0.85;

  const geoH = pushGeom(new THREE.BoxGeometry(full, frameT, dz));
  const geoV = pushGeom(new THREE.BoxGeometry(frameT, midV, dz));

  const top = new THREE.Mesh(geoH, mat);
  top.position.set(0, half - frameT / 2, zBorder);
  const bottom = new THREE.Mesh(geoH, mat);
  bottom.position.set(0, -half + frameT / 2, zBorder);
  const left = new THREE.Mesh(geoV, mat);
  left.position.set(-half + frameT / 2, 0, zBorder);
  const right = new THREE.Mesh(geoV, mat);
  right.position.set(half - frameT / 2, 0, zBorder);

  root.add(top, bottom, left, right);
  return root;
}

function hexToRgb(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

function applyStickerAppearance(globalIdx: number) {
  const mesh = stickerMeshes[globalIdx];
  if (!mesh?.material || Array.isArray(mesh.material)) return;
  const mat = mesh.material as THREE.MeshLambertMaterial;
  const ch = props.facelets[globalIdx] ?? '';

  if (isEmptyCell(ch)) {
    mat.color.setHex(0x9ca3af);
    mat.transparent = false;
    mat.opacity = 1;
    mat.depthWrite = true;
  } else {
    const fid = ch as FaceId;
    const base = props.faceColors[fid] ?? '#888888';
    mat.color.copy(hexToRgb(base));
    mat.transparent = false;
    mat.opacity = 1;
    mat.depthWrite = true;
  }

  const br = borderRoots[globalIdx];
  if (br) {
    br.visible = props.illegal.has(globalIdx);
  }
}

function buildCube(root: THREE.Group) {
  faceBackingGeometry = new THREE.PlaneGeometry(FACE_BACKING_SIZE, FACE_BACKING_SIZE);
  faceBackingMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  for (let face = 0; face < 6; face++) {
    const euler = new THREE.Euler(
      FACE_EULER[face]![0],
      FACE_EULER[face]![1],
      FACE_EULER[face]![2],
    );
    const back = new THREE.Mesh(faceBackingGeometry, faceBackingMaterial);
    const [bx, by, bz] = faceBackingCenter(face);
    back.position.set(bx, by, bz);
    back.rotation.copy(euler);
    root.add(back);
  }

  borderFlashMaterial = new THREE.MeshBasicMaterial({
    color: 0xff0520,
    transparent: true,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
  });

  for (let face = 0; face < 6; face++) {
    const euler = new THREE.Euler(
      FACE_EULER[face]![0],
      FACE_EULER[face]![1],
      FACE_EULER[face]![2],
    );
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const g = face * 9 + row * 3 + col;
        const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const mesh = new THREE.Mesh(planeGeometry, mat);
        mesh.userData.faceletIndex = g;

        const border = buildErrorFrame(borderFlashMaterial);
        border.visible = false;

        const cell = new THREE.Group();
        cell.add(mesh);
        cell.add(border);

        const [x, y, z] = stickerCenter(face, row, col);
        cell.position.set(x, y, z);
        cell.rotation.copy(euler);

        root.add(cell);
        stickerMeshes[g] = mesh;
        borderRoots[g] = border;
        applyStickerAppearance(g);
      }
    }
  }
}

function syncAllStickers() {
  for (let i = 0; i < 54; i++) {
    applyStickerAppearance(i);
  }
}

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

  const group = new THREE.Group();
  buildCube(group);
  scene.add(group);

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

    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(stickerMeshes, false);
    if (hits.length > 0) {
      const idx = hits[0]!.object.userData.faceletIndex;
      if (typeof idx === 'number') {
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

  /** 周期 1s：边框透明度正弦闪烁 */
  function tick() {
    raf = requestAnimationFrame(tick);
    controls?.update();

    if (borderFlashMaterial) {
      if (props.illegal.size > 0) {
        const phase = (performance.now() / 1000) * Math.PI * 2;
        borderFlashMaterial.opacity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(phase));
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
    planeGeometry.dispose();
    faceBackingGeometry?.dispose();
    faceBackingGeometry = null;
    faceBackingMaterial?.dispose();
    faceBackingMaterial = null;
    borderFlashMaterial?.dispose();
    borderFlashMaterial = null;

    for (const m of stickerMeshes) {
      const mat = m.material;
      if (!Array.isArray(mat)) mat.dispose();
    }
    stickerMeshes.length = 0;
    borderRoots.length = 0;

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
    disposeThree = null;
  };
});

onBeforeUnmount(() => {
  disposeThree?.();
});

watch(
  () => [props.facelets, [...props.illegal].sort().join(',')] as const,
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
