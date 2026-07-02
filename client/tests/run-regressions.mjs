import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, 'regressions');

async function collectTests(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const tests = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      tests.push(...await collectTests(fullPath));
    } else if (/\.test\.m?js$/.test(entry.name)) {
      tests.push(fullPath);
    }
  }
  return tests.sort();
}

const tests = await collectTests(root);

if (tests.length === 0) {
  console.log(`No client regression tests found under ${root}.`);
  process.exit(0);
}

const child = spawn(process.execPath, ['--test', ...tests], {
  cwd: path.resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Client regression tests stopped by signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(`Failed to start client regression tests: ${error.message}`);
  process.exit(1);
});
