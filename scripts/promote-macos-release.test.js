#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "promote-macos-release.yml",
);

function readWorkflow() {
  assert.ok(fs.existsSync(workflowPath), "macOS release promotion workflow should exist");
  return fs.readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");
}

function namedStep(workflow, name) {
  return workflow.match(
    new RegExp(`      - name: ${name}\\n(?<body>[\\s\\S]*?)(?=\\n      - name:|$)`),
  )?.groups.body;
}

test("workflow validates fixed promotion inputs before any external action", () => {
  const workflow = readWorkflow();
  assert.match(workflow, /on:\n  workflow_dispatch:\n    inputs:/);
  assert.match(workflow, /source_run_id:\n\s+description:.*\n\s+required: true\n\s+type: string/);
  assert.match(workflow, /release_version:\n\s+description:.*\n\s+required: true\n\s+type: string/);
  assert.match(workflow, /permissions:\n\s+actions: read\n\s+contents: write/);

  const firstStep = workflow.match(
    /    steps:\n      - name: Validate promotion inputs\n(?<body>[\s\S]*?)(?=\n      - name:)/,
  )?.groups.body;
  assert.ok(firstStep, "input validation should be the first step");
  assert.match(firstStep, /RELEASE_VERSION: \$\{\{ inputs\.release_version \}\}/);
  assert.match(firstStep, /SOURCE_RUN_ID: \$\{\{ inputs\.source_run_id \}\}/);
  assert.match(firstStep, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(firstStep, /"\$RELEASE_VERSION" != "26\.707\.41301"/);
  assert.doesNotMatch(firstStep, /uses:/);
});

test("workflow validates a successful same-repository build run with only macOS artifacts", () => {
  const workflow = readWorkflow();
  const step = namedStep(workflow, "Validate source run provenance");
  assert.ok(step, "source run provenance step should exist");
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step, /SOURCE_RUN_ID: \$\{\{ inputs\.source_run_id \}\}/);
  assert.match(step, /CURRENT_REF: \$\{\{ github\.ref \}\}/);
  assert.match(step, /CURRENT_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(step, /GITHUB_OUTPUT/);
  assert.match(step, /default_branch/);
  assert.match(step, /refs\/heads\/\$\{default_branch\}/);
  assert.match(step, /git\/ref\/heads\/\$\{default_branch\}/);
  assert.match(step, /GITHUB_REPOSITORY/);
  assert.match(step, /\.github\/workflows\/build\.yml/);
  assert.match(step, /workflow_dispatch/);
  assert.match(step, /completed/);
  assert.match(step, /success/);
  assert.match(step, /head_repository\.full_name/);
  assert.match(step, /head_branch/);
  assert.match(step, /source_head_sha=/);
  assert.match(step, /actions\/runs\/\$\{SOURCE_RUN_ID\}\/artifacts/);
  assert.match(step, /total_count.*2/);
  assert.ok(step.includes('"Codex-macOS-arm64"'));
  assert.ok(step.includes('"Codex-macOS-x64"'));
  assert.match(step, /expired/);
});

test("workflow downloads exactly the two architecture artifacts from the selected run", () => {
  const workflow = readWorkflow();
  const downloads = [...workflow.matchAll(
    /uses: actions\/download-artifact@v7\n\s+with:\n(?<with>[\s\S]*?)(?=\n\s+- name:)/g,
  )];
  assert.equal(downloads.length, 2);
  const expected = [
    ["Codex-macOS-arm64", "artifacts/arm64"],
    ["Codex-macOS-x64", "artifacts/x64"],
  ];
  for (const [index, [name, destination]] of expected.entries()) {
    const block = downloads[index].groups.with;
    assert.ok(block.includes(`name: ${name}`));
    assert.ok(block.includes(`path: ${destination}`));
    assert.match(block, /run-id: \$\{\{ inputs\.source_run_id \}\}/);
    assert.match(block, /github-token: \$\{\{ github\.token \}\}/);
    assert.doesNotMatch(block, /pattern:|merge-multiple:/);
  }
  assert.match(
    workflow,
    /node scripts\/validate-macos-release-artifacts\.js --root artifacts --version "\$RELEASE_VERSION"/,
  );
});

test("workflow publishes only the fixed macOS release and two exact DMGs", () => {
  const workflow = readWorkflow();
  const releaseIndex = workflow.indexOf("uses: softprops/action-gh-release@v3");
  const validatorIndex = workflow.indexOf("validate-macos-release-artifacts.js");
  const preflightIndex = workflow.indexOf("Validate target release and tag state");
  assert.ok(validatorIndex !== -1 && validatorIndex < preflightIndex && preflightIndex < releaseIndex);
  assert.match(workflow, /tag_name: v26\.707\.41301/);
  assert.match(workflow, /name: Codex 26\.707\.41301/);
  assert.match(workflow, /macOS-only release promoted from GitHub Actions run/);
  assert.match(workflow, /artifacts\/arm64\/Codex-mac-arm64-26\.707\.41301\.dmg/);
  assert.match(workflow, /artifacts\/x64\/Codex-mac-x64-26\.707\.41301\.dmg/);
  assert.match(workflow, /fail_on_unmatched_files: true/);
  assert.match(workflow, /overwrite_files: true/);
  assert.match(workflow, /make_latest: false/);
  assert.doesNotMatch(workflow, /make_latest: true/);
  assert.match(workflow, /target_commitish: \$\{\{ steps\.source_run\.outputs\.source_head_sha \}\}/);
  assert.equal(
    [...workflow.matchAll(/uses: softprops\/action-gh-release@v3/g)].length,
    1,
    "the release action version and count should remain explicit",
  );
  const files = workflow.match(/          files: \|\n(?<files>(?:            .*\n)+)/)?.groups.files ?? "";
  const fileLines = files.trim().split("\n").map((line) => line.trim());
  assert.deepEqual(fileLines, [
    "artifacts/arm64/Codex-mac-arm64-26.707.41301.dmg",
    "artifacts/x64/Codex-mac-x64-26.707.41301.dmg",
  ]);
  assert.doesNotMatch(files, /[*?\[\]]/);
});

test("workflow safely refreshes an existing release or creates a wholly unused release and tag", () => {
  const workflow = readWorkflow();
  const preflight = namedStep(workflow, "Validate target release and tag state");
  const postflight = namedStep(workflow, "Verify exact promoted release assets");
  assert.ok(preflight);
  assert.ok(postflight);
  assert.match(preflight, /RELEASE_TAG: v26\.707\.41301/);
  assert.match(preflight, /curl --silent --show-error/);
  assert.match(preflight, /--write-out '%\{http_code\}'/);
  assert.match(preflight, /releases\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(preflight, /git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(preflight, /"\$release_status:\$tag_status"/);
  assert.match(preflight, /200:200\)/);
  assert.match(preflight, /404:404\)/);
  assert.match(preflight, /release and tag must either both exist or both be absent/i);
  assert.match(preflight, /\.tag_name == \$release_tag/);
  assert.match(preflight, /\.draft == false/);
  assert.match(preflight, /\.prerelease == false/);
  assert.match(preflight, /Unexpected API status/);
  assert.match(postflight, /RELEASE_TAG: v26\.707\.41301/);
  assert.match(postflight, /cmp -s "\$desired_assets" "\$actual_assets"/);
  assert.match(postflight, /Exact macOS release asset verification failed/);
  assert.doesNotMatch(workflow, /delete-asset|gh release delete/);
  assert.doesNotMatch(preflight, /refusing overwrite|already exists/i);
});

test("workflow is isolated from old and non-macOS release channels", () => {
  const workflow = readWorkflow();
  assert.doesNotMatch(
    workflow,
    /26\.707\.31428|windows|update[-_]feed|\.zip|\.exe|\.nupkg|tag_name:.*\|\||\*\.dmg/i,
  );
  assert.doesNotMatch(workflow, /(?:^|\s)RELEASES(?:\s|$)/);
  assert.doesNotMatch(workflow, /push:|schedule:|workflow_call:/);
});
