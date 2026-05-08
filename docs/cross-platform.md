# Cross-Platform Development Contract

Context Workspace is developed on Windows and Linux. Platform-specific behavior should be isolated behind small helpers instead of being embedded in React components or launcher strings.

## Runtime Requirements

- Node.js 22 or newer for the Electron client.
- Python 3.12 or newer for the FastAPI backend.
- Backend Python dependencies from `backend/requirements.txt`.
- `CONTEXT_WORKSPACE_PYTHON` may be set to an absolute Python executable when `python` or `python3` is not the correct interpreter.

## Workspace Paths

The app treats a selected workspace as a structured path:

- `nativePath`: valid on the Electron host OS.
- `wslPath`: valid inside WSL when a Windows path can be translated.
- `displayPath`: user-facing path text.

Renderer code should not hardcode `/home/...` or reject `C:\...` paths. Ask Electron for defaults with `desktop.getDefaultWorkspace()` and normalize selected folders with `desktop.toWorkspacePath()`.

## Windows Modes

Native Windows mode uses:

- `cmd.exe` for plain embedded shells.
- PowerShell for agent launch wrappers.
- `where.exe` for command discovery.
- Windows Terminal (`wt.exe`) for native multi-pane grids.

WSL mode is used for tools that are Linux-first, especially Hermes. Windows paths can be translated to `/mnt/<drive>/...`, but launchers should keep both native and WSL path forms available.

## Linux And macOS Modes

Linux uses:

- `bash` for shell and agent wrappers.
- `which` for command discovery.
- common terminal emulators such as `gnome-terminal`, `konsole`, `xfce4-terminal`, `alacritty`, `kitty`, or `x-terminal-emulator`.
- `tmux` for native multi-pane Codex grids.

macOS uses Terminal.app via `osascript` for native terminal launch.

## Packaging

- Linux builds produce an AppImage.
- Windows builds produce an NSIS installer.
- macOS builds produce a DMG.
- The backend source is copied as an Electron `extraResources` entry. Python itself is not bundled, so packaged apps still need a host Python with backend dependencies unless that is changed later.

## Development Rules

- Put OS checks in `client/electron/platform.ts` or code that delegates to it.
- Do not store raw strings for new workspace state; use the workspace path model.
- Do not add user-specific paths such as `/home/alan` or `C:\Users\...`.
- Prefer structured spawn argument arrays over shell-concatenated command strings.
- Add tests for pure path/launcher helpers when changing platform behavior.
