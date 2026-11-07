/**
 * The pause between proving and sending, as in the send window: the transaction is proven and
 * signed but not sent. Its frames show right away, each ticked by the dry run (tap one to inspect
 * it, All fields for the rest). Send sends it; Cancel drops it, and nothing was spent.
 */
import type { Inspection } from "../../core.ts";
import { el, html, icon, shown } from "./ui.ts";
import { frameMap, txOverview } from "./frames.js";

export function reviewStep(box: HTMLElement, v: Inspection, o: { pool: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const head = el("div", "review-head");
    head.append(html(`<span class="review-mark">${icon("shield", 26)}</span>`),
      (() => { const g = el("div", "grow"); g.append(el("h2", "", "Ready to send"), el("p", "muted small", `Up to ${shown(v.fee, 6)} ETH of gas, from private funds. Nothing is sent yet.`)); return g; })());
    const all = el("details", "card pad all-fields");
    all.append(el("summary", "", "All fields"), txOverview(v.tx, null, { pool: o.pool, unsent: true }));
    const map = frameMap(v.tx.frames, v.frames, { sender: v.tx.sender, pool: o.pool, tx: v.tx, unsent: true, summary: false });
    const foot = el("div", "review-foot");
    const cancel = el("button", "btn secondary", "Cancel") as HTMLButtonElement;
    cancel.id = "inspect-cancel";
    const submit = el("button", "btn primary", "Send") as HTMLButtonElement;
    submit.id = "inspect-submit";
    foot.append(cancel, submit);
    const done = (ok: boolean) => { box.hidden = true; box.replaceChildren(); resolve(ok); };
    cancel.onclick = () => done(false);
    submit.onclick = () => done(true);
    box.replaceChildren(head, map, all, foot);
    box.hidden = false;
    submit.focus();
  });
}
