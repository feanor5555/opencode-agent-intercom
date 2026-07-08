#!/usr/bin/env node
// `opendesign` — CLI wrapper around src/opendesign-cli.js (S3). Thin shim:
// parse argv, hand it to run(), exit with its return code.

import { run } from "../src/opendesign-cli.js"

const code = await run(process.argv.slice(2))
process.exit(code)
