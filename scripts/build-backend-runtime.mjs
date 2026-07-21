import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputRoot = path.join(repositoryRoot, "client", "backend-runtime");
const entryPoint = path.join(repositoryRoot, "backend", "launcher.py");

function findPython() {
  const configured = process.env.CONTEXT_WORKSPACE_BUILD_PYTHON?.trim();
  const candidates = configured
    ? [configured]
    : process.platform === "win32"
      ? ["python", "python3"]
      : ["python3", "python"];
  for (const candidate of candidates) {
    const probe = childProcess.spawnSync(candidate, ["-c", "import PyInstaller"], {
      cwd: repositoryRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    "PyInstaller is unavailable. Install backend/requirements-build.txt or set "
      + "CONTEXT_WORKSPACE_BUILD_PYTHON to a prepared Python executable.",
  );
}

function assertSafeOutputPath(value) {
  const expected = path.join(repositoryRoot, "client", "backend-runtime");
  if (path.resolve(value) !== expected) {
    throw new Error(`Refusing to replace unexpected backend runtime path: ${value}`);
  }
}

const python = findPython();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "athena-backend-build-"));
assertSafeOutputPath(outputRoot);
fs.rmSync(outputRoot, { recursive: true, force: true });

try {
  const result = childProcess.spawnSync(
    python,
    [
      "-m",
      "PyInstaller",
      "--clean",
      "--noconfirm",
      "--onedir",
      "--name",
      "athena-backend",
      "--distpath",
      outputRoot,
      "--workpath",
      path.join(temporaryRoot, "work"),
      "--specpath",
      path.join(temporaryRoot, "spec"),
      "--collect-submodules",
      "uvicorn",
      "--collect-submodules",
      "backend",
      entryPoint,
    ],
    { cwd: repositoryRoot, stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PyInstaller exited with status ${result.status ?? "unknown"}.`);
  }

  const executable = path.join(
    outputRoot,
    "athena-backend",
    process.platform === "win32" ? "athena-backend.exe" : "athena-backend",
  );
  if (!fs.existsSync(executable)) {
    throw new Error(`PyInstaller did not produce the expected executable: ${executable}`);
  }
  console.log(`Bundled Athena backend: ${executable}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
