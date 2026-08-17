# Agent categories

A task declares an `agentCategory` that controls execution and evidence behavior.

Built-in categories include coding/git-oriented tasks, output-producing data tasks, browser/computer-use
tasks, research tasks, and conversational tasks.

Category behavior determines:

- Whether source diff capture applies.
- Whether generated-output manifest capture applies.
- Which deterministic checks are expected.
- Which workspace and evidence fields are relevant.
- Which retained native evidence paths should be collected.

Categories do not invoke judging. They shape the runner, verifier, metrics, and archive evidence contract.
