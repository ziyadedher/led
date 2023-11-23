import useSWR from "swr";
import { z } from "zod";

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

const driverCall = async (
  key: string,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  json?: any,
) => {
  const res = await fetch(`https://driver.led.ziyadedher.com:9000${key}`, {
    method,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(json),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${method} ${key} with status ${
        res.status
      }: ${await res.text()}`,
    );
  }

  return res;
};

const constructDriverFetcherWithSchema =
  <Output>(schema: z.ZodSchema<Output>): ((key: string) => Promise<Output>) =>
  async (key: string) =>
    await schema.parseAsync(await (await driverCall(key, "GET")).json());

const useSWRForDriver = <Output>(
  key: string,
  schema: z.ZodSchema<Output>,
  refreshInterval: number = 500,
) =>
  useSWR(key, constructDriverFetcherWithSchema(schema), {
    refreshInterval,
  });

export const health = {
  get: {
    schema: z.object({
      is_healthy: z.boolean(),
    }),

    call: async () => {
      const res = await driverCall("/health", "GET");
      return await health.get.schema.parseAsync(await res.json());
    },

    useSWR: () => useSWRForDriver("/health", health.get.schema),
  },
};

export const pause = {
  get: {
    schema: z.object({
      is_paused: z.boolean(),
    }),

    call: async () => {
      const res = await driverCall("/pause", "GET");
      return await pause.get.schema.parseAsync(await res.json());
    },

    useSWR: () => useSWRForDriver("/pause", pause.get.schema),
  },

  set: {
    schema: z.object({
      is_paused: z.boolean(),
    }),

    call: async (should_pause: boolean) => {
      const res = await driverCall("/pause", "PUT", { should_pause });
      return await pause.set.schema.parseAsync(await res.json());
    },
  },
};

export const entries = {
  get: {
    schema: z.object({
      entries: z.array(z.object({ text: z.string() })),
    }),

    call: async () => {
      const res = await driverCall("/entries", "GET");
      return await entries.get.schema.parseAsync(await res.json());
    },

    useSWR: () => useSWRForDriver("/entries", entries.get.schema),
  },

  add: {
    schema: z.object({}),

    call: async (entry: TextEntry) => {
      const res = await driverCall("/entries", "POST", { entries: [entry] });
      return await entries.add.schema.parseAsync(await res.json());
    },
  },

  delete: {
    schema: z.object({
      num_removed: z.number(),
    }),

    call: async (choice: "All" | number) => {
      const json = typeof choice === "number" ? { Single: choice } : choice;
      const res = await driverCall("/entries", "DELETE", { choice: json });
      return await entries.delete.schema.parseAsync(await res.json());
    },
  },

  order: {
    patch: {
      schema: z.object({}),

      call: async (entry: number, direction: "Up" | "Down") => {
        const res = await driverCall("/entries/order", "PATCH", {
          entry,
          direction,
        });
        return await entries.order.patch.schema.parseAsync(await res.json());
      },
    },
  },

  scroll: {
    get: {
      schema: z.object({
        scroll: z.number(),
      }),

      call: async () => {
        const res = await driverCall("/entries/scroll", "GET");
        return await entries.scroll.get.schema.parseAsync(await res.json());
      },

      useSWR: () =>
        useSWRForDriver("/entries/scroll", entries.scroll.get.schema),
    },

    post: {
      schema: z.object({
        scroll: z.number(),
      }),

      call: async (direction: "Up" | "Down") => {
        const res = await driverCall("/entries/scroll", "POST", { direction });
        return await entries.scroll.post.schema.parseAsync(await res.json());
      },
    },
  },
};
