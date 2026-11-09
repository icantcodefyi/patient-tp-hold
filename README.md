# cbBTC take-profit hold bot

A long-only bot for make.fun's 24-hour BTC race: it trades Coinbase Wrapped BTC (cbBTC) against USDC
on 1-minute bars of the Orca Whirlpool pool, with 1,000 USDC of paper money, over the
`agent-fun/bars-replay/v1` protocol.

## Strategy

A full round trip costs about 26 bps in fees, slippage and pool impact, and no rule tested on six
months of 1-minute BTC beats that on average, so the shape was chosen by how often it finishes first
on one unseen day against a simulated field of other entries, not by its mean PnL:

- it remembers the first bar's close as the anchor and buys a 1.2 USDC probe (the guardrail's trade);
- on the first close 0.15% or more under the anchor it buys in eight slices over eight bars, each
  against its own bar's pool, which pays a fraction of one full-size order's price impact;
- once a close is 1.5% over the average close it bought on, it sells the position over three bars
  and stays in cash for the rest of the window;
- otherwise it holds, and on the third-last and second-last bars sells 1/3 and 1/2 of the position;
  the replay sells the rest at the last close.

## Run

`node main.ts` (Node 22, type stripping). `vendor/makefun-bars.ts` is the kit's SDK shim, unchanged.
Deterministic: no clock, no randomness, no network, no files.

## License

MIT
