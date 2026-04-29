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
fn image_skips_pure_black_pixels() {
    // A 4x4 image with one red pixel surrounded by black — black
    // should be treated as transparent (left unset on the canvas),
    // matching the documented behaviour.
    let mut bitmap = vec![0_u8; 4 * 4 * 3];
    let red_idx = (1 * 4 + 1) * 3;
    bitmap[red_idx] = 255;
    let scene = scene_with(Mode::Image(Arc::new(ImageScene {
        width: 4,
        height: 4,
        bitmap,
    })));
    let mut canvas = MockCanvas::new(W, H);
    canvas.clear_to(Rgb888::CSS_GRAY);
    // Top-level render clears to BLACK first, so we won't actually
    // see CSS_GRAY here — but the per-mode render must still skip
    // black pixels rather than overwriting them.
    render(&scene, 0, &mut canvas).unwrap();
    // The lit pixel count should be 1 (just the red one).
    assert_eq!(canvas.lit_count(), 1, "only the red pixel should light up");
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
    // Two frames, each 4×4. Frame 0 is bright red, frame 1 is bright
    // blue. Each frame's delay = 100ms. At 60Hz step rate, frame 0
    // covers steps 0..6 and frame 1 covers steps 6..12.
    let red: Vec<u8> = std::iter::repeat([255_u8, 0, 0]).take(16).flatten().collect();
    let blue: Vec<u8> = std::iter::repeat([0_u8, 0, 255]).take(16).flatten().collect();
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
