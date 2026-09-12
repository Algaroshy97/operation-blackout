// ============ RAGDOLL DEATHS ============
'use strict';
// Death used to be a canned animation: the GLB 'die' clip, or a flat 90-degree
// rotation for the box-man, then the corpse sank through the floor. Every body fell
// the same way regardless of where it was shot, which way it was facing, or what it
// was standing on.
//
// The simulation is in CORE (verlet particles with distance constraints, ground and
// AABB collision) and is engine-free and tested. This module is only the glue that
// maps seven simulated points onto whichever body the agent happens to have:
//
//   GLB soldier - the rig is exactly seven bones (root, torso, head, arm-left,
//                 arm-right, leg-left, leg-right), so each bone is aimed down its
//                 own segment. If the rig ever stops matching, aiming is skipped and
//                 the body still tumbles from the root, which is the graceful
//                 degradation a hard-coded bone list would not give.
//   box-man     - the same seven points drive the existing part groups directly.
//
// Corpses are simulated only while they still have energy. A settled body stops
// costing anything, which is what makes running a dozen of them free.

const RAGDOLL_BUDGET = IS_TOUCH ? 4 : 10;   // concurrent simulating corpses
const ragdolls = [];

const _rdV = new THREE.Vector3();
const _rdV2 = new THREE.Vector3();
const _rdM = new THREE.Matrix4();
const _rdQ = new THREE.Quaternion();
const _rdUp = new THREE.Vector3(0, 1, 0);

// Which ragdoll node each rig bone should point at. A bone with no entry is left
// alone rather than guessed at.
const BONE_TARGET = {
  'torso': 'chest',
  'head': 'head',
  'arm-left': 'armL',
  'arm-right': 'armR',
  'leg-left': 'legL',
  'leg-right': 'legR'
};

function spawnRagdoll(en, impulse) {
  // Stop the animation system dead. A mixer still ticking would fight every bone
  // the ragdoll writes, and the result is a corpse that twitches.
  if (en.mixer) { en.mixer.stopAllAction(); en.mixer = null; }
  en.actions = null;

  const rag = CORE.makeRagdoll(en.pos.x, en.pos.y, en.pos.z, en.yaw);
  if (impulse) {
    CORE.ragdollImpulse(rag, impulse.node || 'chest',
      impulse.x, impulse.y, impulse.z, impulse.spread);
  }
  const bones = {};
  let boneCount = 0;
  en.parts.group.traverse(function (o) {
    if (o.isBone && BONE_TARGET[o.name]) { bones[o.name] = o; boneCount++; }
  });
  let root = null;
  en.parts.group.traverse(function (o) { if (o.isBone && o.name === 'root' && !root) root = o; });

  const entry = {
    en: en, rag: rag,
    bones: bones, root: root,
    useBones: boneCount >= 4 && !!root,
    box: en.parts.torso ? en.parts : null,
    t: 0, sunk: 0
  };
  // Box-man limbs are children of nested groups with their own offsets. Driving
  // them in world space means taking them out of that hierarchy first.
  if (!entry.useBones && entry.box) detachBoxParts(entry);
  ragdolls.push(entry);
  return entry;
}

const BOX_PART_NODE = { torso: 'chest', head: 'head', armL: 'armL', armR: 'armR', legL: 'legL', legR: 'legR' };

function detachBoxParts(entry) {
  const p = entry.box;
  entry.boxParts = [];
  for (const key in BOX_PART_NODE) {
    const obj = p[key];
    if (!obj) continue;
    obj.updateWorldMatrix(true, false);
    obj.matrixWorld.decompose(_rdV, _rdQ, _rdV2);
    scene.add(obj);                       // reparent, keeping the world pose
    obj.position.copy(_rdV);
    obj.quaternion.copy(_rdQ);
    obj.scale.copy(_rdV2);
    entry.boxParts.push({ obj: obj, node: BOX_PART_NODE[key] });
  }
}

// Aim a bone's local +Y at a world point. Works in the bone's PARENT space, which
// is the only place a hierarchical skeleton can be steered from without fighting
// its own transforms.
function aimBoneAt(bone, tx, ty, tz) {
  if (!bone || !bone.parent) return;
  bone.parent.updateWorldMatrix(true, false);
  _rdM.copy(bone.parent.matrixWorld).invert();
  _rdV.set(tx, ty, tz).applyMatrix4(_rdM).sub(bone.position);
  if (_rdV.lengthSq() < 1e-8) return;
  _rdV.normalize();
  bone.quaternion.setFromUnitVectors(_rdUp, _rdV);
}

function updateRagdolls(dt) {
  let simulating = 0;
  for (let i = ragdolls.length - 1; i >= 0; i--) {
    const e = ragdolls[i];
    e.t += dt;
    // Budget: the nearest few keep simulating, the rest freeze where they are.
    // A settled corpse costs nothing either way.
    const live = !e.rag.settled && simulating < RAGDOLL_BUDGET;
    if (live) { simulating++; CORE.ragdollStep(e.rag, Math.min(dt, 1 / 45), colliders, 0); }

    const n = e.rag.nodes;
    if (e.useBones) {
      // Root carries position and the spine's orientation; children are aimed.
      if (e.root) {
        e.root.parent.updateWorldMatrix(true, false);
        _rdM.copy(e.root.parent.matrixWorld).invert();
        _rdV.set(n.pelvis.x, n.pelvis.y, n.pelvis.z).applyMatrix4(_rdM);
        e.root.position.copy(_rdV);
      }
      for (const name in e.bones) {
        const target = n[BONE_TARGET[name]];
        if (target) aimBoneAt(e.bones[name], target.x, target.y, target.z);
      }
    } else if (e.boxParts) {
      for (let k = 0; k < e.boxParts.length; k++) {
        const bp = e.boxParts[k];
        const target = n[bp.node];
        if (!target) continue;
        bp.obj.position.set(target.x, target.y, target.z);
        // Point each limb back at the pelvis so the body reads as connected.
        _rdV.set(n.pelvis.x - target.x, n.pelvis.y - target.y, n.pelvis.z - target.z);
        if (_rdV.lengthSq() > 1e-8) {
          _rdV.normalize();
          bp.obj.quaternion.setFromUnitVectors(_rdUp, _rdV);
        }
      }
    }
    // Sink and remove, as before — but only once the body has actually stopped, so
    // a corpse never sinks mid-tumble.
    if (e.rag.settled && e.t > 3.5) {
      e.sunk += dt * 0.6;
      const drop = e.sunk;
      if (e.useBones && e.root) e.root.position.y -= drop * 0.02;
      else if (e.boxParts) for (let k = 0; k < e.boxParts.length; k++) e.boxParts[k].obj.position.y -= drop * 0.02;
      if (e.sunk > 1.6) {
        removeRagdoll(e);
        ragdolls.splice(i, 1);
      }
    }
  }
}

function removeRagdoll(e) {
  if (e.boxParts) {
    for (let k = 0; k < e.boxParts.length; k++) scene.remove(e.boxParts[k].obj);
  }
  if (e.en && e.en.parts && e.en.parts.group) {
    scene.remove(e.en.parts.group);
    disposeEnemyGeometry(e.en);
  }
}

function resetRagdolls() {
  for (let i = ragdolls.length - 1; i >= 0; i--) removeRagdoll(ragdolls[i]);
  ragdolls.length = 0;
}

// Live count, for the probe and for anything that wants to assert corpses are
// actually being cleaned up.
function ragdollCount() { return ragdolls.length; }
