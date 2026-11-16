// @vitest-environment jsdom
//
// Readiness E5: /fleet-scores in a build with no fleet backend (production
// today, VITE_CRUZE_API_URL unset) used to offer a manager login and a token
// box for a backend that is not there, and answered with "VITE_CRUZE_API_URL
// is unset". It must say plainly that driver scores are not available, show no
// form and no config names, and fetch nothing. With a backend configured, the
// sign-in fallback is unchanged, and the gallons column says "modeled" because
// the backend models that figure (the content playbook labels every projection).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "manager@fleet.example" },
    session: { access_token: "supabase-jwt" },
    signOut: vi.fn(),
  }),
}));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function renderPage() {
  const { default: FleetScores } = await import("./FleetScores");
  return render(
    <MemoryRouter>
      <FleetScores />
    </MemoryRouter>,
  );
}

describe("/fleet-scores with no fleet backend", () => {
  beforeEach(() => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_CRUZE_API_URL", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
  });

  it("says driver scores are not available and shows no sign-in form", async () => {
    const { container } = await renderPage();

    expect(await screen.findByRole("heading", { name: "Driver scores are not available yet" })).toBeTruthy();
    expect(screen.getByText(/no scores to show/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to pilot status" }).getAttribute("href")).toBe("/fleet-dashboard");

    expect(container.querySelector("input, form")).toBeNull();
    expect(screen.queryByText(/connect the fleet backend/i)).toBeNull();
    expect(container.textContent).not.toMatch(/VITE_|unset|not set/i);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/fleet-scores with a fleet backend", () => {
  it("keeps the manual sign-in fallback when single sign-on is off", async () => {
    vi.stubEnv("VITE_CRUZE_API_URL", "https://fleet-api.example/api");
    vi.resetModules();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "sso-not-configured" }), { status: 503 }),
    );

    await renderPage();

    expect(await screen.findByRole("heading", { name: "Connect the fleet backend" })).toBeTruthy();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("https://fleet-api.example/api/auth/exchange", expect.anything());
  });

  it("labels the gallons figure as modeled when scores load", async () => {
    vi.stubEnv("VITE_CRUZE_API_URL", "https://fleet-api.example/api");
    vi.resetModules();
    sessionStorage.setItem("cruze_fleet_token", "backend-token");
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          window: { days: 7 },
          fleet_summary: { driver_count: 1, avg_overall: 82, avg_safety: 80, avg_efficiency: 84 },
          drivers: [
            {
              driver_id: "drv-1",
              score: 82,
              miles_driven: 120,
              event_counts: {},
              modeled_gallons_wasted: 1.5,
              scores: { safety: 80, efficiency: 84, overall: 82, band: "Good", has_data: true },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await renderPage();

    expect(await screen.findByRole("button", { name: "Gal. wasted (modeled)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Gal. wasted" })).toBeNull();
    expect(screen.getByText("1.5")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://fleet-api.example/api/fleet/driver-scores?window_days=7",
      expect.anything(),
    );
  });
});
