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
    primitives::{Line, PrimitiveStyle, PrimitiveStyleBuilder, Triangle},
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
    /// as flicker. Independent of `opacity` — edges are the
    /// silhouette we always draw at full brightness, with this flag
    /// modulating just their depth tint.
    #[serde(default)]
    pub depth_shade: bool,
    /// Face fill opacity in [0, 1]. 0 = wireframe (no fill), 1 =
    /// fully opaque flat-shaded faces. Treated as additive intensity
    /// against the panel's natural black: a half-opaque face is half
    /// as bright as fully opaque, giving the LED matrix a "ghost"
    /// shape look. Edges are always drawn at full base color on top
    /// — the silhouette stays crisp regardless of opacity.
    #[serde(default = "default_opacity")]
    pub opacity: f32,
}

fn default_opacity() -> f32 {
    0.0
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
            opacity: 0.0,
        }
    }
}

const MAX_VERTICES: usize = 96;
// Largest face table is the torus at 8×6×2 = 96 triangles. Round up
// to leave headroom for future shapes without bumping the const.
const MAX_FACES: usize = 128;

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

    let vertices = vertices_of(scene.kind);

    // Rotate every vertex into camera space + project to screen.
    // `cam` keeps the post-rotation 3-D position for face-normal
    // math; `screen` is the 2-D projection consumed by the
    // primitives.
    let mut cam: [(f32, f32, f32); MAX_VERTICES] = [(0.0, 0.0, 0.0); MAX_VERTICES];
    let mut screen: [(i32, i32); MAX_VERTICES] = [(0, 0); MAX_VERTICES];
    for (i, &(x, y, z)) in vertices.iter().enumerate() {
        let (x, y, z) = rotate_y(x, y, z, yaw);
        let (x, y, z) = rotate_x(x, y, z, pitch);
        cam[i] = (x, y, z);
        screen[i] = ((cx + x * scale) as i32, (cy + y * scale) as i32);
    }

    let base = Rgb888::new(scene.color.r, scene.color.g, scene.color.b);

    // Faces first (when opacity > 0), then edges on top.
    let opacity = scene.opacity.clamp(0.0, 1.0);
    if opacity > 0.001 {
        render_faces(scene, &cam, &screen, base, opacity, canvas)?;
    }
    render_edges(scene, &cam, &screen, base, canvas)?;

    Ok(())
}

fn render_edges<D>(
    scene: &ShapesScene,
    cam: &[(f32, f32, f32); MAX_VERTICES],
    screen: &[(i32, i32); MAX_VERTICES],
    base: Rgb888,
    canvas: &mut D,
) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    for &(a, b) in edges_of(scene.kind) {
        let (ax, ay) = screen[a];
        let (bx, by) = screen[b];
        let stroke = if scene.depth_shade {
            let depth = ((cam[a].2 + cam[b].2) * 0.5).clamp(-1.0, 1.0);
            // Closer (more negative z, near camera) = full brightness;
            // far (positive z) = dim. Floor at 25% so the back is
            // still legible.
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

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
fn render_faces<D>(
    scene: &ShapesScene,
    cam: &[(f32, f32, f32); MAX_VERTICES],
    screen: &[(i32, i32); MAX_VERTICES],
    base: Rgb888,
    opacity: f32,
    canvas: &mut D,
) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let faces = faces_of(scene.kind);
    if faces.is_empty() {
        return Ok(());
    }

    // Back-face cull + collect visible-face indices into a scratch
    // buffer. For the convex shapes in our catalogue this leaves
    // only triangles whose normals point toward the camera, which
    // means they don't overlap in screen space — the painter sort
    // can't ping-pong adjacent faces anymore. (The earlier
    // centroid-z sort would occasionally swap two front-facing
    // adjacent triangles whose centroids were almost coplanar,
    // producing the "behind face flashes in front" artifact at
    // certain rotations. Culling sidesteps the failure mode.)
    let mut visible: [(f32, usize); MAX_FACES] = [(0.0, 0); MAX_FACES];
    let mut visible_count = 0;
    for (i, &[a, b, c]) in faces.iter().enumerate() {
        let normal_z = face_normal_z(cam[a], cam[b], cam[c]);
        // normal_z < 0 means the face normal points toward the
        // camera (camera at -z direction). Skip the rest.
        if normal_z >= 0.0 {
            continue;
        }
        visible[visible_count] = (
            (cam[a].2 + cam[b].2 + cam[c].2) / 3.0,
            i,
        );
        visible_count += 1;
    }
    if visible_count == 0 {
        return Ok(());
    }

    // Sort visible tris back-to-front. Bigger z = farther.
    let visible = &mut visible[..visible_count];
    for i in 1..visible_count {
        let key = visible[i];
        let mut j = i;
        while j > 0 && visible[j - 1].0 < key.0 {
            visible[j] = visible[j - 1];
            j -= 1;
        }
        visible[j] = key;
    }

    // For each visible (front-facing) face: shade by normal angle,
    // scale by opacity (additive against black background), and
    // fill. No stroke — edges get layered separately at full
    // brightness.
    for &(_, idx) in visible.iter() {
        let [a, b, c] = faces[idx];
        let normal_z = face_normal_z(cam[a], cam[b], cam[c]);
        // After culling, normal_z is always < 0. Map to brightness
        // via -normal_z (range (0, 1]). Floor at 25% so glancing
        // angles still look like real fills, not blank gaps.
        let lit = (0.25 + 0.75 * (-normal_z)).clamp(0.0, 1.0);
        let fill = scale_color(base, lit * opacity);
        let style = PrimitiveStyleBuilder::new()
            .fill_color(fill)
            .stroke_color(fill)
            .stroke_width(1)
            .build();
        Triangle::new(
            Point::new(screen[a].0, screen[a].1),
            Point::new(screen[b].0, screen[b].1),
            Point::new(screen[c].0, screen[c].1),
        )
        .into_styled(style)
        .draw(canvas)?;
    }
    Ok(())
}

fn face_normal_z(
    a: (f32, f32, f32),
    b: (f32, f32, f32),
    c: (f32, f32, f32),
) -> f32 {
    let ab = (b.0 - a.0, b.1 - a.1, b.2 - a.2);
    let ac = (c.0 - a.0, c.1 - a.1, c.2 - a.2);
    // Cross product, z-component only — that's all flat shading
    // against the camera (looking down -z) needs.
    let nz = ab.0 * ac.1 - ab.1 * ac.0;
    let len = (ab.0 * ab.0 + ab.1 * ab.1 + ab.2 * ab.2).sqrt()
        * (ac.0 * ac.0 + ac.1 * ac.1 + ac.2 * ac.2).sqrt();
    if len < 1e-6 { 0.0 } else { nz / len }
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

fn vertices_of(kind: ShapeKind) -> &'static [(f32, f32, f32)] {
    match kind {
        ShapeKind::Cube => CUBE_V,
        ShapeKind::Tetrahedron => TET_V,
        ShapeKind::Octahedron => OCT_V,
        ShapeKind::Icosahedron => ICO_V,
        ShapeKind::Torus => TORUS_V,
        ShapeKind::Hypercube => HCUBE_V,
    }
}

fn edges_of(kind: ShapeKind) -> &'static [(usize, usize)] {
    match kind {
        ShapeKind::Cube => CUBE_E,
        ShapeKind::Tetrahedron => TET_E,
        ShapeKind::Octahedron => OCT_E,
        ShapeKind::Icosahedron => ICO_E,
        ShapeKind::Torus => TORUS_E,
        ShapeKind::Hypercube => HCUBE_E,
    }
}

/// Faces are triangles (vertex-index triples). Quad faces (cube,
/// torus, hypercube cubes) are fan-triangulated into two triangles
/// each. Empty for shapes that don't have a sensible solid surface.
fn faces_of(kind: ShapeKind) -> &'static [[usize; 3]] {
    match kind {
        ShapeKind::Cube => CUBE_F,
        ShapeKind::Tetrahedron => TET_F,
        ShapeKind::Octahedron => OCT_F,
        ShapeKind::Icosahedron => ICO_F,
        ShapeKind::Torus => TORUS_F,
        ShapeKind::Hypercube => HCUBE_F,
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
// 6 quad faces, each fan-triangulated into 2 triangles. Vertex
// winding is consistent (CCW seen from outside) so the cross-product
// face normal points outward.
const CUBE_F: &[[usize; 3]] = &[
    // -z (back)
    [0, 2, 1], [0, 3, 2],
    // +z (front)
    [4, 5, 6], [4, 6, 7],
    // -y (bottom)
    [0, 1, 5], [0, 5, 4],
    // +y (top)
    [3, 7, 6], [3, 6, 2],
    // -x (left)
    [0, 4, 7], [0, 7, 3],
    // +x (right)
    [1, 2, 6], [1, 6, 5],
];

const TET_V: &[(f32, f32, f32)] = &[
    (1.0, 1.0, 1.0),
    (-1.0, -1.0, 1.0),
    (-1.0, 1.0, -1.0),
    (1.0, -1.0, -1.0),
];
const TET_E: &[(usize, usize)] =
    &[(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];
const TET_F: &[[usize; 3]] = &[
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
];

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
// Octahedron: 8 triangular faces. Vertices are the 6 unit-axis
// points; each face lives in one octant.
const OCT_F: &[[usize; 3]] = &[
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
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
// 20 triangular faces. Winding chosen so cross(b-a, c-a) points
// outward for each face (CCW seen from outside the polyhedron).
const ICO_F: &[[usize; 3]] = &[
    [0, 1, 8],  [0, 8, 4],  [0, 4, 5],  [0, 5, 9],  [0, 9, 1],
    [1, 6, 8],  [8, 6, 10], [8, 10, 4], [4, 10, 2], [4, 2, 5],
    [5, 2, 11], [5, 11, 9], [9, 11, 7], [9, 7, 1],  [1, 7, 6],
    [3, 6, 7],  [3, 10, 6], [3, 2, 10], [3, 11, 2], [3, 7, 11],
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
// Tesseract solid mode: render both cubes as solid faces, skip the
// 4-D connectors. Painter sort by avg z handles the natural cube-
// inside-cube depth ordering. Same winding scheme as CUBE_F applied
// to the outer (0..8) and inner (8..16) vertex sets.
const HCUBE_F: &[[usize; 3]] = &[
    // outer cube — same triangle layout as CUBE_F shifted +0
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3],
    [1, 2, 6], [1, 6, 5],
    // inner cube — CUBE_F shifted +8
    [8, 10, 9],   [8, 11, 10],
    [12, 13, 14], [12, 14, 15],
    [8, 9, 13],   [8, 13, 12],
    [11, 15, 14], [11, 14, 10],
    [8, 12, 15],  [8, 15, 11],
    [9, 10, 14],  [9, 14, 13],
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
const TORUS_F: &[[usize; 3]] = &generate_torus_faces();

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

const fn generate_torus_faces() -> [[usize; 3]; TORUS_MAJOR * TORUS_MINOR * 2] {
    // Each (i, j) cell forms a quad with the next cells in the major
    // and minor directions; we triangulate each quad into 2 tris.
    let mut out = [[0_usize; 3]; TORUS_MAJOR * TORUS_MINOR * 2];
    let mut k = 0;
    let mut i = 0;
    while i < TORUS_MAJOR {
        let mut j = 0;
        while j < TORUS_MINOR {
            let i2 = (i + 1) % TORUS_MAJOR;
            let j2 = (j + 1) % TORUS_MINOR;
            let a = i * TORUS_MINOR + j;
            let b = i2 * TORUS_MINOR + j;
            let c = i2 * TORUS_MINOR + j2;
            let d = i * TORUS_MINOR + j2;
            out[k] = [a, b, c];
            k += 1;
            out[k] = [a, c, d];
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
