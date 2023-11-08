#![warn(clippy::pedantic)]
#![warn(clippy::cargo)]

use std::sync::{Arc, Mutex};

use axum::{Router, Server};
use display::State;
use tower_http::{
    cors::{self, CorsLayer},
    trace::TraceLayer,
};
use tracing_subscriber::prelude::*;

mod display;
mod routes;

use crate::{display::drive_display, routes::construct_routes};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let state = Arc::new(Mutex::new(State::default()));

    let service = Server::try_bind(&"0.0.0.0:3001".parse()?)?.serve(
        Router::new()
            .merge(construct_routes(state.clone()))
            .layer(TraceLayer::new_for_http())
            .layer(
                CorsLayer::new()
                    .allow_origin(cors::Any)
                    .allow_methods(cors::Any)
                    .allow_headers(cors::Any),
            )
            .into_make_service(),
    );

    let driver_task = tokio::spawn(drive_display(state.clone()));
    let server_task = tokio::spawn(service);

    let (driver_res, server_res) = tokio::join!(driver_task, server_task);
    driver_res??;
    server_res??;

    Ok(())
}
