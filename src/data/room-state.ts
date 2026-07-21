import type { Actor, RoomEvent } from "./contracts";

const maximumRoomEvents = 300;

export const compareSequences = (left: string, right: string): number => {
  const leftSequence = BigInt(left);
  const rightSequence = BigInt(right);

  if (leftSequence < rightSequence) {
    return -1;
  }

  if (leftSequence > rightSequence) {
    return 1;
  }

  return 0;
};

export const mergeEvents = (
  existing: RoomEvent[] = [],
  incoming: RoomEvent[],
): RoomEvent[] => {
  const events = new Map(existing.map((event) => [event.sequence, event]));

  for (const event of incoming) {
    events.set(event.sequence, event);
  }

  return [...events.values()]
    .sort((left, right) => compareSequences(left.sequence, right.sequence))
    .slice(-maximumRoomEvents);
};

export const onlineActorIds = (events: RoomEvent[]): string[] => {
  const presence = new Map<string, boolean>();

  for (const event of events) {
    if (event.actorId === null) {
      continue;
    }

    if (event.type === "actor_joined") {
      presence.set(event.actorId, true);
    } else if (event.type === "actor_left") {
      presence.set(event.actorId, false);
    }
  }

  return [...presence.entries()]
    .filter(([, online]) => online)
    .map(([actorId]) => actorId);
};

export const actorLabel = (
  actorId: string | null,
  actors: Map<string, Actor>,
): string => {
  if (actorId === null) {
    return "Platform";
  }

  const actor = actors.get(actorId);

  return actor?.display ?? actor?.displayName ?? actorId;
};

export const actorRole = (
  actorId: string | null,
  actors: Map<string, Actor>,
): string => {
  const type = actorId === null ? undefined : actors.get(actorId)?.type;

  if (type === "chat_bot") {
    return "chat bot";
  }

  if (type === "mod_bot") {
    return "mod bot";
  }

  if (type === "human") {
    return "human";
  }

  return "platform";
};
