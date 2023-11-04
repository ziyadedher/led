"use server";

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

const addEntry = async (entry: TextEntry) => {
  const res = await fetch("http://127.0.0.1:3001/entries", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ entries: [entry] }),
  });

  console.log(res.status, res.statusText, await res.text());
};

const clearEntries = async () => {
  const res = await fetch("http://127.0.0.1:3001/entries", {
    method: "DELETE",
    cache: "no-store",
  });

  console.log(res.status, res.statusText, await res.text());
};

export { addEntry, clearEntries };
export type { TextEntry };
