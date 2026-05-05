use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

const GITHUB_UPDATER_ENDPOINT: &str =
    "https://github.com/RodjerYan/Rylo/releases/latest/download/latest.json";

fn is_missing_manifest_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    (lower.contains("404") || lower.contains("not found"))
        && (lower.contains("latest.json") || lower.contains("release"))
}

#[derive(Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
}

#[derive(Serialize, Clone)]
struct UpdaterStatusPayload {
    stage: &'static str,
    message: String,
    version: Option<String>,
    downloaded: Option<u64>,
    total: Option<u64>,
}

fn emit_status(
    app: &AppHandle,
    stage: &'static str,
    message: impl Into<String>,
    version: Option<&str>,
    downloaded: Option<u64>,
    total: Option<u64>,
) {
    let payload = UpdaterStatusPayload {
        stage,
        message: message.into(),
        version: version.map(str::to_string),
        downloaded,
        total,
    };
    let _ = app.emit("updater-status", payload);
}

#[tauri::command]
pub async fn check_client_update(app: AppHandle) -> Result<UpdateCheckResult, String> {
    emit_status(&app, "checking", "Проверка обновлений...", None, None, None);

    let url: url::Url = GITHUB_UPDATER_ENDPOINT
        .parse()
        .map_err(|e: url::ParseError| format!("bad endpoint URL: {e}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("failed to set endpoints: {e}"))?
        .build()
        .map_err(|e| format!("failed to build updater: {e}"))?;

    let update = updater.check().await.map_err(|e| {
        format!("update check failed: {e}")
    });

    let update = match update {
        Ok(value) => value,
        Err(err_msg) => {
            // GitHub release exists, but updater manifest (latest.json) is absent.
            // This happens on unsigned releases and should not be shown as a hard error.
            if is_missing_manifest_error(&err_msg) {
                emit_status(&app, "up_to_date", "Обновлений нет", None, None, None);
                return Ok(UpdateCheckResult {
                    available: false,
                    version: None,
                    body: None,
                });
            }
            emit_status(
                &app,
                "error",
                "Не удалось проверить обновления",
                None,
                None,
                None,
            );
            return Err(err_msg);
        }
    };

    match update {
        Some(u) => {
            emit_status(
                &app,
                "update_available",
                format!("Найдено обновление {}", u.version),
                Some(&u.version),
                None,
                None,
            );
            Ok(UpdateCheckResult {
                available: true,
                version: Some(u.version.clone()),
                body: Some(u.body.clone().unwrap_or_default()),
            })
        }
        None => {
            emit_status(&app, "up_to_date", "Обновлений нет", None, None, None);
            Ok(UpdateCheckResult {
                available: false,
                version: None,
                body: None,
            })
        }
    }
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    let url: url::Url = GITHUB_UPDATER_ENDPOINT
        .parse()
        .map_err(|e: url::ParseError| format!("bad endpoint URL: {e}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("failed to set endpoints: {e}"))?
        .build()
        .map_err(|e| format!("failed to build updater: {e}"))?;

    let update = updater.check().await.map_err(|e| {
        emit_status(
            &app,
            "error",
            "Не удалось проверить обновления перед установкой",
            None,
            None,
            None,
        );
        format!("update check failed: {e}")
    })?;

    match update {
        Some(u) => {
            emit_status(
                &app,
                "downloading",
                "Загрузка обновления...",
                Some(&u.version),
                Some(0),
                None,
            );

            let version = u.version.clone();
            let progress_app = app.clone();
            let install_app = app.clone();
            let mut downloaded: u64 = 0;
            let install_version = version.clone();

            u.download_and_install(
                move |chunk_len, total| {
                    downloaded = downloaded.saturating_add(chunk_len as u64);
                    emit_status(
                        &progress_app,
                        "downloading",
                        "Загрузка обновления...",
                        Some(&version),
                        Some(downloaded),
                        total,
                    );
                },
                move || {
                    emit_status(
                        &install_app,
                        "installing",
                        "Установка обновления...",
                        Some(&install_version),
                        None,
                        None,
                    );
                },
            )
            .await
            .map_err(|e| {
                emit_status(
                    &app,
                    "error",
                    "Ошибка во время установки обновления",
                    Some(&u.version),
                    None,
                    None,
                );
                format!("download/install failed: {e}")
            })?;

            emit_status(
                &app,
                "restarting",
                "Обновление установлено. Перезапуск...",
                Some(&u.version),
                None,
                None,
            );
            Ok(())
        }
        None => {
            emit_status(&app, "up_to_date", "Обновлений нет", None, None, None);
            Err("no update available".into())
        }
    }
}
