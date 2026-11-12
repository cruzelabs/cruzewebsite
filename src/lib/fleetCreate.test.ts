import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { commandName, fleetCreateCommand, shellQuote } from "./fleetCreate";

const ORG = "30000000-0000-0000-0000-00000000000a";
const OWNER = "00000000-0000-0000-0000-0000000000c1";

// What a POSIX shell makes of a word: run `printf %s <word>` and read stdout.
function shellRead(word: string): string {
  return execFileSync("/bin/sh", ["-c", `printf '%s' ${word}`], { encoding: "utf8" });
}

describe("fleetCreateCommand", () => {
  it("fills in the company, the organization and the owner", () => {
    expect(fleetCreateCommand("Acme Freight", ORG, OWNER)).toBe(
      `npm run fleet:create -- --name 'Acme Freight' --organization ${ORG} --owner ${OWNER}`
    );
  });

  it("returns nothing without a name or with an id that is not a uuid", () => {
    expect(fleetCreateCommand("  ", ORG, OWNER)).toBeNull();
    expect(fleetCreateCommand(null, ORG, OWNER)).toBeNull();
    expect(fleetCreateCommand("Acme", "not-a-uuid", OWNER)).toBeNull();
    expect(fleetCreateCommand("Acme", ORG, `${OWNER}; rm -rf ~`)).toBeNull();
    expect(fleetCreateCommand("Acme", null, OWNER)).toBeNull();
  });

  it("puts newlines and other control characters on one line", () => {
    expect(commandName("Acme\nFreight\t\u0007 LLC\r\n")).toBe("Acme Freight LLC");
    expect(fleetCreateCommand("Acme\n$(id)", ORG, OWNER)).not.toContain("\n");
  });

  it("drops bidirectional overrides that would make the line read differently", () => {
    expect(commandName("Acme‮eh⁦t⁩")).toBe("Acme eh t");
  });
});

describe("shellQuote", () => {
  const nasty = [
    "Joe's Trucking",
    "$(touch /tmp/pwned)",
    "`id`",
    'Acme "Best" Freight; echo hi',
    "back\\slash & pipe | here",
    "'",
    "''",
    "trailing quote'",
    "$HOME and ${HOME}",
    "* glob ? [chars]",
  ];

  it.each(nasty)("the shell reads %j back exactly, running nothing", (value) => {
    expect(shellRead(shellQuote(value))).toBe(value);
  });

  it("reads back the name inside the full command", () => {
    const name = "Joe's $(rm -rf ~) `id` Freight";
    const cmd = fleetCreateCommand(name, ORG, OWNER) as string;
    const word = cmd.slice(cmd.indexOf("--name ") + "--name ".length, cmd.indexOf(" --organization"));
    expect(shellRead(word)).toBe(name);
  });
});
