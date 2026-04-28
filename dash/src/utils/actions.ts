import { createClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";

import { Database } from "@/types/supabase";

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

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const getPanel = async (id: string) => {
  const { data, error } = await supabase
    .from("panels")
    .select("*")
    .eq("id", id)
    .maybeSingle()
    .throwOnError();
  if (data === null || error) {
    throw error;
  }
  return data;
};

const getEntries = async (panel_id: string) => {
  const { data, error } = await supabase
    .from("entries")
    .select("*")
    .eq("panel_id", panel_id)
    .order("order", { ascending: true })
    .throwOnError();
  if (data === null || error) {
    throw error;
  }
  return data as TextEntryItem[];
};

const updatePanelLastUpdated = async (panelId: string) => {
  await supabase
    .from("panels")
    .update({ last_updated: new Date().toISOString() })
    .eq("id", panelId)
    .throwOnError();
};

// Realtime pushes invalidations to SWR, so the polling fallback only
// exists to recover from a missed websocket message and can be loose.
const FALLBACK_REFRESH_INTERVAL = 30_000;

const useSWRFactory = <Result>(
  key: string | null,
  func: () => Promise<Result>,
  { refreshInterval = FALLBACK_REFRESH_INTERVAL }: { refreshInterval?: number } = {},
) =>
  useSWR(key, func, {
    refreshInterval,
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

  useEffect(() => {
    const channel = supabase
      .channel("led-dash-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "panels" },
        (payload) => {
          mutate("/panels");
          const id =
            (payload.new as { id?: string })?.id ??
            (payload.old as { id?: string })?.id;
          if (id) mutate(`/entries/scroll/${id}`);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "entries" },
        (payload) => {
          const panelId =
            (payload.new as { panel_id?: string })?.panel_id ??
            (payload.old as { panel_id?: string })?.panel_id;
          if (panelId) mutate(`/entries/${panelId}`);
        },
      )
      .subscribe((s) => {
        if (s === "SUBSCRIBED") setStatus("live");
        else if (s === "CLOSED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT")
          setStatus("down");
        else setStatus("connecting");
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [mutate]);

  return status;
};

export type PanelMode = "text" | "clock";

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
      await supabase
        .from("panels")
        .update({
          mode,
          mode_config: modeConfig as Database["public"]["Tables"]["panels"]["Update"]["mode_config"],
          last_updated: new Date().toISOString(),
        })
        .eq("id", panelId)
        .throwOnError();
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

  add: {
    call: async (panelId: string, entry: TextEntry) => {
      // Insert at the top of the list. The driver renders entries in
      // ascending `order`, so the lowest order ends up at the top of
      // the matrix. We pick min(existing) - 1, which is atomic (no
      // shifting other rows) and self-heals when a reorder rewrites
      // everyone to 0..N-1.
      const existing = await getEntries(panelId);
      const minOrder = existing.length > 0
        ? Math.min(...existing.map((e) => e.order))
        : 0;
      await supabase
        .from("entries")
        .insert({ panel_id: panelId, data: entry, order: minOrder - 1 })
        .throwOnError();
      await updatePanelLastUpdated(panelId);
    },
  },

  delete: {
    call: async (panelId: string, entryId: string) => {
      await supabase
        .from("entries")
        .delete()
        .eq("id", entryId)
        .eq("panel_id", panelId)
        .throwOnError();
      await updatePanelLastUpdated(panelId);
    },
  },

  /**
   * Replace the order of every entry on the panel with positions
   * derived from `orderedIds`. Issued as parallel UPDATEs — the
   * driver's poll re-pulls all entries on `last_updated` change so
   * partial application during a race is self-healing on the next
   * refresh cycle.
   */
  reorder: {
    call: async (panelId: string, orderedIds: string[]) => {
      await Promise.all(
        orderedIds.map((id, order) =>
          supabase
            .from("entries")
            .update({ order })
            .eq("id", id)
            .eq("panel_id", panelId)
            .throwOnError(),
        ),
      );
      await updatePanelLastUpdated(panelId);
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
