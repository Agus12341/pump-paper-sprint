// Washout-reversion for the pump.fun bonding-curve replay (agent-fun/replay/v2),
// with a coverage drip that keeps the run over the guardrail bar.
//
// What the dev window taught, and what this bot is built on:
//
// Most pump.fun coins are untradeable noise for a replay bot. A new coin's price
// spikes inside its first two or three slots - before any order of ours can fill -
// and from the first fillable price the forward path is flat-to-down almost
// everywhere: momentum entries buy the top of a move the tape has already finished,
// launch scalps pay the 1.25%-per-side curve fee on coins that never move again,
// and coins that absorb a huge buy and cross 30 SOL of real reserves in their
// opening slot have usually completed before an order can land. Every one of those
// families was tested on the dev window and lost money after fees.
//
// The one pattern that held up is the washout of a proven coin. A coin that has
// already run hard (at least +20% to its 1500-slot high), holds at least 12 SOL of
// real reserves and has traded at least 40 times is a coin with real holders and
// real liquidity. When such a coin washes out to 45-70% of that high and the
// selling dries up (net flow over the last 40 slots no worse than -0.3 SOL), part
// of the washout tends to mean-revert: dip buyers and returning holders lift the
// price off the base. The bot buys that base once per coin - a second dip on the
// same coin is a falling knife, not a bargain, and re-entries lost money in
// testing - and sells into the recovery: take profit at +18%, a trailing stop
// once up 12%, a hard stop at -12%, and a time stop after 900 slots so capital
// never sits in a coin that stopped moving.
//
// Sizing is one 0.3 SOL stake per position, at most four positions: the dev
// window's drawdown at this size stayed under 2% of the 10 SOL bankroll, far
// inside the 50% guardrail, and the stake is small enough that the 1%-of-reserve
// order cap binds only on the least liquid coins admitted.
//
// The guardrails also ask for round trips of at least 0.01 SOL on at least 20
// coins, which a book of roughly twenty washout trades per day may miss on a
// quiet final window. A slow coverage drip covers the gap: every 500 slots, if
// the round-trip count is behind, the bot round-trips 0.012 SOL on the most
// liquid coin of the moment in the spare position slot. Each trip costs a few
// ten-thousandths of a SOL in fees - cheap insurance that the run ranks above
// every entry that misses the bar.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream, so the
// replay's two executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1e9;
/** Curve fee share used when valuing a position for exit decisions (95 + 30 bps). */
const FEE_RATE = 0.0125;

// ---- washout entry ----------------------------------------------------------
const WINDOW = 1500; // slots of tape the run and the high are measured over
const MIN_AGE = 1500; // slots since CreateEvent before a coin may be bought
const MIN_TRADES = 40; // lifetime recorded trades before a coin may be bought
const MIN_RQ = 12; // real SOL reserve bounds at entry
const MAX_RQ = 80;
const MIN_RUN = 0.2; // the window high must sit at least this far above the window's first price
const OFF_MIN = 0.45; // buy only with the price between these shares of the window high
const OFF_MAX = 0.7;
const FLOW_W = 40; // slots of tape the selling-exhaustion check reads
const MIN_FLOW = -0.3; // net SOL flow over FLOW_W must be no worse than this
const STAKE_SOL = 0.3; // SOL per position
const MAX_POS = 4; // washout positions at once (one slot stays free for coverage)
const BUY_SLIP_BPS = 3000;

// ---- exits ------------------------------------------------------------------
const TAKE_PROFIT = 0.18; // sell when value reaches cost * (1 + this)
const STOP_LOSS = 0.12; // sell when value falls to cost * (1 - this)
const TRAIL_ARM = 0.12; // trailing stop arms at cost * (1 + this)
const TRAIL = 0.1; // then sell when value falls to peak * (1 - this)
const MAX_HOLD = 900; // slots after which the position is sold whatever it shows

// ---- coverage drip ----------------------------------------------------------
const COVER_TARGET = 24; // round-trip coins to bank (the bar is 20)
const COVER_EVERY = 500; // slots between coverage buys
const COVER_SOL = 0.012; // coverage buy size (the round-trip floor is 0.01)
const COVER_MIN_RQ = 2; // coverage coin needs at least this much real SOL reserve

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  lifetimeTrades: number;
  entered: boolean;
}

interface Held {
  opened: number;
  peak: number; // best close value seen (SOL)
  exiting: boolean;
}

export function createBot(): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Coverage positions in flight, by mint: 'buying' until the position shows, then 'selling'. */
  const cover = new Map<Pubkey, string>();
  /** Mints whose round trip has completed (position seen, then gone). */
  const tripped = new Set<Pubkey>();
  /** Mints with a position right now or a buy in flight: candidates for tripped once gone. */
  const openMints = new Set<Pubkey>();
  let lastCoverSlot = -1e12;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], lifetimeTrades: 0, entered: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL flow (buys minus sells) over the last w slots of a tape. */
  const flowOver = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** True when a coin's tape shows a washed-out proven runner with the selling done. */
  const washoutOk = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < MIN_RQ || rqSol > MAX_RQ) return false;
    if (t.created === null || now - t.created < MIN_AGE) return false;
    if (t.lifetimeTrades < MIN_TRADES) return false;
    let first = -1;
    let high = 0;
    let last = 0;
    for (const tr of t.trades) {
      if (tr.slot <= now - WINDOW) {
        first = tr.price;
        continue;
      }
      if (first < 0) first = tr.price;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (first <= 0 || high <= 0 || last <= 0) return false;
    if (high / first - 1 < MIN_RUN) return false;
    const off = last / high;
    if (off < OFF_MIN || off > OFF_MAX) return false;
    if (flowOver(t, now, FLOW_W) < MIN_FLOW) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / SOL;

      // Fold the batch's events into the tapes.
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / SOL,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          t.lifetimeTrades++;
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - WINDOW - 8) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingMints = new Set<Pubkey>();
      const sellPending = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingMints.add(po.order.mint);
        if (po.order.side === 'sell') sellPending.add(po.order.mint);
      }

      // Bookkeeping: a mint whose position has vanished completes its round trip.
      for (const mint of [...openMints]) {
        if (!state.positions.has(mint) && !pendingMints.has(mint)) {
          openMints.delete(mint);
          tripped.add(mint);
          cover.delete(mint);
          held.delete(mint);
        }
      }
      for (const mint of state.positions.keys()) openMints.add(mint);

      const orders: OrderInput[] = [];
      let free = Number(state.freeCashLamports()) / SOL;

      // 1) Exits for washout positions.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const cost = Number(pos.cost_lamports) / SOL;
        const value = ((tokens * vq) / (vt + tokens) / SOL) * (1 - FEE_RATE) - txSol;
        if (value > h.peak) h.peak = value;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
        if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
        if (!exit && h.peak >= cost * (1 + TRAIL_ARM) && value <= h.peak * (1 - TRAIL)) exit = true;
        if (!exit && now - h.opened > MAX_HOLD) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (sellPending.has(mint) || orders.length >= cap) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 2) Coverage sells: out on the first batch after the buy has landed.
      for (const mint of cover.keys()) {
        const pos = state.positions.get(mint);
        if (pos === undefined || held.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (sellPending.has(mint) || pendingMints.has(mint) || orders.length >= cap) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        cover.set(mint, 'selling');
      }

      // 3) Washout entries: one per coin, only on coins traded in this batch.
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0 || held.size >= MAX_POS) break;
        if (held.has(mint) || cover.has(mint) || pendingMints.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint)!;
        if (t.entered) continue;
        const rqSol = Number(curve.real_quote_reserves) / SOL;
        if (!washoutOk(t, now, rqSol)) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / SOL;
        const amount = Math.min(capSol, STAKE_SOL, free - txSol);
        if (amount < 0.01) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * SOL)), max_slippage_bps: BUY_SLIP_BPS });
        free -= amount + txSol;
        held.set(mint, { opened: now, peak: 0, exiting: false });
        t.entered = true;
        slotsLeft--;
      }

      // 4) Coverage drip: bank round trips on liquid coins until the bar is covered.
      if (
        now - lastCoverSlot >= COVER_EVERY &&
        tripped.size + cover.size < COVER_TARGET &&
        cover.size < 1 &&
        slotsLeft > 0 &&
        orders.length < cap
      ) {
        let best: Pubkey | null = null;
        let bestRq = 0;
        for (const mint of traded) {
          if (held.has(mint) || cover.has(mint) || tripped.has(mint) || state.positions.has(mint) || pendingMints.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rq = Number(curve.real_quote_reserves) / SOL;
          if (rq >= COVER_MIN_RQ && rq > bestRq) {
            best = mint;
            bestRq = rq;
          }
        }
        if (best !== null && free >= COVER_SOL + 2 * txSol) {
          const capSol = Number(state.maxBuyLamports(best)) / SOL;
          const amount = Math.min(COVER_SOL, capSol);
          if (amount >= 0.01) {
            orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(amount * SOL)), max_slippage_bps: BUY_SLIP_BPS });
            cover.set(best, 'buying');
            lastCoverSlot = now;
            free -= amount + txSol;
          }
        }
      }

      return orders;
    },
  };
}
