// @slot/dev-tools — the debug panel, the event log, the force-outcome UI.
//
// Development only, twice over: the client imports this package dynamically inside an
// `if (__DEV_TOOLS__)` branch the production build deletes, and the one capability that crosses
// the wire (`forceOutcome`) is refused server-side outside dev mode regardless. The strip is
// verified against the built bundle — see apps/game-client `verify:strip`.
export { EventLog } from './log.js';
export { DEVTOOLS_CSS } from './style.js';
export type { LogEntry, EventLogOptions } from './log.js';
export { createDebugPanel, summarize } from './panel.js';
export type {
  DebugPanel,
  DebugPanelOptions,
  EnginePort,
  FaultView,
  PanelDocument,
  PanelElement,
} from './panel.js';
