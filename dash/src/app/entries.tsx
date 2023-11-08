import useSWR from "swr";
import { z } from "zod";

import { constructFetcherWithSchema } from "@/utils/fetcher";
import { Spinner, Table, Tooltip } from "flowbite-react";
import { HiOutlineExclamationCircle, HiOutlineXCircle } from "react-icons/hi2";

const SCROLL_CONTEXT_SIZE = 7;

const Entry = ({ text, shown: isShown }: { text: string; shown: boolean }) => (
  <Table.Row className={isShown ? "bg-blue-50" : "bg-white"}>
    <Table.Cell className="whitespace-nowrap font-medium text-gray-900">
      {text}
    </Table.Cell>
  </Table.Row>
);

const EntriesTable = () => {
  const entriesData = useSWR(
    "/entries",
    constructFetcherWithSchema(
      z.object({
        entries: z
          .object({
            text: z.string(),
          })
          .array(),
      }),
    ),
    { refreshInterval: 1000 },
  );
  const scrollData = useSWR(
    "/entries/scroll",
    constructFetcherWithSchema(z.object({ scroll: z.number() })),
    {
      refreshInterval: 1000,
    },
  );

  if (entriesData.isLoading) {
    return (
      <Tooltip theme={{ target: "w-full h-full" }} content="Loading entries...">
        <div className="flex h-96 w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-lg bg-gray-50">
          <Spinner className="h-12 w-12" />
          <p className="text-sm text-gray-300">Loading entries...</p>
        </div>
      </Tooltip>
    );
  }

  if (entriesData.error || !entriesData.data) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-lg bg-gray-50">
        <HiOutlineExclamationCircle className="h-12 w-12 text-gray-300" />
        <p className="text-sm text-gray-300">Failed to load entries.</p>
      </div>
    );
  }

  return (
    <Table
      theme={{
        root: {
          shadow: "",
          wrapper: "w-full rounded-lg overflow-hidden",
        },
      }}
    >
      <Table.Head>
        <Table.HeadCell>Entry text</Table.HeadCell>
      </Table.Head>
      {entriesData.data.entries.length === 0 ? (
        <Table.Body className="flex h-96 w-full flex-col items-center justify-center gap-2">
          <HiOutlineXCircle className="h-12 w-12 text-gray-300" />
          <p className="text-sm text-gray-300">No entries, yet.</p>
        </Table.Body>
      ) : (
        <Table.Body className="flex max-h-[48rem] w-full flex-col divide-y overflow-y-auto">
          {entriesData.data.entries.map((entry, i) => {
            const scroll = scrollData.data?.scroll;
            const isShown =
              scroll !== undefined &&
              i >= scroll &&
              i < scroll + SCROLL_CONTEXT_SIZE;

            return (
              <Entry key={i + entry.text} text={entry.text} shown={isShown} />
            );
          })}
        </Table.Body>
      )}
    </Table>
  );
};

const Entries = () => {
  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-4">
      <h2 className="border-b border-gray-300 pb-2 text-xs text-gray-500">
        Entries
      </h2>
      <EntriesTable />
    </div>
  );
};

export default Entries;
