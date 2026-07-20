use reqwest::blocking::Client;
use reqwest::header::RANGE;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Default)]
pub struct ModelDownloadState {
    cancelled: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArtifact {
    artifact_id: String,
    filename: String,
    sha256: String,
    byte_length: String,
    download_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArtifactStatus {
    artifact_id: String,
    state: String,
    downloaded_bytes: u64,
    total_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDownloadProgress {
    artifact_id: String,
    downloaded_bytes: u64,
    total_bytes: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerificationRecord {
    sha256: String,
    byte_length: u64,
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn artifact_paths(
    app: &AppHandle,
    manifest_version: &str,
    artifact: &ModelArtifact,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    if !safe_segment(manifest_version)
        || !safe_segment(&artifact.artifact_id)
        || !safe_segment(&artifact.filename)
    {
        return Err("The model manifest contains an unsafe identifier.".to_string());
    }

    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("The local model directory is unavailable: {error}"))?
        .join("models")
        .join(manifest_version);
    let target = root.join(&artifact.filename);
    let partial = root.join(format!("{}.part", artifact.filename));
    let verified = root.join(format!("{}.verified.json", artifact.filename));
    Ok((target, partial, verified))
}

fn expected_size(artifact: &ModelArtifact) -> Result<u64, String> {
    artifact
        .byte_length
        .parse::<u64>()
        .map_err(|_| "The model manifest contains an invalid artifact size.".to_string())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("The downloaded model could not be opened: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];

    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("The downloaded model could not be verified: {error}"))?;

        if count == 0 {
            break;
        }

        hasher.update(&buffer[..count]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn verified_record_matches(path: &Path, artifact: &ModelArtifact, size: u64) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(record) = serde_json::from_str::<VerificationRecord>(&content) else {
        return false;
    };

    record.byte_length == size && record.sha256 == artifact.sha256
}

fn inspect_artifact(
    app: &AppHandle,
    manifest_version: &str,
    artifact: &ModelArtifact,
) -> Result<ModelArtifactStatus, String> {
    let total_bytes = expected_size(artifact)?;
    let (target, partial, verified) = artifact_paths(app, manifest_version, artifact)?;

    if let Ok(metadata) = fs::metadata(&target) {
        if metadata.len() == total_bytes
            && (verified_record_matches(&verified, artifact, total_bytes)
                || hash_file(&target)? == artifact.sha256)
        {
            if !verified_record_matches(&verified, artifact, total_bytes) {
                let record = VerificationRecord {
                    sha256: artifact.sha256.clone(),
                    byte_length: total_bytes,
                };
                fs::write(
                    &verified,
                    serde_json::to_vec_pretty(&record)
                        .map_err(|error| format!("Verification record failed: {error}"))?,
                )
                .map_err(|error| format!("Verification record could not be saved: {error}"))?;
            }

            return Ok(ModelArtifactStatus {
                artifact_id: artifact.artifact_id.clone(),
                state: "ready".to_string(),
                downloaded_bytes: total_bytes,
                total_bytes,
            });
        }
    }

    let partial_bytes = fs::metadata(partial)
        .map(|metadata| metadata.len().min(total_bytes))
        .unwrap_or(0);

    Ok(ModelArtifactStatus {
        artifact_id: artifact.artifact_id.clone(),
        state: if partial_bytes > 0 {
            "partial"
        } else {
            "missing"
        }
        .to_string(),
        downloaded_bytes: partial_bytes,
        total_bytes,
    })
}

#[tauri::command]
pub async fn model_artifact_status(
    app: AppHandle,
    manifest_version: String,
    artifact: ModelArtifact,
) -> Result<ModelArtifactStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_artifact(&app, &manifest_version, &artifact)
    })
    .await
    .map_err(|error| format!("The model status check failed: {error}"))?
}

#[tauri::command]
pub fn pause_model_download(
    artifact_id: String,
    state: tauri::State<'_, ModelDownloadState>,
) -> Result<(), String> {
    state
        .cancelled
        .lock()
        .map_err(|_| "The model download state is unavailable.".to_string())?
        .insert(artifact_id);
    Ok(())
}

fn download_artifact(
    app: &AppHandle,
    state: &ModelDownloadState,
    manifest_version: &str,
    artifact: &ModelArtifact,
) -> Result<ModelArtifactStatus, String> {
    if !artifact.download_url.starts_with("https://") {
        return Err("Model artifacts must use a secure download URL.".to_string());
    }

    let total_bytes = expected_size(artifact)?;
    let (target, partial, verified) = artifact_paths(app, manifest_version, artifact)?;
    let root = target
        .parent()
        .ok_or_else(|| "The local model directory is unavailable.".to_string())?;
    fs::create_dir_all(root)
        .map_err(|error| format!("The local model directory could not be created: {error}"))?;

    if inspect_artifact(app, manifest_version, artifact)?.state == "ready" {
        return inspect_artifact(app, manifest_version, artifact);
    }

    state
        .cancelled
        .lock()
        .map_err(|_| "The model download state is unavailable.".to_string())?
        .remove(&artifact.artifact_id);

    let mut downloaded_bytes = fs::metadata(&partial)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    if downloaded_bytes > total_bytes {
        fs::remove_file(&partial).map_err(|error| {
            format!("The invalid partial download could not be removed: {error}")
        })?;
        downloaded_bytes = 0;
    }

    if downloaded_bytes == total_bytes {
        if hash_file(&partial)? == artifact.sha256 {
            if target.exists() {
                fs::remove_file(&target).map_err(|error| {
                    format!("The previous model artifact could not be replaced: {error}")
                })?;
            }
            fs::rename(&partial, &target)
                .map_err(|error| format!("The verified model could not be installed: {error}"))?;
            let record = VerificationRecord {
                sha256: artifact.sha256.clone(),
                byte_length: total_bytes,
            };
            fs::write(
                verified,
                serde_json::to_vec_pretty(&record)
                    .map_err(|error| format!("Verification record failed: {error}"))?,
            )
            .map_err(|error| format!("Verification record could not be saved: {error}"))?;

            return Ok(ModelArtifactStatus {
                artifact_id: artifact.artifact_id.clone(),
                state: "ready".to_string(),
                downloaded_bytes,
                total_bytes,
            });
        }

        fs::remove_file(&partial).map_err(|error| {
            format!("The invalid partial download could not be removed: {error}")
        })?;
        downloaded_bytes = 0;
    }

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("The model downloader could not start: {error}"))?;
    let mut request = client.get(&artifact.download_url);

    if downloaded_bytes > 0 {
        request = request.header(RANGE, format!("bytes={downloaded_bytes}-"));
    }

    let mut response = request
        .send()
        .map_err(|error| format!("The model download could not start: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "The model source returned HTTP {}.",
            response.status().as_u16()
        ));
    }

    let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut hasher = Sha256::new();

    if downloaded_bytes > 0 && resumed {
        let mut existing = File::open(&partial)
            .map_err(|error| format!("The partial model download could not be opened: {error}"))?;
        let mut buffer = vec![0_u8; 1024 * 1024];

        loop {
            let count = existing.read(&mut buffer).map_err(|error| {
                format!("The partial model download could not be read: {error}")
            })?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
    } else if downloaded_bytes > 0 {
        downloaded_bytes = 0;
    }

    let mut output = OpenOptions::new()
        .create(true)
        .write(true)
        .append(downloaded_bytes > 0)
        .truncate(downloaded_bytes == 0)
        .open(&partial)
        .map_err(|error| format!("The model download could not be saved: {error}"))?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut last_progress = Instant::now();

    loop {
        if state
            .cancelled
            .lock()
            .map_err(|_| "The model download state is unavailable.".to_string())?
            .remove(&artifact.artifact_id)
        {
            output.flush().map_err(|error| {
                format!("The partial model download could not be saved: {error}")
            })?;
            return Err("The model download was paused.".to_string());
        }

        let count = response
            .read(&mut buffer)
            .map_err(|error| format!("The model download was interrupted: {error}"))?;

        if count == 0 {
            break;
        }

        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("The model download could not be saved: {error}"))?;
        hasher.update(&buffer[..count]);
        downloaded_bytes += count as u64;

        if downloaded_bytes > total_bytes {
            return Err("The model download exceeded its signed size.".to_string());
        }

        if last_progress.elapsed() >= Duration::from_millis(250) {
            let _ = app.emit(
                "model-download-progress",
                ModelDownloadProgress {
                    artifact_id: artifact.artifact_id.clone(),
                    downloaded_bytes,
                    total_bytes,
                },
            );
            last_progress = Instant::now();
        }
    }

    output
        .flush()
        .map_err(|error| format!("The model download could not be saved: {error}"))?;
    drop(output);

    if downloaded_bytes != total_bytes {
        return Err(format!(
            "The model download is incomplete: received {downloaded_bytes} of {total_bytes} bytes."
        ));
    }

    let actual_sha256 = format!("{:x}", hasher.finalize());

    if actual_sha256 != artifact.sha256 {
        let _ = fs::remove_file(&partial);
        return Err("The downloaded model failed verification and was removed.".to_string());
    }

    if target.exists() {
        fs::remove_file(&target).map_err(|error| {
            format!("The previous model artifact could not be replaced: {error}")
        })?;
    }
    fs::rename(&partial, &target)
        .map_err(|error| format!("The verified model could not be installed: {error}"))?;
    let record = VerificationRecord {
        sha256: artifact.sha256.clone(),
        byte_length: total_bytes,
    };
    fs::write(
        verified,
        serde_json::to_vec_pretty(&record)
            .map_err(|error| format!("Verification record failed: {error}"))?,
    )
    .map_err(|error| format!("Verification record could not be saved: {error}"))?;

    let progress = ModelDownloadProgress {
        artifact_id: artifact.artifact_id.clone(),
        downloaded_bytes,
        total_bytes,
    };
    let _ = app.emit("model-download-progress", progress);

    Ok(ModelArtifactStatus {
        artifact_id: artifact.artifact_id.clone(),
        state: "ready".to_string(),
        downloaded_bytes,
        total_bytes,
    })
}

#[tauri::command]
pub async fn download_model_artifact(
    app: AppHandle,
    state: tauri::State<'_, ModelDownloadState>,
    manifest_version: String,
    artifact: ModelArtifact,
) -> Result<ModelArtifactStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        download_artifact(&app, &state, &manifest_version, &artifact)
    })
    .await
    .map_err(|error| format!("The model download task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::safe_segment;

    #[test]
    fn accepts_manifest_identifiers_and_rejects_paths() {
        assert!(safe_segment("gemma-4-E4B_q4_0-it.gguf"));
        assert!(safe_segment("2026.07.20.2"));
        assert!(!safe_segment("../model.gguf"));
        assert!(!safe_segment("folder/model.gguf"));
        assert!(!safe_segment("folder\\model.gguf"));
    }
}
