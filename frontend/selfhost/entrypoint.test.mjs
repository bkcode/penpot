import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "entrypoint.sh");

function runEntrypoint(flags, args = [], exitStatus = 0) {
  const directory = mkdtempSync(join(tmpdir(), "penpot-selfhost-entrypoint-"));
  try {
    const upstream = join(directory, "upstream.sh");
    const bashEnv = join(directory, "bash-env.sh");
    writeFileSync(
      upstream,
      'printf "%s\\0" "$PENPOT_FLAGS" "$@"\nexit "$SELFHOST_TEST_EXIT_STATUS"\n',
    );
    // Replace only the upstream process boundary, not the script under test.
    writeFileSync(
      bashEnv,
      `exec() {
  if [[ "$1" != /bin/bash || "$2" != /entrypoint.sh ]]; then
    exit 64
  fi
  shift 2
  command /bin/bash "$SELFHOST_TEST_UPSTREAM" "$@"
  exit $?
}
`,
    );
    const env = {
      ...process.env,
      BASH_ENV: bashEnv,
      SELFHOST_TEST_UPSTREAM: upstream,
      SELFHOST_TEST_EXIT_STATUS: String(exitStatus),
    };
    delete env.PENPOT_FLAGS;
    if (flags !== undefined) env.PENPOT_FLAGS = flags;
    const result = spawnSync("/bin/bash", [entrypoint, ...args], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, "");
    return {
      status: result.status,
      values: result.stdout.split("\0").slice(0, -1),
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("disables onboarding when deployment flags are unset or empty", () => {
  for (const flags of [undefined, ""]) {
    const result = runEntrypoint(flags);
    assert.equal(result.status, 0);
    assert.deepEqual(result.values, ["disable-onboarding"]);
  }
});

test("preserves deployment flags and disables onboarding after an earlier enable", () => {
  const flags = "enable-mcp enable-onboarding disable-registration";
  const result = runEntrypoint(flags);
  assert.equal(result.status, 0);
  assert.equal(result.values[0], `${flags} disable-onboarding`);
});

test("forwards the original command and arguments without shell expansion", () => {
  const args = ["nginx", "-g", "daemon off;", "space and $literal", ""];
  const result = runEntrypoint("enable-mcp", args);
  assert.equal(result.status, 0);
  assert.deepEqual(result.values.slice(1), args);
});

test("preserves the upstream exit status", () => {
  assert.equal(runEntrypoint(undefined, ["nginx"], 17).status, 17);
});
