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
// Every command DECLARES the options it takes, split by whether they carry a value
// (`values`) or not (`booleans`); `--help`/`-h` are declared for every command and
// need not be repeated. A declared boolean never consumes a following token, so
// `events tail agent --review` keeps `--review` boolean and `agent` positional.
//
// An option NO command declared is collected in `unknown` rather than recorded as a
// flag — and it does not consume the following token, so the value typed after a
// misspelled option stays where the operator put it. Refusing it is the call site's
// job: the parser reports, each command words its own refusal. That split is
// deliberate. Silently ignoring an option the operator typed is the failure this
// exists to end, but a parser that printed the refusal itself could not say which
// command it was refusing for, and every verb's message would flatten to one.
//
// A negative number is taken as a value, not a flag, so `--allow -100123`
// (a Telegram group id) binds the id rather than being read as another flag. In
// positional place a bare `-5` still lands as a digit-keyed flag — the config
// setters read it back to reject the value with their own message — so a
// digit- or dot-leading key is never treated as an undeclared option.

/** The options every command takes, so no command has to declare them. */
const ALWAYS_DECLARED = ["help", "h"] as const;

/** Whether a flag key is really a bare negative number the parser had nowhere to put. */
function isNumericKey(key: string): boolean {
  return /^[.\d]/.test(key);
}

/** The options one command takes: those that carry a value, and those that do not. */
export interface FlagSpec {
  /** Long options that are true/absent and never consume a following token. */
  booleans?: readonly string[];
  /** Long options that carry a value, given as `--flag value` or `--flag=value`. */
  values?: readonly string[];
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
  /** Options no command declared, as typed (`--mdoe`, `-q`), in the order given. */
  unknown: string[];
}

export function parseArgs(argv: readonly string[], spec: FlagSpec = {}): ParsedArgs {
  const boolSet = new Set<string>([...ALWAYS_DECLARED, ...(spec.booleans ?? [])]);
  const valueSet = new Set<string>(spec.values ?? []);
  const declared = (name: string): boolean => boolSet.has(name) || valueSet.has(name);
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      // An option name never contains whitespace, so a token like `--draft the
      // proposal` — one quoted argument, not two — is text that happens to begin with
      // dashes. Taking it as a positional keeps `run agent "--draft the proposal"`
      // working and keeps a whole sentence out of a message about an option. The test
      // is on the NAME, so `--role=senior editor` is still the option it looks like.
      if (/\s/.test(name)) {
        positionals.push(token);
        continue;
      }
      if (!declared(name)) {
        unknown.push(`--${name}`);
        continue;
      }
      if (eq !== -1) {
        flags[name] = body.slice(eq + 1);
        continue;
      }
      if (boolSet.has(name)) {
        flags[name] = true;
        continue;
      }
      const next = argv[i + 1];
      // Take the next token as the value unless it is another flag. A token that
      // starts with "-" followed by a digit is a negative number (e.g. a Telegram
      // group id), so it counts as a value, not a flag.
      if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
      continue;
    }

    // A lone "-" is a positional; "-x" is a short boolean flag.
    if (token.startsWith("-") && token.length > 1) {
      const body = token.slice(1);
      if (!isNumericKey(body) && !declared(body)) {
        unknown.push(token);
        continue;
      }
      flags[body] = true;
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags, unknown };
}

/**
 * Every option this invocation carried that the named command does not take, as
 * typed — both the ones no command declared (collected by {@link parseArgs}) and
 * the ones a SIBLING verb declared but this one does not, which is how a shared
 * parse across subcommands (`config set --agent` vs `config recall-budget`) still
 * narrows per verb. A digit-keyed flag is skipped: that is a bare negative number,
 * not an option, and the setter that reads it has its own message for it.
 */
export function undeclaredOptions(parsed: ParsedArgs, allowed: readonly string[]): string[] {
  const known = new Set<string>([...allowed, ...ALWAYS_DECLARED]);
  return [
    ...parsed.unknown,
    ...Object.keys(parsed.flags)
      .filter((f) => !known.has(f) && !isNumericKey(f))
      .map((f) => `--${f}`),
  ];
}

/**
 * Whether an option CARRIES NOTHING — given with no value at all (which the parser reads
 * as boolean `true`), or given one that is only whitespace.
 *
 * One predicate, because every site that spelled this out by hand drifted from every
 * other. `--x "$VAR"` expands to `""` when the variable is unset and to `"  "` or `"\n"`
 * when it holds a stray space or the newline a `$(cat …)` leaves — one mistake wearing
 * two faces. Sites testing only `=== ""` let the second through: `api add --credential
 * "  "` bound an endpoint to a credential key of two spaces, and `channel telegram
 * --allow "  "` started a bot with no allow-list where one had been named.
 *
 * It decides PRESENCE only. A value with padding around something real is a value, and is
 * kept exactly as typed.
 */
export function carriesNothing(value: string | true | undefined): boolean {
  return value === true || (typeof value === "string" && value.trim().length === 0);
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
