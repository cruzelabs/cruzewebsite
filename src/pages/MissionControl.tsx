import { Link } from "react-router-dom";
import { ArrowLeft, Activity, TrendingUp, ShieldCheck, Mail, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Mission Control, the city operator dashboard (/dashboard). No city data
// source is connected to this site yet, so the page shows no figures and says
// so. It used to show made-up "Live Ops" numbers as if they were live (a
// network ROI of $892,450, ticking braking-event counters, CO2 savings, named
// pilot customers), which failed readiness check E5. Add a figure here only
// when it comes from real data, and say where it comes from.

const COMING: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Activity,
    title: "Traffic flow",
    body: "Stop-and-go waves on your pilot corridors, and the speeds Cruze suggests to drivers there.",
  },
  {
    icon: TrendingUp,
    title: "Measured results",
    body: "Delay and fuel use on those corridors, compared with a baseline measured before the pilot.",
  },
  {
    icon: ShieldCheck,
    title: "Driver follow-through",
    body: "How closely drivers on the corridors follow the suggested speeds.",
  },
];

const MissionControl = () => {
  return (
    <div className="min-h-screen bg-[#0B0E14] text-white overflow-y-auto">
      {/* Top Navbar */}
      <nav className="sticky top-0 z-50 w-full px-6 py-4 border-b border-white/5 bg-[#0B0E14]/80 backdrop-blur-xl flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link
            to="/"
            aria-label="Back to home"
            className="inline-flex items-center justify-center p-2 rounded-full hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-white/70" />
          </Link>
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Cruze" className="h-8 w-auto opacity-90" />
            <div className="h-4 w-px bg-white/20"></div>
            <span className="font-display font-medium text-lg tracking-wide text-white/90">
              Mission Control
            </span>
          </div>
        </div>

        {/* A plain status, not a pulsing "live" light: nothing here is live. */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
          <div className="w-2 h-2 rounded-full bg-white/30"></div>
          <span className="text-xs font-medium text-white/60 tracking-widest uppercase">Not connected</span>
        </div>
      </nav>

      <main className="container mx-auto px-6 py-8 max-w-4xl">
        <h1 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-2">Mission Control</h1>
        <p className="text-white/50 text-sm md:text-base max-w-2xl mb-8">
          Your city's pilot data will show here once a pilot is running and connected to Cruze.
        </p>

        <Card className="bg-white/5 border-white/10 text-white">
          <CardContent className="p-6 md:p-8">
            <h2 className="font-display text-xl font-semibold mb-2">No live data yet</h2>
            <p className="text-white/60 text-sm leading-relaxed max-w-2xl">
              Mission Control is not connected to any city data yet, so there are no figures to show. We do not
              fill this page with sample or estimated numbers.
            </p>

            <h3 className="mt-8 mb-4 text-xs font-medium uppercase tracking-widest text-white/40">
              What will show here
            </h3>
            <ul className="grid gap-4 md:grid-cols-3">
              {COMING.map(({ icon: Icon, title, body }) => (
                <li key={title} className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <Icon className="w-5 h-5 text-brand-cyan mb-3" aria-hidden="true" />
                  <div className="font-medium text-sm mb-1">{title}</div>
                  <p className="text-xs text-white/50 leading-relaxed">{body}</p>
                </li>
              ))}
            </ul>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild className="bg-brand-cyan text-black hover:bg-brand-cyan/90">
                <a href="mailto:cities@cruzemaps.com?subject=City%20pilot%20question">
                  <Mail className="w-4 h-4 mr-2" aria-hidden="true" /> Email cities@cruzemaps.com
                </a>
              </Button>
              <Button asChild variant="ghost" className="text-white/70 hover:bg-white/5 hover:text-white">
                <Link to="/for-cities">Cruze for cities</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default MissionControl;
