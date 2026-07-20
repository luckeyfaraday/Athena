import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "regressions");

async function collectTests(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const tests = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...await collectTests(entryPath));
    else if (/\.test\.m?js$/.test(entry.name)) tests.push(entryPath);
  }
  return tests.sort();
}

const tests = await collectTests(root);
if (tests.length === 0) {
  console.error(`No permanent client regression tests found under ${root}.`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...tests], {
  cwd: path.resolve(import.meta.dirname, ".."),
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Client regression tests stopped by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(`Failed to start client regression tests: ${error.message}`);
  process.exit(1);
});
