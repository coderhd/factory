/**
 * SkillRouter seam (spec §31). Selects the skills (and the context presets they
 * imply) a Task's Attempt should run with. v0.1 ships the interface only — the
 * runtime does not yet select skills through it, and no behaviour is implied.
 */
export interface SkillSelection {
  skills: string[];
  /** Why these skills were selected (`null` when unknown — never fabricated). */
  reason: string | null;
}

export interface SkillRouter {
  select(input: { workOrderId: string; taskId: string; title: string }): Promise<SkillSelection>;
}
