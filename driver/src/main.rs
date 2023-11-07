#![warn(clippy::pedantic)]
#![warn(clippy::cargo)]

use std::sync::{Arc, Mutex};

use axum::{Router, Server};
use display::TextEntry;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

mod display;
mod routes;

use crate::{display::drive_display, routes::construct_routes};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let entries = Arc::new(Mutex::new(Vec::<TextEntry>::new()));

    let service = Server::try_bind(&"0.0.0.0:3001".parse()?)?.serve(
        Router::new()
            .merge(construct_routes(entries.clone()))
            .layer(TraceLayer::new_for_http())
            .layer(
                CorsLayer::new()
                    .allow_origin("*")
                    .allow_methods("*")
                    .allow_headers("*"),
            )
            .into_make_service(),
    );

    let driver_task = tokio::spawn(drive_display(entries.clone()));
    let server_task = tokio::spawn(service);

    let (driver_res, server_res) = tokio::join!(driver_task, server_task);
    driver_res??;
    server_res??;

    Ok(())
}
