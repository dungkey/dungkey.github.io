import * as THREE from 'three';
import RAPIER from '../vendor/rapier/rapier.mjs';

export const FIXED_STEP = 1 / 120;
let initialization;
export function initializePhysics() {
  return initialization ??= RAPIER.init({});
}

const euler = new THREE.Euler(0, 0, 0, 'ZXY');
function updateAxes(body) {
  body.axes[0].set(1, 0, 0).applyQuaternion(body.quaternion);
  body.axes[1].set(0, 1, 0).applyQuaternion(body.quaternion);
  body.axes[2].set(0, 0, 1).applyQuaternion(body.quaternion);
}

export function createRigidBody({
  id,
  halfExtents,
  position = new THREE.Vector3(),
  quaternion = new THREE.Quaternion(),
  mass = 1,
  friction = 0.55,
  restitution = 0.03,
  isStatic = false,
}) {
  const body = {
    id,
    mass,
    friction,
    restitution,
    isStatic,
    halfExtents: halfExtents.clone(),
    position: position.clone(),
    quaternion: quaternion.clone().normalize(),
    linearVelocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    previousPosition: position.clone(),
    previousQuaternion: quaternion.clone().normalize(),
    renderPosition: position.clone(),
    renderQuaternion: quaternion.clone().normalize(),
    axes: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    sleeping: false,
    isDragged: false,
    frozen: false,
    shelfPose: null,
    rigidBody: null,
    collider: null,
  };
  updateAxes(body);
  return body;
}

export function setBodyHalfExtents(body, hx, hy, hz = body.halfExtents.z) {
  body.halfExtents.set(hx, hy, hz);
  if (body.collider) {
    body.collider.setShape(new RAPIER.Cuboid(hx, hy, hz));
    if (!body.isStatic) body.collider.setMass(body.mass);
  }
  wakeBody(body);
}

export function wakeBody(body) {
  if (body.isStatic || body.frozen) return;
  body.rigidBody?.wakeUp();
  body.sleeping = false;
}

export function getWorldHalfExtents(body) {
  const [x, y, z] = body.axes;
  const h = body.halfExtents;
  return new THREE.Vector3(
    Math.abs(x.x) * h.x + Math.abs(y.x) * h.y + Math.abs(z.x) * h.z,
    Math.abs(x.y) * h.x + Math.abs(y.y) * h.y + Math.abs(z.y) * h.z,
    Math.abs(x.z) * h.x + Math.abs(y.z) * h.y + Math.abs(z.z) * h.z
  );
}

export class PhysicsWorld {
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_STEP;
    this.world.numSolverIterations = 8;
    this.world.maxCcdSubsteps = 2;
    this.world.integrationParameters.normalizedAllowedLinearError = 0.0005;
    this.world.integrationParameters.contact_natural_frequency = 120;
    this.bodies = [];
    this.shelves = [];
    this.frameBodies = [];
    this.bounds = null;
    this.grab = null;
    this.accumulator = 0;
  }

  attach(body) {
    const desc = body.isStatic ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(body.position.x, body.position.y, body.position.z).setRotation(body.quaternion);
    if (!body.isStatic) {
      desc
        .setLinvel(body.linearVelocity.x, body.linearVelocity.y, body.linearVelocity.z)
        .setAngvel(body.angularVelocity)
        .setCcdEnabled(true)
        .setLinearDamping(0.15)
        .setAngularDamping(0.4)
        .setAdditionalSolverIterations(4);
    }
    body.rigidBody = this.world.createRigidBody(desc);
    const h = body.halfExtents;
    const collider = RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
      .setFriction(body.friction)
      .setRestitution(body.restitution)
      .setContactSkin(0.0005);
    if (!body.isStatic) collider.setMass(body.mass);
    body.collider = this.world.createCollider(collider, body.rigidBody);
    return body;
  }

  addBody(body) {
    const fallen =
      this.bounds &&
      (body.position.y + getWorldHalfExtents(body).y < this.bounds.minY ||
        body.position.z > this.bounds.depth / 2);
    this.fitToBounds(body);
    this.attach(body);
    this.bodies.push(body);
    if (fallen) this.recoverFallenBody(body);
    else this.repairInitialOverlap(body);
    this.rememberShelfPose(body);
    return body;
  }

  addShelf(body) {
    this.attach(body);
    this.shelves.push(body);
    return body;
  }

  removeBody(body) {
    if (this.grab?.body === body) this.endGrab();
    this.bodies = this.bodies.filter((b) => b !== body);
    if (body.rigidBody) this.world.removeRigidBody(body.rigidBody);
    body.rigidBody = body.collider = null;
  }

  setBounds(bounds) {
    this.bounds = { depth: 1.25, thickness: 0.16, backZ: -0.72, ...bounds };
    for (const body of this.frameBodies) this.world.removeRigidBody(body.rigidBody);
    this.frameBodies = [];
    const { minX, maxX, minY, maxY, depth, thickness: t, backZ } = this.bounds;
    const centerY = (minY + maxY) / 2;
    const height = maxY - minY + 2 * t;
    const width = maxX - minX;
    const frame = (id, x, y, z, hx, hy, hz) => {
      const body = createRigidBody({
        id,
        isStatic: true,
        position: new THREE.Vector3(x, y, z),
        halfExtents: new THREE.Vector3(hx, hy, hz),
        friction: 0.65,
      });
      this.frameBodies.push(this.attach(body));
    };
    frame('left', minX - t / 2, centerY, 0, t / 2, height / 2, depth / 2);
    frame('right', maxX + t / 2, centerY, 0, t / 2, height / 2, depth / 2);
    frame('top', (minX + maxX) / 2, maxY + t / 2, 0, width / 2 + t, t / 2, depth / 2);
    frame('back', (minX + maxX) / 2, centerY, backZ - t / 2, width / 2 + t, height / 2, t / 2);
    for (const body of this.bodies) {
      this.fitToBounds(body);
      this.teleport(body, body.position, body.quaternion);
      this.repairInitialOverlap(body);
      wakeBody(body);
    }
  }

  fitToBounds(body) {
    if (!this.bounds) return;
    updateAxes(body);
    const h = getWorldHalfExtents(body);
    const b = this.bounds;
    body.position.x = THREE.MathUtils.clamp(body.position.x, b.minX + h.x, b.maxX - h.x);
    body.position.y = THREE.MathUtils.clamp(body.position.y, b.minY + h.y, b.maxY - h.y);
    body.position.z = Math.max(body.position.z, b.backZ + h.z);
  }

  repairInitialOverlap(body) {
    const obstacles = [...this.shelves, ...this.frameBodies, ...this.bodies];
    this.world.propagateModifiedBodyPositionsToColliders();
    for (let pass = 0; pass < 8; pass++) {
      let corrected = false;
      for (const other of obstacles) {
        if (other === body) continue;
        const contact = body.collider.contactCollider(other.collider, 0);
        if (!contact || contact.distance >= -0.0005) continue;
        const position = body.position.clone().addScaledVector(contact.normal1, contact.distance - 0.001);
        this.teleport(body, position);
        corrected = true;
      }
      if (!corrected) break;
    }
  }

  hasSupportContact(body) {
    for (const list of [this.shelves, this.bodies]) {
      for (const other of list) {
        if (other === body) continue;
        const contact = body.collider.contactCollider(other.collider, 0.005);
        if (contact && contact.distance >= -0.01 && contact.normal1.y < -0.5) return true;
      }
    }
    return false;
  }

  rememberShelfPose(body) {
    if (
      !this.bounds ||
      body.isDragged ||
      body.frozen ||
      body.linearVelocity.length() > 0.1 ||
      body.angularVelocity.length() > 0.2
    ) {
      return;
    }
    const h = getWorldHalfExtents(body);
    const b = this.bounds;
    if (body.position.z + h.z > b.depth / 2 + 0.01 || body.position.z - h.z < b.backZ - 0.01) return;
    if (this.hasSupportContact(body)) {
      body.shelfPose = {
        position: body.position.clone(),
        quaternion: body.quaternion.clone(),
      };
    }
  }

  recoverFallenBody(body) {
    if (!this.bounds || body.isDragged || body.frozen) return;
    const pose = body.shelfPose;
    const position = pose
      ? pose.position.clone()
      : new THREE.Vector3(body.position.x, this.bounds.minY + body.halfExtents.y + 0.003, 0.05);
    const rotation = pose ? pose.quaternion : new THREE.Quaternion();
    this.teleport(body, position, rotation);
    this.fitToBounds(body);
    this.teleport(body, body.position);
    this.repairInitialOverlap(body);
    body.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.rigidBody.resetForces(true);
    body.rigidBody.resetTorques(true);
    body.linearVelocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    wakeBody(body);
  }

  teleport(body, position, quaternion = body.quaternion) {
    body.position.copy(position);
    body.quaternion.copy(quaternion).normalize();
    body.rigidBody?.setTranslation(body.position, true);
    body.rigidBody?.setRotation(body.quaternion, true);
    this.world.propagateModifiedBodyPositionsToColliders();
    body.previousPosition.copy(body.position);
    body.previousQuaternion.copy(body.quaternion);
    body.renderPosition.copy(body.position);
    body.renderQuaternion.copy(body.quaternion);
    updateAxes(body);
  }

  setFrozen(body, frozen) {
    body.frozen = frozen;
    body.rigidBody.setBodyType(frozen ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, true);
    body.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.linearVelocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    body.sleeping = frozen;
    if (!frozen) wakeBody(body);
  }

  startGrab(body, worldHitPoint) {
    if (this.grab) this.endGrab();
    wakeBody(body);
    body.isDragged = true;
    const localAnchor = worldHitPoint
      .clone()
      .sub(body.position)
      .applyQuaternion(body.quaternion.clone().invert());
    localAnchor.clamp(body.halfExtents.clone().negate(), body.halfExtents);
    this.grab = {
      body,
      localAnchor,
      target: worldHitPoint.clone(),
      smoothedTarget: worldHitPoint.clone(),
      targetRotation: body.quaternion.clone(),
      postureOverride: false,
    };
    body.rigidBody.setAngularDamping(2);
  }

  updateGrabTarget(point) {
    if (this.grab) this.grab.target.copy(point);
  }

  addGrabSpin(delta, axis = 'z') {
    if (!this.grab) return;
    const g = this.grab;
    g.postureOverride = true;
    const v = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    g.targetRotation.premultiply(new THREE.Quaternion().setFromAxisAngle(v, delta));
  }

  cycleGrabPosture(action = 'cycle') {
    if (!this.grab) return;
    const g = this.grab;
    if (action === 'tiltLeft' || action === 'tiltRight') {
      this.addGrabSpin(action === 'tiltLeft' ? Math.PI / 2 : -Math.PI / 2);
    } else if (action === 'flip') {
      this.addGrabSpin(Math.PI, 'y');
    } else {
      euler.setFromQuaternion(g.targetRotation, 'ZXY');
      const flat = Math.abs(Math.sin(euler.x)) > 0.7;
      const spine = !flat && Math.abs(Math.sin(euler.y)) > 0.7;
      euler.set(spine ? -Math.PI / 2 : 0, !flat && !spine ? Math.PI / 2 : 0, 0, 'ZXY');
      g.targetRotation.setFromEuler(euler);
      g.postureOverride = true;
    }
  }

  endGrab() {
    if (!this.grab) return;
    const body = this.grab.body;
    body.isDragged = false;
    body.rigidBody.setAngularDamping(0.4);
    this.grab = null;
    wakeBody(body);
  }

  applyGrab(dt) {
    const g = this.grab;
    if (!g) return;
    const body = g.body;
    const rb = body.rigidBody;

    // PD 弹簧阻尼抓取：线刚度 100、阻尼 -18、最大加速度 80；角刚度 5、角阻尼 -0.9、最大角扭矩 6·mass
    const travel = g.target.clone().sub(g.smoothedTarget).clampLength(0, 5 * dt);
    g.smoothedTarget.add(travel);
    const anchor = g.localAnchor.clone().applyQuaternion(body.quaternion).add(body.position);
    const velocity = new THREE.Vector3().copy(rb.velocityAtPoint(anchor));
    const force = g.smoothedTarget.clone().sub(anchor).multiplyScalar(100).addScaledVector(velocity, -18);
    force.y += 9.81;
    force.multiplyScalar(body.mass).clampLength(0, body.mass * 80);
    rb.applyImpulseAtPoint(force.multiplyScalar(dt), anchor, true);
    if (g.postureOverride) {
      const error = g.targetRotation.clone().multiply(body.quaternion.clone().invert()).normalize();
      if (error.w < 0) error.set(-error.x, -error.y, -error.z, -error.w);
      const sinHalf = Math.hypot(error.x, error.y, error.z);
      const axis = new THREE.Vector3(error.x, error.y, error.z);
      if (sinHalf > 1e-6) axis.multiplyScalar((2 * Math.atan2(sinHalf, error.w)) / sinHalf);
      const torque = axis
        .multiplyScalar(5)
        .addScaledVector(body.angularVelocity, -0.9)
        .multiplyScalar(body.mass)
        .clampLength(0, 6 * body.mass);
      rb.applyTorqueImpulse(torque.multiplyScalar(dt), true);
    }
  }

  castRay(origin, direction, maxToi = 30) {
    const ray = new RAPIER.Ray(origin, direction);
    const hit = this.world.castRay(ray, maxToi, true);
    if (!hit) return null;
    const body = this.bodies.find(
      (b) => b.collider === hit.collider || b.collider?.handle === (hit.collider?.handle ?? hit.collider)
    );
    if (!body) return null;
    const toi = hit.timeOfImpact ?? hit.toi ?? 0;
    return {
      id: body.id,
      body,
      point: new THREE.Vector3(origin.x, origin.y, origin.z).addScaledVector(direction, toi),
    };
  }

  step(deltaTime) {
    const anyAwake =
      Boolean(this.grab) ||
      this.bodies.some((b) => !b.frozen && (!b.sleeping || (b.rigidBody && !b.rigidBody.isSleeping())));
    if (!anyAwake) {
      this.accumulator = 0;
      return false;
    }

    this.accumulator += Math.min(Math.max(deltaTime, 0), 0.1);
    while (this.accumulator + 1e-10 >= FIXED_STEP) {
      for (const body of this.bodies) {
        if (body.sleeping && !body.isDragged) continue;
        body.previousPosition.copy(body.position);
        body.previousQuaternion.copy(body.quaternion);
      }

      this.applyGrab(FIXED_STEP);
      for (const body of this.bodies) {
        if (body.frozen || body.sleeping) continue;
        const av = body.rigidBody.angvel();
        const len = Math.hypot(av.x, av.y, av.z);
        if (len > 14) {
          const s = 14 / len;
          body.rigidBody.setAngvel({ x: av.x * s, y: av.y * s, z: av.z * s }, false);
        }
      }
      this.world.step();

      for (const body of this.bodies) {
        const rb = body.rigidBody;
        const nowSleeping = body.frozen || rb.isSleeping();
        if (body.sleeping && nowSleeping && !body.isDragged) continue;

        body.position.copy(rb.translation());
        body.quaternion.copy(rb.rotation());
        body.linearVelocity.copy(rb.linvel());
        body.angularVelocity.copy(rb.angvel());
        body.sleeping = nowSleeping;
        updateAxes(body);

        if (this.bounds && body.position.y + getWorldHalfExtents(body).y < this.bounds.minY - 0.15) {
          this.recoverFallenBody(body);
        } else {
          this.rememberShelfPose(body);
        }
      }
      this.accumulator = Math.max(0, this.accumulator - FIXED_STEP);
    }

    const alpha = this.accumulator / FIXED_STEP;
    for (const body of this.bodies) {
      if (body.sleeping && !body.isDragged) {
        body.renderPosition.copy(body.position);
        body.renderQuaternion.copy(body.quaternion);
      } else {
        body.renderPosition.lerpVectors(body.previousPosition, body.position, alpha);
        body.renderQuaternion.slerpQuaternions(body.previousQuaternion, body.quaternion, alpha);
      }
    }
    return true;
  }

  dispose() {
    this.grab = null;
    this.world.free();
  }
}
