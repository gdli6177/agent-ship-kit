# Crewvane state protocol

Read this file only when the current agent is acting as a registered Crewvane owner or the global concierge. Every state command requires a real event; natural language alone never proves approval, acceptance, completion, or a passed check.

## Progress and waiting

```sh
crewvane goal progress "$GOAL_ID" --summary "$ACTUAL_RESULT" --next "$NEXT_STEP" --root "$WORKSPACE"
crewvane goal wait "$GOAL_ID" --reason "$WAITING_REASON" --owner "$WAITING_OWNER" --remind-at "$ISO_TIME" --root "$WORKSPACE"
```

Use `progress` after an observable result, not as a heartbeat. Use `wait` only while a named person, service, or event is actually blocking work. When no substantive progress exists, report the blocker instead of manufacturing an update.

## Decisions and high-risk actions

```sh
crewvane goal decide "$GOAL_ID" --question "$SPECIFIC_QUESTION" --next "$PLANNED_NEXT_STEP" --root "$WORKSPACE"
crewvane goal risk "$GOAL_ID" --category "$CATEGORY" --summary "$PROPOSED_ACTION" --root "$WORKSPACE"
```

Use `decide` for a concrete choice Crewvane cannot resolve. Use `risk` before deleting data, stopping a service, spending money, sending an external message, changing product direction, creating or rotating a secret, changing permissions, or changing shipping policy. High-risk work waits for the human even when a project policy is automatic.

## Delivery and shipping

```sh
crewvane goal review "$GOAL_ID" --summary "$DELIVERY_SUMMARY" \
  --location "$REAL_ARTIFACT_PATH" \
  --check "$CHECK_NAME::$ACTUAL_OPERATION::$RESULT::$OBSERVED_RESULT" \
  --root "$WORKSPACE"
crewvane goal ship "$GOAL_ID" --operation merge --checks passed --root "$WORKSPACE"
```

`goal review` needs at least one real check. A check result is `passed` or `failed`; include what was actually executed or inspected. `goal ship` asks the policy engine whether an external merge or deployment is allowed. It does not perform the merge or deployment.

## Herdr owner session

Register a real owner scene only after Herdr returned its identifiers:

```sh
crewvane session set "$GOAL_ID" --session "$HERDR_SESSION" \
  --workspace "$HERDR_WORKSPACE_ID" --tab "$HERDR_TAB_ID" \
  --pane "$HERDR_PANE_ID" --agent "$LIVE_AGENT_NAME" --root "$WORKSPACE"
```

For an unrecognized interactive CLI, verify its foreground PID and add:

```sh
--transport pane --process-id "$FOREGROUND_PID"
```

After the goal is completed or dropped, Crewvane releases the owner scene. Do not register the global concierge or another active goal's pane as the owner.

## Boundaries

- Use the current goal ID only. Do not infer ownership from similar titles.
- Do not accept a delivery, approve a decision, or close a goal for the human.
- Do not bypass a rejected CLI scope by editing state files directly.
- Do not retry an external effect without current authorization.
- Treat Crewvane's coordinator scope as a data API boundary, not an operating-system sandbox.
