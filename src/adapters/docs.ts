/**
 * The adapter authoring guide, served from the API.
 *
 * Everything an author needs to write an adapter used to live in `plan/`, which
 * a person building an agent outside this repo cannot read. The same structure
 * feeds the console's adapter docs panel, so the browser and the API never
 * describe two different contracts.
 */

import { MODEL_STAGES } from "../config/model-config.js";
import { credentialContractDoc, HARNESS_CREDENTIALS } from "./credential-contract.js";

export interface DocSection {
  id: string;
  title: string;
  /** Paragraphs of prose. */
  body: string[];
  /** Optional labelled code sample. */
  code?: { language: string; label: string; source: string };
  /** Optional term/definition rows the UI renders as a table. */
  fields?: { name: string; required?: boolean; description: string }[];
}

const TEMPLATE_PLACEHOLDERS: DocSection["fields"] = [
  { name: "{{prompt}}", description: "The eval task prompt." },
  { name: "{{model}}", description: "Model id for this queue." },
  { name: "{{provider}}", description: "Provider id for this queue. Also selects the credentialEnv bucket." },
  { name: "{{workspace}}", description: "Always /workspace, the writable task directory inside the container." },
  { name: "{{run_id}}", description: "Id of the current run." },
  { name: "{{project_id}}", description: "Id of the owning project." },
  { name: "{{credential:NAME}}", description: "Value of harness credential NAME. Renders empty when the platform has no such credential, so prefer credentialEnv, which is checked at write time." },
  { name: "{{param:a.b}}", description: "Dotted lookup into the queue's params object." },
  { name: "{{override_env:NAME}}", description: "Value of the project's adapter env override NAME." },
];

const ADAPTER_FIELDS: DocSection["fields"] = [
  { name: "agent_id", required: true, description: "Stable id for your agent. Letters, numbers, dot, underscore, dash." },
  { name: "name", required: true, description: "Display name." },
  { name: "image", required: true, description: "Container image tag the platform builds and runs." },
  { name: "containerfile", required: true, description: "How to build that image. Install your CLI and put it on PATH." },
  { name: "install_type", required: true, description: "source-build, npm, or binary." },
  { name: "command", required: true, description: "{argv, env?, cwd?, timeout_ms?}. argv entries go through template rendering." },
  { name: "connection_check", description: "A cheap probe command. Set derive_connection_check: true to reuse `command` with a fixed probe prompt instead." },
  { name: "provider_config", description: "Holds credentialEnv. See the credentials section." },
  { name: "parser_kind", required: true, description: "canonical-jsonl, pi-jsonl, or reapercode-jsonl. Determines how the platform reads your agent's stdout." },
  { name: "evidence", required: true, description: "{paths, required_paths?, manifest?}. Workspace paths retained after the run, and the role-typed manifest that Phase 1 reads." },
  { name: "source_repo", description: "Required for source-build; optional for npm." },
  { name: "default_provider", description: "Provider id used when a queue names none." },
  { name: "default_model", description: "Model id used when a queue names none." },
];

const EVIDENCE_ROLES: DocSection["fields"] = [
  { name: "trace", description: "The canonical event stream. Mark one entry primary: true." },
  { name: "tool_calls", description: "Per-tool-call records." },
  { name: "logs", description: "Free-form agent logs." },
  { name: "model_calls", description: "Raw provider request/response records." },
  { name: "transcript", description: "Human-readable conversation." },
  { name: "session", description: "Session state your CLI writes." },
  { name: "result", description: "Final answer or result artifact." },
  { name: "tmp", description: "Scratch output worth keeping for debugging." },
  { name: "other", description: "Anything else." },
];

/** The full authoring guide: sections, the credential contract, and the readiness rules. */
export function adapterDocs(): Record<string, unknown> {
  return {
    version: 1,
    title: "Writing an adapter for your agent",
    summary:
      "An adapter tells the platform how to build your agent's image, launch its CLI for one eval, " +
      "which environment variables carry the model credentials, and which files to keep as evidence. " +
      "Every project needs one before it can run evals.",
    sections: docSections(),
    credential_contract: credentialContractDoc(),
    template_placeholders: TEMPLATE_PLACEHOLDERS,
    adapter_fields: ADAPTER_FIELDS,
    evidence_roles: EVIDENCE_ROLES,
    model_stages: MODEL_STAGES,
    readiness: readinessDoc(),
  };
}

/** Why a project may not be allowed to start runs yet. */
export function readinessDoc(): Record<string, unknown> {
  return {
    order: ["adapter", "evals", "run", "phase1", "phase2"],
    requirements: [
      {
        step: "adapter",
        rule: "The project must have one enabled agent adapter with a built image.",
        blocks: ["run", "phase1", "phase2"],
      },
      {
        step: "evals",
        rule: "The project must have at least `min_evals` enabled eval queue items. Default is 1; set project.min_evals higher when Phase 2 needs a wider sample.",
        blocks: ["run", "phase1", "phase2"],
      },
      {
        step: "phase1",
        rule: "Phase 1 judges one sealed eval archive, so at least one eval run must have completed and sealed.",
        blocks: ["phase2"],
      },
      {
        step: "phase2",
        rule: "Phase 2 looks for systemic patterns across a campaign, so every Phase-1 result in the generation must be published first.",
        blocks: [],
      },
    ],
  };
}

function docSections(): DocSection[] {
  return [
    {
      id: "overview",
      title: "What an adapter is",
      body: [
        "The platform runs your agent as a real CLI process inside a Podman container, one eval at a time. " +
          "The adapter is the description of that: an image to build, a command to run, credentials to pass, " +
          "and files to collect afterward.",
        "You never write TypeScript. You POST a JSON document, or a generator script that prints one.",
      ],
    },
    {
      id: "two-paths",
      title: "Two ways to supply one",
      body: [
        "Write the adapter JSON directly and POST it to /api/projects/:id/adapters.",
        "Or supply a `generator`: a bash or Node script the platform runs against a clone of your agent's " +
          "source, which prints the same JSON on stdout. Use a generator when the correct command or entry " +
          "point depends on the repo you are testing, since it re-derives them on every rebuild.",
        "pi and ReaperCode also ship as built-ins (`builtin_adapter_id: \"pi\"` or `\"reapercode\"`). " +
          "They have no credentialEnv block: they read the eval stage's OPENAI_* or ANTHROPIC_* pair " +
          "directly, the same values Phase 1 and Phase 2 resolve from their own stages.",
      ],
    },
    {
      id: "credentials",
      title: "Model credentials",
      body: [
        "Your CLI reads its key from whatever environment variable it was built to read. The platform does " +
          "not know that name, and you do not know which credential the operator configured. `credentialEnv` " +
          "is where the two meet: you name your variable, and you name the harness credential that should " +
          "fill it.",
        "Values are never stored. The project config stores the variable name, and the value is read from the " +
          "server environment at the moment the container starts.",
        "Map a stage-managed name and your adapter follows the project's eval stage config automatically. " +
          "Change the endpoint or model in the console, and the next run picks it up with no adapter edit.",
        "A source name the platform cannot supply is rejected when you create or update the adapter, " +
          "rather than silently producing an unset variable.",
      ],
      code: {
        language: "json",
        label: "provider_config",
        source: JSON.stringify(
          {
            credentialEnv: {
              default: { MY_AGENT_API_KEY: "OPENAI_API_KEY", MY_AGENT_BASE_URL: "OPENAI_BASE_URL" },
              anthropic: { MY_AGENT_API_KEY: "ANTHROPIC_API_KEY" },
            },
          },
          null,
          2,
        ),
      },
      fields: HARNESS_CREDENTIALS.map((c) => ({
        name: c.name,
        description: c.stageManaged
          ? `${c.description} Filled from the project's eval stage config.`
          : `${c.description} Passed through from the server environment only.`,
      })),
    },
    {
      id: "provider-buckets",
      title: "Provider buckets",
      body: [
        "The bucket named by the queue's provider wins when it exists; otherwise `default` applies. " +
          "Buckets do not merge, so a provider bucket must list every variable your CLI needs, " +
          "including the ones `default` already covers.",
        "Provider ids match exactly, including case.",
      ],
    },
    {
      id: "command",
      title: "The command",
      body: [
        "`command.argv` launches one eval. Each entry is rendered against the run context, so " +
          "placeholders like {{prompt}} and {{model}} become real values.",
        "`command.env` sets fixed variables. It is merged before credentialEnv, and the project's own " +
          "adapter env overrides are applied last and win over both.",
        "An unknown placeholder is an error at render time, not an empty string, so a typo fails loudly. " +
          "The one exception is {{credential:NAME}}, which renders empty for an unknown name.",
      ],
      code: {
        language: "json",
        label: "command",
        source: JSON.stringify(
          {
            command: {
              argv: [
                "my-agent",
                "run",
                "--jsonl",
                "--model",
                "{{model}}",
                "--prompt",
                "{{prompt}}",
              ],
              cwd: "/workspace",
              timeout_ms: 600000,
            },
            derive_connection_check: true,
          },
          null,
          2,
        ),
      },
    },
    {
      id: "output",
      title: "What your agent must print",
      body: [
        "`parser_kind` tells the platform how to read stdout. `canonical-jsonl` means your CLI prints one " +
          "canonical event per line. `pi-jsonl` and `reapercode-jsonl` cover those two agents' native formats.",
        "The canonical trace must faithfully reflect what your agent actually did. Phase 1 judges process, " +
          "not just the final reward, and a thin or invented trace produces a thin judgement.",
      ],
    },
    {
      id: "evidence",
      title: "Evidence",
      body: [
        "`evidence.paths` are the workspace paths retained when the run seals. `required_paths` fail the run " +
          "when missing, which is how you catch an agent that produced no trace at all.",
        "`evidence.manifest` gives each artifact a role, so the judge can find your trace without guessing " +
          "at file names. Mark exactly one entry `primary: true`.",
      ],
      code: {
        language: "json",
        label: "evidence",
        source: JSON.stringify(
          {
            evidence: {
              paths: [".agent-runs", ".agent-logs"],
              required_paths: [".agent-runs"],
              manifest: [
                {
                  id: "trace",
                  role: "trace",
                  path: ".agent-runs/*.jsonl",
                  format: "jsonl",
                  primary: true,
                  select: "latest_mtime",
                },
                { id: "logs", role: "logs", path: ".agent-logs", format: "dir", select: "all" },
              ],
            },
          },
          null,
          2,
        ),
      },
    },
    {
      id: "validate",
      title: "Check it before you run",
      body: [
        "POST /api/projects/:id/adapters/:adapterId/validate renders the command, connection check, " +
          "configure step, image, and evidence config against a sample run context, with credential values " +
          "redacted. Nothing executes.",
        "The sample context uses the project's real provider and its resolved eval stage config, so the " +
          "variables shown are the ones a real run sets.",
      ],
    },
    {
      id: "rules",
      title: "Rules the platform enforces",
      body: [
        "Credentials go into the agent process environment only. They are never baked into an image.",
        "The eval's protected solution, tests, and validation never enter the agent container.",
        "The verifier owns the reward. Nothing your agent prints changes it.",
      ],
    },
  ];
}
