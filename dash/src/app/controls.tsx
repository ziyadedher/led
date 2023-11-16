import { Button, Spinner, Tooltip } from "flowbite-react";
import { useMemo } from "react";
import { useSWRConfig } from "swr";
import {
  HiMiniArrowDown,
  HiMiniArrowUp,
  HiMiniPaperAirplane,
  HiMiniTrash,
  HiPause,
  HiPlay,
  HiPlayPause,
} from "react-icons/hi2";

import { entries, pause } from "@/utils/actions";

const PauseButton = () => {
  const { data, error, isLoading, mutate } = pause.get.useSWR();

  if (isLoading) {
    return (
      <Tooltip content="Loading the pause status of the LED server...">
        <Button disabled>
          <Spinner className="h-6 w-6" />
        </Button>
      </Tooltip>
    );
  }

  if (error || !data) {
    return (
      <Tooltip content="Failed to load the pause status of the LED server, it probably won't work.">
        <Button disabled>
          <HiPlayPause className="h-6 w-6" />
        </Button>
      </Tooltip>
    );
  }

  if (data.is_paused) {
    return (
      <Tooltip content="Unpause all time-based effects (e.g. rainbow and marquee)">
        <Button
          onClick={async () => {
            await pause.set.call(false);
            await mutate({ is_paused: false });
          }}
        >
          <HiPlay className="h-6 w-6" />
        </Button>
      </Tooltip>
    );
  } else {
    return (
      <Tooltip content="Pause all time-based effects (e.g. rainbow and marquee)">
        <Button
          onClick={async () => {
            await pause.set.call(true);
            await mutate({ is_paused: true });
          }}
        >
          <HiPause className="h-6 w-6" />
        </Button>
      </Tooltip>
    );
  }
};

const ScrollButton = ({ direction }: { direction: "Up" | "Down" }) => {
  const { data, error, isLoading, mutate } = entries.scroll.get.useSWR();

  const entriesResults = entries.get.useSWR();
  const numEntries = useMemo(
    () => entriesResults.data?.entries.length ?? 0,
    [entriesResults.data],
  );

  const canScroll = useMemo(
    () =>
      data &&
      (direction === "Up" ? data.scroll !== 0 : data.scroll !== numEntries),
    [direction, numEntries, data],
  );

  const arrow = useMemo(
    () =>
      direction === "Up" ? (
        <HiMiniArrowUp className="h-6 w-6" />
      ) : (
        <HiMiniArrowDown className="h-6 w-6" />
      ),
    [direction],
  );

  if (isLoading) {
    return (
      <Tooltip content="Loading the scroll status of the LED server...">
        <Button disabled>
          <Spinner className="h-6 w-6" />
        </Button>
      </Tooltip>
    );
  }

  if (error || !data) {
    return (
      <Tooltip content="Failed to load the scroll status of the LED server, it probably won't work.">
        <Button disabled>{arrow}</Button>
      </Tooltip>
    );
  }

  if (canScroll) {
    return (
      <Tooltip
        content={`Scroll entry selection ${direction.toLowerCase()} (i.e. show ${
          direction === "Up" ? "older" : "newer"
        } entries)`}
      >
        <Button
          onClick={async () => {
            await entries.scroll.post.call(direction);
            await mutate({
              scroll: data.scroll + (direction === "Up" ? -1 : 1),
            });
          }}
        >
          {arrow}
        </Button>
      </Tooltip>
    );
  } else {
    return (
      <Tooltip
        content={`Cannot scroll entry selection ${direction.toLowerCase()} (i.e. show ${
          direction === "Up" ? "older" : "newer"
        } entries), likely due to the scroll being at the limit.`}
      >
        <Button disabled>{arrow}</Button>
      </Tooltip>
    );
  }
};

const Controls = ({
  isSubmitable,
  handleSubmit,
}: {
  isSubmitable: boolean;
  handleSubmit: () => void;
}) => {
  const { mutate } = useSWRConfig();

  return (
    <div className="flex flex-col items-center gap-4">
      <h2 className="border-b border-gray-300 pb-2 text-xs text-gray-500">
        Controls
      </h2>
      <div className="flex flex-col items-center gap-2">
        <div className="flex flex-row gap-2">
          <ScrollButton direction="Down" />
          <PauseButton />
          <ScrollButton direction="Up" />
        </div>
        <div className="flex flex-row gap-2">
          <Button
            color="gray"
            disabled={!isSubmitable}
            onClick={() => {
              handleSubmit();
            }}
          >
            <HiMiniPaperAirplane className="mr-2 h-5 w-5" />
            Submit
          </Button>
          <Button
            color="failure"
            onClick={async () => {
              await entries.clear.call();
              await mutate("/entries", { entries: [] });
              await mutate("/entries/scroll");
            }}
          >
            <HiMiniTrash className="mr-2 h-5 w-5" />
            Clear all entries
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Controls;
