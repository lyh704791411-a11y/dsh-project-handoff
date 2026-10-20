/**
 * dsh-project-handoff — Host-only draft, NOT installed.
 *
 * This entry imports only local `./lib/*.js` modules. It deliberately imports
 * no `@deepseek-ai/*` package: the sibling spike proved that a locally linked
 * bundle in this profile cannot resolve the Harness' bundled packages
 * (`ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`). There is also no Config
 * schema for the same reason; defaults live in `lib/util.js`.
 *
 * Behavior:
 *   - `session/event`        count automatic compactions per Session
 *   - `agent/pre-step`       inject one short notice per turn
 *   - `agent/turn-stopping`  verify the notice is displayed; optional steer
 *
 * Every listener is registered on the plugin context, so unloading the plugin
 * disposes them. The function returns nothing to avoid double disposal.
 */

import { installCount } from './lib/count.js'
import { installInject } from './lib/inject.js'
import { createStateStore } from './lib/state.js'
import { loggerOf, resolveConfig } from './lib/util.js'
import { installVerify } from './lib/verify.js'

/** Display name used by the Loader in diagnostics. */
export const name = 'project-handoff'

/**
 * Host plugin entry point.
 *
 * @param {{ on: Function, logger?: object, get?: Function }} ctx
 * @param {{ stateDir?: string, steer?: boolean } | undefined} config
 */
export function apply(ctx, config) {
  if (typeof ctx?.on !== 'function') return
  const logger = loggerOf(ctx)
  const settings = resolveConfig(config)
  const store = createStateStore({ stateDir: settings.stateDir, logger })

  installCount(ctx, { store, logger })
  installInject(ctx, { store, logger })
  installVerify(ctx, { store, steer: settings.steer, logger })
}
