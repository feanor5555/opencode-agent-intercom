// Preloaded into every suite by `npm test` (`--import`): the suite runs as
// though no codegraph binary resolves, whatever this machine has on PATH or in
// its settings file, so prompt text does not depend on the machine. A test that
// exercises the card sets its own resolver with setCodegraphResolver.
//
// The resolver is set by a load hook that appends the call to src/codegraph.js
// as it loads, rather than by importing the module here: an import at preload
// time would evaluate src/log.js before a suite sets the environment that
// module reads at load.

import { registerHooks } from "node:module"

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith("/src/codegraph.js")) return result
    return { ...result, source: `${result.source}\nsetCodegraphResolver(() => null)\n` }
  },
})
