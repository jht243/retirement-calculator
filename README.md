# Retirement Calculator - ChatGPT MCP Connector

A Model Context Protocol (MCP) server that provides an interactive Retirement and finance calculator widget for ChatGPT. Helps users estimate retirement needs and analyze finance metrics.

## Features

- 💰 Calculate Retirement
- 📊 Simple inputs: height, weight, age (as proxies for financial data in this demo)
- 🔄 Interactive widget that appears directly in ChatGPT
- 📈 Shows retirement status breakdown

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm

### Installation

```bash
pnpm install
```

### Run Locally

```bash
pnpm start
```

Server runs on `http://localhost:8000`. **Note:** HTTP endpoints are for local development only. The SDK requires HTTPS for all production connections.

### Deploy to Render.com

1. Push this repo to GitHub
2. Connect to Render.com
3. Create new Web Service from this repo
4. Render will auto-detect `render.yaml` and deploy

Your permanent URL: `https://your-app.onrender.com/mcp`

### Transport Security

- **Production:** Always access the MCP endpoints via `https://…` (Render automatically provisions TLS). Never expose the widget or APIs over plain HTTP in production.
- **Local development:** The only allowed HTTP endpoint is `http://localhost:8000` while running `npm start`. Do not publish that URL or tunnel it publicly.
- **External monitors/webhooks:** When configuring Pingdom, Datadog, etc., use the HTTPS endpoint (`https://your-app.onrender.com/analytics`, `…/mcp`, etc.) to keep telemetry encrypted end-to-end.

## How to Use in ChatGPT

1. Open ChatGPT in **Developer Mode**
2. Add MCP Connector with URL: `https://your-app.onrender.com/mcp`
3. Say: **"calculate my retirement"**
4. The interactive widget appears!

## Tech Stack

- **MCP SDK** - Model Context Protocol for ChatGPT integration
- **Node.js + TypeScript** - Server runtime
- **Server-Sent Events (SSE)** - Real-time communication
- **React** - Widget UI components

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
BUTTONDOWN_API_KEY=your_api_key
TURNSTILE_SITE_KEY=your_public_turnstile_site_key
TURNSTILE_SECRET_KEY=your_secret_key
FRED_API_KEY=optional_fred_api_key
FRED_SERIES_ID=MORTGAGE30US
ANALYTICS_PASSWORD=your_password
```

## Privacy & Data Use

- **What we collect:** When the widget runs inside ChatGPT we receive the location (city/region/country), locale, device/browser fingerprint, and an inferred retirement query via `_meta` so we can prefill the calculator and measure usage.
- **How we use it:** These fields feed the `/analytics` dashboard and error alerts only; we do not sell or share this data with third parties.
- **Retention:** Logs are stored for **30 days** in the `/logs` folder on the server and then automatically rotated.
- **User input storage:** The widget caches your in-progress form values in `localStorage` so they persist across refreshes; entries automatically expire after **30 days**. Clear them anytime with the “Reset defaults” button.
- **Deletion / questions:** Email **support@layer3labs.io** (or open a GitHub issue) with the timestamp (UTC) of your ChatGPT session and we will delete the associated log entry within 7 days.

## Monitoring & Alerts

- Visit `/analytics` (Basic Auth protected) to review the live dashboard plus an “Alerts” panel.
- Thresholds implemented:
  - **Tool failures:** More than 5 `tool_call_error` events in the last 24h raises a critical alert.
  - **Buttondown failures:** If more than 10% of subscription attempts in the last 7 days fail, a warning is raised.
- Recommended: schedule an external ping (e.g., Cron + curl) that hits `/analytics` hourly and sends notifications if the HTML contains active alerts.

## License

MIT
