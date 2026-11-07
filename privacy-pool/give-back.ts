/** For the smoke tests: send what a test wallet has left back to the funder, so runs don't strand the
 * funder's ETH in throwaway wallets (their notes are never saved). */
import * as core from "./core.ts";

/** Withdraws each state's spendable notes to the funder, two at a time, leaving room for the fee. */
export async function giveBack(rpc: core.Rpc, cfg: core.Config, states: core.State[], prover: core.Prover): Promise<void> {
  const funder = core.addressOf(cfg.funderKey);
  const room = 6n * 10n ** 15n; // the fee is about 0.003-0.004 ETH
  let total = 0n;
  for (const state of states) {
    for (let round = 0; round < 4; round++) {
      try {
        await core.sync(rpc, cfg, state);
        const notes = core.spendable(state).map((n) => BigInt(n.value)).sort((x, y) => (y > x ? 1 : -1)).slice(0, 2);
        const amount = notes.reduce((x, y) => x + y, 0n) - room;
        if (amount < 2n * 10n ** 15n) break;
        await core.withdraw({ rpc, cfg, state, amount, recipient: funder, prover });
        total += amount;
      } catch (e) {
        console.log(`   (giving back stopped: ${String((e as Error).message).slice(0, 100)})`);
        break;
      }
    }
  }
  console.log(`gave ${core.eth(total)} ETH back to the funder ${funder}`);
}
