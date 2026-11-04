# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them here.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Goal Detail Prototype Decisions

- Crewvane is a desktop application. This design intentionally has no phone-specific layout.
- The "goal panel" means the modal opened from an Attention or All Goals item. Both entries open the same detail surface.
- Agent output is treated as opaque, non-structured content: plain text, Markdown, excerpts, and attachments. Do not require the Agent to fill fixed factual, option, recommendation, or evidence fields.
- Keep content, status, and actions decoupled.
- Render the latest concierge/Agent message in a single readable column with preserved paragraphs and line breaks. Do not parse its prose into UI controls.
- Crewvane owns the small status set: Waiting for you, Waiting externally, Ready for review, Needs troubleshooting, In progress, Handed off, and Ended.
- The action dock is selected only by status. It must never infer approval, acceptance, or a chosen option from message wording or the user's free-form reply.
- Reply sends the exact text and optional attachments to the global concierge. A reply does not change target status by itself.
- Review exposes explicit Accept and Return commands. Return requires free-form reasoning, not a form schema.
- Waiting externally shows that no action is required and offers a secondary way to report a new update.
- Troubleshooting exposes Open Workspace as the primary action because the responsible Agent cannot continue in the current environment.
- The human talks only to the global concierge. Opening the Herdr scene is a secondary troubleshooting or takeover path, not a normal chat with an execution Agent.
- Human-to-concierge questions and answers are part of the target's message history when they are written through Crewvane, CLI, or the Herdr plugin with the same `goalId`. Both entry points open that one history; messages from other goals must never leak into it.
- Reading a target never removes it from Attention. Only an explicit state update can do that.
- History is collapsed by default. Keep the current message and actionable context in the first reading surface.
- Keep the pixel-magician identity, dark and light themes, modern readable body typography, and restrained violet/mint/amber/rose state colors.

## Prototype Shape

This is one converged design rather than an A/B/C selector. The answer being validated is:

> Can a target detail remain useful when Agent content is arbitrary, while status-driven commands preserve clear control and reduce the user's context switching?

The prototype uses in-memory synthetic data. It is not production code and does not persist results.
