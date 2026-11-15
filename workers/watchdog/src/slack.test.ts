import { describe, expect, it } from "vitest";
import { slackText } from "./slack";

describe("slackText", () => {
  it("turns Discord bold into Slack bold and keeps emoji shortcodes", () => {
    expect(slackText(":x: **Platform API** is down")).toBe(":x: *Platform API* is down");
  });

  it("converts every bold run, not just the first", () => {
    expect(slackText("**a** and **b**")).toBe("*a* and *b*");
  });

  it("escapes Slack control characters so no alert can ping anyone", () => {
    expect(slackText("<!channel> <@U123> a & b")).toBe("&lt;!channel&gt; &lt;@U123&gt; a &amp; b");
  });

  it("unwraps a Discord no-preview link to the bare URL", () => {
    expect(slackText("see <https://dash.cloudflare.com/abc/workers-and-pages>")).toBe(
      "see https://dash.cloudflare.com/abc/workers-and-pages",
    );
    expect(slackText("<https://x.example/a|label> <!here>")).toBe("&lt;https://x.example/a|label&gt; &lt;!here&gt;");
  });

  it("leaves plain text alone", () => {
    expect(slackText("cruzemaps.com answered 200 after 4 min")).toBe("cruzemaps.com answered 200 after 4 min");
  });

  it("caps a runaway message", () => {
    expect(slackText("x".repeat(5000))).toHaveLength(3000);
  });
});
