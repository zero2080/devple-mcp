// DOMAIN 5·6·9장 메시지·그룹·공지·합성 타입 스키마
import { z } from 'zod';

import { epochMs } from './common.js';
import { userSchema } from './user.js';
import { positionSchema } from './world.js';

const messageBaseShape = {
  id: z.string(),
  senderId: z.string(),
  content: z.string(),
  links: z.array(z.string()),
  createdAt: epochMs,
};

export const messageBaseSchema = z.object(messageBaseShape);

export const publicMessageSchema = z.object({
  ...messageBaseShape,
  kind: z.literal('public'),
  position: positionSchema,
});

export const dmMessageSchema = z.object({
  ...messageBaseShape,
  kind: z.literal('dm'),
  conversationId: z.string(),
  readAt: epochMs.optional(),
});

export const dmConversationSchema = z.object({
  id: z.string(),
  participantIds: z.tuple([z.string(), z.string()]),
  lastMessage: dmMessageSchema.optional(),
  unreadCount: z.number().int().nonnegative(),
  updatedAt: epochMs,
});

export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  memberCount: z.number().int().nonnegative(),
  createdAt: epochMs,
});

export const groupRoleSchema = z.enum(['owner', 'member']);

export const groupMemberSchema = z.object({
  groupId: z.string(),
  userId: z.string(),
  role: groupRoleSchema,
  joinedAt: epochMs,
  lastReadMessageId: z.string().optional(),
});

export const groupMessageSchema = z.object({
  ...messageBaseShape,
  kind: z.literal('group'),
  groupId: z.string(),
});

export const messageSchema = z.discriminatedUnion('kind', [
  publicMessageSchema,
  dmMessageSchema,
  groupMessageSchema,
]);

export const noticeSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdBy: z.string(),
  createdAt: epochMs,
});

/* ---------- 9장 합성 타입 ---------- */

export const dmConversationWithPeerSchema = dmConversationSchema.extend({
  peer: userSchema,
});

export const groupListItemSchema = groupSchema.extend({
  unreadCount: z.number().int().nonnegative(),
  lastMessage: groupMessageSchema.optional(),
});

export const groupMemberWithUserSchema = groupMemberSchema.extend({
  user: userSchema,
});

export const groupDetailSchema = z.object({
  group: groupSchema,
  members: z.array(groupMemberWithUserSchema),
});

export const chatPublicEventSchema = publicMessageSchema.extend({
  sender: userSchema.pick({ nickname: true }),
});

export const chatDmEventSchema = dmMessageSchema.extend({
  sender: userSchema,
  peerId: z.string(),
});

export const chatGroupEventSchema = groupMessageSchema.extend({
  sender: userSchema,
});

export const groupUpdatedEventSchema = groupSchema.extend({
  members: z.array(groupMemberWithUserSchema),
});
