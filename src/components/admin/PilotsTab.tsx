import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Building, Truck, FileSignature, ExternalLink, Copy, CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";
import { applicationAnswers, trucksText, type PilotApplicationRow } from "@/lib/pilotApplication";
import { fleetCreateCommand } from "@/lib/fleetCreate";

const LIFECYCLE = ["pending", "in_review", "approved", "onboarding", "active", "denied", "archived"] as const;
type LifecycleState = (typeof LIFECYCLE)[number];

// Stages that come after approval: the application has its organization.
const APPROVED_STAGES: LifecycleState[] = ["approved", "onboarding", "active"];

type PilotApp = Omit<PilotApplicationRow, "status" | "reviewed_at"> & {
  status: LifecycleState;
  organization_id: string | null;
};

// What approve_pilot_application (migration 027) returns.
type ApprovalResult = {
  application_id: string;
  application_status: LifecycleState;
  organization_id: string;
  organization_name: string;
  organization_created: boolean;
  owner_id: string;
};

/**
 * What approve_pilot_application accepts: a pending or in-review application,
 * or one past approval that still has no organization (from before 027). A
 * denied or archived one goes back to in review first.
 */
function canBeApproved(app: Pick<PilotApp, "status" | "organization_id">): boolean {
  if (app.status === "pending" || app.status === "in_review") return true;
  return APPROVED_STAGES.includes(app.status) && !app.organization_id;
}

const NO_NEW_ANSWERS = {
  truck_count: null,
  data_authorizer_name: null,
  data_authorizer_email: null,
  tablet_model: null,
  tablet_count: null,
  tablet_management: null,
  safety_contact_name: null,
  safety_contact_email: null,
};

// Demo ids are uuid-shaped so the demo shows the fleet:create step too.
const DEMO_APPS: PilotApp[] = [
  {
    id: "p1", user_id: "00000000-0000-4000-8000-0000000000d1", organization_id: null,
    company_name: "Swift Transport Logistics", truck_size: null, fleet_size: "1500",
    status: "pending", notes: null, fleet_visible_message: null, contact_name: "Lori Chen", contact_email: "lori@swift.com",
    contact_phone: null, contact_title: "VP Ops", website: null, primary_lanes: "Phoenix yard; I-10 Phoenix to LA",
    fms_provider: "Samsara", fms_other: null, application_notes: null, created_at: "2026-04-30T10:00:00Z",
    ...NO_NEW_ANSWERS,
    truck_count: 1500, data_authorizer_name: "Dee Fleetadmin", data_authorizer_email: "dee@swift.com",
    safety_contact_name: "Ray Safety", safety_contact_email: "ray@swift.com",
    tablet_model: "Galaxy Tab Active5", tablet_count: 1400, tablet_management: "fleet_mdm",
  },
  {
    id: "p2", user_id: "00000000-0000-4000-8000-0000000000d2", organization_id: null,
    company_name: "National Carrier Partners", truck_size: "Class 6", fleet_size: "350",
    status: "in_review", notes: "Reference call scheduled.", fleet_visible_message: "Reference call Thursday 2pm CT.",
    contact_name: "Sam Patel", contact_email: "ops@national.com", contact_phone: null, contact_title: null,
    website: null, primary_lanes: "Dallas → Houston", fms_provider: "Geotab", fms_other: null, application_notes: null,
    created_at: "2026-04-22T10:00:00Z",
    ...NO_NEW_ANSWERS,
  },
  {
    id: "p3", user_id: "00000000-0000-4000-8000-0000000000d3", organization_id: "30000000-0000-4000-8000-0000000000d3",
    company_name: "Alpha Freight", truck_size: "Class 8", fleet_size: "2000",
    status: "approved", notes: null, fleet_visible_message: "Kickoff scheduled — check your email for the calendar invite.",
    contact_name: "Alex Kim", contact_email: "alex@alpha.com", contact_phone: null, contact_title: "COO",
    website: "https://alpha.example", primary_lanes: null, fms_provider: "Motive", fms_other: null, application_notes: null,
    created_at: "2026-04-15T10:00:00Z",
    ...NO_NEW_ANSWERS,
  },
];

export default function PilotsTab({
  isDemo,
  drillDownToken = 0,
  drillDownStatusFilter,
}: {
  isDemo: boolean;
  drillDownToken?: number;
  drillDownStatusFilter?: string;
}) {
  const [apps, setApps] = useState<PilotApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<PilotApp | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [signedPilotIds, setSignedPilotIds] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [statusFilter, setStatusFilter] = useState<LifecycleState | "all">("all");
  const [bulkConfirmStatus, setBulkConfirmStatus] = useState<LifecycleState | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const applyBulkStatus = async (newStatus: LifecycleState) => {
    if (selected.size === 0) return;
    // A stage past approval needs the organization that approval creates, so
    // applications without one are left out (the database refuses them too,
    // migration 027).
    const skipped = APPROVED_STAGES.includes(newStatus)
      ? apps.filter((a) => selected.has(a.id) && !a.organization_id).map((a) => a.id)
      : [];
    const ids = Array.from(selected).filter((id) => !skipped.includes(id));
    const skippedNote = skipped.length
      ? ` ${skipped.length} without an organization skipped: approve ${skipped.length === 1 ? "it" : "them"} first.`
      : "";
    if (ids.length === 0) {
      toast.error(`Nothing moved.${skippedNote}`);
      setBulkConfirmStatus(null);
      return;
    }
    setBulkBusy(true);
    if (isDemo) {
      setApps((prev) => prev.map((a) => (ids.includes(a.id) ? { ...a, status: newStatus } : a)));
      setSelected(new Set());
      toast.success(`Demo: ${ids.length} pilots updated.${skippedNote}`);
      setBulkBusy(false);
      setBulkConfirmStatus(null);
      return;
    }
    const { error } = await supabase
      .from("pilot_applications")
      .update({ status: newStatus, reviewed_at: new Date().toISOString() })
      .in("id", ids);
    setBulkBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setApps((prev) => prev.map((a) => (ids.includes(a.id) ? { ...a, status: newStatus } : a)));
    setSelected(new Set());
    toast.success(`${ids.length} pilots → ${newStatus.replace("_", " ")}.${skippedNote}`);
    setBulkConfirmStatus(null);
  };

  const load = useCallback(async () => {
    setLoading(true);
    if (isDemo) {
      setApps(DEMO_APPS);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("pilot_applications")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    setApps((data as PilotApp[]) || []);

    // Look up which pilot applications already have a signed LOI so we can
    // show a badge on each pilot card. One query, in() filter, then a Set.
    if (data && data.length > 0) {
      const ids = (data as PilotApp[]).map((a) => a.id);
      const { data: loiRows } = await supabase
        .from("loi_signatures")
        .select("pilot_application_id")
        .in("pilot_application_id", ids);
      if (loiRows) {
        setSignedPilotIds(new Set(loiRows.map((r: { pilot_application_id: string | null }) => r.pilot_application_id).filter(Boolean)));
      }
    }
    setLoading(false);
  }, [isDemo]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (drillDownToken > 0 && drillDownStatusFilter) {
      setStatusFilter(drillDownStatusFilter as LifecycleState);
      setShowArchived(false);
      setSelected(new Set());
    }
  }, [drillDownToken, drillDownStatusFilter]);

  return (
    <Card className="bg-[#0F131C] border-white/10">
      <CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as LifecycleState | "all")}>
            <SelectTrigger className="w-[200px] bg-white/5 border-white/10 text-white">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {LIFECYCLE.map((s) => (
                <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="text-xs px-3 py-1.5 rounded-md border border-white/10 text-white/70 hover:border-white/20 hover:text-white"
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
        </div>

        {selected.size > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 p-3 rounded-lg bg-brand-cyan/10 border border-brand-cyan/30">
            <span className="text-sm text-brand-cyan font-semibold mr-2">{selected.size} selected</span>
            {/* No bulk approve: approving creates the fleet's organization, one application at a time. */}
            <Button size="sm" variant="ghost" onClick={() => setBulkConfirmStatus("in_review")}>→ in review</Button>
            <Button size="sm" variant="ghost" onClick={() => setBulkConfirmStatus("onboarding")}>→ onboarding</Button>
            <Button size="sm" variant="ghost" onClick={() => setBulkConfirmStatus("denied")}>→ denied</Button>
            <Button size="sm" variant="ghost" onClick={() => setBulkConfirmStatus("archived")}>→ archived</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} className="ml-auto text-white/40">Clear</Button>
          </div>
        )}
        {loading ? (
          <div className="py-12 flex justify-center"><Loader2 className="animate-spin text-brand-cyan" /></div>
        ) : (() => {
          const visibleApps = (showArchived ? apps : apps.filter((a) => a.status !== "archived")).filter(
            (a) => statusFilter === "all" || a.status === statusFilter
          );
          if (visibleApps.length === 0) {
            return (
              <div className="py-16 text-center text-white/40">
                {apps.length === 0
                  ? "No pilot applications yet."
                  : statusFilter !== "all"
                    ? `No applications with status "${statusFilter.replace("_", " ")}".`
                    : "No active pilot applications. Toggle 'Show archived' to view archived."}
              </div>
            );
          }
          return (
            <div className="grid md:grid-cols-2 gap-4">
              {visibleApps.map((a) => (
              <div key={a.id} className="rounded-xl border border-white/10 bg-[#0B0E14] p-5 hover:border-brand-cyan/40 transition-colors">
                <div className="flex items-start justify-between mb-3 gap-3">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <input
                      type="checkbox"
                      aria-label={`Select ${a.company_name}`}
                      checked={selected.has(a.id)}
                      onChange={() => toggleSelected(a.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <Building size={16} className="text-brand-orange flex-shrink-0" />
                    <button onClick={() => setEditing(a)} className="font-display font-semibold text-left truncate hover:text-brand-cyan">
                      {a.company_name || "(no company)"}
                    </button>
                  </div>
                  <LifecycleBadge state={a.status} />
                </div>
                <button onClick={() => setEditing(a)} className="text-left w-full">
                  <div className="flex flex-wrap gap-3 text-xs text-white/50 mb-3 items-center">
                    <span className="inline-flex items-center gap-1">
                      <Truck size={12} /> {trucksText(a) ? `${trucksText(a)} trucks` : "N/A"}
                    </span>
                    {a.truck_size && <span>{a.truck_size}</span>}
                    <span>· {new Date(a.created_at).toLocaleDateString()}</span>
                    {signedPilotIds.has(a.id) ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400 text-[10px] uppercase tracking-widest font-semibold ml-auto px-2 py-0.5 rounded-full border border-emerald-400/30 bg-emerald-400/5">
                        <FileSignature size={10} /> LOI signed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-white/30 text-[10px] uppercase tracking-widest ml-auto px-2 py-0.5 rounded-full border border-white/10">
                        No LOI
                      </span>
                    )}
                  </div>
                  {a.notes && <p className="text-white/60 text-sm line-clamp-2">{a.notes}</p>}
                </button>
              </div>
            ))}
            </div>
          );
        })()}
      </CardContent>

      {editing && (
        <ManagePilotDialog
          app={editing}
          isDemo={isDemo}
          onClose={() => setEditing(null)}
          onUpdated={(a, keepOpen) => {
            setApps((prev) => prev.map((p) => (p.id === a.id ? a : p)));
            // After an approval the dialog stays open on the portal step.
            setEditing(keepOpen ? a : null);
          }}
        />
      )}

      <Dialog open={!!bulkConfirmStatus} onOpenChange={(o) => { if (!bulkBusy && !o) setBulkConfirmStatus(null); }}>
        <DialogContent className="bg-[#0B0E14] border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              <AlertTriangle size={18} className="text-brand-orange" />
              Update {selected.size} pilot{selected.size === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription className="text-white/50">
              Set all selected applications to{" "}
              <strong className="text-white">{bulkConfirmStatus?.replace("_", " ")}</strong>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBulkConfirmStatus(null)} disabled={bulkBusy}>
              Cancel
            </Button>
            <Button
              onClick={() => bulkConfirmStatus && applyBulkStatus(bulkConfirmStatus)}
              disabled={bulkBusy || !bulkConfirmStatus}
              className="bg-brand-cyan text-[#0B0E14] hover:bg-brand-cyan/90 font-bold"
            >
              {bulkBusy && <Loader2 className="animate-spin mr-2" size={14} />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function LifecycleBadge({ state }: { state: LifecycleState }) {
  const map: Record<LifecycleState, string> = {
    pending: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    in_review: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    approved: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    onboarding: "bg-brand-cyan/15 text-brand-cyan border-brand-cyan/30",
    active: "bg-emerald-500/25 text-emerald-300 border-emerald-500/40",
    denied: "bg-red-500/15 text-red-400 border-red-500/30",
    archived: "bg-white/10 text-white/40 border-white/20",
  };
  return <span className={`text-xs px-2 py-1 rounded-full border ${map[state]}`}>{state.replace("_", " ")}</span>;
}

function ManagePilotDialog({
  app,
  isDemo,
  onClose,
  onUpdated,
}: {
  app: PilotApp;
  isDemo: boolean;
  onClose: () => void;
  onUpdated: (a: PilotApp, keepOpen?: boolean) => void;
}) {
  const [status, setStatus] = useState<LifecycleState>(app.status);
  const [notes, setNotes] = useState(app.notes || "");
  const [fleetMessage, setFleetMessage] = useState(app.fleet_visible_message || "");
  const [busy, setBusy] = useState(false);
  type LoiPreview = { id: string; signed_at: string; initials: string; participant_name: string };
  const [loi, setLoi] = useState<LoiPreview | null>(null);
  // The organization's own name, for the portal step. It can differ from the
  // company on the application when the applicant already had one.
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const portalStepRef = useRef<HTMLDivElement>(null);
  const canApprove = canBeApproved(app);
  const showPortalStep = !!app.organization_id && APPROVED_STAGES.includes(app.status);

  useEffect(() => {
    const id = app.organization_id;
    if (!id || org?.id === id) return;
    if (isDemo) {
      setOrg({ id, name: app.company_name?.trim() || "Demo Fleet" });
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("organizations").select("id, name").eq("id", id).maybeSingle();
      if (!cancelled && data) setOrg(data as { id: string; name: string });
    })();
    return () => {
      cancelled = true;
    };
  }, [app.organization_id, app.company_name, isDemo, org?.id]);

  // Bring the portal step into view once it appears after an approval.
  useEffect(() => {
    if (showPortalStep) portalStepRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [showPortalStep]);

  // Look up the signed LOI tied to this pilot application (if any)
  useEffect(() => {
    if (isDemo) {
      setLoi({ id: "demo-loi", signed_at: new Date().toISOString(), initials: "DM", participant_name: "Demo Signer" });
      return;
    }
    (async () => {
      const { data } = await supabase
        .from("loi_signatures")
        .select("id, signed_at, initials, participant_name")
        .eq("pilot_application_id", app.id)
        .order("signed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) setLoi(data as LoiPreview);
    })();
  }, [app.id, isDemo]);

  // The approval: approve_pilot_application (migration 027) creates the
  // fleet's organization and ties the application and the applicant to it.
  // Changed notes and message are saved first, without the status or the
  // review stamp, so the approval email that the status change sends already
  // carries the message. If the approval is refused they are put back, so the
  // fleet never sees a message written for an approval that did not happen;
  // the text stays in the dialog. Returns null when nothing was approved.
  const runApproval = async (): Promise<ApprovalResult | null> => {
    const message = fleetMessage.trim() || null;
    if (isDemo) {
      return {
        application_id: app.id,
        application_status: APPROVED_STAGES.includes(app.status) ? app.status : "approved",
        organization_id: app.organization_id ?? "30000000-0000-4000-8000-0000000000de",
        organization_name: app.company_name?.trim() || "Demo Fleet",
        organization_created: !app.organization_id,
        owner_id: app.user_id,
      };
    }
    const before = { notes: app.notes, fleet_visible_message: app.fleet_visible_message };
    const changed = notes !== (app.notes || "") || message !== (app.fleet_visible_message?.trim() || null);
    if (changed) {
      const { error } = await supabase
        .from("pilot_applications")
        .update({ notes, fleet_visible_message: message })
        .eq("id", app.id);
      if (error) {
        toast.error(error.message);
        return null;
      }
    }
    const { data, error } = await supabase.rpc("approve_pilot_application", { application_id: app.id });
    if (error) {
      let undo = "";
      if (changed) {
        const { error: undoError } = await supabase.from("pilot_applications").update(before).eq("id", app.id);
        undo = undoError
          ? ` The new message could not be taken back (${undoError.message}); clear it and save.`
          : " Notes and message were not saved; your text is still here.";
      }
      toast.error(`Not approved: ${error.message}${undo}`);
      return null;
    }
    return data as ApprovalResult;
  };

  const finishApproval = (result: ApprovalResult, finalStatus: LifecycleState) => {
    setStatus(finalStatus);
    setOrg({ id: result.organization_id, name: result.organization_name });
    toast.success(
      `${isDemo ? "Demo: " : ""}${result.organization_created ? "Approved. The fleet's organization is created." : "Approved."}`
    );
    onUpdated(
      {
        ...app,
        status: finalStatus,
        notes,
        fleet_visible_message: fleetMessage.trim() || null,
        organization_id: result.organization_id,
      },
      true
    );
  };

  const approve = async () => {
    setBusy(true);
    const result = await runApproval();
    setBusy(false);
    if (result) finishApproval(result, result.application_status);
  };

  const save = async () => {
    // A stage past approval needs the organization, so it is reached through
    // the approval, never a bare status change.
    if (APPROVED_STAGES.includes(status) && !app.organization_id) {
      if (!canApprove) {
        toast.error(`This application is ${app.status.replace("_", " ")}. Move it back to in review, then approve it.`);
        return;
      }
      setBusy(true);
      const result = await runApproval();
      if (!result) {
        setBusy(false);
        return;
      }
      let finalStatus = result.application_status;
      if (status !== "approved" && status !== result.application_status) {
        // The admin chose a later stage: move it there now that it has its
        // organization (a second status email, for that stage).
        if (isDemo) {
          finalStatus = status;
        } else {
          const { data: session } = await supabase.auth.getSession();
          const { error } = await supabase
            .from("pilot_applications")
            .update({
              status,
              reviewed_at: new Date().toISOString(),
              reviewed_by: session.session?.user?.id ?? null,
            })
            .eq("id", app.id);
          if (error) toast.error(`Approved, but not moved to ${status}: ${error.message}`);
          else finalStatus = status;
        }
      }
      setBusy(false);
      finishApproval(result, finalStatus);
      return;
    }
    setBusy(true);
    if (isDemo) {
      onUpdated({ ...app, status, notes, fleet_visible_message: fleetMessage || null });
      toast.success("Demo: pilot updated locally.");
      setBusy(false);
      return;
    }
    const { data: session } = await supabase.auth.getSession();
    const reviewerId = session.session?.user?.id;
    const { error } = await supabase
      .from("pilot_applications")
      .update({
        status,
        notes,
        fleet_visible_message: fleetMessage.trim() || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: reviewerId ?? null,
      })
      .eq("id", app.id);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Pilot updated.");
    onUpdated({ ...app, status, notes, fleet_visible_message: fleetMessage.trim() || null });
  };

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="bg-[#0B0E14] border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="font-display">{app.company_name || "Pilot application"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4 max-h-[70vh] overflow-y-auto">
          {showPortalStep && (
            <div ref={portalStepRef}>
              <PortalNextStep
                name={org?.id === app.organization_id ? org.name : null}
                organizationId={app.organization_id}
                ownerId={app.user_id}
              />
            </div>
          )}
          <ApplicantDetails app={app} />
          <div>
            <Label className="text-white/70 text-sm mb-2 block">Lifecycle stage</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as LifecycleState)}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LIFECYCLE.map((s) => (
                  <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canApprove && (
              <p className="text-xs text-white/40 mt-1">
                Approve (or Save with approved) creates the fleet's organization and shows the portal step.
              </p>
            )}
          </div>
          <div>
            <Label className="text-white/70 text-sm mb-2 block">Message to fleet (shown on their dashboard)</Label>
            <Textarea
              value={fleetMessage}
              onChange={(e) => setFleetMessage(e.target.value)}
              className="bg-white/5 border-white/10 text-white"
              rows={3}
              placeholder="Kickoff call link, FMS instructions, cohort decision context…"
            />
            <p className="text-xs text-white/40 mt-1">Included in status-change emails when you save.</p>
          </div>
          <div>
            <Label className="text-white/70 text-sm mb-2 block">Internal notes (admin only)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="bg-white/5 border-white/10 text-white"
              rows={3}
              placeholder="Disposition, reference calls, integration timeline…"
            />
          </div>

          {loi && (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 flex items-center gap-3">
              <FileSignature size={18} className="text-brand-cyan flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Signed Letter of Intent</div>
                <div className="text-xs text-white/50 mt-0.5">
                  Signed by {loi.participant_name} ({loi.initials}) on{" "}
                  {new Date(loi.signed_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                </div>
              </div>
              <Button asChild size="sm" variant="outline" className="border-white/15 text-white hover:bg-white/5">
                <Link to={`/loi/${loi.id}`} target="_blank" rel="noopener noreferrer">
                  View <ExternalLink size={12} className="ml-1.5" />
                </Link>
              </Button>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{showPortalStep && !canApprove ? "Close" : "Cancel"}</Button>
          {canApprove && (
            <Button onClick={approve} disabled={busy} className="bg-emerald-500 text-[#0B0E14] hover:bg-emerald-400 font-semibold">
              {busy ? <Loader2 className="animate-spin mr-2" size={14} /> : null} Approve
            </Button>
          )}
          <Button onClick={save} disabled={busy} className="bg-brand-cyan text-[#0B0E14] hover:bg-brand-cyan/90">
            {busy ? <Loader2 className="animate-spin mr-2" size={14} /> : null} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// After approval: the one staff step left on the portal side, with both ids
// filled in, so nobody types SQL or looks an id up.
function PortalNextStep({
  name,
  organizationId,
  ownerId,
}: {
  name: string | null;
  organizationId: string;
  ownerId: string;
}) {
  const command = name === null ? null : fleetCreateCommand(name, organizationId, ownerId);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Command copied.");
    } catch {
      toast.error("Could not copy. Select the command and copy it by hand.");
    }
  };
  return (
    <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
        <CheckCircle2 size={16} /> Next step: create the fleet's portal
      </div>
      {name === null ? (
        <p className="text-xs text-white/50">Loading the organization…</p>
      ) : command ? (
        <>
          <p className="text-xs text-white/60 leading-relaxed">
            Run this once in REA/trucklogics (the fleet:create command, REA #77). It creates the fleet's Client
            Portal company, and this applicant becomes its owner the first time they sign in with their
            cruzemaps.com account. Running it again changes nothing.
          </p>
          <pre
            data-testid="fleet-create-command"
            className="text-xs font-mono [font-variant-ligatures:none] text-white/90 bg-black/40 border border-white/10 rounded-md p-3 whitespace-pre-wrap break-all select-all"
          >
            {command}
          </pre>
          <Button size="sm" variant="outline" onClick={copy} className="border-white/15 text-white hover:bg-white/5">
            <Copy size={12} className="mr-1.5" /> Copy command
          </Button>
        </>
      ) : (
        <p className="text-xs text-white/60">
          Organization {organizationId} has no usable name or the applicant's id is missing, so the command cannot
          be filled in.
        </p>
      )}
    </div>
  );
}

function ApplicantDetails({ app }: { app: PilotApp }) {
  const rows: [string, string | null | undefined][] = [
    ["Contact", app.contact_name],
    ["Email", app.contact_email],
    ["Title", app.contact_title],
    ["Phone", app.contact_phone],
    ["Website", app.website],
    ["Truck class", app.truck_size],
    ...applicationAnswers(app),
    ["Applicant notes", app.application_notes],
  ].filter(([, v]) => v) as [string, string][];

  if (rows.length === 0 && !app.notes) return null;

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4 space-y-3">
      <div className="text-[11px] uppercase tracking-widest text-white/45 font-semibold">Applicant details</div>
      {rows.length > 0 && (
        <dl className="grid sm:grid-cols-2 gap-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-white/40 text-xs">{label}</dt>
              <dd className="text-white/85 mt-0.5 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {app.notes && (
        <p className="text-xs text-white/50 border-t border-white/10 pt-3">
          <span className="text-white/40">Legacy/internal notes blob: </span>
          {app.notes}
        </p>
      )}
    </div>
  );
}
