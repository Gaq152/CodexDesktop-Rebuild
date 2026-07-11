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
  "promote-windows-release.yml",
);

function readWorkflow() {
  assert.ok(fs.existsSync(workflowPath), "Windows release promotion workflow should exist");
  return fs.readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");
}

test("promotion workflow downloads only the exact Windows artifacts from the selected run", () => {
  const workflow = readWorkflow();

  assert.match(workflow, /source_run_id:\n\s+description:.*\n\s+required: true\n\s+type: string/);
  assert.match(workflow, /release_version:\n\s+description:.*\n\s+required: true\n\s+type: string/);
  assert.match(workflow, /permissions:\n\s+actions: read\n\s+contents: write/);
  assert.match(workflow, /uses: actions\/checkout@v\d+/);

  const downloads = [...workflow.matchAll(/uses: actions\/download-artifact@v7\n\s+with:\n(?<with>[\s\S]*?)(?=\n\s+- name:)/g)];
  assert.equal(downloads.length, 3, "workflow should have exactly three artifact downloads");
  const expectedNames = [
    "Codex-Windows-Installer-x64-${{ inputs.release_version }}",
    "Codex-Windows-Portable-x64-${{ inputs.release_version }}",
    "Codex-Windows-UpdateFeed-x64",
  ];
  for (const [index, expectedName] of expectedNames.entries()) {
    assert.ok(
      downloads[index].groups.with.includes(`name: ${expectedName}`),
      `download ${index + 1} should use exact artifact name ${expectedName}`,
    );
    assert.match(downloads[index].groups.with, /run-id: \$\{\{ inputs\.source_run_id \}\}/);
    assert.match(downloads[index].groups.with, /github-token: \$\{\{ github\.token \}\}/);
  }
  assert.doesNotMatch(workflow, /Codex-mac|\.dmg|build-mac/i);
});

test("promotion workflow validates installer portable and full package versions", () => {
  const workflow = readWorkflow();

  assert.match(workflow, /resolve-release-artifacts\.js --root artifacts\/installer --github-output/);
  assert.match(workflow, /resolve-release-artifacts\.js --root artifacts\/portable --github-output/);
  assert.match(workflow, /resolve-release-artifacts\.js --root artifacts\/update-feed --github-output/);
  assert.match(workflow, /steps\.installer_artifacts\.outputs\.windows_installer_version/);
  assert.match(workflow, /steps\.portable_artifacts\.outputs\.windows_portable_version/);
  assert.match(workflow, /steps\.package_artifacts\.outputs\.windows_installer_version/);
  assert.match(workflow, /EXPECTED_VERSION: \$\{\{ inputs\.release_version \}\}/);
  assert.match(workflow, /INSTALLER_VERSION: \$\{\{ steps\.installer_artifacts\.outputs\.windows_installer_version \}\}/);
  assert.match(workflow, /PORTABLE_VERSION: \$\{\{ steps\.portable_artifacts\.outputs\.windows_portable_version \}\}/);
  assert.match(workflow, /PACKAGE_VERSION: \$\{\{ steps\.package_artifacts\.outputs\.windows_installer_version \}\}/);
  assert.match(workflow, /\[ -z "\$actual" \] \|\| \[ "\$actual" != "\$EXPECTED_VERSION" \]/);
  assert.match(
    workflow,
    /validate-windows-release-feed\.js --root artifacts\/update-feed --version "\$\{\{ inputs\.release_version \}\}"/,
  );
});

test("promotion workflow publishes the exact Windows-only release contract", () => {
  const workflow = readWorkflow();

  assert.match(workflow, /tag_name: v\$\{\{ inputs\.release_version \}\}/);
  assert.doesNotMatch(workflow, /tag_name:.*\|\||tag_name:.*mac/i);
  assert.match(workflow, /name: Codex \$\{\{ inputs\.release_version \}\}/);
  assert.match(workflow, /Windows-only/i);
  assert.match(workflow, /App 26\.707\.31428/);
  assert.match(workflow, /CLI 0\.144\.1/);
  assert.match(workflow, /full-only,? no delta/i);
  assert.match(workflow, /artifacts\/installer\/CodexSetup-win-x64-\$\{\{ inputs\.release_version \}\}\.exe/);
  assert.match(workflow, /artifacts\/portable\/Codex-win-x64-\$\{\{ inputs\.release_version \}\}\.zip/);
  assert.match(workflow, /artifacts\/update-feed\/Codex-\$\{\{ inputs\.release_version \}\}-full\.nupkg/);
  assert.match(workflow, /artifacts\/update-feed\/RELEASES/);
  assert.match(workflow, /make_latest: true/);
});

test("promotion workflow reconciles the release to exactly four Windows assets", () => {
  const workflow = readWorkflow();
  const step = workflow.match(
    /      - name: Reconcile exact release assets\n(?<body>[\s\S]*?)$/,
  )?.groups.body;
  assert.ok(step, "release asset reconciliation step should exist after upload");
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step, /gh release view "\$RELEASE_TAG" --json assets --jq '\.assets\[\]\.name'/);
  assert.match(step, /gh release delete-asset "\$RELEASE_TAG" "\$asset" -y/);
  assert.match(step, /sort > "\$actual_assets"/);
  assert.match(step, /cmp -s "\$desired_assets" "\$actual_assets"/);

  const expectedAssets = [
    "CodexSetup-win-x64-${RELEASE_VERSION}.exe",
    "Codex-win-x64-${RELEASE_VERSION}.zip",
    "Codex-${RELEASE_VERSION}-full.nupkg",
    "RELEASES",
  ];
  for (const asset of expectedAssets) assert.ok(step.includes(`"${asset}"`));
  assert.doesNotMatch(step, /\.dmg|delta|\*\.nupkg|\*\.zip|\*\.exe/i);
});
