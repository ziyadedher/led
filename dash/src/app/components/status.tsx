import { Badge, Tooltip } from "flowbite-react";
import {
  HiMiniCheck,
  HiMiniClock,
  HiMiniExclamationCircle,
  HiMiniExclamationTriangle,
} from "react-icons/hi2";

import { health } from "@/utils/actions";

const Status = () => {
  const { data: status, error, isLoading } = health.get.useSWR();

  if (isLoading)
    return (
      <Tooltip content="Loading the health of the LED server...">
        <Badge color="gray" icon={HiMiniClock} className="px-3">
          Loading...
        </Badge>
      </Tooltip>
    );

  if (error || !status)
    return (
      <Tooltip
        content={`Failed to load the health of the LED server, it probably won't work.`}
      >
        <Badge color="failure" icon={HiMiniExclamationCircle} className="px-3">
          Error
        </Badge>
      </Tooltip>
    );

  if (!status.is_healthy)
    return (
      <Tooltip content="The LED server is not healthy, it probably won't work.">
        <Badge
          color="warning"
          icon={HiMiniExclamationTriangle}
          className="px-3"
        >
          Unhealthy
        </Badge>
      </Tooltip>
    );

  return (
    <Tooltip content="The LED server is healthy.">
      <Badge color="success" icon={HiMiniCheck} className="px-3">
        Healthy
      </Badge>
    </Tooltip>
  );
};

export default Status;
