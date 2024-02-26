import { createClient } from "@supabase/supabase-js";
import useSWR from "swr";

import { Database } from "@/types/supabase";


const PANEL_ID = "75097deb-6b35-4db2-a49e-ad638de4256c";


type FlashOptions = {
  is_active: boolean;
  on_steps: number;
  total_steps: number;
}

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
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);


const getPanel = async (id: string) => {
  const { data, error } = await supabase.from("panels").select("*").eq("id", id).maybeSingle().throwOnError();
  if (data === null || error) {
    throw error;
  }
  return data;
}

type TypedEntry = Omit<Database["public"]["Tables"]["entries"]["Row"], "data"> & { data: TextEntry };

const getEntries = async (panel_id: string) => {
  const { data, error } = await supabase.from("entries").select("*").eq("panel_id", panel_id).order("order", { ascending: true }).throwOnError();
  if (data === null || error) {
    throw error;
  }
  return data as TypedEntry[];
}

const useSWRFactory = <Result>(key: string, func: () => Promise<Result>, { refreshInterval = 500 }: { refreshInterval?: number } = {}) => useSWR(key, func, {
  refreshInterval,
});

export const health = {
  get: {
    call: async () => {
      const panel = await getPanel(PANEL_ID);
      const has_right_id = panel.id === PANEL_ID;
      const has_been_seen_recently = Date.now() - new Date(panel.last_seen).getTime() < 10000;
      return { is_healthy: has_right_id && has_been_seen_recently }
    },
    useSWR: () => useSWRFactory("/health", health.get.call),
  },
};

export const pause = {
  get: {
    call: async () => ({ is_paused: (await getPanel(PANEL_ID)).is_paused }),
    useSWR: () => useSWRFactory("/pause", pause.get.call),
  },

  set: {
    call: async (should_pause: boolean) =>
      await supabase.from("panels").update({ is_paused: should_pause }).eq("id", PANEL_ID).throwOnError(),
  },
};

export const entries = {
  get: {
    call: async () => ({ entries: (await getEntries(PANEL_ID)).map((entry) => entry.data) }),
    useSWR: () => useSWRFactory("/entries", entries.get.call),
  },

  add: {
    call: async (entry: TextEntry) => {
      const entries = await getEntries(PANEL_ID);
      await supabase.from("entries").insert({ panel_id: PANEL_ID, data: entry, order: entries.length }).throwOnError()
    },
  },

  order: {
    patch: {
      call: async (entry: number, direction: "Up" | "Down") => {
        const order = entry;
        const replaced_order = direction === "Up" ? order - 1 : order + 1;
        const entries = await getEntries(PANEL_ID);

        const entryToMove = entries.find((entry) => entry.order === order);
        const replacedEntry = entries.find((entry) => entry.order === replaced_order);
        if (entryToMove === undefined || replacedEntry === undefined) {
          throw new Error("Entry not found");
        }

        await supabase.from("entries").update({ order: replaced_order }).eq("id", entryToMove.id).throwOnError();
        await supabase.from("entries").update({ order }).eq("id", replacedEntry.id).throwOnError();
      },
    },
  },

  scroll: {
    get: {
      call: async () => ({ scroll: (await getPanel(PANEL_ID)).scroll }),
      useSWR: () => useSWRFactory("/entries/scroll", entries.scroll.get.call),
    },

    post: {
      call: async (direction: "Up" | "Down") => {
        const scroll = (await getPanel(PANEL_ID)).scroll;
        const newScroll = direction === "Up" ? scroll - 1 : scroll + 1;
        await supabase.from("panels").update({ scroll: newScroll }).eq("id", PANEL_ID).throwOnError();
      },
    },
  },
};

export const flash = {
  get: {
    call: async () => (await getPanel(PANEL_ID)).flash as FlashOptions,
    useSWR: () => useSWRFactory("/flash", flash.get.call),
  },

  post: {
    call: async (isActive: boolean) => {
      const flash = {
        is_active: isActive,
        on_steps: 10,
        total_steps: 50,
      }
      await supabase.from("panels").update({ flash }).eq("id", PANEL_ID).throwOnError();
    },
  },
};
