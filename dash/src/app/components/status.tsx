import {
  CheckIcon,
  ClockIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/16/solid";

import { Badge } from "@/components/badge";
import { health } from "@/utils/actions";

const StatusBadge = ({
  color,
  title,
  icon: Icon,
  children,
}: {
  color: "zinc" | "red" | "amber" | "green";
  title: string;
  icon: React.ComponentType<React.ComponentProps<"svg">>;
  children: React.ReactNode;
}) => (
  <Badge className="flex flex-row items-center" color={color} title={title}>
    <Icon className="h-3" />
    {children}
  </Badge>
);

const Status = () => {
  const { data: status, error, isLoading } = health.get.useSWR();

  if (isLoading)
    return (
      <StatusBadge
        color="zinc"
        title="Loading the health of the LED server..."
        icon={ClockIcon}
      >
        Loading...
      </StatusBadge>
    );

  if (error || !status)
    return (
      <StatusBadge
        color="red"
        title="Failed to load the health of the LED server, it probably won't work."
        icon={ExclamationCircleIcon}
      >
        Error
      </StatusBadge>
    );

  if (!status.is_healthy)
    return (
      <StatusBadge
        color="amber"
        title="The LED server is not healthy, it probably won't work."
        icon={ExclamationTriangleIcon}
      >
        Unhealthy
      </StatusBadge>
    );

  return (
    <StatusBadge
      color="green"
      title="The LED server is healthy."
      icon={CheckIcon}
    >
      Healthy
    </StatusBadge>
  );
};

export default Status;
