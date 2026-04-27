"use client";

import { useMemo } from "react";
import { ChevronDownIcon } from "@heroicons/react/20/solid";

import {
  Dropdown,
  DropdownButton,
  DropdownMenu,
  DropdownItem,
  DropdownLabel,
  DropdownDescription,
} from "@/components/dropdown";
import { panels } from "@/utils/actions";

const PanelsDropdown = ({
  panelId,
  setPanelId,
}: {
  panelId: string;
  setPanelId: (id: string) => void;
}) => {
  const { data: panelsData, error } = panels.get.useSWR();

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

  return (
    <div className="flex flex-col items-center gap-2">
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
              <DropdownDescription>{panel.description}</DropdownDescription>
            </DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>
      <div className="text-xs text-zinc-500">
        {selectedPanel?.description || ""}
      </div>
    </div>
  );
};

export default PanelsDropdown;
