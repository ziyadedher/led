import { Button, Spinner, Tooltip } from "flowbite-react";
import {
  HiMiniArrowDown,
  HiMiniArrowUp,
  HiMiniPaperAirplane,
  HiPause,
  HiPlay,
  HiPlayPause,
} from "react-icons/hi2";
import { PiLightning, PiLightningSlash } from "react-icons/pi";
import { useMemo } from "react";

import { entries, pause, flash } from "@/utils/actions";

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
        content={`Scroll entry selection ${direction.toLowerCase()} (i.e. show ${direction === "Up" ? "older" : "newer"
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
        content={`Cannot scroll entry selection ${direction.toLowerCase()} (i.e. show ${direction === "Up" ? "older" : "newer"
          } entries), likely due to the scroll being at the limit.`}
      >
        <Button disabled>{arrow}</Button>
      </Tooltip>
    );
  }
};

const FlashButton = () => {
  const { mutate: mutateFlash, data: flashData } = flash.get.useSWR();

  if (flashData === undefined) {
    return (
      <Tooltip content="Loading the flash status of the LED server...">
        <Button color="blue" disabled>
          <Spinner className="mr-2 h-6 w-6" />
          loading flash...
        </Button>
      </Tooltip>
    );
  }

  if (flashData.is_active) {
    return (
      <Tooltip content="The LED server is currently flashing, please wait before flashing again. There is a limit on how often you can flash.">
        <Button color="blue" disabled>
          <PiLightningSlash className="mr-2 h-6 w-6" />
          Flashing!
        </Button>
      </Tooltip>
    );
  }

  return (
    <Tooltip content="Flash the LED server (i.e. make it blink to get attention).">
      <Button
        color="blue"
        onClick={async () => {
          await flash.post.call(true);
          await mutateFlash({ ...flashData, is_active: true, });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await flash.post.call(false);
          await mutateFlash({ ...flashData, is_active: false, });
        }}
      >
        <PiLightning className="mr-2 h-6 w-6" />
        Flash!!
      </Button>
    </Tooltip>
  );
};

const Controls = ({
  isSubmitable,
  handleSubmit,
}: {
  isSubmitable: boolean;
  handleSubmit: () => void;
}) => {
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
        </div>
        <div className="flex">
          <FlashButton />
        </div>
      </div>
    </div>
  );
};

export default Controls;
