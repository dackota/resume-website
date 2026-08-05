+++
title = 'Beyond "Good Enough": Hardening a K8s Cluster Against Modern Threats'
date = 2026-08-04
summary = "Twelve non-negotiable security practices, inspired by Project Glasswing, and what each one actually looks like in a Kubernetes cluster."
tags = ["kubernetes", "security", "platform-engineering"]
draft = false
aliases = ["/twelve-non-negotiables-kubernetes/"]
+++

If you've been in the dev world long enough, you know the drill: security is
usually an afterthought or a checklist we tackle at the very end of a sprint.
But as AI-driven attacks move from "slow and steady" to "instantaneous," we 
have to move from reactive patching to proactive, architectural security.

Visa recently published a [whitepaper](https://corporate.visa.com/content/dam/VCOM/corporate/visa-perspectives/security-and-trust/documents/project-glasswing.pdf) on their experience with Project Glasswing,
where they took Anthropic's Mythos model and pointed it at their own systems. 

If you're unaware, Project Glasswing is Anthropic's defensive
cybersecurity program, built around Claude Mythos Preview — an unreleased
frontier model good enough at finding and exploiting vulnerabilities to beat
most humans at it. Anthropic gave access to launch partners and 40-odd other
organizations that maintain critical infrastructure. Between them they've
reported [more than ten thousand high or critical vulnerabilities](https://www.anthropic.com/research/glasswing-initial-update)
in some of the most load-bearing software on the internet.

When they pointed Mythos at their own environment it found critical issues but
none of them turned into a real path in, because zero-trust controls and
network segmentation were already in the way. That's the part I find
encouraging: the architecture did the work, not the response time.

The takeaway I keep coming back to is that finding bugs stopped being the
bottleneck. Verifying, disclosing, and patching them is the bottleneck now. If
your security story is "we patch fast," you've bet the whole thing on the one
number that's moving in the wrong direction.

Their experiences led them to establish 12 non‑negotiable architectural security 
practices:

1. Secrets never live in code
2. Authorization is server side, explicit, and
mandatory
3. “Internal” is not a security boundary
4. Tenant isolation is centrally enforced
5. No raw HTML or script rendering
6. Cryptography is either correct or not used
7. Inputs are hostile until proven otherwise:
8. Sensitive data is never logged
9. Security decisions fail closed
10. Security patterns are centralized, not
copy‑pasted
11. AI agents are identities
12. Design for absence

So for each of the twelve, I'm asking the same question: what in the cluster
actually enforces this, so that a team shipping at 4pm on a Friday can't just
route around it?

## Secrets and identity

*Rules 1 and 11: keep secrets out of code, and treat AI agents as identities.*

Nothing sensitive lives in the manifest repo. Secrets sit in a secret manager,
and External Secrets Operator pulls them into the cluster at runtime. What we
actually commit is a pointer:

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

Rotating that password is a change in Vault. No PR, no manifest edit, nobody
has to remember anything.

The scanning side matters just as much, and it's worth being honest about which
half does the work. gitleaks runs pre-commit and again in CI. The hook is a
nice courtesy to whoever's committing. The required CI check is the thing that
actually stops a leaked key from landing.

For workloads, short-lived tokens instead of a static JSON key on disk:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payments
  annotations:
    iam.gke.io/gcp-service-account: payments@project.iam.gserviceaccount.com
```

A key file in a Secret never expires, copies cleanly, and keeps working long
after whoever generated it has moved on. A projected token expires whether or
not anyone's watching.

Rule 11 is the one I think most of us haven't caught up on yet. If an agent
calls your APIs, it's a principal, and it gets treated like one:

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

We all know the alternative, because we've all inherited it: the shared
`automation` account that quietly collected permissions over three years and
shows up in the audit log as one anonymous blob. When agent credentials leak,
you want two answers fast — what could it reach, and what did it reach. Those
are IAM properties. They only exist if you built them.

## Trust boundaries

*Rules 2, 3, and 4: authorize server-side, stop treating "internal" as a
boundary, enforce tenant isolation centrally.*

Every namespace gets a default-deny NetworkPolicy. It's four lines, and it
changes the shape of the entire cluster:

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

Now pods reach what we've explicitly allowed and nothing else, which means
lateral movement is something an attacker has to build rather than something
the network hands over for free. Layer mesh mTLS on top and a pod-to-pod
connection is authenticated, not trusted for the crime of having come from
inside the cluster. That's rule 3 in a sentence: the pod next door is not your
friend.

Authorization lives at the gateway and mesh layer, as policy, not sprinkled
through application code:

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

The service receives a request that's already been authorized and doesn't get a
vote in the matter. Rule 2 holds even for the service somebody wrote at the end
of a very long week.

Tenant isolation is the same trick one level up. A tenant is a namespace with
real edges: ResourceQuota so it can't starve its neighbors, namespace-scoped
RBAC so its credentials are useless anywhere else, network policy so it can't
reach sideways. Nothing a single Deployment can widen, which is the whole point
of rule 4. If your isolation depends on every microservice getting it right,
there's a gap in there somewhere. You just haven't found it yet.

## Admission control

*Rules 5, 6, 7, 9, and 10.*

Most of what's left lands here, because admission control is the one place a
Kubernetes cluster gets to say "no."

Rule 10 wants security patterns centralized instead of copy-pasted, and a
policy engine is that idea made literal:

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
everyone. Change a rule and it changes once.

Rule 9 wants security decisions to fail closed. In a validating webhook that's
a single field:

```yaml
webhooks:
  - name: validate.kyverno.svc
    failurePolicy: Fail        # Ignore means "unguarded when the engine is down"
    timeoutSeconds: 10
```

`Ignore` is the setting that never pages you, it's also the setting that turns a bad afternoon
for your policy engine into a completely unguarded cluster.

Rule 6 says crypto is either correct or you don't use it. Practically, that
means TLS config gets set once at the gateway, minimum versions and cipher
suites included, with cert-manager handling issuance and rotation. Image
signing is the same species of problem, checked where it can't be skipped:

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

Now "this image is the one we built" is something the cluster verifies, instead
of a registry tag that anyone with push access can move.

Rules 5 and 7 are mostly application-level, but the platform can still carry
some of the weight. Request schemas at the gateway keep malformed input away
from services that might parse it a little too eagerly. And the bit of rule 7
worth tattooing somewhere: agent output is input. A model response hitting your
API is external data that took a scenic route, and it gets validated exactly
like anything a user typed.

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

If redaction is a library every service is supposed to remember to call, one of
them will forget, and that one ships tokens straight into your log store. As a
collector processor, a service can log a token and still not export one. I want
good app-level hygiene too — I just don't want it to be the last thing standing
between a bearer token and permanent, searchable storage.

Worth remembering that log access is its own access control problem. Logs
concentrate more sensitive material than most of the systems producing them,
which puts retention limits and read permissions squarely inside the security
model, not in the cost spreadsheet.

## Removal over defense

*Rule 12: design for absence.*

The strongest control available is deletion, and Kubernetes gives us plenty to
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

Pair that with a distroless base image and there's no shell, no package
manager, and nothing to pivot through. Add capabilities back only when
something genuinely needs them, which is almost never. Attack surface that
doesn't exist needs no monitoring, no CVE triage, and no 3am page.

Then there's the unglamorous half: cluster hygiene. CRDs from an operator we
removed two years ago. A ClusterRoleBinding for an audit tool that doesn't need
the access anymore. An Ingress pointing at a Service with no endpoints and no
owner. Every one of those is a live path nobody's watching, and finding them is
a couple of commands:

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
work you'll ever do.

## What ties it together

All twelve hold up better as cluster controls than as team conventions, for the
same reason every time: conventions have exceptions and admission controllers
don't. A wiki page telling everyone to add a default-deny NetworkPolicy gets
you a cluster where some namespaces have one. A policy gets you a cluster where
all of them do, and where the real exceptions are visible, named, and owned by
somebody.
