"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { kbd } from "@/lib/ui";
import { requiredFor, settledOutcome, outcomeOf } from "@/lib/outcomes";
import PrescreenPanel from "@/components/project/PrescreenPanel";
import { fetchResolutions, resKey } from "@/lib/resolutions";
import { cleanQuote } from "@/lib/concepts";
import {
  fulltextPathFor,
  signedFulltextUrl,
  uploadFulltext,
} from "@/lib/fulltext";
import type {
  Decision,
  ExclusionReason,
  InclusionCode,
  Project,
  RecordRow,
  ScreeningResolution,
  Stage,
} from "@/lib/types";

const QUEUE_PAGE = 500;

/**
 * Effective hotkey per exclusion reason: a stored custom key wins;
 * reasons without one pick up the free digits 1-9 in list order.
 */
function reasonKeyMap(reasons: ExclusionReason[]): Map<string, string> {
  const claimed = new Set(
    reasons.map((r) => r.hotkey || "").filter(Boolean)
  );
  const map = new Map<string, string>();
  let d = 1;
  for (const r of reasons) {
    if (r.hotkey) {
      map.set(r.id, r.hotkey);
      continue;
    }
    while (d <= 9 && claimed.has(String(d))) d++;
    if (d <= 9) {
      map.set(r.id, String(d));
      claimed.add(String(d));
      d++;
    } else {
      map.set(r.id, "");
    }
  }
  return map;
}

/** Undecided records in the unassigned pool, counted without paging limits. */
async function remainingPoolCount(projectId: string, decided: Set<string>) {
  const supabase = createClient();
  let remaining = 0;
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from("records")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "active")
      .is("assigned_to", null)
      .range(from, from + 999);
    (data ?? []).forEach((r) => {
      if (!decided.has(r.id)) remaining++;
    });
    if (!data || data.length < 1000) break;
  }
  return remaining;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How many records assigned to this user remain undecided at this stage. */
async function remainingAssignedCount(
  projectId: string,
  uid: string,
  decided: Set<string>
) {
  const supabase = createClient();
  let remaining = 0;
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from("records")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "active")
      .eq("assigned_to", uid)
      .range(from, from + 999);
    (data ?? []).forEach((r) => {
      if (!decided.has(r.id)) remaining++;
    });
    if (!data || data.length < 1000) break;
  }
  return remaining;
}

function Highlighted({
  text,
  include,
  exclude,
}: {
  text: string;
  include: string[];
  exclude: string[];
}) {
  const parts = useMemo(() => {
    const terms = [
      ...include.filter(Boolean).map((t) => ({ t, kind: "inc" as const })),
      ...exclude.filter(Boolean).map((t) => ({ t, kind: "exc" as const })),
    ];
    if (terms.length === 0) return [{ text, kind: null as null | "inc" | "exc" }];
    const pattern = new RegExp(
      `(${terms.map((x) => escapeRegExp(x.t)).join("|")})`,
      "gi"
    );
    const incSet = new Set(include.map((t) => t.toLowerCase()));
    return text.split(pattern).map((seg) => {
      const lower = seg.toLowerCase();
      const isTerm = terms.some((x) => x.t.toLowerCase() === lower);
      if (!isTerm) return { text: seg, kind: null as null | "inc" | "exc" };
      return {
        text: seg,
        kind: incSet.has(lower) ? ("inc" as const) : ("exc" as const),
      };
    });
  }, [text, include, exclude]);

  return (
    <>
      {parts.map((p, i) =>
        p.kind === null ? (
          <span key={i}>{p.text}</span>
        ) : (
          <mark
            key={i}
            className={
              p.kind === "inc"
                ? "rounded bg-emerald-200 px-0.5 text-emerald-950 dark:bg-emerald-800 dark:text-emerald-50"
                : "rounded bg-red-200 px-0.5 text-red-950 dark:bg-red-800 dark:text-red-50"
            }
          >
            {p.text}
          </mark>
        )
      )}
    </>
  );
}

type EditConfirm = {
  reasonId: string;
  newLabel: string;
  affected: number;
};

export default function ScreenClient({
  project,
  userId,
  initialStage = "title_abstract",
}: {
  project: Project;
  userId: string;
  initialStage?: Stage;
}) {
  const [stage, setStage] = useState<Stage>(initialStage);
  const [queue, setQueue] = useState<RecordRow[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [reasons, setReasons] = useState<ExclusionReason[]>([]);
  const [mineTotal, setMineTotal] = useState(0);
  const [mineDone, setMineDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const undoStack = useRef<{ rec: RecordRow; at: number }[]>([]);
  // Review mode: walk through records already screened at this stage —
  // by anyone on the team, so a member who joins late can still go
  // through everything and add their own decisions.
  const [reviewing, setReviewing] = useState(false);
  const [myDecisions, setMyDecisions] = useState<
    Map<
      string,
      {
        decision: Decision;
        reason_id: string | null;
        inclusion_code_id: string | null;
      }
    >
  >(new Map());
  // record_id -> decided_by -> that member's decision at this stage.
  const [teamDecisions, setTeamDecisions] = useState<
    Map<
      string,
      Map<
        string,
        {
          decision: Decision;
          reason_id: string | null;
          inclusion_code_id: string | null;
        }
      >
    >
  >(new Map());
  // Active records with at least one decision at this stage (any
  // member); under independent screening, only REVEALED records count.
  const [teamScreened, setTeamScreened] = useState(0);
  // Conflict resolutions for the project, keyed stage:record_id.
  const [resolutions, setResolutions] = useState<
    Map<string, ScreeningResolution>
  >(new Map());
  const [resolveBusy, setResolveBusy] = useState(false);
  // Opinions this stage requires per record (1 = classic screening).
  const required = requiredFor(project, stage);
  const [memberNames, setMemberNames] = useState<Map<string, string>>(
    new Map()
  );
  // Inclusion codes (optional tags on include decisions)
  const [incCodes, setIncCodes] = useState<InclusionCode[]>([]);
  const [incCodesMissing, setIncCodesMissing] = useState(false);
  const [manageIncOpen, setManageIncOpen] = useState(false);
  const [newIncLabel, setNewIncLabel] = useState("");
  const [newIncKey, setNewIncKey] = useState("");
  const [editingIncId, setEditingIncId] = useState<string | null>(null);
  const [editingIncLabel, setEditingIncLabel] = useState("");
  const [editingIncKey, setEditingIncKey] = useState("");
  // Dialogs for reorganizing a used inclusion code
  const [incDelete, setIncDelete] = useState<{
    code: InclusionCode;
    affected: number;
  } | null>(null);
  const [incMigrateTarget, setIncMigrateTarget] = useState("");
  const [incEditConfirm, setIncEditConfirm] = useState<{
    code: InclusionCode;
    newLabel: string;
    newKey: string;
    affected: number;
  } | null>(null);

  // Full text PDF viewing and upload
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [showAbstract, setShowAbstract] = useState(false);
  // Pasting or fixing a record's abstract from the screening room
  const [pasteAbs, setPasteAbs] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [editingAbs, setEditingAbs] = useState(false);
  const [pdfExpanded, setPdfExpanded] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pdfFrameRef = useRef<HTMLIFrameElement | null>(null);

  // The embedded PDF viewer grabs keyboard focus while it initializes,
  // which silently swallows the screening hotkeys until the user clicks
  // outside it. Right after each load, take focus back (checked a few
  // times because the viewer focuses asynchronously). A deliberate
  // click into the PDF later is still respected.
  function reclaimFocusFromPdf() {
    [0, 120, 400].forEach((ms) =>
      window.setTimeout(() => {
        if (document.activeElement === pdfFrameRef.current) {
          pdfFrameRef.current?.blur();
        }
      }, ms)
    );
  }

  // Criteria panel
  const [criteriaOpen, setCriteriaOpen] = useState(true);
  const [criteriaEditing, setCriteriaEditing] = useState(false);
  const [incText, setIncText] = useState(project.inclusion_criteria ?? "");
  const [excText, setExcText] = useState(project.exclusion_criteria ?? "");
  const [savingCriteria, setSavingCriteria] = useState(false);

  // Reason management
  const [manageOpen, setManageOpen] = useState(false);
  const [newReason, setNewReason] = useState("");
  const [newReasonKey, setNewReasonKey] = useState("");
  const [editingReasonId, setEditingReasonId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [editingReasonKey, setEditingReasonKey] = useState("");
  const [editConfirm, setEditConfirm] = useState<EditConfirm | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();

    const { data: reasonRows } = await supabase
      .from("exclusion_reasons")
      .select("*")
      .eq("project_id", project.id)
      .order("position");
    setReasons((reasonRows ?? []) as ExclusionReason[]);

    // Inclusion codes exist from migration 0012 onward; before that the
    // panel simply offers plain include.
    const { data: codeRows, error: codeErr } = await supabase
      .from("inclusion_codes")
      .select("*")
      .eq("project_id", project.id)
      .order("position");
    setIncCodes(codeErr ? [] : ((codeRows ?? []) as InclusionCode[]));
    setIncCodesMissing(Boolean(codeErr?.message.includes("does not exist")));

    // Member display names, for showing whose decision is whose in review.
    const { data: memberRows } = await supabase
      .from("project_members")
      .select("user_id, profiles(display_name, email)")
      .eq("project_id", project.id);
    const names = new Map<string, string>();
    (
      (memberRows ?? []) as unknown as {
        user_id: string;
        profiles:
          | { display_name: string | null; email: string | null }
          | { display_name: string | null; email: string | null }[]
          | null;
      }[]
    ).forEach((m) => {
      const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
      names.set(m.user_id, p?.display_name || p?.email || "Member");
    });
    setMemberNames(names);

    // Every member's decisions at this stage: my own filter the queue,
    // and the full team map powers review mode.
    type DecInfo = {
      decision: Decision;
      reason_id: string | null;
      inclusion_code_id: string | null;
    };
    const decided = new Set<string>();
    const myDecs = new Map<string, DecInfo>();
    const teamMap = new Map<string, Map<string, DecInfo>>();
    const decSelect = codeErr
      ? "record_id, decision, reason_id, decided_by"
      : "record_id, decision, reason_id, inclusion_code_id, decided_by";
    for (let from = 0; ; from += 1000) {
      const { data, error: dErr } = await supabase
        .from("screening_decisions")
        .select(decSelect)
        .eq("project_id", project.id)
        .eq("stage", stage)
        .range(from, from + 999);
      if (dErr) {
        setError(dErr.message);
        return;
      }
      (
        (data ?? []) as unknown as {
          record_id: string;
          decision: string;
          reason_id: string | null;
          inclusion_code_id?: string | null;
          decided_by: string;
        }[]
      ).forEach((d) => {
        const info: DecInfo = {
          decision: d.decision as Decision,
          reason_id: d.reason_id,
          inclusion_code_id: d.inclusion_code_id ?? null,
        };
        const perUser = teamMap.get(d.record_id) ?? new Map<string, DecInfo>();
        perUser.set(d.decided_by, info);
        teamMap.set(d.record_id, perUser);
        if (d.decided_by === userId) {
          decided.add(d.record_id);
          myDecs.set(d.record_id, info);
        }
      });
      if (!data || data.length < 1000) break;
    }
    setMyDecisions(myDecs);
    setTeamDecisions(teamMap);

    // Conflict resolutions (empty on projects before migration 0017).
    const resMap = await fetchResolutions(supabase, project.id);
    setResolutions(resMap);
    const req = requiredFor(project, stage);

    const activeIds = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("records")
        .select("id")
        .eq("project_id", project.id)
        .eq("status", "active")
        .range(from, from + 999);
      (data ?? []).forEach((r) => activeIds.add(r.id));
      if (!data || data.length < 1000) break;
    }
    // Screened = active records with at least one decision from anyone;
    // under independent screening only REVEALED records (quota reached
    // or resolved) belong here, since blinded ones must stay unseen.
    const screenedIds = [...teamMap.keys()].filter(
      (id) =>
        activeIds.has(id) &&
        (req <= 1 ||
          (teamMap.get(id)?.size ?? 0) >= req ||
          resMap.has(resKey(stage, id)))
    );
    setTeamScreened(screenedIds.length);

    if (reviewing) {
      // Walk everything the team has decided at this stage, oldest
      // first, so any record can be revisited: your own decisions can
      // be changed in place, and records screened by others before you
      // joined can be read and given your own decision.
      const revs: RecordRow[] = [];
      for (let i = 0; i < screenedIds.length; i += 100) {
        const { data } = await supabase
          .from("records")
          .select("*")
          .eq("project_id", project.id)
          .eq("status", "active")
          .in("id", screenedIds.slice(i, i + 100));
        revs.push(...((data ?? []) as RecordRow[]));
      }
      revs.sort((a, b) => a.created_at.localeCompare(b.created_at));
      setMineTotal(revs.length);
      setMineDone(revs.length);
      setError(null);
      setQueue(revs);
      setIdx(0);
      return;
    }

    if (stage === "full_text") {
      // Eligible records: team level outcome "included" at title/abstract.
      const taByRecord = new Map<string, { decision: string }[]>();
      for (let from = 0; ; from += 1000) {
        const { data, error: tErr } = await supabase
          .from("screening_decisions")
          .select("record_id, decision")
          .eq("project_id", project.id)
          .eq("stage", "title_abstract")
          .range(from, from + 999);
        if (tErr) {
          setError(tErr.message);
          return;
        }
        (data ?? []).forEach((d) => {
          const list = taByRecord.get(d.record_id) ?? [];
          list.push(d);
          taByRecord.set(d.record_id, list);
        });
        if (!data || data.length < 1000) break;
      }
      // Eligible once the title/abstract outcome is SETTLED as included
      // (quota reached with agreement, or a conflict resolved include).
      const taReq = requiredFor(project, "title_abstract");
      const includeIds = [...activeIds].filter(
        (id) =>
          settledOutcome(
            taByRecord.get(id) ?? [],
            resMap.get(resKey("title_abstract", id)),
            taReq
          ) === "included"
      );

      const recs: RecordRow[] = [];
      for (let i = 0; i < includeIds.length; i += 100) {
        const { data } = await supabase
          .from("records")
          .select("*")
          .eq("status", "active")
          .in("id", includeIds.slice(i, i + 100));
        recs.push(...((data ?? []) as RecordRow[]));
      }
      // Records marked unretrievable leave the queue (they are reported
      // separately in the PRISMA diagram).
      const retrievable = recs.filter(
        (r) => r.retrieval_status !== "not_retrieved"
      );
      // Under independent screening a record leaves everyone's queue
      // once it has its quota of opinions; assignment pools are ignored
      // because coverage is governed by the quota, not by handout.
      const needsMe = (r: RecordRow) =>
        !decided.has(r.id) &&
        (req <= 1 ||
          ((teamMap.get(r.id)?.size ?? 0) < req &&
            !resMap.has(resKey(stage, r.id))));
      const mineAssigned =
        req > 1
          ? retrievable
          : retrievable.filter((r) => r.ft_assigned_to === userId);
      const mineRemaining = mineAssigned.filter(needsMe);
      const pool =
        req > 1
          ? retrievable
          : retrievable.filter((r) => r.ft_assigned_to === null);
      const poolRemaining = pool.filter(needsMe);
      const eligible = mineRemaining.length > 0 ? mineAssigned : pool;
      const remaining =
        mineRemaining.length > 0 ? mineRemaining : poolRemaining;
      // Progress reflects whichever set feeds the queue; once everything
      // is decided, fall back to my assigned totals so a finished stage
      // reads 100% instead of 0 / 0.
      if (remaining.length > 0 || mineAssigned.length === 0) {
        setMineTotal(eligible.length);
        setMineDone(eligible.length - remaining.length);
      } else {
        setMineTotal(mineAssigned.length);
        setMineDone(mineAssigned.length);
      }
      remaining.sort((a, b) => a.created_at.localeCompare(b.created_at));
      setError(null);
      setQueue(remaining);
      setIdx(0);
      return;
    }

    if (req > 1) {
      // Independent screening: one shared pool. My queue is every
      // active record I have not decided that is still below its
      // opinion quota; workload self-balances across reviewers and
      // assignment pools do not apply.
      const recs: RecordRow[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: rErr } = await supabase
          .from("records")
          .select("*")
          .eq("project_id", project.id)
          .eq("status", "active")
          .order("created_at")
          .range(from, from + 999);
        if (rErr) {
          setError(rErr.message);
          return;
        }
        recs.push(...((data ?? []) as RecordRow[]));
        if (!data || data.length < 1000) break;
      }
      const remaining = recs.filter(
        (r) =>
          !decided.has(r.id) &&
          (teamMap.get(r.id)?.size ?? 0) < req &&
          !resMap.has(resKey(stage, r.id))
      );
      // Personal progress: what I decided, over what has ever been
      // available to me (my decisions plus records still needing me).
      const myActive = [...decided].filter((id) => activeIds.has(id)).length;
      setMineTotal(myActive + remaining.length);
      setMineDone(myActive);
      setError(null);
      setQueue(remaining.slice(0, QUEUE_PAGE));
      setIdx(0);
      return;
    }

    // Queue mode: my undecided assigned records if any remain, otherwise
    // the unassigned pool (this also surfaces fresh imports, such as
    // snowball records, before anyone redistributes).
    const { count: assignedCount } = await supabase
      .from("records")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id)
      .eq("status", "active")
      .eq("assigned_to", userId);
    const remAssigned =
      (assignedCount ?? 0) > 0
        ? await remainingAssignedCount(project.id, userId, decided)
        : 0;
    const useAssigned = remAssigned > 0;

    let query = supabase
      .from("records")
      .select("*")
      .eq("project_id", project.id)
      .eq("status", "active")
      .order("created_at")
      .limit(QUEUE_PAGE);
    query = useAssigned
      ? query.eq("assigned_to", userId)
      : query.is("assigned_to", null);

    const { data: recordRows, error: rErr } = await query;
    if (rErr) {
      setError(rErr.message);
      return;
    }
    const all = (recordRows ?? []) as RecordRow[];
    const remaining = all.filter((r) => !decided.has(r.id));

    if (useAssigned) {
      setMineTotal(assignedCount ?? 0);
      setMineDone(Math.max(0, (assignedCount ?? 0) - remAssigned));
    } else {
      const { count: poolCount } = await supabase
        .from("records")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .eq("status", "active")
        .is("assigned_to", null);
      if ((poolCount ?? 0) > 0 || (assignedCount ?? 0) === 0) {
        const remPool =
          (poolCount ?? 0) > 0
            ? await remainingPoolCount(project.id, decided)
            : 0;
        setMineTotal(poolCount ?? 0);
        setMineDone(Math.max(0, (poolCount ?? 0) - remPool));
      } else {
        // Everything assigned to me is decided and no pool remains:
        // a finished stage should read 100%, not 0 / 0.
        setMineTotal(assignedCount ?? 0);
        setMineDone(assignedCount ?? 0);
      }
    }
    setError(null);
    setQueue(remaining);
    setIdx(0);
    // requiredFor reads two scalar columns off the project row; the row
    // itself is a stable server prop, so project.id stands in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, userId, stage, reviewing]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after awaits inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const current =
    queue && queue.length > 0 ? queue[Math.min(idx, queue.length - 1)] : null;

  useEffect(() => {
    let cancelled = false;
    // Reset viewer state when the record or stage changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPdfUrl(null);

    setShowAbstract(false);
    setPasteAbs("");
    setEditingAbs(false);
    if (stage === "full_text" && current?.fulltext_path) {
      signedFulltextUrl(current.fulltext_path).then((res) => {
        if (cancelled) return;
        if (res.url) setPdfUrl(res.url);
        else if (res.error) setError(res.error);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.fulltext_path, stage]);

  async function onPdfPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !current) return;
    setUploadBusy(true);
    const err = await uploadFulltext(project.id, current.id, file);
    setUploadBusy(false);
    if (err) {
      setError(err);
      return;
    }
    const path = fulltextPathFor(project.id, current.id);
    const id = current.id;
    setQueue(
      (q) =>
        q?.map((r) => (r.id === id ? { ...r, fulltext_path: path } : r)) ?? q
    );
  }

  const goNext = useCallback(() => {
    if (!queue || queue.length < 2) return;
    setIdx((i) => (i + 1) % queue.length);
  }, [queue]);

  const goPrev = useCallback(() => {
    if (!queue || queue.length < 2) return;
    setIdx((i) => (i - 1 + queue.length) % queue.length);
  }, [queue]);

  const decide = useCallback(
    async (
      decision: Decision,
      reasonId: string | null = null,
      inclusionCodeId: string | null = null
    ) => {
      if (!current || !queue || saving) return;
      setSaving(true);
      const supabase = createClient();
      // At the full text stage PRISMA wants a reason for every exclusion.
      if (stage === "full_text" && decision === "exclude" && !reasonId) return;
      const codeId = decision === "include" ? inclusionCodeId : null;
      const row: Record<string, unknown> = {
        project_id: project.id,
        record_id: current.id,
        stage,
        decision,
        reason_id: reasonId,
        decided_by: userId,
      };
      // Written separately so projects that have not run migration 0012
      // yet keep working: retry without the column if it is unknown.
      let insErr = (
        await supabase
          .from("screening_decisions")
          .upsert({ ...row, inclusion_code_id: codeId }, { onConflict: "record_id,stage,decided_by" })
      ).error;
      if (insErr && insErr.message.includes("inclusion_code_id")) {
        insErr = (
          await supabase
            .from("screening_decisions")
            .upsert(row, { onConflict: "record_id,stage,decided_by" })
        ).error;
      }
      setSaving(false);
      if (insErr) {
        setError(insErr.message);
        return;
      }
      const savedInfo = {
        decision,
        reason_id: reasonId,
        inclusion_code_id: codeId,
      };
      setMyDecisions((m) => {
        const next = new Map(m);
        next.set(current.id, savedInfo);
        return next;
      });
      setTeamDecisions((m) => {
        const next = new Map(m);
        const perUser = new Map(next.get(current.id) ?? []);
        perUser.set(userId, savedInfo);
        next.set(current.id, perUser);
        return next;
      });
      const at = Math.min(idx, queue.length - 1);
      if (reviewing) {
        // Revisiting: the decision is updated in place and the record
        // stays in the review queue; just move to the next one.
        setIdx(queue.length > 1 ? (at + 1) % queue.length : 0);
        return;
      }
      undoStack.current.push({ rec: current, at });
      setCanUndo(true);
      const nq = [...queue.slice(0, at), ...queue.slice(at + 1)];
      setQueue(nq);
      setIdx(at >= nq.length ? 0 : at);
      setMineDone((d) => d + 1);
      // The queue loads in pages; when a page is exhausted, fetch the next.
      if (nq.length === 0) load();
    },
    [current, saving, project.id, userId, queue, idx, load, stage, reviewing]
  );

  // The team's final verdict on a revealed conflict; any member may
  // record it after discussion, and the row logs who and when.
  const resolveConflict = useCallback(
    async (decision: Decision, reasonId: string | null = null) => {
      if (!current || resolveBusy) return;
      if (stage === "full_text" && decision === "exclude" && !reasonId) {
        return;
      }
      setResolveBusy(true);
      const supabase = createClient();
      const { data, error: rErr } = await supabase
        .from("screening_resolutions")
        .upsert(
          {
            project_id: project.id,
            record_id: current.id,
            stage,
            decision,
            reason_id: reasonId,
            resolved_by: userId,
          },
          { onConflict: "record_id,stage" }
        )
        .select()
        .single();
      setResolveBusy(false);
      if (rErr) {
        setError(rErr.message);
        return;
      }
      setResolutions((m) => {
        const next = new Map(m);
        next.set(
          resKey(stage, current.id),
          data as unknown as ScreeningResolution
        );
        return next;
      });
    },
    [current, resolveBusy, project.id, stage, userId]
  );

  const markNoAccess = useCallback(async () => {
    if (!current || !queue || saving || stage !== "full_text") return;
    setSaving(true);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("records")
      .update({ retrieval_status: "not_retrieved" })
      .eq("id", current.id);
    setSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    const at = Math.min(idx, queue.length - 1);
    if (reviewing) {
      setIdx(queue.length > 1 ? (at + 1) % queue.length : 0);
      return;
    }
    const nq = [...queue.slice(0, at), ...queue.slice(at + 1)];
    setQueue(nq);
    setIdx(at >= nq.length ? 0 : at);
    setMineTotal((t) => Math.max(0, t - 1));
    if (nq.length === 0) load();
  }, [current, queue, saving, stage, idx, load, reviewing]);

  const undo = useCallback(async () => {
    if (reviewing) return;
    const last = undoStack.current.pop();
    if (!last) return;
    const supabase = createClient();
    const { error: delErr } = await supabase
      .from("screening_decisions")
      .delete()
      .eq("record_id", last.rec.id)
      .eq("stage", stage)
      .eq("decided_by", userId);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    const arr = queue ? [...queue] : [];
    const pos = Math.min(last.at, arr.length);
    arr.splice(pos, 0, last.rec);
    setQueue(arr);
    setIdx(pos);
    setMineDone((d) => Math.max(0, d - 1));
    setCanUndo(undoStack.current.length > 0);
  }, [userId, queue, stage, reviewing]);

  async function saveAbstract() {
    if (!current || !pasteAbs.trim() || pasteBusy) return;
    setPasteBusy(true);
    const supabase = createClient();
    const text = cleanQuote(pasteAbs);
    const { error: upErr } = await supabase
      .from("records")
      .update({ abstract: text })
      .eq("id", current.id);
    setPasteBusy(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setQueue((q) =>
      q
        ? q.map((r) => (r.id === current.id ? { ...r, abstract: text } : r))
        : q
    );
    setPasteAbs("");
    setEditingAbs(false);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (editConfirm || incDelete || incEditConfirm) return; // a dialog is open

      const k = e.key.toLowerCase();
      if (e.key === "ArrowRight") {
        goNext();
        e.preventDefault();
      } else if (e.key === "ArrowLeft") {
        goPrev();
        e.preventDefault();
      } else if (k === "i") {
        decide("include");
      } else if (k === "e" && stage !== "full_text") {
        decide("exclude");
      } else if (k === "n" && stage === "full_text") {
        markNoAccess();
      } else if (k === "u") {
        undo();
      } else if (/^[a-z0-9]$/.test(k)) {
        // Reason keys (free digits by order plus custom keys), then
        // inclusion code keys.
        const keys = reasonKeyMap(reasons);
        const reason = reasons.find((r) => keys.get(r.id) === k);
        if (reason) {
          decide("exclude", reason.id);
          e.preventDefault();
          return;
        }
        const code = incCodes.find((c) => c.hotkey === k);
        if (code) decide("include", null, code.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reasons, incCodes, decide, undo, goNext, goPrev, markNoAccess, editConfirm, incDelete, incEditConfirm, stage]);

  // ----- criteria editing -----

  async function saveCriteria() {
    setSavingCriteria(true);
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("projects")
      .update({
        inclusion_criteria: incText.trim() || null,
        exclusion_criteria: excText.trim() || null,
      })
      .eq("id", project.id);
    setSavingCriteria(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setCriteriaEditing(false);
  }

  // ----- reason management -----

  async function reasonImpact(reasonId: string): Promise<number> {
    const supabase = createClient();
    const { count } = await supabase
      .from("screening_decisions")
      .select("id", { count: "exact", head: true })
      .eq("reason_id", reasonId);
    return count ?? 0;
  }

  // ----- inclusion code management -----

  function validIncKey(raw: string, ignoreId: string | null): string | null {
    const k = raw.trim().toLowerCase();
    if (!/^[a-z]$/.test(k)) return null;
    if (["i", "e", "n", "u", "m"].includes(k)) return null;
    if (incCodes.some((c) => c.hotkey === k && c.id !== ignoreId)) return null;
    if (reasons.some((r) => r.hotkey === k)) return null;
    return k;
  }

  /** A reason hotkey may be any free digit or letter. */
  function validReasonKey(raw: string, ignoreId: string | null): string | null {
    const k = raw.trim().toLowerCase();
    if (!/^[a-z0-9]$/.test(k)) return null;
    if (["i", "e", "n", "u", "m"].includes(k)) return null;
    if (incCodes.some((c) => c.hotkey === k)) return null;
    if (reasons.some((r) => r.hotkey === k && r.id !== ignoreId)) return null;
    return k;
  }

  function suggestIncKey(): string {
    const used = new Set(incCodes.map((c) => c.hotkey));
    return (
      "abcdfghjklopqrstvwxyz".split("").find((k) => !used.has(k)) ?? ""
    );
  }

  async function addIncCode(e: React.FormEvent) {
    e.preventDefault();
    const label = newIncLabel.trim();
    if (!label) return;
    const hotkey = validIncKey(newIncKey, null) ?? suggestIncKey();
    const supabase = createClient();
    const position =
      incCodes.length > 0
        ? Math.max(...incCodes.map((c) => c.position)) + 1
        : 0;
    const { data, error: insErr } = await supabase
      .from("inclusion_codes")
      .insert({ project_id: project.id, label, hotkey, position })
      .select("*")
      .single();
    if (insErr) {
      setError(
        insErr.message.includes("does not exist")
          ? "Inclusion codes need migration 0012_inclusion_codes.sql; run it in the Supabase SQL Editor first."
          : insErr.message
      );
      return;
    }
    setIncCodes((cs) => [...cs, data as InclusionCode]);
    setNewIncLabel("");
    setNewIncKey("");
  }

  async function incImpact(codeId: string): Promise<number> {
    const supabase = createClient();
    const { count } = await supabase
      .from("screening_decisions")
      .select("id", { count: "exact", head: true })
      .eq("inclusion_code_id", codeId);
    return count ?? 0;
  }

  async function applyIncUpdate(
    c: InclusionCode,
    label: string,
    hotkey: string
  ): Promise<boolean> {
    const supabase = createClient();
    const { error: upErr } = await supabase
      .from("inclusion_codes")
      .update({ label, hotkey })
      .eq("id", c.id);
    if (upErr) {
      setError(upErr.message);
      return false;
    }
    setIncCodes((cs) =>
      cs.map((x) => (x.id === c.id ? { ...x, label, hotkey } : x))
    );
    return true;
  }

  async function saveIncEdit(c: InclusionCode) {
    const label = editingIncLabel.trim();
    if (!label) return;
    const hotkey = validIncKey(editingIncKey, c.id) ?? c.hotkey;
    // A pure hotkey change is cosmetic; only a label change can mean
    // the code itself changed and the tagged papers need rejudging.
    if (label !== c.label) {
      const affected = await incImpact(c.id);
      if (affected > 0) {
        setIncEditConfirm({ code: c, newLabel: label, newKey: hotkey, affected });
        return;
      }
    }
    if (await applyIncUpdate(c, label, hotkey)) setEditingIncId(null);
  }

  async function confirmIncEdit(reset: boolean) {
    if (!incEditConfirm) return;
    const { code, newLabel, newKey } = incEditConfirm;
    if (!(await applyIncUpdate(code, newLabel, newKey))) {
      setIncEditConfirm(null);
      return;
    }
    if (reset) {
      const supabase = createClient();
      const { error: rpcErr } = await supabase.rpc("resolve_inclusion_code", {
        p_code: code.id,
        p_action: "reset",
        p_target: null,
        p_delete: false,
      });
      if (rpcErr) {
        setError(
          rpcErr.message.includes("Could not find the function")
            ? "This action needs migration 0013_inclusion_code_moves.sql; run it in the Supabase SQL Editor first."
            : rpcErr.message
        );
        setIncEditConfirm(null);
        return;
      }
    }
    setIncEditConfirm(null);
    setEditingIncId(null);
    load();
  }

  async function deleteIncCode(c: InclusionCode) {
    const affected = await incImpact(c.id);
    if (affected === 0) {
      const ok = window.confirm(
        `Delete the inclusion code "${c.label}"? No decisions currently use it.`
      );
      if (!ok) return;
      const supabase = createClient();
      const { error: delErr } = await supabase
        .from("inclusion_codes")
        .delete()
        .eq("id", c.id);
      if (delErr) {
        setError(delErr.message);
        return;
      }
      setIncCodes((cs) => cs.filter((x) => x.id !== c.id));
      return;
    }
    setIncMigrateTarget("");
    setIncDelete({ code: c, affected });
  }

  async function resolveIncDelete(action: "keep" | "migrate" | "reset") {
    if (!incDelete) return;
    const supabase = createClient();
    if (action === "keep") {
      // The foreign key is on delete set null, so a plain delete keeps
      // every include decision and just clears the tag. Works even
      // before migration 0013.
      const { error: delErr } = await supabase
        .from("inclusion_codes")
        .delete()
        .eq("id", incDelete.code.id);
      if (delErr) {
        setError(delErr.message);
        setIncDelete(null);
        return;
      }
    } else {
      const { error: rpcErr } = await supabase.rpc("resolve_inclusion_code", {
        p_code: incDelete.code.id,
        p_action: action,
        p_target: action === "migrate" ? incMigrateTarget : null,
        p_delete: true,
      });
      if (rpcErr) {
        setError(
          rpcErr.message.includes("Could not find the function")
            ? "This action needs migration 0013_inclusion_code_moves.sql; run it in the Supabase SQL Editor first."
            : rpcErr.message
        );
        setIncDelete(null);
        return;
      }
    }
    setIncDelete(null);
    setIncMigrateTarget("");
    load();
  }

  async function addReason(e: React.FormEvent) {
    e.preventDefault();
    if (!newReason.trim()) return;
    const supabase = createClient();
    const base = {
      project_id: project.id,
      label: newReason.trim(),
      position: (reasons[reasons.length - 1]?.position ?? 0) + 1,
    };
    const hotkey = validReasonKey(newReasonKey, null) ?? "";
    // Retry without the column for projects that predate migration 0014.
    let res = await supabase
      .from("exclusion_reasons")
      .insert({ ...base, hotkey })
      .select("*")
      .single();
    if (res.error && res.error.message.includes("hotkey")) {
      res = await supabase
        .from("exclusion_reasons")
        .insert(base)
        .select("*")
        .single();
    }
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setReasons([...reasons, res.data as ExclusionReason]);
    setNewReason("");
    setNewReasonKey("");
  }

  async function deleteReason(r: ExclusionReason) {
    const affected = await reasonImpact(r.id);
    const ok = window.confirm(
      affected > 0
        ? `Delete "${r.label}"? ${affected} decision(s) across the team used this reason; those records return to the screening queue. This cannot be undone.`
        : `Delete "${r.label}"? No records currently use it.`
    );
    if (!ok) return;
    const supabase = createClient();
    const { error: rpcErr } = await supabase.rpc("delete_reason_and_reset", {
      p_reason: r.id,
    });
    if (rpcErr) {
      setError(
        rpcErr.message.includes("Could not find the function")
          ? "This action needs migration 0003_screening.sql; run it in the Supabase SQL Editor first."
          : rpcErr.message
      );
      return;
    }
    load();
  }

  async function requestEditSave(r: ExclusionReason) {
    const newLabel = editingLabel.trim();
    if (!newLabel) return;
    // Hotkey changes are cosmetic and save directly, whatever happens
    // with the label.
    const newKey = validReasonKey(editingReasonKey, r.id) ?? (r.hotkey || "");
    if (newKey !== (r.hotkey || "")) {
      const supabase = createClient();
      const { error: kErr } = await supabase
        .from("exclusion_reasons")
        .update({ hotkey: newKey })
        .eq("id", r.id);
      if (kErr) {
        setError(
          kErr.message.includes("hotkey")
            ? "Custom reason hotkeys need migration 0014_reason_hotkeys.sql; run it in the Supabase SQL Editor first."
            : kErr.message
        );
        return;
      }
      setReasons((rs) =>
        rs.map((x) => (x.id === r.id ? { ...x, hotkey: newKey } : x))
      );
    }
    if (newLabel === r.label) {
      setEditingReasonId(null);
      return;
    }
    const affected = await reasonImpact(r.id);
    if (affected === 0) {
      const supabase = createClient();
      const { error: upErr } = await supabase
        .from("exclusion_reasons")
        .update({ label: newLabel })
        .eq("id", r.id);
      if (upErr) {
        setError(upErr.message);
        return;
      }
      setEditingReasonId(null);
      load();
      return;
    }
    setEditConfirm({ reasonId: r.id, newLabel, affected });
  }

  async function confirmEdit(reset: boolean) {
    if (!editConfirm) return;
    const supabase = createClient();
    const { error: rpcErr } = await supabase.rpc("update_reason", {
      p_reason: editConfirm.reasonId,
      p_label: editConfirm.newLabel,
      p_reset: reset,
    });
    if (rpcErr) {
      setError(
        rpcErr.message.includes("Could not find the function")
          ? "This action needs migration 0003_screening.sql; run it in the Supabase SQL Editor first."
          : rpcErr.message
      );
      setEditConfirm(null);
      return;
    }
    setEditConfirm(null);
    setEditingReasonId(null);
    load();
  }

  const pct = mineTotal > 0 ? Math.round((mineDone / mineTotal) * 100) : 0;
  const rKeys = reasonKeyMap(reasons);

  const btn =
    "rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-50";
  const sideCard =
    "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";
  const keyChip =
    "flex h-6 min-w-6 shrink-0 items-center justify-center rounded bg-zinc-100 px-1 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";
  const inputCls =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";
  const keyInputCls =
    "h-8 w-12 shrink-0 rounded-lg border border-zinc-300 bg-white py-0 text-center text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";

  const hasCriteria = Boolean(incText.trim() || excText.trim());

  return (
    <main
      className={`mx-auto flex w-full flex-1 flex-col px-6 py-6 ${
        stage === "full_text" ? "max-w-[1700px]" : "max-w-6xl"
      }`}
    >
      <input
        type="file"
        accept="application/pdf,.pdf"
        ref={fileRef}
        className="hidden"
        onChange={onPdfPicked}
      />
      <div className="mb-4 flex gap-2">
        {(
          [
            ["title_abstract", "Title and abstract"],
            ["full_text", "Full text"],
          ] as [Stage, string][]
        ).map(([s, label]) => (
          <button
            key={s}
            onClick={() => {
              if (s !== stage) {
                setStage(s);
                setReviewing(false);
                setQueue(null);
                undoStack.current = [];
                setCanUndo(false);
              }
            }}
            className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
              stage === s
                ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-teal-950"
                : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {label}
          </button>
        ))}
        {stage === "title_abstract" && !reviewing && (
          <div className="ml-auto">
            <PrescreenPanel
              project={project}
              onDone={() => {
                setQueue(null);
                load();
              }}
            />
          </div>
        )}
      </div>

      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
          <span>
            {stage === "full_text" ? "Full text screening" : "Title and abstract screening"}
            {" · "}
            {reviewing ? (
              <>
                reviewing {queue?.length ?? 0} screened record(s){" · "}
                <button
                  onClick={() => {
                    setReviewing(false);
                    setQueue(null);
                  }}
                  className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  back to the queue
                </button>
              </>
            ) : (
              <>
                {mineDone} / {mineTotal} done ({pct}%)
                {teamScreened > 0 && (
                  <>
                    {" · "}
                    <button
                      onClick={() => {
                        setReviewing(true);
                        setQueue(null);
                      }}
                      className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-200"
                      title="Walk through every record the team has screened at this stage"
                    >
                      review screened ({teamScreened})
                    </button>
                  </>
                )}
              </>
            )}
          </span>
          <span className="hidden items-center gap-1.5 lg:inline-flex">
            <kbd className={kbd}>1–9</kbd> exclude
            <kbd className={kbd}>I</kbd> include
            {stage !== "full_text" ? (
              <>
                <kbd className={kbd}>E</kbd> exclude
              </>
            ) : (
              <>
                <kbd className={kbd}>N</kbd> no access
              </>
            )}
            <kbd className={kbd}>←</kbd>
            <kbd className={kbd}>→</kbd> skip
            {!reviewing && (
              <>
                <kbd className={kbd}>U</kbd> undo
              </>
            )}
            {queue && queue.length > 1 && (
              <span className="ml-1">
                viewing {Math.min(idx, queue.length - 1) + 1} of {queue.length}{" "}
                {reviewing ? "screened" : "undecided"}
              </span>
            )}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className="h-full rounded-full bg-teal-600 transition-all"
            style={{ width: `${reviewing ? 100 : pct}%` }}
          />
        </div>
        {reviewing && current && (
          <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {(() => {
              const fmt = (d: {
                decision: Decision;
                reason_id: string | null;
                inclusion_code_id: string | null;
              }) => {
                if (d.decision === "include") {
                  const code = d.inclusion_code_id
                    ? incCodes.find((c) => c.id === d.inclusion_code_id)
                    : null;
                  return (
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">
                      Include
                      {code
                        ? `: ${code.hotkey.toUpperCase()} (${code.label})`
                        : ""}
                    </span>
                  );
                }
                const ri = d.reason_id
                  ? reasons.findIndex((r) => r.id === d.reason_id)
                  : -1;
                return (
                  <span className="font-medium text-red-600 dark:text-red-400">
                    Exclude
                    {ri >= 0 ? `: E${ri + 1} (${reasons[ri].label})` : ""}
                  </span>
                );
              };
              const mine = myDecisions.get(current.id);
              const perUser = teamDecisions.get(current.id) ?? new Map();
              const res = resolutions.get(resKey(stage, current.id));
              // Blinded records never show teammates' decisions; the
              // review queue only holds revealed records under
              // independent screening, but guard here regardless.
              const revealed =
                required <= 1 || perUser.size >= required || Boolean(res);
              const others = revealed
                ? [...perUser].filter(([uid]) => uid !== userId)
                : [];
              const teamConflict =
                revealed && outcomeOf([...perUser.values()]) === "conflict";
              return (
                <>
                  {!revealed && (
                    <p>
                      Independent screening: teammates&apos; decisions stay
                      hidden until this record has {required} opinions.
                    </p>
                  )}
                  {others.length > 0 && (
                    <p>
                      Team decisions:{" "}
                      {others.map(([uid, d], i) => (
                        <span key={uid}>
                          {i > 0 && " · "}
                          {memberNames.get(uid) ?? "Member"}: {fmt(d)}
                        </span>
                      ))}
                    </p>
                  )}
                  <p>
                    Your decision:{" "}
                    {mine ? (
                      fmt(mine)
                    ) : (
                      <span className="font-medium">none recorded</span>
                    )}
                    {teamConflict && !res && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                        conflict
                      </span>
                    )}
                    {" · "}
                    {mine
                      ? "press a key to change it, arrows to move on."
                      : "press a key to add yours, arrows to move on."}
                  </p>
                  {res && (
                    <p>
                      Team resolution: {fmt({ decision: res.decision, reason_id: res.reason_id, inclusion_code_id: res.inclusion_code_id })}{" "}
                      recorded by {memberNames.get(res.resolved_by) ?? "a member"}.
                    </p>
                  )}
                  {teamConflict && !res && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span>Settle it for the team after discussing:</span>
                      <button
                        onClick={() => resolveConflict("include")}
                        disabled={resolveBusy}
                        className="rounded-full bg-emerald-700 px-2.5 py-0.5 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Resolve: include
                      </button>
                      {stage === "full_text" ? (
                        <select
                          value=""
                          disabled={resolveBusy}
                          onChange={(e) => {
                            if (e.target.value) {
                              resolveConflict("exclude", e.target.value);
                            }
                          }}
                          className="h-6 rounded-lg border border-zinc-300 bg-white px-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        >
                          <option value="">Resolve: exclude (reason)...</option>
                          {reasons.map((r, i) => (
                            <option key={r.id} value={r.id}>
                              E{i + 1} {r.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <button
                          onClick={() => resolveConflict("exclude")}
                          disabled={resolveBusy}
                          className="rounded-full border border-red-400 px-2.5 py-0.5 text-xs font-medium text-red-700 disabled:opacity-50 dark:border-red-700 dark:text-red-300"
                        >
                          Resolve: exclude
                        </button>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="flex flex-1 flex-col gap-4 lg:flex-row">
        {/* ---------------- Record ---------------- */}
        <div className="flex min-w-0 flex-1 flex-col">
          {queue === null ? (
            <p className="text-zinc-600 dark:text-zinc-400">Loading your queue...</p>
          ) : current === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                Queue empty. Nice work.
              </h2>
              <p className="max-w-md text-zinc-600 dark:text-zinc-400">
                {reviewing
                  ? "Nobody on the team has screened any records at this stage yet."
                  : stage === "full_text"
                    ? "No records are waiting for full text screening. Records arrive here once the team includes them at the title and abstract stage."
                    : "You have screened everything currently assigned to you. Import more records, ask the owner to distribute unassigned ones, or review the results in the records table."}
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                {!reviewing && teamScreened > 0 && (
                  <button
                    onClick={() => {
                      setReviewing(true);
                      setQueue(null);
                    }}
                    className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
                  >
                    Review screened records ({teamScreened})
                  </button>
                )}
                <Link
                  href={`/projects/${project.id}`}
                  className={`${btn} bg-teal-700 text-white hover:bg-teal-800 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300`}
                >
                  Back to project
                </Link>
                <Link
                  href={`/projects/${project.id}/records`}
                  className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
                >
                  Records table
                </Link>
              </div>
            </div>
          ) : (
            <>
              <article className="mb-4 flex flex-1 flex-col overflow-y-auto rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
                <h2 className="mb-2 text-2xl font-semibold leading-snug text-zinc-900 dark:text-zinc-50">
                  <Highlighted
                    text={current.title}
                    include={project.include_keywords}
                    exclude={project.exclude_keywords}
                  />
                </h2>
                <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
                  {[current.authors, current.year, current.venue, current.source_label]
                    .filter(Boolean)
                    .join(" · ")}
                  {current.doi && (
                    <>
                      {" · "}
                      <a
                        className="underline underline-offset-2"
                        href={`https://doi.org/${current.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        DOI
                      </a>
                    </>
                  )}
                  {current.url && (
                    <>
                      {" · "}
                      <a
                        className="underline underline-offset-2"
                        href={current.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Link
                      </a>
                    </>
                  )}
                  {stage === "full_text" && (
                    <>
                      {" · "}
                      <button
                        onClick={() => fileRef.current?.click()}
                        disabled={uploadBusy}
                        className="underline underline-offset-2 disabled:opacity-50"
                      >
                        {uploadBusy
                          ? "Uploading..."
                          : current.fulltext_path
                            ? "Replace PDF"
                            : "Upload PDF"}
                      </button>
                      {pdfUrl && current.abstract && (
                        <>
                          {" · "}
                          <button
                            onClick={() => setShowAbstract(!showAbstract)}
                            className="underline underline-offset-2"
                          >
                            {showAbstract ? "Hide abstract" : "Show abstract"}
                          </button>
                        </>
                      )}
                      {pdfUrl && (
                        <>
                          {" · "}
                          <button
                            onClick={() =>
                              window.open(pdfUrl, "_blank", "noopener")
                            }
                            className="underline underline-offset-2"
                          >
                            Open in tab
                          </button>
                          {" · "}
                          <button
                            onClick={() => setPdfExpanded(!pdfExpanded)}
                            className="underline underline-offset-2"
                          >
                            {pdfExpanded ? "Exit wide view" : "Wide view"}
                          </button>
                        </>
                      )}
                    </>
                  )}
                </p>
                {(stage !== "full_text" || !pdfUrl || showAbstract) &&
                  (editingAbs ? (
                    <div className="mt-1 flex max-w-3xl flex-col gap-2">
                      <textarea
                        value={pasteAbs}
                        onChange={(e) => setPasteAbs(e.target.value)}
                        rows={6}
                        autoFocus
                        className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={saveAbstract}
                          disabled={pasteBusy || !pasteAbs.trim()}
                          className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          {pasteBusy ? "Saving..." : "Save abstract"}
                        </button>
                        <button
                          onClick={() => {
                            setEditingAbs(false);
                            setPasteAbs("");
                          }}
                          className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : current.abstract ? (
                    <div>
                      <p className="whitespace-pre-line leading-7 text-zinc-800 dark:text-zinc-200">
                        <Highlighted
                          text={current.abstract}
                          include={project.include_keywords}
                          exclude={project.exclude_keywords}
                        />
                      </p>
                      <button
                        onClick={() => {
                          setEditingAbs(true);
                          setPasteAbs(current.abstract ?? "");
                        }}
                        className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                        title="Fix an imported abstract that is wrong or garbled"
                      >
                        Edit abstract
                      </button>
                    </div>
                  ) : (
                    <div>
                      <p className="italic text-zinc-500 dark:text-zinc-500">
                        No abstract in the export for this record.
                      </p>
                      <div className="mt-2 flex max-w-2xl flex-col gap-2">
                        <textarea
                          value={pasteAbs}
                          onChange={(e) => setPasteAbs(e.target.value)}
                          placeholder="Found it elsewhere? Paste the abstract here and it stays with the record."
                          rows={3}
                          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        />
                        {pasteAbs.trim() && (
                          <button
                            onClick={saveAbstract}
                            disabled={pasteBusy}
                            className="self-start rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          >
                            {pasteBusy ? "Saving..." : "Save abstract"}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                {stage === "full_text" &&
                  (pdfUrl ? (
                    <iframe
                      ref={pdfFrameRef}
                      onLoad={reclaimFocusFromPdf}
                      src={`${pdfUrl}#view=FitH&navpanes=0`}
                      title="Full text PDF"
                      className="mt-3 h-[78vh] w-full rounded-lg border border-zinc-200 dark:border-zinc-700"
                    />
                  ) : current.fulltext_path ? (
                    <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading PDF...</p>
                  ) : (
                    <p className="mt-3 rounded-lg border border-dashed border-zinc-300 p-3 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                      No PDF uploaded for this record yet. Use the DOI or Link
                      above to retrieve it, then click Upload PDF to read it
                      here (and later in the concept matrix). If it cannot be
                      accessed at all, press N.
                    </p>
                  ))}
              </article>

              <div className="flex flex-wrap items-center justify-center gap-3 pb-2">
                <button
                  onClick={() => decide("include")}
                  disabled={saving}
                  className={`${btn} bg-emerald-700 text-white hover:bg-emerald-600`}
                >
                  Include (I)
                </button>
                <button
                  onClick={goNext}
                  disabled={saving || (queue?.length ?? 0) < 2}
                  className={`${btn} bg-amber-500 text-white hover:bg-amber-400`}
                  title="Leave undecided and look at the next record; it stays in the queue"
                >
                  Skip (→)
                </button>
                {stage !== "full_text" ? (
                  <button
                    onClick={() => decide("exclude")}
                    disabled={saving}
                    className={`${btn} bg-red-600 text-white hover:bg-red-500`}
                  >
                    Exclude, no reason (E)
                  </button>
                ) : (
                  <button
                    onClick={markNoAccess}
                    disabled={saving}
                    className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
                    title="Full text could not be accessed; reported as 'not retrieved' in the PRISMA diagram"
                  >
                    No access (N)
                  </button>
                )}
                <button
                  onClick={undo}
                  disabled={!canUndo}
                  className={`${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
                >
                  Undo (U)
                </button>
              </div>
            </>
          )}
        </div>

        {/* ---------------- Sidebar ---------------- */}
        <aside
          className={`flex w-full shrink-0 flex-col gap-4 lg:w-80 ${
            stage === "full_text" && pdfExpanded && pdfUrl ? "hidden" : ""
          }`}
        >
          <div className={sideCard}>
            <button
              onClick={() => setCriteriaOpen(!criteriaOpen)}
              className="flex w-full items-center justify-between text-sm font-semibold text-zinc-900 dark:text-zinc-50"
            >
              Criteria
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {criteriaOpen ? "hide" : "show"}
              </span>
            </button>
            {criteriaOpen && (
              <div className="mt-2 text-sm">
                {criteriaEditing ? (
                  <div className="flex flex-col gap-2">
                    <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Inclusion criteria
                      <textarea
                        className={`${inputCls} min-h-20`}
                        value={incText}
                        onChange={(e) => setIncText(e.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Exclusion criteria
                      <textarea
                        className={`${inputCls} min-h-20`}
                        value={excText}
                        onChange={(e) => setExcText(e.target.value)}
                      />
                    </label>
                    <div className="flex gap-3">
                      <button
                        onClick={saveCriteria}
                        disabled={savingCriteria}
                        className="text-xs font-medium text-emerald-600 underline underline-offset-2"
                      >
                        {savingCriteria ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={() => setCriteriaEditing(false)}
                        className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {hasCriteria ? (
                      <div className="flex flex-col gap-2">
                        {incText.trim() && (
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
                              Include when
                            </p>
                            <p className="whitespace-pre-line text-zinc-700 dark:text-zinc-300">
                              {incText}
                            </p>
                          </div>
                        )}
                        {excText.trim() && (
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-red-600">
                              Exclude when
                            </p>
                            <p className="whitespace-pre-line text-zinc-700 dark:text-zinc-300">
                              {excText}
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="italic text-zinc-500 dark:text-zinc-400">
                        No criteria written down yet. Doing that before
                        screening keeps the whole team calibrated.
                      </p>
                    )}
                    <button
                      onClick={() => setCriteriaEditing(true)}
                      className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                    >
                      Edit
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className={sideCard}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Exclude with reason
              </h3>
              <button
                onClick={() => setManageOpen(!manageOpen)}
                className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                {manageOpen ? "done" : "manage"}
              </button>
            </div>

            {reasons.length === 0 && (
              <p className="mb-2 text-sm italic text-zinc-500 dark:text-zinc-400">
                No exclusion reasons yet. Add some to exclude with one
                keypress.
              </p>
            )}

            <div className="flex flex-col gap-1">
              {reasons.map((r) => (
                <div key={r.id} className="flex items-center gap-2">
                  {editingReasonId === r.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        requestEditSave(r);
                      }}
                      className="flex flex-1 items-center gap-2"
                    >
                      <input
                        className={keyInputCls}
                        value={editingReasonKey}
                        onChange={(e) => setEditingReasonKey(e.target.value)}
                        maxLength={1}
                        title="Hotkey: any free digit or letter except I/E/N/U; blank uses the next free digit"
                      />
                      <input
                        className={`${inputCls} h-8 min-w-0 flex-1 py-0`}
                        value={editingLabel}
                        onChange={(e) => setEditingLabel(e.target.value)}
                        autoFocus
                      />
                      <button type="submit" className="text-xs underline underline-offset-2">
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingReasonId(null)}
                        className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2"
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        onClick={() => decide("exclude", r.id)}
                        disabled={saving || !current}
                        className="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-800 transition-colors hover:bg-red-50 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-red-950"
                      >
                        <span
                          className={keyChip}
                          title={
                            rKeys.get(r.id)
                              ? undefined
                              : "No free key; assign one via manage"
                          }
                        >
                          {(rKeys.get(r.id) || "·").toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">{r.label}</span>
                      </button>
                      {manageOpen && (
                        <span className="flex shrink-0 gap-2">
                          <button
                            onClick={() => {
                              setEditingReasonId(r.id);
                              setEditingLabel(r.label);
                              setEditingReasonKey(r.hotkey || "");
                            }}
                            className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                          >
                            edit
                          </button>
                          <button
                            onClick={() => deleteReason(r)}
                            className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-red-600"
                          >
                            delete
                          </button>
                        </span>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>

            {manageOpen && (
              <form onSubmit={addReason} className="mt-2 flex gap-2">
                <input
                  className={keyInputCls}
                  placeholder="key"
                  value={newReasonKey}
                  onChange={(e) => setNewReasonKey(e.target.value)}
                  maxLength={1}
                  title="Hotkey: any free digit or letter except I/E/N/U; blank uses the next free digit"
                />
                <input
                  className={`${inputCls} h-8 min-w-0 flex-1 py-0`}
                  placeholder="New exclusion reason"
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value)}
                />
                <button
                  type="submit"
                  className="rounded-full border border-zinc-300 px-3 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Add
                </button>
              </form>
            )}

            {reasons.some((r) => !rKeys.get(r.id)) && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Reasons marked · have no key left: the free digits ran out.
                Give them any free letter (or digit) via manage.
              </p>
            )}
          </div>

          <div className={sideCard}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Include
              </h3>
              <button
                onClick={() => setManageIncOpen(!manageIncOpen)}
                className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                {manageIncOpen ? "done" : "manage"}
              </button>
            </div>

            <div className="flex flex-col gap-1">
              <button
                onClick={() => decide("include")}
                disabled={saving || !current}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-800 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-emerald-950"
              >
                <span className={keyChip}>I</span>
                <span className="min-w-0 flex-1">Include</span>
              </button>
              {incCodes.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  {editingIncId === c.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveIncEdit(c);
                      }}
                      className="flex flex-1 items-center gap-2"
                    >
                      <input
                        className={keyInputCls}
                        value={editingIncKey}
                        onChange={(e) => setEditingIncKey(e.target.value)}
                        maxLength={1}
                        title="Hotkey: one letter, not I/E/N/U or a digit"
                      />
                      <input
                        className={`${inputCls} h-8 min-w-0 flex-1 py-0`}
                        value={editingIncLabel}
                        onChange={(e) => setEditingIncLabel(e.target.value)}
                        autoFocus
                      />
                      <button type="submit" className="text-xs underline underline-offset-2">
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingIncId(null)}
                        className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2"
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        onClick={() => decide("include", null, c.id)}
                        disabled={saving || !current}
                        className="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-800 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-emerald-950"
                      >
                        <span className={keyChip}>
                          {c.hotkey ? c.hotkey.toUpperCase() : "·"}
                        </span>
                        <span className="min-w-0 flex-1">{c.label}</span>
                      </button>
                      {manageIncOpen && (
                        <span className="flex shrink-0 gap-2">
                          <button
                            onClick={() => {
                              setEditingIncId(c.id);
                              setEditingIncLabel(c.label);
                              setEditingIncKey(c.hotkey);
                            }}
                            className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                          >
                            edit
                          </button>
                          <button
                            onClick={() => deleteIncCode(c)}
                            className="text-xs text-zinc-500 dark:text-zinc-400 underline underline-offset-2 hover:text-red-600"
                          >
                            delete
                          </button>
                        </span>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>

            {manageIncOpen && (
              <form onSubmit={addIncCode} className="mt-2 flex gap-2">
                <input
                  className={keyInputCls}
                  placeholder={suggestIncKey().toUpperCase()}
                  value={newIncKey}
                  onChange={(e) => setNewIncKey(e.target.value)}
                  maxLength={1}
                  title="Hotkey: one letter, not I/E/N/U or a digit; blank picks the next free one"
                />
                <input
                  className={`${inputCls} h-8 min-w-0 flex-1 py-0`}
                  placeholder="New inclusion code"
                  value={newIncLabel}
                  onChange={(e) => setNewIncLabel(e.target.value)}
                />
                <button
                  type="submit"
                  className="rounded-full border border-zinc-300 px-3 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Add
                </button>
              </form>
            )}
            {manageIncOpen && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Codes tag an include decision (I stays plain include).
                Hotkeys are single letters; digits and I/E/N/U are taken.
                Deleting a used code asks where its papers go: stay
                included, move to another code, or back to the queue.
              </p>
            )}
            {incCodesMissing && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                Inclusion codes need migration 0012_inclusion_codes.sql; run
                it in the Supabase SQL Editor.
              </p>
            )}
          </div>

          <div className={`${sideCard} text-xs text-zinc-600 dark:text-zinc-400`}>
            <p className="mb-1 font-semibold text-zinc-700 dark:text-zinc-300">
              Other keys
            </p>
            <p>
              I include · E exclude without reason · ← → skip through
              undecided · U undo
            </p>
          </div>
        </aside>
      </div>

      {/* ------------- Inclusion code delete dialog ------------- */}
      {incDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="mb-2 font-semibold text-zinc-900 dark:text-zinc-50">
              Delete &quot;{incDelete.code.label}&quot;
            </h3>
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
              {incDelete.affected} include decision(s) across the team carry
              this code. Where should those papers go?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => resolveIncDelete("keep")}
                className="rounded-full bg-teal-700 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-teal-800 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
              >
                Keep them included, just drop the code
              </button>
              <div className="flex gap-2">
                <select
                  value={incMigrateTarget}
                  onChange={(e) => setIncMigrateTarget(e.target.value)}
                  className={`${inputCls} h-10 min-w-0 flex-1 py-0`}
                >
                  <option value="">Move them to another code...</option>
                  {incCodes
                    .filter((x) => x.id !== incDelete.code.id)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.hotkey.toUpperCase()}: {x.label}
                      </option>
                    ))}
                </select>
                <button
                  onClick={() => resolveIncDelete("migrate")}
                  disabled={!incMigrateTarget}
                  className="rounded-full border border-zinc-300 px-4 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Move
                </button>
              </div>
              <button
                onClick={() => resolveIncDelete("reset")}
                className="rounded-full border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
              >
                Unmark them: decisions removed, back to the screening queue
              </button>
              <button
                onClick={() => {
                  setIncDelete(null);
                  setIncMigrateTarget("");
                }}
                className="rounded-full px-4 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Inclusion code edit impact dialog ---------- */}
      {incEditConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="mb-2 font-semibold text-zinc-900 dark:text-zinc-50">
              This code has already been used
            </h3>
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
              {incEditConfirm.affected} include decision(s) across the team
              carry this code. If the edit is a small fix (typo, wording),
              keep them tagged. If the code&apos;s meaning changed, the
              affected papers should return to the screening queue and be
              judged again.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => confirmIncEdit(false)}
                className="rounded-full bg-teal-700 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-teal-800 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
              >
                Keep the decisions (small fix)
              </button>
              <button
                onClick={() => confirmIncEdit(true)}
                className="rounded-full border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
              >
                Reset them: back to the screening queue
              </button>
              <button
                onClick={() => setIncEditConfirm(null)}
                className="rounded-full px-4 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Edit impact dialog ---------------- */}
      {editConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="mb-2 font-semibold text-zinc-900 dark:text-zinc-50">
              This reason has already been used
            </h3>
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
              {editConfirm.affected} decision(s) across the team carry this
              reason. If the edit is a small fix (typo, wording), keep them. If
              the criterion itself changed, the affected records should return
              to the screening queue and be judged again.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => confirmEdit(false)}
                className="rounded-full bg-teal-700 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-teal-800 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
              >
                Small fix: keep the {editConfirm.affected} decision(s)
              </button>
              <button
                onClick={() => confirmEdit(true)}
                className="rounded-full border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
              >
                Real change: return those records to the queue
              </button>
              <button
                onClick={() => setEditConfirm(null)}
                className="text-sm text-zinc-500 dark:text-zinc-400 underline underline-offset-2"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
