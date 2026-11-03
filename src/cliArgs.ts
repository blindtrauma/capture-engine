// In PowerShell, `npm run <script> -- --flag value` loses its "--": npm's launcher there is a
// PowerShell script and "--" ends PowerShell's own parameters. npm then keeps the flags as its
// own settings (exported to the script as npm_config_<flag>) and passes only their values, so a
// run would quietly lose them: a lost --use-proxy means no proxy. This stops such a run instead.
// Flags must not share a name with an npm setting: npm validates its own (a bare --proxy is
// rejected as "not a full url") and drops them without a trace, which nothing here could see.

export function stopIfNpmTookFlags(script: string, entry: string, flags: string[], positionals: string[]): void {
  const taken = flags.filter((f) => process.env[`npm_config_${f.replace(/-/g, "_")}`] !== undefined);
  if (!taken.length && !positionals.length) return;
  const what = [
    taken.length ? `npm kept ${taken.map((f) => `--${f}`).join(", ")} as its own setting${taken.length > 1 ? "s" : ""}` : "",
    positionals.length ? `the script got ${positionals.map((p) => JSON.stringify(p)).join(" ")} without the option names` : "",
  ].filter(Boolean).join(" and ");
  console.error(`Not started: ${what}. PowerShell drops the "--" in "npm run ${script} -- ...".\nRun it as\n  npm.cmd run ${script} -- <options>\nor\n  npx tsx ${entry} <options>`);
  process.exit(2);
}
