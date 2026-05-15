import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";

export function MemoryRoom({ entries, busy, onDelete, mark }: { entries: string[]; busy: boolean; onDelete: (entry: string) => Promise<void>; mark: ReactNode }) {
  return (
    <div className="roomPanel memoryRoomFull">
      <div className="memoryHero">
        {mark}
        <div>
          <span className="tinyLabel">ATHENA source of truth</span>
          <h3>Every future agent inherits this trail.</h3>
          <p>Project decisions, agent questions, task outcomes, and user preferences stay available across sessions.</p>
        </div>
      </div>
      <div className="memoryGrid">
        {entries.map((entry, index) => (
          <article key={`${index}-${entry.slice(0, 24)}`} className="memoryCard">
            <div className="memoryCardTop">
              <span>memory · {String(index + 1).padStart(2, "0")}</span>
              <button type="button" className="dangerIconButton" onClick={() => void onDelete(entry)} disabled={busy} title="Delete memory entry">
                <Trash2 size={13} />
              </button>
            </div>
            <p>{entry}</p>
          </article>
        ))}
        {entries.length === 0 && <p className="emptyStateText">No memory entries loaded.</p>}
      </div>
    </div>
  );
}
