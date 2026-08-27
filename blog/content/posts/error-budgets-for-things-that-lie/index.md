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
row is still a 200 that came back inside its latency objective but clearly 
the user experience is not great.

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
only cares that you can decide, per event, which bucket it lands in. Sure, deciding
that for a paragraph of English is harder than reading a status code but its not
a different kind of problem.

Two mechanics from the classic playbook carry over unchanged:

**Measure per event, not per bucket.** If your SLO evaluation classifies a
whole minute as good or bad, one bad minute can eat a large share of a month's
budget in a single shot. That is bad enough for availability. It is useless for
correctness, where the interesting signal is one wrong answer in a minute of
right ones.

**A sustained partial failure spends the budget as completely as an outage.**

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

Correctness is a retrieval and prompting problem. Safety is a
guardrail problem. Experience is usually an orchestration problem, four chained
model calls where you thought there was one. Cost is an architecture problem. A
single "quality" number averages all four into something nobody can act on.

## But who is doing the grading?

You cannot read every response. At any real volume, something automated has to
score production traffic. Where the answer has verifiable structure, use code:
did the JSON parse, did the cited document exist, did the query run. Where it
does not, the usual move is a second model as the judge.

But even the LLM judge needs to occasionally be judged by a human expert so you 
don't put yourself in a blind-leading-the-blind situation. By doing this you calibrate your judge 
to make better judgements which will increase confidence in it. 

Give it a try! Grade a few yourself to see how well my LLM judge did:

{{< slo-judge >}}

## Sources

The SLO mechanics, the good-events-over-valid-events equation, and the budget
arithmetic come from Google Customer Reliability Engineering's
[The Art of SLOs participant handbook](https://static.googleusercontent.com/media/sre.google/en//static/pdf/art-of-slos-handbook-a4.pdf)
(CC BY 4.0).

The four-way split is mine. The transcripts,
grades and pairwise comparisons are real output, generated by
[this script](https://github.com/dackota/resume-website/blob/main/scripts/slo-post-experiment.sh)
and published unedited as
[transcripts.json](transcripts.json).
