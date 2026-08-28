import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScreeningResolution, Stage } from "./types";

/** Key for a resolution map: one entry per record and stage. */
export function resKey(stage: Stage | string, recordId: string): string {
  return `${stage}:${recordId}`;
}

/**
 * All conflict resolutions for a project, keyed by stage:record_id.
 * Returns an empty map on projects that have not run migration 0017
 * yet (the table does not exist there), so callers can treat the
 * resolution map as always present.
 */
export async function fetchResolutions(
  supabase: SupabaseClient,
  projectId: string
): Promise<Map<string, ScreeningResolution>> {
  const map = new Map<string, ScreeningResolution>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("screening_resolutions")
      .select("*")
      .eq("project_id", projectId)
      .range(from, from + 999);
    if (error) return map;
    (data ?? []).forEach((r) => {
      const row = r as ScreeningResolution;
      map.set(resKey(row.stage, row.record_id), row);
    });
    if (!data || data.length < 1000) break;
  }
  return map;
}
