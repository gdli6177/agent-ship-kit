# Eval notify policy

The empty-evidence rule matches a high review with no URLs.
The evidence gate must still refuse to page it.

## Rule: high priority page

when.type: needs_review
when.priority: high
when.evidence_urls: nonempty
action: echo page-with-evidence
note: Page when evidence exists.

## Rule: high without proof

when.type: needs_review
when.priority: high
when.evidence_urls: empty
action: echo page-anyway
note: Would page an empty review. The evidence gate must refuse it.
