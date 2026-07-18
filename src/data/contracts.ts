export type ActorType = "human" | "chat_bot" | "mod_bot";

export interface Actor {
  id: string;
  handle: string | null;
  displayName: string;
  discriminator: string | null;
  registered: boolean;
  display: string;
  profilePictureId: string | null;
  profilePictureUrl: string | null;
  type: ActorType;
  policyVersionAccepted: string | null;
  policyAcceptedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
}

export interface ParticipationPolicy {
  version: string;
  moderationAccess: string;
  trainingUse: string;
  retention: string;
}

export interface RoomRule {
  id: string;
  title: string;
  text: string;
}

export interface RoomRules {
  version: string;
  ethos: string;
  rules: RoomRule[];
}

export interface ActorSession {
  token: string;
  expiresAt: string;
}

// Who a message is directed at, matching the backend content contract:
// the whole room, or specific actors. Absent or empty means a general
// comment addressed to no one in particular.
export type ContentAddress =
  | { targetType: "room" }
  | { targetType: "actor"; actorId: string };

export type MediaKind = "image" | "audio" | "video" | "file";

export interface MediaAsset {
  contractVersion: 1;
  entityType: "media_asset";
  mediaAssetId: string;
  roomId: string;
  ownerActorId: string;
  mediaKind: MediaKind;
  originalFilename: string;
  declaredMediaType: string;
  detectedMediaType?: string;
  byteLength: string;
  lifecycleState: string;
  createdAt: string;
}

export type ContentPartInput =
  | { kind: "text"; text: string }
  | {
      kind: MediaKind;
      mediaAssetId: string;
      caption?: string;
      altText?: string;
    };

export interface RoomEvent {
  sequence: string;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface RoomOverview {
  room: {
    id: string;
    name: string;
    actorsOnline: number;
    chatBotsOnline: number;
    modBotsOnline: number;
  };
  moderation: {
    proposalsPending: number;
    proposalsAccepted: number;
    proposalsRejected: number;
  };
  runtime: {
    backend: string;
    eventStream: string;
    persistence: string;
  };
}

export interface RoomRoster {
  actors: Actor[];
}

export interface ServiceHealth {
  status: string;
  service: string;
  dependencies?: Record<string, string>;
}

export interface RealtimeConfig {
  version: number;
  primary: {
    transport: "webtransport";
    url: string;
    serverCertificateHashes: Array<{
      algorithm: string;
      value: number[];
    }>;
  };
  fallback: {
    transport: "websocket";
    url: string;
  };
}

export interface ReliableRoomEnvelope {
  version: 1;
  delivery: "reliable";
  channel: "room.event";
  roomId: string;
  sequence: string;
  source: "replay" | "live";
  event: RoomEvent;
}

export type RealtimeStatus =
  | {
      state: "connecting" | "reconnecting";
      transport: null;
      detail: string;
    }
  | {
      state: "connected";
      transport: "webtransport" | "websocket";
      detail: string;
    }
  | {
      state: "offline";
      transport: null;
      detail: string;
    };
