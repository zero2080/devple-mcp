import { describe, expect, it } from 'vitest';

import { ManualClock } from './clock.js';

describe('ManualClock', () => {
  it('advance 가 만료 순으로 타이머를 깨우고 취소된 것은 건너뛴다', async () => {
    const clock = new ManualClock(1000);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 200);
    clock.setTimeout(() => fired.push('a'), 100);
    const cancelled = clock.setTimeout(() => fired.push('x'), 150);
    cancelled.cancel();
    const slept = clock.sleep(250).then(() => fired.push('sleep'));

    await clock.advance(120);
    expect(fired).toEqual(['a']);
    expect(clock.now()).toBe(1120);
    await clock.advance(200);
    await slept;
    expect(fired).toEqual(['a', 'b', 'sleep']);
    expect(clock.pending).toBe(0);
  });
});
