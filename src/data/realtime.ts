import type {
  RealtimeConfig,
  ReliableRoomEnvelope,
  RoomEvent,
} from "./contracts";

const MAX_FRAME_BYTES = 1_048_576;

const realtimeUrl = (
  template: string,
  roomId: string,
  after: string,
): string => {
  const url = new URL(template.replace("{roomId}", encodeURIComponent(roomId)));
  url.searchParams.set("after", after);
  return url.toString();
};

const reliableEnvelope = (value: unknown): ReliableRoomEnvelope => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("delivery" in value) ||
    value.delivery !== "reliable" ||
    !("channel" in value) ||
    value.channel !== "room.event" ||
    !("sequence" in value) ||
    typeof value.sequence !== "string" ||
    !("event" in value) ||
    typeof value.event !== "object" ||
    value.event === null
  ) {
    throw new Error("Realtime gateway returned an invalid room event");
  }

  return value as ReliableRoomEnvelope;
};

const decodeEnvelope = (raw: string): ReliableRoomEnvelope =>
  reliableEnvelope(JSON.parse(raw) as unknown);

const appendBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
};

const readReliableStream = async (
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: RoomEvent) => void,
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = new Uint8Array();

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();

      if (done) {
        return;
      }

      buffered = appendBytes(buffered, value);

      while (buffered.byteLength >= 4) {
        const frameLength = new DataView(
          buffered.buffer,
          buffered.byteOffset,
          4,
        ).getUint32(0);

        if (frameLength > MAX_FRAME_BYTES) {
          throw new Error("Realtime frame exceeded the desktop safety limit");
        }

        if (buffered.byteLength < 4 + frameLength) {
          break;
        }

        const frame = buffered.slice(4, 4 + frameLength);
        const envelope = decodeEnvelope(decoder.decode(frame));
        onEvent(envelope.event);
        buffered = buffered.slice(4 + frameLength);
      }
    }
  } finally {
    reader.releaseLock();
  }
};

export const runWebTransport = async (
  config: RealtimeConfig,
  roomId: string,
  after: string,
  signal: AbortSignal,
  onConnected: () => void,
  onEvent: (event: RoomEvent) => void,
): Promise<void> => {
  if (typeof WebTransport === "undefined") {
    throw new Error("WebTransport is unavailable in this WebView");
  }

  const hashes: WebTransportHash[] =
    config.primary.serverCertificateHashes.map((hash) => ({
      algorithm: hash.algorithm,
      value: new Uint8Array(hash.value),
    }));
  const transport = new WebTransport(
    realtimeUrl(config.primary.url, roomId, after),
    { serverCertificateHashes: hashes },
  );
  const close = () =>
    transport.close({ closeCode: 0, reason: "Desktop session stopped" });

  signal.addEventListener("abort", close, { once: true });

  try {
    await transport.ready;
    onConnected();

    const streams = transport.incomingUnidirectionalStreams.getReader();
    const { done, value } = await streams.read();
    streams.releaseLock();

    if (done || value === undefined) {
      throw new Error("WebTransport closed before opening the event stream");
    }

    await readReliableStream(value, signal, onEvent);
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
};

export const runWebSocket = (
  config: RealtimeConfig,
  roomId: string,
  after: string,
  signal: AbortSignal,
  onConnected: () => void,
  onEvent: (event: RoomEvent) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(
      realtimeUrl(config.fallback.url, roomId, after),
    );
    let connected = false;

    const stop = () => socket.close(1000, "Desktop session stopped");

    signal.addEventListener("abort", stop, { once: true });
    socket.addEventListener("open", () => {
      connected = true;
      onConnected();
    });
    socket.addEventListener("message", (message) => {
      try {
        const envelope = decodeEnvelope(String(message.data));
        onEvent(envelope.event);
      } catch (error) {
        socket.close(1002, "Invalid realtime envelope");
        reject(error);
      }
    });
    socket.addEventListener("error", () => {
      if (!connected) {
        reject(new Error("WebSocket fallback could not connect"));
      }
    });
    socket.addEventListener("close", () => {
      signal.removeEventListener("abort", stop);
      resolve();
    });
  });
