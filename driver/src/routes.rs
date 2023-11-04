use std::{
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{extract::State, routing::get, Json, Router};

use crate::display::TextEntry;

#[derive(Clone)]
struct AppState {
    entries: Arc<Mutex<Vec<TextEntry>>>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct HealthResponse {
    time: u64,
    is_healthy: bool,
}

async fn health() -> Json<HealthResponse> {
    log::info!("Responding to health check...");
    Json(HealthResponse {
        time: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        is_healthy: true,
    })
}

#[derive(serde::Deserialize, serde::Serialize)]
struct GetEntriesResponse {
    entries: Vec<TextEntry>,
}

async fn get_entries(State(state): State<Arc<AppState>>) -> Json<GetEntriesResponse> {
    log::info!("Getting all entries...");
    Json(GetEntriesResponse {
        entries: state.entries.lock().unwrap().clone(),
    })
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct AddEntriesRequest {
    entries: Vec<TextEntry>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct AddEntriesResponse {}

async fn add_entries(
    State(state): State<Arc<AppState>>,
    Json(AddEntriesRequest { entries }): Json<AddEntriesRequest>,
) -> Json<AddEntriesResponse> {
    log::info!("Adding {} entries...", entries.len());
    state.entries.lock().unwrap().extend(entries);

    Json(AddEntriesResponse {})
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ClearEntriesResponse {
    num_removed: usize,
}

async fn clear_entries(State(state): State<Arc<AppState>>) -> Json<ClearEntriesResponse> {
    let num_removed = state.entries.lock().unwrap().len();

    log::info!("Clearing {num_removed} entries...");
    state.entries.lock().unwrap().clear();

    Json(ClearEntriesResponse { num_removed })
}

pub fn construct_routes(entries: Arc<Mutex<Vec<TextEntry>>>) -> Router {
    let state = Arc::new(AppState { entries });

    Router::new()
        .route("/health", get(health).post(health))
        .route(
            "/entries",
            get(get_entries)
                .with_state(state.clone())
                .post(add_entries)
                .with_state(state.clone())
                .delete(clear_entries)
                .with_state(state.clone()),
        )
}
