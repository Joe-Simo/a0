#!/usr/bin/env node
/** Internal standalone build entrypoint; public package/release defaults are unchanged. */
import { main, reportCliError } from './cli-main.js';
import { sourceMcpFrontend } from './source-edit.js';
import { initSourceProject } from './source-init.js';

void main(process.argv.slice(2), {
  ...sourceMcpFrontend,
  initializeProject: (root) => initSourceProject(root, { executable: process.execPath }),
}).catch(reportCliError);
