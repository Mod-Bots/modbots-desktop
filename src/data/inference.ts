import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  inferenceManifestKeyId,
  inferenceManifestPublicKey,
} from "./inference-public-key";
import { fetchRequest, platformEndpoints } from "./platform";

export interface InferenceArtifact {
  artifactId: string;
  role: "multimodal_reasoning" | "multimodal_projector";
  filename: string;
  modelId: string;
  revision: string;
  format: string;
  quantization: string;
  sha256: string;
  byteLength: string;
  downloadUrl: string;
}

export interface InferenceManifest {
  contractVersion: 1;
  entityType: "inference_pipeline_manifest";
  manifestVersion: string;
  issuedAt: string;
  artifacts: InferenceArtifact[];
  pipelines: unknown[];
  signature: {
    algorithm: "ed25519";
    keyId: string;
    value: string;
  };
}

export interface ModelArtifactStatus {
  artifactId: string;
  state: "missing" | "partial" | "ready";
  downloadedBytes: number;
  totalBytes: number;
}

export interface ModelDownloadProgress {
  artifactId: string;
  downloadedBytes: number;
  totalBytes: number;
}

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const verifyManifest = async (manifest: InferenceManifest): Promise<void> => {
  if (
    manifest.contractVersion !== 1 ||
    manifest.entityType !== "inference_pipeline_manifest" ||
    manifest.signature.algorithm !== "ed25519" ||
    manifest.signature.keyId !== inferenceManifestKeyId ||
    manifest.artifacts.length === 0
  ) {
    throw new Error("The local AI manifest is not trusted by this client.");
  }

  const { signature, ...unsignedManifest } = manifest;
  const publicKey = await crypto.subtle.importKey(
    "spki",
    decodeBase64(inferenceManifestPublicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    decodeBase64(signature.value),
    new TextEncoder().encode(canonicalize(unsignedManifest)),
  );

  if (!valid) {
    throw new Error("The local AI manifest signature is invalid.");
  }
};

export const getInferenceManifest = async (): Promise<InferenceManifest> => {
  const response = await fetchRequest(
    new URL("/api/inference/manifest", platformEndpoints.api).toString(),
  );

  if (!response.ok) {
    throw new Error("Local AI setup information is not available yet.");
  }

  const manifest = (await response.json()) as InferenceManifest;
  await verifyManifest(manifest);
  return manifest;
};

const requireNativeClient = (): void => {
  if (!isTauri()) {
    throw new Error(
      "Local AI setup for this browser client has not been connected yet.",
    );
  }
};

export const getModelArtifactStatus = (
  manifestVersion: string,
  artifact: InferenceArtifact,
): Promise<ModelArtifactStatus> => {
  requireNativeClient();
  return invoke("model_artifact_status", { manifestVersion, artifact });
};

export const downloadModelArtifact = (
  manifestVersion: string,
  artifact: InferenceArtifact,
): Promise<ModelArtifactStatus> => {
  requireNativeClient();
  return invoke("download_model_artifact", { manifestVersion, artifact });
};

export const pauseModelDownload = (artifactId: string): Promise<void> => {
  requireNativeClient();
  return invoke("pause_model_download", { artifactId });
};

export const onModelDownloadProgress = (
  listener: (progress: ModelDownloadProgress) => void,
): Promise<UnlistenFn> =>
  listen<ModelDownloadProgress>("model-download-progress", (event) => {
    listener(event.payload);
  });
