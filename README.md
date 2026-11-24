# Mend Patch CLI

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zamuwelle/mend-patch-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zamuwelle/mend-patch-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Mend applies unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON editor commands. It stages edits in memory and reports every failed edit before committing any changes. Text patches use exact, trailing-whitespace, and indentation-tolerant matching tiers. JSON replacements remain exact.

## Run it

From the target directory, using Node 22:

```sh
node /path/to/mend/main.ts --check change.patch
node /path/to/mend/main.ts change.patch
```

Omit the patch path to read stdin. Use `--strict` for exact matching or `--format=NAME` to select the reader. The entry keeps the contest kit's MIT-licensed runner and original CLI scaffolding.
