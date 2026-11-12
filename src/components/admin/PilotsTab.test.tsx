// @vitest-environment jsdom
//
// Admin Pilots tab, the approval (CRU-90, migration 027):
//   - Approve saves a changed message first (no status, no review stamp),
//     then calls approve_pilot_application, then shows the fleet:create
//     command with both ids, which Copy puts on the clipboard
//   - Save on an application already set to approved without an
//     organization runs the same approval, never a bare status update
//   - a refused approval shows the reason and no portal step, and puts back
//     a message it had saved first
//   - a denied application offers no Approve; Save on a later stage with no
//     organization approves it and keeps the stage
//   - bulk onboarding skips applications without an organization
//   - reopening an approved application shows the step with the
//     organization's own name, and no Approve button
//   - the bulk bar offers no approve
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

type Result = { data: unknown; error: { code?: string; message: string } | null };

const sb = vi.hoisted(() => {
  const queues: Record<string, Result[]> = {};
  const events: { kind: string; table?: string; payload?: unknown; ids?: unknown }[] = [];
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    let last: { ids?: unknown } | null = null;
    for (const m of ["select", "order", "limit", "eq", "maybeSingle"]) {
      builder[m] = () => builder;
    }
    builder.in = (_col: string, ids: unknown) => {
      if (last) last.ids = ids;
      return builder;
    };
    builder.update = (payload: unknown) => {
      last = { kind: "update", table, payload } as { ids?: unknown };
      events.push(last as { kind: string });
      return builder;
    };
    builder.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queues[table]?.shift() ?? { data: null, error: null }).then(resolve, reject);
    return builder;
  };
  const rpcResults: Result[] = [];
  const rpc = vi.fn(async (fn: string, args: unknown) => {
    events.push({ kind: "rpc", payload: { fn, args } });
    return rpcResults.shift() ?? { data: null, error: null };
  });
  return { queues, events, rpcResults, from: vi.fn(from), rpc };
});

vi.mock("@/lib/supabase", () => ({
  supabase: { from: sb.from, rpc: sb.rpc, auth: { getSession: async () => ({ data: { session: null } }) } },
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import PilotsTab from "./PilotsTab";

const APP = "40000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-0000000000c1";
const ORG = "30000000-0000-0000-0000-00000000000a";

const app = (over: Record<string, unknown> = {}) => ({
  id: APP,
  user_id: USER,
  company_name: "Acme Freight",
  truck_size: null,
  fleet_size: "172",
  truck_count: 172,
  status: "pending",
  website: null,
  primary_lanes: "Laredo yard",
  fms_provider: "Omnitracs",
  fms_other: null,
  contact_name: "Dana Lee",
  contact_email: "dana@acme.example",
  contact_phone: null,
  contact_title: null,
  application_notes: null,
  data_authorizer_name: null,
  data_authorizer_email: null,
  tablet_model: null,
  tablet_count: null,
  tablet_management: null,
  safety_contact_name: null,
  safety_contact_email: null,
  fleet_visible_message: null,
  notes: null,
  organization_id: null,
  created_at: "2026-11-12T12:00:00Z",
  reviewed_at: null,
  ...over,
});

const approval = (over: Record<string, unknown> = {}) => ({
  application_id: APP,
  application_status: "approved",
  organization_id: ORG,
  organization_name: "Acme Freight",
  organization_created: true,
  owner_id: USER,
  ...over,
});

const COMMAND = `npm run fleet:create -- --name 'Acme Freight' --organization ${ORG} --owner ${USER}`;
const writeText = vi.fn(async () => {});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sb.events.length = 0;
  sb.rpcResults.length = 0;
  for (const k of Object.keys(sb.queues)) delete sb.queues[k];
});

async function openDialog(row: Record<string, unknown>) {
  sb.queues.pilot_applications = [{ data: [row], error: null }];
  sb.queues.loi_signatures = [{ data: [], error: null }];
  render(
    <MemoryRouter>
      <PilotsTab isDemo={false} />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole("button", { name: String(row.company_name) }));
  await screen.findByText("Lifecycle stage");
}

describe("PilotsTab approval", () => {
  it("saves the message first, then approves, then shows the fleet:create command", async () => {
    await openDialog(app());
    sb.queues.pilot_applications.push({ data: null, error: null });
    sb.rpcResults.push({ data: approval(), error: null });

    fireEvent.change(screen.getByPlaceholderText(/Kickoff call link/), { target: { value: "Welcome aboard." } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect((await screen.findByTestId("fleet-create-command")).textContent).toBe(COMMAND);
    expect(sb.events.map((e) => e.kind)).toEqual(["update", "rpc"]);
    expect(sb.events[0].payload).toEqual({ notes: "", fleet_visible_message: "Welcome aboard." });
    expect(sb.events[1].payload).toEqual({ fn: "approve_pilot_application", args: { application_id: APP } });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /copy command/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COMMAND));
  });

  it("calls only the function when nothing else changed", async () => {
    await openDialog(app());
    sb.rpcResults.push({ data: approval(), error: null });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByTestId("fleet-create-command");
    expect(sb.events.map((e) => e.kind)).toEqual(["rpc"]);
  });

  it("runs the same approval when Save is pressed on an approved application with no organization", async () => {
    await openDialog(app({ status: "approved" }));
    sb.rpcResults.push({ data: approval({ organization_created: true }), error: null });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByTestId("fleet-create-command")).textContent).toBe(COMMAND);
    expect(sb.events.map((e) => e.kind)).toEqual(["rpc"]);
  });

  it("puts a pre-saved message back when the approval is refused", async () => {
    await openDialog(app({ fleet_visible_message: "Old note", notes: "kept" }));
    sb.queues.pilot_applications.push({ data: null, error: null }, { data: null, error: null });
    sb.rpcResults.push({ data: null, error: { code: "22023", message: "approve_pilot_application: no" } });
    fireEvent.change(screen.getByPlaceholderText(/Kickoff call link/), { target: { value: "You're approved!" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sb.events.map((e) => e.kind)).toEqual(["update", "rpc", "update"]));
    expect(sb.events[0].payload).toEqual({ notes: "kept", fleet_visible_message: "You're approved!" });
    expect(sb.events[2].payload).toEqual({ notes: "kept", fleet_visible_message: "Old note" });
    expect(screen.queryByTestId("fleet-create-command")).toBeNull();
  });

  it("offers no Approve on a denied application", async () => {
    await openDialog(app({ status: "denied" }));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("approves a later-stage application with no organization on Save, keeping its stage", async () => {
    await openDialog(app({ status: "onboarding" }));
    sb.rpcResults.push({ data: approval({ application_status: "onboarding" }), error: null });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByTestId("fleet-create-command")).textContent).toBe(COMMAND);
    expect(sb.events.map((e) => e.kind)).toEqual(["rpc"]);
  });

  it("bulk onboarding skips applications without an organization", async () => {
    const other = app({ id: "40000000-0000-0000-0000-000000000002", company_name: "Beta Freight", status: "approved", organization_id: ORG });
    sb.queues.pilot_applications = [{ data: [app(), other], error: null }, { data: null, error: null }];
    sb.queues.loi_signatures = [{ data: [], error: null }];
    render(
      <MemoryRouter>
        <PilotsTab isDemo={false} />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Acme Freight" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta Freight" }));
    fireEvent.click(screen.getByRole("button", { name: "→ onboarding" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await waitFor(() => expect(sb.events.length).toBe(1));
    expect(sb.events[0].ids).toEqual([other.id]);
    expect((sb.events[0].payload as { status: string }).status).toBe("onboarding");
  });

  it("shows why an approval was refused, and no portal step", async () => {
    await openDialog(app());
    sb.rpcResults.push({
      data: null,
      error: { code: "22023", message: "approve_pilot_application: the applicant's account is archived." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Not approved: approve_pilot_application: the applicant's account is archived."
      )
    );
    expect(screen.queryByTestId("fleet-create-command")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("shows the step again on an approved application, with the organization's own name", async () => {
    sb.queues.organizations = [{ data: { id: ORG, name: "Acme Freight Holdings" }, error: null }];
    await openDialog(app({ status: "onboarding", organization_id: ORG }));
    expect((await screen.findByTestId("fleet-create-command")).textContent).toBe(
      `npm run fleet:create -- --name 'Acme Freight Holdings' --organization ${ORG} --owner ${USER}`
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("quotes a company name so pasting the command runs nothing", async () => {
    await openDialog(app({ company_name: "Joe's $(rm -rf ~) Freight" }));
    sb.rpcResults.push({ data: approval({ organization_name: "Joe's $(rm -rf ~) Freight" }), error: null });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect((await screen.findByTestId("fleet-create-command")).textContent).toBe(
      `npm run fleet:create -- --name 'Joe'\\''s $(rm -rf ~) Freight' --organization ${ORG} --owner ${USER}`
    );
  });

  it("offers no bulk approve", async () => {
    sb.queues.pilot_applications = [{ data: [app()], error: null }];
    sb.queues.loi_signatures = [{ data: [], error: null }];
    render(
      <MemoryRouter>
        <PilotsTab isDemo={false} />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Acme Freight" }));
    expect(screen.getByRole("button", { name: "→ in review" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "→ approved" })).toBeNull();
  });
});
