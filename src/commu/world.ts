import type {
  Position,
  Presence,
  PresenceUpdatedPayload,
  WorldPositionsPayload,
  WorldSnapshotPayload,
} from './schemas.js';

export interface TilePoint {
  x: number;
  y: number;
}

export interface NearbyPresence {
  userId: string;
  nickname: string;
  kind: Presence['kind'];
  x: number;
  y: number;
  dir: Position['dir'];
  state: Presence['state'];
  distance: number;
  inRadius: boolean;
}

/** 체비쇼프 거리 (DOMAIN 5.2: 정사각 범위) */
export function chebyshev(a: TilePoint, b: TilePoint): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * 서버가 SSE 로 보내 주는 월드 상태의 메모리 사본. 내 위치는 PUT /me/position 응답으로만 바꾼다
 * (world.positions 의 본인 항목은 무시 — API_CONTRACT 3.3).
 */
export class WorldState {
  mapId: string | null = null;
  myUserId: string | null = null;
  serverTimeOffsetMs = 0;
  private presences = new Map<string, Presence>();

  applySnapshot(snapshot: WorldSnapshotPayload, now: number = Date.now()): void {
    this.mapId = snapshot.mapId;
    this.serverTimeOffsetMs = snapshot.serverTime - now;
    this.presences = new Map(snapshot.presences.map((p) => [p.userId, p]));
  }

  applyPositions(payload: WorldPositionsPayload): void {
    for (const pos of payload.positions) {
      if (pos.userId === this.myUserId) continue;
      const current = this.presences.get(pos.userId);
      if (!current) continue;
      this.presences.set(pos.userId, {
        ...current,
        position: { ...current.position, x: pos.x, y: pos.y, dir: pos.dir },
      });
    }
  }

  applyJoined(presence: Presence): void {
    this.presences.set(presence.userId, presence);
  }

  applyLeft(payload: { userId: string }): void {
    this.presences.delete(payload.userId);
  }

  applyUpdated(payload: PresenceUpdatedPayload): void {
    const current = this.presences.get(payload.userId);
    if (!current) return;
    this.presences.set(payload.userId, {
      ...current,
      ...(payload.state !== undefined ? { state: payload.state } : {}),
      ...(payload.nickname !== undefined ? { nickname: payload.nickname } : {}),
      ...(payload.appearance !== undefined ? { appearance: payload.appearance } : {}),
    });
  }

  setMyPosition(position: Position, now: number = Date.now()): void {
    const me = this.me();
    if (!me) return;
    this.presences.set(me.userId, { ...me, position, updatedAt: now });
  }

  me(): Presence | undefined {
    return this.myUserId ? this.presences.get(this.myUserId) : undefined;
  }

  all(): Presence[] {
    return [...this.presences.values()];
  }

  others(): Presence[] {
    return this.all().filter((p) => p.userId !== this.myUserId);
  }

  get size(): number {
    return this.presences.size;
  }

  occupantAt(tile: TilePoint, excludeUserId?: string): Presence | undefined {
    for (const p of this.presences.values()) {
      if (p.userId === excludeUserId) continue;
      if (p.position.x === tile.x && p.position.y === tile.y) return p;
    }
    return undefined;
  }

  /** 다른 접속자를 거리순으로. from 을 주지 않으면 내 위치 기준 */
  nearby(radius: number, from?: TilePoint): NearbyPresence[] {
    const origin = from ?? this.me()?.position;
    if (!origin) return [];
    return this.others()
      .map((p) => {
        const distance = chebyshev(origin, p.position);
        return {
          userId: p.userId,
          nickname: p.nickname,
          kind: p.kind,
          x: p.position.x,
          y: p.position.y,
          dir: p.position.dir,
          state: p.state,
          distance,
          inRadius: distance <= radius,
        };
      })
      .sort((a, b) => a.distance - b.distance || a.nickname.localeCompare(b.nickname));
  }

  clear(): void {
    this.mapId = null;
    this.presences.clear();
  }
}
