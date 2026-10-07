// 읽기(C2)·행동(C3) 도구의 결과 모양 (MCP.md 5). 다른 사용자가 쓴 값(닉네임·상태 메시지·메시지 본문·그룹 이름)은
// untrusted 아래에만 둔다 (MCP.md 6.1). 내가 쓴 메시지 본문만 content 로 그대로 둔다.
import { z } from 'zod';

import type { InboxItem, PublicItem } from '../../commu/inbox.js';
import {
  directionSchema,
  epochMs,
  groupRoleSchema,
  positionSchema,
  presenceStateSchema,
  userKindSchema,
  type DmMessage,
  type Group,
  type GroupListItem,
  type GroupMember,
  type GroupMessage,
  type PublicMessage,
  type UserProfile,
} from '../../commu/schemas.js';
import { untrusted } from '../../commu/untrusted.js';
import { chebyshev, type NearbyPresence } from '../../commu/world.js';

/** 누가 — 식별자와 kind 만. 닉네임은 항목의 untrusted 에 */
export const senderSchema = z.object({ userId: z.string(), kind: userKindSchema.optional() });

const tileSchema = z.object({ x: z.number().int(), y: z.number().int() });

/* ---------- commu_look_around ---------- */

export const personNearbySchema = z.object({
  userId: z.string(),
  kind: userKindSchema,
  distance: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  dir: directionSchema,
  state: presenceStateSchema,
  untrusted: z.object({ nickname: z.string() }),
});

export function personNearby(p: NearbyPresence) {
  return {
    userId: p.userId,
    kind: p.kind,
    distance: p.distance,
    x: p.x,
    y: p.y,
    dir: p.dir,
    state: p.state,
    ...untrusted({ nickname: p.nickname }),
  };
}

export const heardSchema = z.object({
  cursor: z.number().int(),
  at: epochMs,
  messageId: z.string(),
  from: senderSchema,
  position: tileSchema,
  links: z.array(z.string()),
  untrusted: z.object({ nickname: z.string(), content: z.string() }),
});

export function heard(item: PublicItem) {
  return {
    cursor: item.cursor,
    at: item.at,
    messageId: item.messageId,
    from: sender(item.from),
    position: item.position,
    links: item.links,
    ...untrusted({ nickname: item.from.nickname, content: item.untrusted.content }),
  };
}

/* ---------- commu_find_user ---------- */

export const foundUserSchema = z.object({
  userId: z.string(),
  kind: userKindSchema,
  ownerId: z.string().optional(),
  online: z.boolean(),
  position: positionSchema.optional(),
  distance: z.number().int().optional(),
  untrusted: z.object({ nickname: z.string(), statusMessage: z.string().optional() }),
});

export function foundUser(
  profile: UserProfile,
  mine: { x: number; y: number; mapId: string } | undefined,
) {
  const { user, position } = profile;
  return {
    userId: user.id,
    kind: user.kind,
    ...(user.ownerId !== undefined ? { ownerId: user.ownerId } : {}),
    online: profile.online,
    ...(position ? { position } : {}),
    ...(position && mine && mine.mapId === position.mapId
      ? { distance: chebyshev(mine, position) }
      : {}),
    ...untrusted({ nickname: user.nickname, statusMessage: user.statusMessage }),
  };
}

/* ---------- commu_read_inbox ---------- */

const itemBase = { cursor: z.number().int(), at: epochMs };

export const inboxViewSchema = z.discriminatedUnion('type', [
  z.object({
    ...itemBase,
    type: z.literal('public'),
    messageId: z.string(),
    from: senderSchema,
    position: tileSchema,
    links: z.array(z.string()),
    untrusted: z.object({ nickname: z.string(), content: z.string() }),
  }),
  z.object({
    ...itemBase,
    type: z.literal('dm'),
    messageId: z.string(),
    conversationId: z.string(),
    from: senderSchema,
    links: z.array(z.string()),
    untrusted: z.object({ nickname: z.string(), content: z.string() }),
  }),
  z.object({
    ...itemBase,
    type: z.literal('dm_recalled'),
    messageId: z.string(),
    conversationId: z.string(),
  }),
  z.object({
    ...itemBase,
    type: z.literal('group'),
    messageId: z.string(),
    groupId: z.string(),
    from: senderSchema,
    links: z.array(z.string()),
    untrusted: z.object({ nickname: z.string(), content: z.string() }),
  }),
  z.object({
    ...itemBase,
    type: z.literal('group_change'),
    groupId: z.string(),
    change: z.enum(['joined', 'updated', 'removed']),
    reason: z.enum(['kicked', 'dissolved', 'left']).optional(),
    ownerId: z.string().optional(),
    memberCount: z.number().int().optional(),
    untrusted: z.object({ name: z.string() }).optional(),
  }),
  z.object({
    ...itemBase,
    type: z.literal('notice'),
    noticeId: z.string(),
    createdBy: z.string(),
    untrusted: z.object({ content: z.string() }),
  }),
]);
export type InboxView = z.infer<typeof inboxViewSchema>;

export function inboxView(item: InboxItem): InboxView {
  const base = { cursor: item.cursor, at: item.at };
  switch (item.type) {
    case 'public':
      return { ...base, type: 'public', ...heardFields(item) };
    case 'dm':
      return {
        ...base,
        type: 'dm',
        messageId: item.messageId,
        conversationId: item.conversationId,
        from: sender(item.from),
        links: item.links,
        ...untrusted({ nickname: item.from.nickname, content: item.untrusted.content }),
      };
    case 'dm_recalled':
      return {
        ...base,
        type: 'dm_recalled',
        messageId: item.messageId,
        conversationId: item.conversationId,
      };
    case 'group':
      return {
        ...base,
        type: 'group',
        messageId: item.messageId,
        groupId: item.groupId,
        from: sender(item.from),
        links: item.links,
        ...untrusted({ nickname: item.from.nickname, content: item.untrusted.content }),
      };
    case 'group_change':
      return {
        ...base,
        type: 'group_change',
        groupId: item.groupId,
        change: item.change,
        ...(item.reason !== undefined ? { reason: item.reason } : {}),
        ...(item.ownerId !== undefined ? { ownerId: item.ownerId } : {}),
        ...(item.memberCount !== undefined ? { memberCount: item.memberCount } : {}),
        ...(item.untrusted !== undefined ? untrusted({ name: item.untrusted.name }) : {}),
      };
    case 'notice':
      return {
        ...base,
        type: 'notice',
        noticeId: item.noticeId,
        createdBy: item.createdBy,
        ...untrusted({ content: item.untrusted.content }),
      };
  }
}

/* ---------- commu_dm_history · commu_group_history · commu_list_groups ---------- */

export const messageViewSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  mine: z.boolean(),
  createdAt: epochMs,
  readAt: epochMs.optional(),
  links: z.array(z.string()),
  /** 내가 보낸 메시지만 */
  content: z.string().optional(),
  /** 다른 사람이 보낸 메시지 */
  untrusted: z.object({ content: z.string() }).optional(),
});

export function messageView(message: DmMessage | GroupMessage, myUserId: string | undefined) {
  const mine = message.senderId === myUserId;
  return {
    id: message.id,
    senderId: message.senderId,
    mine,
    createdAt: message.createdAt,
    ...(message.kind === 'dm' && message.readAt !== undefined ? { readAt: message.readAt } : {}),
    links: message.links,
    ...(mine ? { content: message.content } : untrusted({ content: message.content })),
  };
}

export const groupViewSchema = z.object({
  groupId: z.string(),
  ownerId: z.string(),
  owner: z.boolean(),
  memberCount: z.number().int(),
  unreadCount: z.number().int(),
  createdAt: epochMs,
  lastMessage: messageViewSchema.optional(),
  untrusted: z.object({ name: z.string() }),
});

export function groupView(group: GroupListItem, myUserId: string | undefined) {
  return {
    groupId: group.id,
    ownerId: group.ownerId,
    owner: group.ownerId === myUserId,
    memberCount: group.memberCount,
    unreadCount: group.unreadCount,
    createdAt: group.createdAt,
    ...(group.lastMessage ? { lastMessage: messageView(group.lastMessage, myUserId) } : {}),
    ...untrusted({ name: group.name }),
  };
}

/* ---------- C3 행동 도구 (MCP.md 5.3) ---------- */

/** 내가 방금 보낸 메시지. 내 글이라 content 를 그대로 둔다 (mine: true) */
export const sentMessageSchema = z.object({
  id: z.string(),
  kind: z.enum(['public', 'dm', 'group']),
  mine: z.literal(true),
  createdAt: epochMs,
  links: z.array(z.string()),
  content: z.string(),
  conversationId: z.string().optional(),
  groupId: z.string().optional(),
  position: positionSchema.optional(),
});

export function sentMessage(message: PublicMessage | DmMessage | GroupMessage) {
  return {
    id: message.id,
    kind: message.kind,
    mine: true as const,
    createdAt: message.createdAt,
    links: message.links,
    content: message.content,
    ...(message.kind === 'dm' ? { conversationId: message.conversationId } : {}),
    ...(message.kind === 'group' ? { groupId: message.groupId } : {}),
    ...(message.kind === 'public' ? { position: message.position } : {}),
  };
}

/** commu_say 를 들었을 사람 (반경 안 접속자) */
export const listenerSchema = z.object({
  userId: z.string(),
  kind: userKindSchema,
  distance: z.number().int(),
  untrusted: z.object({ nickname: z.string() }),
});

export function listener(p: NearbyPresence) {
  return {
    userId: p.userId,
    kind: p.kind,
    distance: p.distance,
    ...untrusted({ nickname: p.nickname }),
  };
}

/** 방금 만든 그룹. 이름은 내가 넘긴 값이라 돌려주지 않는다 (남이 바꿀 수 없다 — owner 만 이름을 바꾼다) */
export const createdGroupSchema = z.object({
  groupId: z.string(),
  ownerId: z.string(),
  memberCount: z.number().int(),
  createdAt: epochMs,
});

export function createdGroup(group: Group) {
  return {
    groupId: group.id,
    ownerId: group.ownerId,
    memberCount: group.memberCount,
    createdAt: group.createdAt,
  };
}

/** 초대한 멤버 (즉시 가입) */
export const memberSchema = z.object({
  groupId: z.string(),
  userId: z.string(),
  role: groupRoleSchema,
  joinedAt: epochMs,
});

export function member(m: GroupMember) {
  return { groupId: m.groupId, userId: m.userId, role: m.role, joinedAt: m.joinedAt };
}

/* ---------- 내부 ---------- */

function sender(from: { userId: string; kind?: 'human' | 'ai' }) {
  return from.kind !== undefined
    ? { userId: from.userId, kind: from.kind }
    : { userId: from.userId };
}

function heardFields(item: PublicItem) {
  const { cursor: _cursor, at: _at, ...rest } = heard(item);
  return rest;
}
