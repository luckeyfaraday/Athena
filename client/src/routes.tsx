import type { ReactNode } from "react";
import { Database, Eye, FolderKanban, Settings, TerminalSquare, Users } from "lucide-react";

export type ActiveRoom = "command" | "workspace" | "swarm" | "review" | "memory" | "settings";

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
    id: "workspace",
    label: "Workspaces",
    sidebarLabel: "Workspaces",
    eyebrow: "02 · Project map",
    description: "Switch projects, see live sessions, and manage saved local workspaces.",
    icon: <FolderKanban size={14} />,
  },
  {
    id: "swarm",
    label: "Agents",
    sidebarLabel: "Agents",
    eyebrow: "03 · Parallel agents",
    description: "Track live embedded agents and recent native sessions for this workspace.",
    icon: <Users size={14} />,
  },
  {
    id: "memory",
    label: "Memory Room",
    sidebarLabel: "Memory",
    eyebrow: "04 · Persistent context",
    description: "Inspect what ATHENA knows, what agents asked, and what future sessions inherit.",
    icon: <Database size={14} />,
  },
  {
    id: "review",
    label: "Review Room",
    sidebarLabel: "Reviews",
    eyebrow: "05 · Human control",
    description: "Inspect terminal buffers, prompt paths, and native session metadata before deciding what to keep.",
    icon: <Eye size={14} />,
  },
  {
    id: "settings",
    label: "Settings",
    sidebarLabel: "Settings",
    eyebrow: "06 · Workspace control",
    description: "Manage the active workspace, backend process, Hermes status, and recall refresh.",
    icon: <Settings size={14} />,
  },
] as const satisfies readonly RoomRoute[];

export const roomRouteById: Record<ActiveRoom, RoomRoute> = Object.fromEntries(
  roomRoutes.map((route) => [route.id, route]),
) as Record<ActiveRoom, RoomRoute>;
