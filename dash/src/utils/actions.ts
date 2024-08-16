import { createClient } from "@supabase/supabase-js";
import useSWR from "swr";

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

type TypedEntry = Omit<
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
  return data as TypedEntry[];
};

const useSWRFactory = <Result>(
  key: string,
  func: () => Promise<Result>,
  { refreshInterval = 500 }: { refreshInterval?: number } = {},
) =>
  useSWR(key, func, {
    refreshInterval,
  });

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

export const health = {
  get: {
    call: async (panelId: string) => {
      const panel = await getPanel(panelId);
      const has_right_id = panel.id === panelId;
      const has_been_seen_recently =
        Date.now() - new Date(panel.last_seen).getTime() < 10000;
      return { is_healthy: has_right_id && has_been_seen_recently };
    },
    useSWR: (panelId: string) =>
      useSWRFactory(`/health/${panelId}`, () => health.get.call(panelId)),
  },
};

export const pause = {
  get: {
    call: async (panelId: string) => ({
      is_paused: (await getPanel(panelId)).is_paused,
    }),
    useSWR: (panelId: string) =>
      useSWRFactory(`/pause/${panelId}`, () => pause.get.call(panelId)),
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
      entries: (await getEntries(panelId)).map((entry) => entry.data),
    }),
    useSWR: (panelId: string) =>
      useSWRFactory(`/entries/${panelId}`, () => entries.get.call(panelId)),
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
        useSWRFactory(`/entries/scroll/${panelId}`, () =>
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
      useSWRFactory(`/flash/${panelId}`, () => flash.get.call(panelId)),
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
