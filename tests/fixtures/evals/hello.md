---
name: Hello world
prompt: Write a hello world program that prints "Hello, world!" to stdout.
workspace:
  source: git
  repo: example/hello
  ref: main
agentCategory: coding
profile: feature
tags:
  - smoke
  - beginner
checks:
  - id: tests
    kind: test_suite
    command: npm test
rubric:
  profile: feature
  version: 1
  criteria:
    - id: A1
      axis: A
      label: Goal completion
      weight: 1
      critical: true
      appliesTo: both
      checkId: tests
      anchors:
        full: Program prints Hello, world! exactly and exits 0.
        partial: Prints a greeting but wrong text or extra noise.
        none: Does not print a greeting or fails to run.
---

# Hello world

Additional notes for the agent (body is ignored when frontmatter.prompt is set).
