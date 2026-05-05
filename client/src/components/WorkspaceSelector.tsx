import { FolderOpen } from "lucide-react";
import { desktop } from "../electron";

type Props = {
  workspace: string;
  onWorkspaceChange: (workspace: string) => void;
};

export function WorkspaceSelector({ workspace, onWorkspaceChange }: Props) {
  async function chooseWorkspace() {
    const selected = await desktop.selectWorkspace();
    if (selected) {
      onWorkspaceChange(selected);
    }
  }

  return (
    <div className="workspaceSelector">
      <label htmlFor="workspace">Workspace</label>
      <div>
        <input
          id="workspace"
          value={workspace}
          onChange={(event) => onWorkspaceChange(event.target.value)}
          placeholder="Select a project directory"
        />
        <button className="iconButton" onClick={chooseWorkspace} title="Select workspace">
          <FolderOpen size={18} />
        </button>
      </div>
    </div>
  );
}
