import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type {
  Actor,
  RealtimeStatus,
  RoomEvent,
} from "../data/contracts";
import {
  clearStoredIdentity,
  loadStoredIdentity,
  saveStoredIdentity,
} from "../data/identity";
import type { StoredIdentity } from "../data/identity";
import {
  getActor,
  getApiHealth,
  getParticipationPolicy,
  getRoomRules,
  getRealtimeConfig,
  getRealtimeHealth,
  getRoomEvents,
  getRoomOverview,
  joinAsGuest,
  PlatformRequestError,
  postRoomMessage,
  registerActor,
  setRoomPresence,
  setSessionToken,
} from "../data/platform";
import { runWebSocket, runWebTransport } from "../data/realtime";
import { mergeEvents, onlineActorIds } from "../data/room-state";

export interface JoinRequest {
  mode: "guest" | "register";
  username: string;
  displayName: string;
  acceptPolicy: boolean;
}

const reconnectDelayMilliseconds = 1_000;

const restoreIdentity = (): StoredIdentity | null => {
  const identity = loadStoredIdentity();
  setSessionToken(identity?.token ?? null);
  return identity;
};

const wait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export const useRoomActivity = (roomId: string) => {
  const queryClient = useQueryClient();
  const [identity, setIdentity] = useState<StoredIdentity | null>(
    restoreIdentity,
  );
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>({
    state: "connecting",
    transport: null,
    detail: "Connecting to the room event stream",
  });
  const eventsKey = useMemo(() => ["room-events", roomId] as const, [roomId]);
  const overviewKey = useMemo(
    () => ["room-overview", roomId] as const,
    [roomId],
  );

  const apiHealth = useQuery({
    queryKey: ["api-health"],
    queryFn: getApiHealth,
    refetchInterval: 5_000,
    retry: 1,
  });
  const realtimeHealth = useQuery({
    queryKey: ["realtime-health"],
    queryFn: getRealtimeHealth,
    refetchInterval: 5_000,
    retry: 1,
  });
  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: () => getRoomOverview(roomId),
    retry: 1,
  });
  const events = useQuery({
    queryKey: eventsKey,
    queryFn: async () => {
      const persisted = await getRoomEvents(roomId);
      const existing = queryClient.getQueryData<RoomEvent[]>(eventsKey);
      return mergeEvents(existing, persisted);
    },
    retry: 1,
  });
  const policy = useQuery({
    queryKey: ["participation-policy"],
    queryFn: getParticipationPolicy,
    enabled: identity === null,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const rules = useQuery({
    queryKey: ["room-rules"],
    queryFn: getRoomRules,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const desktopSession = useQuery({
    queryKey: ["desktop-session", roomId, identity?.actorId ?? "none"],
    enabled: identity !== null,
    queryFn: async (): Promise<Actor | null> => {
      if (identity === null) {
        return null;
      }

      let actor: Actor;

      try {
        actor = await getActor(identity.actorId);
      } catch (error) {
        if (error instanceof PlatformRequestError && error.status === 404) {
          return null;
        }

        throw error;
      }

      if (actor.retiredAt !== null) {
        return null;
      }

      await setRoomPresence(roomId, actor.id, "joined");
      return actor;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  const localActor = desktopSession.data ?? undefined;

  // A stored identity that resolves to a missing or retired actor is stale:
  // drop it and fall back to the join screen.
  useEffect(() => {
    if (identity !== null && desktopSession.data === null) {
      clearStoredIdentity();
      setSessionToken(null);
      setIdentity(null);
    }
  }, [identity, desktopSession.data]);

  const join = useMutation({
    mutationFn: async (request: JoinRequest): Promise<StoredIdentity> => {
      const displayName = request.displayName.trim();
      const outcome =
        request.mode === "guest"
          ? await joinAsGuest(
              displayName.length === 0 ? null : displayName,
              request.acceptPolicy,
            )
          : await registerActor(
              request.username.trim(),
              displayName.length === 0 ? null : displayName,
              request.acceptPolicy,
            );
      const stored: StoredIdentity = {
        actorId: outcome.actor.id,
        token: outcome.session?.token ?? null,
      };

      saveStoredIdentity(stored);
      setSessionToken(stored.token);
      return stored;
    },
    onSuccess: (stored) => {
      // The desktop session query validates the new identity and joins the
      // room through the presence endpoint, the same path a restart takes.
      setIdentity(stored);
    },
  });
  const sendMessage = useMutation({
    mutationFn: async (message: {
      content: string;
      replyTo?: { contentItemId: string };
    }) => {
      if (localActor === undefined) {
        throw new Error("Join the room before sending messages.");
      }

      return postRoomMessage(
        roomId,
        localActor.id,
        message.content,
        message.replyTo,
      );
    },
    onSuccess: (event) => {
      queryClient.setQueryData<RoomEvent[]>(eventsKey, (existing) =>
        mergeEvents(existing, [event]),
      );
      void queryClient.invalidateQueries({ queryKey: overviewKey });
    },
  });
  const signOut = async (): Promise<void> => {
    const actorId = identity?.actorId ?? null;

    if (actorId !== null) {
      try {
        await setRoomPresence(roomId, actorId, "left");
      } catch {
        // Signing out clears the local identity even when the room presence
        // update cannot be delivered.
      }
    }

    clearStoredIdentity();
    setSessionToken(null);
    setIdentity(null);
    join.reset();
    sendMessage.reset();
    queryClient.removeQueries({ queryKey: ["desktop-session"] });
  };

  const actorIds = useMemo(() => {
    const ids = new Set<string>();

    for (const event of events.data ?? []) {
      if (event.actorId !== null) {
        ids.add(event.actorId);
      }
    }

    if (localActor !== undefined) {
      ids.add(localActor.id);
    }

    return [...ids].sort();
  }, [localActor, events.data]);
  const actorQueries = useQueries({
    queries: actorIds.map((actorId) => ({
      queryKey: ["actor", actorId],
      queryFn: () => getActor(actorId),
      staleTime: Number.POSITIVE_INFINITY,
      retry: 1,
    })),
  });
  const actors = useMemo(
    () => {
      const actorMap = new Map(
        actorQueries
          .map((query) => query.data)
          .filter((actor): actor is Actor => actor !== undefined)
          .map((actor) => [actor.id, actor]),
      );

      if (localActor !== undefined) {
        actorMap.set(localActor.id, localActor);
      }

      return actorMap;
    },
    [actorQueries, localActor],
  );

  useEffect(() => {
    const controller = new AbortController();
    let hasConnected = false;

    const onEvent = (event: RoomEvent) => {
      queryClient.setQueryData<RoomEvent[]>(eventsKey, (existing) =>
        mergeEvents(existing, [event]),
      );
      void queryClient.invalidateQueries({ queryKey: overviewKey });
    };

    const connect = async () => {
      while (!controller.signal.aborted) {
        const currentEvents =
          queryClient.getQueryData<RoomEvent[]>(eventsKey) ?? [];
        const after =
          currentEvents[currentEvents.length - 1]?.sequence ?? "0";

        setRealtimeStatus({
          state: hasConnected ? "reconnecting" : "connecting",
          transport: null,
          detail: hasConnected
            ? "Reconnecting from the latest processed event"
            : "Connecting to the room event stream",
        });

        try {
          const config = await getRealtimeConfig();

          try {
            await runWebTransport(
              config,
              roomId,
              after,
              controller.signal,
              () => {
                hasConnected = true;
                setRealtimeStatus({
                  state: "connected",
                  transport: "webtransport",
                  detail: "Reliable room events over WebTransport",
                });
              },
              onEvent,
            );
          } catch (webTransportError) {
            if (controller.signal.aborted) {
              return;
            }

            const detail =
              webTransportError instanceof Error
                ? webTransportError.message
                : "WebTransport was unavailable";
            setRealtimeStatus({
              state: "reconnecting",
              transport: null,
              detail: `${detail}. Trying WebSocket fallback`,
            });
            await runWebSocket(
              config,
              roomId,
              after,
              controller.signal,
              () => {
                hasConnected = true;
                setRealtimeStatus({
                  state: "connected",
                  transport: "websocket",
                  detail: "Reliable room events over WebSocket fallback",
                });
              },
              onEvent,
            );
          }
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }

          setRealtimeStatus({
            state: "offline",
            transport: null,
            detail:
              error instanceof Error
                ? error.message
                : "Realtime gateway is unavailable",
          });
        }

        await wait(reconnectDelayMilliseconds, controller.signal);
      }
    };

    void connect();
    return () => controller.abort();
  }, [eventsKey, overviewKey, queryClient, roomId]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["api-health"] }),
      queryClient.invalidateQueries({ queryKey: ["realtime-health"] }),
      queryClient.invalidateQueries({ queryKey: overviewKey }),
      queryClient.invalidateQueries({ queryKey: eventsKey }),
    ]);
  };

  return {
    actors,
    apiHealth,
    desktopSession,
    events,
    hasIdentity: identity !== null,
    join,
    localActor,
    onlineActorIds: onlineActorIds(events.data ?? []),
    overview,
    policy,
    realtimeHealth,
    rules,
    realtimeStatus,
    refresh,
    sendMessage,
    signOut,
  };
};
