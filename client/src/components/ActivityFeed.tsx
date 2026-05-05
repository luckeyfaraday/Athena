import { Database } from "lucide-react";

type Props = {
  entries: string[];
  variant?: "side" | "full";
};

export function ActivityFeed({ entries, variant = "side" }: Props) {
  return (
    <div className={variant === "full" ? "panel activityFeed fullPanel" : "panel activityFeed"}>
      <div className="panelHeader">
        <div className="panelTitle">
          <Database size={16} />
          <h2>Memory</h2>
        </div>
        <span>{entries.length} entries</span>
      </div>
      <div className="memoryRows">
        {entries.map((entry, index) => (
          <article key={`${index}-${entry.slice(0, 12)}`}>
            {entry}
          </article>
        ))}
        {entries.length === 0 && <p className="empty">No memory entries.</p>}
      </div>
    </div>
  );
}
