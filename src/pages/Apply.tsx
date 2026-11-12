import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import SEO from "@/components/SEO";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Check,
  Loader2,
  Timer,
  FormInput,
  PenLine,
  Shield,
  FileX,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import {
  LOI_VERSION,
  PERFORMANCE_FEE_MIN_PCT,
  PERFORMANCE_FEE_MAX_PCT,
  LOI_SUMMARY_BULLETS,
  renderLOIText,
  suggestInitials,
} from "@/lib/loi";
import {
  blankWizard,
  ELD_PROVIDERS,
  parseCount,
  pilotInsertFromWizard,
  TABLET_MANAGER_CHOICES,
  TERMINAL_PILOT_STATUSES,
  wizardErrors,
  type ApplyWizardPayload,
} from "@/lib/pilotApplication";
import {
  clearAllDrafts,
  loadWizardDraft,
  saveSessionDraft,
  scheduleDraftPersist,
  type WizardDraft,
} from "@/lib/applyDraft";

type WizardData = WizardDraft;

const APPLY_PROCESS_FEATURES = [
  {
    icon: Timer,
    title: "Two-Minute Setup",
    body: "Complete your whole application on one short screen.",
  },
  {
    icon: FormInput,
    title: "One-Page Form",
    body: "Your contact details, truck count, ELD provider and sites. The rest is optional.",
  },
  {
    icon: PenLine,
    title: "Instant E-Signing",
    body: 'Check "I Agree" to execute your LOI immediately.',
  },
  {
    icon: Shield,
    title: "Corporate Protection",
    body: "Automatically signs under your company name to protect personal assets.",
  },
  {
    icon: FileX,
    title: "Zero Paperwork Hassle",
    body: "Eliminates messy PDFs, printing, and scanning for busy entrepreneurs.",
  },
] as const;

function isNonEmpty(value: string | undefined): boolean {
  return !!value?.trim();
}

function formValid(data: WizardData): boolean {
  return Object.keys(wizardErrors(data)).length === 0 && !!data.loiAgreed;
}

// Editing these after checking I Agree clears the box: the signed text would
// no longer match what they agreed to.
const LOI_MATERIAL: (keyof WizardData)[] = ["contactName", "companyName", "truckCount"];

const INPUT_CLASS = "bg-white/5 border-white/10 text-white";

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={id} className="text-white/70 text-sm mb-1 block">
        {label}
      </Label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-xs text-red-400 mt-1">
          {error}
        </p>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="pt-2 text-[11px] uppercase tracking-widest text-white/45 font-semibold">{children}</div>
  );
}

const digitsOnly = (value: string) => value.replace(/\D/g, "").slice(0, 7);

export default function Apply() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [showFullLOI, setShowFullLOI] = useState(false);
  const submitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);

  const [data, setData] = useState<WizardData>({
    ...blankWizard(user?.email || ""),
    loiAgreed: false,
    loiInitials: "",
  });

  // Restore session + DB drafts (Apply → Login → resume).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const restored = await loadWizardDraft(user?.id, user?.email ?? undefined);
      if (cancelled) return;
      setData(restored);
      if (user?.id && isNonEmpty(restored.contactName) && isNonEmpty(restored.companyName)) {
        toast.success("We restored your answers. Check the box and submit to finish.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.email]);

  // Clear any pending submit timer on unmount so navigating away during
  // the success animation doesn't navigate us back unexpectedly. (Audit #17)
  useEffect(() => {
    return () => {
      if (submitTimerRef.current) clearTimeout(submitTimerRef.current);
    };
  }, []);

  const update = <K extends keyof WizardData>(key: K, value: WizardData[K]) => {
    if (!startedRef.current) {
      startedRef.current = true;
      track("application_started");
    }
    setData((prev) => {
      let next: WizardData = { ...prev, [key]: value };
      if (LOI_MATERIAL.includes(key) && prev.loiAgreed && prev[key] !== value) {
        next = { ...next, loiAgreed: false };
      }
      scheduleDraftPersist(user?.id, next);
      return next;
    });
  };

  const errors = useMemo(() => wizardErrors(data), [data]);
  // Show a field's problem once something is typed in it; an empty required
  // field is marked with * and the note under the button.
  const shownError = (key: keyof ApplyWizardPayload) => (isNonEmpty(data[key]) ? errors[key] : undefined);

  const signedDate = useMemo(
    () => new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    []
  );

  const initials = useMemo(() => suggestInitials(data.contactName) || "—", [data.contactName]);

  // The exact count as the LOI and the database hold it: digits, no commas.
  const truckCount = parseCount(data.truckCount, 1);
  const trucksForLOI = truckCount === null ? null : String(truckCount);

  const fullLOIText = useMemo(
    () =>
      renderLOIText({
        participantName: data.contactName.trim() || "[your name]",
        participantCompany: data.companyName.trim() || "[your company]",
        fleetSize: trucksForLOI ?? "[number of trucks]",
        signedDate,
        initials,
      }),
    [data.contactName, data.companyName, trucksForLOI, signedDate, initials]
  );

  const submit = async () => {
    if (!formValid(data) || trucksForLOI === null) {
      toast.error("Fill in the fields marked * and check I Agree.");
      return;
    }
    setSubmitting(true);

    if (!user) {
      saveSessionDraft(data);
      navigate("/login?role=fleet_owner&apply=1");
      setSubmitting(false);
      return;
    }

    const { data: existing } = await supabase
      .from("pilot_applications")
      .select("id, status")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing && !(TERMINAL_PILOT_STATUSES as readonly string[]).includes(existing.status)) {
      setSubmitting(false);
      toast.error("You already have an application in progress.", {
        action: { label: "View dashboard", onClick: () => navigate("/fleet-dashboard") },
      });
      return;
    }

    const { data: pilotRow, error: pilotErr } = await supabase
      .from("pilot_applications")
      .insert(pilotInsertFromWizard(user.id, data))
      .select("id")
      .single();

    if (pilotErr) {
      setSubmitting(false);
      const dup =
        pilotErr.message.includes("pilot_applications_one_active_per_user") ||
        pilotErr.code === "23505";
      if (dup) {
        toast.error("You already have an active application.", {
          action: { label: "View dashboard", onClick: () => navigate("/fleet-dashboard") },
        });
      } else {
        toast.error(pilotErr.message);
      }
      return;
    }

    const contactName = data.contactName.trim();
    const companyName = data.companyName.trim();
    const signedInitials = suggestInitials(contactName);
    // Names the truck count the applicant typed; the database refuses an LOI
    // whose fleet_size differs from its application's truck_count (026).
    const loiFullText = renderLOIText({
      participantName: contactName,
      participantCompany: companyName,
      fleetSize: trucksForLOI,
      signedDate,
      initials: signedInitials,
    });

    const { data: loiRow, error: loiErr } = await supabase
      .from("loi_signatures")
      .insert({
        user_id: user.id,
        pilot_application_id: pilotRow?.id ?? null,
        participant_name: contactName,
        participant_company: companyName,
        participant_title: null,
        contact_email: data.contactEmail.trim(),
        fleet_size: trucksForLOI,
        agreed: true,
        initials: signedInitials,
        loi_version: LOI_VERSION,
        loi_full_text: loiFullText,
        performance_fee_min_pct: PERFORMANCE_FEE_MIN_PCT,
        performance_fee_max_pct: PERFORMANCE_FEE_MAX_PCT,
        user_agent: navigator.userAgent,
      })
      .select("id")
      .single();

    if (loiErr) {
      // Roll back the pilot row so we don't leave an orphan. fleet_owner has
      // no DELETE policy on pilot_applications, so use the SECURITY DEFINER
      // rollback_unsigned_pilot RPC (owner-scoped, refuses if an LOI exists).
      if (pilotRow?.id) {
        try {
          await supabase.rpc("rollback_unsigned_pilot", { p_id: pilotRow.id });
        } catch (rollbackErr) {
          console.error("Pilot rollback failed:", rollbackErr);
        }
      }
      setSubmitting(false);
      toast.error("Couldn't sign the LOI: " + loiErr.message + ". Your application was rolled back; please try again.");
      return;
    }

    if (loiRow?.id) {
      supabase.functions
        .invoke("capture-loi-metadata", {
          body: { loi_id: loiRow.id, user_agent: navigator.userAgent },
        })
        .catch((err) => console.warn("LOI metadata capture:", err));
    }

    await clearAllDrafts();

    setSubmitting(false);
    track("application_submitted", { truck_count: truckCount, fms: data.fmsProvider, loi_signed: true });
    setDone(true);
    submitTimerRef.current = setTimeout(() => navigate("/fleet-dashboard"), 1800);
  };

  return (
    <MarketingLayout>
      <SEO />
      <section className="container mx-auto px-6 py-16 max-w-2xl">
        {!done && (
          <>
            <h1 className="font-display text-3xl md:text-5xl font-bold mb-2">Apply for the Cruze pilot.</h1>
            <p className="text-white/60 mb-8">
              One short form, about two minutes. Check I Agree to e-sign your non-binding LOI. We'll respond within
              two business days with a calibrated 30-day pilot proposal.
            </p>

            <Card className="bg-[#0F131C] border-white/10">
              <CardContent className="p-8 space-y-5">
                <div className="grid md:grid-cols-2 gap-4">
                  <Field id="apply-name" label="Your name *">
                    <Input
                      id="apply-name"
                      value={data.contactName}
                      onChange={(e) => update("contactName", e.target.value)}
                      placeholder="Full name (used on your LOI)"
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <Field id="apply-company" label="Company name *">
                    <Input
                      id="apply-company"
                      value={data.companyName}
                      onChange={(e) => update("companyName", e.target.value)}
                      placeholder="Swift Transport Logistics"
                      className={INPUT_CLASS}
                    />
                  </Field>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <Field id="apply-email" label="Work email *" error={shownError("contactEmail")}>
                    <Input
                      id="apply-email"
                      type="email"
                      value={data.contactEmail}
                      onChange={(e) => update("contactEmail", e.target.value)}
                      placeholder="you@company.com"
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <Field id="apply-phone" label="Phone *">
                    <Input
                      id="apply-phone"
                      type="tel"
                      value={data.contactPhone}
                      onChange={(e) => update("contactPhone", e.target.value)}
                      placeholder="(210) 555-0100"
                      className={INPUT_CLASS}
                    />
                  </Field>
                </div>

                <SectionTitle>Your fleet</SectionTitle>
                <div className="grid md:grid-cols-2 gap-4">
                  <Field id="apply-trucks" label="How many trucks? *" error={shownError("truckCount")}>
                    <Input
                      id="apply-trucks"
                      inputMode="numeric"
                      autoComplete="off"
                      value={data.truckCount}
                      onChange={(e) => update("truckCount", digitsOnly(e.target.value))}
                      placeholder="e.g. 172"
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <Field id="apply-provider" label="ELD or telematics provider *">
                    <Select value={data.fmsProvider} onValueChange={(v) => update("fmsProvider", v)}>
                      <SelectTrigger id="apply-provider" className={INPUT_CLASS}>
                        <SelectValue placeholder="Choose one" />
                      </SelectTrigger>
                      <SelectContent>
                        {ELD_PROVIDERS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                {data.fmsProvider === "Other" && (
                  <Field id="apply-provider-other" label="Which provider? *">
                    <Input
                      id="apply-provider-other"
                      value={data.fmsOther}
                      maxLength={200}
                      onChange={(e) => update("fmsOther", e.target.value)}
                      placeholder="e.g. Fleet Complete"
                      className={INPUT_CLASS}
                    />
                  </Field>
                )}
                <Field id="apply-sites" label="Domicile sites or main lanes *">
                  <Textarea
                    id="apply-sites"
                    rows={2}
                    maxLength={1000}
                    value={data.primaryLanes}
                    onChange={(e) => update("primaryLanes", e.target.value)}
                    placeholder="e.g. Laredo yard; I-35 Laredo to Dallas"
                    className={INPUT_CLASS}
                  />
                </Field>

                <SectionTitle>People (optional)</SectionTitle>
                <div className="grid md:grid-cols-2 gap-4 items-end">
                  <Field id="apply-access-name" label="Who can authorize access to your ELD data?">
                    <Input
                      id="apply-access-name"
                      value={data.dataAuthorizerName}
                      maxLength={200}
                      onChange={(e) => update("dataAuthorizerName", e.target.value)}
                      placeholder="Name"
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <Field id="apply-access-email" label="Their email" error={shownError("dataAuthorizerEmail")}>
                    <Input
                      id="apply-access-email"
                      type="email"
                      value={data.dataAuthorizerEmail}
                      maxLength={320}
                      onChange={(e) => update("dataAuthorizerEmail", e.target.value)}
                      placeholder="name@company.com"
                      className={INPUT_CLASS}
                    />
                  </Field>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <Field id="apply-safety-name" label="Safety contact">
                    <Input
                      id="apply-safety-name"
                      value={data.safetyContactName}
                      maxLength={200}
                      onChange={(e) => update("safetyContactName", e.target.value)}
                      placeholder="Name"
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <Field id="apply-safety-email" label="Their email" error={shownError("safetyContactEmail")}>
                    <Input
                      id="apply-safety-email"
                      type="email"
                      value={data.safetyContactEmail}
                      maxLength={320}
                      onChange={(e) => update("safetyContactEmail", e.target.value)}
                      placeholder="name@company.com"
                      className={INPUT_CLASS}
                    />
                  </Field>
                </div>

                <SectionTitle>Driver tablets (optional)</SectionTitle>
                <div className="grid md:grid-cols-3 gap-4">
                  <Field id="apply-tablet-model" label="Model">
                    <Input
                      id="apply-tablet-model"
                      value={data.tabletModel}
                      maxLength={200}
                      onChange={(e) => update("tabletModel", e.target.value)}
                      placeholder="e.g. Galaxy Tab Active5"
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <Field id="apply-tablet-count" label="How many?" error={shownError("tabletCount")}>
                    <Input
                      id="apply-tablet-count"
                      inputMode="numeric"
                      autoComplete="off"
                      value={data.tabletCount}
                      onChange={(e) => update("tabletCount", digitsOnly(e.target.value))}
                      placeholder="e.g. 170"
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <Field id="apply-tablet-manager" label="Who manages them?">
                    <Select value={data.tabletManagement} onValueChange={(v) => update("tabletManagement", v)}>
                      <SelectTrigger id="apply-tablet-manager" className={INPUT_CLASS}>
                        <SelectValue placeholder="Choose one" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(TABLET_MANAGER_CHOICES).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                        <SelectItem value="unsure">Not sure yet</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                {/* LOI agreement */}
                <div className="rounded-xl border border-brand-cyan/25 bg-brand-cyan/5 p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-brand-cyan font-semibold">
                    Your Letter of Intent — the plain-English version
                  </div>
                  <ul className="space-y-2">
                    {LOI_SUMMARY_BULLETS.map((b) => (
                      <li key={b} className="flex items-start gap-2 text-sm text-white/80 leading-relaxed">
                        <Check size={14} className="text-brand-cyan flex-shrink-0 mt-1" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    onClick={() => setShowFullLOI((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-xs text-brand-cyan hover:underline"
                  >
                    {showFullLOI ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    {showFullLOI ? "Hide the full LOI text" : "Read the full LOI text"}
                  </button>

                  {showFullLOI && (
                    <div className="rounded-lg border border-white/10 bg-[#0B0E14] px-4 py-3 max-h-72 overflow-y-auto">
                      <pre className="text-xs text-white/80 leading-relaxed whitespace-pre-wrap font-sans">{fullLOIText}</pre>
                    </div>
                  )}

                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      checked={data.loiAgreed}
                      onCheckedChange={(v) => update("loiAgreed", !!v)}
                      className="mt-0.5 border-white/30 data-[state=checked]:bg-brand-orange data-[state=checked]:text-[#0B0E14] data-[state=checked]:border-brand-orange"
                    />
                    <span className="text-sm text-white/85 leading-relaxed">
                      <span className="font-semibold text-white">I Agree</span>
                      {" "}— I accept the Letter of Intent and terms above on behalf of{" "}
                      <span className="text-brand-cyan">{data.companyName.trim() || "my company"}</span>
                      {trucksForLOI && (
                        <>
                          {" "}for <span className="text-brand-cyan">{truckCount.toLocaleString("en-US")}</span>{" "}
                          {truckCount === 1 ? "truck" : "trucks"}
                        </>
                      )}
                      . This is a
                      30-day <span className="font-semibold text-white">non-binding</span> pilot with a{" "}
                      {PERFORMANCE_FEE_MIN_PCT}–{PERFORMANCE_FEE_MAX_PCT}% performance fee only on documented savings.
                      My initials ({initials}) are applied as my electronic signature, timestamped {signedDate}.
                    </span>
                  </label>

                  <p className="text-xs text-white/50 leading-relaxed">
                    By checking the box you consent to sign and do business electronically under the US
                    ESIGN Act and UETA, and you intend your initials and timestamp to be your signature.
                    A copy of your signed LOI stays available from your dashboard. You can request a paper
                    copy, or withdraw consent to electronic records, by emailing{" "}
                    <a href="mailto:support@cruzemaps.com" className="text-brand-cyan hover:underline">
                      support@cruzemaps.com
                    </a>
                    . See our{" "}
                    <Link to="/terms" target="_blank" className="text-brand-cyan hover:underline">
                      Terms
                    </Link>{" "}
                    and{" "}
                    <Link to="/privacy" target="_blank" className="text-brand-cyan hover:underline">
                      Privacy Policy
                    </Link>
                    . We record signing metadata (including your IP address) to evidence the signature.
                  </p>
                </div>

                <Button
                  onClick={submit}
                  disabled={submitting || !formValid(data)}
                  className="w-full bg-brand-orange text-[#0B0E14] hover:bg-brand-orange/90 font-bold h-12 text-base"
                >
                  {submitting && <Loader2 className="animate-spin mr-2" size={16} />}
                  Sign &amp; submit
                </Button>
                {!formValid(data) && (
                  <p className="text-xs text-white/50 text-center">Fill in the fields marked * and check I Agree.</p>
                )}
                <p className="text-xs text-white/40 text-center">
                  No printing, no scanning. A copy of your signed LOI is available from your dashboard.
                </p>
                <p className="text-xs text-white/40 text-center leading-relaxed">
                  By giving your phone number and submitting, you agree that Cruze may contact you by
                  phone, text, and email about your application and the pilot. This consent is not a
                  condition of any purchase or service. Message and data rates may apply. Reply STOP to
                  stop texts, or email{" "}
                  <a href="mailto:info@cruzemaps.com" className="text-brand-cyan hover:underline">
                    info@cruzemaps.com
                  </a>{" "}
                  to opt out of calls.
                </p>
              </CardContent>
            </Card>

            {/* Why it's fast + pilot context, below the form */}
            <div className="mt-8 rounded-xl border border-brand-cyan/20 bg-brand-cyan/5 p-5">
              <div className="text-[11px] uppercase tracking-widest text-brand-cyan font-semibold mb-4">
                Why applying is quick
              </div>
              <ul className="space-y-3.5">
                {APPLY_PROCESS_FEATURES.map((feature) => {
                  const Icon = feature.icon;
                  return (
                    <li key={feature.title} className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-cyan/10 text-brand-cyan">
                        <Icon size={15} />
                      </span>
                      <div>
                        <div className="text-sm font-semibold text-white">{feature.title}</div>
                        <p className="text-sm text-white/60 leading-relaxed mt-0.5">{feature.body}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="mt-6 rounded-xl border border-brand-orange/20 bg-gradient-to-br from-brand-orange/10 to-transparent p-5">
              <div className="text-[11px] uppercase tracking-widest text-brand-orange font-semibold mb-3">
                About the Cruze pilot
              </div>
              <p className="text-white/80 text-sm leading-relaxed mb-4">
                Cruze coordinates speeds across your drivers and the swarm around them, dissolving phantom traffic
                jams before they form. The 30-day pilot is software-only (no hardware to install) and zero upfront cost.
              </p>
              <div className="grid sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-lg bg-white/5 p-3">
                  <div className="font-display text-2xl font-bold text-brand-orange">Your trucks</div>
                  <div className="text-white/60 mt-1">measured against a control group</div>
                </div>
                <div className="rounded-lg bg-white/5 p-3">
                  <div className="font-display text-2xl font-bold text-brand-cyan">Your data</div>
                  <div className="text-white/60 mt-1">fuel and braking from your own ELD, every number shared</div>
                </div>
                <div className="rounded-lg bg-white/5 p-3">
                  <div className="font-display text-2xl font-bold text-white">$0</div>
                  <div className="text-white/60 mt-1">upfront, only pay on documented savings</div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-3 text-xs">
                <a href="/for-fleets" target="_blank" rel="noopener noreferrer" className="text-brand-orange hover:underline">
                  See the full fleet pitch →
                </a>
                <a href="/faq" target="_blank" rel="noopener noreferrer" className="text-white/60 hover:underline">
                  FAQ →
                </a>
              </div>
            </div>
          </>
        )}

        {done && (
          <Card className="bg-[#0F131C] border-brand-cyan/30">
            <CardContent className="p-12 text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-brand-cyan/15 text-brand-cyan mb-4">
                <Check size={32} />
              </div>
              <h2 className="font-display text-2xl md:text-3xl font-bold mb-3">Application submitted.</h2>
              <p className="text-white/60">We'll be in touch within 2 business days. Routing you to your dashboard…</p>
            </CardContent>
          </Card>
        )}
      </section>
    </MarketingLayout>
  );
}
