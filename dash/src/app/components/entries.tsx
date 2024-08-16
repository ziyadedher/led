import {
  ArrowDownIcon,
  ArrowUpIcon,
  ExclamationCircleIcon,
  XCircleIcon,
} from "@heroicons/react/16/solid";
import clsx from "clsx";
import { useContext } from "react";

import { entries } from "@/utils/actions";
import { Badge } from "@/components/badge";
import {
  Table,
  TableHead,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/table";
import { Text } from "@/components/text";
import { PanelContext } from "@/app/context";

const SCROLL_CONTEXT_SIZE = 7;

const EntriesTable = () => {
  const panelId = useContext(PanelContext);
  const entriesData = entries.get.useSWR(panelId);
  const scrollData = entries.scroll.get.useSWR(panelId);

  if (entriesData.isLoading) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-lg bg-gray-50">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600"></div>
        <Text className="text-gray-300">Loading entries...</Text>
      </div>
    );
  }

  if (entriesData.error || !entriesData.data) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-lg bg-gray-50">
        <ExclamationCircleIcon className="h-12 w-12 text-gray-300" />
        <Text className="text-gray-300">Failed to load entries.</Text>
      </div>
    );
  }

  const entriesCount = entriesData.data.entries.length;

  if (entriesData.data.entries.length === 0) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-lg bg-gray-50">
        <XCircleIcon className="h-12 w-12 text-gray-300" />
        <Text className="text-gray-300">No entries, yet.</Text>
      </div>
    );
  } else {
    return (
      <Table className="overflow-y-auto rounded-lg">
        <TableBody className="divide-y overflow-y-auto">
          {entriesData.data.entries.map((entry, i) => (
            <EntryTableRow
              key={i + entry.text}
              entry={entry}
              index={i}
              entriesData={entriesData}
              scrollData={scrollData}
              totalEntries={entriesCount}
              panelId={panelId}
            />
          ))}
        </TableBody>
      </Table>
    );
  }
};

const EntryTableRow = ({
  entry,
  index,
  entriesData,
  scrollData,
  totalEntries,
  panelId,
}: {
  entry: {
    text: string;
  };
  index: number;
  entriesData: ReturnType<typeof entries.get.useSWR>;
  scrollData: ReturnType<typeof entries.scroll.get.useSWR>;
  totalEntries: number;
  panelId: string;
}) => {
  const scroll = scrollData.data?.scroll;
  const isShown =
    scroll !== undefined &&
    index >= scroll &&
    index < scroll + SCROLL_CONTEXT_SIZE;

  return (
    <TableRow className={isShown ? "bg-blue-50" : "bg-white"}>
      <TableCell className="mx-2 flex flex-row items-center gap-4 whitespace-nowrap">
        <span className="flex flex-row gap-1 text-zinc-400">
          <button
            className={clsx(
              "hover:text-zinc-600",
              index === 0 ? "invisible" : "",
            )}
            onClick={async () => {
              await entries.order.patch.call(panelId, index, "Up");
              const new_entries =
                entriesData.data === undefined ? [] : entriesData.data.entries;
              new_entries[index] = new_entries.splice(
                index - 1,
                1,
                new_entries[index],
              )[0];
              await entriesData.mutate({ entries: new_entries });
            }}
          >
            <ArrowUpIcon className="h-4 w-4" />
          </button>
          <button
            className={clsx(
              "hover:text-zinc-600",
              index + 1 === totalEntries ? "invisible" : "",
            )}
            onClick={async () => {
              await entries.order.patch.call(panelId, index, "Down");
              const new_entries =
                entriesData.data === undefined ? [] : entriesData.data.entries;
              new_entries[index] = new_entries.splice(
                index + 1,
                1,
                new_entries[index],
              )[0];
              await entriesData.mutate({ entries: new_entries });
            }}
          >
            <ArrowDownIcon className="h-4 w-4" />
          </button>
        </span>
        <span
          className="w-0 flex-grow overflow-hidden text-ellipsis"
          title={entry.text}
        >
          {entry.text}
        </span>
        {isShown && (
          <Badge color="blue" className="ml-2">
            Visible
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
};

const Entries = () => {
  return (
    <div className="flex w-full max-w-4xl flex-col">
      <EntriesTable />
    </div>
  );
};

export default Entries;
