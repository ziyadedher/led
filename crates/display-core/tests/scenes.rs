//! Smoke + invariant tests for the render core. Each test renders
//! one scene into a [`MockCanvas`] and checks a few invariants —
//! shape, presence, or specific-pixel values — that would fail noisily
//! under most regressions. Not exhaustive; the goal is to catch the
//! "did anyone change the render contract by accident" class of bug.

use std::sync::Arc;

use display_core::{
    clock::{ClockFormat, ClockScene, ClockTime},
    gif::{GifFrame, GifScene},
    image::ImageScene,
    life::LifeScene,
    render,
    shapes::{ShapeKind, ShapesScene},
    test::{TestPattern, TestScene},
    text::{Rgb, TextEntry, TextEntryColor, TextEntryOptions},
    Mode, PanelState, Scene,
};
use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    Pixel,
};

const W: u32 = 64;
const H: u32 = 64;

/// Minimal owned-buffer DrawTarget for tests. Mirrors the driver and
/// wasm-sim PixelBuffers but stays inside this test crate so the
/// production codebase doesn't carry a test helper.
struct MockCanvas {
    width: u32,
    height: u32,
    pixels: Vec<Rgb888>,
}

impl MockCanvas {
    fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![Rgb888::BLACK; (width * height) as usize],
        }
    }

    fn at(&self, x: u32, y: u32) -> Rgb888 {
        self.pixels[(y * self.width + x) as usize]
    }

    fn lit_count(&self) -> usize {
        self.pixels
            .iter()
            .filter(|p| p.r() != 0 || p.g() != 0 || p.b() != 0)
            .count()
    }

    fn clear_to(&mut self, color: Rgb888) {
        for p in &mut self.pixels {
            *p = color;
        }
    }
}

impl DrawTarget for MockCanvas {
    type Color = Rgb888;
    type Error = core::convert::Infallible;

    fn draw_iter<I>(&mut self, pixels: I) -> Result<(), Self::Error>
    where
        I: IntoIterator<Item = Pixel<Self::Color>>,
    {
        let w = self.width as i32;
        let h = self.height as i32;
        for Pixel(pt, color) in pixels {
            if pt.x < 0 || pt.y < 0 || pt.x >= w || pt.y >= h {
                continue;
            }
            self.pixels[(pt.y as u32 * self.width + pt.x as u32) as usize] = color;
        }
        Ok(())
    }
}

impl OriginDimensions for MockCanvas {
    fn size(&self) -> Size {
        Size::new(self.width, self.height)
    }
}

fn scene_with(mode: Mode) -> Scene {
    Scene {
        mode,
        panel: PanelState::default(),
    }
}

/* ─── render dispatch ────────────────────────────────────────────── */

#[test]
fn empty_text_scene_clears_canvas() {
    let mut canvas = MockCanvas::new(W, H);
    canvas.clear_to(Rgb888::WHITE);
    let scene = scene_with(Mode::default());
    render(&scene, 0, &mut canvas).unwrap();
    // The top-level render() does a `canvas.clear(BLACK)` before
    // dispatch, so a white canvas should be reset to black even if
    // the active mode emits nothing.
    assert_eq!(canvas.lit_count(), 0, "empty text mode should leave a black canvas");
}

#[test]
fn flash_overlay_lights_canvas_white_on_active_window() {
    let mut canvas = MockCanvas::new(W, H);
    let mut scene = scene_with(Mode::default());
    scene.panel.flash.is_active = true;
    scene.panel.flash.on_steps = 4;
    scene.panel.flash.total_steps = 8;
    render(&scene, 0, &mut canvas).unwrap();
    assert_eq!(canvas.at(0, 0), Rgb888::WHITE);
    assert_eq!(canvas.at(W - 1, H - 1), Rgb888::WHITE);

    // Stepping past `on_steps` (but inside `total_steps`) drops the
    // flash — canvas reverts to whatever the underlying mode draws.
    let mut canvas2 = MockCanvas::new(W, H);
    render(&scene, 5, &mut canvas2).unwrap();
    assert_eq!(canvas2.at(0, 0), Rgb888::BLACK);
}

#[test]
fn is_off_short_circuits_render() {
    // Construct a scene that would normally render *something* — text
    // mode with an entry — and verify is_off=true produces a fully
    // black frame. Mode + flash should be ignored entirely; flipping
    // is_off back gives the same scene.
    use display_core::text::{TextEntry, TextEntryColor, TextEntryOptions, MarqueeOptions, RainbowOptions};
    let entries = vec![TextEntry {
        text: "hello".into(),
        options: TextEntryOptions {
            color: TextEntryColor::Rainbow(RainbowOptions { is_per_letter: false, speed: 1 }),
            marquee: MarqueeOptions { speed: 0 },
        },
    }];
    let mut canvas = MockCanvas::new(W, H);
    let mut scene = scene_with(Mode::Text(display_core::text::TextScene { entries, scroll: 0 }));
    scene.panel.is_off = true;
    scene.panel.flash.is_active = true;
    scene.panel.flash.on_steps = 4;
    scene.panel.flash.total_steps = 8;
    render(&scene, 0, &mut canvas).unwrap();
    assert_eq!(canvas.lit_count(), 0, "is_off panel must render fully black");
}

#[test]
fn pause_disables_flash_overlay() {
    let mut canvas = MockCanvas::new(W, H);
    let mut scene = scene_with(Mode::default());
    scene.panel.is_paused = true;
    scene.panel.flash.is_active = true;
    scene.panel.flash.on_steps = 4;
    scene.panel.flash.total_steps = 8;
    render(&scene, 0, &mut canvas).unwrap();
    assert_eq!(
        canvas.lit_count(),
        0,
        "paused panel should suppress the flash overlay"
    );
}

/* ─── text ───────────────────────────────────────────────────────── */

#[test]
fn text_entry_renders_some_pixels() {
    let entries = vec![TextEntry {
        text: "hi".into(),
        options: TextEntryOptions {
            color: TextEntryColor::Rgb(Rgb { r: 255, g: 138, b: 44 }),
            marquee: display_core::MarqueeOptions { speed: 0 },
        },
    }];
    let scene = scene_with(Mode::Text(display_core::text::TextScene {
        entries,
        scroll: 0,
    }));
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 0, &mut canvas).unwrap();
    assert!(
        canvas.lit_count() > 0,
        "rendered text should light up at least some pixels"
    );
}

/* ─── clock ──────────────────────────────────────────────────────── */

#[test]
fn clock_renders_nonempty() {
    let scene = scene_with(Mode::Clock(ClockScene {
        format: ClockFormat::H24,
        show_seconds: false,
        show_meridiem: false,
        color: Rgb { r: 255, g: 200, b: 64 },
        now: ClockTime { hour: 12, minute: 34, second: 56 },
    }));
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 0, &mut canvas).unwrap();
    assert!(canvas.lit_count() > 0, "clock should render at least the time digits");
}

/* ─── image / paint ──────────────────────────────────────────────── */

#[test]
fn image_skips_alpha_zero_pixels() {
    // 4×4 image with one opaque red pixel; the rest are alpha=0
    // (transparent). The renderer should leave the canvas dark
    // everywhere except the red.
    let mut bitmap = vec![0_u8; 4 * 4 * 4];
    let idx = (1 * 4 + 1) * 4;
    bitmap[idx] = 255; // R
    bitmap[idx + 3] = 255; // A
    let scene = scene_with(Mode::Image(Arc::new(ImageScene {
        width: 4,
        height: 4,
        bitmap,
    })));
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 0, &mut canvas).unwrap();
    assert_eq!(canvas.lit_count(), 1, "only the alpha-1 pixel should light up");
}

#[test]
fn image_renders_pure_black_when_alpha_set() {
    // Sanity: a black pixel with alpha=255 is opaque-black and should
    // be drawn (it just doesn't *light* anything because RGB is 0).
    // This is the case the old (0,0,0) sentinel used to break.
    let mut bitmap = vec![0_u8; 4 * 4 * 4];
    for i in 0..16 {
        bitmap[i * 4 + 3] = 255;
    }
    let scene = scene_with(Mode::Image(Arc::new(ImageScene {
        width: 4,
        height: 4,
        bitmap,
    })));
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 0, &mut canvas).unwrap();
    // All pixels are written as RGB(0,0,0) — i.e. the canvas got
    // explicit black writes for those 16 pixels. lit_count counts
    // *non-black*, so it's still 0; but the writes happened
    // (they'd overwrite a non-black starting state).
    assert_eq!(canvas.lit_count(), 0);
    // Confirm by clearing to white first; the image's opaque-black
    // 4x4 in the centre should overwrite to black.
    let mut canvas = MockCanvas::new(W, H);
    canvas.clear_to(Rgb888::WHITE);
    render(&scene, 0, &mut canvas).unwrap();
    // After render, top-level dispatch cleared to BLACK first, so
    // the whole canvas is black-or-image-black.
    assert_eq!(canvas.lit_count(), 0);
}

/* ─── shapes ─────────────────────────────────────────────────────── */

#[test]
fn shapes_wireframe_lights_some_pixels_for_each_kind() {
    for kind in [
        ShapeKind::Cube,
        ShapeKind::Tetrahedron,
        ShapeKind::Octahedron,
        ShapeKind::Icosahedron,
        ShapeKind::Torus,
        ShapeKind::Hypercube,
    ] {
        let scene = scene_with(Mode::Shapes(ShapesScene {
            kind,
            color: Rgb { r: 255, g: 138, b: 44 },
            speed: 1.0,
            depth_shade: false,
            opacity: 0.0,
        }));
        let mut canvas = MockCanvas::new(W, H);
        render(&scene, 0, &mut canvas).unwrap();
        assert!(
            canvas.lit_count() > 4,
            "{kind:?} wireframe should draw multiple lit pixels"
        );
    }
}

#[test]
fn shapes_solid_lights_more_than_wireframe() {
    // Solid mode should fill faces, so for a convex polyhedron the
    // lit-pixel count should always exceed the wireframe count.
    let mut wire_canvas = MockCanvas::new(W, H);
    render(
        &scene_with(Mode::Shapes(ShapesScene {
            kind: ShapeKind::Cube,
            color: Rgb { r: 255, g: 138, b: 44 },
            speed: 1.0,
            depth_shade: false,
            opacity: 0.0,
        })),
        0,
        &mut wire_canvas,
    )
    .unwrap();

    let mut solid_canvas = MockCanvas::new(W, H);
    render(
        &scene_with(Mode::Shapes(ShapesScene {
            kind: ShapeKind::Cube,
            color: Rgb { r: 255, g: 138, b: 44 },
            speed: 1.0,
            depth_shade: false,
            opacity: 1.0,
        })),
        0,
        &mut solid_canvas,
    )
    .unwrap();

    assert!(
        solid_canvas.lit_count() > wire_canvas.lit_count(),
        "solid cube ({} px) should fill more than wireframe cube ({} px)",
        solid_canvas.lit_count(),
        wire_canvas.lit_count(),
    );
}

#[test]
fn shapes_back_edges_are_culled_for_convex_cube() {
    // At step=20 the cube has rotated enough that front and back face
    // edges project to distinct 2-D lines. Previously the renderer
    // drew all 12 cube edges unconditionally, so the back-cube outline
    // bled across the interior of the silhouette ("double cube"
    // artifact). The fix is to skip an edge whose two adjacent faces
    // are both back-facing.
    //
    // Bound is empirical: the cube has 12 edges and the old code
    // drew them all at this orientation for a lit_count of 370.
    // Culling the 3 fully-back edges leaves 9 visible (~280 lit
    // pixels). The 320 threshold sits cleanly between the two —
    // tight enough to catch the "all edges drawn" regression, loose
    // enough to survive line-style tweaks.
    // Cull is opacity-gated: with opacity=1 the faces fully cover
    // any back edge, so culling those edges prevents bleed-through.
    // With opacity=0 (wireframe) the back edges remain visible —
    // see `shapes_wireframe_keeps_back_edges_at_low_opacity`.
    let scene = scene_with(Mode::Shapes(ShapesScene {
        kind: ShapeKind::Cube,
        color: Rgb { r: 255, g: 0, b: 0 },
        speed: 1.0,
        depth_shade: false,
        opacity: 1.0,
    }));
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 20, &mut canvas).unwrap();
    // Count pixels at full edge brightness only — face fills will be
    // at intermediate brightnesses under Gouraud + opacity=1.
    let edge_lit = (0..W)
        .flat_map(|x| (0..H).map(move |y| (x, y)))
        .filter(|&(x, y)| canvas.at(x, y).r() >= 250)
        .count();
    assert!(
        edge_lit <= 320,
        "expected back-edge cull to keep edge-bright pixels <=320, got {edge_lit}",
    );
    assert!(
        edge_lit >= 40,
        "front edges should still draw at full brightness, got {edge_lit}",
    );
}

#[test]
fn shapes_wireframe_keeps_back_edges_at_low_opacity() {
    // With opacity=0 the faces are not drawn, so back edges have
    // nothing covering them. Renderer must NOT cull them. Compare
    // total lit pixels against a solid (opacity=1, cull active)
    // render: the wireframe should light strictly more pixels
    // because it draws ALL 12 edges instead of just the ~9 visible.
    let make = |opacity| {
        let scene = scene_with(Mode::Shapes(ShapesScene {
            kind: ShapeKind::Cube,
            color: Rgb { r: 255, g: 0, b: 0 },
            speed: 1.0,
            depth_shade: false,
            opacity,
        }));
        let mut canvas = MockCanvas::new(W, H);
        render(&scene, 20, &mut canvas).unwrap();
        // Count only pixels at full edge brightness so face fills
        // don't pollute the comparison.
        (0..W)
            .flat_map(|x| (0..H).map(move |y| (x, y)))
            .filter(|&(x, y)| canvas.at(x, y).r() >= 250)
            .count()
    };
    let wire_edges = make(0.0);
    let solid_edges = make(1.0);
    assert!(
        wire_edges > solid_edges + 30,
        "wireframe should draw more edges than solid (cull only when solid), got wire={wire_edges} solid={solid_edges}",
    );
}

#[test]
fn shapes_gouraud_creates_face_gradient() {
    // Per-vertex shading with a fixed directional light: at step=0
    // (axis-aligned cube, opacity=1) the front face should NOT be a
    // single uniform tone — pixels on the "lit" side of the face
    // (toward the light) must be strictly brighter than pixels on
    // the opposite side. With light from upper-right, the top-right
    // of the front face is the bright corner.
    let scene = scene_with(Mode::Shapes(ShapesScene {
        kind: ShapeKind::Cube,
        color: Rgb { r: 255, g: 0, b: 0 },
        speed: 1.0,
        depth_shade: false,
        opacity: 1.0,
    }));
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 0, &mut canvas).unwrap();
    // Both pixels lie inside the front face's silhouette (cube
    // covers ~x:[12,52], y:[12,52] at scale 0.32*64).
    let lit_corner = canvas.at(48, 16);
    let dim_corner = canvas.at(16, 48);
    assert!(
        lit_corner.r() > dim_corner.r() + 30,
        "expected upper-right brighter than lower-left by >30, got lit={} dim={}",
        lit_corner.r(),
        dim_corner.r(),
    );
}

#[test]
fn shapes_depth_shade_floor_is_at_least_half() {
    // depth_shade=true scales edges by z. Old formula floored at 0.25
    // which crushed back edges below visibility on a 64x64 panel.
    // New floor is 0.5. Dimmest non-zero pixel must be >= 0.5*base.
    let scene = scene_with(Mode::Shapes(ShapesScene {
        kind: ShapeKind::Cube,
        color: Rgb { r: 255, g: 0, b: 0 },
        speed: 1.0,
        depth_shade: true,
        opacity: 0.0,
    }));
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 20, &mut canvas).unwrap();
    let mut min_r = 255_u8;
    let mut any_lit = false;
    for y in 0..H {
        for x in 0..W {
            let p = canvas.at(x, y);
            let v = p.r();
            if v > 0 {
                any_lit = true;
                if v < min_r {
                    min_r = v;
                }
            }
        }
    }
    assert!(any_lit, "depth_shade wireframe should render at least one edge");
    assert!(
        min_r >= 120,
        "depth_shade floor should be >= 0.5*255=127, got min R={min_r}",
    );
}

#[test]
fn shapes_speed_clamp_doesnt_panic() {
    // Pathological speeds (NaN, infinity, zero, negative) shouldn't
    // panic the renderer — driver clamps to [0.05, 16] but the
    // public field is untyped, so make sure invariants hold.
    for &speed in &[0.0, -1.0, f32::INFINITY, f32::NAN, 1e9] {
        let scene = scene_with(Mode::Shapes(ShapesScene {
            kind: ShapeKind::Cube,
            color: Rgb { r: 255, g: 138, b: 44 },
            speed,
            depth_shade: false,
            opacity: 0.0,
        }));
        let mut canvas = MockCanvas::new(W, H);
        let _ = render(&scene, 100, &mut canvas);
    }
}

/* ─── brightness ─────────────────────────────────────────────────── */

fn channel_sum(c: &MockCanvas) -> u64 {
    c.pixels
        .iter()
        .map(|p| u64::from(p.r()) + u64::from(p.g()) + u64::from(p.b()))
        .sum()
}

#[test]
fn brightness_scales_output_linearly() {
    let render_at = |brightness: f32| {
        let mut scene = scene_with(Mode::Test(TestScene {
            pattern: TestPattern::ColorBars,
        }));
        scene.panel.brightness = brightness;
        let mut canvas = MockCanvas::new(W, H);
        render(&scene, 0, &mut canvas).unwrap();
        channel_sum(&canvas)
    };
    let full = render_at(1.0);
    let half = render_at(0.5);
    assert!(full > 0, "color bars at full brightness should light pixels");
    let ratio = half as f64 / full as f64;
    assert!(
        (0.45..=0.55).contains(&ratio),
        "half brightness should ~halve total output, got ratio {ratio:.3}",
    );
}

#[test]
fn brightness_default_is_full() {
    // A scene with no brightness set (Default / missing JSON field) must
    // render at full brightness, not black.
    let mut explicit = scene_with(Mode::Test(TestScene {
        pattern: TestPattern::ColorBars,
    }));
    explicit.panel.brightness = 1.0;
    let mut c_explicit = MockCanvas::new(W, H);
    render(&explicit, 0, &mut c_explicit).unwrap();

    let defaulted = scene_with(Mode::Test(TestScene {
        pattern: TestPattern::ColorBars,
    })); // panel via PanelState::default()
    let mut c_default = MockCanvas::new(W, H);
    render(&defaulted, 0, &mut c_default).unwrap();

    assert_eq!(channel_sum(&c_explicit), channel_sum(&c_default));
}

#[test]
fn brightness_zero_is_black() {
    let mut scene = scene_with(Mode::Test(TestScene {
        pattern: TestPattern::ColorBars,
    }));
    scene.panel.brightness = 0.0;
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 0, &mut canvas).unwrap();
    assert_eq!(canvas.lit_count(), 0, "brightness 0 should render black");
}

#[test]
fn brightness_missing_json_field_defaults_full() {
    // Old persisted scenes (and the dash before it sends brightness)
    // omit the field; serde must default it to 1.0, not 0.0.
    let json = r#"{"mode":{"Test":{"pattern":"ColorBars"}},"panel":{"is_paused":false,"is_off":false,"flash":{"is_active":false,"on_steps":0,"total_steps":0}}}"#;
    let scene: Scene = serde_json::from_str(json).unwrap();
    assert_eq!(scene.panel.brightness, 1.0);
}

/* ─── gif ────────────────────────────────────────────────────────── */

#[test]
fn empty_gif_renders_blank() {
    let scene = scene_with(Mode::Gif(Arc::new(GifScene::default())));
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 0, &mut canvas).unwrap();
    assert_eq!(canvas.lit_count(), 0);
}

#[test]
fn gif_advances_through_frames() {
    // Two frames, each 4×4 RGBA opaque. Frame 0 is red, frame 1 blue.
    // Each frame delays 100ms — at 60Hz, frame 0 covers steps 0..6
    // and frame 1 covers steps 6..12.
    let red: Vec<u8> = std::iter::repeat([255_u8, 0, 0, 255]).take(16).flatten().collect();
    let blue: Vec<u8> = std::iter::repeat([0_u8, 0, 255, 255]).take(16).flatten().collect();
    let scene = scene_with(Mode::Gif(Arc::new(GifScene {
        width: 4,
        height: 4,
        frames: vec![
            GifFrame { bitmap: red, delay_ms: 100 },
            GifFrame { bitmap: blue, delay_ms: 100 },
        ],
        speed: 1.0,
    })));

    let mut canvas0 = MockCanvas::new(W, H);
    render(&scene, 0, &mut canvas0).unwrap();
    let centre = canvas0.at(W / 2, H / 2);
    assert!(centre.r() > 0 && centre.b() == 0, "step 0 should be on the red frame");

    let mut canvas1 = MockCanvas::new(W, H);
    render(&scene, 8, &mut canvas1).unwrap();
    let centre = canvas1.at(W / 2, H / 2);
    assert!(centre.b() > 0 && centre.r() == 0, "step 8 should be on the blue frame");
}

/* ─── life ───────────────────────────────────────────────────────── */

#[test]
fn life_renders_at_least_seed_population() {
    let mut cells = vec![0_u8; 64 * 64 / 8 + 1];
    cells[0] |= 1; // (0, 0)
    cells[1] |= 1; // (8, 0)
    let scene = scene_with(Mode::Life(LifeScene {
        color: Rgb { r: 0, g: 255, b: 128 },
        lattice_width: 64,
        lattice_height: 64,
        cells,
    }));
    let mut canvas = MockCanvas::new(W, H);
    render(&scene, 0, &mut canvas).unwrap();
    assert!(canvas.lit_count() >= 2, "life should light up at least the seeded cells");
}

/* ─── test patterns ──────────────────────────────────────────────── */

#[test]
fn test_patterns_all_render_nonempty() {
    for pattern in [
        TestPattern::ColorBars,
        TestPattern::Gradient,
        TestPattern::Checkerboard,
    ] {
        let scene = scene_with(Mode::Test(TestScene { pattern }));
        let mut canvas = MockCanvas::new(W, H);
        render(&scene, 0, &mut canvas).unwrap();
        assert!(
            canvas.lit_count() > (W * H / 4) as usize,
            "{pattern:?} should fill a meaningful fraction of the canvas"
        );
    }
}
