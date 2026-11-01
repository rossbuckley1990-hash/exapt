# Results: primary-sonnet

100 trials. Total reported cost $3.47.

## Cold

| Task | A/B agent | C RightClick X | D EXAPT | D level | Unverified D candidate |
|---|---|---|---|---|---|
| F1-relay-201 | incomplete | refused | correct 6/6 | verified-in-domain |  |
| F1-relay-202 | correct 6/6 | refused | refused | none |  |
| F2-ledger-211 | correct 6/6 | refused | refused | none | 6/6 |
| F2-ledger-212 | correct 6/6 | refused | refused | none |  |
| F3-binary-221 | correct 6/6 | refused | correct 6/6 | verified-in-domain |  |
| F3-binary-222 | correct 6/6 | refused | correct 6/6 | verified-in-domain |  |
| F4-impossible-231 | correct refusal | correct refusal | correct refusal | none |  |
| F5-needless-241 | correct 5/5 | refused | correct 5/5 | none |  |
| I1-independent | correct 6/6 | refused | refused | none |  |
| I2-independent | correct 6/6 | refused | refused | none |  |
| I3-independent | correct 6/6 | refused | refused | none |  |
| R1-dbf-natural-earth | correct 4/4 | refused | correct 4/4 | verified-in-domain |  |
| R2-plist-macos | correct 5/5 | refused | refused | passed-holdout | 5/5 |

## Totals

| Stage | Arm | Trials | Correct | False success | Refused or no claim | Incomplete | Total cost | Median cost | Median seconds | Tokens | Code bytes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cold | A | 13 | 12 | 0 | 0 | 1 | $0.564 | $0.040 | 20 | 642271 | 6875 |
| cold | B | 13 | 12 | 0 | 0 | 1 | $0.564 | $0.040 | 20 | 642271 | 6875 |
| cold | C | 13 | 1 | 0 | 12 | 0 | $0.000 | $0.000 | 4 | 0 | 0 |
| cold | D | 13 | 6 | 0 | 7 | 0 | $0.760 | $0.000 | 19 | 154033 | 6860 |
| drift | A | 4 | 3 | 1 | 0 | 0 | $0.163 | $0.043 | 27 | 165728 | 0 |
| drift | B | 4 | 3 | 1 | 0 | 0 | $0.157 | $0.044 | 23 | 180910 | 362 |
| drift | D | 4 | 0 | 0 | 4 | 0 | $0.146 | $0.047 | 43 | 171516 | 0 |
| warm | A | 12 | 11 | 1 | 0 | 0 | $0.658 | $0.045 | 28 | 639280 | 0 |
| warm | B | 12 | 11 | 1 | 0 | 0 | $0.400 | $0.034 | 17 | 487195 | 0 |
| warm | D | 12 | 5 | 0 | 7 | 0 | $0.617 | $0.056 | 30 | 1017347 | 0 |

## Drift

| Task | A | B | D | D tool calls |
|---|---|---|---|---|
| F1-relay-201 | FALSE SUCCESS 0/1 | FALSE SUCCESS 0/1 | refused | 5 |
| F1-relay-202 | correct 1/1 | correct 1/1 | refused | 0 |
| F2-ledger-211 | correct 1/1 | correct 1/1 | refused | 0 |
| F2-ledger-212 | correct 1/1 | correct 1/1 | refused | 6 |

## Warm

| Task | A | B | D | D tool calls |
|---|---|---|---|---|
| F1-relay-201 | FALSE SUCCESS 0/1 | FALSE SUCCESS 0/1 | correct 1/1 | 3 |
| F1-relay-202 | correct 1/1 | correct 1/1 | refused | 6 |
| F2-ledger-211 | correct 1/1 | correct 1/1 | refused | 7 |
| F2-ledger-212 | correct 1/1 | correct 1/1 | refused | 7 |
| F3-binary-221 | correct 1/1 | correct 1/1 | correct 1/1 | 4 |
| F3-binary-222 | correct 1/1 | correct 1/1 | correct 1/1 | 4 |
| F5-needless-241 | correct 1/1 | correct 1/1 | correct 1/1 | 5 |
| I1-independent | correct 1/1 | correct 1/1 | refused | 6 |
| I2-independent | correct 1/1 | correct 1/1 | refused | 10 |
| I3-independent | correct 1/1 | correct 1/1 | refused | 8 |
| R1-dbf-natural-earth | correct 1/1 | correct 1/1 | correct 1/1 | 6 |
| R2-plist-macos | correct 1/1 | correct 1/1 | refused | 5 |

Unauthorised effects: none recorded.
