+++
title = 'A Golden Path for Agents'
date = 2026-09-06
summary = "Developers and non-developers kept showing up with vibe-coded agents and asking how to get them to production. Here is the platform answer: one values file, a PR, and an agent that cannot leak a key, blow a budget, or call a tool it was not given."
tags = ["platform-engineering", "kubernetes", "ai", "gitops"]
draft = false
+++

Platform engineering has a pattern that works. Find the thing every team
rebuilds, build it once with safe defaults, leave a few knobs, and put guard
rails around the knobs. A universal Helm chart does that for deployments.
Hardened base images do it for containers. Shared GitHub Actions do it for
CI. Eighty percent of teams never need anything else, and the other twenty
get an escape hatch with a review.

Then agents showed up and the pattern did not have an answer.

The people asking were not the usual suspects. A support lead had a prompt
and wanted it to read tickets. An analyst had a Python script that called a
model and ran generated code over CSV files. A developer had a small chat app
that worked on a laptop. None of them wanted to learn about workload identity
or egress policy. All of them were about to paste an API key into a Deployment.

So the question was: what is the golden path for this? I spent a week finding
out and building it. The result is [one public repo](https://github.com/dackota/agent-golden-path)
that runs end to end on a laptop. This post is what I learned.

## What an agent needs that an app does not

An agent is a service with three extra habits. It spends money on every
request. It calls tools that can change things. And it was probably written
by someone who is not a backend engineer.

The research phase ([full notes here](https://github.com/dackota/agent-golden-path/blob/main/docs/research/2026-09-05-agent-deployment-golden-path.md))
turned up no standard for deploying agents. What exists is a set of parts that
are converging. The MCP spec now makes tool servers OAuth resource servers.
OpenTelemetry has draft semantic conventions for agent and tool spans. OWASP
published a top ten for agents in December 2025. And the companies running
agents at scale all built the same thing: a thin layer on the platform they
already had, with a gateway in front of models and tools. Uber gives each
agent a workload identity and routes every tool call through one MCP gateway.
Stripe runs coding agents in sandboxes with no internet and puts a human on
every PR.

None of them bought a hosted agent runtime for the default path. Neither did I.
The org already had Kubernetes, Helm, Argo CD, and GitHub Actions. Agents
became one more workload type with a stateful process, a gateway dependency,
and a budget.

## What the developer sees

This is the whole contract:

```yaml
# deployments/agents/demo/vibe-app/values.yaml
name: vibe-app
team: demo
owner: dackota.j@gmail.com
description: A chat app that calls an LLM and one read-only tool.
kind: container
image: ghcr.io/dackota/agent-app-template:0.2.0
systemPrompt: You are a friendly helper. Keep answers under 30 words.
tools:
  - name: k8s-readonly
budget:
  usdPerMonth: 10
```

Open a PR with that file. CI renders it against the chart schema and fails
with the exact field if something is off. Merge it. About a minute later the
agent answers at `/agents/demo/vibe-app/` on the platform gateway. It can call
three read-only Kubernetes tools. It can spend ten dollars a month. It never
saw a credential.

The `kind` field is the one big switch. `prompt` is a system prompt plus tools
and no code, for the support lead. `container` is your own image, for the
developer. `codeexec` is an isolated sandbox from a warm pool, for the analyst.
One chart renders all three, and only the resources one agent needs. Anything
shared or privileged lives outside the chart and outside the team's reach.

## What the platform does

![Deploy flow from PR to running agent](flow.svg)

Two gateways hold every credential. [LiteLLM](https://docs.litellm.ai/) is the
LLM gateway. It holds the real provider keys and hands each agent a virtual
key with a hard `max_budget`, a model allow-list, and rate limits. Spend is
tracked per key, so cost per agent and per team falls out for free.
[agentgateway](https://agentgateway.dev/) is the tool gateway. It fronts the
MCP tool servers, requires a JWT, and applies one small CEL policy per agent
that says which tool names exist for that agent. Tools outside the list are
absent from `tools/list`. The model cannot try what it cannot see.

A NetworkPolicy makes those two gateways the only things an agent pod can
reach, plus DNS. I tested this the boring way. A pod with the policy could not
reach the model host directly. The same pod could reach the gateway. A control
pod without the policy reached the model host fine.

The piece that makes GitOps work is a small minter. The chart renders a
registration ConfigMap for every agent. A platform CronJob reads them, mints
the LLM key and the tool JWT, writes them into a Secret in the team namespace,
and applies the tool policy. Pods wait for the Secret and then start. Delete
the folder and the minter deletes the Secret and the policy. Eighty lines of
stdlib Python. It is the only process that ever touches the master key.

Argo CD ties it together with a git-directory `ApplicationSet` over
`deployments/agents/*/*` and one `AppProject` per team. The project allows one
source repo and one destination namespace and forbids cluster-scoped
resources. I tried to break it. An Application aimed at another namespace
was refused. An Application from a foreign repo was refused. When Argo tried
to create a namespace on the team's behalf, the project refused that too,
which is how I learned namespaces should be platform-owned files.

## The guard rails, and how I know they hold

Every rail was tested, and the failing test is written down next to it in
[docs/guard-rails.md](https://github.com/dackota/agent-golden-path/blob/main/docs/guard-rails.md).
The short version:

| Rule | Proof |
|---|---|
| Only catalog models, only catalog tools, only allowed registries, no `:latest` | eleven bad values files, all rejected before render |
| Hard budget per agent | a key with a $0.0001 budget: first call ok, second call "Budget has been exceeded" |
| Per-agent tool allow-list | one token lists 3 Kubernetes tools, another lists 3 order tools, same endpoint |
| Default-deny egress | pod to model host: unreachable. Pod to gateway: 200 |
| Human approval on writes | "Cancel order 1004" stopped in `input-required`; the order was untouched |
| Delegation needs consent | an agent in an unlisted namespace named another team's agent as a tool: refused |
| Removal is complete | deleted a folder: CronJob, ConfigMaps, and the minted Secret all gone |

The one I like most is the approval gate. A `prompt` agent that lists the
`orders-cancel` tool with `approval: true` will stop and wait for a human
before the tool runs. That is the difference between an agent that can
cancel orders and an agent that can ask to.

## Two things that make agents a system

Tools that only search the web are not that interesting. The useful tools are
the company's own APIs. So the repo includes a fake Orders REST API and a
ninety-line MCP server that wraps it with no framework: one tool per API call,
a JSON schema per tool, the HTTP call inside. kagent's `MCPServer` resource
deploys it. A `RemoteMCPServer` shares it with agent namespaces. The same
server is a second target on the tool gateway, so container agents reach it
through the JWT check. Wrapping the next API is a copy of one file.

And agents should not know how to do everything. They should know who to ask.
[kagent](https://kagent.dev/) lets an `Agent` list another `Agent` as a tool,
with the call going over A2A between pods. In values that is one line on each
side. The caller says `tools: [{agent: ops/orders-agent}]`. The callee says
`delegation: {allowFromTeams: [demo]}`. Both must agree, and kagent enforces
the callee's side. The concierge in one team answered an order question by
asking the specialist in another team, and the response history shows the
hand-off.

## Things that bit me

Helm's schema validator is Go regex. No lookahead. `(?!latest)` compiles
nowhere and fails every render with an error about the schema, not the
values. Use `not` with a pattern.

Anything rendered from `now` makes Argo permanently OutOfSync. I wanted
sandboxes to expire after eight hours. They now take an explicit timestamp.

agentgateway prefixes tool names as soon as a backend has two targets.
`k8s_get_resources` became `kagent-tools_k8s_get_resources` and the model
happily called it. `prefixMode: Never` and a rule that catalog names may not
collide.

kgateway 2.4 does not bundle agentgateway any more. My research note said
"agentgateway behind kgateway" because 2.1 did. agentgateway ships its own
Gateway API control plane now. Always re-check the install docs the day you
install.

A public repo cannot call a reusable workflow that lives in a private repo.
The shared build workflow had to move to a public one before the template repo
could use it.

## What is still missing

This is a proof of concept on kind, and the README says so. For a real
cluster: the org identity provider becomes the JWT issuer instead of a
platform RSA key. The sandbox template turns on gVisor. Image signatures get
verified at admission, not just in CI. An OpenTelemetry collector lands where
the chart already points. The minter becomes a controller with a watch, or
External Secrets Operator, instead of a CronJob that runs every minute. Each
of those is listed with its local stand-in in the
[platform guide](https://github.com/dackota/agent-golden-path/blob/main/docs/platform-guide.md).

What I would not change is the shape. One values file. Two gateways that own
the credentials. A minter that turns "this agent exists" into "this agent has
keys". A project boundary Argo enforces. The developer gets a URL and a
budget. The platform gets the same agent, every time.

The repo is at [github.com/dackota/agent-golden-path](https://github.com/dackota/agent-golden-path).
`make up` builds the whole thing on a laptop with a local model. Every claim
in this post has a test next to it.
