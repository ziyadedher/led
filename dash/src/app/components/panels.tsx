"use client";

import { useMemo } from "react";
import { ChevronDownIcon } from "@heroicons/react/20/solid";
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/16/solid";

import { Badge } from "@/components/badge";
import {
  Dropdown,
  DropdownButton,
  DropdownMenu,
  DropdownItem,
  DropdownLabel,
  DropdownDescription,
} from "@/components/dropdown";
import { panels, health } from "@/utils/actions";

const getPanelDescription = (panelName: string): string => {
  const descriptions: { [key: string]: string } = {
    alpha: "Little Raspberry Pi Zero panel.",
    beta: "Big Raspberry Pi 3 panel.",
  };
  return descriptions[panelName] || "No description available";
};

const PanelsDropdown = ({
  panelId,
  setPanelId,
}: {
  panelId: string;
  setPanelId: (id: string) => void;
}) => {
  const { data: panelsData, error } = panels.get.useSWR();
  const {
    data: status,
    error: statusError,
    isLoading,
  } = health.get.useSWR(panelId);

  const panelsList = useMemo(() => {
    if (error) {
      console.error("Error fetching panels:", error);
      return [];
    }
    return panelsData || [];
  }, [panelsData, error]);

  const selectedPanel = useMemo(
    () => panelsList.find((panel) => panel.id === panelId) || panelsList[0],
    [panelsList, panelId],
  );

  const getStatus = (): {
    icon: React.ComponentType<React.ComponentProps<"svg">>;
    color: "zinc" | "red" | "amber" | "green";
    title: string;
    text: string;
  } => {
    if (isLoading) {
      return {
        icon: ClockIcon,
        color: "zinc",
        title: "Loading the health of the LED server...",
        text: "Loading...",
      };
    }
    if (statusError || !status) {
      return {
        icon: ExclamationCircleIcon,
        color: "red",
        title:
          "Failed to load the health of the LED server, it probably won't work.",
        text: "Error",
      };
    }
    if (!status.is_healthy) {
      return {
        icon: ExclamationTriangleIcon,
        color: "amber",
        title: "The LED server is not healthy, it probably won't work.",
        text: "Unhealthy",
      };
    }
    return {
      icon: CheckCircleIcon,
      color: "green",
      title: "The LED server is healthy.",
      text: "Healthy",
    };
  };

  const { icon: Icon, color, title, text } = getStatus();
  return (
    <div className="flex flex-col items-center gap-2">
      <Badge color={color} className="flex flex-row items-center" title={title}>
        <Icon className="h-3 w-3" />
        {text}
      </Badge>
      <Dropdown>
        <DropdownButton outline className="w-48 justify-between">
          <span>{selectedPanel ? selectedPanel.name : "None"}</span>
          <ChevronDownIcon
            className="h-5 w-5 text-zinc-400"
            aria-hidden="true"
          />
        </DropdownButton>
        <DropdownMenu>
          {panelsList.map((panel) => (
            <DropdownItem
              key={panel.id}
              onClick={() => setPanelId(panel.id)}
              className="w-full"
            >
              <DropdownLabel>{panel.name}</DropdownLabel>
              <DropdownDescription>
                {getPanelDescription(panel.name)}
              </DropdownDescription>
            </DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>
      <div className="text-xs text-zinc-500">
        {getPanelDescription(selectedPanel?.name || "")}
      </div>
    </div>
  );
};

export default PanelsDropdown;
