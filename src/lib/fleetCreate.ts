// The staff step that follows an approval: create the fleet's Client Portal
// company with REA's `npm run fleet:create` (cruzelabs/REA #77), run in
// REA/trucklogics. The admin dialog shows it with both ids filled in, so
// staff copy one line and need no SQL.
//
// The company name comes from the applicant, so it goes into the command as
// one single-quoted shell word: nothing inside it ($(...), backticks, quotes,
// ;) can run when staff paste the line into a terminal.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Control characters (newlines included) and the bidirectional overrides that
// could make the copied text read differently from what runs.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g;

/** One POSIX shell word holding exactly `value`: single quotes, each ' written as '\''. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The company name as it goes on the command line: unsafe characters become spaces. */
export function commandName(name: string | null | undefined): string {
  return (name ?? "").replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * `npm run fleet:create -- --name '<company>' --organization <organizations.id>
 * --owner <pilot_applications.user_id>`, or null when the name is blank or an
 * id is not a uuid.
 */
export function fleetCreateCommand(
  name: string | null | undefined,
  organizationId: string | null | undefined,
  ownerId: string | null | undefined
): string | null {
  const clean = commandName(name);
  if (!clean || !UUID_RE.test(organizationId ?? "") || !UUID_RE.test(ownerId ?? "")) return null;
  return `npm run fleet:create -- --name ${shellQuote(clean)} --organization ${organizationId} --owner ${ownerId}`;
}
