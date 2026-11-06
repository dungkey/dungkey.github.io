import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const coreUrl = new URL('../vendor/three/three.core.js', import.meta.url).href;
const rapierUrl = new URL('../vendor/rapier/rapier.mjs', import.meta.url).href;
const THREE = await import(coreUrl);
const source = (await readFile(new URL('../src/physics.js', import.meta.url), 'utf8'))
  .replace("from 'three'", `from '${coreUrl}'`)
  .replace("from '../vendor/rapier/rapier.mjs'", `from '${rapierUrl}'`);
const { PhysicsWorld, createRigidBody, initializePhysics, setBodyHalfExtents, FIXED_STEP, getWorldHalfExtents } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
await initializePhysics();
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const q = (x = 0, y = 0, z = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'ZXY'));
const near = (a, b, tolerance = 0.01) => assert.ok(Math.abs(a - b) < tolerance);
const advance = (world, seconds, dt = 1 / 60) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) world.step(dt);
};
function book(world, id, position, { half = v(0.42, 0.56, 0.04), rotation = q(), velocity = v(), mass = 1 } = {}) {
  const body = createRigidBody({ id, halfExtents: half, position, quaternion: rotation, mass, restitution: 0 });
  body.linearVelocity.copy(velocity);
  return world.addBody(body);
}
function board(world, id, position, half = v(3, 0.08, 0.625)) {
  return world.addShelf(createRigidBody({ id, halfExtents: half, position, isStatic: true, tag: 'shelf' }));
}
function gap(a, b) {
  return a.collider.contactCollider(b.collider, 0.1)?.distance ?? 0.1;
}
let passed = 0;
function test(fn) {
  const world = new PhysicsWorld();
  try { fn(world); passed++; } finally { world.dispose(); }
}

for (const speed of [5, 30, 100]) {
  test((w) => {
    const a = book(w, 'a', v(0, 2, -0.2), { velocity: v(0, 0, speed) });
    const b = book(w, 'b', v(0, 2, 0.2), { velocity: v(0, 0, -speed) });
    for (let i = 0; i < 10; i++) {
      w.step(1 / 30);
      assert.ok(a.position.z < b.position.z);
      assert.ok(gap(a, b) > -0.008);
    }
  });
}
test((w) => {
  const floor = board(w, 'floor', v(0, 0, 0));
  const b = book(w, 'rotating', v(0, 0.67, 0), { rotation: q(0.3, 0.2) });
  b.rigidBody.setAngvel(v(30, 20, 15), true);
  for (let i = 0; i < 120; i++) {
    w.step(1 / 120);
    assert.ok(gap(b, floor) > -0.012);
    assert.ok(b.position.y > 0.08);
  }
});
for (const velocity of [v(-100, 0, 0), v(100, 0, 0), v(0, 100, 0), v(0, 0, -100)]) {
  test((w) => {
    w.setBounds({ minX: -2.2, maxX: 2.2, minY: 0.08, maxY: 4 });
    const b = book(w, 'a', v(0, 2, 0), { velocity });
    for (let i = 0; i < 12; i++) {
      w.step(1 / 120);
      const h = getWorldHalfExtents(b);
      assert.ok(b.position.x - h.x > -2.215 && b.position.x + h.x < 2.215);
      assert.ok(b.position.y + h.y < 4.015);
      assert.ok(b.position.z - h.z > -0.735);
    }
  });
}
test((w) => {
  const a = book(w, 'a', v(-0.7, 2, -0.3), { velocity: v(2, 0, 0) });
  const b = book(w, 'b', v(0.7, 2, 0.3), { velocity: v(-2, 0, 0) });
  advance(w, 0.8);
  assert.ok(a.position.x > b.position.x);
  near(a.position.z, -0.3, 0.001); near(b.position.z, 0.3, 0.001);
});
test((w) => {
  const shelf = board(w, 'ceiling', v(0, 2, 0));
  const b = book(w, 'a', v(0, 0.8, 0), { velocity: v(0, 30, 0) });
  for (let i = 0; i < 12; i++) {
    w.step(1 / 120);
    assert.ok(b.position.y < 2 - 0.08 - 0.56 + 0.01);
    assert.ok(gap(b, shelf) > -0.01);
  }
});
test((w) => {
  board(w, 'floor', v(0, 0, 0));
  const books = [];
  for (let i = 0; i < 5; i++) books.push(book(w, `${i}`, v(0, 0.13 + i * 0.085, 0), { rotation: q(-Math.PI / 2) }));
  advance(w, 8);
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    near(b.position.y, 0.12 + i * 0.081, 0.015);
    assert.ok(b.linearVelocity.length() < 0.02);
    assert.ok(b.sleeping);
    if (i) assert.ok(gap(books[i - 1], b) > -0.003);
  }
});
test((w) => {
  const a = book(w, 'a', v(0, 2, 0));
  const b = book(w, 'b', v(0, 2, 0.01));
  advance(w, 1);
  assert.ok(gap(a, b) > -0.002);
  assert.ok(Math.abs(a.linearVelocity.z) < 0.1 && Math.abs(b.linearVelocity.z) < 0.1);
});
test((w) => {
  const shelf = board(w, 'ceiling', v(0, 2, 0));
  const b = book(w, 'a', v(0, 0.8, 0));
  w.startGrab(b, b.position.clone());
  w.updateGrabTarget(v(0, 3, 0));
  for (let i = 0; i < 180; i++) {
    w.step(1 / 60);
    assert.ok(b.position.y < 1.38);
    assert.ok(gap(b, shelf) > -0.015);
  }
  w.endGrab();
  const y = b.position.y;
  advance(w, 0.25);
  assert.ok(b.position.y < y - 0.1);
});
test((w) => {
  board(w, 'floor', v(0, 0, 0));
  const a = book(w, 'a', v(-0.55, 0.65, 0));
  const b = book(w, 'b', v(0.55, 0.65, 0));
  w.startGrab(a, a.position.clone());
  w.updateGrabTarget(v(1.1, 0.65, 0));
  for (let i = 0; i < 120; i++) {
    w.step(1 / 60);
    assert.ok(gap(a, b) > -0.015);
  }
  assert.ok(b.position.x > 0.8);
});
test((w) => {
  const shelf = board(w, 'middle', v(0, 2, 0));
  const b = book(w, 'a', v(0, 0.8, 0));
  w.startGrab(b, b.position.clone());
  w.updateGrabTarget(v(0, 0.8, 1)); advance(w, 1);
  assert.ok(b.position.z > 0.8);
  w.updateGrabTarget(v(0, 2.8, 1)); advance(w, 1.5);
  assert.ok(b.position.y > 2.65);
  w.updateGrabTarget(v(0, 2.8, 0)); advance(w, 1.2);
  assert.ok(Math.abs(b.position.z) < 0.05);
  w.endGrab(); advance(w, 3);
  near(b.position.y, 2.64, 0.02);
  assert.ok(gap(b, shelf) > -0.003);
});
test(() => {
  const positions = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
    const w = new PhysicsWorld();
    const b = book(w, 'a', v(0, 20, 0), { velocity: v(1, 0, 0) });
    advance(w, 1, dt); positions.push(b.position.clone()); w.dispose();
  }
  assert.ok(positions[0].distanceTo(positions[1]) < 1e-5);
  assert.ok(positions[0].distanceTo(positions[2]) < 1e-5);
});
test((w) => {
  const b = book(w, 'a', v(0, 2, 0));
  const before = b.rigidBody.principalInertia();
  w.teleport(b, b.position, q(0.6, 0.4, 0.3));
  const after = b.rigidBody.principalInertia();
  near(before.x, after.x, 1e-6); near(before.y, after.y, 1e-6); near(before.z, after.z, 1e-6);
  assert.ok(Math.abs(before.y - before.z) > 0.01);
});
test((w) => {
  const b = book(w, 'a', v(0, 2, 0));
  const original = b.position.clone();
  w.setFrozen(b, true); advance(w, 2);
  assert.ok(b.position.distanceTo(original) < 1e-6);
  w.setFrozen(b, false); advance(w, 0.5);
  assert.ok(b.position.y < original.y - 0.5);
});
test((w) => {
  board(w, 'floor', v(0, 0, 0));
  const b = book(w, 'a', v(10, 1, 0), { rotation: q(0.2, 0.4, 0.3) });
  const bounds = { minX: -1.5, maxX: 1.5, minY: 0.08, maxY: 4 };
  w.setBounds(bounds);
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const c = v(x * 0.42, y * 0.56, z * 0.04).applyQuaternion(b.quaternion).add(b.position);
    assert.ok(c.x <= 1.500001 && c.x >= -1.500001);
    assert.ok(c.y >= 0.079999 && c.y <= 4.000001);
  }
  setBodyHalfExtents(w.shelves[0], 1.5, 0.08, 0.625);
  near(w.shelves[0].collider.halfExtents().x, 1.5, 1e-6);
  const before = w.world.bodies.len();
  w.setBounds(bounds);
  assert.equal(w.world.bodies.len(), before);
});
test((w) => {
  const b = book(w, 'a', v(0, 2, 0));
  w.startGrab(b, b.position.clone());
  w.cycleGrabPosture();
  near(b.quaternion.angleTo(q()), 0, 1e-6);
  advance(w, 2);
  assert.ok(b.quaternion.angleTo(q(0, Math.PI / 2)) < 0.1);
  w.cycleGrabPosture(); advance(w, 2);
  assert.ok(b.quaternion.angleTo(q(-Math.PI / 2)) < 0.1);
  w.removeBody(b);
  assert.equal(w.grab, null);
  assert.equal(w.world.bodies.len(), 0);
});
function shelfWithBounds(w) {
  board(w, 'bottom', v(0, 0.55, 0));
  board(w, 'middle', v(0, 2.25, 0));
  w.setBounds({ minX: -3, maxX: 3, minY: 0.63, maxY: 5.57 });
}
test((w) => {
  shelfWithBounds(w);
  const b = book(w, 'dropped', v(-0.6, 2.9, 0.05));
  advance(w, 3);
  assert.ok(b.shelfPose);
  const origin = b.position.clone();
  w.startGrab(b, b.position.clone());
  w.updateGrabTarget(v(-0.6, 2.9, 1.2));
  advance(w, 1.5);
  assert.ok(b.position.z > 1);
  w.endGrab();
  advance(w, 4);
  assert.ok(b.position.distanceTo(origin) < 0.03);
  assert.ok(b.linearVelocity.length() < 0.05);
  advance(w, 5);
  assert.ok(b.position.distanceTo(origin) < 0.03);
});
for (const position of [v(0.5, -100, 1.5), v(0.5, 0.65, 1.5), v(0.5, 3, 1.5)]) {
  test((w) => {
    shelfWithBounds(w);
    const b = book(w, 'restored', position, { rotation: q(0.4, 0.7, 0.2), velocity: v(0, -50, 0) });
    near(b.position.z, 0.05, 0.001);
    near(b.position.y, 1.193, 0.005);
    assert.equal(b.linearVelocity.length(), 0);
    advance(w, 6);
    near(b.position.y, 1.19, 0.015);
    assert.ok(b.sleeping);
    
    const saved = { position: b.position.clone(), rotation: b.quaternion.clone() };
    w.removeBody(b);
    const restored = book(w, 'restored-again', saved.position, { rotation: saved.rotation });
    advance(w, 3);
    assert.ok(restored.position.distanceTo(saved.position) < 0.02);
  });
}
test((w) => {
  shelfWithBounds(w);
  const rotation = q(0.3, 0.4, 0.1);
  const b = book(w, 'valid', v(0.5, 3.1, 0.3), { rotation });
  near(b.position.z, 0.3, 0.001);
  assert.ok(b.quaternion.angleTo(rotation) < 1e-6);
});
console.log(passed);
