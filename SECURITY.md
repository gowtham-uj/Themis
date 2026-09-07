# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's **Security** tab to submit a private vulnerability report. Include the affected version or commit, the smallest reproduction you can provide, and the impact you observed. Do not include real API keys, customer archives, or private source code.

If private vulnerability reporting is not enabled on the repository, contact the maintainers through a private channel before sharing technical details.

## Security boundaries

Themis runs untrusted agent code. Its main boundaries are deliberate:

- The evaluated agent runs in a Podman container.
- Hidden tests, reference solutions, validation material, and verifier code never enter the agent container.
- The verifier runs separately and owns the official reward.
- Model and search credentials come from environment variables. The API and project settings store variable names, not secret values.
- The API binds to loopback by default. A non-loopback bind requires authentication or the explicit `AGENTEVAL_ALLOW_UNAUTH_NETWORK=1` acknowledgement.
- The judge reads evidence through mediated tools. Web pages can support recommendations, but cannot establish facts about the evaluated agent.
- Archive file paths are normalized and confined to their archive root.

## Supported versions

The project is pre-1.0. Security fixes target the current `main` branch. Once tagged releases begin, this section will list the maintained release lines.

## Operator responsibilities

- Run the API with `AGENTEVAL_AUTH=1` before exposing it outside a trusted local machine.
- Keep provider keys in the process environment or a deployment secret manager.
- Rotate a credential if it appears in an agent trace, archive, issue, or log.
- Review container network policy, mounts, devices, and capabilities before enabling third-party adapters.
- Keep Podman, Node.js, and system packages patched.
