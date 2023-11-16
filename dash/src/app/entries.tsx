import { Spinner, Table } from "flowbite-react";
import { HiOutlineExclamationCircle, HiOutlineXCircle } from "react-icons/hi2";

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
                <Table.Cell className="whitespace-nowrap font-medium text-gray-900">
                  {entry.text}
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
