// DOMAIN.md의 타입을 그대로 옮긴 파일. 각 블록의 주석은 DOMAIN.md 섹션 번호다.
// 서버 응답 타입에 프론트 전용 필드를 섞지 않는다 (CONVENTIONS 4장). 파생 타입은 ./view.ts.

/* ---------- 3. 사용자 · 인증 ---------- */

// 3.1 User
export type UserRole = 'member' | 'admin';
export type UserStatus = 'active' | 'suspended';
export type UserKind = 'human' | 'ai';

export interface User {
  id: string;
  nickname: string; // 2~12자, 유니크
  appearance: Appearance; // 외형 (3.7)
  statusMessage?: string; // 최대 40자
  kind: UserKind; // 3.8. 'ai'면 화면에 항상 AI 배지
  ownerId?: string; // kind='ai'일 때만. 이 AI를 만든 회원 (항상 human)
  role: UserRole;
  status: UserStatus;
  createdAt: number;
}

// 3.2 UserProfile (캐릭터 클릭 시 조회)
export interface UserProfile {
  user: User;
  online: boolean;
  position?: Position; // 접속 중일 때만
}

// 3.3 Me (본인 확장 정보)
export interface Me extends User {
  email?: string; // kind='human'이면 항상 있음. AI는 없음
  phone?: string; // kind='human'이면 항상 있음. AI는 없음
  nicknameChangeableAt?: number; // 다음에 닉네임을 바꿀 수 있는 시각(epoch ms). 지금 바꿀 수 있으면 키 생략 (DOMAIN 2.6 8장)
}

// 3.4 SignupRequest
export type SignupStatus = 'pending' | 'approved' | 'rejected';

export interface SignupRequest {
  id: string;
  email: string;
  nickname: string;
  phone: string;
  status: SignupStatus;
  rejectReason?: string;
  createdAt: number;
  reviewedAt?: number;
  reviewedBy?: string; // admin userId
}

// 3.5 AccessKey (프론트는 값만 입력, 엔티티 조회 없음)
export interface AccessKeyLogin {
  accessKey: string; // 이메일로 받은 키, 형식은 백엔드 정의
}

export interface AuthSession {
  accessToken: string; // JWT, 메모리 보관
  expiresIn: number; // 초
  me: Me;
  config: ServerConfig;
}

// 3.6 ServerConfig (로그인 응답에 포함)
export interface ServerConfig {
  proximityRadius: number; // 근접 반경 (타일), 기본 5
  positionBatchMs: number; // 이동 전송 주기, 기본 200
  serverTickMs: number; // 위치 브로드캐스트 주기, 기본 200
  maxMessageLength: number; // 기본 200
  defaultMapId: string;
  maxGroupMembers: number; // 기본 10
  avatarOptions: AvatarOptions; // 외형 선택지의 원천 (GRAPHICS 2.7·2.8)
  maxAiPerMember: number; // 회원당 AI 수 상한, 기본 2 (3.8)
  maxTokensPerAi: number; // AI당 활성 토큰 수 상한, 기본 2
}

/** 3.6 ServerConfig.avatarOptions. 목록마다 순서 있음(선택 UI 순서), 비어 있지 않음, 누구나 처음부터 고를 수 있다 */
export interface AvatarOptions {
  itemIds: string[]; // ID 접두사로 슬롯을 판별 ('hat_beanie' → hat)
  skinRampIds: string[];
  hairRampIds: string[];
  itemRampIds: string[]; // primary·secondary 공통
}

// 3.7 Appearance (캐릭터 외형)
export type SlotId = 'hair' | 'hat' | 'face' | 'top' | 'bottom' | 'shoes' | 'hand';

export interface EquippedItem {
  itemId: string; // '<slot>_<name>' (GRAPHICS 2.8). 접두사 = 들어간 슬롯 키
  primary?: string; // itemRampId. 생략 시 아이템 기본색
  secondary?: string; // itemRampId. 생략 시 아이템 기본색
}

/** 모든 키가 항상 존재한다. 선택 슬롯이 비면 null. PATCH /me는 전체 교체 */
export interface Appearance {
  skin: string; // skinRampId
  hairColor: string; // hairRampId
  hair: EquippedItem | null; // null = 민머리. hair.primary는 쓰지 않는다 (머리색은 hairColor)
  hat: EquippedItem | null;
  face: EquippedItem | null;
  top: EquippedItem; // 필수
  bottom: EquippedItem; // 필수
  shoes: EquippedItem; // 필수
  hand: EquippedItem | null;
}

/* ---------- 4. 공간 · 위치 ---------- */

// 3.8 AI 계정 (사용자 결정 2026-10-07) — 주인이 발급한 AI 토큰으로 MCP 서버가 로그인한다
export interface AiTokenInfo {
  id: string;
  label?: string; // 주인이 붙이는 이름 (예: '내 맥북'). 최대 40자
  createdAt: number;
  lastUsedAt?: number; // 마지막 로그인 교환 시각
}

export interface AiTokenIssued extends AiTokenInfo {
  token: string; // 평문. 발급 응답에서 딱 한 번만 나간다
}

// GET /me/ai 항목: kind='ai', ownerId=나
export interface MyAi extends User {
  tokens: AiTokenInfo[];
  online: boolean;
}

// 4.1 Position
export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Position {
  mapId: string;
  x: number; // 타일 X (0-based)
  y: number; // 타일 Y
  dir: Direction;
}

// 4.2 Presence (접속 중인 사용자 1명의 월드 상태)
export type PresenceState = 'online' | 'away';

export interface Presence {
  userId: string;
  nickname: string; // 스냅샷에 포함해 User 조회 없이 렌더
  appearance: Appearance; // 3.7
  kind: UserKind; // AI 배지를 User 조회 없이 그리기 위해
  position: Position;
  state: PresenceState;
  updatedAt: number;
}

// 4.3 MapData (정적 자산)
export interface MapData {
  id: string;
  width: number; // 타일 수
  height: number;
  tileSize: 16;
  tileset: string; // 타일셋 ID (GRAPHICS 3장). 맵당 1개
  spawn: { x: number; y: number };
  layers: TileLayer[]; // 그리기 순서대로. 표준 구성은 GRAPHICS 4장 (floor / objects / overhead)
  collision: number[]; // width*height, 0=통행 1=차단
}

export interface TileLayer {
  name: string;
  order: 'below' | 'above'; // 캐릭터 아래/위
  tiles: number[]; // width*height, 타일셋 인덱스 (-1=빈칸)
}

/* ---------- 5. 메시지 ---------- */

// 5.1 공통
export interface MessageBase {
  id: string;
  senderId: string;
  content: string; // 1~maxMessageLength자, 공백만은 불가
  links: string[]; // 서버가 content에서 추출한 URL 목록 (없으면 [])
  createdAt: number;
}

// 5.2 PublicMessage (근접 공개 대화)
export interface PublicMessage extends MessageBase {
  kind: 'public';
  position: Position; // 발화 시점 위치 (수신 대상 판정 근거)
}

// 5.3 DmMessage / DmConversation
export interface DmConversation {
  id: string;
  participantIds: [string, string];
  lastMessage?: DmMessage;
  unreadCount: number; // 조회자 기준
  updatedAt: number;
}

export interface DmMessage extends MessageBase {
  kind: 'dm';
  conversationId: string;
  readAt?: number; // 상대가 읽은 시각
}

// 5.4 Group / GroupMember / GroupMessage
export interface Group {
  id: string;
  name: string; // 2~20자
  ownerId: string;
  memberCount: number;
  createdAt: number;
}

export type GroupRole = 'owner' | 'member';

export interface GroupMember {
  groupId: string;
  userId: string;
  role: GroupRole;
  joinedAt: number;
  lastReadMessageId?: string;
}

export interface GroupMessage extends MessageBase {
  kind: 'group';
  groupId: string;
}

// 5.5 Message 유니온
export type Message = PublicMessage | DmMessage | GroupMessage;

/* ---------- 6. 운영 ---------- */

// 6.1 Notice (운영자 공지)
export interface Notice {
  id: string;
  content: string;
  createdBy: string;
  createdAt: number;
}

/* ---------- 9. API 응답·이벤트 합성 타입 (zod 스키마 원천) ---------- */
// 읽기 전용 응답 형태. 스토어·캐시에는 기본 엔티티로 분해해 저장한다 (이중 저장 금지).

// 2.6 GET /dm
export interface DmConversationWithPeer extends DmConversation {
  peer: User; // 조회자 관점의 상대
}

// 2.7 GET /groups
export interface GroupListItem extends Group {
  unreadCount: number; // 조회자 기준
  lastMessage?: GroupMessage;
}

// 2.7 GET /groups/{id}, SSE group.updated
export interface GroupMemberWithUser extends GroupMember {
  user: User;
}

export interface GroupDetail {
  group: Group;
  members: GroupMemberWithUser[];
}

// SSE chat.public
export interface ChatPublicEvent extends PublicMessage {
  sender: Pick<User, 'nickname'>; // 발화자는 같은 맵 접속자라 외형은 Presence에 이미 있다
}

// SSE chat.dm
export interface ChatDmEvent extends DmMessage {
  sender: User;
  peerId: string; // 수신자 관점의 상대. 발신자 자기 사본에는 수신자 ID
}

// SSE chat.group
export interface ChatGroupEvent extends GroupMessage {
  sender: User;
}

// SSE group.updated
export interface GroupUpdatedEvent extends Group {
  members: GroupMemberWithUser[];
}
