use std::{
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State as RouterState,
    routing::{any, get, patch},
    Json, Router,
};

use crate::display::{State, TextEntry};

type AppState = RouterState<Arc<RwLock<State>>>;

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
    let is_paused = state.read().unwrap().is_paused;

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
    let is_paused = state.read().unwrap().is_paused;

    log::info!("Pausing: {should_pause}...");
    state.write().unwrap().is_paused = should_pause;

    Json(SetPauseResponse { is_paused })
}

#[derive(serde::Deserialize, serde::Serialize)]
struct GetEntriesResponse {
    entries: Vec<TextEntry>,
}

async fn get_entries(
    RouterState(state): RouterState<Arc<RwLock<State>>>,
) -> Json<GetEntriesResponse> {
    log::info!("Getting all entries...");
    Json(GetEntriesResponse {
        entries: state.read().unwrap().entries.clone(),
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
    state.write().unwrap().entries.extend(entries);

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
            let num_removed = state.read().unwrap().entries.len();
            state.write().unwrap().entries.clear();
            state.write().unwrap().scroll = 0;
            num_removed
        }
        DeleteEntriesChoice::Single(index) => {
            log::info!("Removing entry at index {index}...");
            state.write().unwrap().entries.remove(index);
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
            if entry == state.read().unwrap().entries.len() - 1 {
                return Json(ReorderEntryResponse {});
            }
            entry + 1
        }
    };

    log::info!("Reordering entry {entry} to {new_index}...");

    let entry = state.write().unwrap().entries.remove(entry);
    state.write().unwrap().entries.insert(new_index, entry);

    Json(ReorderEntryResponse {})
}

#[derive(serde::Deserialize, serde::Serialize)]
struct GetEntriesScrollResponse {
    scroll: i32,
}

async fn get_entries_scroll(RouterState(state): AppState) -> Json<GetEntriesScrollResponse> {
    let scroll = state.read().unwrap().scroll;

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
    let current_scroll = state.read().unwrap().scroll;

    let new_scroll = match direction {
        ScrollDirection::Up => current_scroll - 1,
        ScrollDirection::Down => current_scroll + 1,
    };

    log::info!("Scrolling from {current_scroll} to {new_scroll}...");
    state.write().unwrap().scroll = new_scroll;

    Json(ScrollEntriesResponse { scroll: new_scroll })
}

#[derive(serde::Deserialize, serde::Serialize)]
struct GetFlashResponse {
    is_flashing: bool,
}

async fn get_flash(RouterState(state): AppState) -> Json<GetFlashResponse> {
    log::info!("Getting flash status...");
    let is_flashing = state.read().unwrap().flash.is_active;
    Json(GetFlashResponse { is_flashing })
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ActivateFlashRequest {
    on_steps: usize,
    total_steps: usize,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ActivateFlashResponse {}

async fn activate_flash(
    RouterState(state): AppState,
    Json(ActivateFlashRequest {
        on_steps,
        total_steps,
    }): Json<ActivateFlashRequest>,
) -> Json<ActivateFlashResponse> {
    log::info!("Activating flash...");

    {
        let flash = &mut state.write().unwrap().flash;
        flash.on_steps = on_steps;
        flash.total_steps = total_steps;
        flash.is_active = true;
    }

    tokio::task::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        state.write().unwrap().flash.is_active = false;
    });

    Json(ActivateFlashResponse {})
}

pub fn construct_routes(state: Arc<RwLock<State>>) -> Router {
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
        .route("/flash", get(get_flash).post(activate_flash))
        .with_state(state.clone())
}
