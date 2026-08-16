/* me.dackota.com — platform-console resume interactions.
   Vanilla JS, CSP script-src 'self' (no inline handlers anywhere). */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================= tracing core =================
     An OTel-shaped span store: real trace/span ids, real attributes, real
     status codes. The trace explorer section renders it, and the exporter
     below ships it to Honeycomb over OTLP. The trace id is still random per
     tab and dies with it — but the root span also carries a `visitor.id`,
     a random UUID kept in a first-party cookie, so page-view spans from the
     same browser can be correlated across visits. See getVisitorId() below
     for exactly what that cookie holds and doesn't. */
  var Trace = (function () {
    var HEX = "0123456789abcdef";
    function hex(len) {
      var out = "";
      var bytes = new Uint8Array(len);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
      for (var i = 0; i < len; i += 1) out += HEX[bytes[i] % 16];
      return out;
    }

    // A stable, anonymous per-visitor id: a random (v4) UUID, not derived
    // from anything identifying (no IP, no fingerprint), held in a
    // first-party cookie so it survives across tabs and visits. It carries
    // no PII on its own — it's an opaque correlation key, same idea as a
    // Honeycomb/analytics "anonymous id".
    var VISITOR_COOKIE = "visitor_id";
    var VISITOR_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

    function readCookie(name) {
      var m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    }

    function getVisitorId() {
      var existing = readCookie(VISITOR_COOKIE);
      if (existing) return existing;

      // Build a UUID v4 out of the same CSPRNG bytes used for trace/span
      // ids, with the version/variant nibbles forced per RFC 4122.
      var b = hex(32);
      var version = "4" + b.slice(13, 16);
      var variant = "89ab".charAt(parseInt(b[16], 16) & 0x3) + b.slice(17, 20);
      var id = b.slice(0, 8) + "-" + b.slice(8, 12) + "-" + version + "-" + variant + "-" + b.slice(20, 32);

      var cookie = VISITOR_COOKIE + "=" + id + "; Path=/; Max-Age=" + VISITOR_MAX_AGE + "; SameSite=Lax";
      // Secure is conditional so a plain `docker build && docker run` over
      // http (no TLS-terminating proxy in front) still persists the cookie.
      if (location.protocol === "https:") cookie += "; Secure";
      document.cookie = cookie;
      return id;
    }

    var t0 = performance.now();
    var traceId = hex(32);
    var subscribers = [];
    var MAX_SPANS = 90;

    var root = {
      id: hex(16), parentId: null, depth: 0,
      name: "GET /", service: "frontend", kind: "SERVER",
      start: 0, end: null, status: "UNSET", objective: null,
      attrs: {
        "http.method": "GET",
        "http.route": "/",
        "http.status_code": 200,
        "browser.viewport": window.innerWidth + "x" + window.innerHeight,
        "telemetry.sdk.name": "hand-rolled, 200 lines, no dependencies",
        "visitor.id": getVisitorId()
      }
    };
    var spans = [root];

    function notify() {
      for (var i = 0; i < subscribers.length; i += 1) subscribers[i]();
    }

    function now() { return performance.now() - t0; }

    // The trace is measured to its last recorded event, not to wall-clock now.
    // The root span never ends, so anchoring on now() made every duration climb
    // forever while the page sat idle. Clipping open spans here freezes the
    // whole view between events — which is also what makes a repaint timer
    // unnecessary: nothing can change until a span starts or ends.
    var lastEventAt = 0;

    function duration(s) {
      var until = s.end === null ? lastEventAt : s.end;
      return Math.max(until - s.start, 0);
    }

    function breached(s) {
      return s.objective !== null && s.end !== null && duration(s) > s.objective;
    }

    function start(name, opts) {
      opts = opts || {};
      if (spans.length >= MAX_SPANS) {
        // Evict a span the exporter has already shipped, in preference to one
        // still waiting on a flush — dropping the latter would lose it before
        // it ever reached Honeycomb. Falling back to any ended span keeps the
        // cap hard even while a flush is pending.
        var victim = -1;
        for (var i = 1; i < spans.length; i += 1) {
          if (spans[i].end === null) continue;
          if (spans[i].otlpSent) { victim = i; break; }
          if (victim === -1) victim = i;
        }
        if (victim > 0) spans.splice(victim, 1);
      }
      var span = {
        id: hex(16), parentId: opts.parentId || root.id, depth: opts.depth || 1,
        name: name, service: opts.service || "frontend", kind: opts.kind || "INTERNAL",
        start: now(), end: null, status: "UNSET",
        objective: typeof opts.objective === "number" ? opts.objective : null,
        attrs: opts.attrs || {}
      };
      lastEventAt = span.start;
      spans.push(span);
      notify();
      return {
        span: span,
        attr: function (k, v) { span.attrs[k] = v; notify(); },
        end: function (opt) {
          if (span.end !== null) return span;
          opt = opt || {};
          span.end = now();
          lastEventAt = span.end;
          if (opt.attrs) {
            for (var k in opt.attrs) { if (opt.attrs.hasOwnProperty(k)) span.attrs[k] = opt.attrs[k]; }
          }
          span.status = opt.status || "OK";
          notify();
          return span;
        }
      };
    }

    return {
      traceId: function () { return traceId; },
      rootId: function () { return root.id; },
      spans: function () { return spans; },
      start: start,
      now: now,
      lastEvent: function () { return lastEventAt; },
      duration: duration,
      breached: breached,
      onChange: function (fn) { subscribers.push(fn); }
    };
  })();

  /* ================= OTLP export =================
     The store above is genuine OpenTelemetry data, so it is shipped as genuine
     OpenTelemetry: OTLP/HTTP with a JSON body, POSTed same-origin to
     /v1/traces. nginx forwards that to Honeycomb and attaches the ingest key
     there — which is why no key appears in this file, why the CSP is still
     connect-src 'self', and why the unload path can use sendBeacon (it cannot
     set headers). No SDK, no bundler, no dependency: the wire format is a
     couple of nested objects and JSON.stringify.

     What leaves the page: span names, durations, and the attributes the trace
     explorer already shows you — including `visitor.id` on the root span, a
     random UUID kept in a first-party cookie (see getVisitorId() above). No
     fingerprinting, no third-party sharing, and the URL is reduced to its
     path so a query string can't smuggle one out. */
  (function () {
    var ENDPOINT = "/v1/traces";
    var SERVICE_NAME = "resume-website";
    var FLUSH_MS = 5000;

    var SPAN_KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };
    var STATUS_CODE = { UNSET: 0, OK: 1, ERROR: 2 };

    // Trace measures milliseconds from its own init; OTLP wants nanoseconds
    // from the unix epoch. timeOrigin anchors the page to the epoch (the
    // fallback covers browsers without it), and Trace.now() recovers Trace's
    // offset from it without reaching into the closure above.
    var epochBaseMs = (performance.timeOrigin || (Date.now() - performance.now()))
      + (performance.now() - Trace.now());

    function pad6(n) {
      var s = String(n);
      while (s.length < 6) s = "0" + s;
      return s;
    }

    // ~1.7e18 nanoseconds does not survive a double, so the value is assembled
    // as text: whole milliseconds since the epoch, then the sub-millisecond
    // remainder as six digits.
    function unixNano(relMs) {
      var abs = epochBaseMs + relMs;
      var ms = Math.floor(abs);
      var sub = Math.round((abs - ms) * 1e6);
      if (sub >= 1e6) { ms += 1; sub -= 1e6; }
      return String(ms) + pad6(sub);
    }

    function anyValue(v) {
      if (typeof v === "boolean") return { boolValue: v };
      if (typeof v === "number") {
        // OTLP intValue is a string because the field is a 64-bit int in proto.
        return v % 1 === 0 ? { intValue: String(v) } : { doubleValue: v };
      }
      return { stringValue: String(v) };
    }

    function attributes(obj) {
      var out = [];
      Object.keys(obj).forEach(function (k) {
        out.push({ key: k, value: anyValue(obj[k]) });
      });
      return out;
    }

    // The asset URLs carry the release version (substituted at image build),
    // which makes service.version free — no build step had to supply it.
    // Resolved here at load rather than inside resource(): currentScript is
    // only non-null while this file is executing, and resource() runs later,
    // on every flush.
    //
    // An unbuilt checkout reports "dev": the substitution only rewrites .html,
    // so the version is whatever index.html carries, and there the build-time
    // placeholder is still in place. It is matched by its leading underscores
    // rather than spelled out, because the image build greps every file for
    // that literal and fails if one survives — writing it here would fail it.
    var SERVICE_VERSION = (function () {
      var script = document.currentScript
        || document.querySelector('script[src*="/assets/app.js"]');
      var m = /[?&]v=([^&]+)/.exec((script && script.getAttribute("src")) || "");
      if (!m || m[1].indexOf("__") === 0) return "dev";
      return decodeURIComponent(m[1]);
    })();

    function resource() {
      return {
        attributes: attributes({
          "service.name": SERVICE_NAME,
          "service.version": SERVICE_VERSION,
          "telemetry.sdk.name": "hand-rolled",
          "telemetry.sdk.language": "webjs",
          "browser.language": navigator.language || "unknown",
          "browser.user_agent": navigator.userAgent,
          "browser.viewport": window.innerWidth + "x" + window.innerHeight,
          // Path only — never location.href. A query string or fragment is the
          // one part of a URL a third party can choose, so it stays here.
          "page.path": location.pathname
        })
      };
    }

    function toOtlpSpan(s, endMs) {
      var attrs = {};
      for (var k in s.attrs) {
        if (s.attrs.hasOwnProperty(k)) attrs[k] = s.attrs[k];
      }
      // The SLO verdict is derived in the UI rather than stored on the span;
      // sending it too means Honeycomb can group on it without re-deriving.
      if (s.objective !== null) {
        attrs["slo.objective_ms"] = s.objective;
        attrs["slo.breached"] = Trace.breached(s);
      }

      var span = {
        traceId: Trace.traceId(),
        spanId: s.id,
        name: s.name,
        kind: SPAN_KIND[s.kind] || SPAN_KIND.INTERNAL,
        startTimeUnixNano: unixNano(s.start),
        endTimeUnixNano: unixNano(endMs),
        attributes: attributes(attrs),
        status: { code: STATUS_CODE[s.status] || STATUS_CODE.UNSET }
      };
      if (s.parentId) span.parentSpanId = s.parentId;
      return span;
    }

    // Spans go out once, marked on the span itself so the store's eviction can
    // see which ones are safe to drop.
    function collect(closeRoot) {
      var out = [];
      var all = Trace.spans();
      for (var i = 0; i < all.length; i += 1) {
        var s = all[i];
        if (s.otlpSent) continue;
        if (s.end !== null) {
          s.otlpSent = true;
          out.push(toOtlpSpan(s, s.end));
        } else if (closeRoot && s.id === Trace.rootId()) {
          // The root span deliberately never ends — the UI depends on that.
          // On the final flush it is closed to the last recorded event, or the
          // trace would sit in Honeycomb permanently rootless.
          s.otlpSent = true;
          out.push(toOtlpSpan(s, Trace.lastEvent()));
        }
      }
      return out;
    }

    function send(spans, unloading) {
      if (!spans.length) return;
      var body = JSON.stringify({
        resourceSpans: [{
          resource: resource(),
          scopeSpans: [{
            scope: { name: "me.dackota.com/trace", version: "1" },
            spans: spans
          }]
        }]
      });

      // A page going away takes its fetches with it; sendBeacon hands the
      // request to the browser to finish on its own.
      if (unloading && navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
        return;
      }
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true
      })["catch"](function () {
        // Telemetry is never allowed to break the page it measures.
      });
    }

    function flush(closeRoot, unloading) {
      send(collect(closeRoot), unloading);
    }

    setInterval(function () { flush(false, false); }, FLUSH_MS);

    // Two listeners, because neither covers the other: pagehide is the only
    // one that fires reliably on a bfcache navigation, and the hidden
    // transition is what catches a mobile tab switch that never comes back.
    // Only pagehide closes the root — a tab switch is not the end of the
    // visit, and a root closed at the first blur would report a false duration.
    window.addEventListener("pagehide", function () { flush(true, true); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flush(false, true);
    });
  })();

  function fmtDur(ms) {
    if (ms < 1) return ms.toFixed(2) + "ms";
    if (ms < 1000) return Math.round(ms) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    return Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s";
  }

  /* ================= hero: typed kubectl ================= */
  var HERO_CMD = "kubectl get engineers -l role=platform-lead";
  var HERO_OUT =
    "NAME      READY   STATUS    RESTARTS   AGE\n" +
    "dackota   1/1     <span class=\"ok\">Running</span>   0          10y+";

  function typeHero() {
    var cmdEl = document.getElementById("hero-cmd");
    var outEl = document.getElementById("hero-out");
    var caret = document.getElementById("hero-caret");
    if (!cmdEl || !outEl) return;

    // No latency objective: the typing is deliberate theatre, not slowness.
    var span = Trace.start("hero.render", {
      attrs: { "render.mode": reducedMotion ? "reduced-motion" : "typed", "hero.command": HERO_CMD }
    });

    if (reducedMotion) {
      cmdEl.textContent = HERO_CMD;
      outEl.innerHTML = "\n" + HERO_OUT;
      if (caret) caret.remove();
      span.end();
      return;
    }
    var i = 0;
    (function tick() {
      if (i <= HERO_CMD.length) {
        cmdEl.textContent = HERO_CMD.slice(0, i);
        i += 1;
        setTimeout(tick, 28 + Math.random() * 40);
      } else {
        setTimeout(function () {
          outEl.innerHTML = "\n" + HERO_OUT;
          if (caret) caret.remove();
          span.end();
        }, 250);
      }
    })();
  }

  /* ================= career pipeline tabs ================= */
  var stageOrder = ["sysadmin", "sre", "lead"];
  var stagePanels = { sysadmin: "stage-sysadmin", sre: "stage-sre", lead: "stage-lead" };
  var stageTabs = { sysadmin: "tab-sysadmin", sre: "tab-sre", lead: "tab-lead" };

  function selectStage(stage) {
    stageOrder.forEach(function (s) {
      var tab = document.getElementById(stageTabs[s]);
      var panel = document.getElementById(stagePanels[s]);
      var active = s === stage;
      if (tab) tab.setAttribute("aria-selected", active ? "true" : "false");
      if (panel) panel.hidden = !active;
    });
  }

  function initPipeline() {
    stageOrder.forEach(function (s) {
      var tab = document.getElementById(stageTabs[s]);
      if (tab) tab.addEventListener("click", function () {
        var span = Trace.start("stage.select", {
          service: "career-api", kind: "SERVER", objective: 50,
          attrs: { "stage.name": s, "stage.namespace": s === "lead" ? "panasonic-gaai" : "keap" }
        });
        selectStage(s);
        span.end();
      });
    });

    var promote = document.getElementById("promote-btn");
    var note = document.getElementById("promote-note");
    var promoteIdx = -1;
    if (promote) {
      promote.addEventListener("click", function () {
        promoteIdx = (promoteIdx + 1) % stageOrder.length;
        var stage = stageOrder[promoteIdx];
        var span = Trace.start("freight.promote", {
          service: "kargo", kind: "CLIENT", objective: 50,
          attrs: { "kargo.freight": "dackota@sha-2015", "kargo.stage": stage, "promotion.mode": "one-click" }
        });
        selectStage(stage);
        span.end();
        if (note) {
          var labels = {
            sysadmin: "freight dackota@sha-2015 promoted → keap/sysadmin ✓ verified",
            sre: "freight dackota@sha-2015 promoted → keap/sre ✓ verified",
            lead: "freight dackota@sha-2015 promoted → panasonic-gaai/platform-lead ✓ running in prod"
          };
          note.textContent = labels[stage];
        }
      });
    }
  }

  /* ================= metrics count-up ================= */
  function initMetrics() {
    var els = Array.prototype.slice.call(document.querySelectorAll(".metric-value"));
    function render(el, n) {
      el.textContent = (el.getAttribute("data-prefix") || "") + n + (el.getAttribute("data-suffix") || "");
    }
    if (reducedMotion || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { render(el, parseInt(el.getAttribute("data-count"), 10)); });
      return;
    }
    var seen = new WeakSet();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || seen.has(entry.target)) return;
        seen.add(entry.target);
        var el = entry.target;
        var target = parseInt(el.getAttribute("data-count"), 10);
        var start = null;
        var dur = 900;
        function step(ts) {
          if (start === null) start = ts;
          var p = Math.min((ts - start) / dur, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          render(el, Math.round(target * eased));
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
        io.unobserve(el);
      });
    }, { threshold: 0.4 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ================= interactive terminal ================= */

  var JOBS = {
    "platform-lead": {
      ns: "panasonic-gaai",
      title: "Platform Engineering Lead",
      dates: "Jun 2022 - Jul 2026",
      where: "Panasonic Global Applied AI (formerly Yohana / Panasonic Well), Remote",
      bullets: [
        "Led the 4-person platform team behind KanpAI — 20+ production AI agents, 10+ business units, US + Japan",
        "Replaced Spinnaker with self-service GitOps (ArgoCD, Argo Workflows/Events): setup 6h -> 10min, lead time 1h -> 15min, 15 -> 228 microservices",
        "Trunk-based single-artifact promotion with Kargo: weekly -> 15 deploys/day across 5 teams",
        "helm-generic-app chart: new-service packaging 3h -> 5min across 16 microservices",
        "Tenant onboarding: 7 days of manual Vault + Terraform -> minutes with a git push",
        "Zero customer-impacting incidents in GAAI's first 10 months",
        "Kyverno policy-as-code, default-deny NetworkPolicies, per-tenant gateways; built a red-team env in 3h",
        "DR verified: Velero + CSI snapshot restore drills, cross-region failover",
        "Drove the carve-out onto GAAI's own AWS foundation — zero data loss",
        "3-week SRE workshop in Japan: 20 engineers, 12 Panasonic subsidiaries"
      ]
    },
    "sre": {
      ns: "keap",
      title: "Site Reliability Engineer",
      dates: "Nov 2018 - Apr 2022",
      where: "Keap (formerly Infusionsoft), Chandler AZ",
      bullets: [
        "Immutable infrastructure via CI/CD: Packer, Terraform, Ansible, Docker, GitHub Actions",
        "Cut $100K migrating VMs -> Kubernetes: multistage builds, Helm, HPA/VPA, spot node pools",
        "HA logging with Fluentd / Fluent Bit; per-team quotas saved $1K/month",
        "24/7 on-call, OpsGenie auto-remediation, PCI compliance, postmortems"
      ]
    },
    "sysadmin": {
      ns: "keap",
      title: "System Administrator",
      dates: "Feb 2015 - Nov 2018",
      where: "Keap (formerly Infusionsoft), Chandler AZ",
      bullets: [
        "Windows, macOS, and Linux fleets; provisioning + inventory automated with Bash, Python, PowerShell",
        "Identity and access via Okta"
      ]
    }
  };

  var SKILL_NS = {
    "delivery": ["ci-cd", "github-actions", "trunk-based-dev", "release-please", "renovate", "immutable-infra", "dora"],
    "gitops": ["kargo", "argocd", "argo-workflows", "argo-events", "argo-rollouts", "multi-region-promotion"],
    "cloud-iac": ["aws-eks", "multi-account-org", "terraform", "terragrunt", "ansible", "packer", "ack-controllers", "gcp"],
    "kubernetes-platform": ["helm-chart-design", "istio", "traefik-gateway-api", "vault", "external-secrets", "cert-manager", "karpenter", "keda", "velero", "crossplane"],
    "security": ["supply-chain", "multi-tenant-isolation", "networkpolicies", "kyverno", "okta-sso", "rbac", "oidc-oauth", "pci"],
    "observability": ["datadog", "prometheus-grafana", "new-relic", "slos-error-budgets", "disaster-recovery", "incident-response"],
    "languages": ["go", "python", "bash", "linux", "git"],
    "ai-tooling": ["claude-code", "litellm", "internal-dev-platforms", "self-service-clis"],
    "leadership": ["team-leadership", "roadmap-ownership", "mentoring-1on1s", "cross-team-direction"]
  };

  function pad(s, n) {
    s = String(s);
    while (s.length < n) s += " ";
    return s;
  }

  var termLog, termInput, termScroll;
  var history = [];
  var histIdx = -1;

  function print(text, cls) {
    var div = document.createElement("div");
    div.className = cls || "line-out";
    div.textContent = text;
    termLog.appendChild(div);
  }

  function printCmd(cmd) {
    var div = document.createElement("div");
    div.className = "line-cmd";
    var p = document.createElement("span");
    p.className = "prompt";
    p.textContent = "dackota@me:~$";
    div.appendChild(p);
    div.appendChild(document.createTextNode(" " + cmd));
    termLog.appendChild(div);
  }

  function scrollTerm() {
    termScroll.scrollTop = termScroll.scrollHeight;
  }

  function cmdHelp() {
    print("available commands:", "line-cyan");
    print("  help                          this menu");
    print("  whoami                        who you're talking to");
    print("  contact                       ways to reach me");
    print("  kubectl get jobs              career history");
    print("  kubectl describe job <name>   deep-dive a role (platform-lead | sre | sysadmin)");
    print("  kubectl get skills -A         every skill namespace");
    print("  kubectl get pods -n <ns>      skills in one namespace (e.g. gitops)");
    print("  argocd app sync career        re-sync the whole resume");
    print("  trace                         the spans this visit has produced");
    print("  slo                           this session's SLI and error budget");
    print("  dora                          live DORA metrics for this site's repo");
    print("  changes [--repo <name>]       live change feed from my own platform");
    print("  helm install interview .      generate an interview");
    print("  cat resume.md                 the plain-text version");
    print("  history | clear | exit        the usual");
    print("  ...and a few things help doesn't mention", "line-warn");
  }

  function cmdWhoami() {
    print("dackota — platform engineering lead. 10+ years building the platforms other engineers ship on.");
    print("uid=1000(dackota) gid=1000(platform-team) groups=argocd-admins,kargo-operators,vault-unsealers,japan-workshop-alumni");
  }

  function cmdContact() {
    print("email:      dackota.j@gmail.com", "line-cyan");
    print("github:     github.com/dackota", "line-cyan");
    print("linkedin:   linkedin.com/in/dackota-johnson", "line-cyan");
    print("consulting: consulting.dackota.com", "line-cyan");
  }

  function cmdGetJobs() {
    print(pad("NAME", 16) + pad("NAMESPACE", 16) + pad("COMPLETIONS", 14) + pad("DURATION", 12) + "STATUS");
    print(pad("platform-lead", 16) + pad("panasonic-gaai", 16) + pad("1/1", 14) + pad("4.1y", 12) + "Complete");
    print(pad("sre", 16) + pad("keap", 16) + pad("1/1", 14) + pad("3.5y", 12) + "Complete");
    print(pad("sysadmin", 16) + pad("keap", 16) + pad("1/1", 14) + pad("3.75y", 12) + "Complete");
    print("");
    print("hint: kubectl describe job platform-lead", "line-warn");
  }

  function cmdDescribeJob(name) {
    var key = name;
    if (key === "panasonic" || key === "gaai" || key === "lead") key = "platform-lead";
    if (key === "keap") key = "sre";
    var job = JOBS[key];
    if (!job) {
      print("Error from server (NotFound): jobs \"" + name + "\" not found — try: platform-lead, sre, sysadmin", "line-err");
      return;
    }
    print("Name:         " + key, "line-cyan");
    print("Namespace:    " + job.ns, "line-cyan");
    print("Title:        " + job.title);
    print("Where:        " + job.where);
    print("Duration:     " + job.dates);
    print("Events:");
    job.bullets.forEach(function (b) { print("  ✓ " + b, "line-ok"); });
  }

  function cmdGetSkills() {
    print(pad("NAMESPACE", 24) + pad("PODS", 8) + "STATUS");
    Object.keys(SKILL_NS).forEach(function (ns) {
      print(pad(ns, 24) + pad(SKILL_NS[ns].length + "/" + SKILL_NS[ns].length, 8) + "Running", "line-ok");
    });
    print("");
    print("hint: kubectl get pods -n gitops", "line-warn");
  }

  function cmdGetPods(ns) {
    var pods = SKILL_NS[ns];
    if (!pods) {
      if (ns === "observability-reliability") { pods = SKILL_NS["observability"]; }
      else {
        print("Error from server (NotFound): namespaces \"" + ns + "\" not found", "line-err");
        print("namespaces: " + Object.keys(SKILL_NS).join(", "));
        return;
      }
    }
    print(pad("NAME", 30) + pad("READY", 8) + pad("STATUS", 10) + "RESTARTS");
    pods.forEach(function (p) {
      print(pad(p + "-" + Math.random().toString(16).slice(2, 7), 30) + pad("1/1", 8) + pad("Running", 10) + "0", "line-ok");
    });
  }

  function cmdSync(done) {
    var steps = [
      ["syncing app career (target: HEAD, repo: life/dackota) ...", "line-out"],
      ["  ✓ Job/sysadmin            Synced   Healthy  (2015-2018)", "line-ok"],
      ["  ✓ Job/sre                 Synced   Healthy  (2018-2022)", "line-ok"],
      ["  ✓ Job/platform-lead       Synced   Healthy  (2022-2026)", "line-ok"],
      ["  ✓ ConfigMap/skills        Synced   9 namespaces, all pods Running", "line-ok"],
      ["  ✓ Secret/ambition         Synced   (values redacted)", "line-ok"],
      ["app career: Synced + Healthy. no drift detected — this resume IS the desired state.", "line-cyan"]
    ];
    var i = 0;
    (function next() {
      if (i >= steps.length) { if (done) done(); return; }
      print(steps[i][0], steps[i][1]);
      i += 1;
      scrollTerm();
      setTimeout(next, reducedMotion ? 0 : 220);
    })();
    return true; // async
  }

  function cmdHelmInstall() {
    print("NAME: interview");
    print("LAST DEPLOYED: just now");
    print("NAMESPACE: your-company");
    print("STATUS: deployed", "line-ok");
    print("REVISION: 1");
    print("NOTES:");
    print("1. Your interview has been scheduled. To connect, run:");
    print("     open mailto:dackota.j@gmail.com", "line-cyan");
    print("2. This chart ships with 10+ years of production experience preconfigured.");
    print("3. Rollbacks are supported but historically have never been needed.");
  }

  function cmdCatResume() {
    print("# Dackota Johnson — Platform Engineering Lead", "line-cyan");
    print("Mesa, AZ · dackota.j@gmail.com · github.com/dackota · linkedin.com/in/dackota-johnson");
    print("");
    print("10+ years building the platforms other engineers ship on. Most recently ran");
    print("delivery and infrastructure for KanpAI, a multi-tenant agentic-AI platform:");
    print("20+ production agents, 10+ enterprise units, US + Japan.");
    print("");
    print("## Panasonic Global Applied AI — Platform Engineering Lead (2022-2026)");
    JOBS["platform-lead"].bullets.forEach(function (b) { print("- " + b); });
    print("");
    print("## Keap — Site Reliability Engineer (2018-2022)");
    JOBS["sre"].bullets.forEach(function (b) { print("- " + b); });
    print("");
    print("## Keap — System Administrator (2015-2018)");
    JOBS["sysadmin"].bullets.forEach(function (b) { print("- " + b); });
  }

  var lastCmdFailed = false;

  function runCommand(raw, onDone) {
    var cmd = raw.trim();
    printCmd(cmd);
    lastCmdFailed = false;
    if (!cmd) { scrollTerm(); if (onDone) onDone(); return; }
    history.push(cmd);
    histIdx = history.length;

    var lower = cmd.toLowerCase().replace(/\s+/g, " ");
    var async = false;

    if (lower === "help" || lower === "kubectl help" || lower === "man dackota" || lower === "?") cmdHelp();
    else if (lower === "whoami" || lower === "who am i" || lower === "id") cmdWhoami();
    else if (lower === "contact" || lower === "kubectl get contact") cmdContact();
    else if (/^kubectl get (jobs?|experience|career)( -a)?$/.test(lower)) cmdGetJobs();
    else if (/^kubectl describe (job|role) /.test(lower)) cmdDescribeJob(lower.split(" ").pop());
    else if (/^kubectl get (skills?|ns|namespaces)( -a| --all-namespaces| --show-labels)?$/.test(lower)) cmdGetSkills();
    else if (/^kubectl get pods( -n | --namespace[ =])(.+)$/.test(lower)) cmdGetPods(lower.replace(/^kubectl get pods( -n | --namespace[ =])/, "").trim());
    else if (lower === "kubectl get pods" || lower === "kubectl get pods -a" || lower === "kubectl get pods --all-namespaces") cmdGetSkills();
    else if (/^argocd app sync/.test(lower) || lower === "sync") async = cmdSync(onDone);
    else if (/^argocd app (list|get)/.test(lower)) {
      print(pad("NAME", 12) + pad("SYNC", 10) + pad("HEALTH", 10) + "REPO");
      print(pad("career", 12) + pad("Synced", 10) + pad("Healthy", 10) + "life/dackota", "line-ok");
      print(pad("this-site", 12) + pad("Synced", 10) + pad("Healthy", 10) + "github.com/dackota/resume-website", "line-ok");
    }
    else if (/^helm install/.test(lower)) cmdHelmInstall();
    else if (lower === "helm list" || lower === "helm ls") {
      print(pad("NAME", 16) + pad("NAMESPACE", 14) + pad("REVISION", 10) + pad("STATUS", 10) + "CHART");
      print(pad("dackota", 16) + pad("production", 14) + pad("4", 10) + pad("deployed", 10) + "engineer-4.0.0", "line-ok");
    }
    else if (lower === "cat resume.md" || lower === "cat resume" || lower === "resume") cmdCatResume();
    else if (lower === "ls" || lower === "ls -la" || lower === "ls -l" || lower === "dir") {
      print("resume.md   skills/   incidents/   postmortems/   japan-workshop-slides/   .vault-token (redacted)");
    }
    else if (lower === "history") { history.slice(0, -1).forEach(function (h, i2) { print("  " + (i2 + 1) + "  " + h); }); }
    else if (lower === "clear" || lower === "cls") { termLog.innerHTML = ""; }
    else if (lower === "exit" || lower === "logout" || lower === "quit") {
      print("logout... just kidding. this session has no TTL. try 'contact' instead.", "line-warn");
    }
    else if (lower === "sudo hire dackota" || lower === "hire dackota" || lower === "sudo hire-dackota") {
      print("[sudo] password for you: ********", "line-out");
      print("privilege escalation approved — generating offer letter...", "line-ok");
      print("offer.pdf rendered. next step: open mailto:dackota.j@gmail.com", "line-cyan");
    }
    else if (/^rm(\s|$)/.test(lower)) {
      lastCmdFailed = true;
      print("Error: admission webhook \"validate.kyverno.svc\" denied the request:", "line-err");
      print("  policy 'disallow-resume-deletion' blocked rm — this resume has a PodDisruptionBudget.", "line-err");
    }
    else if (/^vault /.test(lower)) {
      lastCmdFailed = true;
      print("Error: 403 permission denied — even this terminal follows least privilege.", "line-err");
    }
    else if (lower === "trace" || lower === "otel spans" || lower === "otel trace") cmdTrace();
    else if (lower === "slo" || lower === "slo status" || lower === "error budget") cmdSlo();
    else if (lower === "dora" || lower === "dora metrics") cmdDora();
    else if (lower === "changes" || lower === "changes feed") cmdChanges(null);
    else if (/^changes (--repo |-r )/.test(lower)) cmdChanges(lower.replace(/^changes (--repo |-r )/, "").trim());
    else if (/^(terraform|tofu) (apply|destroy)/.test(lower)) {
      print("Plan: 1 to add (interview), 0 to change, 0 to destroy.", "line-out");
      print("Apply complete! Resources: 1 added. Output: email = dackota.j@gmail.com", "line-ok");
    }
    else if (lower === "uptime") {
      print("10:31:07 up 10+ years, 1 user, load average: healthy, sustainable, documented");
    }
    else if (lower === "ping" || /^ping /.test(lower)) {
      print("PONG — 64 bytes from dackota.j@gmail.com: icmp_seq=1 ttl=∞ time=fast");
    }
    else if (lower === "kubectl version") {
      print("Client Version: v10.0-dackota  (10+ years of production Kubernetes)");
      print("Server Version: whatever yours is — I've upgraded plenty with zero downtime", "line-ok");
    }
    else {
      lastCmdFailed = true;
      print("command not found: " + cmd.split(" ")[0] + " — try 'help'", "line-err");
    }

    if (!async) { scrollTerm(); if (onDone) onDone(); }
  }

  function initTerminal() {
    termLog = document.getElementById("term-log");
    termInput = document.getElementById("term-input");
    termScroll = document.getElementById("term-scroll");
    if (!termLog || !termInput || !termScroll) return;

    print("Welcome to the resume shell. Connected to cluster 'career' (v10.0, 3 nodes: sysadmin, sre, platform-lead).", "line-cyan");
    print("Type 'help' to see what you can run.", "line-out");
    print("");

    termInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var raw = termInput.value;
        var span = Trace.start("exec {" + (raw.trim() || "∅") + "}", {
          service: "shell", kind: "SERVER", objective: 100,
          attrs: { "command.line": raw.trim(), "command.session": "read-only cluster, generous RBAC" }
        });
        runCommand(raw, function () {
          span.end({
            status: lastCmdFailed ? "ERROR" : "OK",
            attrs: { "command.exit_code": lastCmdFailed ? 1 : 0 }
          });
        });
        termInput.value = "";
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (history.length && histIdx > 0) { histIdx -= 1; termInput.value = history[histIdx]; }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (histIdx < history.length - 1) { histIdx += 1; termInput.value = history[histIdx]; }
        else { histIdx = history.length; termInput.value = ""; }
      }
    });

    // Clicking anywhere in the terminal focuses the input (unless selecting text).
    termScroll.addEventListener("click", function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) termInput.focus();
    });
  }

  /* ================= trace explorer UI ================= */
  var selectedSpanId = null;

  function serviceClass(service) {
    return "svc-" + service.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  }

  function renderAttrs(span) {
    var box = document.getElementById("trace-attrs");
    if (!box) return;
    box.textContent = "";

    function line(k, v, cls) {
      var row = document.createElement("div");
      var kk = document.createElement("span");
      kk.className = "k";
      kk.textContent = pad(k, 22);
      var vv = document.createElement("span");
      vv.className = cls || "v";
      vv.textContent = String(v);
      row.appendChild(kk);
      row.appendChild(vv);
      box.appendChild(row);
    }

    if (!span) {
      var hint = document.createElement("div");
      hint.textContent = "select a span above to inspect its attributes — or scroll, click, and type to make new ones.";
      box.appendChild(hint);
      return;
    }

    var dur = Trace.duration(span);
    line("span.name", span.name);
    line("span.id", span.id);
    line("trace.id", Trace.traceId());
    line("service.name", span.service);
    line("span.kind", span.kind);
    line("otel.status_code", span.end === null ? "UNSET (in flight)" : span.status,
      span.status === "ERROR" ? "err" : "v");
    line("duration", fmtDur(dur) + (span.end === null ? " — still open, measured to the last event" : ""));
    if (span.objective !== null) {
      line("slo.objective_ms", span.objective + "ms");
      line("slo.verdict", Trace.breached(span) ? "BREACH — burned error budget" : "within objective",
        Trace.breached(span) ? "err" : "v");
    }
    Object.keys(span.attrs).forEach(function (k) { line(k, span.attrs[k]); });
  }

  function renderTrace() {
    var wf = document.getElementById("waterfall");
    var meta = document.getElementById("trace-meta");
    if (!wf) return;

    var spans = Trace.spans();
    var total = Math.max(Trace.lastEvent(), 1);
    var errors = 0;
    var open = 0;

    // Every render rebuilds the list, which resets scrollTop. Tail the newest
    // spans only while the viewer is already at the bottom; if they've scrolled
    // up to read something, hold their position instead of yanking them away.
    var scroller = document.getElementById("trace-scroll");
    var prevTop = scroller ? scroller.scrollTop : 0;
    var stick = scroller
      ? (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < 24
      : false;

    wf.textContent = "";
    spans.forEach(function (s) {
      if (s.status === "ERROR") errors += 1;
      if (s.end === null) open += 1;

      var dur = Trace.duration(s);
      var row = document.createElement("button");
      row.type = "button";
      row.className = "span-row";
      row.setAttribute("role", "listitem");
      row.setAttribute("aria-pressed", s.id === selectedSpanId ? "true" : "false");

      var name = document.createElement("span");
      name.className = "span-name";
      if (s.depth > 0) {
        var indent = document.createElement("span");
        indent.className = "depth";
        indent.textContent = new Array(s.depth + 1).join("  ") + "└ ";
        name.appendChild(indent);
      }
      var svc = document.createElement("span");
      svc.className = "svc";
      svc.textContent = s.service + " ";
      name.appendChild(svc);
      name.appendChild(document.createTextNode(s.name));

      var track = document.createElement("span");
      track.className = "span-track";
      var bar = document.createElement("span");
      bar.className = "span-bar " + serviceClass(s.service) +
        (s.status === "ERROR" ? " err" : "") + (s.end === null ? " open" : "");
      bar.style.setProperty("--span-left", (s.start / total * 100).toFixed(3) + "%");
      bar.style.setProperty("--span-width", Math.max(dur / total * 100, 0.2).toFixed(3) + "%");
      track.appendChild(bar);

      var durEl = document.createElement("span");
      durEl.className = "span-dur" + (s.status === "ERROR" ? " err" : (Trace.breached(s) ? " slow" : ""));
      durEl.textContent = fmtDur(dur);

      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(durEl);
      row.addEventListener("click", function () {
        selectedSpanId = s.id;
        renderTrace();
        renderAttrs(s);
      });
      wf.appendChild(row);
    });

    if (scroller) scroller.scrollTop = stick ? scroller.scrollHeight : prevTop;

    if (meta) {
      meta.textContent = "";
      [
        ["trace_id", Trace.traceId()],
        ["spans", String(spans.length)],
        ["in flight", String(open)],
        ["duration", fmtDur(total)],
        ["errors", String(errors)]
      ].forEach(function (pair) {
        var el = document.createElement("span");
        el.appendChild(document.createTextNode(pair[0] + " "));
        var b = document.createElement("b");
        b.textContent = pair[1];
        el.appendChild(b);
        meta.appendChild(el);
      });
    }

    var count = document.getElementById("trace-pill-count");
    if (count) count.textContent = spans.length + (spans.length === 1 ? " span" : " spans");
  }

  function otlpPayload() {
    return {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "me.dackota.com" } },
            { key: "deployment.environment", value: { stringValue: "production" } }
          ]
        },
        scopeSpans: [{
          scope: { name: "resume-website", version: "1.0.2" },
          spans: Trace.spans().map(function (s) {
            var attrs = Object.keys(s.attrs).map(function (k) {
              return { key: k, value: { stringValue: String(s.attrs[k]) } };
            });
            return {
              traceId: Trace.traceId(),
              spanId: s.id,
              parentSpanId: s.parentId || undefined,
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: Math.round(s.start * 1e6),
              endTimeUnixNano: s.end === null ? null : Math.round(s.end * 1e6),
              status: { code: s.status },
              attributes: attrs.concat([{ key: "service.name", value: { stringValue: s.service } }])
            };
          })
        }]
      }]
    };
  }

  function copyText(text, note, okMsg) {
    function fallback() {
      if (note) note.textContent = "copy failed — here it is instead: " + text;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        if (note) note.textContent = okMsg;
      }, fallback);
    } else {
      fallback();
    }
  }

  function initTrace() {
    var wf = document.getElementById("waterfall");
    if (!wf) return;

    renderTrace();
    renderAttrs(null);

    var pending = false;
    Trace.onChange(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        renderTrace();
        var sel = null;
        Trace.spans().forEach(function (s) { if (s.id === selectedSpanId) sel = s; });
        if (sel) renderAttrs(sel);
      });
    });

    var note = document.getElementById("trace-note");
    var copyBtn = document.getElementById("trace-copy");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        copyText(Trace.traceId(), note, "trace id copied — it only ever existed in your tab");
      });
    }

    var exportBtn = document.getElementById("trace-export");
    var out = document.getElementById("otlp-out");
    if (exportBtn && out) {
      exportBtn.addEventListener("click", function () {
        var json = JSON.stringify(otlpPayload(), null, 2);
        out.hidden = !out.hidden;
        out.textContent = json;
        exportBtn.textContent = out.hidden ? "Export OTLP JSON" : "Hide OTLP JSON";
        if (!out.hidden) copyText(json, note, "OTLP payload copied — paste it into Jaeger if you like");
      });
    }

    var pill = document.getElementById("trace-pill");
    if (pill && "IntersectionObserver" in window) {
      pill.hidden = false;
      new IntersectionObserver(function (entries) {
        pill.hidden = entries[0].isIntersecting;
      }, { threshold: 0 }).observe(document.getElementById("trace"));
    }
  }

  /* ================= section dwell spans ================= */
  function initSectionSpans() {
    if (!("IntersectionObserver" in window)) return;
    var targets = document.querySelectorAll("main section[id], header[id]");
    var live = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var id = entry.target.id;
        if (entry.isIntersecting && !live[id]) {
          live[id] = Trace.start("section.view {" + id + "}", {
            attrs: { "section.id": id, "span.type": "dwell" }
          });
        } else if (!entry.isIntersecting && live[id]) {
          live[id].end();
          live[id] = null;
        }
      });
    }, { threshold: 0.35 });
    Array.prototype.forEach.call(targets, function (el) { io.observe(el); });

    window.addEventListener("pagehide", function () {
      Object.keys(live).forEach(function (id) { if (live[id]) live[id].end(); });
    });
  }

  /* ================= session SLO + error budget ================= */
  var SLO_TARGET = 0.999;

  function sloState() {
    var good = 0;
    var total = 0;
    Trace.spans().forEach(function (s) {
      if (s.objective === null || s.end === null) return;
      total += 1;
      if (!Trace.breached(s) && s.status !== "ERROR") good += 1;
    });
    var sli = total ? good / total : 1;
    var badRatio = 1 - sli;
    var budgetLeft = Math.max(0, Math.min(1, 1 - badRatio / (1 - SLO_TARGET)));
    return { good: good, total: total, sli: sli, budgetLeft: budgetLeft };
  }

  function renderSlo() {
    var fill = document.getElementById("budget-fill");
    if (!fill) return;
    var st = sloState();

    document.getElementById("sli-good").textContent = String(st.good);
    document.getElementById("sli-total").textContent = String(st.total);
    document.getElementById("sli-pct").textContent = st.total ? (st.sli * 100).toFixed(2) + "%" : "—";
    document.getElementById("budget-left").textContent = Math.round(st.budgetLeft * 100) + "%";

    fill.style.setProperty("--budget", (st.budgetLeft * 100).toFixed(1) + "%");
    fill.className = "budget-fill" + (st.budgetLeft > 0.5 ? "" : (st.budgetLeft > 0 ? " warn" : " bad"));

    var verdict = document.getElementById("slo-verdict");
    if (!st.total) {
      verdict.textContent = "no interactions yet";
      verdict.className = "slo-verdict";
    } else if (st.budgetLeft >= 1) {
      verdict.textContent = "✓ meeting objective";
      verdict.className = "slo-verdict ok";
    } else if (st.budgetLeft > 0) {
      verdict.textContent = "⚠ burning error budget";
      verdict.className = "slo-verdict warn";
    } else {
      verdict.textContent = "✗ budget exhausted — freeze releases, fix reliability";
      verdict.className = "slo-verdict bad";
    }
  }

  function initSlo() {
    if (!document.getElementById("budget-fill")) return;
    renderSlo();
    var pending = false;
    Trace.onChange(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; renderSlo(); });
    });
  }

  /* ================= real user monitoring: core web vitals ================= */
  var VITAL_THRESHOLDS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], ttfb: [800, 1800] };

  function setVital(key, value, display) {
    var el = document.querySelector('.vital[data-vital="' + key + '"]');
    if (!el) return;
    var t = VITAL_THRESHOLDS[key];
    var cls = value <= t[0] ? "good" : (value <= t[1] ? "meh" : "poor");
    el.className = "vital " + cls;
    el.querySelector(".vital-value").textContent = display;
  }

  function initVitals() {
    if (!document.getElementById("vitals-grid")) return;

    var nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (nav) setVital("ttfb", nav.responseStart, Math.round(nav.responseStart) + "ms");

    if (!("PerformanceObserver" in window)) return;
    var supported = PerformanceObserver.supportedEntryTypes || [];

    function observe(type, opts, handler) {
      if (supported.indexOf(type) === -1) return;
      try {
        new PerformanceObserver(handler).observe(opts);
      } catch (e) { /* browser said no; the tile just stays blank */ }
    }

    observe("largest-contentful-paint", { type: "largest-contentful-paint", buffered: true }, function (list) {
      var entries = list.getEntries();
      var last = entries[entries.length - 1];
      if (last) setVital("lcp", last.startTime, (last.startTime / 1000).toFixed(2) + "s");
    });

    var cls = 0;
    observe("layout-shift", { type: "layout-shift", buffered: true }, function (list) {
      list.getEntries().forEach(function (entry) {
        if (!entry.hadRecentInput) cls += entry.value;
      });
      setVital("cls", cls, cls.toFixed(3));
    });

    var inp = 0;
    observe("event", { type: "event", buffered: true, durationThreshold: 16 }, function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.duration > inp) inp = entry.duration;
      });
      if (inp) setVital("inp", inp, Math.round(inp) + "ms");
    });
  }

  /* ================= live DORA metrics ================= */
  var REPO = "dackota/resume-website";
  var DAY = 86400000;
  var doraResult = null;

  function median(nums) {
    if (!nums.length) return null;
    var sorted = nums.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function humanizeMs(ms) {
    if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + " min";
    if (ms < DAY) return (ms / 3600000).toFixed(1) + " hrs";
    if (ms < 30 * DAY) return (ms / DAY).toFixed(1) + " days";
    return (ms / (30 * DAY)).toFixed(1) + " months";
  }

  function setDora(key, value, band) {
    var el = document.querySelector('.dora[data-dora="' + key + '"]');
    if (!el) return;
    el.className = "dora " + (band ? band.cls : "");
    el.querySelector(".dora-value").textContent = value;
    var bandEl = el.querySelector(".dora-band");
    bandEl.className = "dora-band " + (band ? band.cls : "");
    bandEl.textContent = band ? band.label : "";
  }

  function computeDora(releases, commits) {
    var live = releases.filter(function (r) { return !r.draft && !r.prerelease && r.published_at; })
      .map(function (r) { return { tag: r.tag_name, at: new Date(r.published_at).getTime() }; })
      .sort(function (a, b) { return a.at - b.at; });

    var out = { releases: live.length, commits: commits.length };
    if (!live.length) return out;

    var newest = live[live.length - 1].at;
    var oldest = live[0].at;
    var days = Math.max((Date.now() - oldest) / DAY, 1);
    out.perWeek = live.length / (days / 7);
    out.newestTag = live[live.length - 1].tag;
    out.lastDeployAgo = Date.now() - newest;

    // Lead time: commit authored -> first release published after it. release-please's
    // own release commits land seconds before the tag, so they'd flatter the median.
    var leads = [];
    commits.forEach(function (c) {
      if (/^chore(\(.+\))?: release /i.test(c.commit.message)) return;
      var at = new Date(c.commit.author.date).getTime();
      for (var i = 0; i < live.length; i += 1) {
        if (live[i].at > at) { leads.push(live[i].at - at); return; }
      }
    });
    out.leadTime = median(leads);

    // Failures: a revert commit means the release before it went bad.
    var failed = {};
    var restores = [];
    commits.forEach(function (c) {
      if (!/^revert/i.test(c.commit.message)) return;
      var at = new Date(c.commit.author.date).getTime();
      var broke = null;
      var fixed = null;
      for (var i = 0; i < live.length; i += 1) {
        if (live[i].at <= at) broke = live[i];
        if (live[i].at > at && !fixed) fixed = live[i];
      }
      if (broke) {
        failed[broke.tag] = true;
        if (fixed) restores.push(fixed.at - broke.at);
      }
    });
    out.failedCount = Object.keys(failed).length;
    out.cfr = out.failedCount / live.length;
    out.mttr = median(restores);
    return out;
  }

  function renderDora(d) {
    if (d.perWeek === undefined) {
      setDora("freq", "no releases", null);
      return;
    }
    var perWeek = d.perWeek;
    setDora("freq", perWeek >= 1 ? perWeek.toFixed(1) + " / wk" : (perWeek * 4.35).toFixed(1) + " / mo",
      perWeek >= 7 ? { cls: "elite", label: "elite — on demand" }
        : perWeek >= 1 ? { cls: "high", label: "high — weekly or better" }
          : perWeek >= 0.23 ? { cls: "medium", label: "medium — monthly" }
            : { cls: "low", label: "low — slower than monthly" });

    if (d.leadTime === null || d.leadTime === undefined) {
      setDora("lead", "—", { cls: "", label: "no commits paired to a release yet" });
    } else {
      setDora("lead", humanizeMs(d.leadTime),
        d.leadTime < DAY ? { cls: "elite", label: "elite — under a day" }
          : d.leadTime < 7 * DAY ? { cls: "high", label: "high — under a week" }
            : d.leadTime < 30 * DAY ? { cls: "medium", label: "medium — under a month" }
              : { cls: "low", label: "low — over a month" });
    }

    setDora("cfr", (d.cfr * 100).toFixed(0) + "%",
      d.cfr <= 0.15 ? { cls: "elite", label: d.failedCount + " reverted of " + d.releases + " releases" }
        : d.cfr <= 0.3 ? { cls: "medium", label: d.failedCount + " reverted of " + d.releases }
          : { cls: "low", label: d.failedCount + " reverted of " + d.releases });

    if (d.mttr === null || d.mttr === undefined) {
      setDora("mttr", "n/a", { cls: "elite", label: "nothing has needed restoring" });
    } else {
      setDora("mttr", humanizeMs(d.mttr),
        d.mttr < 3600000 ? { cls: "elite", label: "elite — under an hour" }
          : d.mttr < DAY ? { cls: "high", label: "high — under a day" }
            : { cls: "medium", label: "medium — over a day" });
    }
  }

  function fetchDora() {
    var src = document.getElementById("dora-source");
    var base = "https://api.github.com/repos/" + REPO;
    var span = Trace.start("GET api.github.com/repos/" + REPO, {
      service: "github", kind: "CLIENT",
      attrs: { "http.method": "GET", "http.host": "api.github.com", "peer.service": "github-api" }
    });

    function get(path) {
      return fetch(base + path, { headers: { "Accept": "application/vnd.github+json" } })
        .then(function (res) {
          if (!res.ok) throw new Error(res.status + (res.status === 403 ? " (rate limited — 60 req/hr unauthenticated)" : ""));
          return res.json();
        });
    }

    Promise.all([get("/releases?per_page=100"), get("/commits?sha=main&per_page=100")])
      .then(function (results) {
        span.end({ attrs: { "http.status_code": 200, "github.releases": results[0].length, "github.commits": results[1].length } });
        doraResult = computeDora(results[0], results[1]);
        renderDora(doraResult);
        if (src) {
          src.className = "dora-source";
          src.textContent = "computed in your browser from " + doraResult.releases + " releases and " +
            doraResult.commits + " commits · latest " + (doraResult.newestTag || "—") +
            " shipped " + (doraResult.lastDeployAgo ? humanizeMs(doraResult.lastDeployAgo) + " ago" : "—") +
            " · source: api.github.com/repos/" + REPO;
        }
      })
      .catch(function (err) {
        span.end({ status: "ERROR", attrs: { "error.message": String(err.message || err) } });
        if (src) {
          src.className = "dora-source err";
          src.textContent = "GitHub API unavailable (" + (err.message || err) + ") — the numbers stay blank rather than made up. " +
            "Metrics are computed client-side from api.github.com/repos/" + REPO + ".";
        }
      });
  }

  function initDora() {
    var grid = document.getElementById("dora-grid");
    if (!grid || typeof fetch !== "function") return;
    if (!("IntersectionObserver" in window)) { fetchDora(); return; }
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      fetchDora();
    }, { rootMargin: "300px" });
    io.observe(grid);
  }

  /* ================= live change feed =================
     Data comes from change-tracking-dashboard, proxied same-origin by nginx
     at /api/changes/ — the upstream sends no CORS headers, and proxying keeps
     this page's CSP at connect-src 'self'. */
  var CHANGES_BASE = "/api/changes/";
  var WINDOW_DAYS = 30;
  var FEED_PAGE = 8;
  var MAX_WINDOW_PAGES = 5;
  var IMPACT_TIERS = ["major", "minor", "patch", "downgrade", "other"];
  var TERRAFORM_KINDS = { provider: 1, module: 1, resource: 1, variable: 1 };

  var windowSets = [];          // the unfiltered 30-day window: tiles + heatmap
  var feedItems = [];           // what the feed is currently showing
  var nextCursor = null;
  var feedRendered = 0;
  var repoIndex = {};           // short name -> full repo URL
  var filters = { impacts: [], repo: "", day: null };

  function repoName(url) {
    return repoHref(url).split("/").pop() || url;
  }

  function repoHref(url) {
    return String(url).replace(/\.git$/, "");
  }

  function commitHref(c) {
    return c.commitSha ? repoHref(c.repo) + "/commit/" + c.commitSha : null;
  }

  // issueRefs arrive as "#139". Everything tracked here lands through a pull
  // request (Renovate, release-please, or me), so a bare ref resolves to /pull/ —
  // and GitHub redirects /pull/N to /issues/N on the rare miss.
  function pullHref(c, ref) {
    var n = String(ref || "").replace(/^#/, "");
    return /^\d+$/.test(n) ? repoHref(c.repo) + "/pull/" + n : null;
  }

  function extLink(href, text, cls) {
    var a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    if (cls) a.className = cls;
    a.textContent = text;
    return a;
  }

  function isBot(author) {
    return /\[bot\]|renovate|dependabot|release-please/i.test(author || "");
  }

  function relTime(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return "just now";
    if (ms < 3600000) return Math.round(ms / 60000) + " min ago";
    if (ms < DAY) {
      var hrs = Math.round(ms / 3600000);
      return hrs + (hrs === 1 ? " hr ago" : " hrs ago");
    }
    var days = Math.round(ms / DAY);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  function shortValue(v) {
    var s = String(v);
    var at = s.indexOf("@sha256:");
    if (at > -1) return s.slice(0, at) + "@sha256:" + s.slice(at + 8, at + 15) + "…";
    if (/^[0-9a-f]{40}$/.test(s)) return s.slice(0, 7) + "…";  // bare git SHA pin
    return s.length > 46 ? s.slice(0, 45) + "…" : s;
  }

  function dayKey(d) { return new Date(d).toISOString().slice(0, 10); }

  function windowSince() {
    return new Date(Date.now() - WINDOW_DAYS * DAY).toISOString().replace(/\.\d+Z$/, "Z");
  }

  /* ---- transport ---- */
  function changesFetch(path, query, accept) {
    var url = CHANGES_BASE + path + (query ? "?" + query : "");
    var span = Trace.start("GET /api/changes/" + path, {
      service: "changes-api", kind: "CLIENT",
      attrs: {
        "http.method": "GET",
        "peer.service": "change-tracking-dashboard",
        "http.accept": accept,
        "changes.query": query || "(none)"
      }
    });
    return fetch(url, { headers: { "Accept": accept } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return accept === "application/json" ? res.json() : res.text();
      })
      .then(function (body) {
        span.end({ attrs: { "http.status_code": 200 } });
        return body;
      })
      .catch(function (err) {
        span.end({ status: "ERROR", attrs: { "error.message": String(err.message || err) } });
        throw err;
      });
  }

  function feedError(err) {
    var note = document.getElementById("feed-note");
    if (note) {
      note.className = "feed-note err";
      note.textContent = "change feed unreachable (" + (err.message || err) + ") — the dashboard is a " +
        "single replica on free-tier hardware, so this section fails open rather than inventing history.";
    }
    var moreBtn = document.getElementById("feed-more");
    if (moreBtn) moreBtn.hidden = true;
  }

  /* ---- stat tiles ---- */
  function renderChangeStats() {
    if (!windowSets.length) return;
    var bots = 0;
    var repos = {};
    var oldest = Infinity;
    var newest = 0;
    windowSets.forEach(function (c) {
      if (isBot(c.author)) bots += 1;
      repos[repoName(c.repo)] = true;
      var t = new Date(c.committedAt).getTime();
      if (t < oldest) oldest = t;
      if (t > newest) newest = t;
    });
    var days = Math.max((newest - oldest) / DAY, 1);

    function tile(key, value) {
      var el = document.querySelector('.auto-tile[data-auto="' + key + '"] .auto-value');
      if (el) el.textContent = value;
    }
    tile("bots", Math.round(bots / windowSets.length * 100) + "%");
    tile("count", String(windowSets.length));
    tile("rate", (windowSets.length / days).toFixed(1));
    tile("repos", String(Object.keys(repos).length));
  }

  /* ---- heatmap ---- */
  function topImpact(tiers) {
    for (var i = 0; i < IMPACT_TIERS.length; i += 1) {
      if (tiers[IMPACT_TIERS[i]]) return IMPACT_TIERS[i];
    }
    return "other";
  }

  function renderHeatmap() {
    var hm = document.getElementById("heatmap");
    if (!hm) return;

    var byDay = {};
    windowSets.forEach(function (c) {
      var k = dayKey(c.committedAt);
      if (!byDay[k]) byDay[k] = { count: 0, tiers: {} };
      byDay[k].count += 1;
      byDay[k].tiers[c.impact || "other"] = true;
    });

    var max = 1;
    Object.keys(byDay).forEach(function (k) { if (byDay[k].count > max) max = byDay[k].count; });

    hm.textContent = "";
    for (var i = WINDOW_DAYS - 1; i >= 0; i -= 1) {
      var date = new Date(Date.now() - i * DAY);
      var key = dayKey(date);
      var bucket = byDay[key];
      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = "hm-cell" + (bucket ? " " + topImpact(bucket.tiers) : " empty");
      cell.style.setProperty("--hm-intensity", bucket ? (0.35 + 0.65 * (bucket.count / max)).toFixed(2) : "1");
      cell.setAttribute("aria-pressed", filters.day && filters.day.key === key ? "true" : "false");
      cell.title = key + " · " + (bucket ? bucket.count + " changeset" + (bucket.count === 1 ? "" : "s") +
        " · highest impact: " + topImpact(bucket.tiers) : "no changes");
      cell.setAttribute("aria-label", cell.title);

      (function (k) {
        cell.addEventListener("click", function () {
          if (filters.day && filters.day.key === k) {
            filters.day = null;
          } else {
            filters.day = {
              key: k,
              since: k + "T00:00:00Z",
              asOf: dayKey(new Date(new Date(k + "T00:00:00Z").getTime() + DAY)) + "T00:00:00Z"
            };
          }
          renderHeatmap();
          syncFilterUI();
          queryFeed(null);
        });
      })(key);

      hm.appendChild(cell);
    }
  }

  /* ---- filters ---- */
  function syncFilterUI() {
    var clear = document.getElementById("filter-clear");
    var active = filters.impacts.length || filters.repo || filters.day;
    if (clear) clear.hidden = !active;

    Array.prototype.forEach.call(document.querySelectorAll("#impact-chips .filter-chip"), function (chip) {
      var on = filters.impacts.indexOf(chip.getAttribute("data-impact")) > -1;
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    });

    var select = document.getElementById("repo-select");
    if (select && select.value !== filters.repo) select.value = filters.repo;
  }

  function buildFilterControls() {
    var chips = document.getElementById("impact-chips");
    if (chips && !chips.childNodes.length) {
      IMPACT_TIERS.forEach(function (tier) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "filter-chip impact " + tier;
        chip.setAttribute("data-impact", tier);
        chip.setAttribute("aria-pressed", "false");
        chip.textContent = tier;
        chip.addEventListener("click", function () {
          var at = filters.impacts.indexOf(tier);
          if (at > -1) filters.impacts.splice(at, 1);
          else filters.impacts.push(tier);
          syncFilterUI();
          queryFeed(null);
        });
        chips.appendChild(chip);
      });
    }

    var select = document.getElementById("repo-select");
    if (select && select.options.length <= 1) {
      Object.keys(repoIndex).sort().forEach(function (short) {
        var opt = document.createElement("option");
        opt.value = repoIndex[short];
        opt.textContent = short;
        select.appendChild(opt);
      });
      select.addEventListener("change", function () {
        filters.repo = select.value;
        syncFilterUI();
        queryFeed(null);
      });
    }

    var clear = document.getElementById("filter-clear");
    if (clear && !clear.getAttribute("data-wired")) {
      clear.setAttribute("data-wired", "1");
      clear.addEventListener("click", function () {
        filters = { impacts: [], repo: "", day: null };
        var sel = document.getElementById("repo-select");
        if (sel) sel.value = "";
        renderHeatmap();
        syncFilterUI();
        queryFeed(null);
      });
    }
  }

  function currentQuery() {
    var parts = ["limit=50"];
    if (filters.day) {
      parts.push("since=" + encodeURIComponent(filters.day.since));
      parts.push("asOf=" + encodeURIComponent(filters.day.asOf));
    } else {
      parts.push("since=" + encodeURIComponent(windowSince()));
    }
    filters.impacts.forEach(function (i) { parts.push("impact=" + encodeURIComponent(i)); });
    if (filters.repo) parts.push("repo=" + encodeURIComponent(filters.repo));
    return parts.join("&");
  }

  function filterSummary() {
    var bits = [];
    if (filters.impacts.length) bits.push("impact " + filters.impacts.join("/"));
    if (filters.repo) bits.push(repoName(filters.repo));
    if (filters.day) bits.push(filters.day.key);
    return bits.length ? " · filtered by " + bits.join(" + ") : "";
  }

  /* ---- feed ---- */
  function queryFeed(cursor) {
    var query = currentQuery() + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    var note = document.getElementById("feed-note");
    if (note && !cursor) { note.className = "feed-note"; note.textContent = "querying…"; }

    return changesFetch("changesets", query, "application/json")
      .then(function (body) {
        if (!cursor) {
          feedItems = [];
          feedRendered = 0;
          var feed = document.getElementById("change-feed");
          if (feed) feed.textContent = "";
        }
        feedItems = feedItems.concat(body.changesets || []);
        // Follow nextCursor until it comes back empty — a short page is not the last page.
        nextCursor = body.nextCursor || null;
        renderChangeFeed();
      })
      .catch(feedError);
  }

  /* ---- blast radius ---- */
  var PATH_RE = /data-kind="([a-z]+)"|data-tenant-path="([^"]+)"/g;

  function extractTargets(fragment) {
    // The JSON representation omits the file path; the HTML fragment carries it
    // on the change's diff slot. Attribute values only — no upstream markup is
    // ever inserted into this page.
    var targets = [];
    var seen = {};
    var kind = null;
    var m;
    PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(fragment)) !== null) {
      if (m[1]) { kind = m[1]; continue; }
      var path = m[2];
      if (!/^[\w.\-/]+$/.test(path)) continue;
      var key = kind + "|" + path;
      if (seen[key]) continue;
      seen[key] = true;
      targets.push({ kind: kind, path: path });
    }
    return targets;
  }

  var OUTCOMES = {
    "no-prior-version": "root commit — there is no earlier version to diff against.",
    "unavailable": "a chart dependency has no vendored artifact; this service never pulls from a registry.",
    "could-not-render": "the chart could not be rendered from the commit's contents.",
    "exceeded-limits": "the render hit a configured timeout or resource ceiling."
  };

  function renderDiffText(unified, truncated, into) {
    var pre = document.createElement("pre");
    pre.className = "diff";
    var lines = String(unified).split("\n");
    var shown = lines.slice(0, 400);
    shown.forEach(function (line) {
      var el = document.createElement("span");
      el.className = "diff-line " + (line.charAt(0) === "+" ? "add" : (line.charAt(0) === "-" ? "del" : "ctx"));
      el.textContent = line + "\n";
      pre.appendChild(el);
    });
    into.appendChild(pre);

    if (lines.length > shown.length) {
      var more = document.createElement("p");
      more.className = "blast-note";
      more.textContent = "… " + (lines.length - shown.length) + " more lines not rendered here.";
      into.appendChild(more);
    }
    if (truncated) {
      var warn = document.createElement("p");
      warn.className = "blast-note warn";
      warn.textContent = "⚠ the API truncated this diff at its size ceiling — the counts above are still the true totals.";
      into.appendChild(warn);
    }
  }

  function renderChartDiff(target, body, into) {
    var head = document.createElement("div");
    head.className = "blast-head";
    var path = document.createElement("span");
    path.className = "blast-path";
    path.textContent = target.path;
    head.appendChild(path);

    if (body.kind !== "ok" || !body.diff) {
      var why = document.createElement("span");
      why.className = "blast-outcome";
      why.textContent = OUTCOMES[body.kind] || body.kind;
      head.appendChild(why);
      into.appendChild(head);
      return;
    }

    var s = body.diff.summary || {};
    var stat = document.createElement("span");
    stat.className = "blast-stat";
    stat.textContent = s.manifestsChanged + " manifests changed";
    head.appendChild(stat);
    var plus = document.createElement("span");
    plus.className = "blast-add";
    plus.textContent = "+" + s.linesAdded;
    head.appendChild(plus);
    var minus = document.createElement("span");
    minus.className = "blast-del";
    minus.textContent = "−" + s.linesRemoved;
    head.appendChild(minus);
    into.appendChild(head);

    renderDiffText(body.diff.unified, body.diff.truncated, into);
  }

  function renderPlanDiff(target, body, into) {
    var head = document.createElement("div");
    head.className = "blast-head";
    var path = document.createElement("span");
    path.className = "blast-path";
    path.textContent = target.path;
    head.appendChild(path);

    if (body.kind !== "ok") {
      var why = document.createElement("span");
      why.className = "blast-outcome";
      why.textContent = OUTCOMES[body.kind] || body.kind;
      head.appendChild(why);
      into.appendChild(head);
      return;
    }

    var sum = body.summary || {};
    var stat = document.createElement("span");
    stat.className = "blast-stat";
    stat.textContent = (sum.added || 0) + " added · " + (sum.changed || 0) + " changed · " + (sum.removed || 0) + " removed";
    head.appendChild(stat);
    var repl = document.createElement("span");
    repl.className = "blast-replace" + (sum.replaced ? " danger" : "");
    repl.textContent = (sum.replaced || 0) + " force replacement";
    head.appendChild(repl);
    into.appendChild(head);

    if (body.resources && body.resources.length) {
      var list = document.createElement("ul");
      list.className = "resources-diff";
      body.resources.forEach(function (r) {
        var li = document.createElement("li");
        var k = document.createElement("span");
        k.className = "res-change " + r.kind;
        k.textContent = r.kind;
        li.appendChild(k);
        var addr = document.createElement("span");
        addr.className = "res-addr";
        addr.textContent = r.type + "." + r.name;
        li.appendChild(addr);
        if (r.forcesReplacement) {
          var f = document.createElement("span");
          f.className = "res-forces";
          f.textContent = "forces replacement";
          li.appendChild(f);
        }
        list.appendChild(li);
      });
      into.appendChild(list);
    }

    if (body.diff && body.diff.unified) renderDiffText(body.diff.unified, body.diff.truncated, into);
  }

  function inspectBlastRadius(c, panel, btn) {
    btn.disabled = true;
    btn.textContent = "computing blast radius…";
    panel.hidden = false;
    panel.textContent = "";

    var detailQuery = "repo=" + encodeURIComponent(c.repo) + "&commitSha=" + encodeURIComponent(c.commitSha);

    changesFetch("changesets/detail", detailQuery, "text/html")
      .then(function (fragment) {
        var targets = extractTargets(fragment).filter(function (t) {
          return t.kind === "chart" || TERRAFORM_KINDS[t.kind];
        });
        if (!targets.length) throw new Error("no diffable path on this changeset");

        return Promise.all(targets.map(function (t) {
          var route = t.kind === "chart" ? "changesets/detail/chart-diff" : "changesets/detail/plan-diff";
          return changesFetch(route, detailQuery + "&path=" + encodeURIComponent(t.path), "application/json")
            .then(function (body) { return { target: t, body: body }; });
        }));
      })
      .then(function (results) {
        results.forEach(function (r) {
          var block = document.createElement("div");
          block.className = "blast-block";
          if (r.target.kind === "chart") renderChartDiff(r.target, r.body, block);
          else renderPlanDiff(r.target, r.body, block);
          panel.appendChild(block);
        });
        var foot = document.createElement("p");
        foot.className = "blast-note";
        foot.textContent = c.changes.some(function (ch) { return TERRAFORM_KINDS[ch.kind]; })
          ? "Computed statically from the materialized subtree — no terraform plan, no provider credentials, no state access."
          : "Rendered-manifest diff — what the version bump actually did to the Kubernetes objects, not just the version string.";
        panel.appendChild(foot);

        btn.textContent = "hide blast radius";
        btn.disabled = false;
      })
      .catch(function (err) {
        var msg = document.createElement("p");
        msg.className = "blast-note warn";
        msg.textContent = "blast radius unavailable: " + (err.message || err);
        panel.appendChild(msg);
        btn.textContent = "blast radius unavailable";
        btn.disabled = true;
      });
  }

  function diffableKinds(c) {
    return (c.changes || []).some(function (ch) {
      return ch.kind === "chart" || TERRAFORM_KINDS[ch.kind];
    });
  }

  /* ---- feed rendering ---- */
  function renderChangeFeed() {
    var feed = document.getElementById("change-feed");
    if (!feed) return;

    feedItems.slice(feedRendered, feedRendered + FEED_PAGE).forEach(function (c) {
      var li = document.createElement("li");

      var head = document.createElement("div");
      head.className = "feed-head";

      var impact = document.createElement("span");
      impact.className = "impact " + (c.impact || "other");
      impact.textContent = c.impact || "other";
      head.appendChild(impact);

      head.appendChild(extLink(repoHref(c.repo), repoName(c.repo), "feed-repo"));

      (c.risk || []).forEach(function (r) {
        var chip = document.createElement("span");
        chip.className = "risk-chip";
        chip.textContent = "⚠ " + r;
        head.appendChild(chip);
      });

      var when = document.createElement("span");
      when.className = "feed-when";
      when.textContent = relTime(c.committedAt);
      when.title = c.committedAt;
      head.appendChild(when);
      li.appendChild(head);

      var subject = document.createElement("p");
      subject.className = "feed-subject";
      var subjectText = c.subject || c.commitSha.slice(0, 12);
      // The subject points at the PR that carried the change; direct pushes have
      // no ref, so they fall back to the commit itself.
      var subjectHref = pullHref(c, (c.issueRefs || [])[0]) || commitHref(c);
      if (subjectHref) subject.appendChild(extLink(subjectHref, subjectText, "feed-link"));
      else subject.textContent = subjectText;
      li.appendChild(subject);

      var by = document.createElement("div");
      by.className = "feed-by";
      var author = document.createElement("span");
      if (isBot(c.author)) author.className = "bot";
      author.textContent = c.author;
      by.appendChild(author);

      var sha = c.commitSha.slice(0, 7);
      var shaHref = commitHref(c);
      by.appendChild(document.createTextNode(" · "));
      by.appendChild(shaHref ? extLink(shaHref, sha, "feed-link") : document.createTextNode(sha));

      (c.issueRefs || []).forEach(function (ref) {
        var href = pullHref(c, ref);
        by.appendChild(document.createTextNode(" · "));
        by.appendChild(href ? extLink(href, ref, "feed-link") : document.createTextNode(ref));
      });
      li.appendChild(by);

      if (c.changes && c.changes.length) {
        var deltas = document.createElement("ul");
        deltas.className = "deltas";
        c.changes.slice(0, 4).forEach(function (ch) {
          var row = document.createElement("li");
          var field = document.createElement("span");
          field.className = "delta-field";
          field.textContent = ch.field + (ch.key ? "/" + ch.key : "");
          row.appendChild(field);

          if (ch.changeType === "modified") {
            var oldEl = document.createElement("span");
            oldEl.className = "delta-old";
            oldEl.textContent = shortValue(ch.oldValue);
            oldEl.title = String(ch.oldValue);
            var arrow = document.createElement("span");
            arrow.className = "delta-arrow";
            arrow.textContent = "→";
            var newEl = document.createElement("span");
            newEl.className = "delta-new";
            newEl.textContent = shortValue(ch.newValue);
            newEl.title = String(ch.newValue);
            row.appendChild(oldEl);
            row.appendChild(arrow);
            row.appendChild(newEl);
          } else {
            var val = document.createElement("span");
            val.className = ch.changeType === "removed" ? "delta-old" : "delta-new";
            var raw = ch.changeType === "removed" ? ch.oldValue : ch.newValue;
            val.textContent = (ch.changeType === "removed" ? "− " : "+ ") + shortValue(raw);
            val.title = String(raw);
            row.appendChild(val);
          }

          var kind = document.createElement("span");
          kind.className = "delta-kind";
          kind.textContent = ch.kind;
          row.appendChild(kind);
          deltas.appendChild(row);
        });
        if (c.changes.length > 4) {
          var more = document.createElement("li");
          more.textContent = "+ " + (c.changes.length - 4) + " more tracked values";
          deltas.appendChild(more);
        }
        li.appendChild(deltas);
      }

      if (diffableKinds(c)) {
        var blastBtn = document.createElement("button");
        blastBtn.type = "button";
        blastBtn.className = "blast-btn";
        blastBtn.textContent = "▸ inspect blast radius";
        var panel = document.createElement("div");
        panel.className = "blast-panel";
        panel.hidden = true;

        (function (changeset, button, target) {
          var loaded = false;
          button.addEventListener("click", function () {
            if (!loaded) { loaded = true; inspectBlastRadius(changeset, target, button); return; }
            target.hidden = !target.hidden;
            button.textContent = target.hidden ? "▸ show blast radius" : "hide blast radius";
          });
        })(c, blastBtn, panel);

        li.appendChild(blastBtn);
        li.appendChild(panel);
      }

      feed.appendChild(li);
    });

    feedRendered = Math.min(feedRendered + FEED_PAGE, feedItems.length);

    var moreBtn = document.getElementById("feed-more");
    var note = document.getElementById("feed-note");
    if (moreBtn) moreBtn.hidden = feedRendered >= feedItems.length && !nextCursor;
    if (note) {
      note.className = "feed-note";
      if (!feedItems.length) {
        note.textContent = "no changesets match" + filterSummary() +
          " — an empty result and an unreachable class look the same from here, by design.";
      } else {
        var shown = feedItems.slice(0, feedRendered);
        var hint = shown.some(diffableKinds) ? ""
          : " · nothing here has a blast radius — chart and Terraform changes do, and most of those land as major";
        note.textContent = "showing " + feedRendered + " of " + feedItems.length + " loaded" +
          (nextCursor ? " · more behind the cursor" : " · end of the feed") + filterSummary() + hint;
      }
    }
  }

  /* ---- boot the window ---- */
  function loadWindow(cursor, pagesLeft) {
    var query = "limit=100&since=" + encodeURIComponent(windowSince()) +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    return changesFetch("changesets", query, "application/json").then(function (body) {
      windowSets = windowSets.concat(body.changesets || []);
      (body.changesets || []).forEach(function (c) { repoIndex[repoName(c.repo)] = c.repo; });
      if (body.nextCursor && pagesLeft > 1) return loadWindow(body.nextCursor, pagesLeft - 1);
      return null;
    });
  }

  function initChanges() {
    var feed = document.getElementById("change-feed");
    if (!feed || typeof fetch !== "function") return;

    var moreBtn = document.getElementById("feed-more");
    if (moreBtn) {
      moreBtn.addEventListener("click", function () {
        if (feedRendered < feedItems.length) { renderChangeFeed(); return; }
        if (!nextCursor) return;
        moreBtn.disabled = true;
        queryFeed(nextCursor).then(function () { moreBtn.disabled = false; });
      });
    }

    function boot() {
      loadWindow(null, MAX_WINDOW_PAGES)
        .then(function () {
          renderChangeStats();
          renderHeatmap();
          buildFilterControls();
          syncFilterUI();
          return queryFeed(null);
        })
        .catch(feedError);
    }

    if (!("IntersectionObserver" in window)) { boot(); return; }
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      boot();
    }, { rootMargin: "300px" });
    io.observe(feed);
  }

  /* ================= terminal: observability commands ================= */
  function cmdTrace() {
    var spans = Trace.spans();
    print("trace_id " + Trace.traceId() + "  ·  " + spans.length + " spans  ·  " + fmtDur(Trace.lastEvent()), "line-cyan");
    print(pad("SERVICE", 14) + pad("SPAN", 34) + pad("DURATION", 12) + "STATUS");
    spans.forEach(function (s) {
      var status = s.end === null ? "in flight" : s.status;
      var cls = s.status === "ERROR" ? "line-err" : (s.end === null ? "line-warn" : "line-ok");
      print(pad(s.service, 14) + pad(s.name.slice(0, 32), 34) + pad(fmtDur(Trace.duration(s)), 12) + status, cls);
    });
    print("");
    print("these spans are exported over OTLP to Honeycomb — see the trace explorer section for the waterfall.", "line-cyan");
  }

  function cmdSlo() {
    var st = sloState();
    print("SLO         99.9% of interactions within their latency objective", "line-cyan");
    print("SLI         " + (st.total ? (st.sli * 100).toFixed(2) + "%" : "no interactions measured yet"));
    print("good/total  " + st.good + "/" + st.total);
    print("budget      " + Math.round(st.budgetLeft * 100) + "% remaining",
      st.budgetLeft >= 1 ? "line-ok" : (st.budgetLeft > 0 ? "line-warn" : "line-err"));
    if (st.budgetLeft < 1) print("burn cause  a span exceeded its objective or exited non-zero", "line-warn");
  }

  function cmdDora() {
    if (!doraResult) {
      print("DORA metrics not loaded yet — scroll to # slo.dashboard to trigger the GitHub query.", "line-warn");
      return;
    }
    var d = doraResult;
    print("repo        github.com/" + REPO, "line-cyan");
    print("deploy freq " + (d.perWeek ? d.perWeek.toFixed(1) + " releases/week" : "no releases"), "line-ok");
    print("lead time   " + (d.leadTime ? humanizeMs(d.leadTime) : "—") + "  (commit authored -> released)");
    print("chg failure " + (d.cfr * 100).toFixed(0) + "%  (" + d.failedCount + " reverted of " + d.releases + " releases)");
    print("restore     " + (d.mttr ? humanizeMs(d.mttr) : "nothing has needed restoring"), "line-ok");
    print("computed client-side from the GitHub API — no cached numbers, no claims.", "line-warn");
  }

  function cmdChanges(repoFilter) {
    if (!windowSets.length) {
      print("change feed not loaded yet — scroll to # changes.feed to trigger the query.", "line-warn");
      return;
    }
    var rows = windowSets.filter(function (c) {
      return !repoFilter || repoName(c.repo).indexOf(repoFilter) > -1;
    });
    if (!rows.length) {
      print("no changesets for repo matching '" + repoFilter + "'", "line-err");
      print("tracked: " + Object.keys(windowSets.reduce(function (acc, c) {
        acc[repoName(c.repo)] = true; return acc;
      }, {})).join(", "));
      return;
    }
    print(pad("IMPACT", 11) + pad("REPO", 30) + pad("WHEN", 13) + "SUBJECT");
    rows.slice(0, 12).forEach(function (c) {
      var cls = c.impact === "major" ? "line-err" : (c.impact === "minor" ? "line-warn" : "line-ok");
      print(pad(c.impact, 11) + pad(repoName(c.repo), 30) + pad(relTime(c.committedAt), 13) +
        (c.subject || c.commitSha.slice(0, 12)).slice(0, 60), cls);
    });
    print("");
    print("showing " + Math.min(12, rows.length) + " of " + rows.length + " loaded · source: changes.dackota.com", "line-warn");
  }

  /* ================= boot ================= */
  document.addEventListener("DOMContentLoaded", function () {
    var year = document.getElementById("year");
    if (year) year.textContent = String(new Date().getFullYear());
    typeHero();
    initPipeline();
    initMetrics();
    initTerminal();
    initTrace();
    initSectionSpans();
    initSlo();
    initVitals();
    initDora();
    initChanges();
  });
})();
