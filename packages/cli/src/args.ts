// A tiny, dependency-free argument parser. The CLI's only job at the boundary is
// to turn `argv` into positionals + flags and hand them to the kernel — so this
// stays deliberately minimal rather than pulling in a parser library.
//
// Supported forms:
//   --flag value     value-bearing long flag (consumes the next token)
//   --flag=value     value-bearing long flag (inline)
//   --flag           boolean long flag (true)
//   -h / -v          short boolean flags
//   --               everything after is treated as positional
//
// A long flag named in `booleans` never consumes a following token, so
// `events tail agent --review` keeps `--review` boolean and `agent` positional.

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(
  argv: readonly string[],
  booleans: readonly string[] = [],
): ParsedArgs {
  const boolSet = new Set(booleans);
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (boolSet.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    // A lone "-" is a positional; "-x" is a short boolean flag.
    if (token.startsWith("-") && token.length > 1) {
      flags[token.slice(1)] = true;
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

/** A flag's value when it was given as a string, else undefined. */
export function stringFlag(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A flag's value parsed as a non-negative integer, else undefined. */
export function intFlag(value: string | true | undefined): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/** Whether `--help`/`-h` was requested. */
export function helpRequested(parsed: ParsedArgs): boolean {
  return parsed.flags.help === true || parsed.flags.h === true;
}
