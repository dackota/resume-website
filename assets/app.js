/* me.dackota.com — platform-console resume interactions.
   Vanilla JS, CSP script-src 'self' (no inline handlers anywhere). */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

    if (reducedMotion) {
      cmdEl.textContent = HERO_CMD;
      outEl.innerHTML = "\n" + HERO_OUT;
      if (caret) caret.remove();
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
      if (tab) tab.addEventListener("click", function () { selectStage(s); });
    });

    var promote = document.getElementById("promote-btn");
    var note = document.getElementById("promote-note");
    var promoteIdx = -1;
    if (promote) {
      promote.addEventListener("click", function () {
        promoteIdx = (promoteIdx + 1) % stageOrder.length;
        var stage = stageOrder[promoteIdx];
        selectStage(stage);
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
      dates: "Jun 2022 - present",
      where: "Panasonic Global Applied AI (formerly Yohana / Panasonic Well), Remote",
      bullets: [
        "Leads the 4-person platform team behind KanpAI — 20+ production AI agents, 10+ business units, US + Japan",
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
    print("phone:      (480) 603-6579", "line-cyan");
    print("consulting: consulting.dackota.com", "line-cyan");
  }

  function cmdGetJobs() {
    print(pad("NAME", 16) + pad("NAMESPACE", 16) + pad("COMPLETIONS", 14) + pad("DURATION", 12) + "STATUS");
    print(pad("platform-lead", 16) + pad("panasonic-gaai", 16) + pad("ongoing", 14) + pad("3y+", 12) + "Running", "line-ok");
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
      ["  ✓ Job/platform-lead       Synced   Healthy  (2022-now)", "line-ok"],
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
    print("10+ years building the platforms other engineers ship on. Runs delivery and");
    print("infrastructure for KanpAI, a multi-tenant agentic-AI platform: 20+ production");
    print("agents, 10+ enterprise units, US + Japan.");
    print("");
    print("## Panasonic Global Applied AI — Platform Engineering Lead (2022-now)");
    JOBS["platform-lead"].bullets.forEach(function (b) { print("- " + b); });
    print("");
    print("## Keap — Site Reliability Engineer (2018-2022)");
    JOBS["sre"].bullets.forEach(function (b) { print("- " + b); });
    print("");
    print("## Keap — System Administrator (2015-2018)");
    JOBS["sysadmin"].bullets.forEach(function (b) { print("- " + b); });
  }

  function runCommand(raw) {
    var cmd = raw.trim();
    printCmd(cmd);
    if (!cmd) { scrollTerm(); return; }
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
    else if (/^argocd app sync/.test(lower) || lower === "sync") async = cmdSync();
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
      print("Error: admission webhook \"validate.kyverno.svc\" denied the request:", "line-err");
      print("  policy 'disallow-resume-deletion' blocked rm — this resume has a PodDisruptionBudget.", "line-err");
    }
    else if (/^vault /.test(lower)) {
      print("Error: 403 permission denied — even this terminal follows least privilege.", "line-err");
    }
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
      print("command not found: " + cmd.split(" ")[0] + " — try 'help'", "line-err");
    }

    if (!async) scrollTerm();
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
        runCommand(termInput.value);
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

  /* ================= boot ================= */
  document.addEventListener("DOMContentLoaded", function () {
    var year = document.getElementById("year");
    if (year) year.textContent = String(new Date().getFullYear());
    typeHero();
    initPipeline();
    initMetrics();
    initTerminal();
  });
})();
