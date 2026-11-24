// Entry point for the pump.fun paper sprint: the grader runs `node /bot/main.ts`.
// The strategy lives in strategy.ts; the wire protocol lives in the vendored SDK shim.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

await runBot(createBot());
