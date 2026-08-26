/**
 * Password policy for signup. Accounts gate access to team reviews and
 * the browser holds users' AI API keys, so the bar is higher than the
 * Supabase default. This mirrors the server side policy set in the
 * Supabase dashboard (Auth settings); the client checklist exists for
 * instant feedback, the server setting is the enforcement.
 */

export type PasswordCheck = { ok: boolean; label: string };

export function passwordChecks(pw: string, email: string): PasswordCheck[] {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  return [
    { ok: pw.length >= 8, label: "At least 8 characters" },
    {
      ok: /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw),
      label: "Contains a letter and a number",
    },
    {
      ok: local.length < 4 || !pw.toLowerCase().includes(local),
      label: "Does not contain your email name",
    },
  ];
}

export function passwordOk(pw: string, email: string): boolean {
  return passwordChecks(pw, email).every((c) => c.ok);
}

/** Rough strength read for the hint line; never blocks on its own. */
export function strengthLabel(pw: string): "weak" | "okay" | "strong" {
  let variety = 0;
  if (/[a-z]/.test(pw)) variety++;
  if (/[A-Z]/.test(pw)) variety++;
  if (/[0-9]/.test(pw)) variety++;
  if (/[^a-zA-Z0-9]/.test(pw)) variety++;
  if (pw.length >= 14 && variety >= 3) return "strong";
  if (pw.length >= 8 && variety >= 2) return "okay";
  return "weak";
}
