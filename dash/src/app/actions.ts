"use server";

import { z } from "zod";

type TextEntryOptions = {
  color:
    | { Rgb: { r: number; g: number; b: number } }
    | { Rainbow: { is_per_letter: boolean; speed: number } };
  marquee: { speed: number };
};

type TextEntry = {
  text: string;
  options: TextEntryOptions;
};

const driverCall = async (
  key: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
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
      `HTTP Error: ${res.status} ${res.statusText} ${await res.text()}`,
    );
  }

  return res;
};

const checkHealth = async () => {
  const schema = z.object({
    is_healthy: z.boolean(),
  });

  const res = await driverCall("/health", "GET");

  return (await schema.parseAsync(res.json())).is_healthy;
};

const getPause = async () => {
  const schema = z.object({
    is_paused: z.boolean(),
  });

  const res = await driverCall("/pause", "GET");

  return (await schema.parseAsync(res.json())).is_paused;
};

const setPause = async (should_pause: boolean) => {
  await driverCall("/pause", "PUT", { should_pause });
};

const getEntries = async () => {
  const schema = z
    .object({
      text: z.string(),
    })
    .array();

  const res = await driverCall("/entries", "GET");

  return await schema.parseAsync(res.json());
};

const addEntry = async (entry: TextEntry) => {
  await driverCall("/entries", "POST", { entries: [entry] });
};

const clearEntries = async () => {
  driverCall("/entries", "DELETE");
};

const getEntriesScroll = async () => {
  const schema = z.object({
    scroll: z.number(),
  });

  const res = await driverCall("/entries/scroll", "GET");

  return (await schema.parseAsync(res.json())).scroll;
};

const scrollEntrySelection = async (direction: "Up" | "Down") => {
  await driverCall("/entries/scroll", "POST", {
    direction,
  });
};

export {
  checkHealth,
  getPause,
  setPause,
  getEntries,
  addEntry,
  clearEntries,
  getEntriesScroll,
  scrollEntrySelection,
};
export type { TextEntry };
