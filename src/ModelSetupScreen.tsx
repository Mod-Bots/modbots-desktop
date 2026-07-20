import { useEffect, useMemo, useState } from "react";
import { CircleAlert, Download, HardDrive, LoaderCircle, Pause } from "lucide-react";
import appLogo from "./assets/logo.svg";
import {
  downloadModelArtifact,
  getInferenceManifest,
  getModelArtifactStatus,
  onModelDownloadProgress,
  pauseModelDownload,
  type InferenceManifest,
  type ModelArtifactStatus,
} from "./data/inference";

const formatBytes = (bytes: number): string => {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  }

  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }

  return `${Math.max(0, Math.round(bytes / 1_000))} KB`;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Local AI setup could not continue.";

export function ModelSetupScreen({ onReady }: { onReady: () => void }) {
  const [manifest, setManifest] = useState<InferenceManifest | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ModelArtifactStatus>>({});
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [currentArtifactId, setCurrentArtifactId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSetup = async () => {
    setLoading(true);
    setError(null);

    try {
      const nextManifest = await getInferenceManifest();
      const nextStatuses = await Promise.all(
        nextManifest.artifacts.map((artifact) =>
          getModelArtifactStatus(nextManifest.manifestVersion, artifact),
        ),
      );
      const mapped = Object.fromEntries(
        nextStatuses.map((status) => [status.artifactId, status]),
      );
      setManifest(nextManifest);
      setStatuses(mapped);

      if (nextStatuses.every((status) => status.state === "ready")) {
        onReady();
      }
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSetup();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    void onModelDownloadProgress((progress) => {
      setStatuses((previous) => ({
        ...previous,
        [progress.artifactId]: {
          artifactId: progress.artifactId,
          state:
            progress.downloadedBytes === progress.totalBytes
              ? "ready"
              : "partial",
          downloadedBytes: progress.downloadedBytes,
          totalBytes: progress.totalBytes,
        },
      }));
    }).then((stop) => {
      unlisten = stop;
    });

    return () => unlisten?.();
  }, []);

  const totals = useMemo(() => {
    if (manifest === null) {
      return { downloaded: 0, required: 0 };
    }

    return manifest.artifacts.reduce(
      (total, artifact) => {
        const required = Number(artifact.byteLength);
        const status = statuses[artifact.artifactId];
        total.required += required;
        total.downloaded += status?.downloadedBytes ?? 0;
        return total;
      },
      { downloaded: 0, required: 0 },
    );
  }, [manifest, statuses]);
  const progress =
    totals.required === 0 ? 0 : Math.min(100, (totals.downloaded / totals.required) * 100);

  const startDownload = async () => {
    if (manifest === null || downloading) {
      return;
    }

    setDownloading(true);
    setError(null);

    try {
      for (const artifact of manifest.artifacts) {
        if (statuses[artifact.artifactId]?.state === "ready") {
          continue;
        }

        setCurrentArtifactId(artifact.artifactId);
        const status = await downloadModelArtifact(
          manifest.manifestVersion,
          artifact,
        );
        setStatuses((previous) => ({
          ...previous,
          [status.artifactId]: status,
        }));
      }

      onReady();
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    } finally {
      setCurrentArtifactId(null);
      setDownloading(false);
    }
  };

  const pauseDownload = async () => {
    if (currentArtifactId !== null) {
      await pauseModelDownload(currentArtifactId);
    }
  };

  return (
    <section className="modbots-scroll flex min-h-0 flex-1 overflow-y-auto bg-[#0b0b0b]">
      <div className="mx-auto flex w-full max-w-[620px] flex-col justify-center px-8 py-12">
        <img src={appLogo} alt="" className="h-12 w-12 rounded-lg" />
        <h1 className="mt-5 text-2xl font-semibold text-white">Set up local AI</h1>
        <p className="mt-2 max-w-[58ch] text-sm leading-6 text-zinc-400">
          Mod Bots runs its approved model on your machine. The model is stored
          separately from the app and only downloads after you choose to start.
        </p>

        <div className="mt-7 rounded-2xl border border-white/10 bg-[#141414] p-5">
          {loading ? (
            <div className="flex items-center gap-3 text-sm text-zinc-300">
              <LoaderCircle className="h-5 w-5 animate-spin" />
              Checking your local model files...
            </div>
          ) : manifest === null ? (
            <div>
              <div className="flex items-start gap-3 text-sm text-zinc-300">
                <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" />
                <span>{error ?? "Local AI setup information is unavailable."}</span>
              </div>
              <button
                type="button"
                onClick={() => void loadSetup()}
                className="mt-4 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-zinc-200"
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-300">
                  <HardDrive className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-white">Gemma 4 E4B</p>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">
                    Google instruction model, Q4, including its multimodal projector
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    {formatBytes(totals.required)} required
                  </p>
                </div>
              </div>

              <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/[0.07]">
                <div
                  className="h-full rounded-full bg-white transition-[width]"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-zinc-500">
                <span>{formatBytes(totals.downloaded)} downloaded</span>
                <span>{progress.toFixed(1)}%</span>
              </div>

              <div className="mt-5 space-y-2">
                {manifest.artifacts.map((artifact) => {
                  const status = statuses[artifact.artifactId];
                  return (
                    <div
                      key={artifact.artifactId}
                      className="flex items-center justify-between gap-4 rounded-lg border border-white/[0.06] px-3 py-2 text-xs"
                    >
                      <span className="min-w-0 truncate text-zinc-300">
                        {artifact.role === "multimodal_reasoning"
                          ? "Language model"
                          : "Multimodal projector"}
                      </span>
                      <span className="shrink-0 tabular-nums text-zinc-500">
                        {status?.state === "ready"
                          ? "Verified"
                          : formatBytes(status?.downloadedBytes ?? 0)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {error !== null ? (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}

              {downloading ? (
                <button
                  type="button"
                  onClick={() => void pauseDownload()}
                  className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-white/15 text-sm font-semibold text-white hover:bg-white/[0.05]"
                >
                  <Pause className="h-4 w-4" />
                  Pause download
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void startDownload()}
                  className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-white text-sm font-semibold text-black hover:bg-zinc-200"
                >
                  <Download className="h-4 w-4" />
                  {totals.downloaded > 0 ? "Resume download" : "Download local AI"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
