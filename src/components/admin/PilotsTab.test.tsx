// @vitest-environment jsdom
//
// Admin Pilots tab, the approval (CRU-90, migration 027):
//   - Approve saves a changed message first (no status, no review stamp),
//     then calls approve_pilot_application, then shows the fleet:create
//     command with both ids, which Copy puts on the clipboard
//   - Save on an application already set to approved without an
//     organization runs the same approval, never a bare status update
//   - a refused approval shows the reason and no portal step, and puts back
//     a message it had saved first: what the row held just before that save
//     (re-read then, so another admin's edit made while the dialog was open
//     comes back, not the dialog's stale copy), and only into a field the row
//     still holds as saved (review 155-5)
//   - an approval that created an organization names the other organizations
//     with the same company name above the portal step (review 155-3)
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
    for (const m of ["order", "limit", "eq", "maybeSingle"]) {
      builder[m] = () => builder;
    }
    builder.select = (columns: unknown) => {
      events.push({ kind: "select", table, payload: columns });
      return builder;
    };
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
  // From here on, only what the test's own clicks do.
  sb.events.length = 0;
}

// The dialog's read of the row's notes and message, and a row it returns.
const READ = { kind: "select", table: "pilot_applications", payload: "notes, fleet_visible_message" };
const rowNow = (notes: string | null, fleet_visible_message: string | null): Result => ({
  data: { notes, fleet_visible_message },
  error: null,
});
const OK: Result = { data: null, error: null };
const REFUSED: Result = { data: null, error: { code: "22023", message: "approve_pilot_application: no" } };

describe("PilotsTab approval", () => {
  it("saves the message first, then approves, then shows the fleet:create command", async () => {
    await openDialog(app());
    sb.queues.pilot_applications.push(rowNow(null, null), OK);
    sb.rpcResults.push({ data: approval(), error: null });

    fireEvent.change(screen.getByPlaceholderText(/Kickoff call link/), { target: { value: "Welcome aboard." } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect((await screen.findByTestId("fleet-create-command")).textContent).toBe(COMMAND);
    expect(sb.events.map((e) => e.kind)).toEqual(["select", "update", "rpc"]);
    expect(sb.events[0]).toEqual(READ);
    expect(sb.events[1].payload).toEqual({ notes: "", fleet_visible_message: "Welcome aboard." });
    expect(sb.events[2].payload).toEqual({ fn: "approve_pilot_application", args: { application_id: APP } });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByTestId("same-name-organizations")).toBeNull();

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
    sb.queues.pilot_applications.push(rowNow("kept", "Old note"), OK, rowNow("kept", "You're approved!"), OK);
    sb.rpcResults.push(REFUSED);
    fireEvent.change(screen.getByPlaceholderText(/Kickoff call link/), { target: { value: "You're approved!" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sb.events.map((e) => e.kind)).toEqual(["select", "update", "rpc", "select", "update"]));
    expect(sb.events[1].payload).toEqual({ notes: "kept", fleet_visible_message: "You're approved!" });
    expect(sb.events[3]).toEqual(READ);
    // Only the field the save changed goes back.
    expect(sb.events[4].payload).toEqual({ fleet_visible_message: "Old note" });
    expect(toastMock.error).toHaveBeenCalledWith(
      "Not approved: approve_pilot_application: no Notes and message were not saved; your text is still here."
    );
    expect(screen.queryByTestId("fleet-create-command")).toBeNull();
    expect(screen.getByDisplayValue("You're approved!")).toBeTruthy();
  });

  it("puts back what the row held just before the save, not the copy from when the dialog opened", async () => {
    // The dialog opened on "Old note"; another admin then wrote "Their note".
    await openDialog(app({ fleet_visible_message: "Old note", notes: "kept" }));
    sb.queues.pilot_applications.push(rowNow("kept", "Their note"), OK, rowNow("kept", "You're approved!"), OK);
    sb.rpcResults.push(REFUSED);
    fireEvent.change(screen.getByPlaceholderText(/Kickoff call link/), { target: { value: "You're approved!" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sb.events.map((e) => e.kind)).toEqual(["select", "update", "rpc", "select", "update"]));
    expect(sb.events[0]).toEqual(READ);
    expect(sb.events[4].payload).toEqual({ fleet_visible_message: "Their note" });
  });

  it("leaves a field someone else changed after the save, and still puts back the other", async () => {
    await openDialog(app({ fleet_visible_message: "Old note", notes: "kept" }));
    // Both fields saved; then someone else rewrote the message before the refusal.
    sb.queues.pilot_applications.push(rowNow("kept", "Old note"), OK, rowNow("new notes", "Changed meanwhile"), OK);
    sb.rpcResults.push(REFUSED);
    fireEvent.change(screen.getByPlaceholderText(/Kickoff call link/), { target: { value: "You're approved!" } });
    fireEvent.change(screen.getByPlaceholderText(/Disposition/), { target: { value: "new notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sb.events.map((e) => e.kind)).toEqual(["select", "update", "rpc", "select", "update"]));
    expect(sb.events[1].payload).toEqual({ notes: "new notes", fleet_visible_message: "You're approved!" });
    expect(sb.events[4].payload).toEqual({ notes: "kept" });
    expect(toastMock.error).toHaveBeenCalledWith(
      "Not approved: approve_pilot_application: no Notes and message were not saved. " +
        "Someone else changed the message meanwhile, so their text was kept; yours is still here."
    );
  });

  it("writes nothing back when someone else changed every field it saved", async () => {
    await openDialog(app({ fleet_visible_message: "Old note", notes: "kept" }));
    sb.queues.pilot_applications.push(rowNow("kept", "Old note"), OK, rowNow("kept", "Changed meanwhile"));
    sb.rpcResults.push(REFUSED);
    fireEvent.change(screen.getByPlaceholderText(/Kickoff call link/), { target: { value: "You're approved!" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(sb.events.map((e) => e.kind)).toEqual(["select", "update", "rpc", "select"]);
  });

  it("saves nothing and does not approve when the row cannot be read first", async () => {
    await openDialog(app({ fleet_visible_message: "Old note" }));
    sb.queues.pilot_applications.push({ data: null, error: { message: "network down" } });
    fireEvent.change(screen.getByPlaceholderText(/Kickoff call link/), { target: { value: "You're approved!" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Not approved: the application could not be read. Nothing was saved; try again."
      )
    );
    expect(sb.events.map((e) => e.kind)).toEqual(["select"]);
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("names other organizations of the same company above the portal step", async () => {
    const DUP = "30000000-0000-0000-0000-00000000000b";
    await openDialog(app({ company_name: "Dup Freight" }));
    sb.rpcResults.push({
      data: approval({
        organization_name: "Dup Freight",
        same_name_organizations: [{ id: DUP, name: "Dup Freight LLC", org_type: "fleet", status: "active" }],
      }),
      error: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const warning = await screen.findByTestId("same-name-organizations");
    expect(warning.textContent).toContain(`Dup Freight LLC (fleet, active): ${DUP}`);
    expect(warning.textContent).toContain("link the applicant to it by hand before you run the command below");
    expect(screen.getByTestId("fleet-create-command")).toBeTruthy();
    expect(toastMock.success).toHaveBeenCalledWith(
      "Approved. The fleet's organization is created. Another organization has the same name: check it before the portal step."
    );
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
    const updates = () => sb.events.filter((e) => e.kind === "update");
    await waitFor(() => expect(updates().length).toBe(1));
    expect(updates()[0].ids).toEqual([other.id]);
    expect((updates()[0].payload as { status: string }).status).toBe("onboarding");
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
