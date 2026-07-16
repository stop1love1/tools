export type GameCommand =
  | "jump"
  | "swap-skin"
  | "run-circle"
  | "grow"
  | "shrink";

export function normalizeComment(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .trim();
}

const MATCHERS: Array<{ command: GameCommand; patterns: RegExp[] }> = [
  { command: "jump", patterns: [/\bnhay\b/, /\bjump\b/] },
  {
    command: "swap-skin",
    patterns: [/\bdoi nv\b/, /\bdoi nhan vat\b/, /\bdoi skin\b/],
  },
  { command: "run-circle", patterns: [/\bdi vong\b/, /\bchay vong\b/] },
  { command: "grow", patterns: [/\bto len\b/, /\bphong to\b/] },
  { command: "shrink", patterns: [/\bnho lai\b/, /\bthu nho\b/] },
];

export function parseCommand(comment: string): GameCommand | null {
  const text = normalizeComment(comment);
  for (const { command, patterns } of MATCHERS) {
    if (patterns.some((p) => p.test(text))) return command;
  }
  return null;
}
