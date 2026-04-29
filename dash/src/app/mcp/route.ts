/**
 * MCP server for the LED fleet, mounted at `/mcp`.
 *
 * Streamable-HTTP transport via `mcp-handler`. Unauthed — same data
 * surface the dash UI exposes to anyone on the public URL. Tools wrap
 * the same Supabase queries as `src/utils/actions.ts` but address
 * panels by `name` (the human-meaningful id like "floater") rather
 * than UUID, so an agent can list_panels once and then keep speaking
 * names.
 */

import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

import {
  DEFAULT_CLOCK_CONFIG,
  DEFAULT_LIFE_CONFIG,
  DEFAULT_SHAPES_CONFIG,
  DEFAULT_TEST_CONFIG,
  MODES,
} from "@/app/scenes/types";
import type { Database } from "@/types/supabase";

export const runtime = "nodejs";
// Keep the function alive long enough for streaming responses on
// stateless transports (per mcp-handler's docs).
export const maxDuration = 60;

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

/* ─── helpers ─────────────────────────────────────────────────────── */

const ok = (body: unknown) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(body, null, 2) },
  ],
});

const err = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

const panelByName = async (name: string) => {
  const { data, error } = await supabase
    .from("panels")
    .select("*")
    .eq("name", name)
    .maybeSingle()
    .throwOnError();
  if (error) throw error;
  return data;
};

const touchPanel = async (panelId: string) => {
  await supabase
    .from("panels")
    .update({ last_updated: new Date().toISOString() })
    .eq("id", panelId)
    .throwOnError();
};

/** A panel is "online" if it pinged within ~3× its 30 s heartbeat. */
const isOnline = (lastSeen: string) =>
  Date.now() - new Date(lastSeen).getTime() < 90_000;

const summarisePanel = (
  p: Database["public"]["Tables"]["panels"]["Row"],
) => ({
  name: p.name,
  description: p.description,
  mode: p.mode,
  is_paused: p.is_paused,
  online: isOnline(p.last_seen),
  last_seen: p.last_seen,
  last_updated: p.last_updated,
  driver_version: p.driver_version,
});

/* ─── shared zod fragments ────────────────────────────────────────── */

const Rgb = z.object({
  r: z.number().int().min(0).max(255),
  g: z.number().int().min(0).max(255),
  b: z.number().int().min(0).max(255),
});

const TextColor = z.union([
  z.object({ Rgb }),
  z.object({
    Rainbow: z.object({
      is_per_letter: z.boolean(),
      speed: z.number().min(0.05).max(16),
    }),
  }),
]);

const ClockConfig = z
  .object({
    format: z.enum(["H12", "H24"]).optional(),
    show_seconds: z.boolean().optional(),
    show_meridiem: z.boolean().optional(),
    timezone: z.string().nullable().optional(),
    color: Rgb.optional(),
  })
  .optional();

const LifeConfig = z
  .object({
    color: Rgb.optional(),
    step_interval_frames: z.number().int().min(1).max(120).optional(),
  })
  .optional();

const ShapesConfig = z
  .object({
    kind: z
      .enum([
        "Cube",
        "Tetrahedron",
        "Octahedron",
        "Icosahedron",
        "Torus",
        "Hypercube",
      ])
      .optional(),
    color: Rgb.optional(),
    speed: z.number().min(0.05).max(16).optional(),
    depth_shade: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
  })
  .optional();

const TestConfig = z
  .object({
    pattern: z.enum(["ColorBars", "Gradient", "Checkerboard"]).optional(),
  })
  .optional();

/* ─── handler ─────────────────────────────────────────────────────── */

const handler = createMcpHandler(
  (server) => {
    /* ── reads ──────────────────────────────────────────────────── */

    server.registerTool(
      "list_panels",
      {
        title: "List LED panels",
        description:
          "List every deployed LED panel with current state: name, mode, paused flag, online flag, last_seen, last_updated, driver version. Always start here when addressing panels — every other tool takes a panel by `name`.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const { data, error } = await supabase
          .from("panels")
          .select("*")
          .order("name", { ascending: true })
          .throwOnError();
        if (error) throw error;
        return ok({ panels: (data ?? []).map(summarisePanel) });
      },
    );

    server.registerTool(
      "get_panel",
      {
        title: "Inspect one panel",
        description:
          "Read the full state of one panel by name: mode, mode-specific config (clock/life/shapes/test/etc.), paused flag, online flag, queued text entries (only meaningful when mode is 'text'). Errors if no panel matches the given name — call list_panels first.",
        inputSchema: {
          name: z.string().min(1).describe("Panel name, e.g. 'floater'."),
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ name }) => {
        const panel = await panelByName(name);
        if (!panel) return err(`No panel named '${name}'. Try list_panels.`);
        const { data: entries, error } = await supabase
          .from("entries")
          .select("*")
          .eq("panel_id", panel.id)
          .order("order", { ascending: true })
          .throwOnError();
        if (error) throw error;
        return ok({
          ...summarisePanel(panel),
          mode_config: panel.mode_config,
          entries: entries ?? [],
        });
      },
    );

    server.registerTool(
      "list_messages",
      {
        title: "List queued text messages",
        description:
          "List the text entries queued on a panel, in display order. The driver renders the top entries (up to ~7) on the matrix; the rest sit in the queue. Each entry has an id, text, and per-entry color + marquee speed options.",
        inputSchema: {
          name: z.string().min(1).describe("Panel name."),
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ name }) => {
        const panel = await panelByName(name);
        if (!panel) return err(`No panel named '${name}'. Try list_panels.`);
        const { data, error } = await supabase
          .from("entries")
          .select("*")
          .eq("panel_id", panel.id)
          .order("order", { ascending: true })
          .throwOnError();
        if (error) throw error;
        return ok({ entries: data ?? [] });
      },
    );

    server.registerTool(
      "list_modes",
      {
        title: "List available modes",
        description:
          "List the modes a panel can be set to via MCP, with the mode_config shape each accepts. Modes that need a bitmap upload (image, gif, paint) aren't switchable from MCP — change those from the dashboard. Use this before set_mode if unsure of the schema.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const supportsConfig: Record<string, unknown> = {
          text: { description: "No mode_config — use send_message to add text." },
          clock: {
            description: "Wall clock. All fields optional; defaults shown.",
            schema: {
              format: "'H12' | 'H24'",
              show_seconds: "boolean",
              show_meridiem: "boolean",
              timezone: "IANA tz string or null (use Pi system tz)",
              color: "{ r, g, b } 0-255",
            },
            defaults: DEFAULT_CLOCK_CONFIG,
          },
          life: {
            description: "Game of Life ambient pattern.",
            schema: {
              color: "{ r, g, b } 0-255",
              step_interval_frames:
                "integer 1-120; lower = faster generations (~60 fps base)",
            },
            defaults: DEFAULT_LIFE_CONFIG,
          },
          shapes: {
            description: "Rotating 3D wireframe.",
            schema: {
              kind: "'Cube' | 'Tetrahedron' | 'Octahedron' | 'Icosahedron' | 'Torus' | 'Hypercube'",
              color: "{ r, g, b } 0-255",
              speed: "0.05-16 (1.0 ≈ 6 RPM/axis)",
              depth_shade: "boolean (off by default; reads as flicker on small panels)",
              opacity: "0-1 (0 = wireframe, 1 = solid faces)",
            },
            defaults: DEFAULT_SHAPES_CONFIG,
          },
          test: {
            description: "Static diagnostic patterns.",
            schema: { pattern: "'ColorBars' | 'Gradient' | 'Checkerboard'" },
            defaults: DEFAULT_TEST_CONFIG,
          },
          image: {
            description:
              "Static 64×64 bitmap. Switch from the dashboard — bitmap uploads aren't supported over MCP.",
            switchable_via_mcp: false,
          },
          gif: {
            description:
              "Animated frame loop. Switch from the dashboard — gif uploads aren't supported over MCP.",
            switchable_via_mcp: false,
          },
          paint: {
            description:
              "Pixel-grid editor (stored as image). Switch from the dashboard.",
            switchable_via_mcp: false,
          },
        };
        return ok({
          modes: MODES.map((m) => ({
            id: m.id,
            label: m.label,
            blurb: m.blurb,
            ...(supportsConfig[m.id] as Record<string, unknown>),
          })),
        });
      },
    );

    /* ── writes ─────────────────────────────────────────────────── */

    server.registerTool(
      "send_message",
      {
        title: "Send a text message",
        description:
          "Append a text message to a panel's queue. The panel must already be in 'text' mode — if it isn't, this errors and you should call set_mode with mode='text' first. New messages appear at the top of the queue. Color can be solid RGB or a Rainbow effect.",
        inputSchema: {
          name: z.string().min(1).describe("Panel name."),
          text: z.string().min(1).max(280).describe("Message body."),
          color: TextColor.optional().describe(
            "Optional. Defaults to LED-orange RGB(255,138,44). Use { Rgb: { r, g, b } } or { Rainbow: { is_per_letter, speed } }.",
          ),
          marquee_speed: z
            .number()
            .min(0)
            .max(16)
            .optional()
            .describe(
              "Scroll speed multiplier. 0 = static (no scroll), 1 = default, higher = faster. Defaults to 1.",
            ),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ name, text, color, marquee_speed }) => {
        const panel = await panelByName(name);
        if (!panel) return err(`No panel named '${name}'. Try list_panels.`);
        if (panel.mode !== "text") {
          return err(
            `Panel '${name}' is in '${panel.mode}' mode, not 'text'. Call set_mode with mode='text' first, then retry.`,
          );
        }

        const entry = {
          text,
          options: {
            color: color ?? { Rgb: { r: 255, g: 138, b: 44 } },
            marquee: { speed: marquee_speed ?? 1 },
          },
        };

        // Match entries.add.call: insert at min(order)-1 so it lands
        // at the top of the queue without rewriting other rows.
        const { data: existing } = await supabase
          .from("entries")
          .select("order")
          .eq("panel_id", panel.id)
          .throwOnError();
        const minOrder = existing && existing.length > 0
          ? Math.min(...existing.map((e) => e.order))
          : 0;

        const { data: inserted, error: insertErr } = await supabase
          .from("entries")
          .insert({ panel_id: panel.id, data: entry, order: minOrder - 1 })
          .select()
          .single()
          .throwOnError();
        if (insertErr) throw insertErr;
        await touchPanel(panel.id);
        return ok({ inserted });
      },
    );

    server.registerTool(
      "set_mode",
      {
        title: "Switch panel mode",
        description:
          "Switch a panel to a new mode. Valid modes via MCP: text, clock, life, shapes, test (image/gif/paint require a bitmap upload from the dashboard). Pass mode_config matching the mode's schema (see list_modes); omitted fields fall back to mode defaults.",
        inputSchema: {
          name: z.string().min(1).describe("Panel name."),
          mode: z
            .enum(["text", "clock", "life", "shapes", "test"])
            .describe("Target mode."),
          clock_config: ClockConfig.describe("Used only when mode='clock'."),
          life_config: LifeConfig.describe("Used only when mode='life'."),
          shapes_config: ShapesConfig.describe("Used only when mode='shapes'."),
          test_config: TestConfig.describe("Used only when mode='test'."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ name, mode, clock_config, life_config, shapes_config, test_config }) => {
        const panel = await panelByName(name);
        if (!panel) return err(`No panel named '${name}'. Try list_panels.`);

        let modeConfig: Record<string, unknown> = {};
        if (mode === "clock") {
          modeConfig = { ...DEFAULT_CLOCK_CONFIG, ...(clock_config ?? {}) };
        } else if (mode === "life") {
          modeConfig = { ...DEFAULT_LIFE_CONFIG, ...(life_config ?? {}) };
        } else if (mode === "shapes") {
          modeConfig = { ...DEFAULT_SHAPES_CONFIG, ...(shapes_config ?? {}) };
        } else if (mode === "test") {
          modeConfig = { ...DEFAULT_TEST_CONFIG, ...(test_config ?? {}) };
        }
        // text: no config

        await supabase
          .from("panels")
          .update({
            mode,
            mode_config: modeConfig as Database["public"]["Tables"]["panels"]["Update"]["mode_config"],
            last_updated: new Date().toISOString(),
          })
          .eq("id", panel.id)
          .throwOnError();
        return ok({ name, mode, mode_config: modeConfig });
      },
    );

    server.registerTool(
      "set_paused",
      {
        title: "Pause or resume a panel",
        description:
          "Pause or resume a panel's render loop. While paused the panel freezes on its current frame; resuming continues from there.",
        inputSchema: {
          name: z.string().min(1).describe("Panel name."),
          paused: z.boolean().describe("true = pause, false = resume."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ name, paused }) => {
        const panel = await panelByName(name);
        if (!panel) return err(`No panel named '${name}'. Try list_panels.`);
        await supabase
          .from("panels")
          .update({ is_paused: paused, last_updated: new Date().toISOString() })
          .eq("id", panel.id)
          .throwOnError();
        return ok({ name, is_paused: paused });
      },
    );

    server.registerTool(
      "clear_messages",
      {
        title: "Clear the text queue",
        description:
          "Delete every queued text entry on the panel. Doesn't change mode. Returns the count of removed entries.",
        inputSchema: {
          name: z.string().min(1).describe("Panel name."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ name }) => {
        const panel = await panelByName(name);
        if (!panel) return err(`No panel named '${name}'. Try list_panels.`);
        const { data: deleted, error } = await supabase
          .from("entries")
          .delete()
          .eq("panel_id", panel.id)
          .select("id")
          .throwOnError();
        if (error) throw error;
        await touchPanel(panel.id);
        return ok({ name, deleted: deleted?.length ?? 0 });
      },
    );

    server.registerTool(
      "delete_message",
      {
        title: "Delete one queued message",
        description:
          "Remove a single text entry by its UUID (from list_messages or get_panel). No-op if no entry matches that id on this panel.",
        inputSchema: {
          name: z.string().min(1).describe("Panel name."),
          entry_id: z.string().uuid().describe("Entry UUID."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ name, entry_id }) => {
        const panel = await panelByName(name);
        if (!panel) return err(`No panel named '${name}'. Try list_panels.`);
        const { data: deleted, error } = await supabase
          .from("entries")
          .delete()
          .eq("id", entry_id)
          .eq("panel_id", panel.id)
          .select("id")
          .throwOnError();
        if (error) throw error;
        await touchPanel(panel.id);
        return ok({ name, deleted: deleted?.length ?? 0 });
      },
    );

    server.registerTool(
      "reorder_messages",
      {
        title: "Reorder the text queue",
        description:
          "Replace the queue order with the given list of entry UUIDs. The list must contain every existing entry id for the panel exactly once — otherwise this errors without changing anything.",
        inputSchema: {
          name: z.string().min(1).describe("Panel name."),
          ordered_entry_ids: z
            .array(z.string().uuid())
            .min(1)
            .describe(
              "Entry UUIDs in the desired display order. Index 0 renders first.",
            ),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ name, ordered_entry_ids }) => {
        const panel = await panelByName(name);
        if (!panel) return err(`No panel named '${name}'. Try list_panels.`);

        const { data: existing, error: listErr } = await supabase
          .from("entries")
          .select("id")
          .eq("panel_id", panel.id)
          .throwOnError();
        if (listErr) throw listErr;
        const existingIds = (existing ?? []).map((e) => e.id);
        const givenSet = new Set(ordered_entry_ids);
        if (
          existingIds.length !== givenSet.size ||
          existingIds.some((id) => !givenSet.has(id))
        ) {
          return err(
            `ordered_entry_ids must be a permutation of the panel's current entry ids. Have ${existingIds.length}, got ${givenSet.size}.`,
          );
        }

        await Promise.all(
          ordered_entry_ids.map((id, order) =>
            supabase
              .from("entries")
              .update({ order })
              .eq("id", id)
              .eq("panel_id", panel.id)
              .throwOnError(),
          ),
        );
        await touchPanel(panel.id);
        return ok({ name, ordered_entry_ids });
      },
    );
  },
  {
    serverInfo: { name: "led-fleet", version: "1.0.0" },
    instructions: [
      "MCP server for ziyad's LED matrix fleet (4× 64×64 RGB panels driven by Pi Zero W).",
      "",
      "Each panel renders one mode at a time: text (scrolling messages queued via send_message), clock, life (Game of Life), shapes (rotating 3D wireframes), test (diagnostic patterns), or one of the bitmap modes (image/gif/paint) which can't be set via MCP.",
      "",
      "Conventions:",
      "- Address panels by `name` (e.g. 'floater', 'office'). Always call list_panels first to discover names.",
      "- send_message is text-mode only; if a panel is in another mode, call set_mode mode='text' first.",
      "- 'online' means the driver pinged within the last ~90 s (heartbeat is 30 s).",
      "- Colors are { r, g, b } in 0-255. Default LED-orange is (255, 138, 44).",
    ].join("\n"),
  },
  {
    basePath: "",
    streamableHttpEndpoint: "/mcp",
    disableSse: true,
    verboseLogs: false,
  },
);

export { handler as POST };

export async function GET(): Promise<Response> {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>led-fleet · MCP</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #0b0b0e; color: #e5e5e5; font: 14px/1.55 ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace; }
  main { max-width: 60ch; margin: 8vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.05rem; letter-spacing: .25em; text-transform: uppercase; color: #ff8a2c; margin: 0 0 1.5rem; }
  h2 { font-size: .8rem; letter-spacing: .25em; text-transform: uppercase; color: #ff8a2c; margin: 2rem 0 .5rem; }
  code, pre { background: #15151a; border: 1px solid #2a2a30; padding: .1em .35em; border-radius: 2px; }
  pre { padding: .75rem 1rem; overflow-x: auto; }
  ul { padding-left: 1.25rem; } li { margin: .15rem 0; }
  a { color: #ff8a2c; }
  .muted { color: #8a8a92; }
</style>
</head>
<body>
<main>
  <h1>led-fleet · model context protocol</h1>
  <p class="muted">Streamable-HTTP MCP server. Speak JSON-RPC at <code>POST /mcp</code>.</p>

  <h2>Tools</h2>
  <ul>
    <li><code>list_panels</code> — list every panel with state</li>
    <li><code>get_panel</code> — full state of one panel</li>
    <li><code>list_messages</code> — text queue for a panel</li>
    <li><code>list_modes</code> — modes + config schemas</li>
    <li><code>send_message</code> — append text (panel must be in text mode)</li>
    <li><code>set_mode</code> — text/clock/life/shapes/test</li>
    <li><code>set_paused</code> — freeze/resume render loop</li>
    <li><code>clear_messages</code> — wipe text queue</li>
    <li><code>delete_message</code> — remove one entry</li>
    <li><code>reorder_messages</code> — reshuffle the queue</li>
  </ul>

  <h2>Example client config</h2>
<pre>{
  "mcpServers": {
    "led-fleet": {
      "type": "http",
      "url": "https://led.ziyadedher.com/mcp"
    }
  }
}</pre>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
