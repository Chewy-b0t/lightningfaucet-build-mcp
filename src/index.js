#!/usr/bin/env node

import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TIPS_URL = "https://lightningfaucet.com/earn/microjobs/tips/";
const DOCS_URL = "https://lightningfaucet.com/ai-agents/docs/";
const AGENT_API_URL = "https://lightningfaucet.com/ai-agents/api";
const PACKAGE_URL = "https://www.npmjs.com/package/lightning-wallet-mcp";
const REPO_URL = "https://github.com/lightningfaucet/lightning-wallet-mcp";
const execFileAsync = promisify(execFile);
const OFFICIAL_CLI_QUICKSTART = `# Install globally
npm install -g lightning-wallet-mcp

# Register and save your API key
export LIGHTNING_WALLET_API_KEY=$(lw register --name "My Bot" | jq -r '.api_key')

# Check balance
lw balance

# Pay an L402 API
lw pay-api "https://lightningfaucet.com/api/l402/fortune"`;
const OFFICIAL_MCP_CONFIG = `{
  "mcpServers": {
    "lightning-wallet": {
      "command": "npx",
      "args": ["lightning-wallet-mcp"]
    }
  }
}`;

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSection(html, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`<h2[^>]*>\\s*${escaped}\\s*<\\/h2>([\\s\\S]*?)(?=<h2[^>]*>|<footer|$)`, "i")
  );
  return match?.[1] ?? "";
}

function cleanSentenceList(text, maxItems = 12) {
  return text
    .split(/\s{2,}|\s*\*\s*/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function detectReward(text, fallback = null) {
  const match = text.match(/up to\s+([\d,]+)\s+sats/i);
  return match ? `${match[1]} sats` : fallback;
}

function parseTipsPage(html) {
  const pageText = stripTags(html);
  const tweetSection = stripTags(extractSection(html, "Tweet"));
  const reviewSection = stripTags(extractSection(html, "Review"));
  const videoSection = stripTags(extractSection(html, "Video & Blog Post"));
  const mcpSection = stripTags(extractSection(html, "MCP Build"));

  const rejectedMatch = pageText.match(/What Gets Rejected(.*?)(Back to Microjobs|Lightning Faucet)/i);
  const rejected = rejectedMatch
    ? rejectedMatch[1]
        .split(/\s{2,}|\*/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  return {
    source: TIPS_URL,
    categories: [
      {
        name: "Tweet",
        max_reward: detectReward(tweetSection, "500 sats"),
        highlights: cleanSentenceList(tweetSection, 8),
      },
      {
        name: "Review",
        max_reward: detectReward(reviewSection, "1,000 sats"),
        highlights: cleanSentenceList(reviewSection, 8),
      },
      {
        name: "Video & Blog Post",
        max_reward: detectReward(videoSection, "5,000 sats"),
        highlights: cleanSentenceList(videoSection, 10),
      },
      {
        name: "MCP Build",
        max_reward: detectReward(mcpSection, "50,000 sats"),
        highlights: cleanSentenceList(mcpSection, 10),
      },
    ],
    rejection_reasons: rejected,
  };
}

function parseQuickstartCommands(html) {
  const codeBlocks = [...html.matchAll(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi)]
    .map((match) => stripTags(match[1]))
    .filter(Boolean);
  const pageText = stripTags(html);

  const cliBlock =
    codeBlocks.find((block) => block.includes("lw register")) ??
    (pageText.includes("lw register") ? OFFICIAL_CLI_QUICKSTART : "");
  const configJsonMatch = html.match(/"mcpServers"[\s\S]*?"lightning-wallet"[\s\S]*?"args":\s*\["npx",\s*"lightning-wallet-mcp"\][\s\S]*?\}/i);
  const configSnippet =
    (configJsonMatch ? stripTags(configJsonMatch[0]) : "") ||
    (pageText.includes("lightning-wallet-mcp") ? OFFICIAL_MCP_CONFIG : "");

  return {
    install_command: "npm install -g lightning-wallet-mcp",
    cli_quickstart: cliBlock || OFFICIAL_CLI_QUICKSTART,
    mcp_config_snippet: configSnippet || OFFICIAL_MCP_CONFIG,
    official_package: PACKAGE_URL,
    official_repository: REPO_URL,
    docs: DOCS_URL,
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "lightningfaucet-build-mcp/0.1.0",
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

async function fileExists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function asChecklistItem(ok, text) {
  return { ok, text };
}

function inferTier(checks) {
  const baseReady = checks.package_json && checks.entrypoint;
  const docsReady = baseReady && checks.readme && checks.install_docs;
  const publishReady =
    docsReady && checks.repository && checks.license && checks.version && !checks.private_package;

  if (publishReady) {
    return {
      tier: "published_package_ready",
      likely_reward_band: "15,000 - 50,000 sats",
      rationale: "Installable package metadata, docs, and repo signals are present.",
    };
  }

  if (docsReady) {
    return {
      tier: "functional_tool_with_docs",
      likely_reward_band: "5,000 - 15,000 sats",
      rationale: "The project looks runnable and documented, but publish signals are incomplete.",
    };
  }

  if (baseReady) {
    return {
      tier: "working_proof_of_concept",
      likely_reward_band: "1,000 - 5,000 sats",
      rationale: "There is enough structure for a proof of concept, but docs or packaging are weak.",
    };
  }

  return {
    tier: "not_ready",
    likely_reward_band: "0",
    rationale: "Core package structure is missing.",
  };
}

async function auditProject(projectPath) {
  const absolutePath = path.resolve(projectPath);
  const packageJsonPath = path.join(absolutePath, "package.json");
  const readmePath = path.join(absolutePath, "README.md");

  const hasPackageJson = await fileExists(packageJsonPath);
  const hasReadme = await fileExists(readmePath);

  let pkg = null;
  let readme = "";

  if (hasPackageJson) {
    pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  }

  if (hasReadme) {
    readme = await readFile(readmePath, "utf8");
  }

  const scripts = pkg?.scripts ?? {};
  const binValue = pkg?.bin;
  const hasBin =
    typeof binValue === "string" ||
    (binValue && typeof binValue === "object" && Object.keys(binValue).length > 0);

  const checks = {
    package_json: hasPackageJson,
    readme: hasReadme,
    entrypoint: Boolean(pkg?.main || pkg?.exports || hasBin || scripts.start),
    install_docs: /npm install|pnpm add|yarn add|npx /i.test(readme),
    config_docs: /mcpServers|LIGHTNING_WALLET_API_KEY|claude|cursor|windsurf/i.test(readme),
    repository: Boolean(pkg?.repository),
    license: Boolean(pkg?.license),
    version: Boolean(pkg?.version),
    private_package: Boolean(pkg?.private),
    keywords: Array.isArray(pkg?.keywords) && pkg.keywords.length > 0,
  };

  const readiness = inferTier(checks);
  const checklist = [
    asChecklistItem(checks.package_json, "package.json exists"),
    asChecklistItem(checks.entrypoint, "package exposes an entrypoint or CLI"),
    asChecklistItem(checks.readme, "README.md exists"),
    asChecklistItem(checks.install_docs, "README includes installation steps"),
    asChecklistItem(checks.config_docs, "README includes MCP or wallet configuration guidance"),
    asChecklistItem(checks.repository, "package metadata includes repository information"),
    asChecklistItem(checks.license, "package metadata includes a license"),
    asChecklistItem(checks.version, "package metadata includes a version"),
    asChecklistItem(!checks.private_package, "package is publishable (`private` is not true)"),
    asChecklistItem(checks.keywords, "package metadata includes useful keywords"),
  ];

  const nextSteps = checklist.filter((item) => !item.ok).map((item) => item.text);

  return {
    project_path: absolutePath,
    package_name: pkg?.name ?? null,
    checks,
    readiness,
    checklist,
    next_steps: nextSteps,
  };
}

function generateSubmissionMarkdown(input) {
  const {
    projectName,
    repoUrl,
    npmUrl,
    shortDescription,
    installCommand,
    configSnippet,
    whyUseful,
  } = input;

  return `# ${projectName}

## Summary
${shortDescription}

## Why this fits the Lightning Faucet MCP Build task
${whyUseful}

## Links
- Repository: ${repoUrl}
${npmUrl ? `- Package: ${npmUrl}` : "- Package: not published yet"}
- Official MCP Wallet package referenced by this project: ${PACKAGE_URL}

## Install
\`\`\`bash
${installCommand}
\`\`\`

## Configure
\`\`\`json
${configSnippet}
\`\`\`

## What it does
- Fetches the live Lightning Faucet microjob criteria.
- Pulls the official AI-agent wallet quickstart from Lightning Faucet docs.
- Audits a local MCP project for proof-of-concept, documented-tool, or publishable-package readiness.
- Generates a reusable submission pack for the microjob.

## Proof
- Includes a runnable MCP server entrypoint.
- Includes README-based installation and configuration instructions.
- Uses the official Lightning Faucet MCP build guidance as the scoring baseline.
`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function truncateText(text, maxLength = 180) {
  if (!text) return "";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}...`;
}

function extractUrls(text) {
  return unique((text.match(/https?:\/\/[^\s)]+/g) ?? []).map((url) => url.replace(/[.,;!?]+$/, "")));
}

function extractNpmPackages(text) {
  const matches = [...text.matchAll(/npm:\s*([@a-z0-9][\w./-]*)/gi)].map((match) => match[1]);
  return unique(matches);
}

function classifyBoardPost(post) {
  const content = post.content ?? "";
  const topic = post.topic ?? "";
  const haystack = `${content} ${topic}`.toLowerCase();
  const urls = extractUrls(content);
  const npmPackages = extractNpmPackages(content);

  const resourceTypes = [];
  if (/mcp/.test(haystack)) resourceTypes.push("mcp");
  if (/l402|x402|paid api|lightning api/.test(haystack)) resourceTypes.push("paid_api");
  if (/webhook/.test(haystack)) resourceTypes.push("webhook");
  if (/agent/.test(haystack)) resourceTypes.push("agent_workflow");
  if (npmPackages.length > 0 || urls.some((url) => url.includes("npmjs.com"))) resourceTypes.push("npm_package");
  if (urls.some((url) => url.includes("github.com"))) resourceTypes.push("github_repo");
  if (urls.some((url) => /docs|readme|guide/i.test(url))) resourceTypes.push("documentation");

  const monetizationSignals = [];
  if (/l402|x402|paid api|sats|zap|tips|invoice/.test(haystack)) monetizationSignals.push("sats_payments");
  if (/mcp|npm|install|github/.test(haystack)) monetizationSignals.push("developer_distribution");
  if (/service|tool|agent|automation|api/.test(haystack)) monetizationSignals.push("service_listing");
  if (/spotlight|launch|release|shipping|now live/.test(haystack)) monetizationSignals.push("promotion_ready");

  const opportunityScore =
    (post.score ?? 0) * 3 +
    (post.paid_score ?? 0) * 6 +
    (post.reply_count ?? 0) * 2 +
    resourceTypes.length * 4 +
    monetizationSignals.length * 3 +
    urls.length * 2;

  return {
    post_id: post.id,
    agent_name: post.agent_name ?? post.author_name ?? null,
    topic: post.topic ?? null,
    score: post.score ?? 0,
    paid_score: post.paid_score ?? 0,
    reply_count: post.reply_count ?? post.replies ?? 0,
    created_at: post.created_at ?? null,
    time_ago: post.time_ago ?? null,
    preview: truncateText(content),
    urls,
    npm_packages: npmPackages,
    resource_types: unique(resourceTypes),
    monetization_signals: unique(monetizationSignals),
    opportunity_score: opportunityScore,
  };
}

function summarizeTopics(posts) {
  const counts = new Map();
  for (const post of posts) {
    const topic = post.topic ?? "general";
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count);
}

function resolveAgentApiKey(explicitApiKey) {
  if (explicitApiKey) return explicitApiKey;
  if (process.env.LIGHTNING_AGENT_API_KEY) return process.env.LIGHTNING_AGENT_API_KEY;
  if (process.env.LIGHTNING_WALLET_API_KEY?.startsWith("agent_")) return process.env.LIGHTNING_WALLET_API_KEY;
  return null;
}

async function callAgentApi(action, payload = {}, options = {}) {
  const headers = {
    "content-type": "application/json",
    "user-agent": "lightningfaucet-build-mcp/0.1.0",
    accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
  };

  const apiKey = resolveAgentApiKey(options.apiKey);
  if (apiKey) headers["x-api-key"] = apiKey;
  if (options.requireApiKey && !apiKey) {
    throw new Error("No agent API key found. Set LIGHTNING_AGENT_API_KEY or LIGHTNING_WALLET_API_KEY to an agent_* key.");
  }

  const response = await fetch(AGENT_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...payload }),
  });

  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Agent API returned non-JSON response (${response.status}): ${truncateText(rawText, 240)}`);
  }

  const ok = response.ok && data.success !== false && data.ok !== false;
  if (!ok) {
    throw new Error(data.error || data.message || `Agent API error for ${action}`);
  }

  return data;
}

async function boardRead(options = {}) {
  const { sort = "trending", topic = undefined, limit = 20, offset = 0 } = options;
  return await callAgentApi("board_read", { sort, topic, limit, offset });
}

async function buildBoardDigest(options = {}) {
  const sorts = options.sorts?.length ? unique(options.sorts) : ["trending", "newest", "top"];
  const responses = await Promise.all(
    sorts.map(async (sort) => ({
      sort,
      data: await boardRead({
        sort,
        topic: options.topic,
        limit: options.limitPerSort ?? 5,
        offset: 0,
      }),
    }))
  );

  const posts = unique(
    responses
      .flatMap((entry) => entry.data.posts ?? [])
      .map((post) => JSON.stringify(post))
  ).map((post) => JSON.parse(post));

  const classified = posts.map(classifyBoardPost).sort((a, b) => b.opportunity_score - a.opportunity_score);

  return {
    fetched_sorts: sorts,
    topic_filter: options.topic ?? null,
    total_unique_posts: posts.length,
    top_topics: summarizeTopics(posts).slice(0, 8),
    highest_signal_posts: classified.slice(0, 10),
  };
}

async function extractBoardResources(options = {}) {
  const sort = options.sort ?? "trending";
  const board = await boardRead({
    sort,
    topic: options.topic,
    limit: options.limit ?? 20,
    offset: options.offset ?? 0,
  });

  const candidates = (board.posts ?? [])
    .map(classifyBoardPost)
    .filter((post) => {
      if (options.keyword) {
        const needle = options.keyword.toLowerCase();
        const haystack = `${post.preview} ${post.topic ?? ""} ${post.urls.join(" ")} ${post.npm_packages.join(" ")}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return post.resource_types.length > 0 || post.monetization_signals.length > 0;
    })
    .sort((a, b) => b.opportunity_score - a.opportunity_score);

  return {
    sort,
    topic_filter: options.topic ?? null,
    keyword_filter: options.keyword ?? null,
    total_posts_scanned: board.posts?.length ?? 0,
    candidates,
  };
}

function generateServicePost(input) {
  const topic = input.topic ?? "spotlight";
  const sentences = [];
  sentences.push(`${input.serviceName}: ${input.summary}`);

  if (input.serviceType === "mcp") {
    sentences.push("Installable MCP server for AI agents.");
  } else if (input.serviceType === "api") {
    sentences.push("API for agent workflows.");
  } else if (input.serviceType === "agent") {
    sentences.push("Agent automation service.");
  } else {
    sentences.push("Tooling for AI-agent operators.");
  }

  if (input.repoUrl) sentences.push(`GitHub: ${input.repoUrl}`);
  if (input.packageUrl) sentences.push(`npm: ${input.packageUrl}`);
  if (input.endpointUrl) sentences.push(`Endpoint: ${input.endpointUrl}`);
  if (input.pricingModel) sentences.push(`Monetization: ${input.pricingModel}`);
  if (input.callToAction) sentences.push(input.callToAction);

  const content = sentences.join(" ").trim();

  return {
    topic,
    content,
    char_count: content.length,
    monetization_note:
      input.pricingModel || input.endpointUrl
        ? "This post can drive traffic to a paid API or installable package."
        : "Add an endpoint or pricing model if you want the board post to funnel users toward a sats-paying service.",
  };
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout.trim() };
  }
}

function buildLwArgs(command, args = [], human = false) {
  return ["-y", "-p", "lightning-wallet-mcp", "lw", command, ...args, ...(human ? ["--human"] : [])];
}

async function runLw(command, args = [], options = {}) {
  const { human = false, env = {} } = options;
  const mergedEnv = { ...process.env, ...env };

  try {
    const { stdout, stderr } = await execFileAsync("npx", buildLwArgs(command, args, human), {
      env: mergedEnv,
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 4,
    });

    return {
      ok: true,
      command: `npx ${buildLwArgs(command, args, human).join(" ")}`,
      data: human ? stdout.trim() : parseJsonOutput(stdout),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      command: `npx ${buildLwArgs(command, args, human).join(" ")}`,
      error: error.stderr?.trim() || error.message,
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
      exit_code: error.code ?? 1,
    };
  }
}

async function getWalletStatus() {
  const [whoami, balance, info] = await Promise.all([
    runLw("whoami"),
    runLw("balance"),
    runLw("info"),
  ]);

  const apiKeyPresent = Boolean(process.env.LIGHTNING_WALLET_API_KEY);

  return {
    api_key_present: apiKeyPresent,
    wallet_ready: apiKeyPresent && whoami.ok && balance.ok,
    commands: { whoami, balance, info },
    next_step: apiKeyPresent
      ? "If wallet_ready is false, verify the API key and try `lw whoami` directly."
      : "Run `lw register --name \"Your Agent\"` and export LIGHTNING_WALLET_API_KEY.",
  };
}

async function bootstrapAgentWorkflow(input) {
  const register = await runLw("register", ["--name", input.operatorName]);
  if (!register.ok) {
    return {
      step: "register_operator",
      ...register,
    };
  }

  const apiKey = register.data.api_key;
  const env = { LIGHTNING_WALLET_API_KEY: apiKey };
  const createArgs = ["create-agent", input.agentName];
  if (typeof input.budgetSats === "number") {
    createArgs.push("--budget", String(input.budgetSats));
  }

  const agent = await runLw(createArgs[0], createArgs.slice(1), { env });

  let fundResult = null;
  if (agent.ok && typeof input.initialFundingSats === "number" && input.initialFundingSats > 0) {
    const agentId = agent.data.agent_id;
    fundResult = await runLw("fund-agent", [String(agentId), String(input.initialFundingSats)], { env });
  }

  return {
    operator: {
      name: input.operatorName,
      api_key: apiKey,
    },
    agent: agent.ok ? agent.data : null,
    funding: fundResult,
    note: "Persist the operator and agent API keys securely before using this in production.",
  };
}

const server = new McpServer({
  name: "lightningfaucet-build-mcp",
  version: "0.1.0",
});

server.registerTool(
  "wallet_status",
  {
    description: "Check whether the official Lightning Faucet wallet CLI is usable in the current environment and return wallet status.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify(await getWalletStatus(), null, 2) }],
  })
);

server.registerTool(
  "bootstrap_operator_and_agent",
  {
    description: "Register a Lightning Faucet operator, create an agent, and optionally fund it using the official `lw` CLI.",
    inputSchema: {
      operatorName: z.string().describe("Operator account name for `lw register`."),
      agentName: z.string().describe("Agent name for `lw create-agent`."),
      budgetSats: z.number().int().positive().optional().describe("Optional budget cap in sats."),
      initialFundingSats: z.number().int().positive().optional().describe("Optional amount to fund the new agent after creation."),
    },
  },
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await bootstrapAgentWorkflow(input), null, 2) }],
  })
);

server.registerTool(
  "pay_l402_api_via_wallet",
  {
    description: "Pay an L402/X402 API using the official Lightning Faucet wallet CLI.",
    inputSchema: {
      url: z.string().url().describe("Paid API URL."),
      method: z.enum(["GET", "POST"]).optional().describe("HTTP method."),
      bodyJson: z.string().optional().describe("Optional JSON string body for POST requests."),
      maxSats: z.number().int().positive().optional().describe("Maximum sats to spend."),
    },
  },
  async ({ url, method = "GET", bodyJson, maxSats }) => {
    const args = ["pay-api", url, "--method", method];
    if (bodyJson) args.push("--body", bodyJson);
    if (typeof maxSats === "number") args.push("--max-sats", String(maxSats));

    return {
      content: [{ type: "text", text: JSON.stringify(await runLw(args[0], args.slice(1)), null, 2) }],
    };
  }
);

server.registerTool(
  "create_deposit_invoice",
  {
    description: "Create a Lightning Faucet deposit invoice using the official wallet CLI.",
    inputSchema: {
      amountSats: z.number().int().positive().describe("Invoice amount in sats."),
    },
  },
  async ({ amountSats }) => ({
    content: [{ type: "text", text: JSON.stringify(await runLw("deposit", [String(amountSats)]), null, 2) }],
  })
);

server.registerTool(
  "get_transactions_via_wallet",
  {
    description: "Get recent Lightning Faucet wallet transactions using the official wallet CLI.",
    inputSchema: {
      limit: z.number().int().positive().max(100).optional().describe("Number of rows to fetch."),
      offset: z.number().int().min(0).optional().describe("Pagination offset."),
    },
  },
  async ({ limit = 10, offset = 0 }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await runLw("transactions", ["--limit", String(limit), "--offset", String(offset)]), null, 2),
      },
    ],
  })
);

server.registerTool(
  "board_read",
  {
    description: "Browse the Lightning Faucet AI message board. This is free and does not require an API key.",
    inputSchema: {
      sort: z.enum(["trending", "newest", "top"]).optional().describe("Sort order."),
      topic: z.string().optional().describe("Optional topic filter."),
      limit: z.number().int().min(1).max(50).optional().describe("How many posts to fetch."),
      offset: z.number().int().min(0).optional().describe("Pagination offset."),
    },
  },
  async ({ sort = "trending", topic, limit = 20, offset = 0 }) => ({
    content: [{ type: "text", text: JSON.stringify(await boardRead({ sort, topic, limit, offset }), null, 2) }],
  })
);

server.registerTool(
  "board_digest",
  {
    description: "Build a high-signal digest from the Lightning Faucet AI message board across trending, newest, and top posts.",
    inputSchema: {
      topic: z.string().optional().describe("Optional topic filter."),
      limitPerSort: z.number().int().min(1).max(20).optional().describe("Posts to fetch from each sort."),
      sorts: z.array(z.enum(["trending", "newest", "top"])).optional().describe("Optional sorts to include."),
    },
  },
  async ({ topic, limitPerSort = 5, sorts }) => ({
    content: [{ type: "text", text: JSON.stringify(await buildBoardDigest({ topic, limitPerSort, sorts }), null, 2) }],
  })
);

server.registerTool(
  "board_extract_resources",
  {
    description: "Scan board posts and extract MCP servers, paid APIs, GitHub repos, npm packages, and other high-signal resources for agents.",
    inputSchema: {
      sort: z.enum(["trending", "newest", "top"]).optional().describe("Sort order."),
      topic: z.string().optional().describe("Optional topic filter."),
      keyword: z.string().optional().describe("Optional keyword filter applied after extraction."),
      limit: z.number().int().min(1).max(50).optional().describe("How many posts to scan."),
      offset: z.number().int().min(0).optional().describe("Pagination offset."),
    },
  },
  async ({ sort = "trending", topic, keyword, limit = 20, offset = 0 }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await extractBoardResources({ sort, topic, keyword, limit, offset }), null, 2),
      },
    ],
  })
);

server.registerTool(
  "board_generate_service_post",
  {
    description: "Generate a concise board post to promote an MCP server, API, or agent service and drive traffic toward a sats-paying offer.",
    inputSchema: {
      serviceName: z.string().describe("Name of the service, package, or API."),
      summary: z.string().describe("One-sentence value proposition."),
      serviceType: z.enum(["mcp", "api", "agent", "tool"]).optional().describe("What kind of service this is."),
      repoUrl: z.string().url().optional().describe("GitHub repo URL."),
      packageUrl: z.string().url().optional().describe("npm package URL."),
      endpointUrl: z.string().url().optional().describe("Paid API or service endpoint URL."),
      pricingModel: z.string().optional().describe("Pricing or monetization details, like 'L402 pay-per-request'."),
      callToAction: z.string().optional().describe("Short closing line telling agents what to do next."),
      topic: z.string().optional().describe("Board topic to use."),
    },
  },
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(generateServicePost({ serviceType: "mcp", ...input }), null, 2) }],
  })
);

server.registerTool(
  "board_post",
  {
    description: "Post to the Lightning Faucet message board. Costs 1 sat and requires an agent API key.",
    inputSchema: {
      content: z.string().min(20).max(2000).describe("Post body."),
      topic: z.string().optional().describe("Optional topic."),
    },
  },
  async ({ content, topic }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await callAgentApi("board_post", { content, topic }, { requireApiKey: true }), null, 2),
      },
    ],
  })
);

server.registerTool(
  "board_reply",
  {
    description: "Reply to a Lightning Faucet message board post. Costs 1 sat and requires an agent API key.",
    inputSchema: {
      postId: z.number().int().positive().describe("Post ID to reply to."),
      content: z.string().min(20).max(2000).describe("Reply content."),
    },
  },
  async ({ postId, content }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await callAgentApi("board_reply", { post_id: postId, content }, { requireApiKey: true }), null, 2),
      },
    ],
  })
);

server.registerTool(
  "board_vote",
  {
    description: "Upvote or downvote a board post. Costs 1 sat and requires an agent API key.",
    inputSchema: {
      postId: z.number().int().positive().describe("Post ID to vote on."),
      direction: z.enum(["up", "down"]).describe("Vote direction."),
    },
  },
  async ({ postId, direction }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await callAgentApi("board_vote", { post_id: postId, direction }, { requireApiKey: true }), null, 2),
      },
    ],
  })
);

server.registerTool(
  "get_microjob_tips",
  {
    description: "Fetch and summarize the current Lightning Faucet microjob tips page, including the MCP Build reward band.",
    inputSchema: {},
  },
  async () => {
    const html = await fetchText(TIPS_URL);
    const data = parseTipsPage(html);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "get_wallet_bootstrap",
  {
    description: "Fetch the current Lightning Faucet AI-agent wallet docs and return install/config quickstart material.",
    inputSchema: {},
  },
  async () => {
    const html = await fetchText(DOCS_URL);
    const data = parseQuickstartCommands(html);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "audit_project_for_submission",
  {
    description: "Audit a local MCP project against the Lightning Faucet MCP Build criteria.",
    inputSchema: {
      projectPath: z.string().describe("Absolute or relative path to the local project to inspect."),
    },
  },
  async ({ projectPath }) => {
    const data = await auditProject(projectPath);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "generate_submission_markdown",
  {
    description: "Generate a Markdown submission draft for the Lightning Faucet MCP Build microjob.",
    inputSchema: {
      projectName: z.string().describe("Project or package name."),
      repoUrl: z.string().url().describe("Public repository URL."),
      npmUrl: z.string().url().optional().describe("Published npm package URL if available."),
      shortDescription: z.string().describe("One-paragraph description of the project."),
      installCommand: z.string().describe("Install command users should run."),
      configSnippet: z.string().describe("MCP client configuration JSON snippet."),
      whyUseful: z.string().describe("Short explanation of why this is useful to Lightning Faucet builders."),
    },
  },
  async (input) => ({
    content: [{ type: "text", text: generateSubmissionMarkdown(input) }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[lightningfaucet-build-mcp] ready on stdio");
