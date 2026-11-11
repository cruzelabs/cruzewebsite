// Turns a watchdog message, written in Discord's markdown, into Slack text.

// Slack caps a message's text at 40,000 characters; alerts are far shorter,
// so this limit only guards against a runaway message.
const SLACK_MAX_CHARS = 3000;

// Slack reads "&", "<" and ">" as control characters: "<!channel>" pings a
// channel and "<@U123>" pings a person. Escaping them means no alert can ping
// anyone, whatever text it carries. Bold is "**x**" in Discord and "*x*" in
// Slack; emoji shortcodes such as ":x:" mean the same in both.
export function slackText(content: string): string {
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .slice(0, SLACK_MAX_CHARS);
}
