# OpenClaw Is Burning Your Budget and Stalling Your Agents. We Read the Issues — Here's the Fix.

> _We searched OpenClaw's issue tracker for the problems users actually hit in production — cost, outages, runaway agents, model selection. Four structural problems show up again and again. ClawRouter fixes all four._

---

## The data

OpenClaw is a superb agent harness. But running it in production surfaces the same handful of structural problems — and they're not edge cases, they're consequences of how a single-model, single-provider setup behaves under real load. We read the open issues and grouped them:

| Problem                                    | Representative issues                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cost spikes from background work**       | [#90170](https://github.com/openclaw/openclaw/issues/90170), [#81856](https://github.com/openclaw/openclaw/issues/81856), [#72964](https://github.com/openclaw/openclaw/issues/72964), [#48579](https://github.com/openclaw/openclaw/issues/48579), [#84218](https://github.com/openclaw/openclaw/issues/84218), [#65161](https://github.com/openclaw/openclaw/issues/65161) |
| **Provider outages stall the session**     | [#84865](https://github.com/openclaw/openclaw/issues/84865), [#47910](https://github.com/openclaw/openclaw/issues/47910), [#79611](https://github.com/openclaw/openclaw/issues/79611), [#62615](https://github.com/openclaw/openclaw/issues/62615)                                                                                                                           |
| **No spend ceiling for autonomous agents** | [#42475](https://github.com/openclaw/openclaw/issues/42475), [#17683](https://github.com/openclaw/openclaw/issues/17683), [#64463](https://github.com/openclaw/openclaw/issues/64463), [#13219](https://github.com/openclaw/openclaw/issues/13219)                                                                                                                           |
| **One model for every task**               | [#43260](https://github.com/openclaw/openclaw/issues/43260), [#80521](https://github.com/openclaw/openclaw/issues/80521), [#65557](https://github.com/openclaw/openclaw/issues/65557), [#88371](https://github.com/openclaw/openclaw/issues/88371)                                                                                                                           |

ClawRouter is a local router that sits between OpenClaw and the model providers. Every request — including the internal ones — goes through `blockrun/auto`, which classifies the call across 15 dimensions in under a millisecond and routes it to the cheapest model that can actually handle it. That single architectural move addresses all four problems below.

---

## 1. Your bill spiked 10x and you didn't change a thing

You didn't add agents. You didn't change models. But your token usage tripled. The cost isn't in the prompts you wrote — it's in the work the agent does **between** them: context compaction, heartbeat replays, and memory lookups that run on every turn and quietly burn tokens on whatever model is configured.

From [#90170](https://github.com/openclaw/openclaw/issues/90170): _"Possible token/cost regression after OpenClaw v2026.5.28."_ A version bump, not a usage change, moved the needle.

The culprits are internal:

- **Compaction firing too often, on the wrong model.** [#72964](https://github.com/openclaw/openclaw/issues/72964) and [#48579](https://github.com/openclaw/openclaw/issues/48579) document premature compactions; [#81856](https://github.com/openclaw/openclaw/issues/81856) asks for an absolute-token trigger because on a 1M-context model, summarizing hundreds of thousands of tokens at flagship rates — repeatedly — is ruinous.
- **Heartbeats replaying context.** [#84218](https://github.com/openclaw/openclaw/issues/84218) and [#65161](https://github.com/openclaw/openclaw/issues/65161) (14 comments) show idle beats that stay heavy, so every beat costs like an active one.

### How ClawRouter fixes it

**Route the expensive internal lanes to cheap or free models.** Point compaction and memory at a cost profile instead of your premium default:

```jsonc
{
  "agents": {
    "main": {
      "model": "blockrun/auto",
      "compaction": { "model": "blockrun/eco" }, // summaries don't need a flagship
      "memory": { "model": "blockrun/free" }, // lookups can be free
    },
  },
}
```

The free tier alone covers most internal work — NVIDIA-hosted models with up to 1M context and a vision-capable Nemotron Omni, at zero cost. A compaction call billed at flagship rates becomes free, hundreds of times a day. On top of that, ClawRouter compresses verbose tool outputs and serves repeated responses from a short-TTL cache before any paid call goes out (the full teardown is in [ClawRouter Cuts LLM API Costs 500x](./clawrouter-cuts-llm-api-costs-500x.md)).

---

## 2. A provider goes down and your agent stalls for 14 minutes

The moment you pin OpenClaw to one model, you've built a single point of failure. When that provider has a bad minute — a 503, a rate-limit burst, an auth token that won't refresh — there's nothing behind it.

From [#84865](https://github.com/openclaw/openclaw/issues/84865): _"user-switched model has no fallback chain, causing session deadlock on provider outage."_ The act of choosing a model — what a careful user does — strips the safety net.

And naive failover isn't enough: [#47910](https://github.com/openclaw/openclaw/issues/47910) asks for fallback **by failure class**, because a 429 is transient (retry) while a 401 is not (skip immediately). [#62615](https://github.com/openclaw/openclaw/issues/62615) asks for a circuit breaker so a degraded provider can't drag the whole session down.

### How ClawRouter fixes it

When OpenClaw points at `blockrun/auto`, you're pointed at a router with a fallback chain behind every tier — primary plus an ordered list of fallbacks spanning **different providers**, so one outage doesn't poison the others.

```
[ClawRouter] tier=MEDIUM
[ClawRouter] primary moonshot/kimi-k2.6 → 503, falling through chain
[ClawRouter] trying next: google/gemini-3-flash-preview → ok
```

ClawRouter also classifies failures before reacting — auth errors (401/403) skip straight to the next model instead of burning ~10s per retry; transient errors cascade; payment-simulation hiccups retry with a different model. The agent never sees a bare 503. And the bottom of every chain is the **free tier**, which isn't tied to any paid provider's uptime — so the worst case is "this turn ran on a free model for a minute," not "the gateway hung until I restarted it."

| Failure mode                    | Pinned single model        | ClawRouter (`blockrun/auto`)             |
| ------------------------------- | -------------------------- | ---------------------------------------- |
| Provider returns 503            | Session stalls / deadlocks | Falls to next model in chain             |
| 401 / auth won't refresh        | ~10s wasted, then error    | Classified, skips straight to next model |
| Every paid provider unavailable | Hard failure               | Completes on a free model                |

---

## 3. There's no spend ceiling on an autonomous agent

A human agent stops spending when they go to sleep. An autonomous one doesn't — the whole point is that it runs without you, which means a runaway loop spends without you too.

OpenClaw users have asked for an enforced ceiling for a long time. [#42475](https://github.com/openclaw/openclaw/issues/42475) (11 comments): _"Per-agent cost budget enforcement at the gateway level."_ [#17683](https://github.com/openclaw/openclaw/issues/17683): _"Scoped / Script-Limited Agent Mode."_ [#64463](https://github.com/openclaw/openclaw/issues/64463): _"session.maxTokensPerSession."_ The common thread: a limit the agent **cannot** exceed, enforced by infrastructure rather than the agent's own good behavior.

### How ClawRouter fixes it

ClawRouter enforces a per-run (per-session) dollar ceiling via `maxCostPerRunUsd`, with two modes:

```jsonc
{
  "maxCostPerRunUsd": 0.5,
  "maxCostPerRunMode": "graceful",
}
```

- **`graceful` (default)** — as the session nears its budget, ClawRouter downgrades to cheaper models and falls back to a free model as a last resort. Work continues, cheaper.
- **`strict`** — the moment session spend reaches the cap, it returns a `429` and stops. A run that physically cannot exceed its number — exactly the predictable behavior [#17683](https://github.com/openclaw/openclaw/issues/17683) describes.

Two more guardrails: `/exclude` removes your most expensive models from routing entirely (including every fallback chain), so a loop can't escalate into them — and the **wallet balance itself is a hard ceiling**: fund it with only what you're willing to spend, and the agent literally cannot exceed it. `/stats` shows what was spent and which models served the requests — the per-model visibility [#13219](https://github.com/openclaw/openclaw/issues/13219) is asking for.

---

## 4. One model handles your hardest task and your most trivial one — at the same price

OpenClaw lets you pick a model. Singular. It then handles your hardest reasoning task and a one-line reformat at the same per-token price. Users keep asking for finer control: per-skill model routing ([#43260](https://github.com/openclaw/openclaw/issues/43260), 8 comments), a model picker ([#80521](https://github.com/openclaw/openclaw/issues/80521)), per-account allowlists ([#65557](https://github.com/openclaw/openclaw/issues/65557)). And the default pick can quietly be an expensive one — [#88371](https://github.com/openclaw/openclaw/issues/88371): a brand-new user's first message bills against a premium API with no warning.

### How ClawRouter fixes it

**Automatic per-task routing.** `blockrun/auto` classifies every individual request and routes it to the cheapest capable model — no per-task config:

```
"reformat this JSON"        → simple tier  → fast, cheap model
"refactor this module"      → complex tier → flagship-quality model
"prove this invariant"      → reasoning    → reasoning model
```

**Explicit per-agent control when you want it.** Assign a profile per lane in `openclaw.json` — `blockrun/premium` for coding, `blockrun/free` for formatting — each with its own fallback chain. And **clean aliases** (`sonnet`, `opus`, `flash`, `grok`, `gpt5`) mean switching is one word (`/model grok`), with none of the `provider/provider/model` mangling that fills the tracker. The default itself is cost-safe: a fresh install routes to `blockrun/auto` and the free tier works with no balance, so nobody's first message silently hits a premium API.

---

## The fix is one decision

All four problems share a root cause — a single model, chosen once, doing everything, with nothing behind it — and a single fix: **route through `blockrun/auto`** and let a local router classify, price, and fail over each request on its own merits.

1. Set your primary to `blockrun/auto`.
2. Point compaction and memory at `blockrun/eco` / `blockrun/free`.
3. Set `maxCostPerRunUsd` on anything autonomous; `/exclude` the models you never want reached.
4. Run `/stats` after a day and tune.

An autonomous agent is only as good as its worst provider-minute and its largest unmonitored bill. Fix both at the router, once.

---

## Related documentation

- [Why Your OpenClaw Bill Spiked 10x](./clawrouter-cuts-llm-api-costs-500x.md) — the token-compression teardown
- [We Read 100 OpenClaw Issues About OpenRouter](./clawrouter-vs-openrouter-llm-routing-comparison.md) — the structural case for local routing
- [Routing Profiles](./routing-profiles.md) — `auto` / `eco` / `premium` / `free`
- [11 Free AI Models, Zero Cost](./11-free-ai-models-zero-cost-blockrun.md) — what the free tier covers
- [Using Subscriptions with ClawRouter Failover](./subscription-failover.md) — keep your subscription primary, ClawRouter as failover
