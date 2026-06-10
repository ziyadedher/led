import { createClient } from "@supabase/supabase-js";
import { useEffect, useId, useState } from "react";
import useSWR, { mutate as globalMutate, useSWRConfig } from "swr";

import { Database } from "@/types/supabase";
import { rememberModeConfig } from "@/utils/modeConfigCache";

type PanelRow = Database["public"]["Tables"]["panels"]["Row"];

type TextEntryOptions = {
  color:
    | { Rgb: { r: number; g: number; b: number } }
    | { Rainbow: { is_per_letter: boolean; speed: number } };
  marquee: { speed: number };
};

export type TextEntry = {
  text: string;
  options: TextEntryOptions;
};

export type TextEntryItem = Omit<
  Database["public"]["Tables"]["entries"]["Row"],
  "data"
> & { data: TextEntry };

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — set them in dash/.env.local",
  );
}

const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);

const getPanel = async (id: string) => {
  const { data } = await supabase
    .from("panels")
    .select("*")
    .eq("id", id)
    .maybeSingle()
    .throwOnError();
  if (data === null) {
    throw new Error(`panel ${id} not found`);
  }
  return data;
};

// A row's `data` JSON is untyped at the DB boundary. Narrow it to the
// shape composers rely on, dropping rows that don't match so one bad
// row can't crash the whole queue render.
const isTextEntry = (data: unknown): data is TextEntry => {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.text === "string" && typeof d.options === "object" && d.options !== null;
};

const getEntries = async (panel_id: string): Promise<TextEntryItem[]> => {
  const { data } = await supabase
    .from("entries")
    .select("*")
    .eq("panel_id", panel_id)
    .order("order", { ascending: true })
    .throwOnError();
  return (data ?? []).filter((row) => isTextEntry(row.data)) as TextEntryItem[];
};

type EntriesCache = { entries: TextEntryItem[] };
const entriesKey = (panelId: string) => `/entries/${panelId}`;

const updatePanelLastUpdated = async (panelId: string) => {
  await supabase
    .from("panels")
    .update({ last_updated: new Date().toISOString() })
    .eq("id", panelId)
    .throwOnError();
};

// Realtime pushes invalidations to SWR, so polling is only a fallback
// for a missed websocket message. When the channel is live we poll
// rarely (60s backstop); when it's connecting/down we poll tighter
// (15s) to recover quickly. `realtimeLive` is updated by
// `useRealtimeRevalidation`; the page re-renders on status change so
// the factory re-reads the interval.
let realtimeLive = false;
const LIVE_REFRESH_INTERVAL = 60_000;
const FALLBACK_REFRESH_INTERVAL = 15_000;

const useSWRFactory = <Result>(
  key: string | null,
  func: () => Promise<Result>,
  { refreshInterval }: { refreshInterval?: number } = {},
) =>
  useSWR(key, func, {
    refreshInterval:
      refreshInterval ??
      (realtimeLive ? LIVE_REFRESH_INTERVAL : FALLBACK_REFRESH_INTERVAL),
  });

export type RealtimeStatus = "connecting" | "live" | "down";

/**
 * Subscribe to Postgres changes on the `panels` and `entries` tables
 * and trigger SWR revalidation for the affected keys. Mount once at
 * the page root. Returns the current channel status — useful for a
 * "live" indicator.
 */
export const useRealtimeRevalidation = (): RealtimeStatus => {
  const { mutate } = useSWRConfig();
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  // Unique per mount so a StrictMode double-invoke (or two consumers)
  // can't have the second subscribe race the first's removeChannel
  // onto the same channel name.
  const channelId = useId();

  useEffect(() => {
    realtimeLive = false;
    const channel = supabase
      .channel(`led-dash-realtime-${channelId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "panels" },
        (payload) => {
          mutate("/panels");
          const id =
            (payload.new as { id?: string })?.id ??
            (payload.old as { id?: string })?.id;
          if (id) {
            mutate(`/entries/scroll/${id}`);
            // A cascade-deleted panel takes its entries with it; drop
            // the stale per-panel entries cache too.
            if (payload.eventType === "DELETE") mutate(entriesKey(id));
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "entries" },
        (payload) => {
          const panelId =
            (payload.new as { panel_id?: string })?.panel_id ??
            (payload.old as { panel_id?: string })?.panel_id;
          if (panelId) {
            mutate(`/entries/${panelId}`);
          } else {
            // DELETE events only carry the primary key under the default
            // replica identity (and RLS strips the rest even with
            // REPLICA IDENTITY FULL), so we can't tell which panel's
            // queue changed — invalidate every entries cache rather
            // than silently going stale until the 60s backstop poll.
            void mutate(
              (key) =>
                typeof key === "string" &&
                key.startsWith("/entries/") &&
                !key.startsWith("/entries/scroll/"),
            );
          }
        },
      )
      .subscribe((s) => {
        if (s === "SUBSCRIBED") {
          realtimeLive = true;
          setStatus("live");
        } else if (s === "CLOSED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
          realtimeLive = false;
          setStatus("down");
        } else {
          realtimeLive = false;
          setStatus("connecting");
        }
      });

    return () => {
      realtimeLive = false;
      void supabase.removeChannel(channel);
    };
  }, [mutate, channelId]);

  return status;
};

export type PanelMode =
  | "text"
  | "clock"
  | "life"
  | "image"
  | "paint"
  | "gif"
  | "shapes"
  | "test";

/**
 * Optimistically patch one panel row in the `/panels` SWR cache while
 * the write round-trips, rolling back if it throws. This gives the
 * transport buttons / mode tiles / brightness fader the same instant
 * feel the entries pipeline already has — without it, a tap only takes
 * effect after the write AND a revalidation (up to 15s when the
 * realtime channel is down), which reads as a dead button.
 *
 * Mutations are serialized through a module-level chain: SWR's
 * overlapping-mutation semantics make the first mutation skip its
 * cache commit and let the second commit from a snapshot that
 * predates the first's patch — i.e. quick pause-then-off taps would
 * drop the pause from the cache until the realtime echo. One write at
 * a time sidesteps that class entirely (these are sub-second row
 * UPDATEs; queueing is imperceptible).
 */
let panelWriteChain: Promise<unknown> = Promise.resolve();

const patchPanelOptimistic = (
  panelId: string,
  patch: Partial<PanelRow>,
  write: () => Promise<void>,
): Promise<void> => {
  // Leave an unpopulated cache alone — committing a fabricated []
  // would render "no panels registered" until the next revalidation.
  const apply = (cur?: PanelRow[]) =>
    cur ? cur.map((p) => (p.id === panelId ? { ...p, ...patch } : p)) : cur;
  const run = async () => {
    await globalMutate(
      "/panels",
      async (cur?: PanelRow[]) => {
        await write();
        return apply(cur);
      },
      {
        // Patch the DISPLAYED data, not the committed snapshot — the
        // displayed value carries any still-pending optimistic state.
        optimisticData: (cur?: PanelRow[], displayed?: PanelRow[]) =>
          apply(displayed ?? cur) ?? [],
        rollbackOnError: true,
        // The realtime echo revalidates with the authoritative row.
        revalidate: false,
      },
    );
  };
  const result = panelWriteChain.then(run, run);
  // The chain itself must never reject, or one failed write would
  // poison every later mutation.
  panelWriteChain = result.catch(() => {});
  return result;
};

export const panels = {
  get: {
    call: async () => {
      const { data, error } = await supabase
        .from("panels")
        .select("*")
        .order("name", { ascending: true })
        .throwOnError();
      if (data === null || error) throw error;
      return data;
    },
    useSWR: () => useSWRFactory("/panels", panels.get.call),
  },

  setMode: {
    call: async (
      panelId: string,
      mode: PanelMode,
      modeConfig: Record<string, unknown>,
    ) => {
      const last_updated = new Date().toISOString();
      // Write-through cache of the last config actually written per
      // panel:mode, so ModeSwitcher restores the freshest value (the
      // SWR snapshot lags by debounce + RTT + echo). Stamped with the
      // same timestamp the row gets, so the cache's newest-wins
      // arbitration agrees with last_updated.
      rememberModeConfig(panelId, mode, modeConfig, Date.parse(last_updated));
      await patchPanelOptimistic(
        panelId,
        {
          mode,
          mode_config:
            modeConfig as Database["public"]["Tables"]["panels"]["Row"]["mode_config"],
          last_updated,
        },
        async () => {
          await supabase
            .from("panels")
            .update({
              mode,
              mode_config:
                modeConfig as Database["public"]["Tables"]["panels"]["Update"]["mode_config"],
              last_updated,
            })
            .eq("id", panelId)
            .throwOnError();
        },
      );
    },
  },

  /**
   * Update ONLY mode_config — and only while the panel is still in
   * `mode`. Used by the debounced composer-config path: a late flush
   * after the user has already switched modes becomes a silent no-op
   * (zero-row UPDATE) instead of yanking the panel back to the old
   * mode, which is exactly what `setMode` from a stale closure did.
   */
  setModeConfig: {
    call: async (
      panelId: string,
      mode: PanelMode,
      modeConfig: Record<string, unknown>,
    ) => {
      const last_updated = new Date().toISOString();
      rememberModeConfig(panelId, mode, modeConfig, Date.parse(last_updated));
      await supabase
        .from("panels")
        .update({
          mode_config:
            modeConfig as Database["public"]["Tables"]["panels"]["Update"]["mode_config"],
          last_updated,
        })
        .eq("id", panelId)
        .eq("mode", mode)
        .throwOnError();
      // Patch the cache only after the guarded write succeeds — we
      // can't know client-side whether the mode guard matched. An
      // unpopulated cache is left alone (don't fabricate a fleet).
      void globalMutate(
        "/panels",
        (cur?: PanelRow[]) =>
          cur
            ? cur.map((p) =>
                p.id === panelId && p.mode === mode
                  ? {
                      ...p,
                      mode_config:
                        modeConfig as Database["public"]["Tables"]["panels"]["Row"]["mode_config"],
                      last_updated,
                    }
                  : p,
              )
            : cur,
        { revalidate: false },
      );
    },
  },

  setPaused: {
    call: async (panelId: string, isPaused: boolean) => {
      const last_updated = new Date().toISOString();
      await patchPanelOptimistic(
        panelId,
        { is_paused: isPaused, last_updated },
        async () => {
          await supabase
            .from("panels")
            .update({ is_paused: isPaused, last_updated })
            .eq("id", panelId)
            .throwOnError();
        },
      );
    },
  },

  setOff: {
    call: async (panelId: string, isOff: boolean) => {
      const last_updated = new Date().toISOString();
      await patchPanelOptimistic(
        panelId,
        { is_off: isOff, last_updated },
        async () => {
          await supabase
            .from("panels")
            .update({ is_off: isOff, last_updated })
            .eq("id", panelId)
            .throwOnError();
        },
      );
    },
  },

  setBrightness: {
    call: async (panelId: string, brightness: number) => {
      const clamped = Math.max(0, Math.min(1, brightness));
      const last_updated = new Date().toISOString();
      await patchPanelOptimistic(
        panelId,
        { brightness: clamped, last_updated },
        async () => {
          await supabase
            .from("panels")
            .update({ brightness: clamped, last_updated })
            .eq("id", panelId)
            .throwOnError();
        },
      );
    },
  },
};

export const entries = {
  get: {
    call: async (panelId: string) => ({
      entries: await getEntries(panelId),
    }),
    useSWR: (panelId: string) =>
      useSWRFactory(panelId ? `/entries/${panelId}` : null, () =>
        entries.get.call(panelId),
      ),
  },

  // All three mutations update the `/entries/${panelId}` SWR cache
  // optimistically and roll back on error, so callers just `await`
  // and surface a thrown error — no manual `mutate` needed. The
  // updater performs the write then returns the authoritative list.

  add: {
    call: async (panelId: string, entry: TextEntry) => {
      const key = entriesKey(panelId);
      // Client-generated id: the optimistic row carries the REAL id the
      // insert will persist, so a drag-reorder that settles while the
      // add is still in flight sends valid uuids (a fake placeholder id
      // used to fail the whole reorder against the uuid PK).
      const id = crypto.randomUUID();
      // The driver renders entries in ascending `order`; lowest order
      // shows at the top. min(existing)-1 is atomic (no row shifting)
      // and self-heals when a reorder rewrites everyone to 0..N-1.
      const optimisticRow: TextEntryItem = {
        id,
        panel_id: panelId,
        created_at: new Date().toISOString(),
        order: Number.NEGATIVE_INFINITY,
        data: entry,
      } as TextEntryItem;
      await globalMutate(
        key,
        async (current?: EntriesCache): Promise<EntriesCache> => {
          const existing = current?.entries ?? (await getEntries(panelId));
          const minOrder = existing.length
            ? Math.min(...existing.map((e) => e.order))
            : 0;
          await Promise.all([
            supabase
              .from("entries")
              .insert({ id, panel_id: panelId, data: entry, order: minOrder - 1 })
              .throwOnError(),
            updatePanelLastUpdated(panelId),
          ]);
          return { entries: await getEntries(panelId) };
        },
        {
          optimisticData: (current?: EntriesCache): EntriesCache => ({
            entries: [optimisticRow, ...(current?.entries ?? [])],
          }),
          rollbackOnError: true,
          revalidate: false,
        },
      );
    },
  },

  delete: {
    call: async (panelId: string, entryId: string) => {
      const key = entriesKey(panelId);
      await globalMutate(
        key,
        async (current?: EntriesCache): Promise<EntriesCache> => {
          await Promise.all([
            supabase
              .from("entries")
              .delete()
              .eq("id", entryId)
              .eq("panel_id", panelId)
              .throwOnError(),
            updatePanelLastUpdated(panelId),
          ]);
          const base = current?.entries ?? (await getEntries(panelId));
          return { entries: base.filter((e) => e.id !== entryId) };
        },
        {
          optimisticData: (current?: EntriesCache): EntriesCache => ({
            entries: (current?.entries ?? []).filter((e) => e.id !== entryId),
          }),
          rollbackOnError: true,
          revalidate: false,
        },
      );
    },
  },

  /**
   * Replace the order of every entry with positions derived from
   * `orderedIds`. Parallel UPDATEs — the driver re-pulls all entries
   * on `last_updated` change so a partial race self-heals next poll.
   */
  reorder: {
    call: async (panelId: string, orderedIds: string[]) => {
      const key = entriesKey(panelId);
      await globalMutate(
        key,
        async (current?: EntriesCache): Promise<EntriesCache> => {
          await Promise.all([
            ...orderedIds.map((id, order) =>
              supabase
                .from("entries")
                .update({ order })
                .eq("id", id)
                .eq("panel_id", panelId)
                .throwOnError(),
            ),
            updatePanelLastUpdated(panelId),
          ]);
          void current;
          return { entries: await getEntries(panelId) };
        },
        {
          optimisticData: (current?: EntriesCache): EntriesCache => {
            const byId = new Map((current?.entries ?? []).map((e) => [e.id, e]));
            return {
              entries: orderedIds
                .map((id, order) => {
                  const row = byId.get(id);
                  return row ? { ...row, order } : null;
                })
                .filter((e): e is TextEntryItem => e !== null),
            };
          },
          rollbackOnError: true,
          revalidate: false,
        },
      );
    },
  },

  scroll: {
    get: {
      call: async (panelId: string) => ({
        scroll: (await getPanel(panelId)).scroll,
      }),
      useSWR: (panelId: string) =>
        useSWRFactory(panelId ? `/entries/scroll/${panelId}` : null, () =>
          entries.scroll.get.call(panelId),
        ),
    },
  },
};
