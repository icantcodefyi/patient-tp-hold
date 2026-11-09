// Take-profit hold on cbBTC/USDC for make.fun's 24-hour BTC race (agent-fun/bars-replay/v1).
//
// A ranking game more than a trading edge: a full round trip costs about 26 bps, and no rule tested
// on six months of 1-minute BTC beats that on average. The ranking pays places on one unseen day, so
// the shape was chosen by how often it finishes first against a simulated field of other entries
// (holders, dip buyers that hold, take-profit holders, breakouts, reversion bots), not by its mean.
//
//   - First bar: remember its close as the anchor, and buy a 1.2 USDC probe, the one filled trade the
//     guardrail asks for (held with the rest).
//   - Entry: on the first close DIP_BPS or more under the anchor, buy in ENTRY_SLICES batches: 1/8 of
//     the cash, then 1/7 of what is left, ... then all of it. Each slice trades against its own bar's
//     pool, so the slices pay a fraction of one full-size order's price impact.
//   - Take profit: once a close is TAKE_PROFIT_BPS over the average close the slices were bought on,
//     sell the position over TP_SLICES batches (1/3, 1/2, the rest) and stay in cash for the rest of
//     the window. A day that rallies that far and gives it back still ends in profit; a day that keeps
//     rallying is given up past the target.
//   - Otherwise hold, and on the third-last and second-last bars sell 1/3 and then 1/2 of the
//     position; the replay sells the rest at the last close.
//
// The window's bars are found by time (hello.first_close_ms plus WINDOW_BARS - 1 minutes is the last
// close), never by counting batches, so a minute with no bar shifts nothing. Every decision is taken
// from the account in the batch, so an order the market refuses is sized again on the next batch.
// Deterministic: bigint money and integer comparisons only, no clock, no randomness, no files.

import { BPS, runBars, type Batch, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MINUTE_MS = 60_000;
/** The race and the dev window are both 1,440 one-minute bars. */
const WINDOW_BARS = 1440;

const DIP_BPS = 15n;
const TAKE_PROFIT_BPS = 150n;
const ENTRY_SLICES = 8;
const TP_SLICES = 3;
const EXIT_SLICES = 3;

const PROBE_QUOTE_UNITS = 1_200_000n;
const MIN_ORDER_QUOTE_UNITS = 1_000_000n;
const BUY_MAX_SLIPPAGE_BPS = 300;
const SELL_MAX_SLIPPAGE_BPS = 1_000;

type Order = BuyInput | SellInput;

const buy = (amount: bigint): BuyInput => ({ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS });
const sell = (qty: bigint): SellInput => ({ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS });

let anchor: bigint | null = null;
let phase: 'wait' | 'enter' | 'hold' | 'tp' | 'done' = 'wait';
/** Entry slices sent so far, and the sum of the closes they were decided on. */
let slices = 0;
let sliceCloses = 0n;
/** Take-profit sale slices still to send. */
let tpLeft = TP_SLICES;

/** One slice of the position: 1/n of it, or all of it when that slice would be under the minimum order. */
function slice(state: BarsState, qty: bigint, n: number): Order[] {
  if (qty <= 0n) return [];
  const part = n > 1 ? qty / BigInt(n) : qty;
  return [sell(part > 0n && state.value(SYMBOL, part) >= MIN_ORDER_QUOTE_UNITS ? part : qty)];
}

function decide(state: BarsState, batch: Batch): Order[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  const close = BigInt(bar.c);
  const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
  // bars of the window left after this one (0 on the last bar, whose orders the replay refuses)
  const left = (state.hello.first_close_ms + (WINDOW_BARS - 1) * MINUTE_MS - batch.t) / MINUTE_MS;

  if (anchor === null) {
    anchor = close;
    return [buy(PROBE_QUOTE_UNITS)];
  }
  if (phase === 'done') return [];

  // take profit, checked from the first slice on
  if ((phase === 'enter' || phase === 'hold') && slices > 0 && close * BPS * BigInt(slices) >= sliceCloses * (BPS + TAKE_PROFIT_BPS)) {
    phase = 'tp';
  }
  if (phase === 'tp') {
    if (qty === 0n) {
      phase = 'done';
      return [];
    }
    const n = tpLeft;
    if (tpLeft > 1) tpLeft--;
    return slice(state, qty, n);
  }

  if (phase === 'wait') {
    // the probe was refused (no bar at the next open): send it again, or the run may hold no trade
    if (qty === 0n && close * BPS > anchor * (BPS - DIP_BPS)) return left >= 1 ? [buy(PROBE_QUOTE_UNITS)] : [];
    if (left < EXIT_SLICES) return [];
    if (close * BPS > anchor * (BPS - DIP_BPS)) return [];
    phase = 'enter';
  }

  if (phase === 'enter') {
    if (left < EXIT_SLICES) {
      phase = 'hold';
    } else {
      const parts = BigInt(ENTRY_SLICES - slices > 1 ? ENTRY_SLICES - slices : 1);
      slices++;
      sliceCloses += close;
      if (slices >= ENTRY_SLICES) phase = 'hold';
      const amount = state.cash / parts;
      return amount >= MIN_ORDER_QUOTE_UNITS ? [buy(amount)] : [];
    }
  }

  // holding: a slice the market refused is bought now, then the exit split at the end
  if (left >= EXIT_SLICES && state.cash >= MIN_ORDER_QUOTE_UNITS) return [buy(state.cash)];
  if (left >= 1 && left < EXIT_SLICES) return slice(state, qty, left + 1);
  return [];
}

await runBars({ onBatch: decide });
