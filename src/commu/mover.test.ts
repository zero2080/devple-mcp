import { describe, expect, it } from 'vitest';

import { ManualClock } from './clock.js';
import { CommuApiError } from './errors.js';
import type { MapGrid } from './map.js';
import { MAX_REPLANS, MAX_TILES, MAX_TILES_PER_REQUEST, Mover } from './mover.js';
import type { Position, PositionRejectedReason } from './schemas.js';
import { chebyshev, type TilePoint } from './world.js';

function grid(width: number, height: number, walls: Array<[number, number]> = []): MapGrid {
  const collision = new Array<number>(width * height).fill(0);
  for (const [x, y] of walls) collision[y * width + x] = 1;
  return { id: 'test', width, height, spawn: { x: 20, y: 15 }, collision };
}

const at = (x: number, y: number, dir: Position['dir'] = 'down'): Position => ({
  mapId: 'main',
  x,
  y,
  dir,
});

/** 서버 흉내: 마지막 인정 위치에서 체비쇼프 3 초과면 too_far, 점유면 occupied. rejectNext 로 강제 거부 */
class ServerSim {
  readonly requests: Array<Position & { seq: number }> = [];
  readonly sentAt: number[] = [];
  readonly occupied = new Set<string>();
  readonly rejectNext: PositionRejectedReason[] = [];

  constructor(
    public accepted: Position,
    private readonly clock: ManualClock,
  ) {}

  readonly put = async (body: Position & { seq: number }): Promise<void> => {
    this.requests.push(body);
    this.sentAt.push(this.clock.now());
    const forced = this.rejectNext.shift();
    const reason =
      forced ??
      (chebyshev(this.accepted, body) > MAX_TILES_PER_REQUEST
        ? 'too_far'
        : this.occupied.has(`${String(body.x)},${String(body.y)}`)
          ? 'occupied'
          : null);
    if (reason) {
      throw new CommuApiError(409, 'POSITION_REJECTED', `이동 거부: ${reason}`, {
        position: this.accepted,
        seq: body.seq - 1,
        reason,
      });
    }
    this.accepted = { mapId: body.mapId, x: body.x, y: body.y, dir: body.dir };
  };
}

interface Harness {
  clock: ManualClock;
  server: ServerSim;
  mover: Mover;
  accepted: Position[];
}

function harness(
  start: Position,
  opts: {
    map?: MapGrid;
    others?: () => TilePoint[];
    tileMs?: number;
    batchMs?: number;
    maxTiles?: number;
  } = {},
): Harness {
  const clock = new ManualClock();
  const server = new ServerSim(start, clock);
  const accepted: Position[] = [];
  let lastSeq = 0;
  const mover = new Mover({
    clock,
    map: opts.map ?? grid(40, 30),
    occupied: opts.others ?? (() => []),
    putPosition: server.put,
    nextSeq: () => {
      lastSeq = Math.max(clock.now(), lastSeq + 1);
      return lastSeq;
    },
    onAccepted: (p) => accepted.push(p),
    tileMs: opts.tileMs ?? 0,
    batchMs: opts.batchMs ?? 0,
    ...(opts.maxTiles !== undefined ? { maxTiles: opts.maxTiles } : {}),
  });
  return { clock, server, mover, accepted };
}

/** 시계를 stepMs 씩 밀며 이동이 끝날 때까지 기다린다 (ManualClock 은 sleep 마다 한 번씩 밀어야 깨어난다) */
async function drive<T>(clock: ManualClock, promise: Promise<T>, stepMs = 150): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  for (let i = 0; i < 2000 && !settled; i++) {
    await clock.advance(stepMs);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return tracked;
}

describe('Mover (MCP.md 5.3 commu_move_to 동작)', () => {
  it('타일당 150ms 로 걷고 200ms 마다 전송: 요청마다 3칸 이내, seq 는 보낸 시각, 40타일에서 partial', async () => {
    const h = harness(at(1, 1), { tileMs: 150, batchMs: 200 });
    const start = h.clock.now();
    const result = await drive(h.clock, h.mover.run(at(1, 1), { x: 38, y: 28 }));
    expect(result).toMatchObject({
      status: 'partial',
      tilesMoved: MAX_TILES,
      rejections: 0,
      replans: 0,
      remainingTiles: 37 + 27 - MAX_TILES,
    });
    expect(h.clock.now() - start).toBe(MAX_TILES * 150);
    // 150ms 씩 걷다 200ms 가 지나면 보낸다 → 300ms 마다 2칸
    expect(h.server.requests).toHaveLength(MAX_TILES / 2);
    expect(h.server.sentAt.map((t) => t - start)).toEqual(
      Array.from({ length: MAX_TILES / 2 }, (_, i) => (i + 1) * 300),
    );
    let prev: TilePoint = at(1, 1);
    for (const [i, req] of h.server.requests.entries()) {
      expect(chebyshev(prev, req)).toBeLessThanOrEqual(MAX_TILES_PER_REQUEST);
      expect(req.seq).toBe(h.server.sentAt[i]);
      if (i > 0) expect(req.seq).toBeGreaterThan(h.server.requests[i - 1]!.seq);
      prev = req;
    }
    expect(result.position).toEqual(h.server.accepted);
    expect(h.accepted).toHaveLength(MAX_TILES / 2);
  });

  it('409 occupied 는 그 칸을 피해 다시 계산하고, too_far·collision 은 서버가 준 위치에서 다시 계산한다', async () => {
    const h = harness(at(20, 15));
    h.server.occupied.add('20,18'); // 월드는 모르는 끼어든 사람
    const result = await drive(h.clock, h.mover.run(at(20, 15), { x: 20, y: 21 }));
    expect(result).toMatchObject({
      status: 'arrived',
      position: { x: 20, y: 21 },
      rejections: 1,
      replans: 1,
      remainingTiles: 0,
    });
    const tried = h.server.requests.map((r) => `${String(r.x)},${String(r.y)}`);
    expect(tried.filter((t) => t === '20,18')).toHaveLength(1);
    expect(result.tilesMoved).toBe(h.server.requests.length - 1);

    const far = harness(at(20, 15));
    far.server.rejectNext.push('too_far');
    const back = await drive(far.clock, far.mover.run(at(20, 15), { x: 20, y: 17 }));
    expect(back).toMatchObject({ status: 'arrived', rejections: 1, replans: 1, tilesMoved: 2 });
    expect(far.server.requests).toHaveLength(3);
  });

  it('재계산을 다 쓴 뒤 장애물이면 blocked, 위치는 서버가 인정한 것', async () => {
    const h = harness(at(20, 15));
    for (let i = 0; i <= MAX_REPLANS; i++) h.server.rejectNext.push('too_far');
    const result = await drive(h.clock, h.mover.run(at(20, 15), { x: 20, y: 20 }));
    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'too_far',
      position: at(20, 15),
      tilesMoved: 0,
      rejections: MAX_REPLANS + 1,
      replans: MAX_REPLANS,
      remainingTiles: 5,
    });
  });

  it('걷는 중 눈앞에 사람이 들어오면(월드) 409 없이 다시 계산한다', async () => {
    const others: TilePoint[] = [];
    const h = harness(at(20, 15), { others: () => others });
    const original = h.server.put;
    let first = true;
    (h.server as { put: typeof original }).put = async (body) => {
      await original(body);
      if (first) {
        first = false;
        others.push({ x: 20, y: 18 });
      }
    };
    const mover = new Mover({
      clock: h.clock,
      map: grid(40, 30),
      occupied: () => others,
      putPosition: (body) => h.server.put(body),
      nextSeq: () => h.clock.now(),
      onAccepted: () => undefined,
      tileMs: 0,
      batchMs: 0,
    });
    const result = await drive(h.clock, mover.run(at(20, 15), { x: 20, y: 21 }));
    expect(result).toMatchObject({ status: 'arrived', rejections: 0, replans: 1 });
    expect(h.server.requests.some((r) => r.x === 20 && r.y === 18)).toBe(false);
  });

  it('점유된 목적지는 직전 칸까지 가서 그쪽을 보고, 이미 옆이면 요청 없이 arrived. face 는 도착 방향', async () => {
    const h = harness(at(20, 15), { others: () => [{ x: 23, y: 15 }] });
    const result = await drive(h.clock, h.mover.run(at(20, 15), { x: 23, y: 15 }));
    expect(result).toMatchObject({
      status: 'arrived',
      goal: { x: 22, y: 15 },
      position: at(22, 15, 'right'),
      tilesMoved: 2,
      remainingTiles: 0,
    });
    const adjacent = await drive(h.clock, h.mover.run(at(22, 15, 'right'), { x: 23, y: 15 }));
    expect(adjacent).toMatchObject({ status: 'arrived', requests: 0, goal: { x: 22, y: 15 } });

    const facing = harness(at(23, 18));
    const up = await drive(
      facing.clock,
      facing.mover.run(at(23, 18), { x: 23, y: 16 }, { face: { x: 23, y: 15 } }),
    );
    expect(up.position).toEqual(at(23, 16, 'up'));
    const side = await drive(
      facing.clock,
      facing.mover.run(at(23, 16, 'up'), { x: 22, y: 15 }, { face: { x: 23, y: 15 } }),
    );
    expect(side.position).toEqual(at(22, 15, 'right'));
  });

  it('목적지가 벽이면 blocked(collision), 갇혀 있으면 no_path — 요청 없음', async () => {
    const walled = grid(40, 30, [
      [25, 15],
      [19, 14],
      [20, 14],
      [21, 14],
      [19, 15],
      [21, 15],
      [19, 16],
      [20, 16],
      [21, 16],
    ]);
    const h = harness(at(20, 15), { map: walled });
    expect(await drive(h.clock, h.mover.run(at(20, 15), { x: 25, y: 15 }))).toMatchObject({
      status: 'blocked',
      reason: 'collision',
      requests: 0,
    });
    expect(await drive(h.clock, h.mover.run(at(20, 15), { x: 30, y: 15 }))).toMatchObject({
      status: 'blocked',
      reason: 'no_path',
      requests: 0,
      remainingTiles: 10,
    });
    expect(await drive(h.clock, h.mover.run(at(20, 15), { x: -1, y: 15 }))).toMatchObject({
      status: 'blocked',
      reason: 'collision',
    });
  });
});
