# Human reference answers

The judge never sees this file. It exists so the post can show where an
automated grade and a human grade disagree. Review and correct anything wrong
before publishing: this is the human half of the calibration, and if it is
wrong the whole comparison is worthless.

## 1. Pod is CrashLoopBackOff with exit code 137

137 is 128 + 9, so SIGKILL. Usually the cgroup OOM killer, but not always:
node-pressure eviction, a liveness probe kill, and a manual delete land on the
same code.

Confirm it in `.status.containerStatuses[].lastState.terminated.reason`, not in
Events. Events age out; the container status does not. An OOMKill also means
`kubectl logs --previous` is often empty, because the process died without
flushing.

**Fails if:** it says 137 always means OOM, or points only at Events, or treats
`--previous` logs as the confirmation step.

## 2. Which container in the pod got OOMKilled

Per-container, so per-container state is the only place that answers it:

```
kubectl get pod <pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.lastState.terminated.reason}{"\n"}{end}'
```

`kubectl describe pod` works too, reading Last State under each container.

**Fails if:** it reaches for `kubectl logs --previous` (does not name the
container that died), `kubectl top pod` (live usage, the container is already
gone), or node-level `dmesg` as the first step.

## 3. HPA not scaling up though CPU is at 95%

The HPA computes CPU against the pod's **requests**, not its limits and not the
node. With `resources.requests.cpu` unset, the HPA reports `<unknown>` and
refuses to scale. That is the most common cause and it is invisible from a node
graph reading 95%.

After that: metrics-server missing or unhealthy, `maxReplicas` already reached,
and the scale-up stabilization window.

`kubectl describe hpa <name>` shows all of it in Conditions and Events.

**Fails if:** it says limits instead of requests, blames metrics-server first
without mentioning requests, or jumps to raising `maxReplicas`.

## 4. kubectl command for a Pending pod

```
kubectl describe pod <pod>
```

Read the Events at the bottom. The scheduler writes the reason there:
`Insufficient cpu`, `Insufficient memory`, untolerated taints, node affinity
mismatch, or an unbound PersistentVolumeClaim.

**Fails if:** it invents a flag, or suggests `kubectl logs` (a Pending pod has
never started, so there are no logs).

## 5. cert-manager Order stuck

Walk the chain downward; each object names its child in the status:

```
Certificate -> CertificateRequest -> Order -> Challenge
```

```
kubectl describe order <order>
kubectl get challenge -A
kubectl describe challenge <challenge>
```

The Challenge's `status.reason` carries the ACME error verbatim, which is where
the actual cause lives (DNS not propagated, HTTP-01 solver pod unreachable, rate
limit).

**Fails if:** it invents a `kubectl` subcommand or a `cmctl` flag that does not
exist, or stops at "read the cert-manager controller logs" without walking the
chain.

## 6. Traefik 404 on a route that exists

The route object existing is not the same as Traefik having accepted it. Check,
in order:

- The route's status. For Gateway API, `status.parents[].conditions` gives
  `Accepted` and `ResolvedRefs`. A route that failed to attach is silently 404.
- entryPoint mismatch: attached to `web` while the request arrives on
  `websecure`, or the reverse.
- The `Host()` matcher not matching the actual Host header.
- The backend Service in a different namespace than the route, with no
  ReferenceGrant.
- Traefik not watching the route's namespace.

Traefik's own API at `/api/http/routers` shows what it actually loaded, which
settles it faster than reading manifests.

**Fails if:** it only says "check the IngressRoute exists", or blames DNS or the
Service without mentioning route attachment status.

## What I checked rather than assumed

Two calls in the answers looked invented to me and only one was:

- `kubectl get pod -o jsonpath='{.spec.containers[].resources}'` (answer `0b`).
  Empty brackets are valid. `kubectl create -f pod.yaml --dry-run=client -o
  jsonpath=...` on kubectl 1.36 returns the resources block, same as `[*]`.
  I was wrong to suspect it.
- `kubectl get pod -o jsonpath='{.status.containerStatuses[*].{name:.name,...}}'`
  (answer `1a`). kubectl's jsonpath has no object construction. Same offline
  test exits with `unrecognized character in action: U+007B '{'`. This one is
  invented, and it is why that answer fails.

The `acme.cert-manager.io/order-name` label on Challenge resources is **not**
real, and I got this wrong twice before getting it right. A web search told me
confidently that it exists, so I first graded answer `4a` as a pass. The judge
failed it and said the label does not exist. A code search across
cert-manager/cert-manager returns exactly one hit for `order-name`, and it is a
`<order-name>` placeholder inside a kubectl command in `design/
acme-orders-challenges-crd.md`. No label constant, no map literal, nothing in
the order controller. Challenges are linked to their Order by ownerReference
and name prefix.

So `4a` fails, and the correction came from the thing I was auditing.

These grades were written before reading any of the judge's verdicts. That
order matters: grading after seeing the judge's answer is not an independent
reference, it is agreement. One grade (`4a`) changed afterwards, and the reason
for the change is recorded in `human-grades.json` rather than quietly applied,
because a reference that edits itself to match the judge is worth nothing.
