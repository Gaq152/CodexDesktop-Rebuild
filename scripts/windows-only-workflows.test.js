#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflows = ["build.yml", "sync.yml"].map((name) => ({
  name,
  text: fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", name),
    "utf8",
  ).replace(/\r\n/g, "\n"),
}));

test("default and scheduled build workflows are Windows-only", () => {
  for (const { name, text } of workflows) {
    assert.match(
      text,
      /concurrency:\n\s+group: codex-windows-release-state\n\s+cancel-in-progress: false/,
    );
    assert.match(text, /^  build-windows:\s*$/m, `${name} must build Windows`);
    assert.doesNotMatch(text, /^  build-mac:\s*$/m, `${name} must not contain a macOS build job`);
    assert.doesNotMatch(text, /macos-(?:latest|\d+)|build:mac|sync-upstream\.js --force --skip-win/);
  }
  const scheduled = workflows.find(({ name }) => name === "sync.yml").text;
  assert.match(
    scheduled,
    /node scripts\/check-update\.js --windows-only --json --force/,
  );
});

test("Windows releases use official+rN codex-win tags and ZIP-only public assets", () => {
  for (const { name, text } of workflows) {
    assert.match(
      text,
      /configure-windows-release-version\.js/,
    );
    assert.match(text, /--previous["', ]+scripts\/upstream-versions\.json/);
    assert.match(text, /--write-package["', ]+package\.json/);
    assert.match(text, /--write-package["', ]+src\/win\/_asar\/package\.json/);
    assert.match(text, /--github-output/);
    assert.match(text, /windows_internal_app_version/);
    assert.match(text, /windows_package_version/);
    assert.match(text, /tag_name: codex-win-/i, `${name} must use codex-win tags`);
    assert.match(text, /name: Codex Win /i, `${name} must use the Windows release title`);
    assert.match(text, /CodexSetup-win-x64-.*\.zip/);
    assert.match(
      text,
      /validate-windows-release-feed\.js --root out\/update-feed --version "\$\{\{ steps\.windows_artifacts\.outputs\.windows_package_version \}\}"/,
    );
    assert.match(text, /scripts\/windows-release-metadata\.js/);
    assert.match(text, /--write["', ]+out\/windows-release-metadata\.json/);
    assert.match(text, /Codex-Windows-Release-Metadata-x64-/);
    const release = text.match(/uses: softprops\/action-gh-release@v3[\s\S]*?(?=\n\s+- name: Prepare Windows update feed|\n\s+- name: Publish Windows update feed)/)?.[0] || "";
    assert.match(release, /Codex-win-x64-.*\.zip/);
    assert.match(release, /CodexSetup-win-x64-.*\.zip/);
    assert.doesNotMatch(release, /artifacts\/.*(?:\.exe|\.nupkg)|artifacts\/.*RELEASES/);
  }
});

test("the manual workflow publishes Windows by default", () => {
  const workflow = workflows.find(({ name }) => name === "build.yml").text;
  assert.match(workflow, /publish_release:\s*\n(?:\s+.*\n)*?\s+default: true\s*\n\s+type: boolean/);
  assert.match(workflow, /publish_update_feed:\s*\n(?:\s+.*\n)*?\s+default: true\s*\n\s+type: boolean/);
  assert.doesNotMatch(workflow, /\n\s+platform:\s*\n/);
  assert.doesNotMatch(workflow, /^  publish-windows-update-feed:\s*$/m);
  assert.match(workflow, /name: Validate replacement inputs/);
  assert.ok(
    workflow.indexOf("name: Validate replacement inputs") < workflow.indexOf("uses: actions\/setup-node@v6"),
  );
});

test("scheduled sync publishes directly while manual sync stays isolated as a draft", () => {
  const workflow = workflows.find(({ name }) => name === "sync.yml").text;
  const release = workflow.match(
    /- name: Create Windows Release[\s\S]*?(?=\n\s+- name: Prepare Windows update feed)/,
  )?.[0] || "";

  assert.match(release, /draft: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(release, /make_latest: \$\{\{ github\.event_name == 'schedule' \}\}/);
  assert.match(
    workflow,
    /- name: Record built Windows versions\n\s+if: github\.event_name == 'schedule'/,
  );
  assert.match(
    workflow,
    /- name: Prepare Windows update feed\n\s+if: github\.event_name == 'schedule'/,
  );
  assert.match(
    workflow,
    /- name: Publish Windows update feed\n\s+if: github\.event_name == 'schedule'/,
  );
  assert.doesNotMatch(workflow, /name: Create draft Windows Release/);
});

test("manual and scheduled releases reject mutable or rollback feed state before committing", () => {
  for (const { name, text } of workflows) {
    const validateIndex = text.indexOf("name: Validate release metadata and monotonic state");
    const recordIndex = text.indexOf("name: Record built Windows versions");
    const releaseIndex = text.search(/name: Create (?:draft )?Windows (?:GitHub )?Release/);
    assert.ok(validateIndex !== -1, `${name} must validate remote release state`);
    assert.ok(validateIndex < recordIndex && recordIndex < releaseIndex);
    assert.match(text, /windows-release-metadata\.js \\\n\s+--metadata "\$metadata_file" \\\n\s+--validate-promotion/);
    assert.match(text, /--remote-releases "\$remote_releases"/);
    assert.match(text, /404\) : > "\$remote_releases"/);
  }
});
