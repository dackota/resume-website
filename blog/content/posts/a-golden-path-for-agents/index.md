+++
title = 'A Golden Path for Agents'
date = 2026-09-07
summary = "Developers and non-developers kept showing up with vibe-coded agents and asking how to get them to production. Here is the platform answer: the problems agents actually create, the open source tools that solve each one, and what it costs to wire them together."
tags = ["platform-engineering", "kubernetes", "ai", "gitops"]
draft = false
+++

Platform engineering has one trick, and it works almost everywhere you point
it. Find the thing every team keeps rebuilding, build it once with safe
defaults, leave a few knobs, and put guard rails around the knobs. That is
what a universal Helm chart is for deployments, what hardened base images are
for containers, and what shared GitHub Actions are for CI. Eighty percent of
teams never need anything else, and the other twenty get an escape hatch and
a review.

Then agents showed up, and for a while the trick had no answer.

The people asking were not the usual suspects, either. A support lead had a
prompt and wanted it to read tickets. An analyst had a Python script that
called a model and ran generated code over CSV files. A developer had a small
chat app that worked great on a laptop. Nobody in that group wanted to learn
about workload identity or egress policy, and every one of them was about a
day away from pasting an API key into a Deployment.

So I spent a week working out what the golden path looks like for this, then
built it. The whole thing lives in
[one public repo](https://github.com/dackota/agent-golden-path) and runs end to
end on a laptop. This post is about the problems it solves and the tools that
solve them, because the second half turned out to matter more than I expected.

## The problems, before any tools

Strip away the hype and an agent is a service with three extra habits. It
spends money on every request, it calls tools that can change things, and it
was probably written by someone who does not think of themselves as a backend
engineer.

That produces a specific list of things that can go wrong. I wrote them
out before choosing anything, which in hindsight was the single most useful
hour of the week:

- Someone pastes a provider key into a Deployment, and now it is in Git.
- An agent loops and spends four figures overnight.
- An agent calls a tool nobody meant to give it.
- The support lead cannot ship a container, and should not have to.
- Generated code runs somewhere it can reach things.
- Two teams deploy into each other's namespaces.
- Nobody can say who built the image that is running.
- An agent needs the company's own API, which needs a key, which is a new
  place for a key to live.
- Nobody can see what any of this costs.

Later I added a second list that I had missed entirely, and it is the more
interesting one. Provisioning an agent is where trust turns into a bill. Every
agent someone creates starts two things that outlive the moment: a spending
obligation and a credential relationship. So:

- Who is allowed to create an agent, and at whose expense?
- A per-agent cap answers "will one agent run up a bill". Nothing answers
  "who signs for the total".
- An agent that reaches a third-party service inherits its outages, its data
  policy, and its rate limits. Nothing tells you.
- Credentials pile up across services with no shared pattern for scoping,
  rotation, or revocation.
- Convenience pushes people to ask for broad access, and nobody goes back to
  trim it.
- When the project ends, what did it leave running?

That last one is not rhetorical. I found a real instance of it in my own code,
which I will get to.

## The tools, and the problem each one solves

The research phase ([full notes here](https://github.com/dackota/agent-golden-path/blob/main/docs/research/2026-09-05-agent-deployment-golden-path.md))
turned up no standard for deploying agents, just a set of parts that are
starting to converge. The MCP spec now treats tool servers as OAuth resource
servers. OpenTelemetry has draft conventions for agent and tool spans. OWASP
published a top ten for agents in December 2025. And the companies actually
running agents at scale have all built roughly the same thing: a thin layer on
the platform they already had, with a gateway in front of models and tools.
Uber gives each agent a workload identity and routes every tool call through
one MCP gateway. Stripe runs its coding agents in sandboxes with no internet
and keeps a human on every pull request.

Nobody in that group bought a hosted agent runtime for the default path, and
neither did I. The org already had Kubernetes, Helm, Argo CD, and GitHub
Actions, so agents became one more workload type that happens to have a
gateway dependency and a budget.

Here is what each part does, and what it can do that I have not used yet.
Keeping those two apart mattered more than I expected. "The tool cannot do
this" is a dead end. "I have not configured it" is an afternoon.

### LiteLLM, for money and model keys

[LiteLLM](https://docs.litellm.ai/) is the LLM gateway. It holds the real
provider keys and hands each agent a virtual key with a hard `max_budget`, a
model allow-list, and rate limits. Pods never see a provider key. It records
spend per key, so cost per agent falls out for free.

I underused it for a while. LiteLLM caps spend at four levels, not one.
Keys, users, teams, and organizations each carry their own `max_budget`. My
first version only had per-agent caps, which meant ten agents at the schema
maximum was five thousand dollars a month that nobody had approved. Teams fixed
that. A key created with a `team_id` spends against its team, and the team cap
wins. I proved it the obvious way: a team capped at a ten-millionth of a dollar
refused a call from a key that still had a hundred dollars on it.

Three things I still have not turned on. `soft_budget` fires a `projected_limit_exceeded`
alert before the hard stop, so the first sign of trouble does not have to be a
stopped agent. There are per-model caps. And for agent workloads specifically
there are session controls, `max_budget_per_session` and `max_iterations`,
which stop a runaway loop inside the task rather than at the end of the month.

One caveat worth stating. Key rotation and soft-budget email alerts sit behind
LiteLLM's enterprise licence. Everything else here is free.

### agentgateway, for tool access and other people's credentials

[agentgateway](https://agentgateway.dev/) is the tool gateway. It sits in front
of the MCP tool servers, requires a JWT, and applies one small CEL policy per
agent naming the tools that exist for it. Tools outside that list are absent
from `tools/list`, so the model cannot try what it cannot see. One token lists
three Kubernetes tools, another lists three order tools, same endpoint.

It also solves the credential problem, which I did not appreciate at first.
Its backend authentication policy holds one credential per target and injects
it on the outbound request. So when a tool's
API needs a key, the gateway holds the key and the agent holds nothing.

I went back and made the demo Orders API demand an `X-API-Key` header, just to
be sure I was not dodging the question. A pod calling that API directly gets a
401. The same pod, sending nothing, going through the gateway, gets the order.
The MCP wrapper's entire environment is one variable, and it is a URL.

That policy also does AWS, Azure, and GCP credentials, a freshly signed JWT per
request, and OAuth token exchange, which means an agent can present its own
identity to a backend instead of sharing one static key. I have not needed that
yet. It is good to know the ceiling is a lot higher than where I stopped.

### kagent, for people who cannot ship a container

[kagent](https://kagent.dev/) is what makes the support lead's agent possible.
Its declarative `Agent` resource is a system prompt and a list of tools. No
code, no image, no Dockerfile. It scopes `toolNames` per agent and gates
individual tools with `requireApproval`, which is the feature I keep coming
back to. An agent that lists a cancel tool with approval on will stop and wait
for a human before the tool runs, and that pause is the whole difference
between an agent that can cancel orders and an agent that can ask to.

kagent also handles delegation. An `Agent` can list another `Agent` as a tool,
the call goes over A2A between pods, and both sides have to agree: the caller
names the callee, the callee names the allowed teams. When I asked a concierge
agent in one team about an order, it went and asked the specialist in another
team, and the hand-off showed up in the history. An agent from a team not on
the list was refused.

One thing I wired and never used. kagent emits OpenTelemetry traces and
Prometheus metrics, and it can ship every prompt and every tool call to a SIEM
for audit. That last one is also the answer to "nobody trims broad access",
because it tells you which granted tools an agent has never once called.

### agent-sandbox, for generated code

[agent-sandbox](https://agent-sandbox.sigs.k8s.io/) is a Kubernetes SIG project
for exactly the analyst's problem: code the model wrote, running somewhere it
cannot do damage. The platform owns a template and a warm pool, the developer
writes a one-line claim, and a sandbox arrives in seconds, non-root, read-only
root filesystem, egress blocked.

Real isolation comes from the runtime. agent-sandbox supports gVisor or Kata
through `runtimeClassName`. I could not turn that on, because kind on macOS has no
gVisor node. The line is in the template, commented, waiting for a real cluster.

It also does automatic cleanup after a configurable TTL and can hibernate an
idle sandbox and resume it on network activity. I have not set either, which is
its own small version of the "what did the project leave running" problem.

### Argo CD, cosign, and the small piece I wrote

Argo CD ties it together with a git-directory `ApplicationSet` over
`deployments/agents/*/*` and one `AppProject` per team. The project allows one
source repo and one destination namespace and forbids cluster-scoped resources.
I spent a while trying to break it. An Application aimed at another namespace
was refused. An Application from a foreign repo was refused. When Argo tried to
create a namespace on the team's behalf, the project refused that too, which is
how I learned that namespaces belong in platform-owned files.

One shared GitHub Actions workflow signs every image with cosign and no stored
key, and `cosign verify` with an identity regexp passes. Nothing checks
that signature at admission yet. Kyverno or the sigstore policy-controller
would, and that is a known gap rather than a hard one.

The only thing I actually wrote is a minter, and it is deliberately boring. The
chart renders a registration ConfigMap for every agent. A platform CronJob reads
them, makes sure the team exists at the gateway with its cap, mints the model
key inside that team and the tool JWT, writes both into a Secret in the team
namespace, and applies the tool policy. Pods wait for the Secret and then start.
It is a hundred lines of stdlib Python, and it is the only process anywhere that
touches the master key.

## What the developer sees

After all that, this is the entire contract:

```yaml
# deployments/agents/demo/vibe-app/values.yaml
name: vibe-app
team: demo
owner: you@example.com
description: A chat app that calls an LLM and one read-only tool.
kind: container
image: ghcr.io/dackota/agent-app-template:0.2.0
systemPrompt: You are a friendly helper. Keep answers under 30 words.
tools:
  - name: k8s-readonly
budget:
  usdPerMonth: 10
```

![Deploy flow from PR to running agent](flow.svg)

Open a pull request with that file and CI renders it against the chart schema,
failing with the exact field name if something is off. Merge it, and about a
minute later the agent is answering at `/agents/demo/vibe-app/` on the platform
gateway. It can call three read-only Kubernetes tools, it can spend ten dollars
a month inside its team's cap, and at no point did anyone hand it a credential.

The `kind` field is the one big switch. `prompt` is a system prompt plus tools
and no code at all, which is what the support lead needed. `container` is your
own image, for the developer with the chat app. `codeexec` hands you an
isolated sandbox from a warm pool, which is where the analyst's script belongs.
One chart renders all three, and only the resources a single agent needs.
Anything shared or privileged lives outside the chart, and outside the team's
reach.

## How I know the rails hold

I tested every rail, and the failing test sits next to the rule in
[docs/guard-rails.md](https://github.com/dackota/agent-golden-path/blob/main/docs/guard-rails.md).
The short version:

| Rule | Proof |
|---|---|
| Only catalog models, only catalog tools, only allowed registries, no `:latest` | eleven bad values files, all rejected before render |
| Hard budget per agent | a key with a $0.0001 budget: first call ok, second call "Budget has been exceeded" |
| Team cap wins over a generous agent cap | team capped at $0.0000001, key inside it capped at $100: second call refused, naming the team |
| Per-agent tool allow-list | one token lists 3 Kubernetes tools, another lists 3 order tools, same endpoint |
| Default-deny egress | pod to model host: unreachable. Pod to gateway: 200 |
| The agent never holds an API key | direct call to the Orders API: 401. Same call through the gateway, sending nothing: the order |
| Human approval on writes | "Cancel order 1004" stopped in `input-required`, and the order was untouched |
| Delegation needs consent | an agent in an unlisted namespace named another team's agent as a tool: refused |
| Removal is complete | deleted a folder: workload, ConfigMaps, minted Secret, tool policy, and the model key all gone |

## Things that bit me

The minter deleted an agent's Secret and its tool policy when the folder went
away, and left the model key alive at the gateway, budget and all. Nothing
pointed at it and it still worked. This is exactly the "what did the project
leave running" problem, sitting in my own garbage collector, and I only found
it because I wrote the question down. The fix was one API call. Finding it was
the whole point of listing the problems first.

The chart has an `egress` field where a developer can name a host. It renders as
a pod annotation, not a rule. Nothing is granted, and nothing says so. Plain
NetworkPolicy cannot match names, which I knew, but a field that quietly does
nothing is worse than no field. The better answer is to route outbound calls
through the gateway, which is where the credential already lives.

Helm's schema validator is Go regex, which means no lookahead. My `(?!latest)`
compiled nowhere and failed every render with an error about the schema rather
than the values. `not` with a pattern does the job instead.

Anything rendered from `now` makes Argo permanently OutOfSync. I wanted
sandboxes to expire eight hours after creation, and they take an explicit
timestamp instead.

agentgateway starts prefixing tool names the moment a backend has two targets,
so `k8s_get_resources` quietly became `kagent-tools_k8s_get_resources` and the
model happily called it by the new name. `prefixMode: Never`, plus a rule that
catalog names may not collide.

kgateway 2.4 does not bundle agentgateway any more. My research note said
"agentgateway behind kgateway" because 2.1 did, but agentgateway ships its own
Gateway API control plane now. Re-check the install docs the day you install,
not the week before.

And a public repo cannot call a reusable workflow that lives in a private one,
which I found out when the template repo's first build failed in zero seconds.
The shared build workflow moved to a public repo and that was that.

## What is still missing

This is a proof of concept on kind, and the repo says so plainly. The honest
list: no OpenTelemetry collector, so the traces the chart already asks for go
nowhere. No signature check at admission. No gVisor. No soft budget, so the
first sign of trouble is a stopped agent. No key rotation. And the intake is
still a YAML file in a pull request, which is fine for the developer and wrong
for the support lead.

The one that nags at me is the third-party question. Nothing in this platform
reaches an outside service yet, so I have not had to answer what happens when
an agent depends on somebody else's uptime and somebody else's data policy. The
gateway can enforce whichever decision you make. It cannot make it for you, and
that part is a governance job with a spreadsheet, not a CRD.

What I would not change is the shape. One values file. Gateways that own every
credential, model keys and API keys alike. A minter that turns "this agent
exists" into "this agent has keys, inside its team's budget". A project
boundary that Argo enforces so the platform does not have to argue about it.
The developer gets a URL and a budget, and the platform gets the same agent
every time.

The repo is at [github.com/dackota/agent-golden-path](https://github.com/dackota/agent-golden-path),
and `make up` builds the whole thing on a laptop with a local model. Every claim
in this post has a test sitting next to it, and where it does not, I said so.
