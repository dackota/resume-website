/* Widgets for the "Error budgets for things that lie" post.
   Vanilla JS, CSP script-src 'self' (no inline handlers anywhere). Loaded only
   by pages carrying `interactive = true` in their frontmatter.

   All three widgets read one file: the post's own transcripts.json, which is
   the raw output of scripts/slo-post-experiment.sh. Nothing here invents a
   question, an answer, or a verdict. What *is* invented is the transport:
   there is no service behind this page, so latency and status codes are
   simulated. Each widget says so on screen. */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* A backlog of simulated traffic, so the gauges read over a plausible window
     instead of over the forty rows that happen to have ticked in. Its failure
     counts are derived from the real corpus below, never hand-set, so the
     percentage on screen always matches the transcripts. */
  var BACKLOG_REQUESTS = 12400;
  var BACKLOG_5XX = 4;
  var WINDOW_MINUTES = 28 * 24 * 60;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pct(n) {
    return (Math.round(n * 10000) / 100).toFixed(2) + "%";
  }

  function clockAt(offsetSeconds) {
    var d = new Date(Date.now() - offsetSeconds * 1000);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (v) { return String(v).padStart(2, "0"); })
      .join(":");
  }

  /* Rounds rather than truncates at the hour boundary: 201.6 minutes is closer
     to 3h22m than to 3h21m, and the post quotes the rounded figure. Truncating
     here would put the prose and the widget one minute apart on the number the
     whole section is built on. */
  function duration(minutes) {
    if (!isFinite(minutes)) return "never";
    var total = Math.round(minutes * 60);
    var h = Math.floor(total / 3600);
    if (h > 0) {
      var mins = Math.round((total - h * 3600) / 60);
      if (mins === 60) { h += 1; mins = 0; }
      return h + "h" + String(mins).padStart(2, "0") + "m";
    }
    var m = Math.floor(total / 60);
    var s = total % 60;
    if (m > 0) return m + "m" + String(s).padStart(2, "0") + "s";
    return s + "s";
  }

  /* The graded verdict for one answer. The human reference wins where it
     exists: it is the thing the judge is being measured against, so using the
     judge's own verdict as ground truth would make the comparison circular. */
  function truth(answer) {
    if (answer.human && answer.human.verdict) return answer.human.verdict;
    return answer.judge && answer.judge.verdict;
  }

  function flatten(data) {
    var out = [];
    data.items.forEach(function (item) {
      ["a", "b"].forEach(function (variant) {
        var answer = item.answers[variant];
        if (!answer) return;
        out.push({
          question: item.question,
          text: answer.text,
          verdict: truth(answer),
          judgeVerdict: answer.judge && answer.judge.verdict,
          judgeReason: answer.judge && answer.judge.reason
        });
      });
    });
    return out;
  }

  /* ================= widget A: the dashboard that lies ================= */
  function initDashboard(mount, data) {
    var pool = flatten(data);
    if (!pool.length) return;

    var corpusFailRate = pool.filter(function (a) { return a.verdict === "fail"; }).length / pool.length;
    var backlogWrong = Math.round(BACKLOG_REQUESTS * corpusFailRate);
    var scoringCorrectness = false;
    var served = 0;
    var errors5xx = 0;
    var wrong = 0;
    var cursor = 0;

    mount.textContent = "";
    var panel = el("div", "slo-panel");
    var head = el("div", "slo-head");
    var title = el("span", "slo-title");
    var verdict = el("span", "slo-verdict ok");
    head.appendChild(title);
    head.appendChild(verdict);

    var bar = el("div", "budget-bar");
    var fill = el("span", "budget-fill");
    bar.appendChild(fill);

    var controls = el("div", "slow-controls");
    var toggle = el("button", "slow-btn", "Score for correctness");
    toggle.type = "button";
    toggle.setAttribute("aria-pressed", "false");
    controls.appendChild(toggle);

    var feed = el("div", "slow-feed");
    var scroll = el("div", "slow-feed-scroll");
    feed.appendChild(scroll);

    var note = el("p", "slow-note");
    note.textContent =
      "Every question and answer below is a real transcript: " + data.answerer +
      " answering with no runbooks and no cluster access. There is no service " +
      "behind this page, so timestamps, latencies and status codes are simulated.";

    panel.appendChild(head);
    panel.appendChild(bar);
    panel.appendChild(controls);
    panel.appendChild(feed);
    panel.appendChild(note);
    mount.appendChild(panel);

    function render() {
      var total = BACKLOG_REQUESTS + served;
      var bad = scoringCorrectness ? backlogWrong + wrong : BACKLOG_5XX + errors5xx;
      var sli = (total - bad) / total;
      var objective = scoringCorrectness ? 0.95 : 0.999;
      /* Budget remaining, the way an error budget actually works: the share of
         the allowed failures that have not been spent yet. */
      var allowed = total * (1 - objective);
      var remaining = Math.max(0, (allowed - bad) / allowed);

      title.textContent = scoringCorrectness
        ? "SLO · 95% of answers are correct and safe to act on"
        : "SLO · 99.9% of requests succeed";
      verdict.textContent = pct(sli) + (sli >= objective ? " · healthy" : " · burning");
      verdict.className = "slo-verdict " + (sli >= objective ? "ok" : "bad");
      fill.style.width = (remaining * 100).toFixed(1) + "%";
      fill.className = "budget-fill" + (remaining > 0.4 ? "" : remaining > 0 ? " warn" : " bad");
    }

    function addRow(entry, ageSeconds) {
      var row = el("button", "slow-row");
      row.type = "button";
      row.setAttribute("aria-expanded", "false");

      var line = el("div", "slow-row-line");
      line.appendChild(el("span", "slow-row-time", clockAt(ageSeconds)));
      line.appendChild(el("span", "slow-row-q", entry.question));
      var code = el("span", "slow-row-code", entry.status);
      line.appendChild(code);
      line.appendChild(el("span", "slow-row-ms", entry.latency + "ms"));
      row.appendChild(line);

      var body = el("div", "slow-row-body", entry.text);
      if (entry.verdict === "fail") {
        var why = el("span", "slow-row-verdict",
          "Graded wrong. " + (entry.judgeReason || ""));
        body.appendChild(why);
      }
      row.appendChild(body);

      row.addEventListener("click", function () {
        var open = row.classList.toggle("is-open");
        row.setAttribute("aria-expanded", open ? "true" : "false");
      });

      if (scoringCorrectness && entry.verdict === "fail") row.classList.add("is-wrong");
      row.dataset.wrong = entry.verdict === "fail" ? "1" : "0";

      scroll.insertBefore(row, scroll.firstChild);
      while (scroll.children.length > 60) scroll.removeChild(scroll.lastChild);
    }

    function nextEntry() {
      var source = pool[cursor % pool.length];
      cursor += 1;
      /* One in roughly two hundred requests really does fail at the transport
         layer. That is the whole point: it is the only failure the left-hand
         SLO can see. */
      var is5xx = Math.random() < 0.005;
      served += 1;
      if (is5xx) errors5xx += 1;
      else if (source.verdict === "fail") wrong += 1;
      return {
        question: source.question,
        text: source.text,
        judgeReason: source.judgeReason,
        verdict: is5xx ? "fail" : source.verdict,
        status: is5xx ? "503" : "200",
        latency: is5xx ? 118 : 700 + Math.floor(Math.random() * 1900)
      };
    }

    toggle.addEventListener("click", function () {
      scoringCorrectness = !scoringCorrectness;
      toggle.setAttribute("aria-pressed", scoringCorrectness ? "true" : "false");
      toggle.textContent = scoringCorrectness ? "Score for HTTP status" : "Score for correctness";
      Array.prototype.forEach.call(scroll.children, function (row) {
        row.classList.toggle("is-wrong", scoringCorrectness && row.dataset.wrong === "1");
      });
      render();
    });

    for (var i = 24; i > 0; i -= 1) addRow(nextEntry(), i * 3);
    render();

    if (!reducedMotion) {
      window.setInterval(function () {
        addRow(nextEntry(), 0);
        render();
      }, 900);
    }
  }

  /* ================= widget B: grade them yourself ================= */
  function initJudge(mount, data) {
    var items = data.items.map(function (item) {
      return {
        question: item.question,
        answer: item.answers.a,
        flip: item.position_flip
      };
    });
    if (!items.length) return;

    /* You grade one answer per question, but the run produced two. The reveal
       reports both scopes on purpose: agreeing on the six you saw says nothing
       about the six you did not, and quoting only the flattering half is the
       exact move this post is arguing against. */
    var corpus = flatten(data);
    var corpusAgree = corpus.filter(function (a) {
      return a.verdict === a.judgeVerdict;
    }).length;
    var corpusHumanFail = corpus.filter(function (a) { return a.verdict === "fail"; }).length;
    var corpusJudgeFail = corpus.filter(function (a) { return a.judgeVerdict === "fail"; }).length;

    var index = 0;
    var mine = [];

    mount.textContent = "";
    var panel = el("div", "slo-panel");
    var progress = el("p", "slow-progress");
    var card = el("div", "slow-card");
    var question = el("p", "slow-q");
    var answer = el("div", "slow-answer");
    card.appendChild(question);
    card.appendChild(answer);

    var controls = el("div", "slow-controls");
    var good = el("button", "slow-btn is-good", "Correct and safe to act on");
    var bad = el("button", "slow-btn is-bad", "Wrong");
    good.type = "button";
    bad.type = "button";
    controls.appendChild(good);
    controls.appendChild(bad);

    panel.appendChild(progress);
    panel.appendChild(card);
    panel.appendChild(controls);
    mount.appendChild(panel);

    function show() {
      var item = items[index];
      progress.textContent = "Answer " + (index + 1) + " of " + items.length +
        " · " + data.answerer + ", no runbooks, no cluster access";
      question.textContent = item.question;
      answer.textContent = item.answer.text;
      answer.scrollTop = 0;
    }

    function reveal() {
      panel.textContent = "";
      var agreedWithMe = 0;
      var flips = items.filter(function (item) { return item.flip; }).length;

      var board = el("div", "slow-scoreboard");
      var header = el("div", "slow-score-row");
      header.appendChild(el("span", "slow-score-q", "Question"));
      header.appendChild(el("span", "slow-tag", "You"));
      header.appendChild(el("span", "slow-tag", data.judge));
      header.appendChild(el("span", "slow-tag slow-col-human", "Reference"));
      board.appendChild(header);

      /* Every answer in the run gets a row, not only the six you graded. Both
         places where the judge and the reference disagree happen to be second
         answers, which you were never shown: listing only what you graded
         would hide the disagreement behind the sampling, which is the same
         mistake as trusting a judge you never audited. */
      data.items.forEach(function (item, i) {
        ["a", "b"].forEach(function (variant) {
          var answer = item.answers[variant];
          if (!answer) return;
          var judgeVerdict = answer.judge && answer.judge.verdict;
          var humanVerdict = answer.human && answer.human.verdict;
          var yours = variant === "a" ? mine[i] : null;
          if (yours && yours === judgeVerdict) agreedWithMe += 1;

          var row = el("div", "slow-score-row");
          if (humanVerdict && judgeVerdict !== humanVerdict) row.classList.add("is-split");
          row.appendChild(el("span", "slow-score-q",
            item.question + (variant === "b" ? " (second answer, not shown to you)" : "")));
          row.appendChild(el("span", "slow-tag " + (yours || ""), yours || "—"));
          row.appendChild(el("span", "slow-tag " + judgeVerdict, judgeVerdict || "—"));
          row.appendChild(el("span", "slow-tag slow-col-human " + (humanVerdict || ""),
            humanVerdict || "—"));
          board.appendChild(row);
        });
      });

      var summary = el("p", "slow-note");
      summary.textContent =
        "You and " + data.judge + " agreed on " + agreedWithMe + " of the " + items.length +
        " answers you graded. Across all " + corpus.length + " answers in the run, the judge " +
        "and the written human reference agree on " + corpusAgree + ", and both rows they " +
        "split on are second answers you were never shown. The judge is the stricter grader: it fails " +
        corpusJudgeFail + " of " + corpus.length + " where the reference fails " +
        corpusHumanFail + ", which is the difference between calling this bot " +
        pct((corpus.length - corpusHumanFail) / corpus.length) + " correct and calling it " +
        pct((corpus.length - corpusJudgeFail) / corpus.length) + " correct. " +
        "Asked instead to pick the better of two answers, the judge changed its mind on " +
        flips + " of " + items.length + " questions when the pair was shown in the opposite order.";

      var link = el("p", "slow-note");
      var a = el("a", null, "Read every transcript and verdict");
      a.href = mount.getAttribute("data-src");
      link.appendChild(a);
      link.appendChild(document.createTextNode(
        " · run cost $" + data.total_cost_usd + " on " + data.generated + "."));

      panel.appendChild(board);
      panel.appendChild(summary);
      panel.appendChild(link);
    }

    function record(verdict) {
      mine.push(verdict);
      index += 1;
      if (index >= items.length) reveal();
      else show();
    }

    good.addEventListener("click", function () { record("pass"); });
    bad.addEventListener("click", function () { record("fail"); });
    show();
  }

  /* ================= widget C: how a budget actually burns ================= */
  function initBurn(mount) {
    var targets = [99, 99.5, 99.9, 99.95, 99.99];
    var targetIndex = 3;
    var errorRate = 10;

    mount.textContent = "";
    var panel = el("div", "slo-panel");
    var sliders = el("div", "slow-sliders");

    function slider(labelText, min, max, step, value, onInput) {
      var wrap = el("div", "slow-slider");
      var label = el("label");
      var name = el("span", null, labelText);
      var out = el("b");
      label.appendChild(name);
      label.appendChild(out);
      var input = document.createElement("input");
      input.type = "range";
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = value;
      var id = "slow-" + labelText.replace(/\W+/g, "-").toLowerCase();
      input.id = id;
      label.htmlFor = id;
      input.addEventListener("input", function () { onInput(Number(input.value)); });
      wrap.appendChild(label);
      wrap.appendChild(input);
      sliders.appendChild(wrap);
      return out;
    }

    var targetOut = slider("Objective", 0, targets.length - 1, 1, targetIndex, function (v) {
      targetIndex = v;
      render();
    });
    var rateOut = slider("Sustained error rate", 1, 100, 1, errorRate, function (v) {
      errorRate = v;
      render();
    });

    var readout = el("div", "slow-readout");
    var note = el("p", "slow-note");
    note.textContent =
      "A 28-day window. The budget is the same either way: what changes is " +
      "whether spending it looks like an incident.";

    panel.appendChild(sliders);
    panel.appendChild(readout);
    panel.appendChild(note);
    mount.appendChild(panel);

    function stat(name, value, cls) {
      var box = el("div", "slow-stat");
      box.appendChild(el("div", "slow-stat-name", name));
      box.appendChild(el("div", "slow-stat-value" + (cls ? " " + cls : ""), value));
      return box;
    }

    function render() {
      var target = targets[targetIndex];
      var budget = WINDOW_MINUTES * (1 - target / 100);
      var burn = budget / (errorRate / 100);

      targetOut.textContent = target + "%";
      rateOut.textContent = errorRate + "%";

      readout.textContent = "";
      readout.appendChild(stat("Budget for 28 days", duration(budget)));
      readout.appendChild(stat(
        "Gone after",
        duration(burn),
        errorRate >= 50 ? "" : errorRate >= 20 ? "warn" : "bad"
      ));
      readout.appendChild(stat(
        "Anyone paged?",
        errorRate >= 50 ? "Yes, obviously" : errorRate >= 20 ? "Maybe" : "Probably not",
        errorRate >= 50 ? "" : errorRate >= 20 ? "warn" : "bad"
      ));
    }

    render();
  }

  /* ================= wiring ================= */
  var builders = { dashboard: initDashboard, judge: initJudge, burn: initBurn };
  var cache = {};

  function withData(url, done) {
    if (cache[url]) { done(cache[url]); return; }
    window.fetch(url).then(function (r) {
      if (!r.ok) throw new Error("transcripts " + r.status);
      return r.json();
    }).then(function (data) {
      cache[url] = data;
      done(data);
    }).catch(function () {
      /* Leave the shortcode's fallback markup exactly where it is: it already
         states the point and links the raw data. */
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll(".slow-mount"), function (mount) {
    var build = builders[mount.getAttribute("data-widget")];
    if (!build) return;
    var src = mount.getAttribute("data-src");
    if (!src) { build(mount); return; }
    withData(src, function (data) { build(mount, data); });
  });
})();
