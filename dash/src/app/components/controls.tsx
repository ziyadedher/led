import {
  ArrowDownIcon,
  ArrowUpIcon,
  PaperAirplaneIcon,
  PauseIcon,
  PlayIcon,
  PlayPauseIcon,
  BoltIcon,
  BoltSlashIcon,
} from "@heroicons/react/16/solid";
import { useMemo } from "react";

import { Button } from "@/components/button";

import { entries, pause, flash } from "@/utils/actions";

const PauseButton = () => {
  const { data, error, isLoading, mutate } = pause.get.useSWR();

  if (isLoading) {
    return <Button disabled>?</Button>;
  }

  if (error || !data) {
    return (
      <Button disabled>
        <PlayPauseIcon className="h-6 w-6" />
      </Button>
    );
  }

  if (data.is_paused) {
    return (
      <Button
        onClick={async () => {
          await pause.set.call(false);
          await mutate({ is_paused: false });
        }}
      >
        <PlayIcon className="h-6 w-6" />
      </Button>
    );
  } else {
    return (
      <Button
        onClick={async () => {
          await pause.set.call(true);
          await mutate({ is_paused: true });
        }}
      >
        <PauseIcon className="h-6 w-6" />
      </Button>
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
        <ArrowUpIcon className="h-6 w-6" />
      ) : (
        <ArrowDownIcon className="h-6 w-6" />
      ),
    [direction],
  );

  if (isLoading) {
    return <Button disabled>?</Button>;
  }

  if (error || !data) {
    return <Button disabled>{arrow}</Button>;
  }

  if (canScroll) {
    return (
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
    );
  } else {
    return <Button disabled>{arrow}</Button>;
  }
};

const FlashButton = () => {
  const { mutate: mutateFlash, data: flashData } = flash.get.useSWR();

  if (flashData === undefined) {
    return (
      <Button color="blue" disabled>
        Loading...
      </Button>
    );
  }

  if (flashData.is_active) {
    return (
      <Button color="blue" disabled>
        <BoltSlashIcon className="mr-2 h-6 w-6" />
        Flashing!
      </Button>
    );
  }

  return (
    <Button
      color="blue"
      onClick={async () => {
        await flash.post.call(true);
        await mutateFlash({ ...flashData, is_active: true });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await flash.post.call(false);
        await mutateFlash({ ...flashData, is_active: false });
      }}
    >
      <BoltIcon className="mr-2 h-6 w-6" />
      Flash
    </Button>
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
      <div className="flex flex-col items-center gap-2">
        <div className="flex flex-row gap-2">
          <ScrollButton direction="Down" />
          <PauseButton />
          <ScrollButton direction="Up" />
        </div>
        <div className="flex flex-row gap-2">
          <Button
            color="white"
            disabled={!isSubmitable}
            onClick={() => {
              handleSubmit();
            }}
          >
            <PaperAirplaneIcon className="mr-2 h-5 w-5" />
            Submit
          </Button>
          <FlashButton />
        </div>
      </div>
    </div>
  );
};

export default Controls;
