# Viva preparation — Cricket Score Predictor

Read this once the numbers from your own run are in. Replace every `<...>`
with the actual figure `src/03_train.py` printed for you.

---

## The one-minute opening

> "I predict the final first-innings score of a T20 match from the live state of
> the innings. The data is the full Cricsheet archive — about 22,000 matches
> ball by ball. The model is LightGBM. But the part I spent most of my time on
> was not the model, it was making sure the evaluation was honest: the obvious
> way to split this data leaks the answer, and I can show you by how much."

That framing pre-empts the hardest question by asking it yourself.

---

## Data and problem framing

**Q. Why only the first innings?**
A chase is a different problem. In the second innings the batting side plays to
a target, so their final score is capped by the target and shaped by required
run rate, not by maximising runs. Mixing the two innings would put two different
data-generating processes under one label.

**Q. Why T20 and not ODI or Test?**
The state space is bounded and consistent — 120 balls, 10 wickets. It also gives
the largest number of matches. The same pipeline runs on ODIs by changing
`KEEP_TYPES` and `TOTAL_OVERS` in `src/02_features.py`.

**Q. How many rows do you have, and what is one row?**
One row is the state of the innings after one legal delivery. Roughly 115 usable
rows per innings. The target attached to every row of an innings is the same
number: what that innings finished on.

**Q. Why did you drop some innings?**
Rain-shortened innings. If the innings was cut to 12 overs, its final score is
not comparable to a 20-over total, and the model would learn a nonsense mapping.
I keep an innings only if it went the full distance or ended all out.

---

## The leakage argument (this is the centrepiece)

**Q. Your R² looks lower than other cricket projects. Why?**

> "Because theirs is measured wrong, and I can prove it with my own data.
> `final_score` is constant across all ~115 rows of one innings. If you shuffle
> rows and split randomly, ball 12.3 goes to train and ball 12.4 goes to test —
> two rows that are nearly identical in every feature, with exactly the same
> answer. The model isn't predicting, it's looking the answer up. My script
> trains that leaky version too: MAE `<leaky>` runs. The same model with a
> date-based split gets MAE `<honest>`. The second number is what it would do
> on tomorrow's match."

**Q. Why a temporal split rather than just grouping by match?**
Grouping by match removes the leak, but still lets the model train on 2026 data
and test on 2015 data. T20 scoring has inflated a lot over the years, so that
would flatter it too. A temporal split matches how the model would really be
used: everything it knows is in the past. My script reports both — the group
split gives `<group>`, close to the temporal number, which confirms the leak was
the cause and not the split style.

**Q. Where else could leakage have crept in?**
The context features. If I had used a batter's career strike rate computed over
the whole dataset, then for a 2016 match I'd be feeding in runs he scored in
2024. Every such feature is expanding-mean **shifted by one match**, so it only
ever sees matches before the current one.

---

## Covering every format with one model

**Q. How can one model handle a T20 and a Test?**
Through `progress` - balls bowled divided by total balls in the innings - so
"halfway" means the same thing in both. Multi-day innings have no ball limit,
so progress is missing and LightGBM handles that natively by sending those rows
down their own branch. The format itself is also a categorical feature, so the
model can learn entirely separate behaviour where it needs to.

**Q. Why report error per format instead of one number?**
Because a 30-run error on a 250-run ODI innings is a much smaller mistake than a
30-run error on a 150-run T20 innings. A single blended MAE would hide which
format the model is actually good at. My overall figure is `<x>`; the per-format
row is what should be read.

**Q. Does sharing one model across formats hurt T20 accuracy?**
That is testable, and I tested it: `ONLY_FAMILY = "t20"` in the training script
trains a T20-only model. Compare its MAE against the T20 row of the shared
model. (Report your two numbers here.)

**Q. Why thin the multi-day innings?**
A Test innings can be several thousand balls against roughly 120 for a T20. Left
alone, multi-day rows would dominate the loss purely by count and the model
would optimise for the format I care least about. I keep every 4th ball there
and every ball elsewhere.

**Q. You included chases. Isn't that a different problem?**
It is, so the model is told: `is_chase`, `target_runs` and `runs_needed` are
features. But I would flag the honest caveat - a chase ends as soon as the
target is passed, so its final score is censored. It is not "how many they could
have scored", and the model is implicitly learning the target, not the ceiling.

**Q. Why does the app bound the prediction?**
A physical constraint. The final score cannot fall below what is already on the
board, and in limited overs it cannot exceed about 18 runs an over off the balls
remaining. If an unfamiliar venue or team pushes the raw model somewhere
impossible, the bound catches it. A model should not be allowed to output
something the sport cannot produce.

## Features

**Q. Which feature matters most, and does that make sense?**
Current run rate, by a wide margin, then wickets in hand and the venue par
score. That ordering is what a commentator would tell you, which is a good sign
— it means the model found the real structure rather than an artefact.

**Q. What is `venue_par`?**
The average first-innings total previously scored at that ground, as of this
match's date. It is how the model knows a total of 150 means something different
at a small ground than at a big one.

**Q. What is `resource`?**
`wickets_left × balls_left`. A crude stand-in for the Duckworth-Lewis resource
idea: runs still to come depend on both how much time is left and how many
wickets you can afford to lose.

**Q. Why LightGBM and not a neural network?**
This is heterogeneous tabular data with high-cardinality categoricals (venues,
teams). Gradient-boosted trees are the strongest family here, and it is a
well-replicated result that they beat deep networks on this kind of table. A
bigger model would not buy accuracy; better features and honest validation did.

**Q. How do you handle a team or venue the model has never seen?**
The category becomes null, LightGBM sends it down its default branch, and the
par-score features fall back to the global average. It degrades rather than
crashing.

---

## Uncertainty

**Q. Why show a range instead of a single number?**
Because a single number implies a precision that does not exist. At 5 overs an
innings can genuinely end anywhere over a 60-run span. Reporting a point
estimate alone would be misleading, not accurate.

**Q. How is the interval built?**
Two ways, and I kept the better one. Quantile regression at the 10th and 90th
percentile came out under-covered — a nominal 80% band caught only about
`<quantile coverage>`% of outcomes. So I added split-conformal calibration:
I measure the residual percentiles on the validation set, separately for each
phase of the innings, and add those offsets to the point prediction. That gets
coverage to about `<conformal coverage>`%.

**Q. Why does the band narrow late in the innings?**
Fewer balls remain, so there is less room left for surprise. That shrinking band
is the model correctly representing that the outcome is becoming determined.

---

## Results

**Q. What is your error, honestly?**
MAE `<x>` runs overall, but the overall figure is not the useful one — error
depends heavily on when you ask. Show the phase table: large in the powerplay,
small at the death. Then say: at 5 overs nobody can predict this well, including
a professional commentator.

**Q. Is that good?**
It is in the range published work reports for this task. Anyone reporting
single-digit MAE from the first over either has leakage or is measuring
something else.

---

## Weaknesses to raise yourself

Volunteering these is worth more marks than being caught by them.

1. No weather, pitch condition, or dew — dew alone materially changes second-
   innings behaviour and is not in any free dataset.
2. No team sheet: the model does not know who is yet to bat. A side 60/4 with a
   strong lower order differs from one with tail-enders, and the model cannot
   see that.
3. Player features are match-level, not ball-level form. A batter's last five
   innings would beat his career average.
4. Franchise teams get renamed and rebuilt between seasons, so "team identity"
   is a noisier feature in leagues than in international cricket.
5. Concept drift: T20 scoring keeps rising, so the model needs periodic
   retraining. The `year` feature helps but does not extrapolate past the data.

---

## If asked "what would you do next?"

- Ball-level rolling form for batter and bowler (last 100 balls, not career).
- Model runs-to-come per ball and sum, instead of the final total directly.
- A separate second-innings model with the target as a feature, giving win
  probability.
- Quantile-of-quantile checks on interval calibration by venue, to see whether
  the band is honest everywhere or only on average.
