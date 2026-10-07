// DOMAIN 3.7 Appearance, 3.6 avatarOptions. 모든 키가 항상 존재 — 선택 슬롯은 null로 명시 (부분 객체 없음)
import { z } from 'zod';

export const slotIdSchema = z.enum(['hair', 'hat', 'face', 'top', 'bottom', 'shoes', 'hand']);

export const equippedItemSchema = z.object({
  itemId: z.string(),
  primary: z.string().optional(),
  secondary: z.string().optional(),
});

export const appearanceSchema = z.object({
  skin: z.string(),
  hairColor: z.string(),
  hair: equippedItemSchema.nullable(),
  hat: equippedItemSchema.nullable(),
  face: equippedItemSchema.nullable(),
  top: equippedItemSchema,
  bottom: equippedItemSchema,
  shoes: equippedItemSchema,
  hand: equippedItemSchema.nullable(),
});

export const avatarOptionsSchema = z.object({
  itemIds: z.array(z.string()).min(1),
  skinRampIds: z.array(z.string()).min(1),
  hairRampIds: z.array(z.string()).min(1),
  itemRampIds: z.array(z.string()).min(1),
});
