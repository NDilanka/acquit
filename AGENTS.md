# Personal preferences

## Suggest a fresh chat at the right moment

I use my main chat as an orchestrator. Every request in it re-sends the whole context. A warm prompt cache makes that cheap, but the cache likely expires after about five idle minutes, and the next request then pays full price for all of it. Each compaction is a lossy summary that can drop rules and directives. A fresh chat pays once to rebuild from the handoff note and then runs on a small context. Proactively tell me when to move to a fresh chat, and hand me a prompt to start it. Pick the moment that saves the most and leaves the work safely parked.

Check at every boundary. A boundary is a closed round, a gate or verdict, a landing, a finished phase, a reviewed subagent report, a loop tick, or a pause for my input. When the project keeps a resume file, bring it up to date at each boundary, so parking later costs one short step.

**Never suggest while any of these hold.**

- A subagent this chat spawned is still running. Its report comes back to this chat only.
- A change is half-made or untested.
- We are mid-discussion on a decision I have not settled.
- The current unit finishes in a few more turns. Finish it here, then check again.

**Suggest only when the chat is heavy and the moment is cheap.** Both must hold.

The chat is heavy only when its current context is past half the window, or past 200K tokens when you do not know the window. Use the usage figure when the harness or I give one. When you cannot see it, estimate the context since the last compaction: the summary plus the turns after it. Count large file reads and long tool outputs, not the number of calls.

Nothing else makes a chat heavy. A compaction does not make it heavy, because it shrinks the context to a summary. Continuing right after one costs about what a fresh pickup costs, and the fresh pickup adds a lossy step of its own, the handoff note. The number of tasks or units the chat has run does not count either. A chat at 100K tokens with a warm cache is cheaper to continue than to rebuild, because a fresh pickup rereads the handoff note, the standing rules, and the skills at full price, often 30K to 40K tokens.

The moment is cheap when at least one of these holds:

- The next unit is large and independent, such as a new phase, feature, round, or fan-out wave. Suggest before you launch it, so its work and its reports land in the new chat.
- The work already waits on me, such as a STACK-READY handoff, a review click, or a question only I can answer. I am reading anyway, and the question moves to the new chat through the note.
- The cache is already cold after an idle gap, such as an hourly loop tick, or the next step is a long wait on me or on something this chat does not own.

When the chat is heavy and you are unsure about the moment, compare the work left before the next boundary with the cost of a fresh pickup. Stay for a tail of a few tool calls. Switch for anything that fans out or runs for many turns.

Quality slip overrides both tests. A slip is evidence, not a count. It means you notice a lost rule, a contradicted directive, a fact you got wrong that you had already established, or a re-read forced because you forgot what you already read. A second compaction also counts, because two lossy summaries in a row compound. When a slip occurs, suggest at the first boundary with no blocker. One compaction with no slip is not a reason to suggest. After a compaction, check the summary against the standing rules and the handoff note before you act. Restore anything it dropped, and carry on.

If I said keep going or I am away, never stall the work to suggest. Keep going and suggest at the next point where the work waits on me.

**When you suggest.**

1. Park the work. Start nothing new. Stop the processes this chat owns, such as dev servers, watchers, and browsers, or record each PID and log path in the note. Commit and push finished work per the project's rules. Record any uncommitted change and why it stays.
2. Write or update the durable handoff note. Use the project's resume file if one exists (for example `data/trail/resume.md`), or else create `HANDOFF.md` at the repo root and tell me where it is. It must carry everything a fresh orchestrator needs. That means the current state, branches and SHAs, in-flight work and outside waits, next steps in order, hard rules and standing directives, open questions for me, and the loop to re-arm with its exact cron and prompt. Move any decision or directive that lives only in this chat into the note or the project's decision log. Never include secrets. Say where a secret lives instead.
3. Cancel this chat's loop, because only this chat can cancel it. Put the cancelled loop id in the note and in the reply.
4. Name what does not carry over to a new chat. That means loops, background subagents, active skills and modes, shell state such as environment variables and the working directory, and the todo list.
5. Log the suggestion in the project's decision log if one exists.
6. End your reply with a copy-paste handoff prompt in a code block. The prompt names the repo path, the handoff note to read first, the skills or modes to load, the loop to arm, the first action, and the hard rules that must never lapse.

Suggest once per boundary. If I decline, or I reply here instead of moving, re-arm the loop at once and carry on. Do not raise it again until the next boundary.
