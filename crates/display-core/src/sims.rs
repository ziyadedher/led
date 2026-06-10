//! Caller-held state for the stateful simulation scenes (physarum,
//! reaction-diffusion, fluid, sand, swarm).
//!
//! Unlike Life — whose lattice the driver evolves in driver code and
//! the dash re-implements in TypeScript — these sims keep their state
//! and stepping logic HERE, so the Pi driver and the WASM simulator
//! run literally the same code. The host (driver loop / wasm
//! Renderer) owns one [`SimHost`] and passes it to
//! [`crate::render_with_sims`]; everything else is internal.
//!
//! Pacing is step-based (the scene step unit, a nominal 60/s wall
//! clock): each advance receives the elapsed steps since the last
//! frame, clamped so a stall can't trigger a runaway catch-up.

use crate::frames::{fluid, physarum, rd, sand, swarm};

/// Max scene-steps consumed per frame — bounds sim catch-up after a
/// render stall (StepClock already clamps to ~15; this is a backstop).
const MAX_ELAPSED: usize = 30;

pub enum SimState {
    Physarum(physarum::State),
    Rd(rd::State),
    Fluid(fluid::State),
    Sand(sand::State),
    Swarm(swarm::State),
}

/// One per render loop. Holds whichever sim the active mode needs;
/// switching modes (or changing a structural config param) rebuilds
/// the state transparently.
#[derive(Default)]
pub struct SimHost {
    state: Option<SimState>,
    last_step: usize,
}

macro_rules! sim_accessor {
    ($fn_name:ident, $variant:ident, $module:ident, $cfg:ty) => {
        pub(crate) fn $fn_name(
            &mut self,
            cfg: &$cfg,
            step: usize,
        ) -> &$module::State {
            let needs_init = !matches!(
                &self.state,
                Some(SimState::$variant(s)) if s.compatible(cfg)
            );
            if needs_init {
                #[allow(clippy::cast_possible_truncation)]
                let seed = (step as u32) ^ 0x9e37_79b9;
                self.state = Some(SimState::$variant($module::State::new(cfg, seed)));
                self.last_step = step;
            }
            let elapsed = step.saturating_sub(self.last_step).min(MAX_ELAPSED);
            self.last_step = step;
            match self.state.as_mut().expect("initialized above") {
                SimState::$variant(s) => {
                    s.advance(cfg, elapsed);
                    s
                }
                _ => unreachable!("variant ensured above"),
            }
        }
    };
}

impl SimHost {
    sim_accessor!(physarum, Physarum, physarum, physarum::PhysarumConfig);
    sim_accessor!(rd, Rd, rd, rd::RdConfig);
    sim_accessor!(fluid, Fluid, fluid, fluid::FluidConfig);
    sim_accessor!(sand, Sand, sand, sand::SandConfig);
    sim_accessor!(swarm, Swarm, swarm, swarm::SwarmConfig);
}
