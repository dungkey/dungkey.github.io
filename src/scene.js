import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PhysicsWorld, initializePhysics, createRigidBody, wakeBody } from './physics.js';
import { clamp, computeBookThickness, FALLBACK_PALETTES, parseEpubFile } from './epub.js';
import {
  BOOK,
  BookTransitionRig,
  FRAME_TOP,
  SHELF,
  SHELF_Y,
  SHELVES,
  buildGeometry,
  buildMaterials,
  buildTextures,
  createBookVisual,
  geometry,
  shared,
  shelfTop,
  updateBookVisualDetails,
} from './bookMesh.js';
import {
  deleteBookStorage,
  loadBookChapters,
  loadSavedState,
  saveBookChapters,
  saveBookCover,
  saveShelfState,
  SHELF_WIDTH,
} from './storage.js';
import { CameraRig, setupInputController } from './input.js';
import { BookViewer3D } from './bookViewer3D.js';

const SLOTS = [-2.1, -0.7, 0.7, 2.1, -1.4, 0.0, 1.4, -2.55, 2.55];

const stage = document.getElementById('stage');
const addButton = document.getElementById('add-book');
const curtain = document.getElementById('curtain');
const toastEl = document.getElementById('shelf-toast');
const emptyHintEl = document.getElementById('shelf-empty-hint');

const savedState = loadSavedState();
const state = {
  books: savedState.books,
  nextId: savedState.nextId,
};

let renderer;
let scene;
let camera;
let cameraRig;
let physics;
let bookViewer3D;
let transitionRig;
let inputCtrl;
let bookRoot;

const runtimes = new Map();
let dirtySave = false;
let lastSaveTime = 0;
let needsRender = true;
let loopActive = false;
let lastFrameTime = 0;
let toastTimer = 0;

function showToast(message, durationMs = 2800, isError = false) {
  if (!toastEl) return;
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle('is-error', isError);
  toastEl.classList.add('is-visible');
  if (durationMs > 0) {
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
    }, durationMs);
  }
}

function updateEmptyHint() {
  if (!emptyHintEl) return;
  emptyHintEl.classList.toggle('is-visible', state.books.length === 0);
}

function requestRender() {
  needsRender = true;
  const readingSettled = bookViewer3D?.isOpen && !transitionRig?.mode;
  if (!loopActive && renderer && !readingSettled) {
    loopActive = true;
    lastFrameTime = performance.now();
    renderer.setAnimationLoop(animate);
  }
}

function pauseRenderLoop() {
  if (loopActive && renderer) {
    loopActive = false;
    renderer.setAnimationLoop(null);
  }
}

function syncStateFromPhysics() {
  for (const book of state.books) {
    const runtime = runtimes.get(book.id);
    if (!runtime) continue;
    const { position, quaternion } = runtime.body;
    book.x = position.x;
    book.y = position.y;
    book.z = position.z;
    book.q = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
  }
}

function persistState() {
  syncStateFromPhysics();
  saveShelfState(state.books, state.nextId, () => {
    showToast('存储空间不足，部分书架位置可能无法保存', 4000, true);
  });
}

function buildRoom() {
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), shared.wall);
  wall.position.set(0, 2.5, -0.72);
  wall.receiveShadow = true;
  scene.add(wall);

  bookRoot = new THREE.Group();
  scene.add(bookRoot);

  physics = new PhysicsWorld();

  for (const shelf of SHELVES) {
    const board = new THREE.Mesh(geometry.board, shared.wood);
    board.scale.x = SHELF_WIDTH;
    board.position.set(0, SHELF_Y[shelf], 0);
    board.castShadow = true;
    board.receiveShadow = true;
    scene.add(board);

    const shelfBody = createRigidBody({
      id: `shelf-${shelf}`,
      halfExtents: new THREE.Vector3(SHELF_WIDTH / 2, SHELF.thickness / 2, SHELF.depth / 2),
      position: new THREE.Vector3(0, SHELF_Y[shelf], 0),
      isStatic: true,
      friction: 0.65,
      restitution: 0.04,
    });
    physics.addShelf(shelfBody);
  }

  const frameBottom = SHELF_Y.bottom - SHELF.thickness / 2;
  const height = FRAME_TOP + SHELF.thickness / 2 - frameBottom;
  const railGeo = new RoundedBoxGeometry(SHELF.thickness, height, SHELF.depth, 4, 0.03);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(railGeo, shared.wood);
    rail.position.set(side * (SHELF_WIDTH / 2 + SHELF.thickness / 2), frameBottom + height / 2, 0);
    rail.castShadow = rail.receiveShadow = true;
    scene.add(rail);
  }

  const topBoard = new THREE.Mesh(geometry.board, shared.wood);
  topBoard.scale.x = SHELF_WIDTH + 2 * SHELF.thickness;
  topBoard.position.set(0, FRAME_TOP, 0);
  topBoard.castShadow = topBoard.receiveShadow = true;
  scene.add(topBoard);

  physics.setBounds({
    minX: -SHELF_WIDTH / 2,
    maxX: SHELF_WIDTH / 2,
    minY: shelfTop('bottom'),
    maxY: FRAME_TOP - SHELF.thickness / 2,
    depth: SHELF.depth,
    thickness: SHELF.thickness,
    backZ: -0.72,
  });
}

function setupLights() {
  const hemisphere = new THREE.HemisphereLight(0xfff2dd, 0x7c5b41, 0.55);
  scene.add(hemisphere);

  const key = new THREE.DirectionalLight(0xffe5c0, 3.1);
  key.position.set(5, 8, 6);
  key.target.position.set(0, 2.35, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -8;
  key.shadow.camera.right = 8;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -8;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 30;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(0xc9ddf2, 0.85);
  fill.position.set(-6, 3, 5);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffd39b, 0.7);
  rim.position.set(0, 5, -5);
  scene.add(rim);
}

function setupEnvironment() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');

    const base = context.createLinearGradient(0, 0, 0, 256);
    base.addColorStop(0, '#fff9ee');
    base.addColorStop(0.4, '#f6e8d4');
    base.addColorStop(0.58, '#dcc6aa');
    base.addColorStop(1, '#6f5238');
    context.fillStyle = base;
    context.fillRect(0, 0, 512, 256);

    const windowGlow = context.createRadialGradient(132, 90, 10, 132, 90, 155);
    windowGlow.addColorStop(0, 'rgba(255, 252, 240, 1)');
    windowGlow.addColorStop(0.35, 'rgba(255, 239, 208, 0.55)');
    windowGlow.addColorStop(1, 'rgba(255, 239, 208, 0)');
    context.fillStyle = windowGlow;
    context.fillRect(0, 0, 512, 256);

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const target = pmrem.fromEquirectangular(texture);
    scene.environment = target.texture;
    scene.environmentIntensity = 0.72;
    texture.dispose();
    pmrem.dispose();
  } catch (error) {
    console.warn(error);
  }
}

function addBookRuntime(book, animateIn) {
  const visual = createBookVisual(book, () => {
    renderer.shadowMap.needsUpdate = true;
    requestRender();
  });

  const pos = new THREE.Vector3(
    Number.isFinite(book.x) ? book.x : 0,
    Number.isFinite(book.y) ? book.y : shelfTop('middle') + visual.bookH / 2 + 0.01,
    Number.isFinite(book.z) ? book.z : BOOK.z
  );
  const quat = new THREE.Quaternion(...(book.q || [0, 0, 0, 1])).normalize();

  const body = createRigidBody({
    id: book.id,
    halfExtents: new THREE.Vector3(visual.bookW / 2, visual.bookH / 2, visual.thickness / 2),
    position: pos,
    quaternion: quat,
    mass: clamp(visual.thickness / BOOK.t, 0.55, 2.2),
    friction: 0.48,
    restitution: 0.06,
  });

  if (animateIn) {
    body.linearVelocity.set(0, -0.9, 0);
    body.angularVelocity.z = (Math.random() - 0.5) * 0.45;
  }

  physics.addBody(body);

  const runtime = {
    ...visual,
    body,
  };

  bookRoot.add(visual.group);
  runtimes.set(book.id, runtime);

  runtime.group.position.copy(body.position);
  runtime.group.quaternion.copy(body.quaternion);
  updateBookVisualDetails(runtime, 0.016, book);
  renderer.shadowMap.needsUpdate = true;
  requestRender();
}

export function removeBook(id) {
  const book = state.books.find((b) => b.id === id);
  const title = book?.title || '书籍';
  const runtime = runtimes.get(id);

  if (runtime) {
    if (transitionRig?.runtime === runtime) {
      transitionRig.cancel();
    }
    const oldPos = runtime.body.position.clone();
    bookRoot.remove(runtime.group);
    if (runtime.disposables) {
      for (const item of runtime.disposables) item.dispose?.();
    }
    physics.removeBody(runtime.body);
    runtimes.delete(id);

    for (const other of physics.bodies) {
      if (other.position.distanceTo(oldPos) < 1.35) {
        wakeBody(other);
      }
    }
  }

  const index = state.books.findIndex((b) => b.id === id);
  if (index !== -1) state.books.splice(index, 1);

  if (book?.coverUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(book.coverUrl);
  }
  deleteBookStorage(id);
  persistState();
  updateEmptyHint();
  renderer.shadowMap.needsUpdate = true;
  requestRender();
  showToast(`已移除《${title}》`, 2200);
}

function findSpawnSpot() {
  const shelfOrder = ['middle', 'top', 'bottom'];
  for (const shelf of shelfOrder) {
    const sTop = shelfTop(shelf);
    for (const candidateX of SLOTS) {
      const occupied = state.books.some((book) => {
        const runtime = runtimes.get(book.id);
        const bx = runtime ? runtime.body.position.x : book.x;
        const by = runtime ? runtime.body.position.y : book.y;
        return Math.abs(by - (sTop + BOOK.h / 2)) < 0.75 && Math.abs(bx - candidateX) < 0.68;
      });
      if (!occupied) return { shelf, x: candidateX };
    }
  }
  const fallbackShelf = shelfOrder[state.books.length % shelfOrder.length];
  const fallbackX = SLOTS[state.books.length % SLOTS.length] + (Math.random() - 0.5) * 0.35;
  return { shelf: fallbackShelf, x: clamp(fallbackX, -SHELF_WIDTH / 2 + 0.6, SHELF_WIDTH / 2 - 0.6) };
}

function addEpubBook(epubData) {
  const { shelf, x } = findSpawnSpot();
  const dropHeight = shelfTop(shelf) + BOOK.h / 2 + 0.28;
  const initialTilt = THREE.MathUtils.degToRad((Math.random() - 0.5) * 3.2);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, initialTilt));
  const thickness = epubData.thickness || computeBookThickness(epubData.pages || 260);
  const id = `book-${state.nextId++}`;

  const book = {
    id,
    x,
    y: dropHeight,
    z: BOOK.z,
    q: [q.x, q.y, q.z, q.w],
    theme: state.books.length % FALLBACK_PALETTES.length,
    thickness,
    aspect: epubData.aspect || 0.75,
    pages: epubData.pages || 260,
    title: epubData.title || '未命名书籍',
    author: epubData.author || '',
    palette: epubData.palette || null,
    coverUrl: epubData.coverUrl || null,
    progress: null,
  };

  if (epubData.coverBlob) {
    saveBookCover(id, epubData.coverBlob);
  }
  if (epubData.chapters?.length) {
    saveBookChapters(id, epubData.chapters);
  }

  state.books.push(book);
  addBookRuntime(book, true);
  dirtySave = true;
  persistState();
  updateEmptyHint();
}

async function handleEpubFiles(fileList) {
  const files = Array.from(fileList || []).filter(
    (file) => file && (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip')
  );
  if (!files.length) {
    showToast('请选择 .epub 格式的电子书文件', 2600, true);
    return;
  }

  if (addButton) addButton.classList.add('is-loading');
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const cleanName = file.name.replace(/\.epub$/i, '');
    showToast(`正在导入 (${i + 1}/${files.length})：《${cleanName}》…`, 0);
    try {
      const epubData = await parseEpubFile(file);
      addEpubBook(epubData);
      successCount += 1;
    } catch (err) {
      console.error('解析 EPUB 失败:', file.name, err);
      failCount += 1;
    }
  }

  if (addButton) addButton.classList.remove('is-loading');
  if (failCount === 0) {
    showToast(`成功导入 ${successCount} 本书籍`, 2600);
  } else if (successCount > 0) {
    showToast(`已导入 ${successCount} 本书（${failCount} 个文件解析失败）`, 3600, true);
  } else {
    showToast('导入失败：无法解析所选的 EPUB 文件', 3600, true);
  }
}

function openBookById(bookId) {
  const book = state.books.find((b) => b.id === bookId);
  const runtime = runtimes.get(bookId);
  if (!book || !runtime || !bookViewer3D || bookViewer3D.isOpen || transitionRig?.mode) return;

  if (!book.palette?.cloth) {
    book.palette = FALLBACK_PALETTES[(book.theme ?? 0) % FALLBACK_PALETTES.length];
  }

  const chaptersPromise = loadBookChapters(bookId).catch(() => null);
  bookViewer3D.openBook(runtime, book, chaptersPromise);

  transitionRig.startOpen(
    runtime,
    bookViewer3D.theme,
    () => bookViewer3D.revealSheet(),
    () => {
      if (bookViewer3D.isOpen) pauseRenderLoop();
    }
  );
  renderer.shadowMap.needsUpdate = true;
  requestRender();
}

function handleResize() {
  camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  cameraRig.fitToViewport(true);
  bookViewer3D?.onResize();
  requestRender();
}

function animate(now) {
  const delta = Math.min(Math.max((now - lastFrameTime) / 1000, 0.001), 0.1);
  lastFrameTime = now;
  const elapsed = now / 1000;

  const depthChanged = inputCtrl ? inputCtrl.updateDragDepth(delta) : false;
  const physicsStepped = physics.step(delta);

  let anyAwake = false;
  if (physicsStepped) {
    renderer.shadowMap.needsUpdate = true;
    for (const book of state.books) {
      const runtime = runtimes.get(book.id);
      if (!runtime) continue;
      const { body, group } = runtime;
      group.position.copy(body.renderPosition);
      group.quaternion.copy(body.renderQuaternion);
      updateBookVisualDetails(runtime, delta, book);
      if (!body.sleeping) {
        anyAwake = true;
        dirtySave = true;
      }
    }
  }

  if (dirtySave && (!anyAwake || elapsed - lastSaveTime > 1.2)) {
    persistState();
    dirtySave = false;
    lastSaveTime = elapsed;
  }

  const cameraMoving = cameraRig.update(delta);
  const rigAnimating = transitionRig ? transitionRig.update(delta, camera) : false;
  if (rigAnimating) {
    renderer.shadowMap.needsUpdate = true;
  }

  if (physicsStepped || cameraMoving || depthChanged || rigAnimating || needsRender) {
    needsRender = false;
    renderer.render(scene, camera);
  } else {
    pauseRenderLoop();
  }
}

async function init() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer = new THREE.WebGLRenderer({
    antialias: dpr < 2,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe4d7c5);

  await Promise.all([initializePhysics(), buildTextures()]);

  buildMaterials();
  buildGeometry();
  setupEnvironment();
  buildRoom();
  setupLights();
  transitionRig = new BookTransitionRig(scene);

  camera = new THREE.PerspectiveCamera(32, window.innerWidth / Math.max(1, window.innerHeight), 0.1, 100);
  cameraRig = new CameraRig(camera, renderer.domElement, requestRender);
  cameraRig.fitToViewport(false);

  bookViewer3D = new BookViewer3D({
    onProgressChange: (book) => {
      const runtime = runtimes.get(book.id);
      if (runtime) updateBookVisualDetails(runtime, 0.1, book);
      persistState();
    },
    onDeleteBook: (bookId) => removeBook(bookId),
    onClose: (originRuntime, wasDeleted) => {
      if (!wasDeleted && originRuntime && transitionRig) {
        transitionRig.startClose(originRuntime, bookViewer3D.theme, () => {
          renderer.shadowMap.needsUpdate = true;
          requestRender();
        });
      }
      renderer.shadowMap.needsUpdate = true;
      requestRender();
    },
  });

  state.books.forEach((book) => addBookRuntime(book, false));
  updateEmptyHint();

  inputCtrl = setupInputController({
    renderer,
    camera,
    cameraRig,
    physics,
    runtimes,
    isReaderOpen: () => Boolean(bookViewer3D?.isOpen || transitionRig?.mode),
    onOpenBook: openBookById,
    onDeleteBook: removeBook,
    onImportFiles: handleEpubFiles,
    onMarkDirty: () => {
      dirtySave = true;
    },
    onNeedsRender: requestRender,
  });

  window.addEventListener('resize', handleResize);
  if (addButton) addButton.disabled = false;

  requestRender();
  requestAnimationFrame(() => curtain?.classList.add('is-hidden'));
}

init().catch((error) => {
  console.error(error);
  curtain?.classList.add('is-hidden');
});
