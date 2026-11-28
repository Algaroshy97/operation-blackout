// LAN duel netcode — pure rules that both the browser runtime and these tests use.
// Run: node --test tests/test_lan_netcode.js
//
// These exercise the wire contract (input sanitising, snapshot validation, the
// host-side movement integrator and the host-side hit test) directly from
// src/01_core.js, so a broken protocol fails here instead of only on two phones.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CORE = require(path.join(__dirname, '..', 'src', '01_core.js'));

test('lanSanitizeInput clamps a hostile input frame and keeps a monotonic seq', () => {
  const clean = CORE.lanSanitizeInput({ seq: 12, mx: 5, mz: -5, yaw: 1e9, pitch: 9, buttons: 0xffff, px: NaN, pz: 'x' });
  assert.equal(clean.seq, 12);
  assert.ok(clean.mx <= 1 && clean.mx >= -1);
  assert.ok(clean.mz <= 1 && clean.mz >= -1);
  assert.ok(Math.abs(clean.yaw) <= Math.PI);
  assert.ok(Math.abs(clean.pitch) <= 1.55);
  assert.equal(clean.buttons, 0xffff);
  assert.equal(clean.px, null, 'non-finite position hints are dropped, not forwarded');
  assert.equal(clean.pz, null);
  const junk = CORE.lanSanitizeInput({ seq: -3, mx: 'a', mz: null });
  assert.equal(junk.seq, 0);
  assert.equal(junk.mx, 0);
  assert.equal(junk.mz, 0);
  assert.equal(CORE.lanSanitizeInput(null).seq, 0);
});

test('lanStepActor walks in the facing direction and reports displacement', () => {
  const st = { x: 0, z: 0, y: 1.7, yaw: Math.PI, pitch: 0 };
  // Engine convention: the camera looks down -Z rotated by yaw, so yaw = PI
  // faces +Z (that is the spawn yaw the player starts with).
  const fwd = CORE.lanStepActor(st, { mx: 0, mz: 1, yaw: Math.PI, pitch: 0 }, 0.1, { speed: 5.2 });
  assert.ok(Math.abs(fwd.moved - 0.52) < 1e-6, 'one 100 ms step at 5.2 m/s, got ' + fwd.moved);
  assert.ok(Math.abs(fwd.x) < 1e-6 && fwd.z > 0.5, 'forward is +Z at yaw PI, got ' + JSON.stringify(fwd));
  // A stalled frame must not teleport the guest: dt is clamped like the render loop.
  const clamped = CORE.lanStepActor(st, { mx: 0, mz: 1, yaw: Math.PI }, 5.0, { speed: 5.2 });
  assert.ok(Math.abs(clamped.moved - 0.52) < 1e-6, 'dt clamps to 0.1 s, got ' + clamped.moved);

  const strafe = CORE.lanStepActor({ x: 0, z: 0, y: 1.7, yaw: Math.PI }, { mx: 1, mz: 0, yaw: Math.PI }, 0.1, { speed: 5.2 });
  assert.ok(Math.abs(strafe.x) > 0.5 && Math.abs(strafe.z) < 1e-6, 'strafe is perpendicular to facing');

  const idle = CORE.lanStepActor({ x: 3, z: 3, y: 1.7, yaw: 0 }, { mx: 0, mz: 0 }, 0.1, { speed: 5.2 });
  assert.equal(idle.moved, 0);
  assert.equal(idle.x, 3);
  assert.equal(idle.z, 3);
});

test('lanStepActor carries a diagonal input at the same speed as a straight one', () => {
  const d = CORE.lanStepActor({ x: 0, z: 0, y: 1.7, yaw: 0 }, { mx: 1, mz: 1, yaw: 0 }, 0.1, { speed: 6 });
  assert.ok(Math.abs(d.moved - 0.6) < 0.001, 'normalised diagonal: ' + d.moved);
});

test('lanResolveMove stops an actor at a wall instead of passing through it', () => {
  const colliders = [{ min: { x: -2, y: 0, z: 2 }, max: { x: 2, y: 4, z: 3 } }];
  const out = CORE.lanResolveMove(0, 0, 0, 5, 0.35, 0, 1.7, colliders);
  assert.ok(out.z < 2, 'actor must stay in front of the wall, got z=' + out.z);
  assert.ok(out.z > 1.4, 'actor must advance up to the wall, got z=' + out.z);

  const free = CORE.lanResolveMove(0, 0, 0, -5, 0.35, 0, 1.7, colliders);
  assert.ok(Math.abs(free.z + 5) < 1e-6, 'no wall behind, full step lands');
});

test('lanValidSnapshot rejects malformed frames and normalises a good one', () => {
  assert.equal(CORE.lanValidSnapshot(null), null);
  assert.equal(CORE.lanValidSnapshot({ t: 's', tick: 1 }), null, 'no actors');
  assert.equal(CORE.lanValidSnapshot({ t: 's', tick: 1, actors: [{ slot: 1 }] }), null, 'no pose');
  const snap = CORE.lanValidSnapshot({
    t: 's', tick: 44, target: 10,
    actors: [
      { slot: 0, x: 1, y: 1.7, z: 2, yaw: 0.5, pitch: -0.2, hp: 77, alive: true, kills: 3 },
      { slot: 1, x: -4, y: 1.7, z: 8, yaw: 2, pitch: 0.1, hp: 0, alive: false, kills: 4 }
    ],
    over: false
  });
  assert.ok(snap);
  assert.equal(snap.tick, 44);
  assert.equal(snap.actors.length, 2);
  assert.equal(snap.actors[0].hp, 77);
  assert.equal(snap.actors[1].alive, false);
  assert.equal(snap.target, 10);
});

test('lanRayCapsule registers a body shot, a headshot and a clean miss', () => {
  const body = CORE.lanRayCapsule(0, 1.2, -6, 0, 0, 1, 40, 0, 0, 0, 1.8, 0.35);
  assert.ok(body > 0 && body < 7, 'body hit distance ' + body);
  const head = CORE.lanRayCapsule(0, 1.62, -6, 0, 0, 1, 40, 0, 0, 0, 1.8, 0.35);
  const miss = CORE.lanRayCapsule(3, 1.2, -6, 0, 0, 1, 40, 0, 0, 0, 1.8, 0.35);
  assert.ok(head > 0);
  assert.equal(miss, -1);
  const behind = CORE.lanRayCapsule(0, 1.2, -6, 0, 0, -1, 40, 0, 0, 0, 1.8, 0.35);
  assert.equal(behind, -1, 'shooting away from the target is a miss');
});

test('lanDuelResult settles at the target score without inventing a winner', () => {
  assert.equal(CORE.lanDuelResult(4, 2, 10), null);
  assert.equal(CORE.lanDuelResult(10, 2, 10), 'host');
  assert.equal(CORE.lanDuelResult(9, 10, 10), 'guest');
  assert.equal(CORE.lanDuelResult(10, 10, 10), 'draw');
  assert.equal(CORE.lanDuelResult(NaN, 2, 10), null);
});
