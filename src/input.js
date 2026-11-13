import * as THREE from 'three';
import { clamp } from './epub.js';
import { BOOK, FRAME_TOP, SHELF, SHELF_Y, shelfTop } from './bookMesh.js';
import { SHELF_WIDTH } from './storage.js';

export class CameraRig {
  constructor(camera, domElement, onNeedsRender) {
    this.camera = camera;
    this.domElement = domElement;
    this.onNeedsRender = onNeedsRender;
    this.enabled = true;

    this.baseTarget = new THREE.Vector3(0, (FRAME_TOP + SHELF_Y.bottom) / 2, 0);
    this.target = this.baseTarget.clone();
    this.currentTarget = this.baseTarget.clone();

    this.azimuth = 0.08;
    this.polar = 1.32;
    this.distance = 9.6;

    this.curAzimuth = this.azimuth;
    this.curPolar = this.polar;
    this.curDistance = this.distance;

    this.minPolar = 1.15;
    this.maxPolar = 1.52;
    this.minAzimuth = -0.46;
    this.maxAzimuth = 0.46;
    this.minDistance = 7.5;
    this.maxDistance = 12.0;
    this.baseDistance = 9.6;
  }

  fitToViewport(preserveAngles = false) {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const sceneHeight = FRAME_TOP - SHELF_Y.bottom + 1.1;
    const distanceH = (SHELF_WIDTH / 2 + 0.55) / (Math.tan(fov / 2) * Math.max(aspect, 0.2));
    const distanceV = sceneHeight / 2 / Math.tan(fov / 2);
    const dist = Math.max(distanceH, distanceV) * 1.04;

    this.baseDistance = dist;
    this.minDistance = dist * 0.78;
    this.maxDistance = dist * 1.26;

    if (!preserveAngles) {
      this.azimuth = 0.08;
      this.polar = 1.32;
      this.distance = dist;
      this.target.copy(this.baseTarget);
      this.curAzimuth = this.azimuth;
      this.curPolar = this.polar;
      this.curDistance = this.distance;
      this.currentTarget.copy(this.target);
    } else {
      this.distance = clamp(this.distance, this.minDistance, this.maxDistance);
      this.curDistance = clamp(this.curDistance, this.minDistance, this.maxDistance);
    }

    this.applyImmediate();
  }

  orbitBy(deltaAzimuth, deltaPolar) {
    if (!this.enabled) return;
    this.azimuth = clamp(this.azimuth + deltaAzimuth, this.minAzimuth, this.maxAzimuth);
    this.polar = clamp(this.polar + deltaPolar, this.minPolar, this.maxPolar);
    this.onNeedsRender?.();
  }

  zoomBy(deltaScale) {
    if (!this.enabled) return;
    this.distance = clamp(this.distance * deltaScale, this.minDistance, this.maxDistance);
    this.onNeedsRender?.();
  }

  applyImmediate() {
    const sinP = Math.sin(this.curPolar);
    const cosP = Math.cos(this.curPolar);
    const x = this.curDistance * sinP * Math.sin(this.curAzimuth);
    const y = this.curDistance * cosP;
    const z = this.curDistance * sinP * Math.cos(this.curAzimuth);

    this.camera.position.set(
      this.currentTarget.x + x,
      this.currentTarget.y + y,
      this.currentTarget.z + z
    );
    this.camera.lookAt(this.currentTarget);
  }

  update(delta) {
    const damp = 14;
    const nextAz = THREE.MathUtils.damp(this.curAzimuth, this.azimuth, damp, delta);
    const nextPol = THREE.MathUtils.damp(this.curPolar, this.polar, damp, delta);
    const nextDist = THREE.MathUtils.damp(this.curDistance, this.distance, damp, delta);

    const tx = THREE.MathUtils.damp(this.currentTarget.x, this.target.x, damp, delta);
    const ty = THREE.MathUtils.damp(this.currentTarget.y, this.target.y, damp, delta);
    const tz = THREE.MathUtils.damp(this.currentTarget.z, this.target.z, damp, delta);

    const moving =
      Math.abs(nextAz - this.azimuth) > 1e-4 ||
      Math.abs(nextPol - this.polar) > 1e-4 ||
      Math.abs(nextDist - this.distance) > 1e-4 ||
      Math.abs(tx - this.target.x) > 1e-4 ||
      Math.abs(ty - this.target.y) > 1e-4 ||
      Math.abs(tz - this.target.z) > 1e-4;

    this.curAzimuth = moving ? nextAz : this.azimuth;
    this.curPolar = moving ? nextPol : this.polar;
    this.curDistance = moving ? nextDist : this.distance;
    if (moving) {
      this.currentTarget.set(tx, ty, tz);
    } else {
      this.currentTarget.copy(this.target);
    }

    this.applyImmediate();
    return moving;
  }
}

export function setupInputController({
  renderer,
  camera,
  cameraRig,
  physics,
  runtimes,
  isReaderOpen,
  onOpenBook,
  onDeleteBook,
  onImportFiles,
  onMarkDirty,
  onNeedsRender,
}) {
  const canvas = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -BOOK.z);

  let drag = null;
  let pendingPointer = null;
  let orbitPointer = null;
  let hoveredId = null;
  let hoverRaf = 0;
  let lastHoverEvent = null;

  let wheelSpinAccum = 0;
  let wheelSpinLocked = false;
  let wheelIdleTimer = 0;

  function updatePointer(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pickBook(event) {
    updatePointer(event);
    raycaster.setFromCamera(pointer, camera);
    return physics.castRay(raycaster.ray.origin, raycaster.ray.direction, 30);
  }

  function pointOnDragPlane(event) {
    if (event) updatePointer(event);
    raycaster.setFromCamera(pointer, camera);
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(dragPlane, point) ? point : null;
  }

  function startDragFromPending(pending) {
    const runtime = runtimes.get(pending.id);
    if (!runtime) return;

    dragPlane.constant = -pending.hitPoint.z;
    physics.startGrab(runtime.body, pending.hitPoint);

    drag = {
      id: pending.id,
      runtime,
      pointerId: pending.pointerId,
      anchorZ: pending.hitPoint.z,
      depthKeys: new Set(),
    };

    cameraRig.enabled = false;
    onMarkDirty();
    onNeedsRender();
    canvas.setPointerCapture(pending.pointerId);
    canvas.classList.add('is-grabbing');
    canvas.style.cursor = 'grabbing';
  }

  function updateDragTarget(point) {
    if (!point || !drag) return;
    const maxX = SHELF_WIDTH / 2;
    point.x = clamp(point.x, -maxX, maxX);
    point.y = clamp(point.y, shelfTop('bottom'), FRAME_TOP - SHELF.thickness / 2);
    point.z = drag.anchorZ;
    physics.updateGrabTarget(point);
    onNeedsRender();
  }

  function updateDragDepth(delta) {
    if (!drag) return false;
    const direction = Number(drag.depthKeys.has('KeyS')) - Number(drag.depthKeys.has('KeyW'));
    if (!direction) return false;
    drag.anchorZ = clamp(drag.anchorZ + direction * 0.9 * delta, -0.5, 1.5);
    dragPlane.constant = -drag.anchorZ;
    updateDragTarget(pointOnDragPlane());
    return true;
  }

  function cancelActiveDrag() {
    if (!drag) return;
    if (canvas.hasPointerCapture(drag.pointerId)) {
      canvas.releasePointerCapture(drag.pointerId);
    }
    physics.endGrab();
    drag = null;
    cameraRig.enabled = true;
    canvas.classList.remove('is-grabbing');
    canvas.style.cursor = hoveredId ? 'pointer' : 'grab';
    onMarkDirty();
    onNeedsRender();
  }

  function onPointerDown(event) {
    if (event.button !== 0 || isReaderOpen()) return;

    const hit = pickBook(event);
    if (hit) {
      event.preventDefault();
      pendingPointer = {
        id: hit.id,
        hitPoint: hit.point.clone(),
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTime: performance.now(),
      };
      return;
    }

    orbitPointer = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-grabbing');
    canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(event) {
    if (pendingPointer && event.pointerId === pendingPointer.pointerId) {
      const dist = Math.hypot(
        event.clientX - pendingPointer.startX,
        event.clientY - pendingPointer.startY
      );
      if (dist > 5) {
        const pending = pendingPointer;
        pendingPointer = null;
        startDragFromPending(pending);
      }
    }

    if (drag && event.pointerId === drag.pointerId) {
      updateDragTarget(pointOnDragPlane(event));
      return;
    }

    if (orbitPointer && event.pointerId === orbitPointer.pointerId) {
      const dx = event.clientX - orbitPointer.lastX;
      const dy = event.clientY - orbitPointer.lastY;
      orbitPointer.lastX = event.clientX;
      orbitPointer.lastY = event.clientY;
      cameraRig.orbitBy(-dx * 0.0032, -dy * 0.0032);
    }
  }

  function onPointerUp(event) {
    if (pendingPointer && event.pointerId === pendingPointer.pointerId) {
      const clickBookId =
        performance.now() - pendingPointer.startTime < 500 ? pendingPointer.id : null;
      pendingPointer = null;
      if (clickBookId) onOpenBook(clickBookId);
      return;
    }

    if (drag && event.pointerId === drag.pointerId) {
      cancelActiveDrag();
      return;
    }

    if (orbitPointer && event.pointerId === orbitPointer.pointerId) {
      if (canvas.hasPointerCapture(orbitPointer.pointerId)) {
        canvas.releasePointerCapture(orbitPointer.pointerId);
      }
      orbitPointer = null;
      canvas.classList.remove('is-grabbing');
      canvas.style.cursor = hoveredId ? 'pointer' : 'grab';
    }
  }

  function onHover(event) {
    if (drag || pendingPointer || orbitPointer || isReaderOpen()) return;
    lastHoverEvent = event;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (!lastHoverEvent || drag || orbitPointer || isReaderOpen()) return;
      const hit = pickBook(lastHoverEvent);
      hoveredId = hit ? hit.id : null;
      canvas.style.cursor = hoveredId ? 'pointer' : 'grab';
    });
  }

  function onWheel(event) {
    if (isReaderOpen()) return;
    event.preventDefault();

    if (drag) {
      clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => {
        wheelSpinAccum = 0;
        wheelSpinLocked = false;
      }, 150);

      const isHorizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.1;
      if (isHorizontal) {
        if (wheelSpinLocked) return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        wheelSpinAccum += delta;
        if (Math.abs(wheelSpinAccum) >= 42) {
          physics.cycleGrabPosture('cycle');
          wheelSpinAccum = 0;
          wheelSpinLocked = true;
          onNeedsRender();
        }
      } else {
        drag.anchorZ = clamp(drag.anchorZ + event.deltaY * 0.0025, -0.5, 1.5);
        dragPlane.constant = -drag.anchorZ;
        updateDragTarget(pointOnDragPlane(event));
      }
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(event.deltaY * 0.004);
      cameraRig.zoomBy(factor);
    } else {
      cameraRig.orbitBy(event.deltaX * 0.0018, event.deltaY * 0.0018);
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onHover);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerleave', () => {
    hoveredId = null;
    if (!drag && !orbitPointer) canvas.style.cursor = 'grab';
  });

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('keydown', (event) => {
    if (isReaderOpen()) return;
    if (!drag) return;

    if (event.code === 'Backspace' || event.code === 'Delete') {
      event.preventDefault();
      const idToDelete = drag.id;
      cancelActiveDrag();
      onDeleteBook(idToDelete);
    } else if (event.code === 'KeyW' || event.code === 'KeyS') {
      event.preventDefault();
      drag.depthKeys.add(event.code);
      onNeedsRender();
    } else if (event.code === 'Space' || event.code === 'KeyR') {
      event.preventDefault();
      physics.cycleGrabPosture('cycle');
      onNeedsRender();
    } else if (event.code === 'KeyF') {
      event.preventDefault();
      physics.cycleGrabPosture('flip');
      onNeedsRender();
    } else if (event.code === 'KeyQ' || event.code === 'ArrowLeft') {
      event.preventDefault();
      physics.cycleGrabPosture('tiltLeft');
      onNeedsRender();
    } else if (event.code === 'KeyE' || event.code === 'ArrowRight') {
      event.preventDefault();
      physics.cycleGrabPosture('tiltRight');
      onNeedsRender();
    }
  });

  window.addEventListener('keyup', (event) => {
    drag?.depthKeys.delete(event.code);
  });
  window.addEventListener('blur', () => {
    drag?.depthKeys.clear();
  });

  const addButton = document.getElementById('add-book');
  const epubInput = document.getElementById('epub-input');
  if (addButton && epubInput) {
    addButton.addEventListener('click', () => {
      epubInput.value = '';
      epubInput.click();
    });
    epubInput.addEventListener('change', () => {
      if (epubInput.files?.length) {
        onImportFiles(epubInput.files);
      }
    });
  }

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
        onImportFiles(event.dataTransfer.files);
      }
    }
  });

  return {
    isDragging: () => Boolean(drag),
    getDraggedBookId: () => drag?.id || null,
    cancelActiveDrag,
    updateDragDepth,
  };
}
