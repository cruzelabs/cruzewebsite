// @vitest-environment jsdom
//
// /apply, end to end in the browser with Supabase faked:
//   - the LOI text, the I Agree line, the application row and the LOI row all
//     carry the truck count the applicant typed (CRU-90: the LOI names it)
//   - changing the truck count after I Agree clears the box
//   - the button stays off until the required answers are in
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

type Result = { data: unknown; error: { code?: string; message: string } | null };

const sb = vi.hoisted(() => {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const results: Record<string, Result[]> = {};
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "maybeSingle", "single"]) {
      builder[m] = () => builder;
    }
    builder.insert = (row: Record<string, unknown>) => {
      inserts.push({ table, row });
      return builder;
    };
    builder.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(results[table]?.shift() ?? { data: null, error: null }).then(resolve, reject);
    return builder;
  };
  return {
    inserts,
    results,
    from: vi.fn(from),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    invoke: vi.fn(async () => ({ data: null, error: null })),
  };
});

vi.mock("@/lib/supabase", () => ({
  supabase: { from: sb.from, rpc: sb.rpc, functions: { invoke: sb.invoke } },
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "00000000-0000-0000-0000-0000000000c1", email: "dana@acme.example" } }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/marketing/MarketingLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/SEO", () => ({ default: () => null }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// The provider is picked from a Radix select, which jsdom cannot open, so the
// restored draft brings it, as a draft does after the sign-in round trip.
const drafts = vi.hoisted(() => ({
  loadWizardDraft: vi.fn(),
  scheduleDraftPersist: vi.fn(),
  saveSessionDraft: vi.fn(),
  clearAllDrafts: vi.fn(async () => {}),
}));
vi.mock("@/lib/applyDraft", () => drafts);

import Apply from "./Apply";
import { blankWizard } from "@/lib/pilotApplication";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sb.inserts.length = 0;
  for (const k of Object.keys(sb.results)) delete sb.results[k];
});

async function renderApply() {
  drafts.loadWizardDraft.mockResolvedValue({
    ...blankWizard("dana@acme.example"),
    fmsProvider: "Omnitracs",
    loiAgreed: false,
    loiInitials: "",
  });
  render(
    <MemoryRouter>
      <Apply />
    </MemoryRouter>
  );
  await waitFor(() => expect(drafts.loadWizardDraft).toHaveBeenCalled());
  await act(async () => {});
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const agree = () => screen.getByRole("checkbox");
const submitButton = () => screen.getByRole("button", { name: /sign & submit/i });

function fillRequired(trucks: string) {
  type("Your name *", "Dana Lee");
  type("Company name *", "Acme Freight");
  type("Phone *", "210-555-0100");
  type("How many trucks? *", trucks);
  type("Domicile sites or main lanes *", "Laredo yard; I-35 Laredo to Dallas");
}

describe("Apply", () => {
  it("puts the typed truck count in the LOI text, the application and the signed LOI", async () => {
    sb.results.pilot_applications = [
      { data: null, error: null }, // no earlier application
      { data: { id: "40000000-0000-0000-0000-000000000001" }, error: null },
    ];
    sb.results.loi_signatures = [{ data: { id: "50000000-0000-0000-0000-000000000001" }, error: null }];
    await renderApply();

    fillRequired("0172");
    type("Who can authorize access to your ELD data?", "Ira Ops");
    type("Model", "Galaxy Tab Active5");

    fireEvent.click(screen.getByText(/read the full loi text/i));
    expect(screen.getByText(/Fleet Integration: 172 vehicles shall be enrolled\./)).toBeTruthy();

    expect(submitButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(agree());
    expect(screen.getByText(/I accept the Letter of Intent/).textContent).toMatch(/Acme Freight for 172 trucks\./);
    expect(submitButton().hasAttribute("disabled")).toBe(false);

    fireEvent.click(submitButton());
    await waitFor(() => expect(sb.inserts.map((i) => i.table)).toEqual(["pilot_applications", "loi_signatures"]));

    const [app, loi] = sb.inserts.map((i) => i.row);
    expect(app).toMatchObject({
      truck_count: 172,
      fleet_size: "172",
      fms_provider: "Omnitracs",
      primary_lanes: "Laredo yard; I-35 Laredo to Dallas",
      data_authorizer_name: "Ira Ops",
      tablet_model: "Galaxy Tab Active5",
      status: "pending",
    });
    expect(loi.fleet_size).toBe("172");
    expect(loi.pilot_application_id).toBe("40000000-0000-0000-0000-000000000001");
    expect(String(loi.loi_full_text)).toContain("Fleet Integration: 172 vehicles shall be enrolled.");
    expect(String(loi.loi_full_text)).toContain("AND: Acme Freight (The Participant)");
  });

  it("clears I Agree when the truck count changes after agreeing", async () => {
    await renderApply();
    fillRequired("172");
    fireEvent.click(agree());
    expect(agree().getAttribute("aria-checked")).toBe("true");

    type("How many trucks? *", "180");
    expect(agree().getAttribute("aria-checked")).toBe("false");
    expect(submitButton().hasAttribute("disabled")).toBe(true);
  });

  it("keeps the button off without sites or lanes, and keeps digits only in the count", async () => {
    await renderApply();
    fillRequired("1,200 trucks");
    expect((screen.getByLabelText("How many trucks? *") as HTMLInputElement).value).toBe("1200");
    type("Domicile sites or main lanes *", "  ");
    fireEvent.click(agree());
    expect(submitButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Fill in the fields marked * and check I Agree.")).toBeTruthy();
  });

  it("shows a typed optional email that is not valid", async () => {
    await renderApply();
    type("Who can authorize access to your ELD data?", "Ira Ops");
    fireEvent.change(screen.getAllByLabelText("Their email")[0], { target: { value: "ira@" } });
    expect(screen.getByText("Enter a valid email.")).toBeTruthy();
  });
});
