// MCP.md 1.1 (5.2): commu_get_appearance — 현재 외형과 고를 수 있는 선택지. 토큰 교환 때 받은 me·config.avatarOptions 만 쓰고
// 입장하지 않는다 (SSE 없음). 리소스가 아니라 도구인 이유: 많은 클라이언트에서 리소스는 사용자가 직접 첨부해야 한다 (사용자 결정 2026-10-08).
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { appearanceSchema, slotIdSchema, type ServerConfig } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { runTool } from './shared.js';

type SlotId = z.infer<typeof slotIdSchema>;

const SLOTS: readonly SlotId[] = ['hair', 'hat', 'face', 'top', 'bottom', 'shoes', 'hand'];
/** DOMAIN 3.7: top·bottom·shoes 는 필수, 나머지는 null 가능 */
const REQUIRED_SLOTS: readonly SlotId[] = ['top', 'bottom', 'shoes'];

export const appearanceOptionsSchema = z.object({
  /** 슬롯별 아이템 ID (itemId 접두사 `<slot>_` 로 분류, DOMAIN 3.7) */
  slots: z.object({
    hair: z.array(z.string()),
    hat: z.array(z.string()),
    face: z.array(z.string()),
    top: z.array(z.string()),
    bottom: z.array(z.string()),
    shoes: z.array(z.string()),
    hand: z.array(z.string()),
  }),
  requiredSlots: z.array(slotIdSchema),
  skinRampIds: z.array(z.string()),
  hairRampIds: z.array(z.string()),
  itemRampIds: z.array(z.string()),
  /** 어느 슬롯 접두사도 아닌 아이템 ID — 있으면 서버 설정이 계약(DOMAIN 3.7)과 어긋난 것 */
  other: z.array(z.string()).optional(),
});

export function appearanceOptions(avatar: ServerConfig['avatarOptions']) {
  const slots: Record<SlotId, string[]> = {
    hair: [],
    hat: [],
    face: [],
    top: [],
    bottom: [],
    shoes: [],
    hand: [],
  };
  const other: string[] = [];
  for (const itemId of avatar.itemIds) {
    const prefix = itemId.slice(0, itemId.indexOf('_'));
    const slot = SLOTS.find((s) => s === prefix);
    if (slot) slots[slot].push(itemId);
    else other.push(itemId);
  }
  return {
    slots,
    requiredSlots: [...REQUIRED_SLOTS],
    skinRampIds: avatar.skinRampIds,
    hairRampIds: avatar.hairRampIds,
    itemRampIds: avatar.itemRampIds,
    ...(other.length > 0 ? { other } : {}),
  };
}

export function registerAppearanceTool(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_get_appearance',
    {
      title: '내 외형과 선택지',
      description:
        '내 현재 외형(current — skin·hairColor 램프 ID와 슬롯별 아이템)과 고를 수 있는 선택지(options — 슬롯별 아이템 ID, 피부·머리·아이템 램프 ID, 필수 슬롯)를 돌려준다. ' +
        '아이템 ID 는 hat_beanie 처럼 슬롯과 모양이 드러나는 이름이다. 외형을 바꾸려면 이걸 먼저 보고 commu_update_profile 에 바꿀 슬롯만 고친 ' +
        '전체 appearance 를 보낸다 (부분 수정 없음). 입장하지 않고 토큰만 쓴다.',
      inputSchema: z.object({}),
      outputSchema: z.object({ current: appearanceSchema, options: appearanceOptionsSchema }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () =>
      runTool(session, async () => {
        await session.authorize();
        const me = session.me;
        const config = session.serverConfig;
        if (!me || !config) throw new Error('내 정보를 아직 받지 못했어요. 다시 시도하세요.');
        return { current: me.appearance, options: appearanceOptions(config.avatarOptions) };
      }),
  );
}
