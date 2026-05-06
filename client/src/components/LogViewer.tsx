import { useEffect, useState } from "react";
import type { BackendClient, Run } from "../api";

type Props = {
  client: BackendClient | null;
  run: Run | null;
};

const artifacts = ["stdout", "stderr", "result", "context"] as const;

export function LogViewer({ client, run }: Props) {
  const [artifact, setArtifact] = useState<(typeof artifacts)[number]>("stdout");
  const [text, setText] = useState("");

  useEffect(() => {
    if (!client || !run) {
      setText("");
      return;
    }
    let cancelled = false;
    client
      .artifact(run.run_id, artifact)
      .then((content) => {
        if (!cancelled) setText(content);
      })
      .catch((error) => {
        if (!cancelled) setText(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [artifact, client, run]);

  return (
    <div className="panel logViewer">
      <div className="panelHeader">
        <h2>{run ? run.agent_id : "Logs"}</h2>
        <div className="tabs">
          {artifacts.map((name) => (
            <button key={name} className={artifact === name ? "active" : ""} onClick={() => setArtifact(name)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <pre>{text || "Select a run."}</pre>
    </div>
  );
}
