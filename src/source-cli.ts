#!/usr/bin/env node
/** Internal candidate entrypoint; no public default or package binary change. */
import { main, reportCliError } from './cli-main.js';
import { sourceMcpFrontend } from './source-edit.js';

void main(process.argv.slice(2), sourceMcpFrontend).catch(reportCliError);
