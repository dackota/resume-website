+++
title = "Twelve Security Rules, Applied to Kubernetes"
date = 2026-08-04
summary = "The Project Glasswing report ends with twelve architecture rules it calls non-negotiable. Here is which Kubernetes control enforces each one, with the YAML."
tags = ["kubernetes", "security", "platform-engineering"]
draft = false
+++

Project Glasswing is Anthropic's defensive cybersecurity program. It points
frontier models at widely used software to see what they turn up. In the first
month, participants reported more than 10,000 vulnerabilities rated high or
critical.

Visa took part as a test partner and ran an AI system called Mythos against its
own environment. Mythos surfaced critical findings, but none of them turned into
an exploited path. Zero-trust controls and network segmentation stopped the
attempts before they mattered. Visa also open-sourced the harness it used, the
Visa Vulnerability Agentic Harness.

The conclusion is the part worth sitting with. Finding vulnerabilities is no
longer the bottleneck. Verifying, disclosing, and patching them is. If your
security posture rests on how fast you can ship a fix, you have built it on the
one variable that is now moving against you.

The appendix lists twelve architecture and design rules and calls them
non-negotiable. Most of them will be familiar. The useful exercise isn't
agreeing with them, it's asking a narrower question about each: which control in
the cluster actually enforces this, so a team shipping at 4pm on a Friday can't
route around it?

Here's how I answer that in Kubernetes.

## Secrets and identity

*Rules 1 and 11: keep secrets out of code, and treat AI agents as identities.*

Nothing sensitive lives in the manifest repo. Secrets sit in a secret manager,
and External Secrets Operator reconciles them into Kubernetes Secrets at
runtime. What gets committed is a reference:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: payments-db
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: payments-db          # the Secret ESO creates in-cluster
  data:
    - secretKey: password
      remoteRef:
        key: prod/payments/db  # a path, not a value
        property: password
```

Rotating that credential is a change in Vault. No pull request goes near it, and
nobody has to remember to update a manifest.

The scanning half matters just as much. gitleaks runs pre-commit and again in
CI. Be honest about which one does the work: the pre-commit hook is a courtesy
to whoever is committing, and the required CI check is the thing that actually
stops a leak from landing.

Workloads authenticate with short-lived tokens rather than a static service
account key mounted as a file:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payments
  annotations:
    iam.gke.io/gcp-service-account: payments@project.iam.gserviceaccount.com
```

A JSON key sitting in a Secret never expires, survives being copied, and keeps
working long after whoever created it has moved on. A projected token expires
whether or not anyone is paying attention.

Rule 11 is the one most platforms haven't caught up on. An agent calling your
APIs is a principal, and it needs the same treatment any other principal gets:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: triage-agent
  namespace: incidents
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "events"]
    verbs: ["get", "list"]        # read-only, one namespace, no exec
```

The failure mode here is the shared `automation` account that picked up
permissions over three years and shows up in the audit log as one
indistinguishable actor. When an agent's credentials leak, you want two answers
fast: what could it reach, and what did it reach. Both are IAM properties, and
they only exist if you built them in.

## Trust boundaries

*Rules 2, 3, and 4: authorize server-side, stop treating "internal" as a
boundary, enforce tenant isolation centrally.*

Every namespace gets a default-deny NetworkPolicy. It's four lines and it
changes the shape of the whole cluster:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: payments
spec:
  podSelector: {}               # every pod in the namespace
  policyTypes: ["Ingress", "Egress"]
```

Now pods reach what you've explicitly allowed and nothing else, which turns
lateral movement into something an attacker has to configure rather than
something the network hands over for free. The mesh handles mTLS on top of that,
so a connection between two pods is authenticated instead of being trusted for
having originated inside the cluster. That's rule 3 in one sentence: the pod
next door is not a friend.

Authorization decisions happen at the gateway and mesh layer, from central
policy rather than code scattered across services:

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: payments-callers
  namespace: payments
spec:
  action: ALLOW
  rules:
    - from:
        - source:
            principals: ["cluster.local/ns/checkout/sa/checkout"]
      to:
        - operation:
            methods: ["POST"]
            paths: ["/v1/charges"]
```

The service gets a request that's already been authorized and doesn't get a
vote. Rule 2 then holds even for the service whose authors were having a bad
week.

Tenant isolation is the same idea one level up. A tenant is a namespace with
enforced edges: a ResourceQuota so it can't starve its neighbors,
namespace-scoped RBAC so its credentials are inert everywhere else, and network
policy so its pods can't reach sideways. No single Deployment can widen any of
that, which is exactly what rule 4 is after. Isolation that depends on every
microservice implementing it correctly has a hole in it somewhere. You just
haven't found it yet.

## Admission control

*Rules 5, 6, 7, 9, and 10.*

Most of what's left lands here, because admission control is the one place a
Kubernetes cluster gets to say no.

Rule 10 wants security patterns centralized instead of copy-pasted, and a policy
engine is that made literal:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-non-root
spec:
  validationFailureAction: Enforce
  rules:
    - name: run-as-non-root
      match:
        any:
          - resources:
              kinds: ["Pod"]
      validate:
        message: "Pods must set runAsNonRoot: true"
        pattern:
          spec:
            securityContext:
              runAsNonRoot: true
```

One audited repo, every workload, read by everyone instead of reimplemented by
everyone. Changing a rule is a single edit.

Rule 9 wants security decisions to fail closed. In a validating webhook that's
one field:

```yaml
webhooks:
  - name: validate.kyverno.svc
    failurePolicy: Fail        # Ignore means "unguarded when the engine is down"
    timeoutSeconds: 10
```

Worth being deliberate about, because `Ignore` is the setting that never pages
you and also the one that quietly turns an outage in your policy engine into an
unguarded cluster.

Rule 6 says cryptography is either correct or unused. In practice that means TLS
config is set once at the gateway, minimum versions and cipher suites included,
with cert-manager issuing and rotating certificates. Image signing is the same
family of problem, verified where it can't be skipped:

```yaml
    - name: verify-signature
      match:
        any:
          - resources:
              kinds: ["Pod"]
      verifyImages:
        - imageReferences: ["ghcr.io/dackota/*"]
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/dackota/*"
                    issuer: "https://token.actions.githubusercontent.com"
```

That makes "this artifact is the one we built" something the cluster checks,
rather than a registry tag anyone with push access can move.

Rules 5 and 7 are mostly application-level, though the platform holds some of
the line. Request schemas enforced at the gateway keep malformed input away from
services that might parse it optimistically. The part of rule 7 worth
internalizing is that agent output counts as input. A model response arriving at
your API is external data that took an unusual route to get there, and it earns
the same validation as anything a user typed.

## Logs without sensitive data

*Rule 8: sensitive data is never logged.*

Redaction belongs in the collector, not in every application's logger:

```yaml
processors:
  redaction:
    allow_all_keys: true
    blocked_values:
      - "(?i)bearer\\s+[a-z0-9._-]+"
      - "\\b4[0-9]{12}(?:[0-9]{3})?\\b"   # PAN
    summary: debug
```

If redaction is a library each service is supposed to call, one service will
eventually forget, and that service ships tokens into your log store. As a
collector processor, a service can log a token and still not export one.
App-level hygiene is good and I want it. I just don't want it to be the last
thing standing between a bearer token and permanent searchable storage.

Log access is its own access control problem, too. Logs concentrate more
sensitive material than most of the systems producing them, which puts retention
limits and read permissions inside the security model rather than in the cost
spreadsheet.

## Removal over defense

*Rule 12: design for absence.*

The strongest control available is deletion, and Kubernetes gives you plenty to
delete.

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

Pair that with a distroless base image and there's no shell, no package manager,
and nothing for an attacker to pivot through. Add capabilities back only when
something genuinely needs them, which in practice is almost never. Attack
surface that doesn't exist needs no monitoring.

The unglamorous half is cluster hygiene. CRDs from an operator you removed two
years ago. A ClusterRoleBinding for an audit tool that no longer needs the
access. An Ingress pointing at a Service with no endpoints and no owner. Every
one of those is a live path nobody is watching, and finding them is a couple of
commands:

```bash
# bindings whose subjects no longer exist
kubectl get clusterrolebindings -o json | jq -r '
  .items[] | select(.subjects != null) |
  .metadata.name + " -> " + (.subjects[].name // "?")'

# services routing to nothing
kubectl get endpoints -A -o json | jq -r '
  .items[] | select(.subsets == null) |
  "\(.metadata.namespace)/\(.metadata.name)"'
```

Deleting things on a schedule is security work, and it's the cheapest security
work on offer.

## What connects them

All twelve hold up better as cluster controls than as conventions, for the same
reason every time: conventions have exceptions and admission controllers don't.
A wiki page telling teams to add a default-deny NetworkPolicy gets you a cluster
where most namespaces have one. A policy gets you a cluster where all of them
do, and where the real exceptions are visible, named, and attributable to
someone.

That last part is where the cost shows up, and it's worth saying out loud.
Policy-as-code generates an exception queue, and somebody has to own it. When
nobody does, the queue becomes a backlog, the backlog becomes pressure, and the
pressure eventually produces a blanket exclusion that switches the control off
without anyone deciding to. A control lasts about as long as the team's appetite
for saying no.

Still worth it, in my view. Reviewing exceptions is work you can put in the
calendar. The alternative shows up whenever it likes.
