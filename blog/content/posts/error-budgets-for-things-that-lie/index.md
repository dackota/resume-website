+++
title = 'Error Budgets for Things That Lie'
date = 2026-08-26
summary = "An LLM feature can return a fast, well-formed, HTTP 200 answer that is wrong. Every classic SLI reads that as a success. Here is what to measure instead, and who gets to grade it."
tags = ["sre", "observability", "ai"]
draft = false
interactive = true
+++

Here is an internal SRE assistant. On-call engineers ask it Kubernetes
questions. It is up, it is fast, and it is meeting its SLO.

{{< slo-dashboard >}}

Now press "score for correctness."

Nothing about the traffic changed. Same requests, same status codes, same
latencies. The only thing that changed is what counts as a good event. Every
row is still a 200 that came back inside its latency objective, and a quarter
of them are answers I would not want an engineer acting on at 3am.

## The proxy broke and nobody told us

Availability was never the thing we cared about. It was a proxy for the thing
we cared about, and it was a very good one. A 500 means the user got nothing.
A timeout means they gave up. The status code sat close enough to lost value
that we could measure the code and reason about the value.

That link is what an LLM breaks. The response is well-formed. The status is
200. The latency is fine. The content is wrong. There is no layer in the
request path that knows the difference, so the service reports healthy while
quietly handing people bad answers.

This is not a new failure mode in kind. We have always had bugs that return
200. What is new is the rate. A bug that returns wrong data is a defect you fix
once. A model that returns wrong data is doing exactly what it does, at some
rate, forever. You are not going to fix it to zero. You are going to have to
budget for it.

Which, conveniently, is a thing we already know how to do.

## Keep the machine, swap the signal

None of this needs new machinery. The SLI/SLO/error-budget loop works fine. You
point it at a different number.

| The part | What it used to mean | What it means now |
|---|---|---|
| SLI | Share of requests that returned successfully | Share of answers that clear a quality bar |
| SLO | The target for that share | Unchanged |
| Error budget | Failed requests you can afford | Wrong answers you can afford |
| Burn alerts, release gates, postmortems | Same mechanism | Unchanged |

Google's *Art of SLOs* handbook reduces every SLI to one equation: good events
divided by valid events. That equation does not care what "good" means. It
only cares that you can decide, per event, which bucket it lands in. Deciding
that for a paragraph of English is harder than reading a status code. It is not
a different kind of problem.

Two mechanics from the classic playbook carry over unchanged, and both matter
more here than they did before.

**Measure per event, not per bucket.** If your SLO evaluation classifies a
whole minute as good or bad, one bad minute can eat a large share of a month's
budget in a single shot. That is bad enough for availability. It is useless for
correctness, where the interesting signal is one wrong answer in a minute of
right ones.

**A sustained partial failure spends the budget as completely as an outage.**
There is a slider for this further down, because the arithmetic is more
alarming than the sentence.

## Four things worth measuring

I split AI quality indicators four ways. This is my own carve-up, not a
standard, and the value is in the split rather than the labels:

- **Correctness.** Is the answer right? Groundedness, factual accuracy, whether
  the task actually got done.
- **Safety.** Is the answer allowed? Policy adherence, data leakage, refusing
  the things that should be refused.
- **Experience.** Is it usable? Time to first useful token, completeness, valid
  format. This is the one your existing latency SLI already half-covers.
- **Cost.** Is it sustainable? Spend per resolved task, retry rate, how often
  you fall back to a cheaper model.

The split earns its keep because these fail independently and get fixed by
different people. Correctness is a retrieval and prompting problem. Safety is a
guardrail problem. Experience is usually an orchestration problem, four chained
model calls where you thought there was one. Cost is an architecture problem. A
single "quality" number averages all four into something nobody can act on.

## Start with one, and keep safety out of it

Two opinions, and they are opinions.

**Safety is a gate, not an SLO.** You will see advice to set safety objectives
first: zero PII exposure, under 0.1% serious errors in critical workflows. The
targets are right and the mechanism is wrong. An SLO with a zero target is not
an SLO. It has no budget, so there is nothing to spend, nothing to burn, and no
decision the number can inform. It is a rule. Enforce it the way you enforce
every other rule with no acceptable failure rate: block at the boundary,
redact, require a human for destructive actions, and page when it trips. Do not
give it an error budget, because you are never going to let anyone spend it.

**Then commit to exactly one correctness SLI, and set it too loose.** Pick your
feature's worst realistic failure, write one indicator for it, and set the
target where you are confident you already pass. You will be tempted to
instrument all four families at once. Resist it. A program that ships four
indicators and zero decisions is worse than one indicator that changes what you
do on Thursday. Tighten after you have watched real traffic for a month, not
before.

## But who is doing the grading?

Everything above depends on this and I have seen almost nobody do it.

You cannot read every response. At any real volume, something automated has to
score production traffic. Where the answer has verifiable structure, use code:
did the JSON parse, did the cited document exist, did the query run. Where it
does not, the usual move is a second model as the judge.

Which just moves the question. Now the judge's calibration is load-bearing.
Your error budget is only as trustworthy as the thing deciding what counts as
an error, and a number that came out of a model is still a number that came out
of a model. Uncalibrated automated scoring is its own kind of hallucination:
confidently wrong, and wearing a percent sign so nobody argues with it.

So I ran it, expecting to catch the judge out.

Six real on-call questions, the sort our platform team actually gets asked.
Claude Haiku 4.5 answered each one twice, with no runbooks, no retrieval and no
cluster access, which is how these bots tend to get shipped. Then Claude Opus 5
graded all twelve answers, seeing only the question and the answer. It never
saw a reference. Separately, I graded all twelve myself against written ground
truth, before reading a single one of its verdicts.

Grade a few yourself before you look at either of us.

{{< slo-judge >}}

Here is what came back. The judge and I agreed on ten of twelve. It was the
stricter one: it failed five answers, I failed three. And on the two we split,
its reasoning was sound both times. It failed an answer for listing a status
string that Kubernetes does not have, and another for saying a dead backend
causes a 404 when a dead backend causes a 503. I had let both through as
imprecise-but-harmless. Reasonable people can draw that line in either place.

Then the part I did not plan for. One answer suggested finding a cert-manager
Challenge with `-l acme.cert-manager.io/order-name=<order>`. I passed it,
because a web search told me the label was real. The judge failed it and said
the label does not exist. The judge was right. A code search across
cert-manager's repository returns exactly one hit for `order-name`, and it is a
placeholder inside a kubectl command in a design document. So my reference
answer was wrong, my fact-check was wrong, and the model I was auditing caught
it.

I also tested for position bias, since that is the failure everyone cites. Each
pair of answers went back to the judge twice, in both orders. It changed its
mind on one question out of six, and picked whichever answer came second in
seven of twelve comparisons. Seven of twelve is a coin flip. On this sample,
with this rubric, I did not find the bias I went looking for.

None of which makes the judge trustworthy. It makes it measured. Look at the
two numbers: by my grading this bot answers correctly 75% of the time, by the
judge's it is 58%. Same twelve answers. That 17-point gap is not noise and it
is not either of us being wrong. It is a disagreement about where the bar sits,
and if you had only shipped the automated number you would have had 58% and no
way to know which kind of number it was.

That is the whole argument for calibration, and it survives the judge doing
well. "We use an LLM judge" describes your tooling. It says nothing about
whether your SLI means anything. Hand-grade a sample, compare, and keep doing
it on a schedule, because the model behind your judge gets swapped out and
nobody will think to re-check.

## The failure that never looks like one

The other thing that carries over from classic SLO practice, and the one I
think gets underweighted the most.

Every added nine cuts your allowed downtime by about ten times. Over 28 days,
99% gives you 6h43m, 99.9% gives you 40m, 99.95% gives you 20m, 99.99% gives
you 4m. Everyone knows this part.

The part people skip: a sustained partial error rate spends that budget just as
completely as a total outage, and nothing about it looks like an incident.

{{< slo-burn >}}

Drag the error rate down. At a 99.95% objective, a full outage burns the whole
28-day budget in 20 minutes, and every phone in the company rings. A sustained
10% error rate burns the same budget in 3h22m, and nothing rings at all. The
dashboards stay green. The graphs look normal. Nobody files a ticket, because
nine out of ten requests worked fine and the tenth just looked like a bad
answer rather than a broken service.

That is the exact shape of LLM failure. Not an outage. A steady rate of
confident wrongness that no transport-layer alert will ever catch.

## Evals are not observability

One last thing, because it is the mistake I see most.

Evals are unit tests for the model call. They are useful and you should have
them. They also do not exercise anything around the model call: tool routing,
output correction, retries, error handling, the actual thing the user sees. An
application can pass every eval and still be a bad product, because the code
around the model is broken.

Honeycomb's Query Assistant is the case study I keep returning to. It errored
on roughly a quarter of requests in early production. The fix that cut it to
14% was not prompt engineering. It was one deterministic post-processing step
that stripped a single known-invalid field from the model's output before
running it. No eval would have found that, because the model call was fine. The
code around it was not.

Which is the same lesson as everything else here: measure the thing the user
receives, not the thing the model produced.

## What to do on Monday

1. Pick the one AI feature that would embarrass you most if it were quietly
   wrong.
2. Write down what "wrong" means for it, in one sentence, specific enough that
   two engineers grade the same answer the same way.
3. Score a hundred real production responses by hand. Not a golden dataset.
   Real traffic, sampled.
4. That number is your current SLI. Set the objective a bit below it.
5. Now automate the scoring, and check the automated grades against your
   hundred hand-graded ones. If they disagree, fix the grader before you trust
   the SLO.
6. Keep safety out of it. That is a gate, and it blocks.

The machinery already exists in your organization. It is pointed at the wrong
number.

## Sources

The SLO mechanics, the good-events-over-valid-events equation, and the outage
arithmetic come from Google Customer Reliability Engineering's
[The Art of SLOs participant handbook](https://static.googleusercontent.com/media/sre.google/en//static/pdf/art-of-slos-handbook-a4.pdf)
(CC BY 4.0). The offline versus online evaluation split is from Huang, Li and
Yehdego,
[Evaluating LLM systems](https://medium.com/data-science-at-microsoft/evaluating-llm-systems-metrics-challenges-and-best-practices-664ac25be7e5),
Data Science at Microsoft, March 2024. The Query Assistant numbers and the
evals-are-not-observability framing are from *Observability Engineering*, 2nd
edition, chapters 11, 12 and 21.

The four-way split and both opinions in this post are mine. The transcripts,
grades and pairwise comparisons are real output, generated by
[this script](https://github.com/dackota/resume-website/blob/main/scripts/slo-post-experiment.sh)
and published unedited as
[transcripts.json](transcripts.json).
