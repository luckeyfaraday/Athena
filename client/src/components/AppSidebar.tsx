import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ActiveRoom } from "../routes";
import { roomRoutes } from "../routes";
import athenaMarkUrl from "../assets/athena-mark.png";
import athenaWordmarkUrl from "../assets/athena-wordmark.png";

export function AppSidebar({
  activeRoom,
  backendOnline,
  hermesOnline,
  onNavigate,
}: {
  activeRoom: ActiveRoom;
  backendOnline: boolean;
  hermesOnline: boolean;
  onNavigate: (room: ActiveRoom) => void;
}) {
  return (
    <aside className="appSidebar" aria-label="Workspace navigation">
      <div className="brandLockup">
        <AthenaMark />
        <img className="athenaWordmark" src={athenaWordmarkUrl} alt="ATHENA" />
      </div>
      <nav className="sidebarNav">
        <span>Workspace</span>
        {roomRoutes.map((route) => (
          <SidebarButton
            key={route.id}
            active={activeRoom === route.id}
            icon={route.icon}
            label={route.sidebarLabel}
            onClick={() => onNavigate(route.id)}
          />
        ))}
      </nav>
      <div className="sidebarStatus">
        <span>Status</span>
        <StatusLine label="Backend" ok={backendOnline} />
        <StatusLine label="Hermes" ok={hermesOnline} />
      </div>
      <div className="sidebarUser">
        <div className="avatar">A</div>
        <div>
          <strong>Alan</strong>
          <span>Pro</span>
        </div>
        <ChevronRight size={14} />
      </div>
    </aside>
  );
}

export function AthenaMark({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? "athenaMark small" : "athenaMark"} aria-hidden="true">
      <img src={athenaMarkUrl} alt="" />
    </span>
  );
}

function SidebarButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={active ? "sidebarButton active" : "sidebarButton"} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function StatusLine({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="statusLine">
      <span><i className={ok ? "ok" : "bad"} />{label}</span>
      <strong>{ok ? "Online" : "Offline"}</strong>
    </div>
  );
}
