import { z } from 'zod';

import type { CommuHttp } from './http.js';
import {
  dmConversationWithPeerSchema,
  dmMessageSchema,
  groupDetailSchema,
  groupListItemSchema,
  groupMemberSchema,
  groupMessageSchema,
  groupSchema,
  meResponseSchema,
  meSchema,
  paginated,
  positionSchema,
  publicMessageSchema,
  sseTicketResponseSchema,
  userProfileSchema,
  worldChunksResponseSchema,
  worldPresencesResponseSchema,
  type Appearance,
  type Position,
  type PresenceState,
} from './schemas.js';

export interface PageQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface PatchMeBody {
  nickname?: string;
  statusMessage?: string;
  appearance?: Appearance;
}

const dmPageSchema = paginated(dmMessageSchema);
const dmListSchema = paginated(dmConversationWithPeerSchema);
const groupPageSchema = paginated(groupMessageSchema);
const groupListSchema = z.object({ items: z.array(groupListItemSchema) });
const userSearchSchema = z.object({ items: z.array(userProfileSchema) });

const enc = encodeURIComponent;

/** API_CONTRACT 2.1~2.7 회원용 엔드포인트. 운영자(2.8)는 포함하지 않는다 */
export class CommuClient {
  constructor(private readonly http: CommuHttp) {}

  // 2.1
  requestTicket() {
    return this.http.request('POST', '/sse/ticket', { schema: sseTicketResponseSchema });
  }

  // 2.2
  getMe() {
    return this.http.request('GET', '/me', { schema: meResponseSchema });
  }
  patchMe(body: PatchMeBody) {
    return this.http.request('PATCH', '/me', { body, schema: meSchema });
  }
  putPosition(body: Position & { seq: number }) {
    return this.http.request<void>('PUT', '/me/position', { body });
  }
  putPresence(state: PresenceState) {
    return this.http.request<void>('PUT', '/me/presence', { body: { state } });
  }
  /** 마을 귀환: 원점 스폰(점유면 가까운 빈 칸)으로 순간이동. 내 모든 연결에 새 world.snapshot 이 온다. 10초에 1번 */
  goHome() {
    return this.http.request('POST', '/me/position/home', { schema: positionSchema });
  }

  // 2.3
  getUser(userId: string) {
    return this.http.request('GET', `/users/${enc(userId)}`, { schema: userProfileSchema });
  }
  searchUsers(nickname: string) {
    return this.http.request('GET', '/users', { query: { nickname }, schema: userSearchSchema });
  }

  // 2.4
  getPresences(mapId: string) {
    return this.http.request('GET', `/world/${enc(mapId)}/presences`, {
      schema: worldPresencesResponseSchema,
    });
  }
  /** 지상 월드 청크: (cx, cy) 중심 한 변 2r+1 (조회는 생성을 일으키지 않는다) */
  getChunks(mapId: string, cx: number, cy: number, r: number) {
    return this.http.request('GET', `/world/${enc(mapId)}/chunks`, {
      query: { cx: String(cx), cy: String(cy), r: String(r) },
      schema: worldChunksResponseSchema,
    });
  }

  // 2.5
  sendPublic(content: string) {
    return this.http.request('POST', '/chat/public', {
      body: { content },
      schema: publicMessageSchema,
    });
  }

  // 2.6
  listDm(cursor?: string) {
    return this.http.request('GET', '/dm', { query: { cursor }, schema: dmListSchema });
  }
  dmHistory(userId: string, page: PageQuery = {}) {
    return this.http.request('GET', `/dm/${enc(userId)}/messages`, {
      query: { cursor: page.cursor, limit: page.limit },
      schema: dmPageSchema,
    });
  }
  sendDm(userId: string, content: string) {
    return this.http.request('POST', `/dm/${enc(userId)}/messages`, {
      body: { content },
      schema: dmMessageSchema,
    });
  }
  recallDm(messageId: string) {
    return this.http.request<void>('POST', `/dm/messages/${enc(messageId)}/recall`);
  }
  readDm(userId: string, lastMessageId: string) {
    return this.http.request<void>('POST', `/dm/${enc(userId)}/read`, { body: { lastMessageId } });
  }

  // 2.7
  listGroups() {
    return this.http.request('GET', '/groups', { schema: groupListSchema });
  }
  getGroup(groupId: string) {
    return this.http.request('GET', `/groups/${enc(groupId)}`, { schema: groupDetailSchema });
  }
  createGroup(name: string) {
    return this.http.request('POST', '/groups', { body: { name }, schema: groupSchema });
  }
  renameGroup(groupId: string, name: string) {
    return this.http.request('PATCH', `/groups/${enc(groupId)}`, {
      body: { name },
      schema: groupSchema,
    });
  }
  dissolveGroup(groupId: string) {
    return this.http.request<void>('DELETE', `/groups/${enc(groupId)}`);
  }
  inviteMember(groupId: string, userId: string) {
    return this.http.request('POST', `/groups/${enc(groupId)}/members`, {
      body: { userId },
      schema: groupMemberSchema,
    });
  }
  removeMember(groupId: string, userId: string) {
    return this.http.request<void>('DELETE', `/groups/${enc(groupId)}/members/${enc(userId)}`);
  }
  groupHistory(groupId: string, page: PageQuery = {}) {
    return this.http.request('GET', `/groups/${enc(groupId)}/messages`, {
      query: { cursor: page.cursor, limit: page.limit },
      schema: groupPageSchema,
    });
  }
  sendGroup(groupId: string, content: string) {
    return this.http.request('POST', `/groups/${enc(groupId)}/messages`, {
      body: { content },
      schema: groupMessageSchema,
    });
  }
  readGroup(groupId: string, lastMessageId: string) {
    return this.http.request<void>('POST', `/groups/${enc(groupId)}/read`, {
      body: { lastMessageId },
    });
  }
}
