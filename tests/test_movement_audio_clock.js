'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RampClock } = require('../scripts/movement_audio_clock.js');

function samples(start, count, scale = 1000000) {
  return Float32Array.from({length: count}, (_, i) => (start + i) / scale);
}

test('ramp sequence survives metadata anomalies but rejects missing and duplicate samples', () => {
  const clock = new RampClock(1000000);
  assert.equal(clock.accept(samples(10000, 128)), 10000);
  assert.equal(clock.accept(samples(10128, 128)), 10128);
  for (const offset of [1, -1, 128, -128]) {
    const negative = new RampClock(1000000);
    negative.accept(samples(10000, 128));
    assert.throws(() => negative.accept(samples(10128 + offset, 128)), /ramp discontinuity/);
  }
});

test('ramp rejects a missing or duplicate sample within a quantum', () => {
  for (const offset of [1, -1]) {
    const data = samples(20000, 128);
    data.set(samples(20064 + offset, 64), 64);
    assert.throws(() => new RampClock(1000000).accept(data), /ramp discontinuity/);
  }
});
