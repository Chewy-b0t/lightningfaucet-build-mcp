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
