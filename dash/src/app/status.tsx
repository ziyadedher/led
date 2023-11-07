import { Badge, Tooltip } from "flowbite-react";
import {
  HiCheck,
  HiClock,
  HiExclamationCircle,
  HiExclamationTriangle,
} from "react-icons/hi2";
import useSWR from "swr";

const fetcher = (key: string) =>
  fetch(`http://192.168.0.190:3001${key}`).then((res) => res.json());

const Status = () => {
  const { data, error, isLoading } = useSWR("/health", fetcher, {
    refreshInterval: 1000,
  });

  if (isLoading)
    return (
      <Tooltip content="Loading the health of the LED server...">
        <Badge color="gray" icon={HiClock}>
          Loading...
        </Badge>
      </Tooltip>
    );

  if (error)
    return (
      <Tooltip
        content={`Failed to load the health of the LED server: ${JSON.stringify(
          error,
        )}`}
      >
        <Badge color="failure" icon={HiExclamationCircle}>
          Error
        </Badge>
      </Tooltip>
    );

  if (!data || !data.is_healthy)
    return (
      <Tooltip content="The LED server is not healthy.">
        <Badge color="warning" icon={HiExclamationTriangle}>
          Unhealthy
        </Badge>
      </Tooltip>
    );

  return (
    <Tooltip content="The LED server is healthy.">
      <Badge color="success" icon={HiCheck}>
        Healthy
      </Badge>
    </Tooltip>
  );
};

export default Status;
