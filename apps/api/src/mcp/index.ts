import { apiKeyTools } from './api-keys'
import { collectionTools } from './collections'
import { entryTools } from './entries'
import { mediaTools } from './media'
import { newsletterTools } from './newsletters'
import type { ToolDefinition } from './registry'
import { siteTools } from './sites'
import { userTools } from './users'

export { buildTools, type McpContext, type ToolAccess, type ToolDefinition } from './registry'

/**
 * Every tool the MCP endpoint can offer, in the order a client sees them: the content model first,
 * then content, then the things around it, then the deployment itself.
 *
 * What any one caller actually sees is a subset — `buildTools` filters by the scopes the client was
 * granted at consent, and each tool's role requirement is checked again when it is called.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  ...collectionTools,
  ...entryTools,
  ...mediaTools,
  ...newsletterTools,
  ...siteTools,
  ...userTools,
  ...apiKeyTools,
]

/** Guards against two modules picking the same tool name — MCP dispatches on it. */
const duplicates = ALL_TOOLS.map((tool) => tool.name).filter(
  (name, index, names) => names.indexOf(name) !== index,
)
if (duplicates.length > 0) {
  throw new Error(`Duplicate MCP tool name(s): ${[...new Set(duplicates)].join(', ')}`)
}
