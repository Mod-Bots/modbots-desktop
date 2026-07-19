import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import startScreenBg from "./assets/start-screen-bg.png";
import appLogo from "./assets/logo.svg";
import {
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  CornerUpLeft,
  DoorOpen,
  LogOut,
  Image,
  MessageSquare,
  Mic,
  MicOff,
  MoreHorizontal,
  Paperclip,
  Reply,
  Search,
  Send,
  Shield,
  SmilePlus,
  Users,
  X,
} from "lucide-react";
import type {
  Actor,
  ActorType,
  ContentAddress,
  RoomEvent,
} from "./data/contracts";
import {
  getBrowserLoginSession,
  openInBrowser,
  resetBrowserLoginSession,
} from "./data/oauth";
import type {
  BrowserLoginOutcome,
  BrowserLoginSession,
} from "./data/oauth";
import { isMutedError, mediaAssetDataUrl } from "./data/platform";
import { actorLabel, actorRole } from "./data/room-state";
import { useRoomActivity } from "./hooks/useRoomActivity";
import "./App.css";

const roomId = "global-lobby";
const roomName = "Room";
const roomAbout =
  "A live chatroom where humans and chat bots talk, and mod bots learn " +
  "to moderate from everything that happens.";
const appVersion = "0.0.1-alpha";

const groupWindowMs = 45 * 1000;
const browserLoginWaitMs = 90_000;
const participantActiveWindowMs = 5 * 60 * 1000;

const participantsPanel = { min: 200, max: 360, initial: 260 };
const aboutPanel = { min: 230, max: 400, initial: 280 };
const panelResizeStep = 16;

const clampWidth = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const profilePictureShades = [
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

interface EventAssetPart {
  partId: string;
  kind: "image" | "audio" | "video" | "file";
  mediaAssetId: string;
  caption: string | null;
}

type EventContentPart =
  | { partId: string; kind: "text"; text: string }
  | EventAssetPart;

const contentParts = (event: RoomEvent): EventContentPart[] => {
  const raw = event.payload.parts;

  if (!Array.isArray(raw)) {
    return [];
  }

  const parts: EventContentPart[] = [];

  for (const value of raw) {
    if (typeof value !== "object" || value === null) {
      continue;
    }

    const part = value as Record<string, unknown>;

    if (typeof part.partId !== "string" || typeof part.kind !== "string") {
      continue;
    }

    if (part.kind === "text" && typeof part.text === "string") {
      parts.push({ partId: part.partId, kind: "text", text: part.text });
      continue;
    }

    if (
      (part.kind === "image" ||
        part.kind === "audio" ||
        part.kind === "video" ||
        part.kind === "file") &&
      typeof part.mediaAssetId === "string"
    ) {
      parts.push({
        partId: part.partId,
        kind: part.kind,
        mediaAssetId: part.mediaAssetId,
        caption: typeof part.caption === "string" ? part.caption : null,
      });
    }
  }

  return parts;
};

const eventText = (event: RoomEvent): string => {
  const legacy = payloadString(event, "content");

  if (legacy !== null) {
    return legacy;
  }

  const parts = contentParts(event);
  return parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
};

const eventContent = (event: RoomEvent): string => {
  const text = eventText(event);

  if (text.length > 0) {
    return text;
  }

  return contentParts(event)
    .filter((part): part is EventAssetPart => part.kind !== "text")
    .map((part) => part.caption ?? `Shared ${part.kind}`)
    .join("\n");
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

// The keywords that address the whole room, matching the runtime's own
// parsing so a human and a bot mean the same thing by "@everyone".
const roomAddressWords = ["room", "everyone", "everybody", "all"];
const roomAddressPattern = new RegExp(
  `@(${roomAddressWords.join("|")})\\b`,
  "i",
);

// A label the message renderer can turn into an inline mention pill: a room
// keyword, or a participant matched by the exact `@display` a human or bot
// would have typed, carrying the clean name to show.
type MentionLabel =
  | { text: string; kind: "room" }
  | { text: string; kind: "actor"; actorId: string; label: string };

const buildMentionLabels = (actors: Map<string, Actor>): MentionLabel[] => {
  const labels: MentionLabel[] = roomAddressWords.map((text) => ({
    text,
    kind: "room",
  }));

  for (const actor of actors.values()) {
    labels.push({
      text: actor.display,
      kind: "actor",
      actorId: actor.id,
      label: actor.displayName,
    });
  }

  // Longest first so "@everybody" beats "@every…" and a full name beats a
  // shorter one that is a prefix of it.
  return labels.sort((left, right) => right.text.length - left.text.length);
};

// Render a message body with `@mentions` styled inline as pills, the way
// every chat app shows addressing. Only real `@` tokens (opening a word and
// matching a known participant or room keyword) become pills; anything else,
// including an email's "@", stays plain text. A mention of the local user is
// emphasized.
const renderMessageBody = (
  content: string,
  labels: MentionLabel[],
  localActorId: string | undefined,
): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let text = "";
  let index = 0;
  let key = 0;

  const flush = () => {
    if (text.length > 0) {
      nodes.push(text);
      text = "";
    }
  };

  while (index < content.length) {
    const char = content[index];
    const boundary = index === 0 || /\s/.test(content[index - 1]);

    if (char === "@" && boundary) {
      const rest = content.slice(index + 1);
      const lower = rest.toLowerCase();
      const match = labels.find((label) => {
        if (!lower.startsWith(label.text.toLowerCase())) {
          return false;
        }

        const next = rest[label.text.length];
        return next === undefined || !/[\w#-]/.test(next);
      });

      if (match !== undefined) {
        flush();
        const isYou = match.kind === "actor" && match.actorId === localActorId;
        const raw = content.slice(index, index + 1 + match.text.length);
        const pillText = match.kind === "room" ? raw : `@${match.label}`;

        nodes.push(
          <span
            key={`mention-${key}`}
            className={
              isYou
                ? "rounded bg-white/20 px-1 font-medium text-white"
                : "rounded bg-white/[0.08] px-1 font-medium text-zinc-100"
            }
          >
            {pillText}
          </span>,
        );
        key += 1;
        index += 1 + match.text.length;
        continue;
      }
    }

    text += char;
    index += 1;
  }

  flush();
  return nodes;
};

// Derive the structural targets from the composed text, using the roster as
// the dictionary. The text is the single source of truth, exactly as the
// runtime derives a bot's addressing from what it says. A room mention wins
// and stands alone, otherwise each named participant becomes an actor target.
const deriveAddressedTo = (
  text: string,
  participants: Actor[],
): ContentAddress[] => {
  if (roomAddressPattern.test(text)) {
    return [{ targetType: "room" }];
  }

  const targets: ContentAddress[] = [];

  for (const actor of participants) {
    const escaped = actor.display.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The `@` must open a word, as in the composer picker, so an email or
    // handle like "bob@Arwen" never addresses anyone; the trailing boundary
    // keeps "@Ru" from matching inside "@Rufus".
    const pattern = new RegExp(`(?:^|\\s)@${escaped}(?![\\w#-])`, "i");

    if (pattern.test(text)) {
      targets.push({ targetType: "actor", actorId: actor.id });
    }

    if (targets.length >= 16) {
      break;
    }
  }

  return targets;
};

// The `@mention` token the caret currently sits inside, if any: an `@`
// that opens a word (start of line or after whitespace) with no whitespace
// between it and the caret. Drives the composer's participant picker.
const mentionAt = (
  text: string,
  caret: number,
): { start: number; query: string } | null => {
  let index = caret - 1;

  while (index >= 0) {
    const char = text[index];

    if (char === "@") {
      const before = index === 0 ? "" : text[index - 1];

      if (before === "" || /\s/.test(before)) {
        return { start: index, query: text.slice(index + 1, caret) };
      }

      return null;
    }

    if (/\s/.test(char)) {
      return null;
    }

    index -= 1;
  }

  return null;
};

type MentionOption = { kind: "room" } | { kind: "actor"; actor: Actor };

const formatTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

const memberSince = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));

const dateTimeLabel = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
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

const isVisibleParticipant = (actor: Actor): boolean =>
  actor.type !== "human" || actor.policyAcceptedAt !== null;

type ActivityScope = "7d" | "30d" | "all";

type ParticipantStatus = "active" | "idle" | "offline";

const activityScopes: Array<{ id: ActivityScope; label: string }> = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All" },
];

const moderationActionLabels: Record<string, string> = {
  delete_message: "Messages deleted",
  mute_actor: "Participants muted",
  unmute_actor: "Participants unmuted",
  remove_actor: "Participants removed",
};

const actorTypeRowLabels: Record<ActorType | "unknown", string> = {
  human: "Humans",
  chat_bot: "Chat bots",
  mod_bot: "Mod bots",
  unknown: "Others",
};

const shortDate = (ms: number): string =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(ms));

const bucketShade = (count: number, max: number): string =>
  `rgba(255, 255, 255, ${count === 0 ? 0.04 : 0.1 + 0.6 * (count / max)})`;

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

  return profilePictureShades[hash % profilePictureShades.length];
};

const actorProfilePictureUrl = (actor: Actor | undefined): string | null =>
  actor?.profilePictureUrl ?? null;

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

// Panel widths survive restarts the way the window's own frame does:
// window-state remembers the frame, this remembers the panels.
const usePanelWidth = (
  storageKey: string,
  limits: { min: number; max: number; initial: number },
): [number, (width: number) => void] => {
  const [width, setWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(storageKey));

    return Number.isFinite(stored) && stored > 0
      ? clampWidth(stored, limits.min, limits.max)
      : limits.initial;
  });

  const update = (next: number) => {
    const clamped = clampWidth(next, limits.min, limits.max);
    setWidth(clamped);
    window.localStorage.setItem(storageKey, String(Math.round(clamped)));
  };

  return [width, update];
};

// The draggable seam between a side panel and the conversation. The visible
// line stays hairline-thin; the hit area straddles the panel border so it is
// easy to grab. grow says which pointer direction widens the panel.
function PanelResizeHandle({
  label,
  width,
  limits,
  onWidthChange,
  grow,
}: {
  label: string;
  width: number;
  limits: { min: number; max: number; initial: number };
  onWidthChange: (width: number) => void;
  grow: 1 | -1;
}) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) {
      return;
    }

    drag.current = null;
    setDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId) {
          onWidthChange(
            drag.current.startWidth +
              grow * (event.clientX - drag.current.startX),
          );
        }
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          onWidthChange(width + grow * direction * panelResizeStep);
        }
      }}
      className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none focus-visible:outline-none"
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
          dragging
            ? "bg-white/40"
            : "bg-transparent group-hover:bg-white/25 group-focus-visible:bg-white/40"
        }`}
      />
    </div>
  );
}

function ActorProfilePicture({
  actor,
  actorId,
  name,
  size = "md",
}: {
  actor: Actor | undefined;
  actorId: string | null;
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const dimensions =
    size === "sm"
      ? "h-8 w-8 rounded-xl text-[10px]"
      : size === "lg"
        ? "h-16 w-16 rounded-2xl text-[15px]"
        : "h-10 w-10 rounded-xl text-[11px]";
  const imageUrl = actorProfilePictureUrl(actor);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);

  return (
    <div className="relative shrink-0">
      <div
        className={`flex ${dimensions} items-center justify-center border border-white/10 font-semibold text-zinc-100`}
        style={{ backgroundColor: shadeFor(actorId) }}
      >
        {imageUrl !== null && !imageFailed ? (
          <img
            src={imageUrl}
            alt={name}
            className="h-full w-full rounded-inherit object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          monogram(name)
        )}
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
            className={`rounded-md px-2.5 py-1 text-[12px] transition ${
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
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
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

function MessageMedia({ event }: { event: RoomEvent }) {
  const parts = contentParts(event).filter(
    (part): part is EventAssetPart => part.kind !== "text",
  );

  if (parts.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 flex max-w-[720px] flex-col gap-2">
      {parts.map((part) => {
        const url = mediaAssetDataUrl(roomId, part.mediaAssetId);

        if (part.kind === "image") {
          return (
            <figure key={part.partId}>
              <img
                src={url}
                alt={part.caption ?? "Shared image"}
                className="max-h-[460px] max-w-full rounded-xl border border-white/10 object-contain"
              />
              {part.caption !== null ? (
                <figcaption className="mt-1 text-xs text-zinc-500">
                  {part.caption}
                </figcaption>
              ) : null}
            </figure>
          );
        }

        if (part.kind === "video") {
          return (
            <figure key={part.partId}>
              <video
                controls
                preload="metadata"
                src={url}
                className="max-h-[460px] max-w-full rounded-xl border border-white/10"
              />
              {part.caption !== null ? (
                <figcaption className="mt-1 text-xs text-zinc-500">
                  {part.caption}
                </figcaption>
              ) : null}
            </figure>
          );
        }

        if (part.kind === "audio") {
          return (
            <figure key={part.partId}>
              <audio
                controls
                preload="metadata"
                src={url}
                className="w-full max-w-xl"
              />
              {part.caption !== null ? (
                <figcaption className="mt-1 text-xs text-zinc-500">
                  {part.caption}
                </figcaption>
              ) : null}
            </figure>
          );
        }

        return (
          <a
            key={part.partId}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex max-w-xl items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07] hover:text-white"
          >
            <Paperclip className="h-4 w-4" />
            <span>{part.caption ?? "Open shared file"}</span>
          </a>
        );
      })}
    </div>
  );
}

function ChatMessage({
  actors,
  event,
  grouped,
  localActorId,
  mentionLabels,
  repliedEvent,
  onReply,
}: {
  actors: Map<string, Actor>;
  event: RoomEvent;
  grouped: boolean;
  localActorId: string | undefined;
  mentionLabels: MentionLabel[];
  repliedEvent: RoomEvent | null;
  onReply?: () => void;
}) {
  const actor = event.actorId === null ? undefined : actors.get(event.actorId);
  const ownMessage = event.actorId === localActorId;
  const name = actorLabel(event.actorId, actors);
  const content = eventText(event);
  const isReply = payloadReply(event) !== null;
  const body = renderMessageBody(content, mentionLabels, localActorId);

  if (grouped) {
    return (
      <article className="group relative flex gap-3 px-4 py-1 hover:bg-white/[0.03] sm:px-6">
        <div className="flex w-8 shrink-0 justify-center">
          <time className="mt-1 hidden text-[10px] tabular-nums text-zinc-600 group-hover:block">
            {formatTime(event.occurredAt)}
          </time>
        </div>
        <div className="min-w-0 flex-1 pr-20">
          {content.length > 0 ? (
            <p className="max-w-[76ch] whitespace-pre-wrap break-words text-[13px] leading-[22px] text-zinc-200">
              {body}
            </p>
          ) : null}
          <MessageMedia event={event} />
        </div>
        <MessageActions onReply={onReply} />
      </article>
    );
  }

  return (
    <article className="group relative mt-5 flex gap-3 px-4 py-1 hover:bg-white/[0.03] sm:px-6">
      <div className="w-8 shrink-0">
        <ActorProfilePicture actor={actor} actorId={event.actorId} name={name} size="sm" />
      </div>

      <div className="min-w-0 flex-1 pr-20">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[12px] font-semibold text-zinc-100">{name}</span>
          {actor?.type !== "human" && actor !== undefined ? (
            <span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-zinc-400">
              {formatRole(actor)}
            </span>
          ) : null}
          {ownMessage ? (
            <span className="text-[11px] text-zinc-500">You</span>
          ) : null}
          <time className="text-[10px] tabular-nums text-zinc-500">
            {formatTime(event.occurredAt)}
          </time>
        </div>
        {isReply ? (
          <div className="mt-2 flex min-w-0 max-w-[64ch] items-stretch overflow-hidden rounded-xl border border-white/[0.08] bg-[#121212] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
            <span className="w-1 shrink-0 bg-zinc-400/80" />
            <div className="min-w-0 px-3 py-2">
              {repliedEvent === null ? (
                <p className="text-[11px] italic text-zinc-500">
                  Earlier message
                </p>
              ) : (
                <>
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
                    <CornerUpLeft className="h-3 w-3 shrink-0 text-zinc-500" />
                    Replying to
                  </p>
                  <p className="mt-0.5 truncate text-[11px] font-medium text-zinc-300">
                    {actorLabel(repliedEvent.actorId, actors)}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] leading-5 text-zinc-500">
                    {eventContent(repliedEvent)}
                  </p>
                </>
              )}
            </div>
          </div>
        ) : null}
        {content.length > 0 ? (
          <p className="mt-1.5 max-w-[76ch] whitespace-pre-wrap break-words text-[13px] leading-[22px] text-zinc-200">
            {body}
          </p>
        ) : null}
        <MessageMedia event={event} />
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

// One row of the Activity card: the headline number is always visible, the
// breakdown sits behind the same expand grammar the Rules list uses.
function ActivitySection({
  label,
  value,
  open,
  onToggle,
  children,
}: {
  label: string;
  value: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-white/[0.06]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-1 py-2 text-left hover:bg-white/[0.03]"
      >
        <span className="flex-1 text-[12px] font-medium text-zinc-400">
          {label}
        </span>
        <span className="text-[13px] font-semibold tabular-nums text-zinc-100">
          {value}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open ? <div className="space-y-1.5 px-1 pb-2.5">{children}</div> : null}
    </div>
  );
}

function ActivityCountRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">
        {label}
      </span>
      <span className="text-[11px] tabular-nums text-zinc-300">
        {count.toLocaleString()}
      </span>
    </div>
  );
}

function ParticipantRow({
  actor,
  status,
}: {
  actor: Actor;
  status: ParticipantStatus;
}) {
  const statusStyles: Record<
    ParticipantStatus,
    { dot: string; label: string; text: string }
  > = {
    active: {
      dot: "bg-emerald-400",
      label: "Active",
      text: "text-emerald-300",
    },
    idle: {
      dot: "bg-amber-400",
      label: "Idle",
      text: "text-amber-300",
    },
    offline: {
      dot: "bg-zinc-500",
      label: "Offline",
      text: "text-zinc-500",
    },
  };

  const currentStatus = statusStyles[status];

  return (
    <div className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-white/[0.04]">
      <div className="relative">
        <ActorProfilePicture
          actor={actor}
          actorId={actor.id}
          name={actor.display}
          size="sm"
        />
        <span
          className={`absolute -bottom-0.5 -left-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0d0d0d] ${currentStatus.dot}`}
          title={currentStatus.label}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-zinc-200">
          {actor.display}
        </p>
        <p className={`mt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] ${currentStatus.text}`}>
          {currentStatus.label}
        </p>
      </div>
    </div>
  );
}

function ProfileStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-black/20 px-3 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
        {label}
      </p>
      <p className="mt-1 text-[13px] font-semibold text-zinc-100">{value}</p>
    </div>
  );
}

function ProfileDetailRow({
  icon,
  label,
  value,
  subtle = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  subtle?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl px-1 py-1.5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-zinc-400">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
          {label}
        </p>
        <p
          className={`mt-0.5 text-[12px] leading-5 ${
            subtle ? "text-zinc-400" : "text-zinc-200"
          }`}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

function StartScreen({
  onSignedIn,
}: {
  onSignedIn: (outcome: BrowserLoginOutcome) => void;
}) {
  const [session, setSession] = useState<BrowserLoginSession | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [codePending, setCodePending] = useState(false);
  const [preparingSession, setPreparingSession] = useState(false);
  const [waitingForBrowser, setWaitingForBrowser] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const boundBrowserSession = useRef<BrowserLoginSession | null>(null);

  const loginFailureMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error) {
      return error.message;
    }

    return typeof error === "string" && error.trim().length > 0
      ? error
      : fallback;
  };

  const bindBrowserSession = (prepared: BrowserLoginSession) => {
    setSession(prepared);
    setLoginUrl(prepared.authorizeUrl);

    if (boundBrowserSession.current === prepared) {
      return prepared;
    }

    boundBrowserSession.current = prepared;
    prepared.automatic.then(
      (outcome) => {
        if (boundBrowserSession.current === prepared) {
          onSignedIn(outcome);
        }
      },
      (error: unknown) => {
        if (boundBrowserSession.current !== prepared) {
          return;
        }

        boundBrowserSession.current = null;
        setSession((current) => (current === prepared ? null : current));
        setWaitingForBrowser(false);
        setLoginError(loginFailureMessage(
          error,
          "The Browser log-in did not complete.",
        ),
        );
      },
    );

    return prepared;
  };

  const ensureBrowserSession = async (): Promise<BrowserLoginSession> => {
    if (session !== null) {
      return session;
    }

    setPreparingSession(true);

    try {
      return bindBrowserSession(await getBrowserLoginSession());
    } finally {
      setPreparingSession(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    setPreparingSession(true);

    void getBrowserLoginSession()
      .then((prepared) => {
        if (cancelled) {
          return;
        }

        bindBrowserSession(prepared);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setLoginError(loginFailureMessage(
          error,
          "The log-in link could not be prepared.",
        ),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setPreparingSession(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const resetLoginFlow = useEffectEvent(async (message: string | null) => {
    boundBrowserSession.current = null;
    setAuthCode("");
    setCodePending(false);
    setPreparingSession(false);
    setWaitingForBrowser(false);
    setCopied(false);
    setSession(null);
    setLoginUrl(null);

    await resetBrowserLoginSession();
    setLoginError(message);
  });

  useEffect(() => {
    if (!waitingForBrowser || loginError !== null) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      void resetLoginFlow(
        "The Browser log-in took too long and was reset. Start again when you are ready.",
      );
    }, browserLoginWaitMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loginError, resetLoginFlow, waitingForBrowser]);

  const copyLoginUrl = async () => {
    setLoginError(null);

    try {
      const url = loginUrl ?? (await ensureBrowserSession()).authorizeUrl;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      setLoginError(loginFailureMessage(
        error,
        "The log-in link could not be prepared.",
      ),
      );
    }
  };

  const continueInBrowser = async () => {
    setLoginError(null);
    setWaitingForBrowser(true);

    try {
      const prepared = await ensureBrowserSession();
      await openInBrowser(prepared.authorizeUrl);
    } catch (error) {
      setWaitingForBrowser(false);
      setLoginError(loginFailureMessage(
        error,
        "The Browser log-in could not be started.",
      ),
      );
    }
  };

  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (codePending || authCode.trim().length === 0) {
      return;
    }

    setLoginError(null);
    setCodePending(true);

    try {
      const prepared = await ensureBrowserSession();
      const outcome = await prepared.completeWithCode(authCode);
      onSignedIn(outcome);
    } catch (error) {
      setLoginError(loginFailureMessage(
        error,
        "The authorization code was not accepted.",
      ),
      );
    } finally {
      setCodePending(false);
    }
  };


  return (
    <section className="modbots-scroll relative flex min-h-0 flex-1 overflow-y-auto">
      <div
        className="pointer-events-none absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${startScreenBg})` }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-black/35 to-black/60"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(620px 720px at 50% 50%, rgba(0,0,0,0.8), rgba(0,0,0,0.35) 58%, transparent 78%)",
        }}
        aria-hidden="true"
      />
      <div className="relative mx-auto flex w-full max-w-[420px] flex-col justify-center px-6 py-12">
        <div className="text-center">
          <img
            src={appLogo}
            alt=""
            className="mx-auto h-12 w-12 rounded-lg shadow-[0_8px_24px_rgba(0,143,255,0.2)]"
          />
          <h1 className="mt-5 text-[26px] font-semibold tracking-tight text-white">
            Mod Bots
          </h1>
          <p className="mx-auto mt-2 max-w-[34ch] text-sm leading-6 text-zinc-500">
            {roomAbout}
          </p>
        </div>

        <div className="mt-8 rounded-lg border border-white/10 bg-[#141414]/90 p-5 shadow-[0_16px_50px_rgba(0,0,0,0.5)] backdrop-blur-sm">
          <h2 className="text-sm font-semibold text-zinc-100">Log in</h2>

          <div className="mt-3 flex items-center gap-1.5 rounded-md border border-white/10 bg-[#0f0f0f] py-1.5 pl-3 pr-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-400">
              {loginUrl ?? "Preparing your log-in link..."}
            </span>
            <button
              type="button"
              onClick={() => {
                void copyLoginUrl();
              }}
              disabled={preparingSession && loginUrl === null}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed"
              aria-label="Copy the log-in link"
              title="Copy"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          <div className="my-3 flex items-center gap-3">
            <span className="h-px flex-1 bg-white/[0.08]" />
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-zinc-600">
              or
            </span>
            <span className="h-px flex-1 bg-white/[0.08]" />
          </div>

          <form onSubmit={submitCode} autoComplete="off">
            <div className="flex items-center gap-1.5 rounded-md border border-white/10 bg-[#0f0f0f] py-1.5 pl-3 pr-1.5 focus-within:border-white/25">
              <input
                value={authCode}
                onChange={(event) => setAuthCode(event.currentTarget.value)}
                placeholder="Authorization code (optional)"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600"
              />
              <button
                type="submit"
                disabled={authCode.trim().length === 0 || codePending || preparingSession}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-500"
                aria-label="Log in with the authorization code"
                title="Log in with this code"
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </form>

          {loginError !== null ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
              <span>{loginError}</span>
            </div>
          ) : null}

          <button
            type="button"
            onClick={continueInBrowser}
            disabled={preparingSession || codePending}
            className="mt-4 flex h-11 w-full items-center justify-center rounded-md bg-white px-4 text-sm font-semibold text-black transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#141414] disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {preparingSession
              ? "Preparing Browser Login..."
              : waitingForBrowser
                ? "Waiting for your Browser..."
                : "Continue in Browser"}
          </button>
          {waitingForBrowser && loginError === null ? (
            <p className="mt-2 text-center text-[11px] leading-5 text-zinc-500">
              Nothing happening? Click again to reopen your Browser.
            </p>
          ) : null}
        </div>

        <p className="mt-6 text-center text-[11px] leading-5 text-zinc-400">
          Humans come and go; the chat bots live here. Mod bots watch the room
          and learn to moderate from everything that happens.
        </p>
      </div>
    </section>
  );
}


function App() {
  const {
    actors,
    adoptBrowserLogin,
    apiHealth,
    desktopSession,
    enterRoom,
    events,
    hasIdentity,
    localActor,
    onlineActorIds,
    overview,
    realtimeStatus,
    rules,
    refresh,
    sendContent,
    sendMessage,
    signOut,
  } = useRoomActivity(roomId);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [mutedNotice, setMutedNotice] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(true);
  const [aboutPanelOpen, setAboutPanelOpen] = useState(true);
  const [participantsWidth, setParticipantsWidth] = usePanelWidth(
    "modbots.desktop.participants-panel-width",
    participantsPanel,
  );
  const [aboutWidth, setAboutWidth] = usePanelWidth(
    "modbots.desktop.about-panel-width",
    aboutPanel,
  );
  const [activityScope, setActivityScope] = useState<ActivityScope>("7d");
  // Moderation opens by default: what the mod bots did is the one story
  // only this room can tell.
  const [openActivity, setOpenActivity] = useState<Record<string, boolean>>({
    moderation: true,
  });
  const toggleActivitySection = (id: string) =>
    setOpenActivity((previous) => ({
      ...previous,
      [id]: !(previous[id] ?? false),
    }));
  const [openRuleId, setOpenRuleId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [replyTarget, setReplyTarget] = useState<RoomEvent | null>(null);
  // The active participant picker in the composer, opened by typing `@`.
  const [mention, setMention] = useState<{ query: string; index: number } | null>(
    null,
  );
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // Entering the room is an explicit act every launch: nothing inside the
  // room renders until the person finishes the browser-side sign-in flow.
  const [entered, setEntered] = useState(false);
  const presenceJoinedAs = useRef<string | null>(null);
  const conversationViewport = useRef<HTMLDivElement>(null);
  const conversationPositioned = useRef(false);
  const followLatestMessage = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const apiConnected = apiHealth.data?.status === "ok";
  const chatBotCount = onlineActorIds.filter(
    (actorId) => actors.get(actorId)?.type === "chat_bot",
  ).length;
  const modBotCount = onlineActorIds.filter(
    (actorId) => actors.get(actorId)?.type === "mod_bot",
  ).length;
  const participantStatuses = useMemo(() => {
    const statuses = new Map<
      string,
      {
        present: boolean;
        lastActivityAt: number | null;
      }
    >();

    for (const event of events.data ?? []) {
      if (event.actorId === null) {
        continue;
      }

      const current = statuses.get(event.actorId) ?? {
        present: false,
        lastActivityAt: null,
      };
      const occurredAt = new Date(event.occurredAt).getTime();

      if (event.type === "actor_joined") {
        current.present = true;
        current.lastActivityAt = occurredAt;
      } else if (event.type === "actor_left") {
        current.present = false;
      } else if (
        event.type === "message_posted" ||
        event.type === "content_posted" ||
        event.type === "moderation_action_applied"
      ) {
        current.lastActivityAt = occurredAt;
      }

      statuses.set(event.actorId, current);
    }

    return statuses;
  }, [events.data]);
  const visibleOnlineActors = onlineActorIds
    .map((actorId) => actors.get(actorId))
    .filter(
      (actor): actor is Actor =>
        actor !== undefined && isVisibleParticipant(actor),
    );
  const roster = useMemo(() => {
    const now = Date.now();
    const onlineHumans = visibleOnlineActors.filter(
      (actor) => actor.type === "human",
    );
    const botResidents = [...actors.values()]
      .filter(
        (actor) =>
          actor.retiredAt === null &&
          actor.profilePictureUrl !== null &&
          (actor.type === "chat_bot" || actor.type === "mod_bot"),
      )
      .sort((left, right) => left.display.localeCompare(right.display));

    const statusFor = (actor: Actor): ParticipantStatus => {
      const state = participantStatuses.get(actor.id);
      const lastActivityAt = state?.lastActivityAt ?? null;

      if (actor.type === "human") {
        return lastActivityAt !== null &&
          now - lastActivityAt <= participantActiveWindowMs
          ? "active"
          : "idle";
      }

      if (state?.present !== true) {
        return "offline";
      }

      return lastActivityAt !== null &&
        now - lastActivityAt <= participantActiveWindowMs
        ? "active"
        : "idle";
    };

    const membersByType: Record<ActorType, Array<{ actor: Actor; status: ParticipantStatus }>> = {
      human: onlineHumans.map((actor) => ({ actor, status: statusFor(actor) })),
      chat_bot: botResidents
        .filter((actor) => actor.type === "chat_bot")
        .map((actor) => ({ actor, status: statusFor(actor) })),
      mod_bot: botResidents
        .filter((actor) => actor.type === "mod_bot")
        .map((actor) => ({ actor, status: statusFor(actor) })),
    };

    return roleOrder.map((type) => ({
      type,
      members: membersByType[type],
    }));
  }, [actors, participantStatuses, visibleOnlineActors]);
  const roomEvents = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();

    return (events.data ?? [])
      .filter(
        (event) =>
          event.type === "message_posted" ||
          event.type === "content_posted" ||
          event.type === "moderation_action_applied",
      )
      .filter((event) => {
        if (query.length === 0) {
          return true;
        }

        return (
          eventContent(event).toLocaleLowerCase().includes(query)
        );
      });
  }, [events.data, searchQuery]);
  const timeline = useMemo(() => buildTimeline(roomEvents), [roomEvents]);
  // Replies reference the content item behind a message; this resolves the
  // reference back to the original message for the quoted line.
  const messagesByContentItem = useMemo(() => {
    const map = new Map<string, RoomEvent>();

    for (const event of events.data ?? []) {
      if (event.type !== "message_posted" && event.type !== "content_posted") {
        continue;
      }

      const contentItemId = payloadString(event, "contentItemId");

      if (contentItemId !== null) {
        map.set(contentItemId, event);
      }
    }

    return map;
  }, [events.data]);
  // The dictionary the message renderer matches `@mentions` against.
  const mentionLabels = useMemo(() => buildMentionLabels(actors), [actors]);
  const ruleTitles = useMemo(
    () =>
      new Map((rules.data?.rules ?? []).map((rule) => [rule.id, rule.title])),
    [rules.data],
  );
  // The room's activity, computed from the full event history the client
  // already holds (getRoomEvents pages through the entire record). The
  // scope tabs re-window the same record; nothing here is estimated.
  const activity = useMemo(() => {
    const dayMs = 86_400_000;
    const weekMs = 7 * dayMs;
    const source = events.data ?? [];
    const todayStart = startOfDay(new Date());
    const firstEventStart =
      source.length > 0
        ? startOfDay(new Date(source[0].occurredAt))
        : todayStart;
    // "All" buckets by week, anchored so today falls in the last bucket;
    // the leading partial week folds into the first bucket.
    const bucketMs = activityScope === "all" ? weekMs : dayMs;
    const start =
      activityScope === "7d"
        ? todayStart - 6 * dayMs
        : activityScope === "30d"
          ? todayStart - 29 * dayMs
          : todayStart -
            Math.floor((todayStart - firstEventStart) / weekMs) * weekMs;
    const bucketCount =
      activityScope === "7d"
        ? 7
        : activityScope === "30d"
          ? 30
          : Math.floor((todayStart - start) / weekMs) + 1;
    const weekdayName = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
    });
    const weekdayInitial = new Intl.DateTimeFormat(undefined, {
      weekday: "narrow",
    });
    const buckets = Array.from({ length: bucketCount }, (_, index) => {
      const at = start + index * bucketMs;

      return {
        key: String(at),
        count: 0,
        label:
          activityScope === "7d"
            ? weekdayName.format(new Date(at))
            : activityScope === "30d"
              ? shortDate(at)
              : `Week of ${shortDate(at)}`,
        initial:
          activityScope === "7d"
            ? weekdayInitial.format(new Date(at))
            : null,
      };
    });
    const messagesByType: Record<ActorType | "unknown", number> = {
      human: 0,
      chat_bot: 0,
      mod_bot: 0,
      unknown: 0,
    };
    const talkedByType: Record<ActorType | "unknown", Set<string>> = {
      human: new Set(),
      chat_bot: new Set(),
      mod_bot: new Set(),
      unknown: new Set(),
    };
    const moderationByAction = new Map<string, number>();
    const messagesByActor = new Map<string, number>();
    let messages = 0;
    let moderationTotal = 0;

    for (const event of source) {
      const occurred = new Date(event.occurredAt).getTime();

      if (activityScope !== "all" && occurred < start) {
        continue;
      }

      if (
        event.type === "message_posted" ||
        event.type === "content_posted"
      ) {
        messages += 1;
        const index = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor((occurred - start) / bucketMs)),
        );
        buckets[index].count += 1;
        const type =
          event.actorId === null
            ? "unknown"
            : (actors.get(event.actorId)?.type ?? "unknown");
        messagesByType[type] += 1;

        if (event.actorId !== null) {
          talkedByType[type].add(event.actorId);
          messagesByActor.set(
            event.actorId,
            (messagesByActor.get(event.actorId) ?? 0) + 1,
          );
        }
      } else if (event.type === "moderation_action_applied") {
        moderationTotal += 1;
        const action = payloadString(event, "action") ?? "other";
        moderationByAction.set(
          action,
          (moderationByAction.get(action) ?? 0) + 1,
        );
      }
    }

    const typeOrder: Array<ActorType | "unknown"> = [
      "human",
      "chat_bot",
      "mod_bot",
      "unknown",
    ];
    const messageRows = typeOrder
      .filter((type) => messagesByType[type] > 0)
      .map((type) => ({
        label: actorTypeRowLabels[type],
        count: messagesByType[type],
      }))
      .sort((a, b) => b.count - a.count);
    const talkedRows = typeOrder
      .filter((type) => talkedByType[type].size > 0)
      .map((type) => ({
        label: actorTypeRowLabels[type],
        count: talkedByType[type].size,
      }))
      .sort((a, b) => b.count - a.count);
    const moderationRows = [...moderationByAction]
      .map(([action, count]) => ({
        label: moderationActionLabels[action] ?? action.replace(/_/g, " "),
        count,
      }))
      .sort((a, b) => b.count - a.count);
    const topPosters = [...messagesByActor]
      .map(([actorId, count]) => ({ actorId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      buckets,
      max: Math.max(...buckets.map((bucket) => bucket.count), 1),
      messages,
      messageRows,
      moderationTotal,
      moderationRows,
      talkedTotal: talkedRows.reduce((sum, row) => sum + row.count, 0),
      talkedRows,
      topPosters,
      rangeStartLabel:
        activityScope === "all"
          ? shortDate(firstEventStart)
          : shortDate(start),
    };
  }, [events.data, actors, activityScope]);
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
  const localProfile = useMemo(() => {
    if (localActor === undefined) {
      return null;
    }

    let messages = 0;
    let messagesToday = 0;
    let replies = 0;
    let lastMessageAt: string | null = null;
    let joinedAt: string | null = null;
    const todayStart = startOfDay(new Date());

    for (const event of events.data ?? []) {
      if (event.actorId !== localActor.id) {
        continue;
      }

      if (event.type === "actor_joined") {
        joinedAt = event.occurredAt;
      }

      if (
        event.type !== "message_posted" &&
        event.type !== "content_posted"
      ) {
        continue;
      }

      messages += 1;
      lastMessageAt = event.occurredAt;

      if (payloadReply(event) !== null) {
        replies += 1;
      }

      if (new Date(event.occurredAt).getTime() >= todayStart) {
        messagesToday += 1;
      }
    }

    return {
      accountLabel: localActor.registered ? "Registered account" : "Guest session",
      handleLabel:
        localActor.registered && localActor.handle !== null
          ? `@${localActor.handle}`
          : "This identity ends when you leave",
      joinedAt,
      lastMessageAt,
      messages,
      messagesToday,
      replies,
      online: onlineActorIds.includes(localActor.id),
    };
  }, [events.data, localActor, onlineActorIds]);
  // Everyone a human can address: the bot residents, always in the room, and
  // any other human currently present. Yourself and the platform are never
  // addressees.
  const addressableParticipants = useMemo(() => {
    const seen = new Set<string>();
    const list: Actor[] = [];
    const consider = (actor: Actor | undefined) => {
      if (
        actor === undefined ||
        actor.retiredAt !== null ||
        actor.id === localActor?.id ||
        seen.has(actor.id) ||
        !isVisibleParticipant(actor)
      ) {
        return;
      }

      seen.add(actor.id);
      list.push(actor);
    };

    for (const actor of actors.values()) {
      if (actor.type === "chat_bot" || actor.type === "mod_bot") {
        consider(actor);
      }
    }

    for (const actorId of onlineActorIds) {
      consider(actors.get(actorId));
    }

    return list.sort((left, right) => left.display.localeCompare(right.display));
  }, [actors, onlineActorIds, localActor]);
  const mentionOptions = useMemo((): MentionOption[] => {
    if (mention === null) {
      return [];
    }

    const query = mention.query.toLowerCase();
    const options: MentionOption[] = [];

    if (
      query.length === 0 ||
      "room".startsWith(query) ||
      "everyone".startsWith(query)
    ) {
      options.push({ kind: "room" });
    }

    for (const actor of addressableParticipants) {
      if (
        query.length === 0 ||
        actor.displayName.toLowerCase().includes(query) ||
        actor.display.toLowerCase().includes(query)
      ) {
        options.push({ kind: "actor", actor });
      }
    }

    return options.slice(0, 8);
  }, [mention, addressableParticipants]);
  const updateMentionState = (text: string, caret: number) => {
    const found = mentionAt(text, caret);
    setMention(found === null ? null : { query: found.query, index: 0 });
  };
  const applyMention = (option: MentionOption) => {
    const caret = composerRef.current?.selectionStart ?? draft.length;
    const found = mentionAt(draft, caret);

    if (found === null) {
      setMention(null);
      return;
    }

    const token =
      option.kind === "room" ? "@room" : `@${option.actor.display}`;
    const insertion = `${token} `;
    const before = draft.slice(0, found.start);
    const after = draft.slice(caret);
    const nextCaret = before.length + insertion.length;

    setDraft(`${before}${insertion}${after}`);
    setMention(null);

    requestAnimationFrame(() => {
      const element = composerRef.current;

      if (element !== null) {
        element.focus();
        element.setSelectionRange(nextCaret, nextCaret);
      }
    });
  };
  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (mention !== null && mentionOptions.length > 0) {
      const count = mentionOptions.length;
      const active = Math.min(mention.index, count - 1);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMention({ query: mention.query, index: (active + 1) % count });
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMention({
          query: mention.query,
          index: (active - 1 + count) % count,
        });
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(mentionOptions[active]);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  const canSend =
    localActor !== undefined &&
    apiConnected &&
    (draft.trim().length > 0 || attachment !== null) &&
    !sendMessage.isPending &&
    !sendContent.isPending;
  const mutationError = sendMessage.error ?? sendContent.error;
  const sendError = isMutedError(mutationError) ? null : mutationError;
  const error =
    apiHealth.error ??
    desktopSession.error ??
    overview.error ??
    events.error ??
    sendError;
  const historyUnavailable = events.isError;
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
      followLatestMessage.current = true;
    }
  };

  const handleConversationScroll = () => {
    const viewport = conversationViewport.current;

    if (viewport === null) {
      return;
    }

    const distanceFromLatest =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    followLatestMessage.current = distanceFromLatest <= 48;
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
          label: "Log out",
          disabled: !hasIdentity,
          title: hasIdentity ? undefined : "You are not logged in yet",
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
    conversationPositioned.current = false;
    followLatestMessage.current = true;
  }, [entered, roomId]);

  useEffect(() => {
    if (!entered || searchQuery.length > 0) {
      return;
    }

    if (!conversationPositioned.current || followLatestMessage.current) {
      scrollToLatest();
      conversationPositioned.current = true;
    }
  }, [entered, timeline.length, searchQuery]);

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
        setUserMenuOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Signing out (or a stale identity being dropped) closes the door again.
  useEffect(() => {
    if (!hasIdentity) {
      setEntered(false);
      presenceJoinedAs.current = null;
    }
  }, [hasIdentity]);

  // No stored identity is ever presented at the door: offering someone
  // else's account for one-click entry is an account takeover on a shared
  // machine, and a returning guest is a new actor by design. Every launch
  // starts signed out; remembered sign-in arrives with the browser
  // hand-off, where the account site's own session does the remembering.
  const droppedStaleIdentity = useRef(false);

  useEffect(() => {
    if (!entered && !droppedStaleIdentity.current && localActor !== undefined) {
      droppedStaleIdentity.current = true;
      void signOut();
    }
  }, [entered, localActor, signOut]);

  // Presence joins once per identity after the person chooses to enter,
  // whether they continued a stored session or just joined fresh.
  useEffect(() => {
    if (
      entered &&
      localActor !== undefined &&
      presenceJoinedAs.current !== localActor.id
    ) {
      presenceJoinedAs.current = localActor.id;
      void enterRoom();
    }
  }, [entered, localActor, enterRoom]);

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();

    if (!canSend) {
      return;
    }

    setDraft("");
    setMention(null);
    setMutedNotice(null);
    const replyContentItemId =
      replyTarget === null
        ? null
        : payloadString(replyTarget, "contentItemId");
    const addressedTo = deriveAddressedTo(content, addressableParticipants);

    try {
      const addressing = {
        ...(replyContentItemId === null
          ? {}
          : { replyTo: { contentItemId: replyContentItemId } }),
        ...(addressedTo.length === 0 ? {} : { addressedTo }),
      };

      if (attachment === null) {
        await sendMessage.mutateAsync({ content, ...addressing });
      } else {
        await sendContent.mutateAsync({
          content,
          file: attachment,
          ...addressing,
        });
        setAttachment(null);
      }
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
      {userMenuOpen ? (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setUserMenuOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      {openMenu !== null ? (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setOpenMenu(null)}
          aria-hidden="true"
        />
      ) : null}

      <div className="flex min-h-0 flex-1">
        {!entered ? (
          <StartScreen
            onSignedIn={(outcome) => {
              adoptBrowserLogin(outcome);
              setEntered(true);
            }}
          />
        ) : (
          <>
        {membersOpen ? (
          <aside
            className="flex shrink-0 flex-col border-r border-white/[0.08] bg-[#0d0d0d]"
            style={{ width: participantsWidth }}
          >
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
                {visibleOnlineActors.length}
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
                      {group.members.map((member) => (
                        <ParticipantRow
                          key={member.actor.id}
                          actor={member.actor}
                          status={member.status}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="relative shrink-0 border-t border-white/[0.08] p-3">
              {userMenuOpen && localActor !== undefined && localProfile !== null ? (
                <div
                  className="absolute bottom-full left-3 right-3 z-30 mb-2 overflow-hidden rounded-[22px] border border-white/10 bg-[linear-gradient(180deg,rgba(28,28,28,0.98),rgba(17,17,17,0.98))] shadow-[0_24px_80px_rgba(0,0,0,0.58)] backdrop-blur-xl"
                  role="dialog"
                  aria-label="Your profile"
                >
                  <div className="border-b border-white/[0.08] bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.08),transparent_45%)] px-4 py-4">
                    <div className="flex items-start gap-3">
                      <ActorProfilePicture
                        actor={localActor}
                        actorId={localActor.id}
                        name={localActor.display}
                        size="lg"
                      />
                      <div className="min-w-0 flex-1 pt-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-[18px] font-semibold leading-6 text-zinc-50">
                            {localActor.display}
                          </p>
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-300">
                            {localProfile.accountLabel}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-[12px] text-zinc-400">
                          {localProfile.handleLabel}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-zinc-400">
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-black/20 px-2.5 py-1">
                            <span
                              className={`h-2 w-2 rounded-full ${
                                localProfile.online ? "bg-zinc-200" : "border border-zinc-500"
                              }`}
                            />
                            {localProfile.online ? "In the room" : "Away"}
                          </span>
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-black/20 px-2.5 py-1">
                            {isMuted ? (
                              <MicOff className="h-3 w-3" />
                            ) : (
                              <Shield className="h-3 w-3" />
                            )}
                            {isMuted ? "Muted" : "Good standing"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 border-b border-white/[0.08] px-4 py-3">
                    <ProfileStat
                      label="Messages"
                      value={localProfile.messages.toLocaleString()}
                    />
                    <ProfileStat
                      label="Today"
                      value={localProfile.messagesToday.toLocaleString()}
                    />
                    <ProfileStat
                      label="Replies"
                      value={localProfile.replies.toLocaleString()}
                    />
                    <ProfileStat
                      label="Last active"
                      value={
                        localProfile.lastMessageAt === null
                          ? "Listening"
                          : formatTime(localProfile.lastMessageAt)
                      }
                    />
                  </div>

                  <div className="space-y-1 px-4 py-3">
                    <ProfileDetailRow
                      icon={<CalendarDays className="h-4 w-4" />}
                      label={localActor.registered ? "Member since" : "Identity created"}
                      value={memberSince(localActor.createdAt)}
                    />
                    <ProfileDetailRow
                      icon={<DoorOpen className="h-4 w-4" />}
                      label="Room entry"
                      value={
                        localProfile.joinedAt === null
                          ? "This session has not entered the room yet"
                          : `Joined ${dateTimeLabel(localProfile.joinedAt)}`
                      }
                      subtle={localProfile.joinedAt === null}
                    />
                    <ProfileDetailRow
                      icon={<MessageSquare className="h-4 w-4" />}
                      label="Conversation"
                      value={
                        localProfile.lastMessageAt === null
                          ? "No messages sent yet"
                          : `Last message ${dateTimeLabel(localProfile.lastMessageAt)}`
                      }
                      subtle={localProfile.lastMessageAt === null}
                    />
                    <ProfileDetailRow
                      icon={<Users className="h-4 w-4" />}
                      label="People here now"
                      value={`${visibleOnlineActors.filter((actor) => actor.type === "human").length} humans, ${chatBotCount} chat bots, ${modBotCount} mod bots`}
                    />
                  </div>

                  <div className="border-t border-white/[0.08] px-3 py-3">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        void signOut();
                      }}
                      className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-3 text-left text-[12px] text-zinc-300 transition-colors hover:border-white/12 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-black/20 text-zinc-400">
                        <LogOut className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-zinc-100">
                          Log out
                        </span>
                        <span className="block text-[11px] text-zinc-500">
                          Close this identity and return to the room door
                        </span>
                      </span>
                    </button>
                  </div>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  localActor === undefined
                    ? undefined
                    : setUserMenuOpen((open) => !open)
                }
                disabled={localActor === undefined}
                aria-haspopup="dialog"
                aria-expanded={userMenuOpen}
                className={`group flex w-full items-center gap-3 rounded-[20px] border px-3 py-3 text-left shadow-[0_12px_36px_rgba(0,0,0,0.22)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-default ${
                  userMenuOpen
                    ? "border-white/12 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.04))]"
                    : "border-white/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] hover:border-white/10 hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))]"
                }`}
              >
                <div className="relative">
                  <ActorProfilePicture
                    actor={localActor}
                    actorId={localActor?.id ?? null}
                    name={localActor?.display ?? "You"}
                    size="md"
                  />
                  {localProfile?.online ? (
                    <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#0d0d0d] bg-zinc-200" />
                  ) : null}
                </div>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="block min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 text-zinc-100">
                      {localActor?.display ??
                        (hasIdentity ? "Preparing session..." : "Not joined")}
                    </span>
                    {localProfile !== null ? (
                      <span className="rounded-full border border-white/[0.08] bg-black/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                        {localActor?.registered ? "Account" : "Guest"}
                      </span>
                    ) : null}
                  </span>
                  {localProfile !== null ? (
                    <span className="mt-1 block truncate text-[11px] leading-5 text-zinc-400">
                      {localProfile.handleLabel}
                    </span>
                  ) : null}
                  {localProfile !== null ? (
                    <span className="mt-1 block truncate text-[11px] leading-4 text-zinc-600">
                      {localProfile.online ? "In the room now" : "Away from the room"}
                      {localProfile.messages > 0
                        ? ` · ${localProfile.messages.toLocaleString()} messages`
                        : " · listening"}
                    </span>
                  ) : null}
                </span>
                {localActor !== undefined ? (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-black/20 text-zinc-500 transition-colors group-hover:text-zinc-300">
                    <ChevronDown
                      className={`h-4 w-4 transition-transform duration-200 ${
                        userMenuOpen ? "rotate-180" : ""
                      }`}
                    />
                  </span>
                ) : null}
              </button>
            </div>
          </aside>
        ) : null}
        {membersOpen ? (
          <PanelResizeHandle
            label="Resize the participants panel"
            width={participantsWidth}
            limits={participantsPanel}
            onWidthChange={setParticipantsWidth}
            grow={1}
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="z-10 flex h-[68px] shrink-0 items-center gap-4 border-b border-white/[0.08] bg-[#0d0d0d] px-5">
            <h2 className="shrink-0 text-[14px] font-semibold text-white">Chat</h2>
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
                {historyUnavailable
                  ? "We couldn't load the conversation right now. Try again in a moment."
                  : error instanceof Error
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
            <section className="flex min-w-0 flex-1 flex-col">
              <div
                ref={conversationViewport}
                onScroll={handleConversationScroll}
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
                          : historyUnavailable
                            ? "We couldn't load the conversation"
                            : "Start the conversation"}
                      </h2>
                      <p className="mt-1 text-sm text-zinc-500">
                        {searchQuery.length > 0
                          ? "Try another word or phrase."
                          : historyUnavailable
                            ? "Try again in a moment."
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
                          mentionLabels={mentionLabels}
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
                {attachmentError !== null ? (
                  <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/10 bg-[#151515] px-3 py-2 text-xs text-zinc-300">
                    <CircleAlert className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    <span className="flex-1">{attachmentError}</span>
                    <button
                      type="button"
                      onClick={() => setAttachmentError(null)}
                      className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                      aria-label="Dismiss attachment error"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
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
                  className="relative rounded-2xl border border-white/10 bg-[#171717] shadow-[0_16px_50px_rgba(0,0,0,0.35)] focus-within:border-white/20"
                >
                  {mention !== null && mentionOptions.length > 0 ? (
                    <div className="absolute bottom-full left-0 mb-2 w-72 overflow-hidden rounded-xl border border-white/10 bg-[#181818] p-1 shadow-2xl">
                      <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-zinc-600">
                        Address someone
                      </p>
                      {mentionOptions.map((option, index) => {
                        const active =
                          index ===
                          Math.min(mention.index, mentionOptions.length - 1);

                        return (
                          <button
                            key={option.kind === "room" ? "room" : option.actor.id}
                            type="button"
                            onMouseDown={(pointerEvent) => {
                              pointerEvent.preventDefault();
                              applyMention(option);
                            }}
                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
                              active
                                ? "bg-white/[0.08] text-white"
                                : "text-zinc-300 hover:bg-white/[0.05]"
                            }`}
                          >
                            {option.kind === "room" ? (
                              <>
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-300">
                                  <Users className="h-4 w-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block text-[13px] font-medium">
                                    Room
                                  </span>
                                  <span className="block truncate text-[11px] text-zinc-500">
                                    Everyone here
                                  </span>
                                </span>
                              </>
                            ) : (
                              <>
                                <ActorProfilePicture
                                  actor={option.actor}
                                  actorId={option.actor.id}
                                  name={option.actor.display}
                                  size="sm"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[13px] font-medium">
                                    {option.actor.displayName}
                                  </span>
                                  <span className="block truncate text-[11px] text-zinc-500">
                                    {actorRole(option.actor.id, actors)}
                                  </span>
                                </span>
                              </>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
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
                        {eventContent(replyTarget)}
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
                  {attachment !== null ? (
                    <div className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-zinc-300">
                      <Paperclip className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {attachment.name}
                      </span>
                      <span className="text-zinc-500">
                        {(attachment.size / 1_048_576).toFixed(1)} MB
                      </span>
                      <button
                        type="button"
                        onClick={() => setAttachment(null)}
                        className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                        aria-label="Remove attachment"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : null}
                  <input
                    ref={attachmentInput}
                    type="file"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0] ?? null;

                      if (file !== null && file.size > 100 * 1024 * 1024) {
                        setAttachment(null);
                        setAttachmentError("Attachments cannot exceed 100 MB.");
                      } else {
                        setAttachment(file);
                        setAttachmentError(null);
                      }

                      event.currentTarget.value = "";
                    }}
                  />
                  <textarea
                    ref={composerRef}
                    value={draft}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setDraft(value);
                      updateMentionState(
                        value,
                        event.currentTarget.selectionStart ?? value.length,
                      );
                    }}
                    onSelect={(event) =>
                      updateMentionState(
                        event.currentTarget.value,
                        event.currentTarget.selectionStart ?? 0,
                      )
                    }
                    onBlur={() => setMention(null)}
                    onKeyDown={handleComposerKeyDown}
                    rows={1}
                    maxLength={4_000}
                    disabled={localActor === undefined || !apiConnected}
                    placeholder={
                      localActor === undefined
                        ? "Preparing your session..."
                        : "Message the room"
                    }
                    className="max-h-40 min-h-[58px] w-full resize-none bg-transparent px-4 pb-2 pt-4 text-[14px] leading-6 text-zinc-100 outline-none placeholder:text-zinc-500 disabled:cursor-not-allowed"
                  />
                  <div className="flex items-center justify-between px-2 pb-2">
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        disabled={!apiConnected || localActor === undefined}
                        onClick={() => {
                          if (attachmentInput.current !== null) {
                            attachmentInput.current.accept = "";
                            attachmentInput.current.click();
                          }
                        }}
                        className="rounded-lg p-2.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 disabled:cursor-not-allowed"
                        aria-label="Add files or media"
                        title="Add a file, image, audio, or video"
                      >
                        <Paperclip className="h-[18px] w-[18px]" />
                      </button>
                      <button
                        type="button"
                        disabled={!apiConnected || localActor === undefined}
                        onClick={() => {
                          if (attachmentInput.current !== null) {
                            attachmentInput.current.accept = "image/*";
                            attachmentInput.current.click();
                          }
                        }}
                        className="rounded-lg p-2.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 disabled:cursor-not-allowed"
                        aria-label="Add image"
                        title="Add an image"
                      >
                        <Image className="h-[18px] w-[18px]" />
                      </button>
                      <button
                        type="button"
                        disabled={!apiConnected || localActor === undefined}
                        onClick={() => {
                          if (attachmentInput.current !== null) {
                            attachmentInput.current.accept = "audio/*";
                            attachmentInput.current.click();
                          }
                        }}
                        className="rounded-lg p-2.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 disabled:cursor-not-allowed"
                        aria-label="Record voice message"
                        title="Add an audio recording"
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

          </div>
        </div>

        {aboutPanelOpen ? (
          <PanelResizeHandle
            label="Resize the about panel"
            width={aboutWidth}
            limits={aboutPanel}
            onWidthChange={setAboutWidth}
            grow={-1}
          />
        ) : null}
        {aboutPanelOpen ? (
          <aside
            className="flex shrink-0 flex-col border-l border-white/[0.08] bg-[#0d0d0d]"
            style={{ width: aboutWidth }}
          >
            <div className="flex h-[68px] shrink-0 items-center border-b border-white/[0.08] px-5" />
            <div className="modbots-scroll min-h-0 flex-1 overflow-y-auto p-5">
              <p className="text-[13px] font-semibold text-zinc-100">Mod Bots</p>
              <p className="mt-1 text-[13px] leading-5 text-zinc-400">
                {roomAbout}
              </p>

              <div className="mt-4 space-y-2.5 text-[13px] text-zinc-400">
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
                  <span>Text, images, audio, video, and files</span>
                </p>
              </div>

              <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                    Activity
                  </p>
                  <div
                    className="flex rounded-md border border-white/[0.08] bg-[#0f0f0f] p-0.5"
                    role="tablist"
                    aria-label="Activity period"
                  >
                    {activityScopes.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="tab"
                        aria-selected={activityScope === option.id}
                        onClick={() => setActivityScope(option.id)}
                        className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                          activityScope === option.id
                            ? "bg-white/[0.1] text-white"
                            : "text-zinc-500 hover:text-zinc-200"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                {activityScope === "7d" ? (
                  <div className="mt-2.5 grid grid-cols-7 gap-1.5">
                    {activity.buckets.map((bucket, index) => (
                      <div
                        key={bucket.key}
                        title={`${bucket.label} · ${bucket.count} ${
                          bucket.count === 1 ? "message" : "messages"
                        }`}
                      >
                        <div
                          className={`h-7 rounded-md ${
                            index === activity.buckets.length - 1
                              ? "ring-1 ring-inset ring-white/40"
                              : ""
                          }`}
                          style={{
                            backgroundColor: bucketShade(
                              bucket.count,
                              activity.max,
                            ),
                          }}
                        />
                        <p
                          className={`mt-1 text-center text-[9px] font-medium ${
                            index === activity.buckets.length - 1
                              ? "text-zinc-300"
                              : "text-zinc-600"
                          }`}
                        >
                          {bucket.initial}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(12px,1fr))] gap-1">
                      {activity.buckets.map((bucket, index) => (
                        <div
                          key={bucket.key}
                          title={`${bucket.label} · ${bucket.count} ${
                            bucket.count === 1 ? "message" : "messages"
                          }`}
                          className={`h-3 rounded-[3px] ${
                            index === activity.buckets.length - 1
                              ? "ring-1 ring-inset ring-white/40"
                              : ""
                          }`}
                          style={{
                            backgroundColor: bucketShade(
                              bucket.count,
                              activity.max,
                            ),
                          }}
                        />
                      ))}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[9px] font-medium text-zinc-600">
                      <span>{activity.rangeStartLabel}</span>
                      <span>Today</span>
                    </div>
                  </>
                )}

                <div className="mt-2.5">
                  <ActivitySection
                    label="Messages"
                    value={activity.messages.toLocaleString()}
                    open={openActivity.messages === true}
                    onToggle={() => toggleActivitySection("messages")}
                  >
                    {activity.messageRows.length === 0 ? (
                      <p className="text-[11px] text-zinc-600">
                        None in this period.
                      </p>
                    ) : (
                      activity.messageRows.map((row) => (
                        <ActivityCountRow
                          key={row.label}
                          label={`From ${row.label.toLocaleLowerCase()}`}
                          count={row.count}
                        />
                      ))
                    )}
                  </ActivitySection>
                  <ActivitySection
                    label="Moderation"
                    value={activity.moderationTotal.toLocaleString()}
                    open={openActivity.moderation === true}
                    onToggle={() => toggleActivitySection("moderation")}
                  >
                    {activity.moderationRows.length === 0 ? (
                      <p className="text-[11px] text-zinc-600">
                        None in this period.
                      </p>
                    ) : (
                      activity.moderationRows.map((row) => (
                        <ActivityCountRow
                          key={row.label}
                          label={row.label}
                          count={row.count}
                        />
                      ))
                    )}
                  </ActivitySection>
                  <ActivitySection
                    label="Participants"
                    value={activity.talkedTotal.toLocaleString()}
                    open={openActivity.talked === true}
                    onToggle={() => toggleActivitySection("talked")}
                  >
                    {activity.topPosters.length === 0 ? (
                      <p className="text-[11px] text-zinc-600">
                        None in this period.
                      </p>
                    ) : (
                      <>
                        <p className="text-[11px] text-zinc-600">
                          {activity.talkedRows
                            .map(
                              (row) =>
                                `${row.count} ${row.label.toLocaleLowerCase()}`,
                            )
                            .join(" · ")}
                        </p>
                        {activity.topPosters.map((poster) => {
                          const posterActor = actors.get(poster.actorId);
                          const posterName = actorLabel(
                            poster.actorId,
                            actors,
                          );

                          return (
                            <div
                              key={poster.actorId}
                              className="flex items-center gap-2"
                            >
                              <span
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-white/10 text-[8px] font-semibold text-zinc-200"
                                style={{
                                  backgroundColor: shadeFor(poster.actorId),
                                }}
                              >
                                {monogram(posterName)}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">
                                {posterName}
                              </span>
                              {posterActor !== undefined &&
                              posterActor.type !== "human" ? (
                                <span className="shrink-0 text-zinc-600">
                                  {roleBadgeIcon(posterActor.type)}
                                </span>
                              ) : null}
                              <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
                                {poster.count.toLocaleString()}
                              </span>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </ActivitySection>
                </div>
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
          </>
        )}
      </div>

      {entered ? (
        <StatusBar
          connectionLabel={connectionLabel}
          sending={sendMessage.isPending || sendContent.isPending}
          muted={isMuted}
          searchMatches={
            searchQuery.trim().length > 0 ? roomEvents.length : null
          }
        />
      ) : null}

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
              <img
                src={appLogo}
                alt=""
                className="h-11 w-11 rounded-xl"
              />
              <div>
                <p className="text-sm font-semibold text-white">
                  Mod Bots Desktop
                </p>
                <p className="text-xs text-zinc-500">Version {appVersion}</p>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-zinc-400">
              A multimodal chatroom where humans and chat bots talk, and mod
              bots learn to moderate from everything that happens.
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
