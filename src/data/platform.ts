import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type {
  Actor,
  ActorSession,
  ContentAddress,
  ParticipationPolicy,
  RealtimeConfig,
  RoomEvent,
  RoomOverview,
  RoomRules,
  ServiceHealth,
} from "./contracts";

const apiBaseUrl =
  import.meta.env.VITE_MODBOTS_API_URL ?? "http://localhost:3001";
const realtimeConfigUrl =
  import.meta.env.VITE_MODBOTS_REALTIME_CONFIG_URL ??
  "http://localhost:3002/v1/realtime/config";
const realtimeHealthUrl =
  import.meta.env.VITE_MODBOTS_REALTIME_HEALTH_URL ??
  "http://localhost:3002/health";

export class PlatformRequestError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null,
  ) {
    super(message);
  }
}

export const isMutedError = (error: unknown): boolean =>
  error instanceof PlatformRequestError &&
  error.status === 409 &&
  error.code === "actor_muted";

let sessionToken: string | null = null;

export const setSessionToken = (token: string | null): void => {
  sessionToken = token;
};

export const fetchRequest = (
  url: string,
  init?: RequestInit,
): Promise<Response> =>
  isTauri() ? tauriFetch(url, init) : globalThis.fetch(url, init);

const requestJson = async <Result>(
  url: string,
  init?: RequestInit,
): Promise<Result> => {
  const headers = new Headers(init?.headers);

  if (sessionToken !== null) {
    headers.set("authorization", `Bearer ${sessionToken}`);
  }

  const response = await fetchRequest(url, { ...init, headers });

  if (!response.ok) {
    let detail = response.statusText;
    let code: string | null = null;

    try {
      const body = (await response.json()) as {
        error?: unknown;
        message?: unknown;
      };

      if (typeof body.error === "string") {
        code = body.error;
        detail = body.error.replace(/_/g, " ");
      }

      if (typeof body.message === "string") {
        detail = body.message;
      }
    } catch {
      // The status code and status text still provide a useful error.
    }

    throw new PlatformRequestError(
      response.status,
      `${response.status} ${detail}`.trim(),
      code,
    );
  }

  return (await response.json()) as Result;
};

const apiUrl = (path: string): string =>
  new URL(path, apiBaseUrl).toString();

export const platformEndpoints = {
  api: apiBaseUrl,
  realtime: new URL(realtimeConfigUrl).origin,
};

export const getApiHealth = (): Promise<ServiceHealth> =>
  requestJson(apiUrl("/health"));

export const getRealtimeHealth = (): Promise<ServiceHealth> =>
  requestJson(realtimeHealthUrl);

export const getRealtimeConfig = (): Promise<RealtimeConfig> =>
  requestJson(realtimeConfigUrl);

export const getRoomOverview = (roomId: string): Promise<RoomOverview> =>
  requestJson(apiUrl(`/api/rooms/${encodeURIComponent(roomId)}/overview`));

export const getActor = (actorId: string): Promise<Actor> =>
  requestJson(apiUrl(`/api/actors/${encodeURIComponent(actorId)}`));

export const getParticipationPolicy = (): Promise<ParticipationPolicy> =>
  requestJson(apiUrl("/api/policy"));

export const getRoomRules = (): Promise<RoomRules> =>
  requestJson(apiUrl("/api/rules"));

export interface JoinOutcome {
  actor: Actor;
  session: ActorSession | null;
}

// The backend currently returns a bare Actor at 201 and is gaining sessions,
// after which it returns { actor, session }. Accept both shapes.
type JoinResponse = Actor | { actor: Actor; session?: ActorSession | null };

const normalizeJoinResponse = (payload: JoinResponse): JoinOutcome =>
  "actor" in payload
    ? { actor: payload.actor, session: payload.session ?? null }
    : { actor: payload, session: null };

export const joinAsGuest = async (
  displayName: string | null,
  acceptPolicy: boolean,
): Promise<JoinOutcome> =>
  normalizeJoinResponse(
    await requestJson<JoinResponse>(apiUrl("/api/guests"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        acceptPolicy,
        ...(displayName === null ? {} : { displayName }),
      }),
    }),
  );

// The browser sign-in hand-off's final step: the access token from the
// account site is exchanged at the backend for a platform session.
export const exchangeAccountToken = (
  accessToken: string,
): Promise<{ actor: Actor; session: { token: string; expiresAt: string } }> =>
  requestJson(apiUrl("/api/sessions/exchange"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken }),
  });

export const setRoomPresence = (
  roomId: string,
  actorId: string,
  state: "joined" | "left",
): Promise<RoomEvent> =>
  requestJson(apiUrl(`/api/rooms/${encodeURIComponent(roomId)}/presence`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId, state }),
  });

export const postRoomMessage = (
  roomId: string,
  actorId: string,
  content: string,
  replyTo?: { contentItemId: string },
  addressedTo?: ContentAddress[],
): Promise<RoomEvent> =>
  requestJson(apiUrl(`/api/rooms/${encodeURIComponent(roomId)}/messages`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorId,
      content,
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(addressedTo === undefined || addressedTo.length === 0
        ? {}
        : { addressedTo }),
    }),
  });

export const getRoomEvents = async (roomId: string): Promise<RoomEvent[]> => {
  const events: RoomEvent[] = [];
  let cursor = "0";

  while (true) {
    const page = await requestJson<{
      data: RoomEvent[];
      nextCursor: string;
    }>(
      apiUrl(
        `/api/rooms/${encodeURIComponent(roomId)}/events?after=${cursor}&limit=500`,
      ),
    );

    events.push(...page.data);

    if (page.data.length < 500 || page.nextCursor === cursor) {
      return events;
    }

    cursor = page.nextCursor;
  }
};
