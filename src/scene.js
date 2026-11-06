import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  PhysicsWorld,
  initializePhysics,
  createRigidBody,
  setBodyHalfExtents,
  wakeBody,
} from './physics.js';
import {
  parseEpubFile,
  renderSpineCanvas,
  computeBookThickness,
} from './epub.js';
import { BookViewer3D, ensureCustomFontLoaded } from './bookViewer3D.js?v=flat-reader-2';

const CONTENT_DB_NAME = 'shelf-book-content-db';
const CONTENT_STORE_NAME = 'book-chapters';

function openContentDb() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.indexedDB) return resolve(null);
    const req = indexedDB.open(CONTENT_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CONTENT_STORE_NAME)) {
        db.createObjectStore(CONTENT_STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function saveBookChaptersToStorage(bookId, chapters) {
  if (!bookId || !chapters) return;
  try {
    const db = await openContentDb();
    if (!db) return;
    const tx = db.transaction(CONTENT_STORE_NAME, 'readwrite');
    tx.objectStore(CONTENT_STORE_NAME).put({ id: bookId, chapters });
  } catch (e) {
    console.warn(e);
  }
}

async function loadBookChaptersFromStorage(bookId) {
  if (!bookId) return null;
  try {
    const db = await openContentDb();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(CONTENT_STORE_NAME, 'readonly');
      const req = tx.objectStore(CONTENT_STORE_NAME).get(bookId);
      req.onsuccess = () => resolve(req.result ? req.result.chapters : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

const THEMES = [
  { cloth: '#4f5b49', dark: '#35412f', sheen: '#c9d5b4' },
  { cloth: '#7a3f35', dark: '#57271f', sheen: '#e3b9a5' },
  { cloth: '#33465d', dark: '#202d40', sheen: '#b8c9de' },
  { cloth: '#a37742', dark: '#775026', sheen: '#f0d8b0' },
  { cloth: '#3a3834', dark: '#201e1b', sheen: '#c9bca8' },
  { cloth: '#6c5260', dark: '#4a3542', sheen: '#dcc3d1' },
];

const SHELVES = ['bottom', 'middle', 'top'];
const SHELF_Y = { bottom: 0.55, middle: 2.25, top: 3.95 };
const STORAGE_KEY = 'shelf-3d-books-v2';
const SLOTS = [0.38, 0.56, 0.22, 0.72, 0.47, 0.64, 0.3, 0.8, 0.15, 0.86];
const BOOK = { w: 0.84, h: 1.12, t: 0.2, cover: 0.03, z: 0.05 };
const SHELF = { thickness: 0.16, depth: 1.25 };
const FRAME_TOP = 5.65;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function shelfTop(shelf) {
  return SHELF_Y[shelf] + SHELF.thickness / 2;
}

function computeShelfWidth() {
  const aspect = window.innerWidth / window.innerHeight;
  if (aspect < 0.8) return 4.4;
  if (aspect < 1.2) return 6.0;
  return 7.6;
}

function usableHalfWidth(shelfWidth = state.shelfWidth) {
  return shelfWidth / 2 - 0.55;
}

function mapX(xNorm, shelfWidth = state.shelfWidth) {
  return (clamp(xNorm, 0, 1) - 0.5) * 2 * usableHalfWidth(shelfWidth);
}

function xToNorm(x, shelfWidth = state.shelfWidth) {
  return clamp(0.5 + x / (2 * usableHalfWidth(shelfWidth)), 0.01, 0.99);
}

function legacyPoseToTransform(book) {
  const shelf = SHELVES.includes(book.shelf) ? book.shelf : 'middle';
  const orientation = book.orientation || 'front';
  const tilt = THREE.MathUtils.degToRad(
    Number.isFinite(book.tilt) ? clamp(book.tilt, -6, 6) : 0
  );

  let q;
  let halfH = BOOK.h / 2;
  if (orientation === 'spine') {
    q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, Math.PI / 2, tilt * 0.35, 'ZXY')
    );
  } else if (orientation === 'flat') {
    q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI / 2, 0, tilt * 0.6, 'ZXY')
    );
    halfH = BOOK.t / 2;
  } else {
    q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, tilt, 'ZXY'));
  }

  return {
    xNorm: Number.isFinite(book.xNorm)
      ? clamp(book.xNorm, 0.02, 0.98)
      : Number.isFinite(book.x)
        ? clamp(book.x, 0.02, 0.98)
        : 0.38,
    y: shelfTop(shelf) + halfH + 0.002,
    z: BOOK.z,
    q: [q.x, q.y, q.z, q.w],
  };
}

function loadSavedState() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem('shelf-3d-books-v1') ??
      localStorage.getItem('shelf-books-v1');
    if (!raw) return null;

    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.books)) return null;

    const books = saved.books
      .map((book, index) => {
        if (!book || typeof book !== 'object') return null;

        const theme = Number.isFinite(book.theme)
          ? ((Math.trunc(book.theme) % THEMES.length) + THEMES.length) % THEMES.length
          : index % THEMES.length;

        const id =
          typeof book.id === 'string' && /^[a-z0-9-]+$/i.test(book.id)
            ? book.id
            : `book-${index + 1}`;

        if (
          Number.isFinite(book.y) &&
          Array.isArray(book.q) &&
          book.q.length === 4 &&
          book.q.every(Number.isFinite)
        ) {
          const cleanQ = new THREE.Quaternion(...book.q).normalize();
          const thickness = Number.isFinite(book.thickness)
            ? clamp(book.thickness, 0.08, 0.45)
            : Number.isFinite(book.pages)
              ? computeBookThickness(book.pages)
              : BOOK.t;
          return {
            id,
            xNorm: Number.isFinite(book.xNorm) ? clamp(book.xNorm, 0.02, 0.98) : 0.38,
            
            y: book.y,
            z: Number.isFinite(book.z) ? clamp(book.z, -0.6, 1.5) : BOOK.z,
            q: [cleanQ.x, cleanQ.y, cleanQ.z, cleanQ.w],
            theme,
            thickness,
            pages: Number.isFinite(book.pages) ? book.pages : undefined,
            title: typeof book.title === 'string' ? book.title : undefined,
            author: typeof book.author === 'string' ? book.author : undefined,
            palette: book.palette && typeof book.palette === 'object' ? book.palette : undefined,
            coverDataUrl:
              typeof book.coverDataUrl === 'string' ? book.coverDataUrl : undefined,
          };
        }

        const legacy = legacyPoseToTransform(book);
        return {
          id,
          ...legacy,
          theme,
          thickness: BOOK.t,
        };
      })
      .filter(Boolean);

    const maxId = books.reduce((max, book) => {
      const value = Number.parseInt(book.id.replace('book-', ''), 10);
      return Number.isFinite(value) ? Math.max(max, value) : max;
    }, 0);

    return {
      books,
      nextId: Math.max(Number(saved.nextId) || 0, maxId + 1, 1),
    };
  } catch {
    return null;
  }
}

const initialShelfWidth = computeShelfWidth();
const savedState = loadSavedState();

const state = {
  books: savedState
    ? savedState.books
    : [
        {
          id: 'book-1',
          ...legacyPoseToTransform({
            shelf: 'middle',
            x: 0.38,
            orientation: 'front',
            tilt: 0,
          }),
          theme: 0,
        },
      ],
  nextId: savedState ? savedState.nextId : 2,
  shelfWidth: initialShelfWidth,
};

const stage = document.querySelector('#stage');
const addDock = document.querySelector('#add-dock');
const addButton = document.querySelector('#add-book');
const addMenu = document.querySelector('#add-menu');
const importEpubBtn = document.querySelector('#import-epub-btn');
const importEpubTitle = document.querySelector('#import-epub-title');
const importEpubHint = document.querySelector('#import-epub-hint');
const epubInput = document.querySelector('#epub-input');
const curtain = document.querySelector('#curtain');

let renderer;
let scene;
let camera;
let controls;
let timer;
let bookRoot;
let shadowRoot;
let physics;
let bookViewer3D;
let drag = null;
let hoveredId = null;
let isOrbiting = false;
let dirtySave = false;
let lastSaveTime = 0;

let readingFreeze = null;

const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -BOOK.z);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const runtimes = new Map();
const shelfMeshes = [];
const shelfBodies = [];
const sideRails = [];
let topBoard;

const textures = {};
const shared = {};
const geometry = {};
const clothMaterials = new Map();

function syncStateFromPhysics() {
  for (const book of state.books) {
    const runtime = runtimes.get(book.id);
    if (!runtime) continue;
    const { position, quaternion } = runtime.body;
    book.xNorm = Number(xToNorm(position.x).toFixed(4));
    book.y = Number(position.y.toFixed(4));
    book.z = Number(position.z.toFixed(4));
    book.q = [
      Number(quaternion.x.toFixed(5)),
      Number(quaternion.y.toFixed(5)),
      Number(quaternion.z.toFixed(5)),
      Number(quaternion.w.toFixed(5)),
    ];
  }
}

function saveState() {
  syncStateFromPhysics();
  try {
    const serializedBooks = state.books.map((b) => {
      const { chapters, ...rest } = b;
      return rest;
    });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ books: serializedBooks, nextId: state.nextId })
    );
  } catch {
    
  }
}

function bookById(id) {
  return state.books.find((book) => book.id === id);
}

function makeCanvasTexture(width, height, draw, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  draw(context, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = options.wrap || THREE.RepeatWrapping;
  texture.repeat.set(...(options.repeat || [1, 1]));
  texture.colorSpace = options.colorSpace || THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function createWallTexture() {
  return makeCanvasTexture(
    512,
    512,
    (context, width, height) => {
      const image = context.createImageData(width, height);
      const data = image.data;

      for (let i = 0; i < data.length; i += 4) {
        const grain = (Math.random() - 0.5) * 13;
        data[i] = 230 + grain;
        data[i + 1] = 217 + grain;
        data[i + 2] = 198 + grain;
        data[i + 3] = 255;
      }

      context.putImageData(image, 0, 0);

      for (let i = 0; i < 80; i++) {
        const x = Math.random() * width;
        const y = Math.random() * height;
        const radius = 10 + Math.random() * 70;
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        const warm = Math.random() > 0.5;
        gradient.addColorStop(0, warm ? 'rgba(255, 245, 226, 0.035)' : 'rgba(110, 78, 48, 0.028)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        context.fillStyle = gradient;
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
    },
    { repeat: [4, 3] }
  );
}

function createWallBump() {
  return makeCanvasTexture(
    256,
    256,
    (context, width, height) => {
      const image = context.createImageData(width, height);
      const data = image.data;

      for (let i = 0; i < data.length; i += 4) {
        const value = 128 + (Math.random() - 0.5) * 40;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 255;
      }

      context.putImageData(image, 0, 0);
    },
    { repeat: [4, 3], colorSpace: THREE.NoColorSpace }
  );
}

function createClothBump() {
  return makeCanvasTexture(
    256,
    256,
    (context, width, height) => {
      context.fillStyle = '#808080';
      context.fillRect(0, 0, width, height);

      for (let x = 0; x < width; x += 3) {
        context.fillStyle = x % 6 === 0 ? 'rgba(255,255,255,0.11)' : 'rgba(0,0,0,0.09)';
        context.fillRect(x, 0, 1, height);
      }

      for (let y = 0; y < height; y += 3) {
        context.fillStyle = y % 6 === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.1)';
        context.fillRect(0, y, width, 1);
      }
    },
    { repeat: [3, 3], colorSpace: THREE.NoColorSpace }
  );
}

function createPageTexture() {
  return makeCanvasTexture(
    256,
    512,
    (context, width, height) => {
      context.fillStyle = '#e8ddc7';
      context.fillRect(0, 0, width, height);

      for (let y = 0; y < height; y += 2) {
        const alpha = 0.02 + Math.random() * 0.09;
        context.fillStyle = `rgba(94, 69, 42, ${alpha})`;
        context.fillRect(0, y, width, 1);
      }

      for (let i = 0; i < 900; i++) {
        context.fillStyle = `rgba(255, 250, 236, ${Math.random() * 0.08})`;
        context.fillRect(Math.random() * width, Math.random() * height, 1, 1);
      }
    },
    { repeat: [1, 3] }
  );
}

function createShadowTexture() {
  return makeCanvasTexture(
    256,
    256,
    (context, width, height) => {
      context.clearRect(0, 0, width, height);
      const gradient = context.createRadialGradient(
        width / 2,
        height / 2,
        width * 0.04,
        width / 2,
        height / 2,
        width * 0.48
      );
      gradient.addColorStop(0, 'rgba(30, 18, 8, 0.62)');
      gradient.addColorStop(0.45, 'rgba(30, 18, 8, 0.34)');
      gradient.addColorStop(1, 'rgba(30, 18, 8, 0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    },
    { wrap: THREE.ClampToEdgeWrapping, colorSpace: THREE.NoColorSpace }
  );
}

function createFallbackWoodTexture() {
  return makeCanvasTexture(
    512,
    256,
    (context, width, height) => {
      context.fillStyle = '#c59f76';
      context.fillRect(0, 0, width, height);

      for (let y = 0; y < height; y += 2) {
        const alpha = 0.03 + Math.random() * 0.08;
        context.fillStyle = y % 4 === 0 ? `rgba(88, 54, 28, ${alpha})` : `rgba(245, 222, 192, ${alpha * 0.7})`;
        context.fillRect(0, y, width, 2);
      }
    },
    { wrap: THREE.MirroredRepeatWrapping, repeat: [2, 1] }
  );
}

async function buildTextures() {
  textures.wall = createWallTexture();
  textures.wallBump = createWallBump();
  textures.clothBump = createClothBump();
  textures.pages = createPageTexture();
  textures.shadow = createShadowTexture();

  const loader = new THREE.TextureLoader();
  try {
    textures.wood = await loader.loadAsync('./assets/wood.jpg');
  } catch {
    textures.wood = createFallbackWoodTexture();
  }
  textures.wood.colorSpace = THREE.SRGBColorSpace;
  textures.wood.wrapS = textures.wood.wrapT = THREE.MirroredRepeatWrapping;
  textures.wood.repeat.set(2, 1);
  textures.wood.anisotropy = 8;

  textures.woodBump = textures.wood.clone();
  textures.woodBump.colorSpace = THREE.NoColorSpace;
  textures.woodBump.needsUpdate = true;
}

function buildMaterials() {
  shared.gold = new THREE.MeshPhysicalMaterial({
    color: 0xd6b678,
    metalness: 1,
    roughness: 0.23,
    clearcoat: 0.2,
    clearcoatRoughness: 0.25,
    envMapIntensity: 1.6,
  });

  shared.paper = new THREE.MeshStandardMaterial({
    color: 0xe9dcc4,
    roughness: 0.92,
    metalness: 0,
  });

  shared.pages = new THREE.MeshStandardMaterial({
    map: textures.pages,
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0,
  });

  shared.ribbon = new THREE.MeshPhysicalMaterial({
    color: 0xb64d34,
    roughness: 0.56,
    metalness: 0,
    sheen: 0.4,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0xe3a88a),
    side: THREE.DoubleSide,
  });

  shared.wood = new THREE.MeshStandardMaterial({
    map: textures.wood,
    bumpMap: textures.woodBump,
    bumpScale: 0.012,
    roughness: 0.52,
    metalness: 0.02,
  });

  shared.wall = new THREE.MeshStandardMaterial({
    map: textures.wall,
    bumpMap: textures.wallBump,
    bumpScale: 0.025,
    roughness: 0.96,
    metalness: 0,
  });

  shared.shadow = new THREE.MeshBasicMaterial({
    map: textures.shadow,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    toneMapped: false,
  });
}

function getClothMaterials(index, customPalette = null) {
  const theme =
    customPalette && customPalette.cloth
      ? customPalette
      : THEMES[(index ?? 0) % THEMES.length];
  if (clothMaterials.has(theme.cloth)) return clothMaterials.get(theme.cloth);

  const cover = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.cloth),
    roughness: 0.71,
    metalness: 0,
    sheen: 0.55,
    sheenRoughness: 0.82,
    sheenColor: new THREE.Color(theme.sheen || '#d8ccb8'),
    bumpMap: textures.clothBump,
    bumpScale: 0.003,
    clearcoat: 0.04,
    clearcoatRoughness: 0.6,
    envMapIntensity: 0.75,
  });

  const spine = cover.clone();
  spine.color.set(theme.dark || theme.cloth);
  spine.envMapIntensity = 0.6;

  const materials = { cover, spine };
  clothMaterials.set(theme.cloth, materials);
  return materials;
}

function createRibbonGeometry() {
  const width = 0.046;
  const length = 0.2;
  const notch = 0.018;
  const shape = new THREE.Shape();

  shape.moveTo(-width / 2, 0);
  shape.lineTo(width / 2, 0);
  shape.lineTo(width / 2, -length);
  shape.lineTo(0, -length + notch);
  shape.lineTo(-width / 2, -length);
  shape.closePath();

  return new THREE.ShapeGeometry(shape);
}

function createCurvedSpineArtGeometry() {
  const geo = new THREE.PlaneGeometry(1, BOOK.h - 0.022, 18, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i); 
    const arch = Math.cos(x * Math.PI); 
    pos.setZ(i, arch);
  }
  geo.computeVertexNormals();
  return geo;
}

function buildGeometry() {
  geometry.cover = new RoundedBoxGeometry(BOOK.w, BOOK.h, BOOK.cover, 4, 0.012);
  geometry.pages = new RoundedBoxGeometry(
    BOOK.w - 0.06,
    BOOK.h - 0.045,
    BOOK.t - 0.04,
    3,
    0.006
  );
  geometry.spine = new RoundedBoxGeometry(BOOK.cover + 0.006, BOOK.h, BOOK.t, 4, 0.01);
  geometry.headband = new THREE.BoxGeometry(0.016, 0.016, 1);
  geometry.band = new THREE.BoxGeometry(BOOK.cover + 0.012, 0.008, BOOK.t + 0.004);
  geometry.frameH = new THREE.BoxGeometry(BOOK.w - 0.15, 0.007, 0.003);
  geometry.frameV = new THREE.BoxGeometry(0.007, BOOK.h - 0.19, 0.003);
  geometry.labelBack = new THREE.BoxGeometry(0.36, 0.24, 0.004);
  geometry.label = new THREE.BoxGeometry(0.32, 0.2, 0.004);
  geometry.rule = new THREE.BoxGeometry(0.11, 0.004, 0.002);
  geometry.diamond = new THREE.OctahedronGeometry(0.012, 0);
  geometry.ribbon = createRibbonGeometry();
  geometry.spineLabelBack = new THREE.BoxGeometry(0.004, 0.18, 0.12);
  geometry.spineLabel = new THREE.BoxGeometry(0.003, 0.155, 0.095);
  geometry.coverArt = new THREE.PlaneGeometry(BOOK.w - 0.022, BOOK.h - 0.022);
  geometry.spineArt = createCurvedSpineArtGeometry();
  geometry.board = new RoundedBoxGeometry(1, SHELF.thickness, SHELF.depth, 5, 0.03);
  geometry.shadow = new THREE.PlaneGeometry(1, 1);
}

function buildRoom() {
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), shared.wall);
  wall.position.set(0, 2.5, -0.72);
  wall.receiveShadow = true;
  scene.add(wall);

  bookRoot = new THREE.Group();
  shadowRoot = new THREE.Group();
  scene.add(bookRoot, shadowRoot);

  physics = new PhysicsWorld();

  for (const shelf of SHELVES) {
    const board = new THREE.Mesh(geometry.board, shared.wood);
    board.scale.x = state.shelfWidth;
    board.position.set(0, SHELF_Y[shelf], 0);
    board.castShadow = true;
    board.receiveShadow = true;
    scene.add(board);
    shelfMeshes.push({ shelf, mesh: board });

    const shelfBody = createRigidBody({
      id: `shelf-${shelf}`,
      halfExtents: new THREE.Vector3(
        state.shelfWidth / 2,
        SHELF.thickness / 2,
        SHELF.depth / 2
      ),
      position: new THREE.Vector3(0, SHELF_Y[shelf], 0),
      isStatic: true,
      friction: 0.65,
      restitution: 0.04,
      tag: 'shelf',
      shelfName: shelf,
    });
    physics.addShelf(shelfBody);
    shelfBodies.push(shelfBody);
  }

  const frameBottom = SHELF_Y.bottom - SHELF.thickness / 2;
  const height = FRAME_TOP + SHELF.thickness / 2 - frameBottom;
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      new RoundedBoxGeometry(SHELF.thickness, height, SHELF.depth, 5, 0.03), shared.wood
    );
    rail.position.set(side * (state.shelfWidth / 2 + SHELF.thickness / 2), frameBottom + height / 2, 0);
    rail.castShadow = rail.receiveShadow = true;
    scene.add(rail);
    sideRails.push(rail);
  }
  topBoard = new THREE.Mesh(geometry.board, shared.wood);
  topBoard.scale.x = state.shelfWidth + 2 * SHELF.thickness;
  topBoard.position.set(0, FRAME_TOP, 0);
  topBoard.castShadow = topBoard.receiveShadow = true;
  scene.add(topBoard);
  updatePhysicsBounds();
}

function updatePhysicsBounds() {
  physics.setBounds({
    minX: -state.shelfWidth / 2, maxX: state.shelfWidth / 2,
    minY: shelfTop('bottom'), maxY: FRAME_TOP - SHELF.thickness / 2,
    depth: SHELF.depth, thickness: SHELF.thickness, backZ: -0.72,
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
    canvas.width = 1024;
    canvas.height = 512;
    const context = canvas.getContext('2d');

    const base = context.createLinearGradient(0, 0, 0, 512);
    base.addColorStop(0, '#fff9ee');
    base.addColorStop(0.4, '#f6e8d4');
    base.addColorStop(0.58, '#dcc6aa');
    base.addColorStop(1, '#6f5238');
    context.fillStyle = base;
    context.fillRect(0, 0, 1024, 512);

    const windowGlow = context.createRadialGradient(265, 180, 20, 265, 180, 310);
    windowGlow.addColorStop(0, 'rgba(255, 252, 240, 1)');
    windowGlow.addColorStop(0.35, 'rgba(255, 239, 208, 0.55)');
    windowGlow.addColorStop(1, 'rgba(255, 239, 208, 0)');
    context.fillStyle = windowGlow;
    context.fillRect(0, 0, 1024, 512);

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

function fitCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const sceneHeight = FRAME_TOP - SHELF_Y.bottom + 1.1;
  const distanceH =
    (state.shelfWidth / 2 + 0.55) / (Math.tan(fov / 2) * Math.max(aspect, 0.2));
  const distanceV = (sceneHeight / 2) / Math.tan(fov / 2);
  const distance = Math.max(distanceH, distanceV) * 1.04;
  const target = new THREE.Vector3(0, (FRAME_TOP + SHELF_Y.bottom) / 2, 0);
  const direction = new THREE.Vector3(0.08, 0.25, 1).normalize();

  controls.target.copy(target);
  camera.position.copy(target).addScaledVector(direction, distance);
  controls.minDistance = distance * 0.82;
  controls.maxDistance = distance * 1.24;
  controls.update();
}

function setupCamera() {
  camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0.8, 4.7, 9.6);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.rotateSpeed = 0.42;
  controls.zoomSpeed = 0.65;
  controls.minPolarAngle = 1.15;
  controls.maxPolarAngle = 1.52;
  controls.minAzimuthAngle = -0.46;
  controls.maxAzimuthAngle = 0.46;
  controls.target.set(0, 2.28, 0);
  controls.update();
}

function createBookVisual(book) {
  const t = clamp(Number(book.thickness) || BOOK.t, 0.08, 0.45);
  const cloth = getClothMaterials(book.theme, book.palette);
  const group = new THREE.Group();
  group.userData.bookId = book.id;
  const disposables = [];

  const coverArt = { texture: null };

  const spineArt = { canvas: null, texture: null };

  const addMesh = (mesh, cast = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  const coverScaleZ = clamp(t / BOOK.t, 0.56, 1.14);
  const coverT = BOOK.cover * coverScaleZ;

  const pagesMesh = addMesh(new THREE.Mesh(geometry.pages, shared.pages));
  pagesMesh.scale.z = Math.max(0.18, (t - coverT * 1.65) / (BOOK.t - 0.04));

  const front = addMesh(new THREE.Mesh(geometry.cover, cloth.cover));
  front.scale.z = coverScaleZ;
  front.position.z = t / 2 - coverT / 2;

  const back = addMesh(new THREE.Mesh(geometry.cover, cloth.cover));
  back.scale.z = coverScaleZ;
  back.position.z = -t / 2 + coverT / 2;

  const spine = addMesh(new THREE.Mesh(geometry.spine, cloth.spine));
  spine.position.x = -BOOK.w / 2 + (BOOK.cover + 0.006) / 2;
  spine.scale.z = Math.max(0.32, (t - 0.006) / BOOK.t);

  const headbandSpan = Math.max(0.03, t - coverT * 1.9);
  for (const dirY of [1, -1]) {
    const hb = addMesh(new THREE.Mesh(geometry.headband, shared.gold), false);
    hb.scale.z = headbandSpan;
    hb.position.set(-BOOK.w / 2 + 0.022, dirY * (BOOK.h / 2 - 0.022), 0);
  }

  const archDepth =
    t < 0.13
      ? clamp(t * 0.02, 0.0018, 0.004)
      : t >= 0.25
        ? clamp(t * 0.055, 0.014, 0.024)
        : clamp(t * 0.045, 0.005, 0.014);

  if (book.coverDataUrl) {
    
    const coverMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0,
      sheen: 0.35,
      sheenRoughness: 0.8,
      bumpMap: textures.clothBump,
      bumpScale: 0.0018,
      clearcoat: 0.08,
      clearcoatRoughness: 0.5,
      envMapIntensity: 0.72,
    });
    disposables.push(coverMaterial);

    const img = new Image();
    img.onload = () => {
      const tex = new THREE.CanvasTexture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      coverMaterial.map = tex;
      coverMaterial.needsUpdate = true;
      coverArt.texture = tex;
      disposables.push(tex);
    };
    img.src = book.coverDataUrl;

    const coverArtMesh = addMesh(new THREE.Mesh(geometry.coverArt, coverMaterial), false);
    coverArtMesh.position.set(0.004, 0, t / 2 + 0.0012);

    const spineCanvas = renderSpineCanvas({
      title: book.title,
      author: book.author,
      palette: book.palette || THEMES[(book.theme ?? 0) % THEMES.length],
      thickness: t,
    });
    const spineTex = new THREE.CanvasTexture(spineCanvas);
    spineTex.colorSpace = THREE.SRGBColorSpace;
    spineTex.anisotropy = 4;
    spineTex.needsUpdate = true;
    spineArt.canvas = spineCanvas;
    spineArt.texture = spineTex;

    const spineMat = new THREE.MeshPhysicalMaterial({
      map: spineTex,
      roughness: 0.66,
      metalness: 0,
      bumpMap: textures.clothBump,
      bumpScale: 0.002,
      envMapIntensity: 0.68,
    });
    disposables.push(spineTex, spineMat);

    const spineArtMesh = addMesh(new THREE.Mesh(geometry.spineArt, spineMat), false);
    spineArtMesh.scale.set(Math.max(0.055, t - 0.008), 1, archDepth);
    spineArtMesh.position.set(-BOOK.w / 2 + 0.001, 0, 0);
    spineArtMesh.rotation.y = -Math.PI / 2;
  } else {
    
    for (const y of [BOOK.h / 2 - 0.18, -BOOK.h / 2 + 0.18]) {
      const band = addMesh(new THREE.Mesh(geometry.band, shared.gold), false);
      band.position.set(-BOOK.w / 2 + (BOOK.cover + 0.004) / 2, y, 0);
      band.scale.z = (t + 0.002) / (BOOK.t + 0.004);
    }

    const frameZ = t / 2 + 0.0015;
    const frameY = BOOK.h / 2 - 0.09;
    const frameX = BOOK.w / 2 - 0.09;

    for (const y of [frameY, -frameY]) {
      const bar = addMesh(new THREE.Mesh(geometry.frameH, shared.gold), false);
      bar.position.set(0, y, frameZ);
    }

    for (const x of [frameX, -frameX]) {
      const bar = addMesh(new THREE.Mesh(geometry.frameV, shared.gold), false);
      bar.position.set(x, 0, frameZ);
    }

    const labelBack = addMesh(new THREE.Mesh(geometry.labelBack, shared.gold), false);
    labelBack.position.set(0, 0.02, t / 2 + 0.003);

    const label = addMesh(new THREE.Mesh(geometry.label, shared.paper), false);
    label.position.set(0, 0.02, t / 2 + 0.006);

    const rule = addMesh(new THREE.Mesh(geometry.rule, shared.gold), false);
    rule.position.set(0, 0.055, t / 2 + 0.007);

    const diamond = addMesh(new THREE.Mesh(geometry.diamond, shared.gold), false);
    diamond.position.set(0, -0.025, t / 2 + 0.009);
    diamond.scale.set(1, 1, 0.3);

    const labelScaleZ = clamp((t - 0.03) / 0.12, 0.35, 1.45);
    const spineLabelBack = addMesh(new THREE.Mesh(geometry.spineLabelBack, shared.gold), false);
    spineLabelBack.scale.z = labelScaleZ;
    spineLabelBack.position.set(-BOOK.w / 2 - 0.002, 0.26, 0);

    const spineLabel = addMesh(new THREE.Mesh(geometry.spineLabel, shared.paper), false);
    spineLabel.scale.z = labelScaleZ;
    spineLabel.position.set(-BOOK.w / 2 - 0.004, 0.26, 0);
  }

  const ribbonZ = clamp(t / 2 - 0.04, 0.0, t / 2 - 0.015);
  const ribbon = addMesh(new THREE.Mesh(geometry.ribbon, shared.ribbon), false);
  ribbon.position.set(0.14, -BOOK.h / 2 + 0.004, ribbonZ);
  ribbon.rotation.x = -Math.PI / 2;

  const shadowMaterial = shared.shadow.clone();
  const shadow = new THREE.Mesh(geometry.shadow, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 2;

  return { group, shadow, ribbon, thickness: t, coverArt, spineArt, disposables };
}

function addBookRuntime(book, animateIn) {
  const t = clamp(Number(book.thickness) || BOOK.t, 0.08, 0.45);
  book.thickness = t;

  const visual = createBookVisual(book);
  const pos = new THREE.Vector3(
    mapX(book.xNorm),
    book.y,
    Number.isFinite(book.z) ? book.z : BOOK.z
  );
  const quat = new THREE.Quaternion(...(book.q || [0, 0, 0, 1])).normalize();

  const body = createRigidBody({
    id: book.id,
    halfExtents: new THREE.Vector3(BOOK.w / 2, BOOK.h / 2, t / 2),
    position: pos,
    quaternion: quat,
    mass: clamp(t / BOOK.t, 0.55, 2.2),
    friction: 0.48,
    restitution: 0.06,
    tag: 'book',
  });

  if (animateIn) {
    body.linearVelocity.set(0, -0.9, 0);
    body.angularVelocity.z = (Math.random() - 0.5) * 0.45;
  }

  physics.addBody(body);

  const runtime = {
    ...visual,
    body,
    
    bookW: BOOK.w,
    bookH: BOOK.h,
  };

  bookRoot.add(visual.group);
  shadowRoot.add(visual.shadow);
  runtimes.set(book.id, runtime);

  runtime.group.position.copy(body.position);
  runtime.group.quaternion.copy(body.quaternion);
  runtime.group.scale.setScalar(1);
  updateBookVisualDetails(runtime, 0.016);
}

function computeWorldHalfExtents(body) {
  const ux = body.axes[0];
  const uy = body.axes[1];
  const uz = body.axes[2];
  const hx = body.extentsArray[0];
  const hy = body.extentsArray[1];
  const hz = body.extentsArray[2];

  return {
    halfW: Math.abs(ux.x) * hx + Math.abs(uy.x) * hy + Math.abs(uz.x) * hz,
    halfH: Math.abs(ux.y) * hx + Math.abs(uy.y) * hy + Math.abs(uz.y) * hz,
    halfD: Math.abs(ux.z) * hx + Math.abs(uy.z) * hy + Math.abs(uz.z) * hz,
  };
}

function updateBookVisualDetails(runtime, delta) {
  const { body, shadow, ribbon } = runtime;
  const { halfW, halfH, halfD } = computeWorldHalfExtents(body);
  const bottomY = body.position.y - halfH;
  const shelfLimitX = state.shelfWidth / 2 + halfW * 0.35;

  let bestShelf = null;
  let bestShelfTop = -Infinity;

  if (Math.abs(body.position.x) <= shelfLimitX) {
    for (const shelf of SHELVES) {
      const top = shelfTop(shelf);
      if (top <= bottomY + 0.14 && top > bestShelfTop) {
        bestShelfTop = top;
        bestShelf = shelf;
      }
    }
  }

  const gap = bestShelf ? Math.max(0, bottomY - bestShelfTop) : Infinity;

  if (ribbon) {
    const bookT = runtime.thickness || BOOK.t;
    const uprightness = body.axes[1].y;
    const onShelfBottom = bestShelf && gap < 0.05 && uprightness > 0.65;
    const targetRotX = onShelfBottom ? -Math.PI / 2 : -0.15;
    const targetPosY = onShelfBottom ? -BOOK.h / 2 + 0.004 : -BOOK.h / 2 + 0.05;
    const targetPosZ = onShelfBottom ? clamp(bookT / 2 - 0.04, 0, bookT / 2 - 0.015) : 0.01;

    ribbon.rotation.x = THREE.MathUtils.damp(ribbon.rotation.x, targetRotX, 14, delta);
    ribbon.position.y = THREE.MathUtils.damp(ribbon.position.y, targetPosY, 14, delta);
    ribbon.position.z = THREE.MathUtils.damp(ribbon.position.z, targetPosZ, 14, delta);
  }

  if (!bestShelf || gap > 1.35) {
    shadow.visible = false;
    return;
  }

  shadow.visible = true;
  const fade = clamp(1 - gap / 1.35, 0, 1);
  shadow.material.opacity = 0.56 * fade * fade;
  shadow.position.set(body.position.x, bestShelfTop + 0.004, body.position.z);

  const spread = 1 + gap * 0.32;
  shadow.scale.set(
    Math.max(0.28, halfW * 2.25 * spread),
    Math.max(0.28, halfD * 3.1 * spread),
    1
  );
}

function removeBook(id) {
  const runtime = runtimes.get(id);
  if (runtime) {
    if (readingFreeze && readingFreeze.runtime === runtime) readingFreeze = null;
    bookRoot.remove(runtime.group);
    shadowRoot.remove(runtime.shadow);
    runtime.shadow.material.dispose();
    if (runtime.disposables) {
      for (const item of runtime.disposables) {
        if (item && typeof item.dispose === 'function') item.dispose();
      }
    }
    physics.removeBody(runtime.body);
    runtimes.delete(id);
  }

  const index = state.books.findIndex((book) => book.id === id);
  if (index !== -1) state.books.splice(index, 1);

  if (drag && drag.id === id) {
    drag = null;
    controls.enabled = true;
    renderer.domElement.classList.remove('is-grabbing');
    renderer.domElement.style.cursor = 'grab';
  }

  saveState();
}

function updateBooks(delta, elapsed) {
  const freezeActive =
    readingFreeze && bookViewer3D && bookViewer3D.isOpen;
  
  if (readingFreeze && !freezeActive) {
    physics.setFrozen(readingFreeze.runtime.body, false);
    readingFreeze = null;
  }
  physics.step(delta);

  let anyActive = false;

  for (const book of state.books) {
    const runtime = runtimes.get(book.id);
    if (!runtime) continue;

    const { body, group } = runtime;

    if (freezeActive && readingFreeze.runtime === runtime) {
      const f = readingFreeze;
      group.position.copy(f.visualPos);
      group.quaternion.copy(f.visualQuat);
      group.scale.setScalar(1);
      group.visible = false;
      
      runtime.shadow.visible = false;
      continue;
    }

    group.position.copy(body.renderPosition);
    group.quaternion.copy(body.renderQuaternion);
    group.scale.setScalar(1);

    updateBookVisualDetails(runtime, delta);

    if (!body.sleeping) {
      anyActive = true;
      dirtySave = true;
    }

  }

  if (dirtySave && (!anyActive || elapsed - lastSaveTime > 1.2)) {
    saveState();
    dirtySave = false;
    lastSaveTime = elapsed;
  }
}

function updatePointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickBook(event) {
  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(bookRoot.children, true);
  for (const hit of hits) {
    let object = hit.object;
    while (object && !object.userData.bookId) object = object.parent;
    if (object?.userData.bookId) {
      return { id: object.userData.bookId, point: hit.point };
    }
  }

  return null;
}

function pointOnDragPlane(event) {
  if (event) updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  const point = new THREE.Vector3();
  return raycaster.ray.intersectPlane(dragPlane, point) ? point : null;
}

function startDrag(id, hitPoint, event) {
  const runtime = runtimes.get(id);
  if (!runtime) return;

  dragPlane.constant = -hitPoint.z;

  physics.startGrab(runtime.body, hitPoint);

  drag = {
    id,
    runtime,
    pointerId: event.pointerId,
    anchorZ: hitPoint.z,
    depthKeys: new Set(),
  };

  dirtySave = true;
  controls.enabled = false;
  try {
    renderer.domElement.setPointerCapture(event.pointerId);
  } catch {}
  renderer.domElement.classList.add('is-grabbing');
  renderer.domElement.style.cursor = 'grabbing';
}

let pendingClick = null;

function openBookById(bookId) {
  const book = state.books.find((b) => b.id === bookId);
  const runtime = runtimes.get(bookId);
  if (!book || !runtime || !bookViewer3D) return;
  if (bookViewer3D.isOpen) return;

  const body = runtime.body;
  runtime.group.scale.setScalar(1);
  runtime.shadow.visible = false;
  readingFreeze = {
    runtime,
    pos: body.position.clone(),
    visualPos: runtime.group.position.clone(),
    visualQuat: runtime.group.quaternion.clone(),
  };

  physics.teleport(body, readingFreeze.visualPos, readingFreeze.visualQuat);
  readingFreeze.pos.copy(body.position);
  physics.setFrozen(body, true);

  if (!book.palette?.cloth) {
    book.palette = THEMES[(book.theme ?? 0) % THEMES.length];
  }

  let chaptersPromise = null;
  if (!book.chapters) {
    chaptersPromise = loadBookChaptersFromStorage(bookId)
      .then((cached) => {
        if (cached && !book.chapters) book.chapters = cached;
        return book.chapters || cached;
      })
      .catch(() => null);
  }

  bookViewer3D.openBook(runtime, book, chaptersPromise);
}

function prefetchBookChapters() {
  
  const pending = state.books.filter((book) => !book.chapters).slice(0, 3);
  const step = (index) => {
    if (index >= pending.length) return;
    const book = pending[index];
    loadBookChaptersFromStorage(book.id)
      .then((chapters) => {
        if (chapters && !book.chapters) book.chapters = chapters;
      })
      .catch(() => {})
      .finally(() => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => step(index + 1));
        } else {
          setTimeout(() => step(index + 1), 0);
        }
      });
  };
  step(0);
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  if (bookViewer3D && bookViewer3D.isOpen) return;

  closeAddMenu();

  const hit = pickBook(event);
  if (!hit) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  pendingClick = {
    bookId: hit.id,
    startX: event.clientX,
    startY: event.clientY,
    startTime: performance.now(),
    moved: false,
  };

  startDrag(hit.id, hit.point, event);
}

function onPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;

  if (pendingClick && !pendingClick.moved) {
    const dist = Math.hypot(
      event.clientX - pendingClick.startX,
      event.clientY - pendingClick.startY
    );
    if (dist > 5) {
      pendingClick.moved = true;
    }
  }

  updateDragTarget(pointOnDragPlane(event));
}

function updateDragTarget(point) {
  if (!point || !drag) return;

  const maxX = state.shelfWidth / 2;
  point.x = clamp(point.x, -maxX, maxX);
  point.y = clamp(point.y, shelfTop('bottom'), FRAME_TOP - SHELF.thickness / 2);
  point.z = drag.anchorZ;

  physics.updateGrabTarget(point);
}

function updateDragDepth(delta) {
  if (!drag) return;
  const direction = Number(drag.depthKeys.has('KeyS')) - Number(drag.depthKeys.has('KeyW'));
  if (!direction) return;
  drag.anchorZ = clamp(drag.anchorZ + direction * 0.9 * delta, -0.5, 1.5);
  dragPlane.constant = -drag.anchorZ;
  updateDragTarget(pointOnDragPlane());
}

function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;

  const isClick =
    pendingClick &&
    !pendingClick.moved &&
    performance.now() - pendingClick.startTime < 450;
  const clickBookId = isClick ? pendingClick.bookId : null;
  pendingClick = null;

  const { pointerId } = drag;
  if (renderer.domElement.hasPointerCapture(pointerId)) {
    try {
      renderer.domElement.releasePointerCapture(pointerId);
    } catch {}
  }

  physics.endGrab();
  drag = null;
  dirtySave = true;

  controls.enabled = true;
  renderer.domElement.classList.remove('is-grabbing');
  renderer.domElement.style.cursor = hoveredId ? 'pointer' : 'grab';

  if (clickBookId) {
    openBookById(clickBookId);
  }
}

function onWheel(event) {
  if (!drag) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    physics.addGrabSpin(-delta * 0.015, 'y');
  } else if (event.altKey) {
    physics.addGrabSpin(-event.deltaY * 0.015, 'x');
  } else {
    physics.addGrabSpin(-event.deltaY * 0.015, 'z');
  }
}

function onHover(event) {
  if (drag || (bookViewer3D && bookViewer3D.isOpen)) return;
  const hit = pickBook(event);
  hoveredId = hit ? hit.id : null;
  if (!isOrbiting) {
    renderer.domElement.style.cursor = hoveredId ? 'pointer' : 'grab';
  }
}

function findSpawnSpot() {
  const shelfOrder = ['middle', 'top', 'bottom'];

  for (const shelf of shelfOrder) {
    const sTop = shelfTop(shelf);
    for (const candidateNorm of SLOTS) {
      const candidateX = mapX(candidateNorm);
      const occupied = state.books.some((book) => {
        const runtime = runtimes.get(book.id);
        const bx = runtime ? runtime.body.position.x : mapX(book.xNorm);
        const by = runtime ? runtime.body.position.y : book.y;
        return Math.abs(by - (sTop + BOOK.h / 2)) < 0.75 && Math.abs(bx - candidateX) < 0.72;
      });
      if (!occupied) {
        return { shelf, xNorm: candidateNorm };
      }
    }
  }

  const fallbackShelf = shelfOrder[state.books.length % shelfOrder.length];
  const fallbackSlot = SLOTS[state.books.length % SLOTS.length];
  return { shelf: fallbackShelf, xNorm: clamp(fallbackSlot + (Math.random() - 0.5) * 0.08, 0.1, 0.9) };
}

function addEpubBook(epubData) {
  if (!bookRoot || !epubData) return;

  const { shelf, xNorm } = findSpawnSpot();
  const dropHeight = shelfTop(shelf) + BOOK.h / 2 + 0.28;
  const initialTilt = THREE.MathUtils.degToRad((Math.random() - 0.5) * 3.2);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, initialTilt));
  const thickness = clamp(
    Number(epubData.thickness) || computeBookThickness(epubData.pages || 260),
    0.08,
    0.45
  );

  const book = {
    id: `book-${state.nextId++}`,
    xNorm,
    y: dropHeight,
    z: BOOK.z,
    q: [q.x, q.y, q.z, q.w],
    theme: state.books.length % THEMES.length,
    thickness,
    pages: epubData.pages || 260,
    title: epubData.title || '',
    author: epubData.author || '',
    palette: epubData.palette || null,
    coverDataUrl: epubData.coverDataUrl || null,
    chapters: epubData.chapters || null,
  };

  if (epubData.chapters && epubData.chapters.length > 0) {
    saveBookChaptersToStorage(book.id, epubData.chapters);
  }

  state.books.push(book);
  addBookRuntime(book, true);
  dirtySave = true;
  saveState();
}

let isMenuOpen = false;

function openAddMenu() {
  if (!addMenu || !addButton) return;
  isMenuOpen = true;
  addMenu.hidden = false;
  requestAnimationFrame(() => {
    addMenu.classList.add('is-open');
  });
  addButton.classList.add('is-open');
  addButton.setAttribute('aria-expanded', 'true');
}

function closeAddMenu() {
  if (!addMenu || !addButton || !isMenuOpen) return;
  isMenuOpen = false;
  addMenu.classList.remove('is-open');
  addButton.classList.remove('is-open');
  addButton.setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    if (!isMenuOpen && addMenu) addMenu.hidden = true;
  }, 200);
}

function toggleAddMenu(event) {
  if (event) {
    event.stopPropagation();
  }
  if (isMenuOpen) {
    closeAddMenu();
  } else {
    openAddMenu();
  }
}

async function handleEpubFiles(fileList) {
  const files = Array.from(fileList || []).filter(
    (file) => file && (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip')
  );
  if (!files.length) return;

  const origTitle = importEpubTitle?.textContent || '';
  const origDesc = importEpubHint?.textContent || '';

  if (importEpubBtn) importEpubBtn.classList.add('is-loading');
  if (importEpubTitle) importEpubTitle.textContent = '';

  try {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (importEpubHint) {
        importEpubHint.textContent =
          '';
      }
      const epubData = await parseEpubFile(file);
      addEpubBook(epubData);
    }
  } catch (err) {
    console.error(err);
  } finally {
    if (importEpubBtn) importEpubBtn.classList.remove('is-loading');
    if (importEpubTitle) importEpubTitle.textContent = origTitle;
    if (importEpubHint) importEpubHint.textContent = origDesc;
    closeAddMenu();
  }
}

function handleResize() {
  const prevWidth = state.shelfWidth;
  const width = computeShelfWidth();
  const widthChanged = width !== prevWidth;
  state.shelfWidth = width;

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);

  if (widthChanged) {
    for (const entry of shelfMeshes) entry.mesh.scale.x = width;
    sideRails.forEach((rail, i) => {
      rail.position.x = (i === 0 ? -1 : 1) * (width / 2 + SHELF.thickness / 2);
    });
    topBoard.scale.x = width + 2 * SHELF.thickness;
    for (const shelfBody of shelfBodies) {
      setBodyHalfExtents(shelfBody, width / 2, SHELF.thickness / 2, SHELF.depth / 2);
    }

    for (const book of state.books) {
      const runtime = runtimes.get(book.id);
      if (!runtime || (drag && drag.id === book.id)) continue;
      const nextX = mapX(book.xNorm, width);

      if (readingFreeze && readingFreeze.runtime === runtime) {
        readingFreeze.pos.x = nextX;
        readingFreeze.visualPos.x = nextX;
      }
      const nextPosition = runtime.body.position.clone();
      nextPosition.x = nextX;
      physics.teleport(runtime.body, nextPosition);
      wakeBody(runtime.body);
    }
  }

  updatePhysicsBounds();
  if (readingFreeze) {
    const f = readingFreeze;
    const p = f.runtime.body.position;
    f.pos.copy(p);
    f.visualPos.copy(p);
  }
  fitCamera();
  if (bookViewer3D) bookViewer3D.onResize();
}

function bindEvents() {
  const canvas = renderer.domElement;

  canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
  canvas.addEventListener('pointermove', onHover);
  canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });
  canvas.addEventListener('pointerleave', () => {
    hoveredId = null;
    if (!drag && !isOrbiting) canvas.style.cursor = 'grab';
  });

  controls.addEventListener('start', () => {
    if (drag) return;
    isOrbiting = true;
    canvas.classList.add('is-grabbing');
    canvas.style.cursor = 'grabbing';
  });

  controls.addEventListener('end', () => {
    isOrbiting = false;
    canvas.classList.remove('is-grabbing');
    if (!drag) canvas.style.cursor = 'grab';
  });

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', handleResize);

  if (addButton) {
    addButton.addEventListener('click', toggleAddMenu);
  }

  if (importEpubBtn && epubInput) {
    importEpubBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      epubInput.value = '';
      epubInput.click();
    });

    epubInput.addEventListener('change', () => {
      if (epubInput.files && epubInput.files.length > 0) {
        handleEpubFiles(epubInput.files);
      }
    });
  }

  window.addEventListener('pointerdown', (event) => {
    if (!isMenuOpen) return;
    if (addDock && !addDock.contains(event.target)) {
      closeAddMenu();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (bookViewer3D && bookViewer3D.isOpen) return;
    if (event.key === 'Escape' && isMenuOpen) {
      closeAddMenu();
      return;
    }
    if (!drag) return;
    if (event.code === 'KeyW' || event.code === 'KeyS') {
      event.preventDefault();
      drag.depthKeys.add(event.code);
      if (pendingClick) pendingClick.moved = true;
    } else if (event.code === 'Space' || event.code === 'KeyR') {
      event.preventDefault();
      physics.cycleGrabPosture('cycle');
    } else if (event.code === 'KeyF') {
      event.preventDefault();
      physics.cycleGrabPosture('flip');
    } else if (event.code === 'KeyQ' || event.code === 'ArrowLeft') {
      event.preventDefault();
      physics.cycleGrabPosture('tiltLeft');
    } else if (event.code === 'KeyE' || event.code === 'ArrowRight') {
      event.preventDefault();
      physics.cycleGrabPosture('tiltRight');
    }
  });

  window.addEventListener('keyup', (event) => {
    drag?.depthKeys.delete(event.code);
  });
  window.addEventListener('blur', () => {
    drag?.depthKeys.clear();
  });

  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
      event.preventDefault();
    }
  });

  window.addEventListener('drop', (event) => {
    if (event.dataTransfer?.files?.length) {
      const hasEpub = Array.from(event.dataTransfer.files).some(
        (file) => /\.epub$/i.test(file.name) || file.type === 'application/epub+zip'
      );
      if (hasEpub) {
        event.preventDefault();
        handleEpubFiles(event.dataTransfer.files);
      }
    }
  });
}

function animate() {
  timer.update();
  const delta = Math.min(timer.getDelta(), 0.1);
  const elapsed = timer.getElapsed();

  updateDragDepth(delta);
  updateBooks(delta, elapsed);

  if (!bookViewer3D || !bookViewer3D.isOpen) controls.update();
  renderer.render(scene, camera);
}

async function init() {
  
  ensureCustomFontLoaded();
  await initializePhysics();
  renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  stage.appendChild(renderer.domElement);

  await renderer.init();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe4d7c5);
  timer = new THREE.Timer();
  timer.connect(document);

  await buildTextures();
  buildMaterials();
  buildGeometry();
  setupEnvironment();
  buildRoom();
  setupLights();
  setupCamera();
  bookViewer3D = new BookViewer3D(controls);
  window.bookViewer3D = bookViewer3D;

  state.books.forEach((book) => addBookRuntime(book, false));
  fitCamera();
  bindEvents();
  addButton.disabled = false;

  renderer.setAnimationLoop(animate);
  requestAnimationFrame(() => curtain.classList.add('is-hidden'));
  if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetchBookChapters);
  else setTimeout(prefetchBookChapters, 1200);
}

init().catch((error) => {
  console.error(error);
  curtain.classList.add('is-hidden');
});
