import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_PROVIDERS = ["brave", "tavily"] as const;

type ProviderId = (typeof DEFAULT_PROVIDERS)[number];

interface ProviderState {
  order: ProviderId[];
}

function normalizeOrder(input: string): ProviderId[] {
  const tokens = input
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean) as ProviderId[];
  const filtered = tokens.filter((t) => DEFAULT_PROVIDERS.includes(t));
  const unique: ProviderId[] = [];
  for (const t of filtered) {
    if (!unique.includes(t)) unique.push(t);
  }
  return unique.length ? unique : [...DEFAULT_PROVIDERS];
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... (truncated ${text.length - limit} chars)`;
}

async function searchBrave(query: string, maxResults: number) {
  const key = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brave error ${res.status}: ${truncate(body, 500)}`);
  }
  const data = await res.json();
  const items = data?.web?.results ?? [];
  return items.map((item: any) => ({
    title: item?.title ?? "",
    url: item?.url ?? "",
    snippet: item?.description ?? "",
  }));
}

async function searchTavily(query: string, maxResults: number) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY not set");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily error ${res.status}: ${truncate(body, 500)}`);
  }
  const data = await res.json();
  const items = data?.results ?? [];
  return items.map((item: any) => ({
    title: item?.title ?? "",
    url: item?.url ?? "",
    snippet: item?.content ?? "",
  }));
}

export default function webSearch(pi: ExtensionAPI) {
  let state: ProviderState = { order: [...DEFAULT_PROVIDERS] };

  function persist() {
    pi.appendEntry<ProviderState>("web-search-config", { order: state.order });
  }

  function restore(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    let latest: ProviderState | null = null;
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "web-search-config") {
        latest = (entry.data as ProviderState) ?? null;
      }
    }
    if (latest?.order?.length) {
      state.order = latest.order;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    restore(ctx);
  });

  pi.registerCommand("search_providers", {
    description: "Set web search provider order (brave, tavily)",
    handler: async (_args, ctx) => {
      const current = state.order.join(", ");
      const input = await ctx.ui.input(
        "Provider order (comma-separated)",
        current
      );
      if (!input) return;
      state.order = normalizeOrder(input);
      persist();
      ctx.ui.notify(`Search providers: ${state.order.join(", ")}`, "info");
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using configured providers (Brave, Tavily).",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(Type.Number({ description: "Max results" })),
    }),
    async execute(_toolCallId, params) {
      const query = params.query;
      const maxResults = Math.max(1, Math.min(10, params.maxResults ?? 5));

      const errors: string[] = [];
      for (const provider of state.order) {
        try {
          const results =
            provider === "brave"
              ? await searchBrave(query, maxResults)
              : await searchTavily(query, maxResults);

          const text = results
            .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
            .join("\n\n");

          return {
            content: [
              {
                type: "text",
                text: `Provider: ${provider}\n\n${text}`.trim(),
              },
            ],
            details: { provider, results },
          };
        } catch (err) {
          errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Web search failed.\n${errors.join("\n")}`.trim(),
          },
        ],
        details: { errors },
      };
    },
  });
}
