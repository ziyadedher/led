import cx from "classnames";
import { Spinner, Table } from "flowbite-react";
import {
  HiOutlineArrowDown,
  HiOutlineArrowUp,
  HiOutlineExclamationCircle,
  HiOutlineXCircle,
  HiOutlineXMark,
} from "react-icons/hi2";

import { entries } from "@/utils/actions";

const SCROLL_CONTEXT_SIZE = 7;

const EntriesTable = () => {
  const entriesData = entries.get.useSWR();
  const scrollData = entries.scroll.get.useSWR();

  if (entriesData.isLoading) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-lg bg-gray-50">
        <Spinner className="h-10 w-10 text-gray-300" />
        <p className="text-base text-gray-300">Loading entries...</p>
      </div>
    );
  }

  if (entriesData.error || !entriesData.data) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-lg bg-gray-50">
        <HiOutlineExclamationCircle className="h-12 w-12 text-gray-300" />
        <p className="text-base text-gray-300">Failed to load entries.</p>
      </div>
    );
  }

  if (entriesData.data.entries.length === 0) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-lg bg-gray-50">
        <HiOutlineXCircle className="h-12 w-12 text-gray-300" />
        <p className="text-base text-gray-300">No entries, yet.</p>
      </div>
    );
  } else {
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
        <Table.Body className="flex max-h-[48rem] w-full flex-col divide-y overflow-y-auto">
          {entriesData.data.entries.map((entry, i) => {
            const scroll = scrollData.data?.scroll;
            const isShown =
              scroll !== undefined &&
              i >= scroll &&
              i < scroll + SCROLL_CONTEXT_SIZE;

            return (
              <Table.Row
                key={i + entry.text}
                className={isShown ? "bg-blue-50" : "bg-white"}
              >
                <Table.Cell className="flex flex-row items-center whitespace-nowrap font-medium text-gray-900 hover:shadow-inner">
                  <span className="mr-4 flex flex-row gap-1 text-gray-400">
                    <button
                      className={cx(
                        "hover:text-gray-600",
                        i === 0 ? "invisible" : "",
                      )}
                      onClick={async () => {
                        await entries.order.patch.call(i, "Up");
                        const new_entries =
                          entriesData.data === undefined
                            ? []
                            : entriesData.data.entries;
                        new_entries[i] = new_entries.splice(
                          i - 1,
                          1,
                          new_entries[i],
                        )[0];
                        await entriesData.mutate({ entries: new_entries });
                      }}
                    >
                      <HiOutlineArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      className={cx(
                        "hover:text-gray-600",
                        i + 1 === entriesData.data?.entries.length
                          ? "invisible"
                          : "",
                      )}
                      onClick={async () => {
                        await entries.order.patch.call(i, "Down");
                        const new_entries =
                          entriesData.data === undefined
                            ? []
                            : entriesData.data.entries;
                        new_entries[i] = new_entries.splice(
                          i + 1,
                          1,
                          new_entries[i],
                        )[0];
                        await entriesData.mutate({ entries: new_entries });
                      }}
                    >
                      <HiOutlineArrowDown className="h-4 w-4" />
                    </button>
                  </span>
                  <span className="flex-grow text-ellipsis">{entry.text}</span>
                  <button
                    className="ml-4 text-gray-400 hover:text-gray-600"
                    onClick={async () => {
                      await entries.delete.call(i);
                      const remaining_entries =
                        entriesData.data === undefined
                          ? []
                          : entriesData.data.entries.filter((_, j) => j !== i);
                      await entriesData.mutate({ entries: remaining_entries });
                    }}
                  >
                    <HiOutlineXMark className="h-4 w-4" />
                  </button>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    );
  }
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
