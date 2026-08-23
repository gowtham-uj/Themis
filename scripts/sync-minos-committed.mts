/**
 * Regenerate each fixture's `minos_committed` block from its good report.yaml.
 *
 * b-verbatim-assembly compares every verdict, score and prose string in the
 * report against the strings minos committed. Hand-editing a report without
 * mirroring the change here makes the rule fire on a fixture that is otherwise
 * correct, so this derivation is mechanical and rerunnable rather than a
 * one-time generation.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = 'tests/fixtures/judge-quality';

/** Directories holding a `report.yaml` + `archive-facts.json` pair to sync. */
function caseDirs(): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Probes and adversarial attacks both nest one level deeper:
    // <corpus>/tier-x/<case>/. Attacks need the same derivation as fixtures —
    // an attack whose facts lack `minos_committed` crashes the tier-B checker
    // before its payload is ever evaluated, which reads as "no violation".
    if (entry.name === 'probes' || entry.name === 'adversarial') {
      const probeRoot = join(root, entry.name);
      for (const tier of readdirSync(probeRoot, { withFileTypes: true })) {
        if (!tier.isDirectory()) continue;
        for (const rule of readdirSync(join(probeRoot, tier.name), { withFileTypes: true })) {
          if (rule.isDirectory()) dirs.push(join(probeRoot, tier.name, rule.name));
        }
      }
      continue;
    }
    dirs.push(join(root, entry.name));
  }
  return dirs;
}

for (const dir of caseDirs()) {
  const factsPath = join(dir, 'archive-facts.json');
  // Tier A probes are pure grammar defects and carry no archive to sync.
  if (!existsSync(factsPath)) continue;
  const rep = parse(readFileSync(join(dir, 'report.yaml'), 'utf8')) as any;

  const prose: string[] = [];
  const push = (s: unknown) => {
    if (typeof s === 'string' && !prose.includes(s)) prose.push(s);
  };

  push(rep.narrative);
  push(rep.reward_reconciliation);
  push(rep.confidence_basis);
  for (const s of rep.what_the_agent_did_well ?? []) push(s.observation);
  for (const i of rep.improvements ?? []) {
    push(i.issue);
    push(i.recommendation);
  }
  for (const f of rep.integrity_summary?.findings ?? []) push(f.finding);
  for (const q of rep.open_questions ?? []) {
    push(q.question);
    push(q.what_would_settle_it);
  }
  for (const r of rep.revision_history ?? []) push(r.why);

  const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
  facts.minos_committed = {
    approach_verdicts: [rep.verdict.approach],
    integrity_verdicts: [...new Set([rep.verdict.integrity, rep.integrity_summary?.verdict])].filter(
      (x) => typeof x === 'string',
    ),
    competence_scores: [rep.verdict.competence],
    reconciliation_verdicts: [rep.verdict.reconciliation],
    prose,
  };

  // Keep ref_conventions last so the file stays readable.
  const conventions = facts.ref_conventions;
  delete facts.ref_conventions;
  facts.ref_conventions = conventions;

  writeFileSync(factsPath, `${JSON.stringify(facts, null, 2)}\n`);
  console.log(`${dir}: ${prose.length} prose strings`);
}
