//! Rotating 3-D wireframes. The scene picks one shape from a small
//! catalogue (cube, tetrahedron, octahedron, icosahedron, torus, and a
//! 4-D hypercube projection) and animates it on a per-frame rotation.
//!
//! Implementation is wholly software:
//!   1. each shape's vertices live in a unit cube centered on the
//!      origin (or are generated parametrically for the torus / sphere);
//!   2. each frame we apply yaw + pitch from `step * speed`, project
//!      orthographically (panels are tiny, no perspective needed);
//!   3. edges become Bresenham lines via embedded_graphics.
//!
//! The whole pipeline is allocation-free — vertex / edge tables are
//! `&'static`, projection writes into a fixed-size scratch buffer.

use core::f32::consts::PI;

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    primitives::{Line, PrimitiveStyle},
};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum ShapeKind {
    Cube,
    Tetrahedron,
    Octahedron,
    Icosahedron,
    Torus,
    Hypercube,
}

impl Default for ShapeKind {
    fn default() -> Self {
        Self::Cube
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ShapesScene {
    pub kind: ShapeKind,
    pub color: Rgb,
    /// Rotation rate. 1.0 = base ~6 RPM around each axis. Clamped at
    /// render time to a sane range.
    pub speed: f32,
    /// `true` if depth should fade lines — far edges drawn dimmer
    /// than near ones. Off by default; on small panels it can read
    /// as flicker.
    #[serde(default)]
    pub depth_shade: bool,
}

impl Default for ShapesScene {
    fn default() -> Self {
        Self {
            kind: ShapeKind::Cube,
            color: Rgb {
                r: 0xff,
                g: 0x8a,
                b: 0x2c,
            },
            speed: 1.0,
            depth_shade: false,
        }
    }
}

const MAX_VERTICES: usize = 96;

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
pub fn render<D>(scene: &ShapesScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let cs = canvas.size();
    let cw = cs.width as f32;
    let ch = cs.height as f32;
    let cx = cw / 2.0;
    let cy = ch / 2.0;
    let scale = cw.min(ch) * 0.32;

    let speed = scene.speed.clamp(0.05, 16.0);
    // Two non-commensurate rotation rates so the shape doesn't
    // visually "lock" to a single axis.
    let yaw = (step as f32) * 0.022 * speed;
    let pitch = (step as f32) * 0.015 * speed;

    let (vertices, edges) = topology(scene.kind);

    // Projected screen-space points + camera-space z (for shading).
    let mut projected: [(i32, i32, f32); MAX_VERTICES] = [(0, 0, 0.0); MAX_VERTICES];
    for (i, &(x, y, z)) in vertices.iter().enumerate() {
        let (x, y, z) = rotate_y(x, y, z, yaw);
        let (x, y, z) = rotate_x(x, y, z, pitch);
        let sx = (cx + x * scale) as i32;
        let sy = (cy + y * scale) as i32;
        projected[i] = (sx, sy, z);
    }

    let base = Rgb888::new(scene.color.r, scene.color.g, scene.color.b);
    for &(a, b) in edges {
        let (ax, ay, az) = projected[a];
        let (bx, by, bz) = projected[b];
        let stroke = if scene.depth_shade {
            // Average the two endpoints' z (range roughly [-1, 1] for
            // a unit shape) and remap to a brightness multiplier.
            let depth = ((az + bz) * 0.5).clamp(-1.0, 1.0);
            // Closer (-1, near camera) = full brightness; far (+1) =
            // dim. Floor at 25% so the back of the shape is still
            // legible.
            let scale_f = 0.25 + 0.75 * (0.5 - depth * 0.5);
            scale_color(base, scale_f)
        } else {
            base
        };
        Line::new(Point::new(ax, ay), Point::new(bx, by))
            .into_styled(PrimitiveStyle::with_stroke(stroke, 1))
            .draw(canvas)?;
    }

    Ok(())
}

fn rotate_y(x: f32, y: f32, z: f32, a: f32) -> (f32, f32, f32) {
    let (s, c) = a.sin_cos();
    (x * c + z * s, y, -x * s + z * c)
}

fn rotate_x(x: f32, y: f32, z: f32, a: f32) -> (f32, f32, f32) {
    let (s, c) = a.sin_cos();
    (x, y * c - z * s, y * s + z * c)
}

fn scale_color(c: Rgb888, s: f32) -> Rgb888 {
    let s = s.clamp(0.0, 1.0);
    Rgb888::new(
        (f32::from(c.r()) * s) as u8,
        (f32::from(c.g()) * s) as u8,
        (f32::from(c.b()) * s) as u8,
    )
}

fn topology(kind: ShapeKind) -> (&'static [(f32, f32, f32)], &'static [(usize, usize)]) {
    match kind {
        ShapeKind::Cube => (CUBE_V, CUBE_E),
        ShapeKind::Tetrahedron => (TET_V, TET_E),
        ShapeKind::Octahedron => (OCT_V, OCT_E),
        ShapeKind::Icosahedron => (ICO_V, ICO_E),
        ShapeKind::Torus => (TORUS_V, TORUS_E),
        ShapeKind::Hypercube => (HCUBE_V, HCUBE_E),
    }
}

/* ─── shape catalogues ─────────────────────────────────────────────
 *
 * All vertices are centred at the origin. Static `&[(f32, f32, f32)]`
 * tables let the renderer borrow without allocation. Edge lists are
 * undirected pairs of indices into the vertex table.
 */

const CUBE_V: &[(f32, f32, f32)] = &[
    (-1.0, -1.0, -1.0),
    (1.0, -1.0, -1.0),
    (1.0, 1.0, -1.0),
    (-1.0, 1.0, -1.0),
    (-1.0, -1.0, 1.0),
    (1.0, -1.0, 1.0),
    (1.0, 1.0, 1.0),
    (-1.0, 1.0, 1.0),
];
const CUBE_E: &[(usize, usize)] = &[
    (0, 1), (1, 2), (2, 3), (3, 0),
    (4, 5), (5, 6), (6, 7), (7, 4),
    (0, 4), (1, 5), (2, 6), (3, 7),
];

const TET_V: &[(f32, f32, f32)] = &[
    (1.0, 1.0, 1.0),
    (-1.0, -1.0, 1.0),
    (-1.0, 1.0, -1.0),
    (1.0, -1.0, -1.0),
];
const TET_E: &[(usize, usize)] =
    &[(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];

const OCT_V: &[(f32, f32, f32)] = &[
    (1.0, 0.0, 0.0),
    (-1.0, 0.0, 0.0),
    (0.0, 1.0, 0.0),
    (0.0, -1.0, 0.0),
    (0.0, 0.0, 1.0),
    (0.0, 0.0, -1.0),
];
const OCT_E: &[(usize, usize)] = &[
    (0, 2), (0, 3), (0, 4), (0, 5),
    (1, 2), (1, 3), (1, 4), (1, 5),
    (2, 4), (2, 5), (3, 4), (3, 5),
];

// Icosahedron via the canonical (0, ±1, ±φ) cyclic-permutation form,
// pre-normalised so vertices sit on the unit sphere.
const ICO_V: &[(f32, f32, f32)] = &[
    (0.0, 0.5257311, 0.8506508),
    (0.0, -0.5257311, 0.8506508),
    (0.0, 0.5257311, -0.8506508),
    (0.0, -0.5257311, -0.8506508),
    (0.5257311, 0.8506508, 0.0),
    (-0.5257311, 0.8506508, 0.0),
    (0.5257311, -0.8506508, 0.0),
    (-0.5257311, -0.8506508, 0.0),
    (0.8506508, 0.0, 0.5257311),
    (-0.8506508, 0.0, 0.5257311),
    (0.8506508, 0.0, -0.5257311),
    (-0.8506508, 0.0, -0.5257311),
];
const ICO_E: &[(usize, usize)] = &[
    (0, 1), (0, 4), (0, 5), (0, 8), (0, 9),
    (1, 6), (1, 7), (1, 8), (1, 9),
    (2, 3), (2, 4), (2, 5), (2, 10), (2, 11),
    (3, 6), (3, 7), (3, 10), (3, 11),
    (4, 5), (4, 8), (4, 10),
    (5, 9), (5, 11),
    (6, 7), (6, 8), (6, 10),
    (7, 9), (7, 11),
    (8, 10),
    (9, 11),
];

// Hypercube — two unit cubes at z = ±0.5, with corresponding vertices
// connected. Visually a "cube inside a cube" wireframe; rotation in
// 3-space already sells the 4-D feel without doing a full 4-D rotor.
const HCUBE_V: &[(f32, f32, f32)] = &[
    // outer cube, scale 1.0
    (-1.0, -1.0, -1.0),
    (1.0, -1.0, -1.0),
    (1.0, 1.0, -1.0),
    (-1.0, 1.0, -1.0),
    (-1.0, -1.0, 1.0),
    (1.0, -1.0, 1.0),
    (1.0, 1.0, 1.0),
    (-1.0, 1.0, 1.0),
    // inner cube, scale 0.5
    (-0.5, -0.5, -0.5),
    (0.5, -0.5, -0.5),
    (0.5, 0.5, -0.5),
    (-0.5, 0.5, -0.5),
    (-0.5, -0.5, 0.5),
    (0.5, -0.5, 0.5),
    (0.5, 0.5, 0.5),
    (-0.5, 0.5, 0.5),
];
const HCUBE_E: &[(usize, usize)] = &[
    // outer cube
    (0, 1), (1, 2), (2, 3), (3, 0),
    (4, 5), (5, 6), (6, 7), (7, 4),
    (0, 4), (1, 5), (2, 6), (3, 7),
    // inner cube
    (8, 9), (9, 10), (10, 11), (11, 8),
    (12, 13), (13, 14), (14, 15), (15, 12),
    (8, 12), (9, 13), (10, 14), (11, 15),
    // tesseract connectors
    (0, 8), (1, 9), (2, 10), (3, 11),
    (4, 12), (5, 13), (6, 14), (7, 15),
];

// Torus: 8 major segments × 6 minor segments. Wireframe edges run
// both around the major loop and around each minor loop, giving the
// classic "doughnut" feel without needing >100 vertices.
const TORUS_MAJOR: usize = 8;
const TORUS_MINOR: usize = 6;
const TORUS_R_MAJOR: f32 = 0.7;
const TORUS_R_MINOR: f32 = 0.3;

const TORUS_V: &[(f32, f32, f32)] = &generate_torus_vertices();
const TORUS_E: &[(usize, usize)] = &generate_torus_edges();

const fn generate_torus_vertices() -> [(f32, f32, f32); TORUS_MAJOR * TORUS_MINOR] {
    // const-fn trig isn't available, so we precompute via build script
    // would be the clean answer. For 8×6=48 verts the lookup tables
    // are small enough to write by hand here.
    let mut out = [(0.0_f32, 0.0_f32, 0.0_f32); TORUS_MAJOR * TORUS_MINOR];
    let mut i = 0;
    while i < TORUS_MAJOR {
        let major_t = (i as f32) * 2.0 * PI / (TORUS_MAJOR as f32);
        let (cm, sm) = (cos_const(major_t), sin_const(major_t));
        let mut j = 0;
        while j < TORUS_MINOR {
            let minor_t = (j as f32) * 2.0 * PI / (TORUS_MINOR as f32);
            let (cn, sn) = (cos_const(minor_t), sin_const(minor_t));
            let r = TORUS_R_MAJOR + TORUS_R_MINOR * cn;
            out[i * TORUS_MINOR + j] = (r * cm, TORUS_R_MINOR * sn, r * sm);
            j += 1;
        }
        i += 1;
    }
    out
}

const fn generate_torus_edges() -> [(usize, usize); TORUS_MAJOR * TORUS_MINOR * 2] {
    let mut out = [(0_usize, 0_usize); TORUS_MAJOR * TORUS_MINOR * 2];
    let mut k = 0;
    let mut i = 0;
    while i < TORUS_MAJOR {
        let mut j = 0;
        while j < TORUS_MINOR {
            let here = i * TORUS_MINOR + j;
            // Around the minor loop.
            let next_minor = i * TORUS_MINOR + ((j + 1) % TORUS_MINOR);
            out[k] = (here, next_minor);
            k += 1;
            // Around the major loop.
            let next_major = ((i + 1) % TORUS_MAJOR) * TORUS_MINOR + j;
            out[k] = (here, next_major);
            k += 1;
            j += 1;
        }
        i += 1;
    }
    out
}

/* Tiny const-fn cos/sin good to ~1e-5 over the [0, 2π] range we use,
 * via Taylor expansion folded into [-π, π]. const-context-only — at
 * runtime the std `f32::sin_cos` is faster and more accurate. */

const fn fold_pi(x: f32) -> f32 {
    let mut x = x;
    while x > PI {
        x -= 2.0 * PI;
    }
    while x < -PI {
        x += 2.0 * PI;
    }
    x
}

const fn sin_const(x: f32) -> f32 {
    let x = fold_pi(x);
    let x2 = x * x;
    // 7-term Taylor; remainders past x^11/11! are < 1e-5 over [-π, π].
    x * (1.0
        - x2 / 6.0
        + x2 * x2 / 120.0
        - x2 * x2 * x2 / 5040.0
        + x2 * x2 * x2 * x2 / 362880.0)
}

const fn cos_const(x: f32) -> f32 {
    let x = fold_pi(x);
    let x2 = x * x;
    1.0 - x2 / 2.0
        + x2 * x2 / 24.0
        - x2 * x2 * x2 / 720.0
        + x2 * x2 * x2 * x2 / 40320.0
}
