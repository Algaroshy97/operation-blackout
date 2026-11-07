'use strict';
class RampClock {
  constructor(scale) { this.scale = scale; this.next = null; }
  accept(samples) {
    if (!samples.length) throw new Error('empty ramp quantum');
    const first = Math.round(samples[0] * this.scale);
    if (this.next === null) this.next = first;
    for (const sample of samples) {
      const actual = Math.round(sample * this.scale);
      if (!Number.isFinite(sample) || actual !== this.next)
        throw new Error(`ramp discontinuity expected=${this.next} actual=${actual}`);
      this.next++;
    }
    return first;
  }
}
if (typeof module !== 'undefined') module.exports = {RampClock};
