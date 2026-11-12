import { describe, it, expect } from "vitest";
import {
  PILOT_LIFECYCLE,
  TERMINAL_PILOT_STATUSES,
  PILOT_STATUS_LABELS,
  ELD_PROVIDERS,
  applicationAnswers,
  blankWizard,
  parseCount,
  pilotInsertFromWizard,
  providerName,
  tabletsText,
  trucksText,
  wizardErrors,
  type ApplyWizardPayload,
} from "./pilotApplication";

const fullPayload: ApplyWizardPayload = {
  ...blankWizard(),
  companyName: "Coastal Transport",
  website: "https://coastal.example",
  truckCount: "120",
  truckSize: "Class 8",
  primaryLanes: "I-35 SA-Laredo",
  fmsProvider: "Samsara",
  fmsOther: "",
  contactEmail: "ops@coastal.example",
  contactName: "Sam Patel",
  contactPhone: "210-555-0100",
  contactTitle: "Ops Director",
  notes: "Petroleum tankers",
  dataAuthorizerName: "Ira Ops",
  dataAuthorizerEmail: "ira@coastal.example",
  safetyContactName: "Sal Safety",
  safetyContactEmail: "sal@coastal.example",
  tabletModel: "Galaxy Tab Active5",
  tabletCount: "110",
  tabletManagement: "fleet_mdm",
};

describe("pilotInsertFromWizard", () => {
  it("maps the core wizard fields onto the DB row shape", () => {
    const row = pilotInsertFromWizard("user-123", fullPayload);
    expect(row.user_id).toBe("user-123");
    expect(row.company_name).toBe("Coastal Transport");
    expect(row.truck_size).toBe("Class 8");
    expect(row.contact_name).toBe("Sam Patel");
    expect(row.contact_email).toBe("ops@coastal.example");
    expect(row.application_notes).toBe("Petroleum tankers");
  });

  it("stores the exact truck count, and fleet_size as the same number in text", () => {
    const row = pilotInsertFromWizard("u", { ...fullPayload, truckCount: "0172" });
    expect(row.truck_count).toBe(172);
    expect(row.fleet_size).toBe("172");
  });

  it("stores every answer from the new form, none of them as null", () => {
    const row = pilotInsertFromWizard("u", fullPayload);
    expect(row).toMatchObject({
      truck_count: 120,
      fms_provider: "Samsara",
      primary_lanes: "I-35 SA-Laredo",
      data_authorizer_name: "Ira Ops",
      data_authorizer_email: "ira@coastal.example",
      safety_contact_name: "Sal Safety",
      safety_contact_email: "sal@coastal.example",
      tablet_model: "Galaxy Tab Active5",
      tablet_count: 110,
      tablet_management: "fleet_mdm",
    });
  });

  it("sends only columns the applicant may insert (migration 026's grant)", () => {
    const granted = [
      "user_id", "company_name", "truck_size", "fleet_size", "website", "primary_lanes",
      "fms_provider", "fms_other", "contact_name", "contact_email", "contact_phone",
      "contact_title", "application_notes", "status",
      "truck_count", "data_authorizer_name", "data_authorizer_email", "tablet_model",
      "tablet_count", "tablet_management", "safety_contact_name", "safety_contact_email",
    ];
    expect(Object.keys(pilotInsertFromWizard("u", fullPayload)).sort()).toEqual(granted.sort());
  });

  it("always inserts as 'pending'", () => {
    expect(pilotInsertFromWizard("u", fullPayload).status).toBe("pending");
  });

  it("coerces empty optional strings to null", () => {
    const sparse: ApplyWizardPayload = {
      ...fullPayload,
      website: "",
      primaryLanes: "",
      contactPhone: "",
      contactTitle: "",
      notes: "",
      dataAuthorizerName: " ",
      dataAuthorizerEmail: "",
      safetyContactName: "",
      safetyContactEmail: "",
      tabletModel: "",
      tabletCount: "",
      tabletManagement: "",
    };
    const row = pilotInsertFromWizard("u", sparse);
    expect(row.website).toBeNull();
    expect(row.primary_lanes).toBeNull();
    expect(row.contact_phone).toBeNull();
    expect(row.contact_title).toBeNull();
    expect(row.application_notes).toBeNull();
    for (const key of [
      "data_authorizer_name", "data_authorizer_email", "safety_contact_name", "safety_contact_email",
      "tablet_model", "tablet_count", "tablet_management",
    ]) {
      expect(row[key], key).toBeNull();
    }
  });

  it("keeps a tablet count of zero and drops an unknown tablet manager", () => {
    const row = pilotInsertFromWizard("u", { ...fullPayload, tabletCount: "0", tabletManagement: "unsure" });
    expect(row.tablet_count).toBe(0);
    expect(row.tablet_management).toBeNull();
  });

  it("only records fms_other when the provider is exactly 'Other'", () => {
    const namedProvider = pilotInsertFromWizard("u", {
      ...fullPayload,
      fmsProvider: "Samsara",
      fmsOther: "ShouldBeIgnored",
    });
    expect(namedProvider.fms_provider).toBe("Samsara");
    expect(namedProvider.fms_other).toBeNull();

    const otherProvider = pilotInsertFromWizard("u", {
      ...fullPayload,
      fmsProvider: "Other",
      fmsOther: "HomegrownTMS",
    });
    expect(otherProvider.fms_provider).toBe("Other");
    expect(otherProvider.fms_other).toBe("HomegrownTMS");
  });

  it("nulls fms_other when provider is 'Other' but no name was typed", () => {
    const row = pilotInsertFromWizard("u", {
      ...fullPayload,
      fmsProvider: "Other",
      fmsOther: "",
    });
    expect(row.fms_other).toBeNull();
  });

  it("drops a provider that is not on the list", () => {
    expect(pilotInsertFromWizard("u", { ...fullPayload, fmsProvider: "Other / multiple" }).fms_provider).toBeNull();
  });
});

describe("parseCount", () => {
  it("takes whole numbers from the minimum to 1,000,000", () => {
    expect(parseCount("1", 1)).toBe(1);
    expect(parseCount(" 172 ", 1)).toBe(172);
    expect(parseCount("1000000", 1)).toBe(1_000_000);
    expect(parseCount("0", 0)).toBe(0);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "0", "1000001", "-4", "1.5", "1,200", "12a", "1e3", undefined]) {
      expect(parseCount(bad, 1), String(bad)).toBeNull();
    }
  });
});

describe("wizardErrors", () => {
  it("passes a complete form", () => {
    expect(wizardErrors(fullPayload)).toEqual({});
  });

  it("passes with the optional people and tablet answers left empty", () => {
    const minimal: ApplyWizardPayload = {
      ...blankWizard("ops@coastal.example"),
      contactName: "Sam",
      companyName: "Coastal",
      contactPhone: "210",
      truckCount: "3",
      fmsProvider: "None",
      primaryLanes: "Houston yard",
    };
    expect(wizardErrors(minimal)).toEqual({});
  });

  it("requires name, company, email, phone, trucks, provider and sites", () => {
    expect(Object.keys(wizardErrors(blankWizard())).sort()).toEqual(
      ["companyName", "contactEmail", "contactName", "contactPhone", "fmsProvider", "primaryLanes", "truckCount"].sort()
    );
  });

  it("needs the provider's name when the provider is Other", () => {
    expect(wizardErrors({ ...fullPayload, fmsProvider: "Other", fmsOther: " " }).fmsOther).toBeTruthy();
    expect(wizardErrors({ ...fullPayload, fmsProvider: "Other", fmsOther: "Fleet Complete" })).toEqual({});
  });

  it("refuses a truck count of zero or over a million", () => {
    expect(wizardErrors({ ...fullPayload, truckCount: "0" }).truckCount).toBeTruthy();
    expect(wizardErrors({ ...fullPayload, truckCount: "1000001" }).truckCount).toBeTruthy();
  });

  it("checks optional emails and the tablet count only when typed", () => {
    const errors = wizardErrors({
      ...fullPayload,
      dataAuthorizerEmail: "ira@",
      safetyContactEmail: "a@b",
      tabletCount: "1000001",
    });
    expect(Object.keys(errors).sort()).toEqual(["dataAuthorizerEmail", "safetyContactEmail", "tabletCount"]);
  });
});

describe("application answers as staff and the fleet read them", () => {
  const row = pilotInsertFromWizard("u", { ...fullPayload, truckCount: "1200" }) as Parameters<
    typeof applicationAnswers
  >[0];

  it("lists every answer with a plain label", () => {
    expect(applicationAnswers(row)).toEqual([
      ["Trucks", "1,200"],
      ["ELD or telematics", "Samsara"],
      ["Sites or lanes", "I-35 SA-Laredo"],
      ["Authorizes data access", "Ira Ops, ira@coastal.example"],
      ["Safety contact", "Sal Safety, sal@coastal.example"],
      ["Tablets", "110 tablets, Galaxy Tab Active5, managed through the fleet's MDM"],
    ]);
  });

  it("leaves out what was not answered", () => {
    const sparse = { ...row, primary_lanes: null, data_authorizer_name: null, data_authorizer_email: null };
    expect(applicationAnswers(sparse).map(([label]) => label)).toEqual([
      "Trucks", "ELD or telematics", "Safety contact", "Tablets",
    ]);
  });

  it("falls back to the size bucket of an older application", () => {
    expect(trucksText({ truck_count: null, fleet_size: "101-500" })).toBe("101-500");
    expect(trucksText({ truck_count: null, fleet_size: null })).toBeNull();
  });

  it("names the provider in sentences, never 'Other' or 'None'", () => {
    expect(providerName({ fms_provider: "Omnitracs", fms_other: null })).toBe("Omnitracs");
    expect(providerName({ fms_provider: "Other", fms_other: "Fleet Complete" })).toBe("Fleet Complete");
    expect(providerName({ fms_provider: "Other", fms_other: null })).toBeNull();
    expect(providerName({ fms_provider: "None", fms_other: null })).toBeNull();
  });

  it("writes one tablet in the singular and skips an unknown manager", () => {
    expect(tabletsText({ tablet_count: 1, tablet_model: null, tablet_management: "cruze" })).toBe(
      "1 tablet, managed by Cruze"
    );
    expect(tabletsText({ tablet_count: null, tablet_model: null, tablet_management: "someone" })).toBeNull();
  });

  it("offers the eight providers the readiness review lists", () => {
    expect([...ELD_PROVIDERS]).toEqual([
      "Samsara", "Geotab", "Motive", "Verizon Connect", "Trimble", "Omnitracs", "Other", "None",
    ]);
  });
});

describe("pilot lifecycle metadata", () => {
  it("treats only denied/archived as terminal, and both are real statuses", () => {
    expect(TERMINAL_PILOT_STATUSES).toContain("denied");
    expect(TERMINAL_PILOT_STATUSES).toContain("archived");
    for (const s of TERMINAL_PILOT_STATUSES) {
      expect(PILOT_LIFECYCLE).toContain(s);
    }
  });

  it("has a human label for every lifecycle status (no missing/extra keys)", () => {
    const labelKeys = Object.keys(PILOT_STATUS_LABELS).sort();
    const lifecycle = [...PILOT_LIFECYCLE].sort();
    expect(labelKeys).toEqual(lifecycle);
    for (const label of Object.values(PILOT_STATUS_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate lifecycle statuses", () => {
    expect(new Set(PILOT_LIFECYCLE).size).toBe(PILOT_LIFECYCLE.length);
  });
});
