import type { ReactNode } from "react";
import { Database, Eye, Settings, TerminalSquare, Users } from "lucide-react";

export type ActiveRoom = "command" | "swarm" | "review" | "memory" | "settings";

export type RoomRoute = {
  id: ActiveRoom;
  label: string;
  sidebarLabel: string;
  eyebrow: string;
  description: string;
  icon: ReactNode;
};

export const roomRoutes = [
  {
    id: "command",
    label: "Command Room",
    sidebarLabel: "Command Room",
    eyebrow: "01 · Native work",
    description: "Terminals, repo state, and agent context open in one controlled workspace.",
    icon: <TerminalSquare size={14} />,
  },
  {
    id: "swarm",
    label: "Swarm Room",
    sidebarLabel: "Agents",
    eyebrow: "02 · Parallel agents",
    description: "Spin up builders, reviewers, scouts, and fixers with memory already attached.",
    icon: <Users size={14} />,
  },
  {
    id: "memory",
    label: "Memory Room",
    sidebarLabel: "Memory",
    eyebrow: "03 · Persistent context",
    description: "Inspect what ATHENA knows, what agents asked, and what future sessions inherit.",
    icon: <Database size={14} />,
  },
  {
    id: "review",
    label: "Review Room",
    sidebarLabel: "Reviews",
    eyebrow: "04 · Human control",
    description: "Turn agent output into a clean ship, revise, or investigate decision.",
    icon: <Eye size={14} />,
  },
  {
    id: "settings",
    label: "Settings",
    sidebarLabel: "Settings",
    eyebrow: "05 · Workspace control",
    description: "Manage the active workspace, backend process, Hermes status, and recall refresh.",
    icon: <Settings size={14} />,
  },
] as const satisfies readonly RoomRoute[];

export const roomRouteById: Record<ActiveRoom, RoomRoute> = Object.fromEntries(
  roomRoutes.map((route) => [route.id, route]),
) as Record<ActiveRoom, RoomRoute>;
