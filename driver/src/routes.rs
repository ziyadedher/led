use std::{
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State as RouterState,
    routing::{any, get, patch},
    Json, Router,
};

use crate::display::{State, TextEntry};

type AppState = RouterState<Arc<Mutex<State>>>;

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
struct GetPauseResponse {
    is_paused: bool,
}

async fn get_pause(RouterState(state): AppState) -> Json<GetPauseResponse> {
    let is_paused = state.lock().unwrap().is_paused;

    log::info!("Getting pause status...");
    Json(GetPauseResponse { is_paused })
}

#[derive(serde::Deserialize, serde::Serialize)]
struct SetPauseRequest {
    should_pause: bool,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct SetPauseResponse {
    is_paused: bool,
}

async fn set_pause(
    RouterState(state): AppState,
    Json(SetPauseRequest { should_pause }): Json<SetPauseRequest>,
) -> Json<SetPauseResponse> {
    let is_paused = state.lock().unwrap().is_paused;

    log::info!("Pausing: {should_pause}...");
    state.lock().unwrap().is_paused = should_pause;

    Json(SetPauseResponse { is_paused })
}

#[derive(serde::Deserialize, serde::Serialize)]
struct GetEntriesResponse {
    entries: Vec<TextEntry>,
}

async fn get_entries(
    RouterState(state): RouterState<Arc<Mutex<State>>>,
) -> Json<GetEntriesResponse> {
    log::info!("Getting all entries...");
    Json(GetEntriesResponse {
        entries: state.lock().unwrap().entries.clone(),
    })
}

#[derive(serde::Deserialize, serde::Serialize)]
struct AddEntriesRequest {
    entries: Vec<TextEntry>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct AddEntriesResponse {}

async fn add_entries(
    RouterState(state): AppState,
    Json(AddEntriesRequest { entries }): Json<AddEntriesRequest>,
) -> Json<AddEntriesResponse> {
    log::info!("Adding {} entries...", entries.len());
    state.lock().unwrap().entries.extend(entries);

    Json(AddEntriesResponse {})
}

#[derive(serde::Deserialize, serde::Serialize)]
enum DeleteEntriesChoice {
    All,
    Single(usize),
}

#[derive(serde::Deserialize, serde::Serialize)]
struct DeleteEntriesRequest {
    choice: DeleteEntriesChoice,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct DeleteEntriesResponse {
    num_removed: usize,
}

async fn delete_entries(
    RouterState(state): AppState,
    Json(DeleteEntriesRequest { choice }): Json<DeleteEntriesRequest>,
) -> Json<DeleteEntriesResponse> {
    let num_removed = match choice {
        DeleteEntriesChoice::All => {
            log::info!("Clearing all entries...");
            let num_removed = state.lock().unwrap().entries.len();
            state.lock().unwrap().entries.clear();
            state.lock().unwrap().scroll = 0;
            num_removed
        }
        DeleteEntriesChoice::Single(index) => {
            log::info!("Removing entry at index {index}...");
            state.lock().unwrap().entries.remove(index);
            1
        }
    };

    Json(DeleteEntriesResponse { num_removed })
}

#[derive(serde::Deserialize, serde::Serialize)]
enum ReorderDirection {
    Up,
    Down,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ReorderEntryRequest {
    entry: usize,
    direction: ReorderDirection,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ReorderEntryResponse {}

async fn reorder_entry(
    RouterState(state): AppState,
    Json(ReorderEntryRequest { entry, direction }): Json<ReorderEntryRequest>,
) -> Json<ReorderEntryResponse> {
    let new_index = match direction {
        ReorderDirection::Up => {
            if entry == 0 {
                return Json(ReorderEntryResponse {});
            }
            entry - 1
        }
        ReorderDirection::Down => {
            if entry == state.lock().unwrap().entries.len() - 1 {
                return Json(ReorderEntryResponse {});
            }
            entry + 1
        }
    };

    log::info!("Reordering entry {entry} to {new_index}...");

    let entry = state.lock().unwrap().entries.remove(entry);
    state.lock().unwrap().entries.insert(new_index, entry);

    Json(ReorderEntryResponse {})
}

#[derive(serde::Deserialize, serde::Serialize)]
struct GetEntriesScrollResponse {
    scroll: i32,
}

async fn get_entries_scroll(RouterState(state): AppState) -> Json<GetEntriesScrollResponse> {
    let scroll = state.lock().unwrap().scroll;

    log::info!("Getting scroll...");
    Json(GetEntriesScrollResponse { scroll })
}

#[derive(serde::Deserialize, serde::Serialize)]
enum ScrollDirection {
    Up,
    Down,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ScrollEntriesRequest {
    direction: ScrollDirection,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ScrollEntriesResponse {
    scroll: i32,
}

async fn scroll_entries(
    RouterState(state): AppState,
    Json(ScrollEntriesRequest { direction }): Json<ScrollEntriesRequest>,
) -> Json<ScrollEntriesResponse> {
    let current_scroll = state.lock().unwrap().scroll;

    let new_scroll = match direction {
        ScrollDirection::Up => current_scroll - 1,
        ScrollDirection::Down => current_scroll + 1,
    };

    log::info!("Scrolling from {current_scroll} to {new_scroll}...");
    state.lock().unwrap().scroll = new_scroll;

    Json(ScrollEntriesResponse { scroll: new_scroll })
}

pub fn construct_routes(state: Arc<Mutex<State>>) -> Router {
    Router::new()
        .route("/health", any(health))
        .route("/pause", get(get_pause).put(set_pause))
        .route(
            "/entries",
            get(get_entries).post(add_entries).delete(delete_entries),
        )
        .route("/entries/order", patch(reorder_entry))
        .route(
            "/entries/scroll",
            get(get_entries_scroll).post(scroll_entries),
        )
        .with_state(state.clone())
}
