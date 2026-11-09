'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const CORE = require(path.join(__dirname, '..', 'src', '01_core.js'));

test('Stage4 per-mode stats migrate old careers without loss and are idempotently sanitized', () => {
  const old = { bestScore: 42, totalKills: 7, xp: 91, mapStats: { urban: { bestScore: 42, bestWave: 2 } } };
  const one = CORE.sanitizeStats(old), two = CORE.sanitizeStats(one);
  assert.equal(one.totalKills, 7); assert.deepEqual(JSON.parse(JSON.stringify(one)), JSON.parse(JSON.stringify(two)));
  for (const id of ['survival', 'tdm', 'ffa', 'domination', 'gun-game']) {
    assert.deepEqual(JSON.parse(JSON.stringify(one.modeStats[id])), { kills: 0, deaths: 0, shotsFired: 0, shotsHit: 0, wins: 0, weaponKills: {} });
  }
});

test('Stage4 merge records per-mode player kills/deaths, pellet-safe accuracy, favourite weapon, and wins', () => {
  const first = CORE.mergeRunIntoStats({}, { modeId: 'tdm', kills: 4, deaths: 2, shotsFired: 3, shotsHit: 2, weaponKills: { M4: 3, M870: 1 }, win: true });
  const second = CORE.mergeRunIntoStats(first.stats, { modeId: 'tdm', kills: 1, deaths: 1, shotsFired: 2, shotsHit: 1, weaponKills: { M870: 2 }, win: false, countRun: false });
  const s = second.stats.modeStats.tdm;
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { kills: 5, deaths: 3, shotsFired: 5, shotsHit: 3, wins: 1, weaponKills: { M4: 3, M870: 3 } });
  assert.equal(CORE.modeFavoriteWeapon(s), 'M4');
  assert.equal(CORE.modeAccuracy(s), 60);
});

test('Stage4 never lets early exit award a win/loss while keeping observed combat totals', () => {
  const r = CORE.mergeRunIntoStats({}, { modeId: 'ffa', kills: 2, deaths: 1, shotsFired: 4, shotsHit: 1, weaponKills: { AK: 2 }, complete: false });
  assert.equal(r.stats.modeStats.ffa.wins, 0);
  assert.equal(r.stats.modeStats.ffa.kills, 2);
  assert.equal(r.stats.modeStats.ffa.deaths, 1);
});
