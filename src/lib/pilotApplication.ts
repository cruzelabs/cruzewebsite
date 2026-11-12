/** Pilot application lifecycle + shared field shapes for /apply and dashboards. */

export const PILOT_LIFECYCLE = [
  "pending",
  "in_review",
  "approved",
  "onboarding",
  "active",
  "denied",
  "archived",
] as const;

export type PilotLifecycleStatus = (typeof PILOT_LIFECYCLE)[number];

/** Terminal statuses — user may submit a new application after these. */
export const TERMINAL_PILOT_STATUSES: PilotLifecycleStatus[] = ["denied", "archived"];

/** ELD or telematics providers offered on /apply, in the order shown. */
export const ELD_PROVIDERS = [
  "Samsara",
  "Geotab",
  "Motive",
  "Verizon Connect",
  "Trimble",
  "Omnitracs",
  "Other",
  "None",
] as const;

/** Who manages the fleet's tablets (pilot_applications.tablet_management, migration 026). */
export const TABLET_MANAGERS = ["fleet_mdm", "cruze", "manual"] as const;
export type TabletManager = (typeof TABLET_MANAGERS)[number];

/** The choices as the applicant reads them on /apply. */
export const TABLET_MANAGER_CHOICES: Record<TabletManager, string> = {
  fleet_mdm: "Our MDM (device management)",
  cruze: "Cruze",
  manual: "By hand",
};

/** The same answer as staff and the fleet read it back. */
const TABLET_MANAGER_TEXT: Record<TabletManager, string> = {
  fleet_mdm: "managed through the fleet's MDM",
  cruze: "managed by Cruze",
  manual: "managed by hand",
};

/** Largest truck or tablet count, the same as the database checks (migration 026). */
export const MAX_COUNT = 1_000_000;

export type PilotApplicationRow = {
  id: string;
  user_id: string;
  company_name: string | null;
  truck_size: string | null;
  fleet_size: string | null;
  truck_count: number | null;
  status: PilotLifecycleStatus;
  website: string | null;
  primary_lanes: string | null;
  fms_provider: string | null;
  fms_other: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_title: string | null;
  application_notes: string | null;
  data_authorizer_name: string | null;
  data_authorizer_email: string | null;
  tablet_model: string | null;
  tablet_count: number | null;
  tablet_management: string | null;
  safety_contact_name: string | null;
  safety_contact_email: string | null;
  fleet_visible_message: string | null;
  notes: string | null;
  created_at: string;
  reviewed_at: string | null;
};

/** The /apply form's answers, as typed. Counts stay strings until submit. */
export type ApplyWizardPayload = {
  companyName: string;
  website: string;
  truckCount: string;
  truckSize: string;
  primaryLanes: string;
  fmsProvider: string;
  fmsOther: string;
  contactEmail: string;
  contactName: string;
  contactPhone: string;
  contactTitle: string;
  notes: string;
  dataAuthorizerName: string;
  dataAuthorizerEmail: string;
  safetyContactName: string;
  safetyContactEmail: string;
  tabletModel: string;
  tabletCount: string;
  tabletManagement: string;
};

export function blankWizard(contactEmail = ""): ApplyWizardPayload {
  return {
    companyName: "",
    website: "",
    truckCount: "",
    truckSize: "",
    primaryLanes: "",
    fmsProvider: "",
    fmsOther: "",
    contactEmail,
    contactName: "",
    contactPhone: "",
    contactTitle: "",
    notes: "",
    dataAuthorizerName: "",
    dataAuthorizerEmail: "",
    safetyContactName: "",
    safetyContactEmail: "",
    tabletModel: "",
    tabletCount: "",
    tabletManagement: "",
  };
}

/** A whole number typed as digits, from `min` to MAX_COUNT, else null. */
export function parseCount(value: string | undefined, min: number): number | null {
  const s = (value ?? "").trim();
  if (!/^\d{1,7}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= MAX_COUNT ? n : null;
}

export function isValidEmail(value: string | undefined): boolean {
  const email = value?.trim() ?? "";
  // Practical check: HTML type=email is UX only; submit must not accept "a@b".
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function isKnownProvider(value: string): boolean {
  return (ELD_PROVIDERS as readonly string[]).includes(value);
}

function isTabletManager(value: string | null | undefined): value is TabletManager {
  return (TABLET_MANAGERS as readonly string[]).includes(value ?? "");
}

export type WizardErrors = Partial<Record<keyof ApplyWizardPayload, string>>;

/**
 * What still stops the form from being sent. Required fields: name, company,
 * work email, phone, truck count, provider (and its name for Other), sites
 * or lanes. The people and tablet answers are optional, but an email or a
 * tablet count that is typed must be valid.
 */
export function wizardErrors(data: ApplyWizardPayload): WizardErrors {
  const errors: WizardErrors = {};
  const blank = (v: string | undefined) => !v?.trim();
  if (blank(data.contactName)) errors.contactName = "Enter your name.";
  if (blank(data.companyName)) errors.companyName = "Enter your company name.";
  if (!isValidEmail(data.contactEmail)) errors.contactEmail = "Enter a valid work email.";
  if (blank(data.contactPhone)) errors.contactPhone = "Enter a phone number.";
  if (parseCount(data.truckCount, 1) === null) {
    errors.truckCount = "Enter the number of trucks, 1 to 1,000,000.";
  }
  if (!isKnownProvider(data.fmsProvider)) errors.fmsProvider = "Choose your ELD or telematics provider.";
  if (data.fmsProvider === "Other" && blank(data.fmsOther)) errors.fmsOther = "Name your provider.";
  if (blank(data.primaryLanes)) errors.primaryLanes = "Enter your domicile sites or main lanes.";
  if (!blank(data.dataAuthorizerEmail) && !isValidEmail(data.dataAuthorizerEmail)) {
    errors.dataAuthorizerEmail = "Enter a valid email.";
  }
  if (!blank(data.safetyContactEmail) && !isValidEmail(data.safetyContactEmail)) {
    errors.safetyContactEmail = "Enter a valid email.";
  }
  if (!blank(data.tabletCount) && parseCount(data.tabletCount, 0) === null) {
    errors.tabletCount = "Enter a number, 0 to 1,000,000.";
  }
  return errors;
}

function textOrNull(value: string | undefined): string | null {
  return value?.trim() || null;
}

/**
 * The row the applicant inserts. Only these columns are granted to applicants
 * (migration 026), so a key added here needs a migration too. fleet_size
 * repeats the truck count as text for the screens that print it; the
 * database requires the two to match.
 */
export function pilotInsertFromWizard(
  userId: string,
  data: ApplyWizardPayload
): Record<string, unknown> {
  const trucks = parseCount(data.truckCount, 1);
  const provider = isKnownProvider(data.fmsProvider) ? data.fmsProvider : null;
  return {
    user_id: userId,
    company_name: data.companyName.trim(),
    truck_size: textOrNull(data.truckSize),
    fleet_size: trucks === null ? null : String(trucks),
    truck_count: trucks,
    website: textOrNull(data.website),
    primary_lanes: textOrNull(data.primaryLanes),
    fms_provider: provider,
    fms_other: provider === "Other" ? textOrNull(data.fmsOther) : null,
    contact_name: data.contactName.trim(),
    contact_email: data.contactEmail.trim(),
    contact_phone: textOrNull(data.contactPhone),
    contact_title: textOrNull(data.contactTitle),
    application_notes: textOrNull(data.notes),
    data_authorizer_name: textOrNull(data.dataAuthorizerName),
    data_authorizer_email: textOrNull(data.dataAuthorizerEmail),
    safety_contact_name: textOrNull(data.safetyContactName),
    safety_contact_email: textOrNull(data.safetyContactEmail),
    tablet_model: textOrNull(data.tabletModel),
    tablet_count: parseCount(data.tabletCount, 0),
    tablet_management: isTabletManager(data.tabletManagement) ? data.tabletManagement : null,
    status: "pending",
  };
}

type AnswerFields = Pick<
  PilotApplicationRow,
  | "fleet_size"
  | "truck_count"
  | "fms_provider"
  | "fms_other"
  | "primary_lanes"
  | "data_authorizer_name"
  | "data_authorizer_email"
  | "safety_contact_name"
  | "safety_contact_email"
  | "tablet_model"
  | "tablet_count"
  | "tablet_management"
>;

/** The exact truck count, or the size bucket an older application holds. */
export function trucksText(app: Pick<AnswerFields, "truck_count" | "fleet_size">): string | null {
  if (typeof app.truck_count === "number") return app.truck_count.toLocaleString("en-US");
  return app.fleet_size?.trim() || null;
}

/** "Samsara", or "Other (Fleet Complete)". */
export function providerText(app: Pick<AnswerFields, "fms_provider" | "fms_other">): string | null {
  if (!app.fms_provider) return null;
  return app.fms_other ? `${app.fms_provider} (${app.fms_other})` : app.fms_provider;
}

/** The provider to name in sentences: the typed name for Other, nothing for None. */
export function providerName(app: Pick<AnswerFields, "fms_provider" | "fms_other">): string | null {
  if (!app.fms_provider || app.fms_provider === "None") return null;
  if (app.fms_provider === "Other") return app.fms_other?.trim() || null;
  return app.fms_provider;
}

export function personText(name: string | null | undefined, email: string | null | undefined): string | null {
  return [name?.trim(), email?.trim()].filter(Boolean).join(", ") || null;
}

/** "120 tablets, Samsung Galaxy Tab Active5, managed through the fleet's MDM". */
export function tabletsText(
  app: Pick<AnswerFields, "tablet_count" | "tablet_model" | "tablet_management">
): string | null {
  const parts: string[] = [];
  if (typeof app.tablet_count === "number") {
    parts.push(`${app.tablet_count.toLocaleString("en-US")} ${app.tablet_count === 1 ? "tablet" : "tablets"}`);
  }
  if (app.tablet_model?.trim()) parts.push(app.tablet_model.trim());
  if (isTabletManager(app.tablet_management)) parts.push(TABLET_MANAGER_TEXT[app.tablet_management]);
  return parts.length ? parts.join(", ") : null;
}

/**
 * The answers a pilot needs, as label and value, empty ones left out. The
 * admin application dialog and the fleet's own summary both show these.
 */
export function applicationAnswers(app: AnswerFields): [string, string][] {
  const rows: [string, string | null][] = [
    ["Trucks", trucksText(app)],
    ["ELD or telematics", providerText(app)],
    ["Sites or lanes", app.primary_lanes?.trim() || null],
    ["Authorizes data access", personText(app.data_authorizer_name, app.data_authorizer_email)],
    ["Safety contact", personText(app.safety_contact_name, app.safety_contact_email)],
    ["Tablets", tabletsText(app)],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]);
}

export const PILOT_STATUS_LABELS: Record<PilotLifecycleStatus, string> = {
  pending: "received and queued for review",
  in_review: "under review",
  approved: "approved",
  onboarding: "in onboarding",
  active: "live and active",
  denied: "not selected for the current cohort",
  archived: "archived",
};
