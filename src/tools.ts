import { tool } from '@opencode-ai/plugin'
import { fetchUsageReport } from './adapters/v1.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { formatWebSearchResults, kiroWebSearch } from './plugin/web-search.js'

// Register Kiro's server-side web search as a custom tool, when enabled and the
// active account is Pro (has a profileArn). Returns an empty object otherwise so
// nothing is advertised to the model on free accounts.
//
// The description is adapted from Kiro's own web_search tool spec so the model
// gets the same guidance on when to search and how to attribute results.
const WEB_SEARCH_DESCRIPTION = `Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.

## When to Use
- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).
- Verifying facts that may have changed recently, or details likely newer than the model's training data.
- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.

## When NOT to Use
- Basic concepts, historical facts, or well-established programming syntax the model already knows.
- Anything answerable from the current repository, files, or conversation. Search the codebase first.

## Query Tips
- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).
- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.
- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.

## Using Results & Attribution
- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).
- ALWAYS cite sources with inline links in the format [description](url).
- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.`

export function buildTools(
  config: any,
  accountManager: AccountManager,
  repository: AccountRepository
): Record<string, any> {
  const tools: Record<string, any> = {
    kiro_usage: tool({
      description:
        'Refresh and report Kiro credit usage for every configured account, followed by aggregate totals. Never expose credentials or raw API responses.',
      args: {},
      async execute() {
        return fetchUsageReport(config, accountManager, repository)
      }
    })
  }

  if (!config.web_search_enabled) return tools
  const account = accountManager.getCurrentOrNext()
  if (!account?.profileArn) return tools

  Object.assign(tools, {
    kiro_web_search: tool({
      description: WEB_SEARCH_DESCRIPTION,
      args: {
        query: tool.schema.string().describe('The search query. Must be 200 characters or fewer.')
      },
      async execute(args: { query: string }) {
        try {
          const results = await kiroWebSearch(accountManager, args.query)
          return formatWebSearchResults(results)
        } catch (e) {
          return `Web search failed: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    })
  })

  return tools
}
