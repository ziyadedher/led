import { createClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";

import { Database } from "@/types/supabase";

type FlashOptions = {
  is_active: boolean;
  on_steps: number;
  total_steps: number;
};

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

export type TextEntryItem = Omit<
  Database["public"]["Tables"]["entries"]["Row"],
  "data"
> & { data: TextEntry };

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

// Realtime subscriptions push invalidations to SWR, so the polling fallback
// only exists to recover from a missed websocket message and can be loose.
const FALLBACK_REFRESH_INTERVAL = 30_000;

const useSWRFactory = <Result>(
  key: string | null,
  func: () => Promise<Result>,
  { refreshInterval = FALLBACK_REFRESH_INTERVAL }: { refreshInterval?: number } = {},
) =>
  useSWR(key, func, {
    refreshInterval,
  });

/**
 * Subscribe to Postgres changes on the `panels` and `entries` tables and
 * trigger SWR revalidation for the affected keys. Mount once at the top of
 * the app.
 */
export type RealtimeStatus = "connecting" | "live" | "down";

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
          if (id) {
            mutate(`/pause/${id}`);
            mutate(`/flash/${id}`);
            mutate(`/entries/scroll/${id}`);
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
          }
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

const updatePanelLastUpdated = async (panelId: string) => {
  await supabase
    .from("panels")
    .update({ last_updated: new Date().toISOString() })
    .eq("id", panelId)
    .throwOnError();
};

export const panels = {
  get: {
    call: async () => {
      const { data, error } = await supabase
        .from("panels")
        .select("*")
        .order("name", { ascending: true })
        .throwOnError();
      if (data === null || error) {
        throw error;
      }
      return data;
    },
    useSWR: () => useSWRFactory("/panels", panels.get.call),
  },
};

export const pause = {
  get: {
    call: async (panelId: string) => ({
      is_paused: (await getPanel(panelId)).is_paused,
    }),
    useSWR: (panelId: string) =>
      useSWRFactory(panelId ? `/pause/${panelId}` : null, () =>
        pause.get.call(panelId),
      ),
  },

  set: {
    call: async (panelId: string, should_pause: boolean) => {
      await supabase
        .from("panels")
        .update({ is_paused: should_pause })
        .eq("id", panelId)
        .throwOnError();
      await updatePanelLastUpdated(panelId);
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
      const entries = await getEntries(panelId);
      await supabase
        .from("entries")
        .insert({ panel_id: panelId, data: entry, order: entries.length })
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

  order: {
    patch: {
      call: async (
        panelId: string,
        entry: number,
        direction: "Up" | "Down",
      ) => {
        const order = entry;
        const replaced_order = direction === "Up" ? order - 1 : order + 1;
        const entries = await getEntries(panelId);

        const entryToMove = entries.find((entry) => entry.order === order);
        const replacedEntry = entries.find(
          (entry) => entry.order === replaced_order,
        );
        if (entryToMove === undefined || replacedEntry === undefined) {
          throw new Error("Entry not found");
        }

        await supabase
          .from("entries")
          .update({ order: replaced_order })
          .eq("id", entryToMove.id)
          .throwOnError();
        await supabase
          .from("entries")
          .update({ order })
          .eq("id", replacedEntry.id)
          .throwOnError();
        await updatePanelLastUpdated(panelId);
      },
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

    post: {
      call: async (panelId: string, direction: "Up" | "Down") => {
        const scroll = (await getPanel(panelId)).scroll;
        const newScroll = direction === "Up" ? scroll - 1 : scroll + 1;
        await supabase
          .from("panels")
          .update({ scroll: newScroll })
          .eq("id", panelId)
          .throwOnError();
        await updatePanelLastUpdated(panelId);
      },
    },
  },
};

export const flash = {
  get: {
    call: async (panelId: string) =>
      (await getPanel(panelId)).flash as FlashOptions,
    useSWR: (panelId: string) =>
      useSWRFactory(panelId ? `/flash/${panelId}` : null, () =>
        flash.get.call(panelId),
      ),
  },

  post: {
    call: async (panelId: string, isActive: boolean) => {
      const flash = {
        is_active: isActive,
        on_steps: 10,
        total_steps: 50,
      };
      await supabase
        .from("panels")
        .update({ flash })
        .eq("id", panelId)
        .throwOnError();
      await updatePanelLastUpdated(panelId);
    },
  },
};
