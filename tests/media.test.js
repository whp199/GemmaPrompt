const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sampleTimes } = require('../web/media.js');

test('sampling includes opening and closing views in chronological order', () => {
  const times = sampleTimes(8, 8);
  assert.equal(times.length, 8);
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 7.95);
  assert.ok(times.every((n, i) => i === 0 || n > times[i - 1]));
});
test('short and long clips remain inside their duration', () => {
  for (const duration of [0.001, 0.025, 1, 36000]) {
    const times = sampleTimes(duration, 32);
    assert.ok(times.every(n => Number.isFinite(n) && n >= 0 && n < duration));
  }
});
test('invalid duration and frame counts fail clearly', () => {
  for (const duration of [0, -1, NaN, Infinity]) assert.throws(() => sampleTimes(duration, 8));
  for (const count of [0, 1, 1.5, 33, NaN]) assert.throws(() => sampleTimes(8, count));
});
