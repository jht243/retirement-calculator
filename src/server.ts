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

type BmiHealthWidget = {
  id: string;
  title: string;
  templateUri: string;
  invoking: string;
  invoked: string;
  html: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve project root: prefer ASSETS_ROOT only if it actually has an assets/ directory
const DEFAULT_ROOT_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = (() => {
  const envRoot = process.env.ASSETS_ROOT;
  if (envRoot) {
    const candidate = path.resolve(envRoot);
    try {
      const candidateAssets = path.join(candidate, "assets");
      if (fs.existsSync(candidateAssets)) {
        return candidate;
      }
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_ROOT_DIR;
})();

const ASSETS_DIR = path.resolve(ROOT_DIR, "assets");
const LOGS_DIR = path.resolve(__dirname, "..", "logs");
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || "";

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// FRED daily mortgage rate endpoint logic removed for BMI Health Calculator
type RateCache = { ts: number; payload: any } | null;
let fredRateCache: RateCache = null;

async function fetchFredLatestRate(): Promise<{ raw: number; adjusted: number; observationDate: string; source: string; } | null> {
  // FRED integration is disabled/removed for BMI context
  return null;
}

async function handleRate(req: IncomingMessage, res: ServerResponse) {
  // ...
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200).end(JSON.stringify({ note: "Rate endpoint not used in BMI calculator" }));
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
  const height = Number(args.height_cm);
  const weight = Number(args.weight_kg);
  const age = Number(args.age_years);
  const gender = args.gender;
  const waist = Number(args.waist_cm);
  const hip = Number(args.hip_cm);
  const neck = Number(args.neck_cm);
  const activity = args.activity_level || "sedentary";

  if (!height || !weight) {
    return {
      bmi: null,
      bmi_category: null,
      ideal_weight_min: null,
      ideal_weight_max: null,
      body_fat_pct: null,
      tdee_calories: null,
    };
  }

  // BMI Calculation
  const heightM = height / 100;
  const bmi = weight / (heightM * heightM);
  
  let bmiCategory = "Normal weight";
  if (bmi < 18.5) bmiCategory = "Underweight";
  else if (bmi >= 25 && bmi < 30) bmiCategory = "Overweight";
  else if (bmi >= 30) bmiCategory = "Obese";

  // Ideal Body Weight (Devine Formula)
  // Male: 50 kg + 2.3 kg per inch over 5 feet
  // Female: 45.5 kg + 2.3 kg per inch over 5 feet
  const heightInches = height / 2.54;
  const inchesOver60 = Math.max(0, heightInches - 60);
  let idealWeight = 0;
  if (gender === "female") {
    idealWeight = 45.5 + (2.3 * inchesOver60);
  } else {
    // Default to male if unknown
    idealWeight = 50.0 + (2.3 * inchesOver60);
  }
  const idealWeightMin = Math.round((idealWeight * 0.9) * 10) / 10;
  const idealWeightMax = Math.round((idealWeight * 1.1) * 10) / 10;

  // Body Fat (U.S. Navy Method)
    // Male: 495 / (1.0324 - 0.19077(log10(waist-neck)) + 0.15456(log10(height))) - 450
    // Female: 495 / (1.29579 - 0.35004(log10(waist+hip-neck)) + 0.22100(log10(height))) - 450
  let bodyFat = null;
  if (waist && neck && height) {
      const h = height;
      const w = waist;
      const n = neck;
      
      if (gender === 'male') {
        // D = 1.0324 - 0.19077 * log10(W-N) + 0.15456 * log10(H)
        if (w > n) {
            const density = 1.0324 - 0.19077 * Math.log10(w - n) + 0.15456 * Math.log10(h);
            bodyFat = (495 / density) - 450;
        }
      } else if (gender === 'female' && hip) {
        // D = 1.29579 - 0.35004 * Math.log10(waist + hip - n) + 0.22100 * Math.log10(h);
        if (w + hip > n) {
            const density = 1.29579 - 0.35004 * Math.log10(w + hip - n) + 0.22100 * Math.log10(h);
            bodyFat = (495 / density) - 450;
        }
      }
  }

  // TDEE / Calorie Calculation (Mifflin-St Jeor)
  // Men: 10*W + 6.25*H - 5*A + 5
  // Women: 10*W + 6.25*H - 5*A - 161
  let bmr = 0;
  if (gender === 'female') {
    bmr = (10 * weight) + (6.25 * height) - (5 * (age || 30)) - 161;
  } else {
    bmr = (10 * weight) + (6.25 * height) - (5 * (age || 30)) + 5;
  }

  const activityMultipliers: Record<string, number> = {
    "sedentary": 1.2,
    "light": 1.375,
    "moderate": 1.55,
    "active": 1.725,
    "very_active": 1.9,
    "extra_active": 1.9
  };
  
  const tdee = Math.round(bmr * (activityMultipliers[activity] || 1.2));

  return {
    bmi: Math.round(bmi * 10) / 10,
    bmi_category: bmiCategory,
    ideal_weight_min: idealWeightMin,
    ideal_weight_max: idealWeightMax,
    body_fat_pct: bodyFat ? Math.round(bodyFat * 10) / 10 : null,
    tdee_calories: tdee,
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
// Use git commit hash for deterministic cache-busting across deploys
// Added timestamp suffix to force cache invalidation for width fix
const VERSION = (process.env.RENDER_GIT_COMMIT?.slice(0, 7) || Date.now().toString()) + '-' + Date.now();

function widgetMeta(widget: BmiHealthWidget, bustCache: boolean = false) {
  const templateUri = bustCache
    ? `ui://widget/bmi-health-calculator.html?v=${VERSION}`
    : widget.templateUri;

  return {
    "openai/outputTemplate": templateUri,
    "openai/widgetDescription":
      "A comprehensive health calculator for BMI, Ideal Weight, Body Fat Percentage, and Calorie Needs.",
    "openai/componentDescriptions": {
      "metrics-form": "Input form for height, weight, age, gender, and other body measurements.",
      "bmi-card": "Card displaying the calculated Body Mass Index and health category.",
      "ideal-weight-card": "Card showing the estimated ideal weight range based on height and gender.",
      "body-fat-card": "Card showing estimated body fat percentage using the US Navy method.",
      "calorie-card": "Card showing daily calorie needs (TDEE) based on activity level."
    },
    "openai/widgetKeywords": [
      "bmi",
      "body fat",
      "ideal weight",
      "calories",
      "tdee",
      "health calculator",
      "weight loss",
      "fitness",
      "diet"
    ],
    "openai/sampleConversations": [
      { "user": "Calculate my BMI, I am 180cm and 75kg.", "assistant": "I can help with that. Here is your BMI calculation." },
      { "user": "What is my ideal weight if I'm 5'6\" female?", "assistant": "I've estimated your ideal weight range based on your height and gender." },
      { "user": "Estimate body fat for 30yo male, waist 90cm, neck 38cm, height 178cm.", "assistant": "Using the US Navy method, here is your estimated body fat percentage." },
      { "user": "How many calories should I eat to lose weight? I'm active.", "assistant": "I can calculate your daily calorie needs based on your activity level." }
    ],
    "openai/starterPrompts": [
      "Calculate BMI",
      "Ideal Weight",
      "Body Fat Calculator",
      "Calorie Calculator",
      "BMI Calculator",
      "Am I overweight?",
    ],
    "openai/widgetPrefersBorder": true,
    "openai/widgetCSP": {
      connect_domains: [
        "https://api.stlouisfed.org",
        "https://body-health-calculator.onrender.com",
        "http://localhost:8010",
        "https://challenges.cloudflare.com"
      ],
      script_src_domains: [
        "https://body-health-calculator.onrender.com",
        "https://challenges.cloudflare.com"
      ],
      resource_domains: [],
    },
    "openai/widgetDomain": "https://chatgpt.com",
    "openai/toolInvocation/invoking": widget.invoking,
    "openai/toolInvocation/invoked": widget.invoked,
    "openai/widgetAccessible": true,
    "openai/resultCanProduceWidget": true,
  } as const;
}

const widgets: BmiHealthWidget[] = [
  {
    id: "bmi-health-calculator",
    title: "BMI Health Calculator — analyze body mass index and health",
    templateUri: `ui://widget/bmi-health-calculator.html?v=${VERSION}`,
    invoking:
      "Opening the BMI Health Calculator...",
    invoked:
      "Here is the BMI Health Calculator. You can enter your height and weight.",
    html: readWidgetHtml("bmi-health-calculator"),
  },
];

const widgetsById = new Map<string, BmiHealthWidget>();
const widgetsByUri = new Map<string, BmiHealthWidget>();

widgets.forEach((widget) => {
  widgetsById.set(widget.id, widget);
  widgetsByUri.set(widget.templateUri, widget);
});

const toolInputSchema = {
  type: "object",
  properties: {
    height_cm: { type: "number", description: "Height in centimeters." },
    weight_kg: { type: "number", description: "Weight in kilograms." },
    age_years: { type: "number", description: "Age in years." },
    gender: { type: "string", enum: ["male", "female"], description: "Biological sex for formula selection." },
    waist_cm: { type: "number", description: "Waist circumference in cm (for body fat)." },
    hip_cm: { type: "number", description: "Hip circumference in cm (for body fat, female)." },
    neck_cm: { type: "number", description: "Neck circumference in cm (for body fat)." },
    activity_level: { 
        type: "string", 
        enum: ["sedentary", "light", "moderate", "active", "very_active", "extra_active"],
        description: "Activity level for TDEE calculation."
    }
  },
  required: [],
  additionalProperties: false,
  $schema: "http://json-schema.org/draft-07/schema#",
} as const;

const toolInputParser = z.object({
  height_cm: z.number().optional(),
  weight_kg: z.number().optional(),
  age_years: z.number().optional(),
  gender: z.enum(["male", "female"]).optional(),
  waist_cm: z.number().optional(),
  hip_cm: z.number().optional(),
  neck_cm: z.number().optional(),
  activity_level: z.enum(["sedentary", "light", "moderate", "active", "very_active", "extra_active"]).optional(),
});

const tools: Tool[] = widgets.map((widget) => ({
  name: widget.id,
  description:
    "Use this for BMI, Ideal Weight, and Body Fat analysis. It calculates health metrics based on height, weight, and other inputs.",
  inputSchema: toolInputSchema,
  outputSchema: {
    type: "object",
    properties: {
      ready: { type: "boolean" },
      timestamp: { type: "string" },
      height_cm: { type: "number" },
      weight_kg: { type: "number" },
      bmi: { type: "number" },
      input_source: { type: "string", enum: ["user", "default"] },
      summary: {
        type: "object",
        properties: {
          bmi: { type: ["number", "null"] },
          bmi_category: { type: ["string", "null"] },
          ideal_weight_min: { type: ["number", "null"] },
          ideal_weight_max: { type: ["number", "null"] },
          body_fat_pct: { type: ["number", "null"] },
          tdee_calories: { type: ["number", "null"] },
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
    "HTML template for the BMI, Fitness, Calorie, and Body Fat Health Calculator widget.",
  mimeType: "text/html+skybridge",
  _meta: widgetMeta(widget),
}));

const resourceTemplates: ResourceTemplate[] = widgets.map((widget) => ({
  uriTemplate: widget.templateUri,
  name: widget.title,
  description:
    "Template descriptor for the BMI, Fitness, Calorie, and Body Fat Health Calculator widget.",
  mimeType: "text/html+skybridge",
  _meta: widgetMeta(widget),
}));

function createBmiHealthCalculatorServer(): Server {
  const server = new Server(
    {
      name: "bmi-health-calculator",
      version: "0.1.0",
      description:
        "BMI Health Calculator is a comprehensive app for analyzing health metrics.",
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
      // (Logic removed for BMI calculator)
      let htmlToSend = widget.html;
      
      if (TURNSTILE_SITE_KEY) {
        htmlToSend = htmlToSend.replace(/__TURNSTILE_SITE_KEY__/g, TURNSTILE_SITE_KEY);
      } else {
        console.warn("[Turnstile] TURNSTILE_SITE_KEY missing; captcha will not render");
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
          logAnalytics("parameter_parse_error", {
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
            meta["openai/subject"],
            meta["openai/userPrompt"],
            meta["openai/userText"],
            meta["openai/lastUserMessage"],
            meta["openai/inputText"],
            meta["openai/requestText"],
          ];
          const userText = candidates.find((t) => typeof t === "string" && t.trim().length > 0) || "";

          const parseAmountToNumber = (s: string): number | null => {
            const lower = s.toLowerCase().replace(/[,$\s]/g, "").trim();
            const k = lower.match(/(\d+(?:\.\d+)?)(k)$/);
            if (k) return Math.round(parseFloat(k[1]) * 1_000);
            const n = Number(lower.replace(/[^0-9.]/g, ""));
            return Number.isFinite(n) ? Math.round(n) : null;
          };

          // Infer height and weight
          if (args.height_cm === undefined) {
            // Try to find "180 cm" or "1.8 m" or "5'10"
            const heightMatch = userText.match(/(\d+)\s*cm\b/i) || userText.match(/(\d+(?:\.\d+)?)\s*m\b/i);
            if (heightMatch) {
              let h = parseFloat(heightMatch[1]);
              if (heightMatch[0].includes("m")) h *= 100; // convert m to cm
              if (h > 50 && h < 300) args.height_cm = Math.round(h);
            }
            // Imperial: 5'10" or 5 ft 10
            const ftMatch = userText.match(/(\d+)'(\d+)(?:"|'')?/);
            if (ftMatch) {
              const ft = parseInt(ftMatch[1], 10);
              const inch = parseInt(ftMatch[2], 10);
              args.height_cm = Math.round((ft * 30.48) + (inch * 2.54));
            }
          }

          if (args.weight_kg === undefined) {
            // Try to find "75 kg" or "165 lbs"
            const weightMatch = userText.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilo|lbs|lb|pound|pounds)\b/i);
            if (weightMatch) {
              let w = parseFloat(weightMatch[1]);
              const unit = weightMatch[2].toLowerCase();
              if (unit.startsWith("lb") || unit.startsWith("pound")) {
                w = w * 0.453592;
              }
              if (w > 20 && w < 600) args.weight_kg = Math.round(w * 10) / 10;
            }
          }

          // Infer age
          if (args.age_years === undefined) {
            const ageMatch = userText.match(/\b(\d{1,3})\s*(?:yo|years|year old)\b/i);
            if (ageMatch) {
              const age = parseInt(ageMatch[1], 10);
              if (age > 0 && age < 120) args.age_years = age;
            }
          }

          // Infer gender
          if (args.gender === undefined) {
            if (/\b(?:male|man|boy|guy)\b/i.test(userText)) args.gender = "male";
            else if (/\b(?:female|woman|girl|lady)\b/i.test(userText)) args.gender = "female";
          }

          // Infer activity level
          if (args.activity_level === undefined) {
             if (/\b(?:sedentary|desk job|no exercise)\b/i.test(userText)) args.activity_level = "sedentary";
             else if (/\b(?:light|active|exercise)\b/i.test(userText)) args.activity_level = "light";
             else if (/\b(?:athlete|training|gym)\b/i.test(userText)) args.activity_level = "active";
          }

        } catch (e) {
          console.warn("Parameter inference from meta failed", e);
        }


        const responseTime = Date.now() - startTime;

        const fallbackDefaults = {
          height_cm: 170,
          weight_kg: 70,
          age_years: 30,
          gender: "male" as const,
          waist_cm: 80,
          hip_cm: 95,
          neck_cm: 40,
          activity_level: "moderate" as const,
        };

        let usedDefaults = false;

        (Object.keys(fallbackDefaults) as (keyof typeof fallbackDefaults)[]).forEach((key) => {
          if (args[key] === undefined || args[key] === null) {
            (args as any)[key] = fallbackDefaults[key];
            usedDefaults = true;
          }
        });

        // Infer likely user query from parameters
        const inferredQuery = [] as string[];
        if (args.height_cm) inferredQuery.push(`height: ${args.height_cm}cm`);
        if (args.weight_kg) inferredQuery.push(`weight: ${args.weight_kg}kg`);
        if (args.age_years) inferredQuery.push(`age: ${args.age_years}`);
        if (args.gender) inferredQuery.push(`gender: ${args.gender}`);
        if (args.activity_level) inferredQuery.push(`activity: ${args.activity_level}`);

        logAnalytics("tool_call_success", {
          toolName: request.params.name,
          params: args,
          inferredQuery: inferredQuery.length > 0 ? inferredQuery.join(", ") : "BMI Health Calculator",
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

        // Use a stable template URI so toolOutput reliably hydrates the component
        const widgetMetadata = widgetMeta(widget, false);
        console.log(`[MCP] Tool called: ${request.params.name}, returning templateUri: ${(widgetMetadata as any)["openai/outputTemplate"]}`);

        // Build structured content once so we can log it and return it.
        // For the health calculator, expose fields relevant to BMI/Body Fat
        const structured = {
          ready: true,
          timestamp: new Date().toISOString(),
          height_cm: args.height_cm,
          weight_kg: args.weight_kg,
          age_years: args.age_years,
          gender: args.gender,
            activity_level: args.activity_level,
          input_source: usedDefaults ? "default" : "user",
          // Summary + follow-ups for natural language UX
          summary: computeSummary(args),
          suggested_followups: [
            "How much weight should I lose?",
            "What is a healthy BMI range?",
            "Calculate body fat percentage",
              "What is my TDEE?"
          ],
        } as const;

        // Embed the widget resource in _meta to mirror official examples and improve hydration reliability
        const metaForReturn = {
          ...widgetMetadata,
          "openai.com/widget": {
            type: "resource",
            resource: {
              uri: widget.templateUri,
              mimeType: "text/html+skybridge",
              text: widget.html,
              title: widget.title,
            },
          },
        } as const;

        console.log("[MCP] Returning outputTemplate:", (metaForReturn as any)["openai/outputTemplate"]);
        console.log("[MCP] Returning structuredContent:", structured);

        // Log success analytics with rental parameters
        try {
          // Check for "empty" result - effectively when no main calculation inputs are provided
          // This mimics the "filteredSettlements.length === 0" logic from the prior project
          const hasMainInputs = args.height_cm || args.weight_kg || args.age_years;
          
          if (!hasMainInputs) {
             logAnalytics("tool_call_empty", {
               toolName: request.params.name,
               params: request.params.arguments || {},
               reason: "No calculation inputs provided"
             });
          } else {
          logAnalytics("tool_call_success", {
            responseTime,
            params: request.params.arguments || {},
            inferredQuery: inferredQuery.join(", "),
            userLocation,
            userLocale,
            device: deviceCategory,
          });
          }
        } catch {}

        return {
          structuredContent: structured,
          _meta: metaForReturn,
          content: [],
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

type AlertEntry = {
  id: string;
  level: "warning" | "critical";
  message: string;
};

function evaluateAlerts(logs: AnalyticsEvent[]): AlertEntry[] {
  const alerts: AlertEntry[] = [];
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  // 1. Tool Call Failures
  const toolErrors24h = logs.filter(
    (l) =>
      l.event === "tool_call_error" &&
      new Date(l.timestamp).getTime() >= dayAgo
  ).length;

  if (toolErrors24h > 5) {
    alerts.push({
      id: "tool-errors",
      level: "critical",
      message: `Tool failures in last 24h: ${toolErrors24h} (>5 threshold)`,
    });
  }

  // 2. Parameter Parsing Errors
  const parseErrorsWeek = logs.filter(
    (l) =>
      l.event === "parameter_parse_error" &&
      new Date(l.timestamp).getTime() >= weekAgo
  ).length;

  if (parseErrorsWeek > 3) {
    alerts.push({
      id: "parse-errors",
      level: "warning",
      message: `Parameter parse errors in last 7d: ${parseErrorsWeek} (>3 threshold)`,
    });
  }

  // 3. Empty Result Sets (or equivalent for calculator - e.g. missing inputs)
  const successCalls = logs.filter(
    (l) => l.event === "tool_call_success" && new Date(l.timestamp).getTime() >= weekAgo
  );
  const emptyResults = logs.filter(
    (l) => l.event === "tool_call_empty" && new Date(l.timestamp).getTime() >= weekAgo
  ).length;

  const totalCalls = successCalls.length + emptyResults;
  if (totalCalls > 0 && (emptyResults / totalCalls) > 0.2) {
    alerts.push({
      id: "empty-results",
      level: "warning",
      message: `Empty result rate ${((emptyResults / totalCalls) * 100).toFixed(1)}% (>20% threshold)`,
    });
  }

  // 5. Buttondown Subscription Failures
  const recentSubs = logs.filter(
    (l) =>
      (l.event === "widget_notify_me_subscribe" ||
        l.event === "widget_notify_me_subscribe_error") &&
      new Date(l.timestamp).getTime() >= weekAgo
  );

  const subFailures = recentSubs.filter(
    (l) => l.event === "widget_notify_me_subscribe_error"
  ).length;

  const failureRate =
    recentSubs.length > 0 ? subFailures / recentSubs.length : 0;

  if (recentSubs.length >= 5 && failureRate > 0.1) {
    alerts.push({
      id: "buttondown-failures",
      level: "warning",
      message: `Buttondown failure rate ${(failureRate * 100).toFixed(
        1
      )}% over last 7d (${subFailures}/${recentSubs.length})`,
    });
  }

  return alerts;
}

function generateAnalyticsDashboard(logs: AnalyticsEvent[], alerts: AlertEntry[]): string {
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
  const bmiCatDist: Record<string, number> = {};
  
  successLogs.forEach((log) => {
    if (log.params) {
      Object.keys(log.params).forEach((key) => {
        if (log.params[key] !== undefined) {
          paramUsage[key] = (paramUsage[key] || 0) + 1;
        }
      });
    }
    if (log.structuredContent?.summary?.bmi_category) {
       const cat = log.structuredContent.summary.bmi_category;
       bmiCatDist[cat] = (bmiCatDist[cat] || 0) + 1;
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
  // const settlementClicks: Record<string, { name: string; count: number }> = {};
  // widgetEvents.filter(l => l.event === "widget_file_claim_click").forEach((log) => {
  //   if (log.settlementId) {
  //     if (!settlementClicks[log.settlementId]) {
  //       settlementClicks[log.settlementId] = { name: log.settlementName || log.settlementId, count: 0 };
  //     }
  //     settlementClicks[log.settlementId].count++;
  //   }
  // });

  // Calculator Actions
  const actionCounts: Record<string, number> = {
    "Calculate": 0,
    "Subscribe": 0,
    "Donate": 0, 
    "Print": 0,
    "Reset": 0,
    "Photo Upload": 0
  };

  widgetEvents.forEach(log => {
      if (log.event === "widget_calculate_click") actionCounts["Calculate"]++;
      if (log.event === "widget_notify_me_subscribe") actionCounts["Subscribe"]++;
      if (log.event === "widget_donate_click") actionCounts["Donate"]++;
      if (log.event === "widget_print_click") actionCounts["Print"]++;
      if (log.event === "widget_reset_click") actionCounts["Reset"]++;
      if (log.event === "widget_photo_upload") actionCounts["Photo Upload"]++;
  });

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BMI Health Calculator Analytics</title>
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
    <h1>📊 BMI Health Calculator Analytics</h1>
    <p class="subtitle">Last 7 days • Auto-refresh every 60s</p>
    
    <div class="grid">
      <div class="card ${alerts.length ? "warning" : ""}">
        <h2>Alerts</h2>
        ${
          alerts.length
            ? `<ul style="padding-left:16px;margin:0;">${alerts
                .map(
                  (a) =>
                    `<li><strong>${a.level.toUpperCase()}</strong> — ${a.message}</li>`
                )
                .join("")}</ul>`
            : '<p style="color:#16a34a;">No active alerts</p>'
        }
      </div>
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
        <h2>BMI Categories</h2>
        <table>
          <thead><tr><th>Category</th><th>Count</th></tr></thead>
          <tbody>
            ${Object.entries(bmiCatDist).length > 0 ? Object.entries(bmiCatDist)
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
        <h2>User Actions</h2>
        <table>
          <thead><tr><th>Action</th><th>Count</th></tr></thead>
          <tbody>
            ${Object.entries(actionCounts)
              .sort((a, b) => b[1] - a[1])
              .map(
                ([action, count]) => `
              <tr>
                <td>${action}</td>
                <td>${count}</td>
              </tr>
            `
              )
              .join("")}
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
      
      <!-- Replaced File Claim Clicks with empty or other widget data -->
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
    const alerts = evaluateAlerts(logs);
    alerts.forEach((alert) =>
      console.warn("[ALERT]", alert.id, alert.message)
    );
    const html = generateAnalyticsDashboard(logs, alerts);
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
  
  if (!TURNSTILE_SECRET_KEY) {
    console.error("TURNSTILE_SECRET_KEY not set in environment variables");
    return false;
  }

  if (!token) {
    console.error("Turnstile token missing");
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
          logAnalytics("widget_notify_me_subscribe_error", {
            stage: "update",
            email,
            error: updateError?.message,
          });
          res.writeHead(200).end(JSON.stringify({
            success: true,
            message: "You're already subscribed! We'll keep you posted.",
          }));
        }
        return;
      }

      logAnalytics("widget_notify_me_subscribe_error", {
        stage: "subscribe",
        email,
        error: rawMessage || "unknown_error",
      });
      throw subscribeError;
    }
  } catch (error: any) {
    console.error("Subscribe error:", error);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    logAnalytics("widget_notify_me_subscribe_error", {
      stage: "handler",
      email: undefined,
      error: error.message || "unknown_error",
    });
    res.writeHead(500).end(JSON.stringify({ 
      error: error.message || "Failed to subscribe. Please try again." 
    }));
  }
}

async function handleSseRequest(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const server = createBmiHealthCalculatorServer();
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
    if (req.method === "GET" && url.pathname === "/assets/bmi-health-calculator.html") {
      const mainAssetPath = path.join(ASSETS_DIR, "bmi-health-calculator.html");
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
        const ext = path.extname(assetPath).toLowerCase();
        const contentTypeMap: Record<string, string> = {
          ".js": "application/javascript",
          ".css": "text/css",
          ".html": "text/html",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".png": "image/png",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml"
        };
        const contentType = contentTypeMap[ext] || "application/octet-stream";
        res.writeHead(200, { 
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache"
        });

        // If serving the main widget HTML, inject the current rate into the badge
        if (ext === ".html" && path.basename(assetPath) === "bmi-health-calculator.html") {
          try {
            let html = fs.readFileSync(assetPath, "utf8");
            
            if (TURNSTILE_SITE_KEY) {
              html = html.replace(/__TURNSTILE_SITE_KEY__/g, TURNSTILE_SITE_KEY);
            } else {
              console.warn("[Turnstile] TURNSTILE_SITE_KEY missing; captcha will not render");
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
  console.log(`BMI Health Calculator MCP server listening on http://localhost:${port}`);
  console.log(`  SSE stream: GET http://localhost:${port}${ssePath}`);
  console.log(
    `  Message post endpoint: POST http://localhost:${port}${postPath}?sessionId=...`
  );
});
