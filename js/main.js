import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { loadFamilies } from './apriltag.js';
import { generateModel, flipForPrint } from './geometry.js';
import { build3mfBlob } from './export3mf.js';

const PRESETS = {
  0: { panelName: 'Pump Panel' },
  1: { panelName: 'Muffler Panel' },
  2: { panelName: 'Battery Panel' },
  3: { panelName: 'E Stop Panel' },
};

const els = {
  preset: document.getElementById('preset'),
  family: document.getElementById('family'),
  tagId: document.getElementById('tagId'),
  tagIdRange: document.getElementById('tagIdRange'),
  panelName: document.getElementById('panelName'),
  squareSize: document.getElementById('squareSize'),
  totalThickness: document.getElementById('totalThickness'),
  frontSkinThickness: document.getElementById('frontSkinThickness'),
  chamferEdge: document.getElementById('chamferEdge'),
  chamferSize: document.getElementById('chamferSize'),
  notice: document.getElementById('notice'),
  downloadBtn: document.getElementById('downloadBtn'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  downloadBambuBtn: document.getElementById('downloadBambuBtn'),
  swapSlots: document.getElementById('swapSlots'),
  loading: document.getElementById('loading'),
  canvas: document.getElementById('canvas'),
  viewport: document.querySelector('.viewport'),
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2c33);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
const renderer = new THREE.WebGLRenderer({ canvas: els.canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(1, -1, 2);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(-1, 1, -1);
scene.add(fill);

const whiteMaterial = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.7, metalness: 0.05 });
const blackMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.7, metalness: 0.05 });
let whiteMesh = null;
let blackMesh = null;

function resize() {
  const w = els.viewport.clientWidth;
  const h = els.viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(els.viewport);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

function fitCamera(plateSize, thickness) {
  const dist = plateSize * 1.7;
  camera.position.set(plateSize * 0.35, -plateSize * 0.55, dist * 0.65);
  camera.near = Math.max(0.01, plateSize * 0.002);
  camera.far = plateSize * 30;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, thickness / 2);
  controls.update();
}

function showNotice(message) {
  if (message) {
    els.notice.textContent = message;
    els.notice.hidden = false;
  } else {
    els.notice.hidden = true;
  }
}

let families = null;
let font = null;
let lastPlateSize = null;
let currentResult = null;

function readState() {
  return {
    familyKey: els.family.value,
    tagId: parseInt(els.tagId.value, 10),
    squareSize: parseFloat(els.squareSize.value),
    totalThickness: parseFloat(els.totalThickness.value),
    frontSkinThickness: parseFloat(els.frontSkinThickness.value),
    chamferEdge: els.chamferEdge.value,
    chamferSize: parseFloat(els.chamferSize.value),
    panelName: els.panelName.value,
  };
}

// Keeps the preset dropdown honest: shows a canned preset only when the
// current fields exactly match it, otherwise falls back to "New AprilTag".
function syncPresetDropdown(state) {
  let matched = 'new';
  for (const [presetId, preset] of Object.entries(PRESETS)) {
    if (state.familyKey === 'tag36h11' && state.tagId === Number(presetId) && state.panelName.trim() === preset.panelName) {
      matched = presetId;
      break;
    }
  }
  if (els.preset.value !== matched) els.preset.value = matched;
}

function updateMeshes(result) {
  if (whiteMesh) {
    scene.remove(whiteMesh);
    whiteMesh.geometry.dispose();
  }
  if (blackMesh) {
    scene.remove(blackMesh);
    blackMesh.geometry.dispose();
  }
  whiteMesh = new THREE.Mesh(result.whiteGeometry, whiteMaterial);
  blackMesh = new THREE.Mesh(result.blackGeometry, blackMaterial);
  scene.add(whiteMesh, blackMesh);

  if (lastPlateSize === null || Math.abs(result.plateSize - lastPlateSize) > 1e-6) {
    fitCamera(result.plateSize, result.totalThickness ?? parseFloat(els.totalThickness.value));
    lastPlateSize = result.plateSize;
  }
}

function regenerate() {
  if (!families) return;
  const state = readState();
  const familyData = families[state.familyKey];
  if (!familyData) return;

  const maxId = familyData.codes.length - 1;
  els.tagIdRange.textContent = `(0–${maxId})`;
  if (!Number.isInteger(state.tagId) || state.tagId < 0) {
    state.tagId = 0;
    els.tagId.value = 0;
  } else if (state.tagId > maxId) {
    state.tagId = maxId;
    els.tagId.value = maxId;
  }
  els.tagId.max = String(maxId);

  syncPresetDropdown(state);

  if (!(state.squareSize > 0) || !(state.totalThickness > 0)) return;

  let result;
  try {
    result = generateModel({
      familyData,
      tagId: state.tagId,
      squareSize: state.squareSize,
      totalThickness: state.totalThickness,
      frontSkinThickness: Math.max(0.05, state.frontSkinThickness || 0.25),
      chamferEdge: state.chamferEdge,
      chamferSize: Math.max(0, state.chamferSize || 0),
      panelName: state.panelName,
      font,
    });
  } catch (err) {
    showNotice(err.message);
    els.downloadBtn.disabled = true;
    return;
  }

  currentResult = { ...result, totalThickness: state.totalThickness, panelName: state.panelName, tagId: state.tagId, familyKey: state.familyKey };
  updateMeshes(currentResult);
  showNotice(result.notice);
  els.downloadBtn.disabled = false;
}

let debounceHandle = null;
function scheduleRegenerate() {
  clearTimeout(debounceHandle);
  debounceHandle = setTimeout(regenerate, 80);
}

[els.family, els.tagId, els.panelName, els.squareSize, els.totalThickness,
  els.frontSkinThickness, els.chamferEdge, els.chamferSize]
  .forEach((el) => el.addEventListener('input', scheduleRegenerate));

els.preset.addEventListener('change', () => {
  const key = els.preset.value;
  if (key === 'new') {
    els.family.value = 'tag36h11';
    els.tagId.value = '0';
    els.panelName.value = '';
  } else {
    els.family.value = 'tag36h11';
    els.tagId.value = key;
    els.panelName.value = PRESETS[key].panelName;
  }
  regenerate();
});

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

els.downloadBtn.addEventListener('click', () => {
  if (!currentResult) return;
  const t = currentResult.totalThickness;
  const blob = build3mfBlob({
    objects: [
      { geometry: flipForPrint(currentResult.whiteGeometry, t), name: 'Tag Background' },
      { geometry: flipForPrint(currentResult.blackGeometry, t), name: 'Tag Ink' },
    ],
  });
  const safeName = (currentResult.panelName || 'panel').trim().replace(/[^a-z0-9_-]+/gi, '_') || 'panel';
  triggerDownload(blob, `apriltag_${currentResult.familyKey}_${currentResult.tagId}_${safeName}.3mf`);
});

// Builds one preset's model using whatever size/thickness/chamfer settings
// are currently set in the shared fields below, overriding only tag id,
// family, and panel label to match the preset.
function buildPresetModel(presetId, squareSize, totalThickness, frontSkinThickness, chamferEdge, chamferSize) {
  return generateModel({
    familyData: families.tag36h11,
    tagId: Number(presetId),
    squareSize,
    totalThickness,
    frontSkinThickness,
    chamferEdge,
    chamferSize,
    panelName: PRESETS[presetId].panelName,
    font,
  });
}

function todayForFolderName() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Builds all 4 preset panels, flipped print-side-down, laid out side by
// side on one virtual plate (2x2 grid) so they don't overlap in the file.
// extruders, if given, is { background, ink } — 1-based AMS slot numbers
// baked into the file's Bambu/Orca metadata. Which physical color that
// slot number prints in is up to what's loaded in the printer's AMS, not
// something the file controls — the swap-slots checkbox just lets the
// user match whichever way their own AMS happens to be loaded.
function buildPlateObjects(squareSize, totalThickness, frontSkinThickness, chamferEdge, chamferSize, extruders) {
  const presetIds = Object.keys(PRESETS);
  const cols = 2;
  const objects = [];
  let step = null;

  presetIds.forEach((presetId, idx) => {
    const result = buildPresetModel(presetId, squareSize, totalThickness, frontSkinThickness, chamferEdge, chamferSize);
    if (step === null) step = result.plateSize + Math.max(6, result.plateSize * 0.05);

    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const gx = (col - 0.5) * step;
    const gy = (0.5 - row) * step;

    const white = flipForPrint(result.whiteGeometry, totalThickness);
    white.translate(gx, gy, 0);
    const black = flipForPrint(result.blackGeometry, totalThickness);
    black.translate(gx, gy, 0);

    objects.push({ geometry: white, name: `${PRESETS[presetId].panelName} Background`, extruder: extruders?.background });
    objects.push({ geometry: black, name: `${PRESETS[presetId].panelName} Ink`, extruder: extruders?.ink });
  });

  return objects;
}

function readPlateParams() {
  return {
    squareSize: parseFloat(els.squareSize.value),
    totalThickness: parseFloat(els.totalThickness.value),
    frontSkinThickness: Math.max(0.05, parseFloat(els.frontSkinThickness.value) || 0.25),
    chamferEdge: els.chamferEdge.value,
    chamferSize: Math.max(0, parseFloat(els.chamferSize.value) || 0),
  };
}

els.downloadAllBtn.addEventListener('click', () => {
  if (!families || !font) return;
  const p = readPlateParams();
  if (!(p.squareSize > 0) || !(p.totalThickness > 0)) return;

  let objects;
  try {
    objects = buildPlateObjects(p.squareSize, p.totalThickness, p.frontSkinThickness, p.chamferEdge, p.chamferSize, null);
  } catch (err) {
    showNotice(`Failed to build plate: ${err.message}`);
    return;
  }
  const blob = build3mfBlob({ objects });
  triggerDownload(blob, `Latest Gripper April Tags x4 - ${todayForFolderName()}.3mf`);
});

els.downloadBambuBtn.addEventListener('click', () => {
  if (!families || !font) return;
  const p = readPlateParams();
  if (!(p.squareSize > 0) || !(p.totalThickness > 0)) return;
  const extruders = els.swapSlots.checked ? { background: 2, ink: 1 } : { background: 1, ink: 2 };

  let objects;
  try {
    objects = buildPlateObjects(p.squareSize, p.totalThickness, p.frontSkinThickness, p.chamferEdge, p.chamferSize, extruders);
  } catch (err) {
    showNotice(`Failed to build plate: ${err.message}`);
    return;
  }
  const blob = build3mfBlob({ objects });
  triggerDownload(blob, `Latest Gripper April Tags x4 - ${todayForFolderName()} (Bambu Plate).3mf`);
});

Promise.all([
  loadFamilies(),
  fetch(new URL('./vendor/fonts/helvetiker_regular.typeface.json', import.meta.url)).then((r) => r.json()),
]).then(([familiesData, fontJson]) => {
  families = familiesData;
  font = new FontLoader().parse(fontJson);
  els.loading.hidden = true;
  els.downloadAllBtn.disabled = false;
  els.downloadBambuBtn.disabled = false;
  regenerate();
}).catch((err) => {
  els.loading.textContent = `Failed to load: ${err.message}`;
});
