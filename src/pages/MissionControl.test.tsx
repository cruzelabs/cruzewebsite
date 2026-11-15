// @vitest-environment jsdom
//
// Readiness E5: Mission Control (/dashboard, city operators) has no data
// source, so it must not show figures or look live. It used to show made-up
// "Live Ops" numbers ($892,450 of network ROI, a ticking braking-event count,
// CO2 savings) and named companies as pilots.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MissionControl from "./MissionControl";

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter>
      <MissionControl />
    </MemoryRouter>,
  );
}

describe("Mission Control with no data source", () => {
  it("says plainly that nothing is connected", () => {
    renderPage();
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No live data yet" })).toBeTruthy();
    expect(screen.getByText(/not connected to any city data yet/i)).toBeTruthy();
  });

  it("shows no figures", () => {
    const text = renderPage().container.textContent ?? "";
    expect(text).not.toMatch(/\$\s?\d/); // no money
    expect(text).not.toMatch(/\d,\d{3}/); // no counts like 892,450 or 1,482
    expect(text).not.toMatch(/\d\s?%/); // no percentages
    expect(text).not.toMatch(/\d+(\.\d+)?\s?(k|tonnes?|tons?)\b/i);
  });

  it("does not claim to be live or name customers", () => {
    const { container } = renderPage();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/live ops|real-time|telemetry/i);
    expect(text).not.toMatch(/H-E-B|FedEx/);
    // Nothing pulses like a live indicator.
    expect(container.querySelector(".animate-pulse, .animate-ping")).toBeNull();
  });

  it("gives the operator a way to reach Cruze", () => {
    renderPage();
    const email = screen.getByRole("link", { name: /cities@cruzemaps\.com/ });
    expect(email.getAttribute("href")).toMatch(/^mailto:cities@cruzemaps\.com/);
  });
});
