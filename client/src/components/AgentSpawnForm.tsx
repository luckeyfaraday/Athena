import { Play } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";

type Props = {
  disabled: boolean;
  onSpawn: (task: string) => Promise<void>;
};

export function AgentSpawnForm({ disabled, onSpawn }: Props) {
  const [task, setTask] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = task.trim();
    if (!trimmed) return;
    await onSpawn(trimmed);
    setTask("");
  }

  return (
    <form className="panel spawnForm" onSubmit={submit}>
      <div className="panelHeader">
        <h2>Codex Run</h2>
        <button className="button buttonPrimary" disabled={disabled || !task.trim()} title="Spawn Codex">
          <Play size={17} />
          <span>Spawn</span>
        </button>
      </div>
      <textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        placeholder="Review the auth module and report concrete issues."
        rows={6}
      />
    </form>
  );
}
