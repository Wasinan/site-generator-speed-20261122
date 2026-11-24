# site-generator-speed-20261122

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Wasinan/site-generator-speed-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Wasinan/site-generator-speed-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0 static site generator: it builds the exact same output tree, byte for byte, with less CPU time. Templates are compiled to functions once, Markdown is lexed and rendered in a single fused pass with batched inline escaping, and hot paths (slugs, front matter, escaping) use fast paths and caches.

## Run

```sh
node main.ts
```

It reads the cases from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).

Referral code: 5tkzhb3s
