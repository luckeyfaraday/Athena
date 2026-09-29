import type { ReactNode } from "react";
import { Settings, TerminalSquare } from "lucide-react";

export type ActiveRoom = "command" | "settings";

export type RoomRoute = {
  id: ActiveRoom;
  label: string;
  icon: ReactNode;
};

export const roomRoutes = [
  {
    id: "command",
    label: "Command Room",
    icon: <TerminalSquare size={13} />,
  },
  {
    id: "settings",
    label: "Settings",
    icon: <Settings size={13} />,
  },
] as const satisfies readonly RoomRoute[];
