import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { positionSchema } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { chebyshev } from '../../commu/world.js';
import { compactUser, compactUserSchema, runTool } from './shared.js';

const profileSchema = z.object({
  user: compactUserSchema,
  online: z.boolean(),
  position: positionSchema.optional(),
  distance: z.number().int().optional(),
});

export function registerUserTools(server: McpServer, session: CommuSession): void {
  const withDistance = (profile: {
    user: Parameters<typeof compactUser>[0];
    online: boolean;
    position?: { x: number; y: number; mapId: string; dir: 'up' | 'down' | 'left' | 'right' };
  }) => {
    const mine = session.world.me()?.position;
    return {
      user: compactUser(profile.user),
      online: profile.online,
      ...(profile.position ? { position: profile.position } : {}),
      ...(profile.position && mine && mine.mapId === profile.position.mapId
        ? { distance: chebyshev(mine, profile.position) }
        : {}),
    };
  };

  server.registerTool(
    'commu_search_users',
    {
      title: '닉네임 검색',
      description:
        '닉네임 부분 일치로 회원을 찾는다 (접속 여부 무관, 최대 20명, 본인 제외). DM 보낼 userId 를 얻을 때 쓴다.',
      inputSchema: z.object({ nickname: z.string().min(1).max(12).describe('검색어 (1자 이상)') }),
      outputSchema: z.object({ items: z.array(profileSchema) }),
      annotations: { readOnlyHint: true },
    },
    ({ nickname }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        const { items } = await session.client.searchUsers(nickname);
        return { items: items.map(withDistance) };
      }),
  );

  server.registerTool(
    'commu_get_user',
    {
      title: '프로필 조회',
      description:
        'userId 로 프로필 카드(닉네임·상태 메시지·접속 여부·위치)를 본다. 접속 중이면 나와의 거리도 준다.',
      inputSchema: z.object({ userId: z.string().min(1) }),
      outputSchema: profileSchema,
      annotations: { readOnlyHint: true },
    },
    ({ userId }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        return withDistance(await session.client.getUser(userId));
      }),
  );
}
