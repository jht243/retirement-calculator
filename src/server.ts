import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListResourceTemplatesRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type MortgageWidget = {
  id: string;
  title: string;
  templateUri: string;
  invoking: string;
  invoked: string;
  html: string;
  responseText: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = process.env.ASSETS_ROOT || path.resolve(__dirname, "..", "..");
const ASSETS_DIR = path.resolve(ROOT_DIR, "assets");
const LOGS_DIR = path.resolve(__dirname, "..", "logs");

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// FRED daily mortgage rate endpoint (/api/rate)
type RateCache = { ts: number; payload: any } | null;
let fredRateCache: RateCache = null;

async function fetchFredLatestRate(): Promise<{ raw: number; adjusted: number; observationDate: string; source: string; } | null> {
  const FRED_API_KEY = process.env.FRED_API_KEY;
  const seriesId = process.env.FRED_SERIES_ID || "MORTGAGE30US";
  if (!FRED_API_KEY) {
    console.error("[FRED] FRED_API_KEY not set");
    return null;
  }

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", FRED_API_KEY);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "14");

  try {
    console.log("[FRED] Fetching latest rate", {
      seriesId,
      url: url.toString(),
    });
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`FRED error ${resp.status}`);
    const data = await resp.json();
    const obs = Array.isArray(data?.observations) ? data.observations : [];
    const firstValid = obs.find((o: any) => o && o.value && o.value !== ".");
    if (!firstValid) {
      console.error("[FRED] No valid observations returned", {
        seriesId,
        sample: obs.slice(0, 5),
      });
      return null;
    }
    const raw = parseFloat(firstValid.value);
    if (!Number.isFinite(raw)) {
      console.error("[FRED] Observation value not numeric", {
        seriesId,
        observation: firstValid,
      });
      return null;
    }
    const adjusted = raw - 0.4;
    console.log("[FRED] Received observation", {
      observationDate: firstValid.date,
      raw,
      adjusted,
    });
    return { raw, adjusted, observationDate: firstValid.date, source: seriesId };
  } catch (e) {
    console.error("[FRED] Fetch failed", e);
    return null;
  }
}

async function handleRate(req: IncomingMessage, res: ServerResponse) {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log("[Rate] Request received", {
    requestId,
    method: req.method,
    url: req.url,
  });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    }).end();
    return;
  }

  if (req.method !== "GET") {
    console.warn("[Rate] Unsupported method", { requestId, method: req.method });
    res.writeHead(405).end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const now = Date.now();
  const TTL = 60 * 60 * 1000; // 1 hour
  if (fredRateCache && now - fredRateCache.ts < TTL) {
    console.log("[Rate] Serving cached value", {
      requestId,
      cachedAt: fredRateCache.ts,
      ratePercent: fredRateCache.payload?.ratePercent,
    });
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.writeHead(200).end(JSON.stringify(fredRateCache.payload));
    return;
  }

  console.log("[Rate] Cache miss, fetching fresh value", {
    requestId,
    cachePresent: Boolean(fredRateCache),
  });
  const result = await fetchFredLatestRate();
  if (!result) {
    console.error("[Rate] Failed to obtain FRED rate", { requestId });
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(503).end(JSON.stringify({ error: "FRED unavailable" }));
    return;
  }
  const rounded = Math.round(result.adjusted * 10) / 10;
  const payload: any = {
    ratePercent: rounded,
    rawPercent: result.raw,
    adjustedAdded: -0.4,
    observationDate: result.observationDate,
    source: result.source,
  };
  fredRateCache = { ts: now, payload };
  console.log("[Rate] Returning fresh value", {
    requestId,
    payload,
  });
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.writeHead(200).end(JSON.stringify(payload));
}

type AnalyticsEvent = {
  timestamp: string;
  event: string;
  [key: string]: any;
};

function logAnalytics(event: string, data: Record<string, any> = {}) {
  const entry: AnalyticsEvent = {
    timestamp: new Date().toISOString(),
    event,
    ...data,
  };

  const logLine = JSON.stringify(entry);
  console.log(logLine);

  const today = new Date().toISOString().split("T")[0];
  const logFile = path.join(LOGS_DIR, `${today}.log`);
  fs.appendFileSync(logFile, logLine + "\n");
}

function getRecentLogs(days: number = 7): AnalyticsEvent[] {
  const logs: AnalyticsEvent[] = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    const logFile = path.join(LOGS_DIR, `${dateStr}.log`);

    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, "utf8");
      const lines = content.trim().split("\n");
      lines.forEach((line) => {
        try {
          logs.push(JSON.parse(line));
        } catch (e) {}
      });
    }
  }

  return logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function classifyDevice(userAgent?: string | null): string {
  if (!userAgent) return "Unknown";
  const ua = userAgent.toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) return "iOS";
  if (ua.includes("android")) return "Android";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macOS";
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("linux")) return "Linux";
  if (ua.includes("cros")) return "ChromeOS";
  return "Other";
}

function computeSummary(args: any) {
  const hv = typeof args.home_value === "number" && args.home_value > 0 ? args.home_value : null;
  const dpv = typeof args.down_payment_value === "number" && args.down_payment_value >= 0 ? args.down_payment_value : 0;
  const principal = hv != null ? Math.max(0, hv - dpv) : null;
  const apr = typeof args.rate_apr === "number" && args.rate_apr > 0 ? args.rate_apr : null;
  const years = typeof args.term_years === "number" && args.term_years > 0 ? args.term_years : null;
  if (principal == null || apr == null || years == null) {
    return {
      loan_amount: principal,
      monthly_payment_pi: null,
      months_to_payoff: null,
      payoff_date: null,
      lifetime_interest: null,
      pmi_end_month_index: null,
      biweekly: null,
    };
  }
  const n = Math.round(years * 12);
  const r = (apr / 100) / 12;
  let m = 0;
  if (r === 0) {
    m = principal / n;
  } else {
    const f = Math.pow(1 + r, n);
    m = principal * r * f / (f - 1);
  }
  const totalPaid = m * n;
  const totalInterest = totalPaid - principal;
  let startMonth = args.start_month && args.start_month >= 1 && args.start_month <= 12 ? args.start_month : null;
  let startYear = typeof args.start_year === "number" && args.start_year > 1900 ? args.start_year : null;
  const now = new Date();
  if (!startMonth || !startYear) {
    startMonth = now.getMonth() + 1;
    startYear = now.getFullYear();
  }
  const payoff = new Date(startYear, (startMonth - 1) + n, 1);
  const payoffDate = `${payoff.getFullYear()}-${String(payoff.getMonth() + 1).padStart(2, "0")}`;
  let pmiEndIndex: number | null = null;
  const pmiThreshold = hv * 0.8;
  if (principal > 0) {
    let bal = principal;
    for (let i = 1; i <= n; i++) {
      const interestPortion = r === 0 ? 0 : bal * r;
      const principalPortion = Math.min(bal, m - interestPortion);
      bal = Math.max(0, bal - principalPortion);
      const ltvAmount = bal;
      if (pmiEndIndex === null && ltvAmount <= pmiThreshold) {
        pmiEndIndex = i;
        break;
      }
    }
  }
  let biweekly: any = null;
  try {
    const periodsPerYear = 26;
    const i = (apr / 100) / periodsPerYear;
    const paymentBiweekly = m / 2;
    let nbi = null as null | number;
    if (i === 0) {
      nbi = principal / paymentBiweekly;
    } else {
      const denom = paymentBiweekly - principal * i;
      if (denom > 0) {
        nbi = Math.log(paymentBiweekly / denom) / Math.log(1 + i);
      }
    }
    if (nbi && nbi > 0 && Number.isFinite(nbi)) {
      const interestBi = paymentBiweekly * nbi - principal;
      const monthsBi = nbi / periodsPerYear * 12;
      const monthsSaved = Math.max(0, n - monthsBi);
      biweekly = {
        months_to_payoff: Math.round(monthsBi),
        interest_paid: Math.max(0, interestBi),
        savings_interest: Math.max(0, totalInterest - interestBi),
        months_saved: Math.round(monthsSaved),
      };
    }
  } catch {}
  return {
    loan_amount: Math.round(principal),
    monthly_payment_pi: Math.round(m * 100) / 100,
    months_to_payoff: n,
    payoff_date: payoffDate,
    lifetime_interest: Math.round(totalInterest * 100) / 100,
    pmi_end_month_index: pmiEndIndex,
    biweekly,
  };
}

function readWidgetHtml(componentName: string): string {
  if (!fs.existsSync(ASSETS_DIR)) {
    throw new Error(
      `Widget assets not found. Expected directory ${ASSETS_DIR}. Run "pnpm run build" before starting the server.`
    );
  }

  const directPath = path.join(ASSETS_DIR, `${componentName}.html`);
  let htmlContents: string | null = null;
  let loadedFrom = "";

  if (fs.existsSync(directPath)) {
    htmlContents = fs.readFileSync(directPath, "utf8");
    loadedFrom = directPath;
  } else {
    const candidates = fs
      .readdirSync(ASSETS_DIR)
      .filter(
        (file) => file.startsWith(`${componentName}-`) && file.endsWith(".html")
      )
      .sort();
    const fallback = candidates[candidates.length - 1];
    if (fallback) {
      const fallbackPath = path.join(ASSETS_DIR, fallback);
      htmlContents = fs.readFileSync(fallbackPath, "utf8");
      loadedFrom = fallbackPath;
    }
  }

  if (!htmlContents) {
    throw new Error(
      `Widget HTML for "${componentName}" not found in ${ASSETS_DIR}. Run "pnpm run build" to generate the assets.`
    );
  }

  // Log what was loaded and check for "5%" in the badge
  const has5Percent = htmlContents.includes('<span class="rate-num">5%</span>');
  const isBlank = htmlContents.includes('<span class="rate-num"></span>');
  console.log(`[Widget Load] File: ${loadedFrom}`);
  console.log(`[Widget Load] Has "5%": ${has5Percent}, Is Blank: ${isBlank}`);
  console.log(`[Widget Load] HTML length: ${htmlContents.length} bytes`);

  return htmlContents;
}

function widgetMeta(widget: MortgageWidget, bustCache: boolean = false) {
  const templateUri = bustCache
    ? `ui://widget/mortgage-calculator.html?v=${Date.now()}`
    : widget.templateUri;

  return {
    "openai/outputTemplate": templateUri,
    "openai/widgetDescription":
      "Interactive mortgage-planning dashboard with live FRED-sourced rate badge, configurable loan inputs, payment breakdown charts, amortization timeline, and email notifications for rate drops.",
    "openai/componentDescriptions": {
      "rate-indicator": "Header pill cluster that surfaces today's average 30-year fixed mortgage rate sourced from FRED, including the manual refresh control for forced updates.",
      "rate-badge": "Rounded badge displaying the most recent mortgage rate percentage that auto-updates after every successful API call.",
      "manual-refresh-button": "Circular refresh button that triggers a new call to the /api/rate endpoint and spins while the rate is being fetched.",
      "loan-input-form": "Primary loan configuration form containing fields for program type, home value, down payment, interest rate, term, and advanced property expenses.",
      "monthly-summary-card": "Top result card that surfaces the all-in monthly payment, highlighting cash flow at month zero with contextual hints.",
      "quick-metrics": "Horizontal metric stack summarizing principal and interest, lifetime interest, and projected payoff date for the current scenario.",
      "breakdown-chart": "Donut chart and companion list that visualize how the monthly payment splits across P&I, taxes, insurance, HOA dues, and mortgage insurance.",
      "amortization-section": "Lower panels summarizing lifetime totals and a preview of the amortization schedule, including per-period balances and payments.",
      "notification-cta": "Call-to-action button that opens the modal for subscribing to mortgage rate drop alerts via email.",
    },
    "openai/widgetKeywords": [
      "mortgage calculator",
      "home loan planning",
      "FRED mortgage rate",
      "amortization schedule",
      "monthly payment analysis",
      "rate badge",
      "home affordability",
    ],
    "openai/widgetPrefersBorder": true,
    "openai/widgetCSP": {
      connect_domains: [
        "https://api.stlouisfed.org",
        "https://mortgage-calculator-open-ai.onrender.com",
        "http://localhost:8000"
      ],
      resource_domains: [],
    },
    "openai/widgetDomain": "https://chatgpt.com",
    "openai/toolInvocation/invoking": widget.invoking,
    "openai/toolInvocation/invoked": widget.invoked,
    "openai/widgetAccessible": true,
    "openai/resultCanProduceWidget": true,
    "openai/starterPrompts": [
      "Show the mortgage calculator with today's average rate and monthly payment summary",
      "Help me explore loan scenarios for buying a $600,000 home with different down payments",
      "Estimate monthly payments, payoff schedule, and total interest for a 15-year FHA mortgage",
      "Refresh the live mortgage rate badge and recompute the amortization schedule",
    ],
  } as const;
}

const widgets: MortgageWidget[] = [
  {
    id: "mortgage-calculator",
    title: "Mortgage Calculator – Live Rates, Payment Breakdown & Amortization Explorer",
    templateUri: `ui://widget/mortgage-calculator.html?v=${Date.now()}`,
    invoking:
      "Opening the interactive mortgage calculator with live mortgage-rate badge and detailed payment analytics...",
    invoked:
      "Here is the live mortgage calculator with configurable loan inputs, rate badge, payment breakdown, and amortization insights.",
    html: readWidgetHtml("mortgage-calculator"),
    responseText:
      "Here is an interactive mortgage calculator experience. It fetches the live 30-year fixed mortgage rate from FRED, lets you adjust home price, down payment, loan program, taxes, insurance, HOA dues, and extra payments, then visualizes monthly cash flow, payment composition, and amortization timelines.",
  },
];

const widgetsById = new Map<string, MortgageWidget>();
const widgetsByUri = new Map<string, MortgageWidget>();

widgets.forEach((widget) => {
  widgetsById.set(widget.id, widget);
  widgetsByUri.set(widget.templateUri, widget);
});

const toolInputSchema = {
  type: "object",
  properties: {
    loan_type: {
      type: "string",
      enum: ["conventional", "FHA", "VA", "USDA"],
      description: "Loan program type. Choose one of: conventional, FHA, VA, USDA.",
    },
    home_value: {
      type: "number",
      description: "Home purchase price in dollars. Example: 600000.",
    },
    down_payment_value: {
      type: "number",
      description: "Down payment in dollars (not percent). Example: 120000.",
    },
    rate_apr: {
      type: "number",
      description: "Annual percentage rate, e.g., 6.5 for 6.5%.",
    },
    term_years: {
      type: "number",
      description: "Loan term in years. Common values: 30, 20, 15, 10.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

const toolInputParser = z.object({
  loan_type: z.enum(["conventional", "FHA", "VA", "USDA"]).optional(),
  home_value: z.number().optional(),
  down_payment_value: z.number().optional(),
  rate_apr: z.number().optional(),
  term_years: z.number().optional(),
  zip_code: z.string().optional(),
  credit_score: z.enum(["760+", "720-759", "680-719", "640-679", "600-639", "<600"]).optional(),
  property_tax_input: z.number().optional(),
  homeowners_insurance_yearly: z.number().optional(),
  hoa_monthly: z.number().optional(),
  pmi_pct: z.number().optional(),
  annual_mi_pct: z.number().optional(),
  upfront_fee_pct: z.number().optional(),
  finance_upfront_fee: z.boolean().optional(),
  start_month: z.number().min(1).max(12).optional(),
  start_year: z.number().optional(),
  extra_principal_monthly: z.number().optional(),
  extra_start_month_index: z.number().optional(),
});

const tools: Tool[] = widgets.map((widget) => ({
  name: widget.id,
  description:
    "Use this when you need a full mortgage-planning workspace that pulls live FRED rates, lets you adjust loan assumptions, and visualizes payments via charts and amortization tables. Do not use for unrelated financial products like auto loans or credit cards.",
  inputSchema: toolInputSchema,
  outputSchema: {
    type: "object",
    properties: {
      ready: { type: "boolean" },
      timestamp: { type: "string" },
      currentRate: { type: ["number", "null"] },
      loan_type: { type: "string" },
      home_value: { type: "number" },
      down_payment_value: { type: "number" },
      rate_apr: { type: "number" },
      term_years: { type: "number" },
      zip_code: { type: "string" },
      credit_score: { type: "string" },
      property_tax_input: { type: "number" },
      homeowners_insurance_yearly: { type: "number" },
      hoa_monthly: { type: "number" },
      pmi_pct: { type: "number" },
      annual_mi_pct: { type: "number" },
      upfront_fee_pct: { type: "number" },
      finance_upfront_fee: { type: "boolean" },
      start_month: { type: "number" },
      start_year: { type: "number" },
      extra_principal_monthly: { type: "number" },
      extra_start_month_index: { type: "number" },
      summary: {
        type: "object",
        properties: {
          loan_amount: { type: ["number", "null"] },
          monthly_payment_pi: { type: ["number", "null"] },
          months_to_payoff: { type: ["number", "null"] },
          payoff_date: { type: ["string", "null"] },
          lifetime_interest: { type: ["number", "null"] },
          pmi_end_month_index: { type: ["number", "null"] },
          biweekly: {
            type: ["object", "null"],
            properties: {
              months_to_payoff: { type: ["number", "null"] },
              interest_paid: { type: ["number", "null"] },
              savings_interest: { type: ["number", "null"] },
              months_saved: { type: ["number", "null"] },
            },
          },
        },
      },
      suggested_followups: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
  title: widget.title,
  securitySchemes: [{ type: "noauth" }],
  _meta: {
    ...widgetMeta(widget),
    securitySchemes: [{ type: "noauth" }],
  },
  annotations: {
    destructiveHint: false,
    openWorldHint: false,
    readOnlyHint: true,
  },
}));

const resources: Resource[] = widgets.map((widget) => ({
  uri: widget.templateUri,
  name: widget.title,
  description:
    "HTML template for the mortgage calculator widget including live rate badge, calculator form, payment breakdown charts, amortization timeline, and notification modal.",
  mimeType: "text/html+skybridge",
  _meta: widgetMeta(widget),
}));

const resourceTemplates: ResourceTemplate[] = widgets.map((widget) => ({
  uriTemplate: widget.templateUri,
  name: widget.title,
  description:
    "Template descriptor for the mortgage calculator widget with live rate integration, configurable loan controls, visualization panels, and notification workflow.",
  mimeType: "text/html+skybridge",
  _meta: widgetMeta(widget),
}));

function createMortgageCalculatorServer(): Server {
  const server = new Server(
    {
      name: "mortgage-calculator",
      version: "0.1.0",
      description:
        "Mortgage Calculator is a comprehensive mortgage planning assistant. It fetches authoritative rate data from the Federal Reserve (FRED), calculates monthly payments, taxes, insurance, PMI, and HOA costs, and renders interactive charts, amortization schedules, and payoff timelines so homebuyers can compare loan scenarios and understand lifetime costs before making decisions.",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => {
      console.log(`[MCP] resources/list called, returning ${resources.length} resources`);
      resources.forEach((r: any) => {
        console.log(`  - ${r.uri} (${r.name})`);
      });
      return { resources };
    }
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest) => {
      const widget = widgetsByUri.get(request.params.uri);

      if (!widget) {
        throw new Error(`Unknown resource: ${request.params.uri}`);
      }

      // Inject current FRED rate into HTML before sending to ChatGPT
      let htmlToSend = widget.html;
      let displayRate: number | null = null;
      if (fredRateCache && fredRateCache.payload && typeof fredRateCache.payload.ratePercent === "number") {
        displayRate = fredRateCache.payload.ratePercent;
        console.log(`[MCP Injection] Using cached rate: ${displayRate}%`);
      } else {
        const latest = await fetchFredLatestRate();
        if (latest) {
          displayRate = Math.round((latest.adjusted) * 10) / 10;
          console.log(`[MCP Injection] Fetched fresh rate: ${displayRate}%`);
        } else {
          console.log(`[MCP Injection] FRED fetch failed, leaving blank`);
        }
      }
      // Only inject if we have a valid live rate. Otherwise leave blank.
      if (displayRate != null && Number.isFinite(displayRate)) {
        const rateText = `${displayRate}%`;
        const beforeLength = htmlToSend.length;
        htmlToSend = htmlToSend.replace(
          /(<span\s+class="rate-num">)([^<]*?)(<\/span>)/,
          (_m: any, p1: string, _p2: string, p3: string) => `${p1}${rateText}${p3}`
        );
        const afterLength = htmlToSend.length;
        const replaced = beforeLength !== afterLength || htmlToSend.includes(`rate-num">${rateText}`);
        console.log(`[MCP Injection] Injected "${rateText}", replacement success: ${replaced}`);
      } else {
        console.log(`[MCP Injection] No valid rate, sending blank badge`);
      }

      return {
        contents: [
          {
            uri: widget.templateUri,
            mimeType: "text/html+skybridge",
            text: htmlToSend,
            _meta: widgetMeta(widget),
          },
        ],
      };
    }
  );

  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (_request: ListResourceTemplatesRequest) => ({ resourceTemplates })
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest) => ({ tools })
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const startTime = Date.now();
      let userAgentString: string | null = null;
      let deviceCategory = "Unknown";
      
      // Log the full request to debug _meta location
      console.log("Full request object:", JSON.stringify(request, null, 2));
      
      try {
        const widget = widgetsById.get(request.params.name);

        if (!widget) {
          logAnalytics("tool_call_error", {
            error: "Unknown tool",
            toolName: request.params.name,
          });
          throw new Error(`Unknown tool: ${request.params.name}`);
        }

        // Parse and validate input parameters
        let args: z.infer<typeof toolInputParser> = {};
        try {
          args = toolInputParser.parse(request.params.arguments ?? {});
        } catch (parseError: any) {
          logAnalytics("parameter_parsing_error", {
            toolName: request.params.name,
            params: request.params.arguments,
            error: parseError.message,
          });
          throw parseError;
        }

        // Capture user context from _meta - try multiple locations
        const meta = (request as any)._meta || request.params?._meta || {};
        const userLocation = meta["openai/userLocation"];
        const userLocale = meta["openai/locale"];
        const userAgent = meta["openai/userAgent"];
        userAgentString = typeof userAgent === "string" ? userAgent : null;
        deviceCategory = classifyDevice(userAgentString);
        
        // Debug log
        console.log("Captured meta:", { userLocation, userLocale, userAgent });

        // If ChatGPT didn't pass structured arguments, try to infer key numbers from freeform text in meta
        try {
          const candidates: any[] = [
            meta["openai/userPrompt"],
            meta["openai/userText"],
            meta["openai/lastUserMessage"],
            meta["openai/inputText"],
            meta["openai/requestText"],
          ];
          const userText = candidates.find((t) => typeof t === "string" && t.trim().length > 0) || "";
          if (args.home_value === undefined || args.home_value === null) {
            if (userText) {
              const parseAmountToNumber = (s: string): number | null => {
                const lower = s.toLowerCase().replace(/[,$\s]/g, "").trim();
                const m = lower.match(/^(\d+(?:\.\d+)?)(m)$/);
                const k = lower.match(/^(\d+(?:\.\d+)?)(k)$/);
                if (m) return Math.round(parseFloat(m[1]) * 1_000_000);
                if (k) return Math.round(parseFloat(k[1]) * 1_000);
                const n = Number(lower.replace(/[^0-9.]/g, ""));
                return Number.isFinite(n) ? Math.round(n) : null;
              };

              // 1) Targeted pattern allowing determiners between preposition and number (e.g., "on a 500,000 home")
              const targeted = userText.match(/(?:home|house|property|mortgage)\b[^\d$]{0,40}?\$?([\d,.]+\s*[kKmM]?)/i)
                || userText.match(/\$\s*([\d,.]+\s*[kKmM]?)/i)
                || userText.match(/([\d,.]+\s*[kKmM]?)\s*(?:home|house|property|mortgage)\b/i);

              const tryAssign = (raw: string | null | undefined) => {
                if (!raw) return false;
                const parsed = parseAmountToNumber(raw);
                if (parsed && parsed >= 50_000 && parsed <= 100_000_000) {
                  args.home_value = parsed;
                  console.log("[Inference] home_value inferred from user text", { home_value: parsed, source: userText });
                  return true;
                }
                return false;
              };

              let assigned = false;
              if (targeted && targeted[1]) {
                assigned = tryAssign(targeted[1]);
              }

              // 2) Fallback: scan for any plausible amount near keywords within a small window
              if (!assigned) {
                const keywordRe = /(home|house|property|mortgage)/i;
                const amountRe = /\$?\b(\d{1,3}(?:[.,]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s*[kKmM]?)\b/g;
                let match: RegExpExecArray | null;
                while ((match = amountRe.exec(userText)) !== null) {
                  const start = Math.max(0, match.index - 40);
                  const end = Math.min(userText.length, amountRe.lastIndex + 40);
                  const windowText = userText.slice(start, end);
                  if (keywordRe.test(windowText)) {
                    if (tryAssign(match[1])) { assigned = true; break; }
                  }
                }
              }
            }
          }
          if ((args.term_years === undefined || args.term_years === null) && userText) {
            const tm = userText.match(/\b(\d{1,2})\s*[- ]?(?:year|yr|y)\b/i) || userText.match(/\b(10|15|20|25|30)\s*[- ]?(?:fixed|mortgage)\b/i);
            if (tm && tm[1]) {
              const ty = parseInt(tm[1], 10);
              if (ty >= 5 && ty <= 40) {
                args.term_years = ty;
              }
            }
          }
          if ((args.rate_apr === undefined || args.rate_apr === null) && userText) {
            const rm = userText.match(/\b(\d{1,2}(?:\.\d+)?)\s*%\b/i) || userText.match(/\b(?:rate|apr|at)\s*(\d{1,2}(?:\.\d+)?)\b/i);
            if (rm && rm[1]) {
              const rv = parseFloat(rm[1]);
              if (rv > 0 && rv < 25) {
                args.rate_apr = rv;
              }
            }
          }
          if ((args.zip_code === undefined || args.zip_code === null) && userText) {
            const zm = userText.match(/\b(\d{5})\b/);
            if (zm && zm[1]) {
              args.zip_code = zm[1];
            }
          }
          if ((args.down_payment_value === undefined || args.down_payment_value === null) && userText) {
            let dpm = userText.match(/\$\s*([\d,.]+)\s*(?:down|dp)\b/i);
            if (dpm && dpm[1]) {
              const n = Number(dpm[1].replace(/[^0-9.]/g, ""));
              if (Number.isFinite(n) && n >= 0) {
                args.down_payment_value = Math.round(n);
              }
            } else {
              const ppm = userText.match(/\b(\d{1,2}(?:\.\d+)?)\s*%\s*(?:down|dp|down\s*payment)\b/i) || userText.match(/\b(?:down|dp|down\s*payment)[^\d%]{0,20}(\d{1,2}(?:\.\d+)?)\s*%\b/i);
              if (ppm && ppm[1] && typeof args.home_value === "number" && args.home_value > 0) {
                const pct = parseFloat(ppm[1]);
                if (pct >= 0 && pct <= 100) {
                  args.down_payment_value = Math.round(args.home_value * (pct / 100));
                }
              }
            }
          }
        } catch (e) {
          console.warn("Parameter inference from meta failed", e);
        }

        const responseTime = Date.now() - startTime;

        // Infer likely user query from parameters
        const inferredQuery = [];
        if (args.home_value) inferredQuery.push(`home value: $${args.home_value.toLocaleString()}`);
        if (args.down_payment_value) inferredQuery.push(`down payment: $${args.down_payment_value.toLocaleString()}`);
        if (args.loan_type) inferredQuery.push(`loan type: ${args.loan_type}`);
        if (args.term_years) inferredQuery.push(`${args.term_years}-year term`);
        if (args.rate_apr) inferredQuery.push(`${args.rate_apr}% APR`);

        logAnalytics("tool_call_success", {
          toolName: request.params.name,
          params: args,
          inferredQuery: inferredQuery.length > 0 ? inferredQuery.join(", ") : "mortgage calculator",
          responseTime,
          device: deviceCategory,
          userLocation: userLocation
            ? {
                city: userLocation.city,
                region: userLocation.region,
                country: userLocation.country,
                timezone: userLocation.timezone,
              }
            : null,
          userLocale,
          userAgent,
        });

        // Generate fresh URI with timestamp on every tool call to bust ChatGPT's cache
        const widgetMetadata = widgetMeta(widget, true);
        console.log(`[MCP] Tool called: ${request.params.name}, returning templateUri: ${(widgetMetadata as any)["openai/outputTemplate"]}`);

        return {
          content: [
            {
              type: "text",
              text: widget.responseText,
            },
          ],
          structuredContent: {
            ready: true,
            timestamp: new Date().toISOString(),
            currentRate: fredRateCache?.payload?.ratePercent ?? null,
            // Flatten parsed parameters directly into structuredContent
            loan_type: args.loan_type,
            home_value: args.home_value,
            down_payment_value: args.down_payment_value,
            rate_apr: args.rate_apr,
            term_years: args.term_years,
            zip_code: args.zip_code,
            credit_score: args.credit_score,
            property_tax_input: args.property_tax_input,
            homeowners_insurance_yearly: args.homeowners_insurance_yearly,
            hoa_monthly: args.hoa_monthly,
            pmi_pct: args.pmi_pct,
            annual_mi_pct: args.annual_mi_pct,
            upfront_fee_pct: args.upfront_fee_pct,
            finance_upfront_fee: args.finance_upfront_fee,
            start_month: args.start_month,
            start_year: args.start_year,
            extra_principal_monthly: args.extra_principal_monthly,
            extra_start_month_index: args.extra_start_month_index,
            summary: computeSummary(args),
            suggested_followups: [
              "Help me reduce my monthly payment",
              "Compare 15 vs 30 year for my inputs",
              "What if property taxes are 1.2%?",
            ],
          },
          _meta: widgetMetadata,
        };
      } catch (error: any) {
        logAnalytics("tool_call_error", {
          error: error.message,
          stack: error.stack,
          responseTime: Date.now() - startTime,
          device: deviceCategory,
          userAgent: userAgentString,
        });
        throw error;
      }
    }
  );

  return server;
}

type SessionRecord = {
  server: Server;
  transport: SSEServerTransport;
};

const sessions = new Map<string, SessionRecord>();

const ssePath = "/mcp";
const postPath = "/mcp/messages";
const subscribePath = "/api/subscribe";
const analyticsPath = "/analytics";
const trackEventPath = "/api/track";
const healthPath = "/health";
const ratePath = "/api/rate";

const ANALYTICS_PASSWORD = process.env.ANALYTICS_PASSWORD || "changeme123";

function checkAnalyticsAuth(req: IncomingMessage): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return false;
  }

  const base64Credentials = authHeader.split(" ")[1];
  const credentials = Buffer.from(base64Credentials, "base64").toString("utf8");
  const [username, password] = credentials.split(":");

  return username === "admin" && password === ANALYTICS_PASSWORD;
}

function humanizeEventName(event: string): string {
  const eventMap: Record<string, string> = {
    tool_call_success: "Tool Call Success",
    tool_call_error: "Tool Call Error",
    parameter_parse_error: "Parameter Parse Error",
    widget_file_claim_click: "File Claim Click",
    widget_share_click: "Share Click",
    widget_notify_me_subscribe: "Notify Me Subscribe",
    widget_carousel_prev: "Carousel Previous",
    widget_carousel_next: "Carousel Next",
    widget_filter_age_change: "Filter: Age Change",
    widget_filter_state_change: "Filter: State Change",
    widget_filter_sort_change: "Filter: Sort Change",
    widget_filter_category_change: "Filter: Category Change",
    widget_user_feedback: "User Feedback",
    widget_test_event: "Test Event",
    widget_followup_click: "Follow-up Click",
    widget_toggle_biweekly: "Toggle Biweekly",
    widget_slider_rate_change: "Rate Slider Change",
    widget_slider_down_payment_change: "Down Payment Slider Change",
  };
  return eventMap[event] || event;
}

function formatEventDetails(log: AnalyticsEvent): string {
  const excludeKeys = ["timestamp", "event"];
  const details: Record<string, any> = {};
  
  Object.keys(log).forEach((key) => {
    if (!excludeKeys.includes(key)) {
      details[key] = log[key];
    }
  });
  
  if (Object.keys(details).length === 0) {
    return "—";
  }
  
  return JSON.stringify(details, null, 0);
}

function generateAnalyticsDashboard(logs: AnalyticsEvent[]): string {
  const errorLogs = logs.filter((l) => l.event.includes("error"));
  const successLogs = logs.filter((l) => l.event === "tool_call_success");
  const parseLogs = logs.filter((l) => l.event === "parameter_parse_error");
  const widgetEvents = logs.filter((l) => l.event.startsWith("widget_"));

  const avgResponseTime =
    successLogs.length > 0
      ? (successLogs.reduce((sum, l) => sum + (l.responseTime || 0), 0) /
          successLogs.length).toFixed(0)
      : "N/A";

  const paramUsage: Record<string, number> = {};
  const categoryDist: Record<string, number> = {};
  const companySearches: Record<string, number> = {};
  
  successLogs.forEach((log) => {
    if (log.params) {
      Object.keys(log.params).forEach((key) => {
        if (log.params[key] !== undefined) {
          paramUsage[key] = (paramUsage[key] || 0) + 1;
          
          if (key === "category") {
            categoryDist[log.params[key]] = (categoryDist[log.params[key]] || 0) + 1;
          }
          if (key === "companyName") {
            companySearches[log.params[key]] = (companySearches[log.params[key]] || 0) + 1;
          }
        }
      });
    }
  });
  
  const widgetInteractions: Record<string, number> = {};
  widgetEvents.forEach((log) => {
    const humanName = humanizeEventName(log.event);
    widgetInteractions[humanName] = (widgetInteractions[humanName] || 0) + 1;
  });
  
  // Category selections count
  const categorySelections: Record<string, number> = {};
  widgetEvents.filter(l => l.event === "widget_filter_category_change").forEach((log) => {
    if (log.to) {
      categorySelections[log.to] = (categorySelections[log.to] || 0) + 1;
    }
  });
  
  // Age selections count
  const ageSelections: Record<string, number> = {};
  widgetEvents.filter(l => l.event === "widget_filter_age_change").forEach((log) => {
    if (log.to) {
      ageSelections[log.to] = (ageSelections[log.to] || 0) + 1;
    }
  });
  
  // Sort selections count
  const sortSelections: Record<string, number> = {};
  widgetEvents.filter(l => l.event === "widget_filter_sort_change").forEach((log) => {
    if (log.to) {
      sortSelections[log.to] = (sortSelections[log.to] || 0) + 1;
    }
  });
  
  // Clicks per settlement
  const settlementClicks: Record<string, { name: string; count: number }> = {};
  widgetEvents.filter(l => l.event === "widget_file_claim_click").forEach((log) => {
    if (log.settlementId) {
      if (!settlementClicks[log.settlementId]) {
        settlementClicks[log.settlementId] = { name: log.settlementName || log.settlementId, count: 0 };
      }
      settlementClicks[log.settlementId].count++;
    }
  });

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Class Action Finder Analytics</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #1a1a1a; margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .card h2 { font-size: 14px; color: #666; text-transform: uppercase; margin-bottom: 10px; }
    .card .value { font-size: 32px; font-weight: bold; color: #1a1a1a; }
    .card.error .value { color: #dc2626; }
    .card.success .value { color: #16a34a; }
    .card.warning .value { color: #ea580c; }
    table { width: 100%; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e5e5e5; }
    th { background: #f9fafb; font-weight: 600; color: #374151; font-size: 12px; text-transform: uppercase; }
    td { color: #1f2937; font-size: 14px; }
    tr:last-child td { border-bottom: none; }
    .error-row { background: #fef2f2; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .timestamp { color: #9ca3af; font-size: 12px; }
    td strong { color: #1f2937; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Class Action Finder Analytics</h1>
    <p class="subtitle">Last 7 days • Auto-refresh every 60s</p>
    
    <div class="grid">
      <div class="card success">
        <h2>Total Calls</h2>
        <div class="value">${successLogs.length}</div>
      </div>
      <div class="card error">
        <h2>Errors</h2>
        <div class="value">${errorLogs.length}</div>
      </div>
      <div class="card warning">
        <h2>Parse Errors</h2>
        <div class="value">${parseLogs.length}</div>
      </div>
      <div class="card">
        <h2>Avg Response Time</h2>
        <div class="value">${avgResponseTime}<span style="font-size: 16px; color: #666;">ms</span></div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 20px;">
      <h2>Parameter Usage</h2>
      <table>
        <thead><tr><th>Parameter</th><th>Times Used</th><th>Usage %</th></tr></thead>
        <tbody>
          ${Object.entries(paramUsage)
            .sort((a, b) => b[1] - a[1])
            .map(
              ([param, count]) => `
            <tr>
              <td><code>${param}</code></td>
              <td>${count}</td>
              <td>${((count / successLogs.length) * 100).toFixed(1)}%</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>

    <div class="grid" style="margin-bottom: 20px;">
      <div class="card">
        <h2>Category Distribution</h2>
        <table>
          <thead><tr><th>Category</th><th>Searches</th></tr></thead>
          <tbody>
            ${Object.entries(categoryDist).length > 0 ? Object.entries(categoryDist)
              .sort((a, b) => b[1] - a[1])
              .map(
                ([cat, count]) => `
              <tr>
                <td>${cat}</td>
                <td>${count}</td>
              </tr>
            `
              )
              .join("") : '<tr><td colspan="2" style="text-align: center; color: #9ca3af;">No data yet</td></tr>'}
          </tbody>
        </table>
      </div>
      
      <div class="card">
        <h2>Company Searches</h2>
        <table>
          <thead><tr><th>Company</th><th>Searches</th></tr></thead>
          <tbody>
            ${Object.entries(companySearches).length > 0 ? Object.entries(companySearches)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(
                ([company, count]) => `
              <tr>
                <td>${company}</td>
                <td>${count}</td>
              </tr>
            `
              )
              .join("") : '<tr><td colspan="2" style="text-align: center; color: #9ca3af;">No data yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-bottom: 20px;">
      <h2>Widget Interactions</h2>
      <table>
        <thead><tr><th>Action</th><th>Count</th></tr></thead>
        <tbody>
          ${Object.entries(widgetInteractions).length > 0 ? Object.entries(widgetInteractions)
            .sort((a, b) => b[1] - a[1])
            .map(
              ([action, count]) => `
            <tr>
              <td>${action}</td>
              <td>${count}</td>
            </tr>
          `
            )
            .join("") : '<tr><td colspan="2" style="text-align: center; color: #9ca3af;">No data yet</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="grid" style="margin-bottom: 20px;">
      <div class="card">
        <h2>Category Selections</h2>
        <table>
          <thead><tr><th>Category</th><th>Selections</th></tr></thead>
          <tbody>
            ${Object.entries(categorySelections).length > 0 ? Object.entries(categorySelections)
              .sort((a, b) => b[1] - a[1])
              .map(
                ([category, count]) => `
              <tr>
                <td>${category}</td>
                <td>${count}</td>
              </tr>
            `
              )
              .join("") : '<tr><td colspan="2" style="text-align: center; color: #9ca3af;">No data yet</td></tr>'}
          </tbody>
        </table>
      </div>
      
      <div class="card">
        <h2>Age Range Selections</h2>
        <table>
          <thead><tr><th>Age Range</th><th>Selections</th></tr></thead>
          <tbody>
            ${Object.entries(ageSelections).length > 0 ? Object.entries(ageSelections)
              .sort((a, b) => b[1] - a[1])
              .map(
                ([age, count]) => `
              <tr>
                <td>${age}</td>
                <td>${count}</td>
              </tr>
            `
              )
              .join("") : '<tr><td colspan="2" style="text-align: center; color: #9ca3af;">No data yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid" style="margin-bottom: 20px;">
      <div class="card">
        <h2>Sort Selections</h2>
        <table>
          <thead><tr><th>Sort By</th><th>Selections</th></tr></thead>
          <tbody>
            ${Object.entries(sortSelections).length > 0 ? Object.entries(sortSelections)
              .sort((a, b) => b[1] - a[1])
              .map(
                ([sort, count]) => `
              <tr>
                <td>${sort}</td>
                <td>${count}</td>
              </tr>
            `
              )
              .join("") : '<tr><td colspan="2" style="text-align: center; color: #9ca3af;">No data yet</td></tr>'}
          </tbody>
        </table>
      </div>
      
      <div class="card">
        <h2>File Claim Clicks by Settlement</h2>
        <table>
          <thead><tr><th>Settlement</th><th>Clicks</th></tr></thead>
          <tbody>
            ${Object.entries(settlementClicks).length > 0 ? Object.entries(settlementClicks)
              .sort((a, b) => b[1].count - a[1].count)
              .slice(0, 10)
              .map(
                ([id, data]) => `
              <tr>
                <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${data.name}</td>
                <td>${data.count}</td>
              </tr>
            `
              )
              .join("") : '<tr><td colspan="2" style="text-align: center; color: #9ca3af;">No data yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-bottom: 20px;">
      <h2>User Queries (Inferred from Tool Calls)</h2>
      <table>
        <thead><tr><th>Date</th><th>Query</th><th>Location</th><th>Locale</th></tr></thead>
        <tbody>
          ${successLogs.length > 0 ? successLogs
            .slice(0, 20)
            .map(
              (log) => `
            <tr>
              <td class="timestamp" style="white-space: nowrap;">${new Date(log.timestamp).toLocaleString()}</td>
              <td style="max-width: 400px;">${log.inferredQuery || "general search"}</td>
              <td style="font-size: 12px; color: #6b7280;">${log.userLocation ? `${log.userLocation.city || ''}, ${log.userLocation.region || ''}, ${log.userLocation.country || ''}`.replace(/^, |, $/g, '') : '—'}</td>
              <td style="font-size: 12px; color: #6b7280;">${log.userLocale || '—'}</td>
            </tr>
          `
            )
            .join("") : '<tr><td colspan="4" style="text-align: center; color: #9ca3af;">No queries yet</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card" style="margin-bottom: 20px;">
      <h2>User Feedback</h2>
      <table>
        <thead><tr><th>Date</th><th>Feedback</th></tr></thead>
        <tbody>
          ${logs.filter(l => l.event === "widget_user_feedback").length > 0 ? logs
            .filter(l => l.event === "widget_user_feedback")
            .slice(0, 20)
            .map(
              (log) => `
            <tr>
              <td class="timestamp" style="white-space: nowrap;">${new Date(log.timestamp).toLocaleString()}</td>
              <td style="max-width: 600px;">${log.feedback || "—"}</td>
            </tr>
          `
            )
            .join("") : '<tr><td colspan="2" style="text-align: center; color: #9ca3af;">No feedback yet</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Recent Events (Last 50)</h2>
      <table>
        <thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead>
        <tbody>
          ${logs
            .slice(0, 50)
            .map(
              (log) => `
            <tr class="${log.event.includes("error") ? "error-row" : ""}">
              <td class="timestamp">${new Date(log.timestamp).toLocaleString()}</td>
              <td><strong>${humanizeEventName(log.event)}</strong></td>
              <td style="font-size: 12px; max-width: 600px; overflow: hidden; text-overflow: ellipsis;">${formatEventDetails(log)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  </div>
  <script>setTimeout(() => location.reload(), 60000);</script>
</body>
</html>`;
}

async function handleAnalytics(req: IncomingMessage, res: ServerResponse) {
  if (!checkAnalyticsAuth(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Analytics Dashboard"',
      "Content-Type": "text/plain",
    });
    res.end("Authentication required");
    return;
  }

  try {
    const logs = getRecentLogs(7);
    const html = generateAnalyticsDashboard(logs);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } catch (error) {
    console.error("Analytics error:", error);
    res.writeHead(500).end("Failed to generate analytics");
  }
}

async function handleTrackEvent(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    const { event, data } = JSON.parse(body);

    if (!event) {
      res.writeHead(400).end(JSON.stringify({ error: "Missing event name" }));
      return;
    }

    logAnalytics(`widget_${event}`, data || {});

    res.writeHead(200).end(JSON.stringify({ success: true }));
  } catch (error) {
    console.error("Track event error:", error);
    res.writeHead(500).end(JSON.stringify({ error: "Failed to track event" }));
  }
}

// Turnstile verification
async function verifyTurnstile(token: string): Promise<boolean> {
  const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
  
  // Accept fallback tokens when Turnstile fails to load (e.g., in iframes)
  if (token === 'auto-verified-fallback' || token === 'error-fallback' || token === 'render-error-fallback') {
    console.warn(`Turnstile fallback used: ${token}`);
    return true; // Allow subscription to proceed
  }
  
  if (!TURNSTILE_SECRET_KEY) {
    console.error("TURNSTILE_SECRET_KEY not set in environment variables");
    return false;
  }

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        secret: TURNSTILE_SECRET_KEY,
        response: token,
      }),
    });

    const data = await response.json();
    return data.success === true;
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return false;
  }
}

// Buttondown API integration
async function subscribeToButtondown(email: string, settlementId: string, settlementName: string, deadline: string | null) {
  const BUTTONDOWN_API_KEY = process.env.BUTTONDOWN_API_KEY;
  
  if (!BUTTONDOWN_API_KEY) {
    throw new Error("BUTTONDOWN_API_KEY not set in environment variables");
  }

  const metadata: Record<string, any> = {
    settlementName,
    subscribedAt: new Date().toISOString(),
  };

  // Only add deadline if it's provided (not null for global notifications)
  if (deadline) {
    metadata.deadline = deadline;
  }

  const response = await fetch("https://api.buttondown.email/v1/subscribers", {
    method: "POST",
    headers: {
      "Authorization": `Token ${BUTTONDOWN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: email,
      tags: [settlementId],
      metadata,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = "Failed to subscribe";
    
    try {
      const errorData = JSON.parse(errorText);
      if (errorData.detail) {
        errorMessage = errorData.detail;
      } else if (errorData.code) {
        errorMessage = `Error: ${errorData.code}`;
      }
    } catch {
      errorMessage = errorText;
    }
    
    throw new Error(errorMessage);
  }

  return await response.json();
}

// Update existing subscriber with new settlement
async function updateButtondownSubscriber(email: string, settlementId: string, settlementName: string, deadline: string | null) {
  const BUTTONDOWN_API_KEY = process.env.BUTTONDOWN_API_KEY;
  
  if (!BUTTONDOWN_API_KEY) {
    throw new Error("BUTTONDOWN_API_KEY not set in environment variables");
  }

  // First, get the subscriber ID
  const searchResponse = await fetch(`https://api.buttondown.email/v1/subscribers?email=${encodeURIComponent(email)}`, {
    method: "GET",
    headers: {
      "Authorization": `Token ${BUTTONDOWN_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!searchResponse.ok) {
    throw new Error("Failed to find subscriber");
  }

  const subscribers = await searchResponse.json();
  if (!subscribers.results || subscribers.results.length === 0) {
    throw new Error("Subscriber not found");
  }

  const subscriber = subscribers.results[0];
  const subscriberId = subscriber.id;

  // Update the subscriber with new tag and metadata
  const existingTags = subscriber.tags || [];
  const existingMetadata = subscriber.metadata || {};

  // Add new settlement to tags if not already there
  const updatedTags = existingTags.includes(settlementId) ? existingTags : [...existingTags, settlementId];

  // Add new settlement to metadata (Buttondown requires string values)
  const settlementKey = `settlement_${settlementId}`;
  const settlementData = JSON.stringify({
    name: settlementName,
    deadline: deadline,
    subscribedAt: new Date().toISOString(),
  });
  
  const updatedMetadata = {
    ...existingMetadata,
    [settlementKey]: settlementData,
  };

  const updateResponse = await fetch(`https://api.buttondown.email/v1/subscribers/${subscriberId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Token ${BUTTONDOWN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tags: updatedTags,
      metadata: updatedMetadata,
    }),
  });

  if (!updateResponse.ok) {
    const errorText = await updateResponse.text();
    throw new Error(`Failed to update subscriber: ${errorText}`);
  }

  return await updateResponse.json();
}

async function handleSubscribe(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    const { email, settlementId, settlementName, deadline, turnstileToken } = JSON.parse(body);

    if (!email || !email.includes("@")) {
      res.writeHead(400).end(JSON.stringify({ error: "Invalid email address" }));
      return;
    }

    if (!settlementId || !settlementName) {
      res.writeHead(400).end(JSON.stringify({ error: "Missing required fields" }));
      return;
    }

    // Verify Turnstile token
    if (!turnstileToken) {
      res.writeHead(400).end(JSON.stringify({ error: "Security verification required" }));
      return;
    }

    const isValidToken = await verifyTurnstile(turnstileToken);
    if (!isValidToken) {
      res.writeHead(400).end(JSON.stringify({ error: "Security verification failed. Please try again." }));
      return;
    }

    const BUTTONDOWN_API_KEY_PRESENT = !!process.env.BUTTONDOWN_API_KEY;
    if (!BUTTONDOWN_API_KEY_PRESENT) {
      res.writeHead(500).end(JSON.stringify({ error: "Server misconfigured: BUTTONDOWN_API_KEY missing" }));
      return;
    }

    try {
      await subscribeToButtondown(email, settlementId, settlementName, deadline || null);
      res.writeHead(200).end(JSON.stringify({ 
        success: true, 
        message: "Successfully subscribed! You'll receive a reminder before the deadline." 
      }));
    } catch (subscribeError: any) {
      const rawMessage = String(subscribeError?.message ?? "").trim();
      const msg = rawMessage.toLowerCase();
      const already = msg.includes('already subscribed') || msg.includes('already exists') || msg.includes('already on your list') || msg.includes('subscriber already exists') || msg.includes('already');

      if (already) {
        console.log("Subscriber already on list, attempting update", { email, settlementId, message: rawMessage });
        try {
          await updateButtondownSubscriber(email, settlementId, settlementName, deadline || null);
          res.writeHead(200).end(JSON.stringify({ 
            success: true, 
            message: "Settlement added to your subscriptions!" 
          }));
        } catch (updateError: any) {
          console.warn("Update subscriber failed, returning graceful success", {
            email,
            settlementId,
            error: updateError?.message,
          });
          res.writeHead(200).end(JSON.stringify({
            success: true,
            message: "You're already subscribed! We'll keep you posted.",
          }));
        }
        return;
      }

      throw subscribeError;
    }
  } catch (error: any) {
    console.error("Subscribe error:", error);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    res.writeHead(500).end(JSON.stringify({ 
      error: error.message || "Failed to subscribe. Please try again." 
    }));
  }
}

async function handleSseRequest(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const server = createMortgageCalculatorServer();
  const transport = new SSEServerTransport(postPath, res);
  const sessionId = transport.sessionId;

  sessions.set(sessionId, { server, transport });

  transport.onclose = async () => {
    sessions.delete(sessionId);
    await server.close();
  };

  transport.onerror = (error) => {
    console.error("SSE transport error", error);
  };

  try {
    await server.connect(transport);
  } catch (error) {
    sessions.delete(sessionId);
    console.error("Failed to start SSE session", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to establish SSE connection");
    }
  }
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    res.writeHead(400).end("Missing sessionId query parameter");
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    res.writeHead(404).end("Unknown session");
    return;
  }

  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Failed to process message", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to process message");
    }
  }
}

const portEnv = Number(process.env.PORT ?? 8000);
const port = Number.isFinite(portEnv) ? portEnv : 8000;

const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (
      req.method === "OPTIONS" &&
      (url.pathname === ssePath || url.pathname === postPath)
    ) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === healthPath) {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("OK");
      return;
    }

    if (req.method === "GET" && url.pathname === ssePath) {
      await handleSseRequest(res);
      return;
    }

    if (req.method === "POST" && url.pathname === postPath) {
      await handlePostMessage(req, res, url);
      return;
    }

    if (url.pathname === subscribePath) {
      await handleSubscribe(req, res);
      return;
    }

    if (url.pathname === ratePath) {
      await handleRate(req, res);
      return;
    }

    if (url.pathname === analyticsPath) {
      await handleAnalytics(req, res);
      return;
    }

    if (url.pathname === trackEventPath) {
      await handleTrackEvent(req, res);
      return;
    }

    // Serve alias for legacy loader path -> our main widget HTML
    if (req.method === "GET" && url.pathname === "/assets/mortgage-calculator-2d2b.html") {
      const mainAssetPath = path.join(ASSETS_DIR, "mortgage-calculator.html");
      if (fs.existsSync(mainAssetPath) && fs.statSync(mainAssetPath).isFile()) {
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(mainAssetPath).pipe(res);
        return;
      }
    }

    // Serve static assets from /assets directory
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const assetPath = path.join(ASSETS_DIR, url.pathname.slice(8));
      if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
        const ext = path.extname(assetPath);
        const contentType = ext === ".js" ? "application/javascript" : 
                           ext === ".css" ? "text/css" : 
                           ext === ".html" ? "text/html" : "application/octet-stream";
        res.writeHead(200, { 
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache"
        });

        // If serving the main widget HTML, inject the current rate into the badge
        if (ext === ".html" && path.basename(assetPath) === "mortgage-calculator.html") {
          try {
            let html = fs.readFileSync(assetPath, "utf8");
            // Compute the current rate (prefer cache, otherwise fetch)
            let displayRate: number | null = null;
            if (fredRateCache && fredRateCache.payload && typeof fredRateCache.payload.ratePercent === "number") {
              displayRate = fredRateCache.payload.ratePercent;
            } else {
              const latest = await fetchFredLatestRate();
              if (latest) {
                displayRate = Math.round((latest.adjusted) * 10) / 10;
              }
            }
            // Only inject if we have a valid live rate. Otherwise leave blank.
            if (displayRate != null && Number.isFinite(displayRate)) {
              const rateText = `${displayRate}%`;
              html = html.replace(
                /(<span\s+class=\"rate-num\">)([^<]*?)(<\/span>)/,
                (_m: any, p1: string, _p2: string, p3: string) => `${p1}${rateText}${p3}`
              );
            }
            res.end(html);
            return;
          } catch (e) {
            // Fallback to streaming the file unchanged if anything goes wrong
          }
        }

        fs.createReadStream(assetPath).pipe(res);
        return;
      }
    }

    res.writeHead(404).end("Not Found");
  }
);

httpServer.on("clientError", (err: Error, socket) => {
  console.error("HTTP client error", err);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

httpServer.listen(port, () => {
  console.log(`Mortgage Calculator MCP server listening on http://localhost:${port}`);
  console.log(`  SSE stream: GET http://localhost:${port}${ssePath}`);
  console.log(
    `  Message post endpoint: POST http://localhost:${port}${postPath}?sessionId=...`
  );
});
