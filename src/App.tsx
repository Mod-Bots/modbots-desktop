import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CornerUpLeft,
  DoorOpen,
  Image,
  LogIn,
  MessageSquare,
  Mic,
  MicOff,
  MoreHorizontal,
  Paperclip,
  Reply,
  ScrollText,
  Search,
  Send,
  Shield,
  SmilePlus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import type {
  Actor,
  ActorType,
  ParticipationPolicy,
  RoomEvent,
} from "./data/contracts";
import { isMutedError, PlatformRequestError } from "./data/platform";
import { actorLabel } from "./data/room-state";
import { useRoomActivity } from "./hooks/useRoomActivity";
import type { JoinRequest } from "./hooks/useRoomActivity";
import "./App.css";

const roomId = "global-lobby";
const roomName = "Room";
const roomAbout =
  "A live chatroom where humans and chat bots talk, and mod bots learn " +
  "to moderate from everything that happens.";
const appVersion = "0.1.0";

const groupWindowMs = 5 * 60 * 1000;

const avatarShades = [
  "#202020",
  "#272727",
  "#2f2f2f",
  "#383838",
  "#414141",
  "#1c1c1c",
  "#4a4a4a",
  "#242424",
];

const roleLabels: Record<ActorType, string> = {
  human: "Humans",
  chat_bot: "Chat bots",
  mod_bot: "Mod bots",
};

const roleOrder: ActorType[] = ["mod_bot", "chat_bot", "human"];

const payloadString = (event: RoomEvent, key: string): string | null => {
  const value = event.payload[key];
  return typeof value === "string" ? value : null;
};

const payloadReply = (event: RoomEvent): { contentItemId: string } | null => {
  const value = event.payload.replyTo;

  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { contentItemId?: unknown }).contentItemId === "string"
  ) {
    return {
      contentItemId: (value as { contentItemId: string }).contentItemId,
    };
  }

  return null;
};

const formatTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const dayLabel = (date: Date): string => {
  const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);

  if (diff === 0) {
    return "Today";
  }

  if (diff === 1) {
    return "Yesterday";
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
};

const formatRole = (actor: Actor): string => actor.type.replace("_", " ");

const monogram = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return "?";
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const shadeFor = (actorId: string | null): string => {
  if (actorId === null) {
    return "#202020";
  }

  let hash = 0;

  for (let index = 0; index < actorId.length; index += 1) {
    hash = (hash * 31 + actorId.charCodeAt(index)) >>> 0;
  }

  return avatarShades[hash % avatarShades.length];
};

const roleBadgeIcon = (type: ActorType) => {
  if (type === "mod_bot") {
    return <Shield className="h-2.5 w-2.5" />;
  }

  if (type === "chat_bot") {
    return <Bot className="h-2.5 w-2.5" />;
  }

  return null;
};

const moderationEventText = (
  event: RoomEvent,
  actors: Map<string, Actor>,
  ruleTitles: Map<string, string>,
): string | null => {
  if (event.type !== "moderation_action_applied") {
    return null;
  }

  const action =
    payloadString(event, "action")?.replace(/_/g, " ") ??
    "a moderation action";
  const target = payloadString(event, "targetEventSequence");
  const ruleId = payloadString(event, "ruleId");
  const ruleTitle = ruleId === null ? undefined : ruleTitles.get(ruleId);

  return `${actorLabel(event.actorId, actors)} applied ${action}${
    target === null ? "" : ` to message ${target}`
  }${ruleTitle === undefined ? "" : ` · rule: ${ruleTitle}`}`;
};

type TimelineItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; event: RoomEvent; grouped: boolean }
  | { kind: "moderation"; key: string; event: RoomEvent };

const buildTimeline = (events: RoomEvent[]): TimelineItem[] => {
  const items: TimelineItem[] = [];
  let previousMessage: RoomEvent | null = null;
  let previousDayKey: string | null = null;

  for (const event of events) {
    const occurredAt = new Date(event.occurredAt);
    const dayKey = startOfDay(occurredAt).toString();

    if (dayKey !== previousDayKey) {
      items.push({
        kind: "day",
        key: `day-${event.sequence}`,
        label: dayLabel(occurredAt),
      });
      previousDayKey = dayKey;
      previousMessage = null;
    }

    if (event.type === "moderation_action_applied") {
      items.push({ kind: "moderation", key: event.sequence, event });
      previousMessage = null;
      continue;
    }

    // A reply always shows its author and its reference, so it never folds
    // into the previous author's group.
    const grouped =
      previousMessage !== null &&
      previousMessage.actorId === event.actorId &&
      payloadReply(event) === null &&
      occurredAt.getTime() - new Date(previousMessage.occurredAt).getTime() <
        groupWindowMs;

    items.push({ kind: "message", key: event.sequence, event, grouped });
    previousMessage = event;
  }

  return items;
};

type MenuId = "file" | "edit" | "view" | "room" | "help";

interface MenuItemSpec {
  label: string;
  shortcut?: string;
  onSelect?: () => void;
  disabled?: boolean;
  checked?: boolean;
  title?: string;
}

interface MenuSpec {
  id: MenuId;
  label: string;
  items: MenuItemSpec[];
}

function ActorAvatar({
  actor,
  actorId,
  name,
  size = "md",
}: {
  actor: Actor | undefined;
  actorId: string | null;
  name: string;
  size?: "sm" | "md";
}) {
  const dimensions =
    size === "sm" ? "h-8 w-8 text-[11px]" : "h-10 w-10 text-xs";

  return (
    <div className="relative shrink-0">
      <div
        className={`flex ${dimensions} items-center justify-center rounded-xl border border-white/10 font-semibold text-zinc-100`}
        style={{ backgroundColor: shadeFor(actorId) }}
      >
        {monogram(name)}
      </div>
      {actor !== undefined && actor.type !== "human" ? (
        <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-black/70 bg-[#0d0d0d] text-zinc-300">
          {roleBadgeIcon(actor.type)}
        </span>
      ) : null}
    </div>
  );
}

function MenuBar({
  menus,
  openMenu,
  onOpenMenu,
}: {
  menus: MenuSpec[];
  openMenu: MenuId | null;
  onOpenMenu: (menu: MenuId | null) => void;
}) {
  return (
    <div className="relative z-30 flex h-8 shrink-0 items-center gap-0.5 border-b border-white/[0.08] bg-[#0a0a0a] px-2.5">
      {menus.map((menu) => (
        <div key={menu.id} className="relative">
          <button
            type="button"
            onClick={() => onOpenMenu(openMenu === menu.id ? null : menu.id)}
            onMouseEnter={() => {
              if (openMenu !== null) {
                onOpenMenu(menu.id);
              }
            }}
            className={`rounded-md px-2.5 py-1 text-[13px] transition ${
              openMenu === menu.id
                ? "bg-white/[0.1] text-white"
                : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
            }`}
          >
            {menu.label}
          </button>
          {openMenu === menu.id ? (
            <div className="absolute left-0 top-full z-40 mt-0.5 min-w-[224px] rounded-lg border border-white/10 bg-[#151515] p-1 shadow-[0_16px_50px_rgba(0,0,0,0.5)]">
              {menu.items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => {
                    onOpenMenu(null);
                    item.onSelect?.();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-zinc-300 hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
                >
                  <span className="flex w-4 shrink-0 justify-center text-zinc-400">
                    {item.checked ? <Check className="h-3.5 w-3.5" /> : null}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.shortcut ? (
                    <span className="text-[11px] tabular-nums text-zinc-600">
                      {item.shortcut}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// The status bar surfaces only state the user cannot otherwise perceive:
// the link to the service, in-flight sends, restrictions on the user, and
// search feedback. It never repeats what is visible elsewhere.
function StatusBar({
  connectionLabel,
  sending,
  muted,
  searchMatches,
}: {
  connectionLabel: string;
  sending: boolean;
  muted: boolean;
  searchMatches: number | null;
}) {
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-white/[0.08] bg-[#0a0a0a] px-3 text-[11px] text-zinc-500">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              connectionLabel === "Connected"
                ? "bg-zinc-200"
                : connectionLabel === "Offline"
                  ? "border border-zinc-500"
                  : "animate-pulse bg-zinc-500"
            }`}
          />
          <span className="text-zinc-400">{connectionLabel}</span>
        </span>
        {sending ? <span>Sending...</span> : null}
        {muted ? (
          <span
            className="flex items-center gap-1.5 text-zinc-300"
            title="Moderation has muted you in this room"
          >
            <MicOff className="h-3 w-3" />
            Muted
          </span>
        ) : null}
      </div>

      {searchMatches !== null ? (
        <span className="tabular-nums">
          {searchMatches} {searchMatches === 1 ? "match" : "matches"}
        </span>
      ) : null}
    </footer>
  );
}

function MessageActions({ onReply }: { onReply?: () => void }) {
  return (
    <div className="absolute right-4 top-0 hidden items-center rounded-xl border border-white/10 bg-[#181818] p-0.5 shadow-xl group-hover:flex group-focus-within:flex sm:right-6">
      <button
        type="button"
        onClick={onReply}
        disabled={onReply === undefined}
        className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-500"
        aria-label="Reply to message"
        title="Reply"
      >
        <Reply className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.07] hover:text-white"
        aria-label="Add reaction"
        title="Add reaction"
      >
        <SmilePlus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.07] hover:text-white"
        aria-label="More message actions"
        title="More actions"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ChatMessage({
  actors,
  event,
  grouped,
  localActorId,
  repliedEvent,
  onReply,
}: {
  actors: Map<string, Actor>;
  event: RoomEvent;
  grouped: boolean;
  localActorId: string | undefined;
  repliedEvent: RoomEvent | null;
  onReply?: () => void;
}) {
  const actor = event.actorId === null ? undefined : actors.get(event.actorId);
  const ownMessage = event.actorId === localActorId;
  const name = actorLabel(event.actorId, actors);
  const content =
    payloadString(event, "content") ?? "Message content unavailable";
  const isReply = payloadReply(event) !== null;

  if (grouped) {
    return (
      <article className="group relative flex gap-3 px-4 py-0.5 hover:bg-white/[0.035] sm:px-6">
        <div className="flex w-10 shrink-0 justify-center">
          <time className="mt-1 hidden text-[10px] tabular-nums text-zinc-600 group-hover:block">
            {formatTime(event.occurredAt)}
          </time>
        </div>
        <div className="min-w-0 flex-1 pr-20">
          <p className="max-w-[90ch] whitespace-pre-wrap break-words text-[14px] leading-[22px] text-zinc-200">
            {content}
          </p>
        </div>
        <MessageActions onReply={onReply} />
      </article>
    );
  }

  return (
    <article className="group relative mt-2 flex gap-3 px-4 py-0.5 hover:bg-white/[0.035] sm:px-6">
      <ActorAvatar actor={actor} actorId={event.actorId} name={name} />

      <div className="min-w-0 flex-1 pr-20">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[13px] font-semibold text-zinc-100">{name}</span>
          {actor?.type !== "human" && actor !== undefined ? (
            <span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-zinc-400">
              {formatRole(actor)}
            </span>
          ) : null}
          {ownMessage ? (
            <span className="text-[11px] text-zinc-500">You</span>
          ) : null}
          <time className="text-[11px] tabular-nums text-zinc-500">
            {formatTime(event.occurredAt)}
          </time>
        </div>
        {isReply ? (
          <div className="mt-1 flex min-w-0 max-w-[70ch] items-stretch overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.03]">
            <span className="w-1 shrink-0 bg-zinc-500" />
            <div className="min-w-0 px-2.5 py-1.5">
              {repliedEvent === null ? (
                <p className="text-[12px] italic text-zinc-500">
                  Earlier message
                </p>
              ) : (
                <>
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300">
                    <CornerUpLeft className="h-3 w-3 shrink-0 text-zinc-500" />
                    {actorLabel(repliedEvent.actorId, actors)}
                  </p>
                  <p className="truncate text-[12px] leading-5 text-zinc-500">
                    {payloadString(repliedEvent, "content")}
                  </p>
                </>
              )}
            </div>
          </div>
        ) : null}
        <p className="mt-0.5 max-w-[90ch] whitespace-pre-wrap break-words text-[14px] leading-[22px] text-zinc-200">
          {content}
        </p>
      </div>

      <MessageActions onReply={onReply} />
    </article>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
      <span className="h-px flex-1 bg-white/[0.07]" />
      <span className="rounded-full border border-white/10 bg-[#141414] px-3 py-0.5 text-[11px] font-medium text-zinc-500">
        {label}
      </span>
      <span className="h-px flex-1 bg-white/[0.07]" />
    </div>
  );
}

function ModerationEvent({
  actors,
  event,
  ruleTitles,
}: {
  actors: Map<string, Actor>;
  event: RoomEvent;
  ruleTitles: Map<string, string>;
}) {
  const text = moderationEventText(event, actors, ruleTitles);

  if (text === null) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs text-zinc-500 sm:px-6">
      <span className="h-px flex-1 bg-white/[0.06]" />
      <Shield className="h-3.5 w-3.5 shrink-0" />
      <span>{text}</span>
      <span className="tabular-nums">{formatTime(event.occurredAt)}</span>
      <span className="h-px flex-1 bg-white/[0.06]" />
    </div>
  );
}

function ParticipantRow({ actor }: { actor: Actor }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-white/[0.04]">
      <div className="relative">
        <ActorAvatar
          actor={actor}
          actorId={actor.id}
          name={actor.display}
          size="sm"
        />
        <span
          className="absolute -bottom-0.5 -left-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0d0d0d] bg-zinc-200"
          title="Online"
        />
      </div>
      <p className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
        {actor.display}
      </p>
    </div>
  );
}

const joinErrorText = (error: unknown): string => {
  if (error instanceof PlatformRequestError) {
    if (error.code === "username_taken") {
      return "That username is already taken. Pick a different one.";
    }

    if (error.code === "policy_not_accepted") {
      return "You must accept the participation policy before joining.";
    }
  }

  return error instanceof Error ? error.message : "Joining failed. Try again.";
};

const joinInputClass =
  "h-10 w-full rounded-lg border border-white/10 bg-[#181818] px-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-white/25";

function PolicySection({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
        {label}
      </p>
      <p className="mt-1 text-sm leading-6 text-zinc-400">{text}</p>
    </div>
  );
}

function JoinPanel({
  policy,
  policyLoading,
  policyError,
  joinPending,
  joinError,
  onRetryPolicy,
  onJoin,
}: {
  policy: ParticipationPolicy | undefined;
  policyLoading: boolean;
  policyError: Error | null;
  joinPending: boolean;
  joinError: Error | null;
  onRetryPolicy: () => void;
  onJoin: (request: JoinRequest) => void;
}) {
  const [mode, setMode] = useState<"guest" | "register">("guest");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const errorText =
    localError ?? (joinError !== null ? joinErrorText(joinError) : null);

  const selectMode = (nextMode: "guest" | "register") => {
    setMode(nextMode);
    setLocalError(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (joinPending) {
      return;
    }

    if (!accepted) {
      setLocalError(
        "You must accept the participation policy before joining.",
      );
      return;
    }

    if (mode === "register" && username.trim().length === 0) {
      setLocalError("A username is required to register.");
      return;
    }

    setLocalError(null);
    onJoin({ mode, username, displayName, acceptPolicy: accepted });
  };

  return (
    <section className="modbots-scroll flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[560px] px-6 py-10">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-[#171717] text-zinc-300">
          <LogIn className="h-5 w-5" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-zinc-100">
          Join the room
        </h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">
          Walk in as a guest or register a username. Review and accept the
          participation policy first.
        </p>

        <div className="mt-6 rounded-2xl border border-white/10 bg-[#141414] p-4">
          <div className="flex items-center gap-2 text-zinc-300">
            <ScrollText className="h-4 w-4 shrink-0" />
            <h3 className="text-sm font-semibold">Participation policy</h3>
            {policy !== undefined ? (
              <span className="ml-auto text-[11px] text-zinc-600">
                Version {policy.version}
              </span>
            ) : null}
          </div>

          {policyLoading ? (
            <p className="mt-3 text-sm text-zinc-500">
              Loading the participation policy...
            </p>
          ) : policy !== undefined ? (
            <div className="mt-3 space-y-3">
              <PolicySection
                label="Moderation access"
                text={policy.moderationAccess}
              />
              <PolicySection label="Training use" text={policy.trainingUse} />
              <PolicySection label="Retention" text={policy.retention} />
            </div>
          ) : (
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-sm text-zinc-400">
                {policyError !== null
                  ? policyError.message
                  : "The participation policy could not be loaded."}
              </p>
              <button
                type="button"
                onClick={onRetryPolicy}
                className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-white hover:bg-white/[0.07]"
              >
                Retry
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setAccepted((value) => !value);
              setLocalError(null);
            }}
            aria-pressed={accepted}
            className="mt-4 flex w-full items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 text-left transition hover:bg-white/[0.05]"
          >
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                accepted
                  ? "border-white bg-white text-black"
                  : "border-zinc-600 text-transparent"
              }`}
            >
              <Check className="h-3 w-3" />
            </span>
            <span className="text-sm text-zinc-300">
              I accept the participation policy.
            </span>
          </button>
        </div>

        <div className="mt-5 flex gap-1 rounded-xl border border-white/10 bg-[#141414] p-1">
          <button
            type="button"
            onClick={() => selectMode("guest")}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              mode === "guest"
                ? "bg-white/[0.09] text-white"
                : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"
            }`}
          >
            <LogIn className="h-4 w-4" />
            Join as guest
          </button>
          <button
            type="button"
            onClick={() => selectMode("register")}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              mode === "register"
                ? "bg-white/[0.09] text-white"
                : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"
            }`}
          >
            <UserPlus className="h-4 w-4" />
            Register
          </button>
        </div>

        <form
          onSubmit={submit}
          className="mt-3 rounded-2xl border border-white/10 bg-[#141414] p-4"
        >
          {mode === "register" ? (
            <label className="block">
              <span className="text-xs font-medium text-zinc-400">
                Username
              </span>
              <input
                value={username}
                onChange={(event) => {
                  setUsername(event.currentTarget.value);
                  setLocalError(null);
                }}
                maxLength={64}
                placeholder="Pick a unique username"
                className={`mt-1.5 ${joinInputClass}`}
              />
            </label>
          ) : null}

          <label className={`block ${mode === "register" ? "mt-3" : ""}`}>
            <span className="text-xs font-medium text-zinc-400">
              Display name (optional)
            </span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
              maxLength={64}
              placeholder="How the room sees you"
              className={`mt-1.5 ${joinInputClass}`}
            />
          </label>

          {errorText !== null ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
              <span>{errorText}</span>
            </div>
          ) : null}

          <button
            type="submit"
            disabled={joinPending || policy === undefined}
            className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-black transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#141414] disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {mode === "guest" ? (
              <LogIn className="h-4 w-4" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            {joinPending
              ? "Joining..."
              : mode === "guest"
                ? "Join as guest"
                : "Register and join"}
          </button>
        </form>
      </div>
    </section>
  );
}

function App() {
  const {
    actors,
    apiHealth,
    desktopSession,
    events,
    hasIdentity,
    join,
    localActor,
    onlineActorIds,
    overview,
    policy,
    realtimeStatus,
    rules,
    refresh,
    sendMessage,
    signOut,
  } = useRoomActivity(roomId);
  const [draft, setDraft] = useState("");
  const [mutedNotice, setMutedNotice] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(true);
  const [aboutPanelOpen, setAboutPanelOpen] = useState(true);
  const [openRuleId, setOpenRuleId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [replyTarget, setReplyTarget] = useState<RoomEvent | null>(null);
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const conversationViewport = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const apiConnected = apiHealth.data?.status === "ok";
  const chatBotCount = onlineActorIds.filter(
    (actorId) => actors.get(actorId)?.type === "chat_bot",
  ).length;
  const modBotCount = onlineActorIds.filter(
    (actorId) => actors.get(actorId)?.type === "mod_bot",
  ).length;
  const onlineActors = onlineActorIds
    .map((actorId) => actors.get(actorId))
    .filter((actor): actor is Actor => actor !== undefined);
  const roster = roleOrder.map((type) => ({
    type,
    members: onlineActors.filter((actor) => actor.type === type),
  }));
  const roomEvents = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();

    return (events.data ?? [])
      .filter(
        (event) =>
          event.type === "message_posted" ||
          event.type === "moderation_action_applied",
      )
      .filter((event) => {
        if (query.length === 0) {
          return true;
        }

        return (
          payloadString(event, "content")?.toLocaleLowerCase().includes(query) ??
          false
        );
      })
      .slice(-300);
  }, [events.data, searchQuery]);
  const timeline = useMemo(() => buildTimeline(roomEvents), [roomEvents]);
  // Replies reference the content item behind a message; this resolves the
  // reference back to the original message for the quoted line.
  const messagesByContentItem = useMemo(() => {
    const map = new Map<string, RoomEvent>();

    for (const event of events.data ?? []) {
      if (event.type !== "message_posted") {
        continue;
      }

      const contentItemId = payloadString(event, "contentItemId");

      if (contentItemId !== null) {
        map.set(contentItemId, event);
      }
    }

    return map;
  }, [events.data]);
  const ruleTitles = useMemo(
    () =>
      new Map((rules.data?.rules ?? []).map((rule) => [rule.id, rule.title])),
    [rules.data],
  );
  // The room's pulse, computed from the event history: a bar per day for
  // the last seven days of conversation, plus the week's totals. Shown
  // nowhere else in the interface.
  const weekPulse = useMemo(() => {
    const dayMs = 86_400_000;
    const start = startOfDay(new Date()) - 6 * dayMs;
    const days = Array.from({ length: 7 }, () => 0);
    let messages = 0;
    let moderationActions = 0;

    for (const event of events.data ?? []) {
      const occurred = new Date(event.occurredAt).getTime();

      if (occurred < start) {
        continue;
      }

      if (
        event.type === "message_posted" ||
        event.type === "content_posted"
      ) {
        messages += 1;
        days[Math.min(6, Math.floor((occurred - start) / dayMs))] += 1;
      } else if (event.type === "moderation_action_applied") {
        moderationActions += 1;
      }
    }

    return { days, messages, moderationActions };
  }, [events.data]);
  // Muted state is imperceptible until a send fails, so it is derived from
  // the room's own moderation events for the local actor.
  const isMuted = useMemo(() => {
    if (localActor === undefined) {
      return false;
    }

    let muted = false;

    for (const event of events.data ?? []) {
      if (event.actorId !== localActor.id) {
        continue;
      }

      if (event.type === "actor_muted") {
        muted = true;
      } else if (event.type === "actor_unmuted") {
        muted = false;
      }
    }

    return muted;
  }, [events.data, localActor]);
  const canSend =
    localActor !== undefined &&
    apiConnected &&
    draft.trim().length > 0 &&
    !sendMessage.isPending;
  const sendError = isMutedError(sendMessage.error) ? null : sendMessage.error;
  const error =
    apiHealth.error ??
    desktopSession.error ??
    overview.error ??
    events.error ??
    sendError;
  const realtimeConnected = realtimeStatus.state === "connected";
  const connectionProblem = !apiConnected || !realtimeConnected;
  const connectionLabel =
    apiConnected && realtimeConnected
      ? "Connected"
      : realtimeStatus.state === "offline"
        ? "Offline"
        : realtimeStatus.state === "reconnecting" || realtimeConnected
          ? "Reconnecting"
          : "Connecting";

  const scrollToLatest = () => {
    const viewport = conversationViewport.current;

    if (viewport !== null) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  };

  const menus: MenuSpec[] = [
    {
      id: "file",
      label: "File",
      items: [
        {
          label: "Search conversation",
          shortcut: "Ctrl+F",
          onSelect: () => searchInput.current?.focus(),
        },
        {
          label: "Export transcript",
          disabled: true,
          title: "Transcript export is not connected yet",
        },
        {
          label: "Quit",
          disabled: true,
          title: "Use the window controls to close the app",
        },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        {
          label: "Find in conversation",
          shortcut: "Ctrl+F",
          onSelect: () => searchInput.current?.focus(),
        },
        {
          label: "Clear search",
          disabled: searchQuery.length === 0,
          onSelect: () => setSearchQuery(""),
        },
      ],
    },
    {
      id: "view",
      label: "View",
      items: [
        {
          label: "Participants panel",
          checked: membersOpen,
          onSelect: () => setMembersOpen((open) => !open),
        },
        {
          label: "About panel",
          checked: aboutPanelOpen,
          onSelect: () => setAboutPanelOpen((open) => !open),
        },
        {
          label: "Scroll to latest",
          onSelect: scrollToLatest,
        },
      ],
    },
    {
      id: "room",
      label: "Room",
      items: [
        {
          label: "Room details",
          disabled: true,
          title: "Room management is not connected yet",
        },
        {
          label: "Invite people",
          disabled: true,
          title: "Invites are not connected yet",
        },
        {
          label: "Leave room",
          disabled: true,
          title: "Leaving the room is not connected yet",
        },
        {
          label: "Sign out",
          disabled: !hasIdentity,
          title: hasIdentity
            ? undefined
            : "Join the room before signing out",
          onSelect: () => void signOut(),
        },
      ],
    },
    {
      id: "help",
      label: "Help",
      items: [
        {
          label: "About Mod Bots",
          onSelect: () => setAboutOpen(true),
        },
        {
          label: "Keyboard shortcuts",
          disabled: true,
          title: "Shortcut reference is not connected yet",
        },
      ],
    },
  ];

  useEffect(() => {
    if (searchQuery.length > 0) {
      return;
    }

    scrollToLatest();
  }, [timeline.length, searchQuery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInput.current?.focus();
        return;
      }

      if (event.key === "Escape") {
        setOpenMenu(null);
        setAboutOpen(false);
        setReplyTarget(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();

    if (!canSend || content.length === 0) {
      return;
    }

    setDraft("");
    setMutedNotice(null);
    const replyContentItemId =
      replyTarget === null
        ? null
        : payloadString(replyTarget, "contentItemId");

    try {
      await sendMessage.mutateAsync({
        content,
        ...(replyContentItemId === null
          ? {}
          : { replyTo: { contentItemId: replyContentItemId } }),
      });
      setReplyTarget(null);
    } catch (sendFailure) {
      setDraft(content);

      if (isMutedError(sendFailure)) {
        setMutedNotice(
          "You are muted by moderation. Your message was not sent.",
        );
      }
    }
  };

  return (
    <main className="flex h-screen min-w-[880px] flex-col overflow-hidden bg-[#0b0b0b] text-zinc-100">
      <MenuBar menus={menus} openMenu={openMenu} onOpenMenu={setOpenMenu} />
      {openMenu !== null ? (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setOpenMenu(null)}
          aria-hidden="true"
        />
      ) : null}

      <div className="flex min-h-0 flex-1">
        {membersOpen ? (
          <aside className="flex w-[260px] shrink-0 flex-col border-r border-white/[0.08] bg-[#0d0d0d]">
            <div className="flex h-[68px] shrink-0 items-center border-b border-white/[0.08] px-5">
              <h1 className="truncate text-[15px] font-semibold text-white">
                {roomName}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-5 py-2 text-zinc-400">
              <Users className="h-3.5 w-3.5 shrink-0" />
              <span className="text-xs font-semibold uppercase tracking-[0.08em]">
                Participants
              </span>
              <span className="ml-auto text-xs tabular-nums text-zinc-500">
                {onlineActors.length}
              </span>
            </div>
            <div className="modbots-scroll min-h-0 flex-1 overflow-y-auto p-3">
              <div className="space-y-4">
                {roster.map((group) => (
                  <div key={group.type}>
                    <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                      {roleLabels[group.type]} · {group.members.length}
                    </p>
                    <div className="space-y-0.5">
                      {group.members.map((actor) => (
                        <ParticipantRow key={actor.id} actor={actor} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="shrink-0 border-t border-white/[0.08] p-3">
              <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
                <ActorAvatar
                  actor={localActor}
                  actorId={localActor?.id ?? null}
                  name={localActor?.display ?? "You"}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-200">
                    {localActor?.display ??
                      (hasIdentity ? "Preparing session..." : "Not joined")}
                  </p>
                </div>
              </div>
            </div>
          </aside>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="z-10 flex h-[68px] shrink-0 items-center gap-4 border-b border-white/[0.08] bg-[#0d0d0d] px-5">
            <h2 className="shrink-0 text-[15px] font-semibold text-white">Chat</h2>
            <div className="flex-1" />
            <div className="flex h-9 w-[min(32vw,380px)] items-center gap-2 rounded-lg border border-white/10 bg-[#181818] px-3">
              <Search className="h-4 w-4 shrink-0 text-zinc-500" />
              <input
                ref={searchInput}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                placeholder="Search the chat"
                className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
              />
              {searchQuery.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <div className="flex-1" />
          </header>

          {connectionProblem || error instanceof Error ? (
            <div className="flex shrink-0 items-center justify-between border-b border-white/[0.08] bg-[#151515] px-7 py-2 text-xs text-zinc-300">
              <span>
                {error instanceof Error
                  ? error.message
                  : "The conversation is reconnecting. New messages may be delayed."}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg px-3 py-1.5 font-medium text-white hover:bg-white/[0.07]"
              >
                Retry
              </button>
            </div>
          ) : null}

          <div className="relative flex min-h-0 flex-1">
            {!hasIdentity ? (
              <JoinPanel
                policy={policy.data}
                policyLoading={policy.isLoading}
                policyError={policy.error}
                joinPending={join.isPending}
                joinError={join.error}
                onRetryPolicy={() => void policy.refetch()}
                onJoin={(request) => join.mutate(request)}
              />
            ) : (
            <section className="flex min-w-0 flex-1 flex-col">
              <div
                ref={conversationViewport}
                className="modbots-scroll min-h-0 flex-1 overflow-y-auto"
              >
                <div className="flex min-h-full flex-col justify-end py-3">
                  {events.isLoading ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
                      Loading conversation...
                    </div>
                  ) : timeline.length === 0 ? (
                    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-[#171717] text-zinc-400">
                        {searchQuery.length > 0 ? (
                          <Search className="h-5 w-5" />
                        ) : (
                          <MessageSquare className="h-5 w-5" />
                        )}
                      </div>
                      <h2 className="mt-4 text-base font-semibold text-zinc-200">
                        {searchQuery.length > 0
                          ? "No matching messages"
                          : "Start the conversation"}
                      </h2>
                      <p className="mt-1 text-sm text-zinc-500">
                        {searchQuery.length > 0
                          ? "Try another word or phrase."
                          : "Messages from people and bots appear here together."}
                      </p>
                    </div>
                  ) : (
                    timeline.map((item) => {
                      if (item.kind === "day") {
                        return <DayDivider key={item.key} label={item.label} />;
                      }

                      if (item.kind === "moderation") {
                        return (
                          <ModerationEvent
                            key={item.key}
                            actors={actors}
                            event={item.event}
                            ruleTitles={ruleTitles}
                          />
                        );
                      }

                      const reply = payloadReply(item.event);
                      const repliedEvent =
                        reply === null
                          ? null
                          : (messagesByContentItem.get(reply.contentItemId) ??
                            null);
                      const canReply =
                        localActor !== undefined &&
                        payloadString(item.event, "contentItemId") !== null;

                      return (
                        <ChatMessage
                          key={item.key}
                          actors={actors}
                          event={item.event}
                          grouped={item.grouped}
                          localActorId={localActor?.id}
                          repliedEvent={repliedEvent}
                          onReply={
                            canReply
                              ? () => setReplyTarget(item.event)
                              : undefined
                          }
                        />
                      );
                    })
                  )}
                </div>
              </div>

              <div className="shrink-0 px-4 pb-4 pt-2 sm:px-7 sm:pb-5">
                {mutedNotice !== null ? (
                  <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/10 bg-[#151515] px-3 py-2 text-xs text-zinc-300">
                    <MicOff className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    <span className="flex-1">{mutedNotice}</span>
                    <button
                      type="button"
                      onClick={() => setMutedNotice(null)}
                      className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                      aria-label="Dismiss muted notice"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
                <form
                  onSubmit={(event) => void submitMessage(event)}
                  className="rounded-2xl border border-white/10 bg-[#171717] shadow-[0_16px_50px_rgba(0,0,0,0.35)] focus-within:border-white/20"
                >
                  {replyTarget !== null ? (
                    <div className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-2 text-xs">
                      <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                      <span className="shrink-0 text-zinc-400">
                        Replying to{" "}
                        <span className="font-medium text-zinc-200">
                          {actorLabel(replyTarget.actorId, actors)}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1 truncate text-zinc-600">
                        {payloadString(replyTarget, "content")}
                      </span>
                      <button
                        type="button"
                        onClick={() => setReplyTarget(null)}
                        className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                        aria-label="Cancel reply"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : null}
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    rows={1}
                    maxLength={4_000}
                    disabled={localActor === undefined || !apiConnected}
                    placeholder={
                      localActor === undefined
                        ? "Preparing your session..."
                        : "Message the room"
                    }
                    className="max-h-40 min-h-[58px] w-full resize-none bg-transparent px-4 pb-2 pt-4 text-[15px] leading-6 text-zinc-100 outline-none placeholder:text-zinc-500 disabled:cursor-not-allowed"
                  />
                  <div className="flex items-center justify-between px-2 pb-2">
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        disabled
                        className="rounded-lg p-2.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 disabled:cursor-not-allowed"
                        aria-label="Add files or media"
                        title="File and media upload is not connected yet"
                      >
                        <Paperclip className="h-[18px] w-[18px]" />
                      </button>
                      <button
                        type="button"
                        disabled
                        className="rounded-lg p-2.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 disabled:cursor-not-allowed"
                        aria-label="Add image"
                        title="Image upload is not connected yet"
                      >
                        <Image className="h-[18px] w-[18px]" />
                      </button>
                      <button
                        type="button"
                        disabled
                        className="rounded-lg p-2.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 disabled:cursor-not-allowed"
                        aria-label="Record voice message"
                        title="Voice messages are not connected yet"
                      >
                        <Mic className="h-[18px] w-[18px]" />
                      </button>
                      <span className="mx-1 h-5 w-px bg-white/10" />
                      <button
                        type="button"
                        disabled
                        className="rounded-lg p-2.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 disabled:cursor-not-allowed"
                        aria-label="Add reaction"
                        title="Reactions are not connected yet"
                      >
                        <SmilePlus className="h-[18px] w-[18px]" />
                      </button>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="hidden text-[11px] text-zinc-600 sm:block">
                        {draft.length > 0
                          ? `${draft.length}/4000`
                          : "Shift + Enter for a new line"}
                      </span>
                      <button
                        type="submit"
                        disabled={!canSend}
                        className="flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-black transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#171717] disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                      >
                        <span>Send</span>
                        <Send className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </section>
            )}

          </div>
        </div>

        {aboutPanelOpen ? (
          <aside className="flex w-[280px] shrink-0 flex-col border-l border-white/[0.08] bg-[#0d0d0d]">
            <div className="flex h-[68px] shrink-0 items-center border-b border-white/[0.08] px-5" />
            <div className="modbots-scroll min-h-0 flex-1 overflow-y-auto p-5">
              <p className="text-sm font-semibold text-zinc-100">Mod Bots</p>
              <p className="mt-1 text-sm leading-6 text-zinc-400">
                {roomAbout}
              </p>

              <div className="mt-4 space-y-2.5 text-sm text-zinc-400">
                <p className="flex items-start gap-2.5">
                  <Bot className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                  <span>
                    Home to{" "}
                    <span className="text-zinc-200">
                      {chatBotCount} chat {chatBotCount === 1 ? "bot" : "bots"}
                    </span>
                    , watched by{" "}
                    <span className="text-zinc-200">
                      {modBotCount} mod {modBotCount === 1 ? "bot" : "bots"}
                    </span>
                  </span>
                </p>
                <p className="flex items-start gap-2.5">
                  <DoorOpen className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                  <span>Open to guests, anonymous or registered</span>
                </p>
                <p className="flex items-start gap-2.5">
                  <Image className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                  <span>Text today; images, files, and voice planned</span>
                </p>
              </div>

              <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                  This week
                </p>
                <div className="mt-2.5 flex h-9 items-end gap-1">
                  {weekPulse.days.map((count, index) => {
                    const max = Math.max(...weekPulse.days, 1);
                    const height =
                      count === 0
                        ? 8
                        : Math.max(14, Math.round((count / max) * 100));

                    return (
                      <div
                        key={index}
                        className={`flex-1 rounded-sm ${
                          index === 6 ? "bg-zinc-300" : "bg-zinc-800"
                        }`}
                        style={{ height: `${height}%` }}
                        title={`${count} ${count === 1 ? "message" : "messages"}`}
                      />
                    );
                  })}
                </div>
                <p className="mt-2.5 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-300">
                    {weekPulse.messages}
                  </span>{" "}
                  {weekPulse.messages === 1 ? "message" : "messages"} ·{" "}
                  <span className="font-medium text-zinc-300">
                    {weekPulse.moderationActions}
                  </span>{" "}
                  moderation{" "}
                  {weekPulse.moderationActions === 1 ? "action" : "actions"}
                </p>
              </div>

              {rules.data !== undefined ? (
                <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                    Rules
                  </p>
                  <p className="mt-2 text-sm leading-6 text-zinc-300">
                    {rules.data.ethos}
                  </p>
                  <ol className="mt-2">
                    {rules.data.rules.map((rule, index) => (
                      <li key={rule.id}>
                        <button
                          type="button"
                          onClick={() =>
                            setOpenRuleId(
                              openRuleId === rule.id ? null : rule.id,
                            )
                          }
                          className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-sm text-zinc-300 hover:bg-white/[0.04]"
                        >
                          <span className="w-4 shrink-0 text-xs tabular-nums text-zinc-600">
                            {index + 1}
                          </span>
                          <span className="flex-1">{rule.title}</span>
                          <ChevronDown
                            className={`h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform ${
                              openRuleId === rule.id ? "rotate-180" : ""
                            }`}
                          />
                        </button>
                        {openRuleId === rule.id ? (
                          <p className="pb-2 pl-7 pr-1.5 text-xs leading-5 text-zinc-500">
                            {rule.text}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      <StatusBar
        connectionLabel={connectionLabel}
        sending={sendMessage.isPending}
        muted={isMuted}
        searchMatches={
          searchQuery.trim().length > 0 ? roomEvents.length : null
        }
      />

      {aboutOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setAboutOpen(false)}
        >
          <div
            className="w-[360px] rounded-2xl border border-white/10 bg-[#111111] p-6 shadow-[0_24px_70px_rgba(0,0,0,0.6)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white text-sm font-bold text-black">
                MB
              </div>
              <div>
                <p className="text-sm font-semibold text-white">
                  Mod Bots Desktop
                </p>
                <p className="text-xs text-zinc-500">Version {appVersion}</p>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-zinc-400">
              A moderated multimodal chat room for teaching moderation bots from
              live chat activity. This is the desktop client track.
            </p>
            <button
              type="button"
              onClick={() => setAboutOpen(false)}
              className="mt-5 w-full rounded-xl bg-white py-2 text-sm font-semibold text-black transition hover:bg-zinc-200"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default App;
