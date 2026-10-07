/**
 * 시간 의존(유휴 퇴장, 토큰 재교환, 이동 간격)을 테스트에서 제어하기 위한 시계 주입점.
 */
export interface ClockTimer {
  cancel(): void;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(fn: () => void, ms: number): ClockTimer;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

interface Scheduled {
  at: number;
  seq: number;
  fn: () => void;
}

/** 테스트용. `advance(ms)` 로 시간을 밀면 그 사이 만료된 타이머·sleep 이 순서대로 깨어난다 */
export class ManualClock implements Clock {
  private current: number;
  private seq = 0;
  private scheduled: Scheduled[] = [];

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  setTimeout(fn: () => void, ms: number): ClockTimer {
    const entry: Scheduled = { at: this.current + Math.max(0, ms), seq: ++this.seq, fn };
    this.scheduled.push(entry);
    return {
      cancel: () => {
        this.scheduled = this.scheduled.filter((s) => s !== entry);
      },
    };
  }

  get pending(): number {
    return this.scheduled.length;
  }

  /** 시간을 ms 만큼 민다. 만료 순(같으면 등록 순)으로 콜백을 실행하고, 마이크로태스크가 돌도록 한 번 양보한다 */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.scheduled
        .filter((s) => s.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.scheduled = this.scheduled.filter((s) => s !== due);
      this.current = Math.max(this.current, due.at);
      due.fn();
      await Promise.resolve();
    }
    this.current = target;
    await Promise.resolve();
  }
}
