import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Actor,
  ContentAddress,
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
  getRoomRoster,
  joinAsGuest,
  PlatformRequestError,
  postRoomContent,
  postRoomMediaAsset,
  postRoomMessage,
  setRoomPresence,
  setSessionToken,
} from "../data/platform";
import type { BrowserLoginOutcome } from "../data/oauth";
import { runWebSocket, runWebTransport } from "../data/realtime";
import { mergeEvents, onlineActorIds } from "../data/room-state";

// Guest walk-in is the only in-app entry; accounts sign in on the website.
export interface JoinRequest {
  displayName: string;
  acceptPolicy: boolean;
}

const reconnectDelayMilliseconds = 1_000;
const roomHistoryRetryDelayMilliseconds = 2_000;
const maximumRoomHistoryRetries = 7;
const maximumRoomHistoryRetryDelayMilliseconds = 59_000;

const roomHistoryRetryDelay = (attempt: number): number =>
  Math.min(
    roomHistoryRetryDelayMilliseconds * 2 ** attempt,
    maximumRoomHistoryRetryDelayMilliseconds,
  );

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
  const rosterKey = useMemo(
    () => ["room-roster", roomId] as const,
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
  const roster = useQuery({
    queryKey: rosterKey,
    queryFn: () => getRoomRoster(roomId),
    retry: 1,
  });
  const fetchPersistedEvents = useCallback(async () => {
    const persisted = await getRoomEvents(roomId);
    const existing = queryClient.getQueryData<RoomEvent[]>(eventsKey);
    return mergeEvents(existing, persisted);
  }, [eventsKey, queryClient, roomId]);
  const events = useQuery({
    queryKey: eventsKey,
    queryFn: fetchPersistedEvents,
    // The desktop can start before the API. Give a Docker-backed service more
    // up to three minutes to become ready, then stop retrying and let the
    // interface show a clear unavailable state with an explicit Retry action.
    retry: maximumRoomHistoryRetries,
    retryDelay: roomHistoryRetryDelay,
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

      // Validation only: entering the room (presence) is an explicit act
      // from the start screen, never a side effect of launching the app.
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
      const outcome = await joinAsGuest(
        displayName.length === 0 ? null : displayName,
        request.acceptPolicy,
      );
      const stored: StoredIdentity = {
        actorId: outcome.actor.id,
        token: outcome.session?.token ?? null,
      };

      saveStoredIdentity(stored);
      setSessionToken(stored.token);
      queryClient.setQueryData(
        ["desktop-session", roomId, outcome.actor.id],
        outcome.actor,
      );
      return stored;
    },
    onSuccess: (stored) => {
      // The desktop session query validates the new identity and joins the
      // room through the presence endpoint, the same path a restart takes.
      setIdentity(stored);
    },
  });
  // A completed browser login (automatic return or pasted code) becomes
  // the app's identity and session.
  const adoptBrowserLogin = (outcome: BrowserLoginOutcome): void => {
    const stored: StoredIdentity = {
      actorId: outcome.actor.id,
      token: outcome.session.token,
    };

    saveStoredIdentity(stored);
    setSessionToken(stored.token);
    queryClient.setQueryData(
      ["desktop-session", roomId, outcome.actor.id],
      outcome.actor,
    );
    setIdentity(stored);
  };
  const sendMessage = useMutation({
    mutationFn: async (message: {
      content: string;
      replyTo?: { contentItemId: string };
      addressedTo?: ContentAddress[];
    }) => {
      if (localActor === undefined) {
        throw new Error("Join the room before sending messages.");
      }

      return postRoomMessage(
        roomId,
        localActor.id,
        message.content,
        message.replyTo,
        message.addressedTo,
      );
    },
    onSuccess: (event) => {
      queryClient.setQueryData<RoomEvent[]>(eventsKey, (existing) =>
        mergeEvents(existing, [event]),
      );
      void queryClient.invalidateQueries({ queryKey: overviewKey });
    },
  });
  const sendContent = useMutation({
    mutationFn: async (message: {
      content: string;
      file: File;
      replyTo?: { contentItemId: string };
      addressedTo?: ContentAddress[];
    }) => {
      if (localActor === undefined) {
        throw new Error("Join the room before sending content.");
      }

      const asset = await postRoomMediaAsset(
        roomId,
        localActor.id,
        message.file,
      );
      const parts = [
        ...(message.content.length === 0
          ? []
          : [{ kind: "text" as const, text: message.content }]),
        {
          kind: asset.mediaKind,
          mediaAssetId: asset.mediaAssetId,
          caption: message.file.name,
        },
      ];

      return postRoomContent(
        roomId,
        localActor.id,
        parts,
        message.replyTo,
        message.addressedTo,
      );
    },
    onSuccess: ({ event }) => {
      queryClient.setQueryData<RoomEvent[]>(eventsKey, (existing) =>
        mergeEvents(existing, [event]),
      );
      void queryClient.invalidateQueries({ queryKey: overviewKey });
      void queryClient.invalidateQueries({ queryKey: rosterKey });
    },
  });
  // The explicit step through the room door: presence joins only when the
  // person chooses to enter from the start screen.
  const enterRoom = async (): Promise<void> => {
    if (localActor !== undefined) {
      await setRoomPresence(roomId, localActor.id, "joined");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: overviewKey }),
        queryClient.invalidateQueries({ queryKey: rosterKey }),
      ]);
    }
  };

  const signOut = async (): Promise<void> => {
    const actorId = identity?.actorId ?? null;

    if (actorId !== null) {
      try {
        await setRoomPresence(roomId, actorId, "left");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: overviewKey }),
          queryClient.invalidateQueries({ queryKey: rosterKey }),
        ]);
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
    sendContent.reset();
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

    for (const actor of roster.data?.actors ?? []) {
      ids.add(actor.id);
    }

    return [...ids].sort();
  }, [localActor, events.data, roster.data]);
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

      for (const actor of roster.data?.actors ?? []) {
        actorMap.set(actor.id, actor);
      }

      return actorMap;
    },
    [actorQueries, localActor, roster.data],
  );

  useEffect(() => {
    const controller = new AbortController();
    let hasConnected = false;
    let overviewInvalidation: number | null = null;

    // Reconnects replay history in a burst; one overview refetch per replayed
    // event floods the connection pool. Coalesce to at most one refetch per
    // second no matter how fast events arrive.
    const invalidateOverviewSoon = () => {
      if (overviewInvalidation !== null) {
        return;
      }

      overviewInvalidation = window.setTimeout(() => {
        overviewInvalidation = null;
        void queryClient.invalidateQueries({ queryKey: overviewKey });
      }, 1_000);
    };

    const onEvent = (event: RoomEvent) => {
      queryClient.setQueryData<RoomEvent[]>(eventsKey, (existing) =>
        mergeEvents(existing, [event]),
      );
      invalidateOverviewSoon();
    };

    const connect = async () => {
      // Seed the replay cursor from persisted history before the first
      // connection, so a fresh session asks the stream only for the gap
      // since that history, never the whole room from sequence zero. The
      // fetch dedupes with the events query; if the API is unreachable the
      // stream still connects with whatever cursor exists.
      try {
        await queryClient.fetchQuery({
          queryKey: eventsKey,
          queryFn: fetchPersistedEvents,
          retry: false,
        });
      } catch {
        // The events query keeps retrying on its own schedule.
      }

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
    return () => {
      controller.abort();

      if (overviewInvalidation !== null) {
        window.clearTimeout(overviewInvalidation);
      }
    };
  }, [eventsKey, fetchPersistedEvents, overviewKey, queryClient, roomId, rosterKey]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["api-health"] }),
      queryClient.invalidateQueries({ queryKey: ["realtime-health"] }),
      queryClient.invalidateQueries({ queryKey: overviewKey }),
      queryClient.invalidateQueries({ queryKey: rosterKey }),
      queryClient.invalidateQueries({ queryKey: eventsKey }),
    ]);
  };
  const currentOnlineActorIds =
    roster.data?.actors.map((actor) => actor.id) ??
    onlineActorIds(events.data ?? []);

  return {
    actors,
    adoptBrowserLogin,
    apiHealth,
    desktopSession,
    enterRoom,
    events,
    hasIdentity: identity !== null,
    join,
    localActor,
    onlineActorIds: currentOnlineActorIds,
    overview,
    policy,
    realtimeHealth,
    rules,
    realtimeStatus,
    refresh,
    sendMessage,
    sendContent,
    signOut,
  };
};
