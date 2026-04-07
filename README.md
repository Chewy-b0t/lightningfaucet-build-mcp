# lightningfaucet-build-mcp

`lightningfaucet-build-mcp` is an MCP integration package aimed at the Lightning Faucet `MCP Build` microjob. It builds on top of the official `lightning-wallet-mcp` / `lw` wallet flow instead of replacing it.

It helps you ship a stronger submission by:

- fetching the live reward criteria from the microjob tips page
- fetching the official AI-agent wallet quickstart
- exposing higher-level wallet workflow tools via MCP by wrapping the official `lw` CLI
- auditing a local MCP project for likely reward-tier readiness
- generating a Markdown submission draft you can paste into a microjob entry

The official wallet package remains `lightning-wallet-mcp`:

- Docs: <https://lightningfaucet.com/ai-agents/docs/>
- npm: <https://www.npmjs.com/package/lightning-wallet-mcp>
- GitHub: <https://github.com/lightningfaucet/lightning-wallet-mcp>

## Install

```bash
cd /home/y/lightningfaucet-build-mcp
npm install
```

## Run

```bash
npm start
```

## Prerequisite

Install the official wallet package so the bundled MCP tools can call `lw`:

```bash
npm install -g lightning-wallet-mcp
```

Then either:

```bash
lw register --name "Your Agent"
export LIGHTNING_WALLET_API_KEY=...
```

or let this package register and create an agent for you with the `bootstrap_operator_and_agent` tool.

## Claude Code MCP config

```json
{
  "mcpServers": {
    "lightningfaucet-build": {
      "command": "node",
      "args": ["/home/y/lightningfaucet-build-mcp/src/index.js"]
    }
  }
}
```

## Tools

### `wallet_status`

Checks whether the official Lightning Faucet wallet CLI is installed and whether `LIGHTNING_WALLET_API_KEY` is usable.

### `bootstrap_operator_and_agent`

Wraps the official wallet flow:

- `lw register`
- `lw create-agent`
- `lw fund-agent`

This is the fastest way to bootstrap a usable operator + agent setup from an MCP client.

### `pay_l402_api_via_wallet`

Pays a Lightning Faucet-compatible L402 or X402 endpoint using `lw pay-api`.

### `create_deposit_invoice`

Creates a deposit invoice with `lw deposit`.

### `get_transactions_via_wallet`

Fetches recent transaction history with `lw transactions`.

### `get_microjob_tips`

Fetches the current <https://lightningfaucet.com/earn/microjobs/tips/> page and returns the reward categories, with focus on `MCP Build`.

### `get_wallet_bootstrap`

Fetches the current <https://lightningfaucet.com/ai-agents/docs/> page and returns quickstart material for the official `lightning-wallet-mcp` package.

### `audit_project_for_submission`

Audits a local project path and scores it against a pragmatic version of the Lightning Faucet build tiers:

- `working_proof_of_concept`
- `functional_tool_with_docs`
- `published_package_ready`

Example:

```json
{
  "projectPath": "/home/y/lightningfaucet-build-mcp"
}
```

### `generate_submission_markdown`

Produces a Markdown draft for your microjob submission, including install and config sections.

## Suggested workflow

1. Install `lightning-wallet-mcp`.
2. Run `wallet_status`.
3. Use `bootstrap_operator_and_agent` to create real wallet credentials and an agent.
4. Use `pay_l402_api_via_wallet` against a paid endpoint to prove the integration works.
5. Run `audit_project_for_submission` on the local repo.
6. Publish to GitHub, and npm if appropriate.
7. Use `generate_submission_markdown` to prepare the submission text.

## Notes

- This package is intentionally opinionated: it combines wallet bootstrapping, L402 payment helpers, and submission workflow in one installable MCP package.
- The underlying wallet actions are delegated to the official `lightning-wallet-mcp` package so the integration stays aligned with Lightning Faucet’s supported path.
