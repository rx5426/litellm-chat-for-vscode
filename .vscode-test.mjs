import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';
import process from 'node:process';

const runId = `${process.pid}-${Date.now()}`;
const userDataDir = path.join(process.cwd(), '.vscode-test', 'user-data', runId);
const extensionsDir = path.join(process.cwd(), '.vscode-test', 'extensions-run', runId);

export default defineConfig({
  files: 'out/test/**/*.test.js',
  launchArgs: [
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-workspace-trust',
    '--disable-updates',
    '--skip-release-notes',
    '--disable-telemetry',
    '--disable-extension=ms-vsliveshare.vsliveshare',
    '--disable-extension=ms-python.gather',
    '--disable-extension=ms-python.vscode-pylance'
  ],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    color: true
  }
});