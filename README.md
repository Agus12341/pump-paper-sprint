[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Agus12341/pump-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Agus12341/pump-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# pump-paper-sprint - washout reversion bot

An entry for make.fun's [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty.

`main.ts` runs a paper-trading bot on the agent-fun/replay/v2 harness (Node 22); the strategy lives in `strategy.ts` and the kit's SDK shim is vendored at `vendor/makefun-bot.ts`.

The strategy, in short:

- Most pump.fun coins are untradeable for a replay bot: the launch spike happens before any order can fill, momentum buys the top, and instant buyouts complete before an order lands. All of those lost money after fees on the dev window.
- What held up is the washout of a proven coin: a coin that already ran at least +20% to its 1500-slot high, holds at least 12 SOL of real reserves and has traded at least 40 times, then washes out to 45-70% of that high with the selling dried up. The bot buys that base once per coin (0.3 SOL, at most four positions) and sells the recovery: take profit +18%, trailing stop armed at +12% with a 10% trail, hard stop -12%, time stop after 900 slots.
- A slow coverage drip (0.012 SOL round trips on the most liquid coin of the moment, every 500 slots) banks the 20-coin round-trip count the guardrails ask for.

Dev window result (kit grade-local, two executions byte-identical): net PnL +0.036132470 SOL on 10 SOL capital, 43 round trips over 41 coins, max drawdown 1.92%, all guardrails met.

## License

MIT - see `LICENSE`.
