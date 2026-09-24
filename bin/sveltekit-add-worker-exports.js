#!/usr/bin/env node
// Committed launcher (not built) so package managers can link the bin
// before `dist/` exists, e.g. in this workspace right after `pnpm install`.
import '../dist/bin.js';
