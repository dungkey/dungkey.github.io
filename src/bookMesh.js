import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { getWorldHalfExtents } from './physics.js';
import { clamp, FALLBACK_PALETTES, renderSpineCanvas } from './epub.js';
import { loadBookCoverUrl, SHELF_WIDTH } from './storage.js';

export const SHELVES = ['bottom', 'middle', 'top'];
export const SHELF_Y = { bottom: 0.55, middle: 2.25, top: 3.95 };
export const BOOK = { w: 0.84, h: 1.12, t: 0.2, cover: 0.03, z: 0.05 };
export const SHELF = { thickness: 0.16, depth: 1.25 };
export const FRAME_TOP = 5.65;

export function shelfTop(shelf) {
  return SHELF_Y[shelf] + SHELF.thickness / 2;
}

export const textures = {};
export const shared = {};
export const geometry = {};
const clothMaterials = new Map();

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
        const grain = (Math.random() - 0.5) * 16;
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

function createFallbackWoodTexture() {
  return makeCanvasTexture(
    512,
    256,
    (context, width, height) => {
      context.fillStyle = '#c59f76';
      context.fillRect(0, 0, width, height);
      for (let y = 0; y < height; y += 2) {
        const alpha = 0.03 + Math.random() * 0.08;
        context.fillStyle =
          y % 4 === 0 ? `rgba(88, 54, 28, ${alpha})` : `rgba(245, 222, 192, ${alpha * 0.7})`;
        context.fillRect(0, y, width, 2);
      }
    },
    { wrap: THREE.MirroredRepeatWrapping, repeat: [2, 1] }
  );
}

function createInnerPageTexture() {
  return makeCanvasTexture(
    512,
    768,
    (ctx, w, h) => {
      ctx.fillStyle = '#fdfbf6';
      ctx.fillRect(0, 0, w, h);

      const spineGrad = ctx.createLinearGradient(0, 0, 48, 0);
      spineGrad.addColorStop(0, 'rgba(40, 26, 14, 0.16)');
      spineGrad.addColorStop(0.5, 'rgba(40, 26, 14, 0.04)');
      spineGrad.addColorStop(1, 'rgba(40, 26, 14, 0)');
      ctx.fillStyle = spineGrad;
      ctx.fillRect(0, 0, 48, h);

      ctx.fillStyle = 'rgba(60, 46, 32, 0.13)';
      ctx.fillRect(56, 62, w - 112, 2);

      for (let y = 104; y < h - 84; y += 22) {
        const isParaEnd = (y - 104) % 132 === 110;
        const lineW = isParaEnd ? (w - 116) * 0.62 : w - 116;
        const indent = (y - 104) % 132 === 0 ? 28 : 0;
        ctx.fillStyle = 'rgba(52, 40, 28, 0.16)';
        ctx.fillRect(58 + indent, y, lineW - indent, 3.5);
      }
    },
    { wrap: THREE.ClampToEdgeWrapping }
  );
}

export async function buildTextures() {
  textures.wall = createWallTexture();
  textures.wallBump = createWallBump();
  textures.clothBump = createClothBump();
  textures.pages = createPageTexture();
  textures.innerPage = createInnerPageTexture();

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

export function buildMaterials() {
  shared.gold = new THREE.MeshStandardMaterial({
    color: 0xd6b678,
    metalness: 0.92,
    roughness: 0.25,
    envMapIntensity: 1.5,
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

  shared.innerPage = new THREE.MeshStandardMaterial({
    map: textures.innerPage,
    color: 0xf8f3e8,
    roughness: 0.92,
    metalness: 0,
  });
}

function getClothMaterials(index, customPalette = null) {
  const theme =
    customPalette && customPalette.cloth
      ? customPalette
      : FALLBACK_PALETTES[(index ?? 0) % FALLBACK_PALETTES.length];
  if (clothMaterials.has(theme.cloth)) return clothMaterials.get(theme.cloth);

  const cover = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.cloth),
    roughness: 0.72,
    metalness: 0,
    sheen: 0.5,
    sheenRoughness: 0.82,
    sheenColor: new THREE.Color(theme.sheen || '#d8ccb8'),
    bumpMap: textures.clothBump,
    bumpScale: 0.003,
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
  const geo = new THREE.PlaneGeometry(1, BOOK.h - 0.022, 16, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    pos.setZ(i, Math.cos(x * Math.PI));
  }
  geo.computeVertexNormals();
  return geo;
}

export function buildGeometry() {
  geometry.cover = new RoundedBoxGeometry(BOOK.w, BOOK.h, BOOK.cover, 3, 0.012);
  geometry.pages = new RoundedBoxGeometry(BOOK.w - 0.06, BOOK.h - 0.045, BOOK.t - 0.04, 2, 0.006);
  geometry.spine = new RoundedBoxGeometry(BOOK.cover + 0.006, BOOK.h, BOOK.t, 3, 0.01);
  geometry.headband = new THREE.BoxGeometry(0.016, 0.016, 1);
  geometry.ribbon = createRibbonGeometry();
  geometry.coverArt = new THREE.PlaneGeometry(1, BOOK.h - 0.022);
  geometry.innerPage = new THREE.PlaneGeometry(1, BOOK.h - 0.045);
  geometry.spineArt = createCurvedSpineArtGeometry();
  geometry.board = new RoundedBoxGeometry(1, SHELF.thickness, SHELF.depth, 4, 0.03);
}

export function createBookVisual(book, onNeedsRender) {
  const t = book.thickness || BOOK.t;
  const aspect = clamp(Number(book.aspect) || 0.75, 0.58, 0.88);
  const bookH = BOOK.h;
  const bookW = Number((bookH * aspect).toFixed(3));
  const scaleX = bookW / BOOK.w;

  const cloth = getClothMaterials(book.theme, book.palette);
  const group = new THREE.Group();
  group.userData.bookId = book.id;
  const disposables = [];

  const addMesh = (mesh, cast = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  const coverScaleZ = clamp(t / BOOK.t, 0.56, 1.14);
  const coverT = BOOK.cover * coverScaleZ;

  const pagesMesh = addMesh(new THREE.Mesh(geometry.pages, shared.pages));
  pagesMesh.scale.set(
    (bookW - 0.06) / (BOOK.w - 0.06),
    1,
    Math.max(0.18, (t - coverT * 1.65) / (BOOK.t - 0.04))
  );

  const front = addMesh(new THREE.Mesh(geometry.cover, cloth.cover));
  front.scale.set(scaleX, 1, coverScaleZ);
  front.position.z = t / 2 - coverT / 2;

  const back = addMesh(new THREE.Mesh(geometry.cover, cloth.cover));
  back.scale.set(scaleX, 1, coverScaleZ);
  back.position.z = -t / 2 + coverT / 2;

  const spine = addMesh(new THREE.Mesh(geometry.spine, cloth.spine));
  spine.position.x = -bookW / 2 + (BOOK.cover + 0.006) / 2;
  spine.scale.z = Math.max(0.32, (t - 0.006) / BOOK.t);

  const headbandSpan = Math.max(0.03, t - coverT * 1.9);
  for (const dirY of [1, -1]) {
    const hb = addMesh(new THREE.Mesh(geometry.headband, shared.gold), false);
    hb.scale.z = headbandSpan;
    hb.position.set(-bookW / 2 + 0.022, dirY * (bookH / 2 - 0.022), 0);
  }

  // 按书厚 t 分三段计算书脊外凸弧高：薄书平直、中书微凸、厚书圆脊
  const archDepth =
    t < 0.13
      ? clamp(t * 0.02, 0.0018, 0.004)
      : t >= 0.25
        ? clamp(t * 0.055, 0.014, 0.024)
        : clamp(t * 0.045, 0.005, 0.014);

  const coverMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0,
    bumpMap: textures.clothBump,
    bumpScale: 0.0018,
    envMapIntensity: 0.72,
  });
  disposables.push(coverMaterial);

  const applyCoverUrl = (url) => {
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.CanvasTexture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      coverMaterial.map = tex;
      coverMaterial.needsUpdate = true;
      disposables.push(tex);
      onNeedsRender?.();
    };
    img.src = url;
  };

  if (book.coverUrl) {
    applyCoverUrl(book.coverUrl);
  } else {
    loadBookCoverUrl(book.id).then((url) => {
      if (url) {
        book.coverUrl = url;
        applyCoverUrl(url);
      }
    });
  }

  const coverArtMesh = addMesh(new THREE.Mesh(geometry.coverArt, coverMaterial), false);
  coverArtMesh.scale.x = bookW - 0.022;
  coverArtMesh.position.set(0.004, 0, t / 2 + 0.0012);

  const palette = book.palette || FALLBACK_PALETTES[(book.theme ?? 0) % FALLBACK_PALETTES.length];
  const spineCanvas = renderSpineCanvas({
    title: book.title,
    author: book.author,
    palette,
    thickness: t,
  });
  const spineTex = new THREE.CanvasTexture(spineCanvas);
  spineTex.colorSpace = THREE.SRGBColorSpace;
  spineTex.anisotropy = 4;
  spineTex.needsUpdate = true;

  const spineMat = new THREE.MeshStandardMaterial({
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
  spineArtMesh.position.set(-bookW / 2 + 0.001, 0, 0);
  spineArtMesh.rotation.y = -Math.PI / 2;

  const spineChars = `${book.title || ''}${book.author || ''}`.trim();
  if (spineChars && document.fonts?.load) {
    document.fonts
      .load('600 36px "KingHwa_OldSong"', spineChars)
      .then(() => {
        const updated = renderSpineCanvas({
          title: book.title,
          author: book.author,
          palette,
          thickness: t,
        });
        spineTex.image = updated;
        spineTex.needsUpdate = true;
        onNeedsRender?.();
      })
      .catch(() => {});
  }

  const ribbon = addMesh(new THREE.Mesh(geometry.ribbon, shared.ribbon), false);
  ribbon.position.set(bookW * 0.16, -bookH / 2 + 0.004, clamp(t / 2 - 0.04, 0, t / 2 - 0.015));
  ribbon.rotation.x = -Math.PI / 2;

  return {
    group,
    ribbon,
    thickness: t,
    bookW,
    bookH,
    cloth,
    coverMaterial,
    spineMat,
    archDepth,
    disposables,
  };
}

export function updateBookVisualDetails(runtime, delta, book) {
  const { body, ribbon, bookW, bookH } = runtime;
  if (!ribbon) return;

  const h = getWorldHalfExtents(body);
  const bottomY = body.position.y - h.y;
  const shelfLimitX = SHELF_WIDTH / 2 + h.x * 0.35;

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
  const bookT = runtime.thickness || BOOK.t;
  const uprightness = body.axes[1].y;
  const onShelfBottom = bestShelf && gap < 0.05 && uprightness > 0.65;

  const ratio = clamp(Number(book?.progress?.ratio) || 0, 0, 1);
  const maxZ = Math.max(0.01, bookT / 2 - 0.025);
  const progressZ = THREE.MathUtils.lerp(maxZ, -maxZ, ratio);

  const targetRotX = onShelfBottom ? -Math.PI / 2 : -0.15;
  const targetPosY = onShelfBottom ? -bookH / 2 + 0.004 : -bookH / 2 + 0.05;
  const targetPosZ = onShelfBottom ? progressZ : progressZ * 0.5;
  const targetPosX = bookW * 0.16;

  ribbon.position.x = targetPosX;
  ribbon.rotation.x = THREE.MathUtils.damp(ribbon.rotation.x, targetRotX, 14, delta);
  ribbon.position.y = THREE.MathUtils.damp(ribbon.position.y, targetPosY, 14, delta);
  ribbon.position.z = THREE.MathUtils.damp(ribbon.position.z, targetPosZ, 14, delta);
}

const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// 负责开书飞出翻开与合书归架的 3D 过渡装置
export class BookTransitionRig {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.bookOffset = new THREE.Group();
    this.group.add(this.bookOffset);

    this.pagesMesh = new THREE.Mesh(geometry.pages, shared.pages);
    this.backMesh = new THREE.Mesh(geometry.cover, shared.pages);
    this.spineMesh = new THREE.Mesh(geometry.spine, shared.pages);
    this.spineArtMesh = new THREE.Mesh(geometry.spineArt, shared.pages);
    this.rightPageSheet = new THREE.Mesh(geometry.innerPage, shared.innerPage);

    this.frontPivot = new THREE.Group();
    this.frontMesh = new THREE.Mesh(geometry.cover, shared.pages);
    this.coverArtMesh = new THREE.Mesh(geometry.coverArt, shared.pages);
    this.leftPageSheet = new THREE.Mesh(geometry.innerPage, shared.innerPage);
    this.leftPageSheet.rotation.y = Math.PI;
    this.frontPivot.add(this.frontMesh, this.coverArtMesh, this.leftPageSheet);

    this.bookOffset.add(
      this.pagesMesh,
      this.backMesh,
      this.spineMesh,
      this.spineArtMesh,
      this.rightPageSheet,
      this.frontPivot
    );

    this.group.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    this.coverArtMesh.castShadow = false;
    this.spineArtMesh.castShadow = false;
    this.rightPageSheet.castShadow = false;
    this.leftPageSheet.castShadow = false;

    this.runtime = null;
    this.mode = null;
    this.progress = 0;
    this.revealed = false;
    this.onRevealReader = null;
    this.onComplete = null;
    this._forward = new THREE.Vector3();
    this._targetPos = new THREE.Vector3();
  }

  configure(runtime, theme = 'cream') {
    this.runtime = runtime;
    const { bookW, thickness: t, cloth, coverMaterial, spineMat, archDepth } = runtime;
    const scaleX = bookW / BOOK.w;
    const coverScaleZ = clamp(t / BOOK.t, 0.56, 1.14);
    const coverT = BOOK.cover * coverScaleZ;
    const pageBlockT = Math.max(0.04, t - coverT * 1.65);

    const themeColor = theme === 'night' ? 0x24211d : theme === 'white' ? 0xfcfcfa : 0xf8f3e8;
    shared.innerPage.color.setHex(themeColor);

    this.backMesh.material = cloth.cover;
    this.frontMesh.material = cloth.cover;
    this.spineMesh.material = cloth.spine;
    this.coverArtMesh.material = coverMaterial;
    this.spineArtMesh.material = spineMat;

    this.pageBlockScaleZ = pageBlockT / (BOOK.t - 0.04);
    this.pagesMesh.scale.set((bookW - 0.06) / (BOOK.w - 0.06), 1, this.pageBlockScaleZ);
    this.backMesh.scale.set(scaleX, 1, coverScaleZ);
    this.backMesh.position.set(0, 0, -t / 2 + coverT / 2);

    this.spineScaleZ = Math.max(0.32, (t - 0.006) / BOOK.t);
    this.spineMesh.position.set(-bookW / 2 + (BOOK.cover + 0.006) / 2, 0, 0);
    this.spineMesh.scale.set(1, 1, this.spineScaleZ);

    this.spineArtMesh.scale.set(Math.max(0.055, t - 0.008), 1, archDepth);
    this.spineArtMesh.position.set(-bookW / 2 + 0.001, 0, 0);
    this.spineArtMesh.rotation.y = -Math.PI / 2;

    this.rightPageSheet.scale.set(bookW - 0.045, 1, 1);
    this.rightPageSheet.position.set(0.006, 0, pageBlockT / 2 + 0.002);

    this.frontPivot.position.set(-bookW / 2, 0, t / 2 - coverT / 2);
    this.frontMesh.scale.set(scaleX, 1, coverScaleZ);
    this.frontMesh.position.set(bookW / 2, 0, 0);
    this.coverArtMesh.scale.set(bookW - 0.022, 1, 1);
    this.coverArtMesh.position.set(bookW / 2 + 0.004, 0, coverT / 2 + 0.0012);
    this.leftPageSheet.scale.set(bookW - 0.045, 1, 1);
    this.leftPageSheet.position.set(bookW / 2 - 0.006, 0, -coverT / 2 - 0.002);
  }

  startOpen(runtime, theme, onRevealReader, onComplete) {
    this.configure(runtime, theme);
    runtime.group.visible = false;
    this.mode = 'opening';
    this.progress = 0;
    this.revealed = false;
    this.onRevealReader = onRevealReader;
    this.onComplete = onComplete;
    this.group.visible = true;
  }

  startClose(runtime, theme, onComplete) {
    this.configure(runtime, theme);
    runtime.group.visible = false;
    this.mode = 'closing';
    this.progress = 1;
    this.revealed = false;
    this.onRevealReader = null;
    this.onComplete = onComplete;
    this.group.visible = true;
  }

  cancel() {
    this.mode = null;
    this.group.visible = false;
    this.runtime = null;
  }

  update(delta, camera) {
    if (!this.mode || !this.runtime) return false;

    if (this.mode === 'opening') {
      this.progress = Math.min(1, this.progress + delta / 0.66);
    } else {
      this.progress = Math.max(0, this.progress - delta / 0.52);
    }

    const p = this.progress;
    const { bookW, bookH } = this.runtime;
    const moveT = easeInOutCubic(clamp(p / 0.88, 0, 1));
    const rotT = easeInOutCubic(clamp(p / 0.74, 0, 1));
    const openT = easeInOutCubic(clamp((p - 0.24) / 0.64, 0, 1));
    const scaleT = easeInOutCubic(clamp((p - 0.14) / 0.82, 0, 1));

    this._forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const dist = 2.1;
    this._targetPos.copy(camera.position).addScaledVector(this._forward, dist);

    const viewH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const viewW = viewH * camera.aspect;
    const isDual = window.innerWidth >= 860 && window.innerWidth / window.innerHeight > 1.0;
    const spreadW = isDual ? bookW * 2 : bookW;
    const targetScale = Math.max(viewW / spreadW, viewH / bookH) * 0.96;

    this.group.position.lerpVectors(this.runtime.group.position, this._targetPos, moveT);
    const pullOut = Math.sin(moveT * Math.PI) * 0.62;
    this.group.position.addScaledVector(this._forward, -pullOut);

    this.group.quaternion.slerpQuaternions(this.runtime.group.quaternion, camera.quaternion, rotT);
    this.group.scale.setScalar(THREE.MathUtils.lerp(1, targetScale, scaleT));

    this.frontPivot.rotation.y = -openT * Math.PI * 0.96;
    this.bookOffset.position.x = isDual ? openT * (bookW * 0.5) : 0;
    this.pagesMesh.scale.z = this.pageBlockScaleZ * (1 - openT * 0.45);
    this.spineMesh.scale.z = this.spineScaleZ * (1 - openT * 0.45);

    if (this.mode === 'opening' && p >= 0.66 && !this.revealed) {
      this.revealed = true;
      this.onRevealReader?.();
    }

    if (this.mode === 'opening' && p >= 1) {
      this.mode = null;
      this.group.visible = false;
      const done = this.onComplete;
      this.onComplete = null;
      done?.();
    } else if (this.mode === 'closing' && p <= 0) {
      this.mode = null;
      this.group.visible = false;
      this.runtime.group.visible = true;
      const done = this.onComplete;
      this.onComplete = null;
      done?.();
    }

    return true;
  }
}
