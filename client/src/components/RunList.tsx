import { Square } from "lucide-react";
import type { Run } from "../api";
import { isTerminalRunStatus } from "./status";

type Props = {
  runs: Run[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onCancel: (runId: string) => Promise<void>;
};

export function RunList({ runs, selectedRunId, onSelect, onCancel }: Props) {
  return (
    <div className="panel runList">
      <div className="panelHeader">
        <h2>Runs</h2>
        <span>{runs.length}</span>
      </div>
      <div className="runRows">
        {runs.map((run) => (
          <button
            key={run.run_id}
            className={`runRow ${selectedRunId === run.run_id ? "selected" : ""}`}
            onClick={() => onSelect(run.run_id)}
          >
            <span className={`dot ${run.status}`} />
            <span>
              <strong>{run.agent_id}</strong>
              <small>{run.task}</small>
            </span>
            {!isTerminalRunStatus(run.status) && (
              <span
                className="rowIcon"
                title="Cancel run"
                onClick={(event) => {
                  event.stopPropagation();
                  void onCancel(run.run_id);
                }}
              >
                <Square size={14} />
              </span>
            )}
          </button>
        ))}
        {runs.length === 0 && <p className="empty">No runs yet.</p>}
      </div>
    </div>
  );
}
