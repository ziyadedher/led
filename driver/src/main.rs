#![warn(clippy::pedantic)]

use std::{env, sync::Arc};

use human_panic::setup_panic;
use rpi_led_panel::{LedSequence, RGBMatrixConfig};
use tokio::{sync::RwLock, task::JoinSet};

use led_driver::{
    display::drive,
    state::{self, State},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    setup_panic!();
    env_logger::init();

    log::info!("Setting up configuration...");
    let config = RGBMatrixConfig {
        led_sequence: LedSequence::Rgb,
        ..Default::default()
    };

    log::info!("Initializing state...");
    let state = Arc::new(RwLock::new(State::default()));

    log::info!("Spawning tasks...");
    let mut tasks = JoinSet::new();
    tasks.spawn(drive(config, state.clone()));
    tasks.spawn(state::sync(state.clone()));

    log::info!("Waiting for tasks...");
    while let Some(result) = tasks.join_next().await {
        result??;
    }

    Ok(())
}
