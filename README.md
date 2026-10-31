# agent-ship-kit

agent-ship-kit is the acceptance-and-attention layer for parallel AI coding-agent delivery. A person talks to one captain from intake through ship. Workers are spawned on demand, one slice per frozen contract, and are not a standing roster. The kit sits on Herdr, Orca, Multica, or any other orchestrator through thin adapters, and it also works with no orchestrator at all. It does not schedule the fleet, does not merge to main, and does not deploy to production. The captain prepares a proposal, the human freezes the contract, workers return evidence, and the human accepts that evidence before anything ships.

Status: v0. Skills, templates, an event schema, adapter notes, and a local inbox / notify dry-run CLI.

## What you get

| Piece | Role |
| --- | --- |
| [skills/](skills/) | Captain procedures: contract, dispatch, review, notify |
| [templates/](templates/) | Proposal, contract, review packet, notify policy, allowlist, e2e conventions |
| [adapters/](adapters/) | `spawn` / `status` / `collect` plus Herdr, Orca, and Multica notes |
| [events/schema.json](events/schema.json) | `needs_review` and the related lifecycle events |
| [cli/](cli/) | `inbox add`, `inbox list`, `notify dry-run` |

The product definition in Chinese is [docs/PRODUCT.md](docs/PRODUCT.md). Event, adapter, and notify behavior is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

Clone the repo and copy the four skills into the captain agent's skill directory. On Cursor that directory is `~/.cursor/skills`:

```bash
git clone https://github.com/gdli6177/agent-ship-kit.git
cd agent-ship-kit
mkdir -p ~/.cursor/skills
cp -R skills/ship-contract skills/ship-dispatch skills/ship-review skills/ship-notify ~/.cursor/skills/
```

For another agent, copy those same four directories into that agent's skill path. Each directory contains a `SKILL.md`. The CLI is optional and stays in this repo; it is not installed into the skill directory.

```bash
cd cli
npm install
```

Node 20 or newer. No API keys.

## Quickstart without Multica

No orchestrator account, no `multica` binary, no webhook. The inbox is a JSONL file. The notify command prints a plan and does not run it.

```bash
cd cli
npm install
npm run agent-ship -- inbox add --root .. \
  --title "Auth middleware ready" \
  --summary "Contract checks passed on the slice branch." \
  --priority high \
  --source-task-id task_auth_mw \
  --evidence https://ci.example/runs/1001 \
  --pr https://example.com/pull/12 \
  --path .agent-ship/packets/task_auth_mw.md

npm run agent-ship -- inbox list --root ..

npm run agent-ship -- notify dry-run --root .. --latest \
  --policy ../templates/notify.policy.example.md \
  --allowlist ../templates/notify.allowlist.example.json
```

Expect a `needs_review` event, then a plan whose `matched_rule` is `high priority page`, `allow` is true, and `executed` is false. That last field is the point: a matching allowlist entry is not a shell-out, and it is not a merge.

To do the same loop with a captain and no CLI, follow [templates/e2e-conventions.md](templates/e2e-conventions.md) and [adapters/generic.md](adapters/generic.md). `spawn` is one fresh agent session per frozen slice. The human stays in the captain thread.

## Tests

```bash
cd cli
npm test
npm run typecheck
```

## Layout

```text
README.md
LICENSE
docs/PRODUCT.md
docs/ARCHITECTURE.md
skills/ship-contract/SKILL.md
skills/ship-dispatch/SKILL.md
skills/ship-review/SKILL.md
skills/ship-notify/SKILL.md
templates/proposal-card.md
templates/contract-card.md
templates/review-packet.md
templates/notify.policy.example.md
templates/notify.allowlist.example.json
templates/e2e-conventions.md
adapters/README.md
adapters/generic.md
adapters/herdr.md
adapters/orca.md
adapters/multica.md
events/schema.json
cli/package.json
cli/README.md
cli/src/cli.ts
cli/src/inbox.ts
cli/src/notify.ts
cli/src/types.ts
cli/test/
.agent-ship/.gitkeep
```

## 中文

agent-ship-kit 是并行 AI 编程交付的验收与注意力层。人从进需求到交付只和一位船长说话；工人不预先组队，而是在合同冻结后按切片按需生成。它可以接在 Herdr、Orca、Multica 或任何编排器之上，也可以不接编排器。它不是编排器，不会自动合并到 main，也不会部署到生产。船长负责把方案收成卡片，人冻结合同、审证据、决定是否接受；真正的合并和发布仍由人自己完成。

安装：克隆本仓库，把 `skills/` 下的 `ship-contract`、`ship-dispatch`、`ship-review`、`ship-notify` 四个目录拷进船长代理的 skill 目录（Cursor 为 `~/.cursor/skills`）。不依赖 Multica 的最短路径是上面的 Quickstart：本地收件箱加一条待审，再对示例策略做 `notify dry-run`。产品边界和使用场景见 [docs/PRODUCT.md](docs/PRODUCT.md)，事件与通知规则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## License

[MIT](LICENSE)
