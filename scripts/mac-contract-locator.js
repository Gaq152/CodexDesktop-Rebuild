#!/usr/bin/env node

const PROBE_STATES = new Set(["irrelevant", "exact", "owned-malformed"]);
const VALIDATED_PLANS = new WeakMap();

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateCandidate(candidate, index) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`candidate ${index} must be an object`);
  }
  requireText(candidate.path, `candidate ${index} path`);
  requireText(candidate.fileName, `candidate ${index} fileName`);
  if (typeof candidate.source !== "string") {
    throw new Error(`candidate ${index} source must be a string`);
  }
}

function cannotSnapshot(path, detail) {
  throw new Error(`${path} cannot safely snapshot ${detail}`);
}

function snapshotSafeValue(value, path, active = new WeakSet()) {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    cannotSnapshot(path, `value of type ${typeof value}`);
  }
  if (active.has(value)) cannotSnapshot(path, "cyclic reference");

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        cannotSnapshot(path, "array with a custom prototype");
      }
      const extraKeys = Reflect.ownKeys(value).filter(
        (key) =>
          key !== "length" &&
          !(typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length),
      );
      if (extraKeys.length > 0) cannotSnapshot(path, "array with custom properties");

      const snapshot = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) continue;
        if (!Object.hasOwn(descriptor, "value")) {
          cannotSnapshot(`${path}[${index}]`, "accessor property");
        }
        snapshot[index] = snapshotSafeValue(descriptor.value, `${path}[${index}]`, active);
      }
      return Object.freeze(snapshot);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      cannotSnapshot(path, `value of type ${value.constructor?.name || "unknown"}`);
    }
    const snapshot = prototype === null ? Object.create(null) : {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") cannotSnapshot(path, "symbol-keyed property");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        cannotSnapshot(`${path}.${key}`, "non-data property");
      }
      snapshot[key] = snapshotSafeValue(descriptor.value, `${path}.${key}`, active);
    }
    return Object.freeze(snapshot);
  } finally {
    active.delete(value);
  }
}

function normalizeProbeOutput(output) {
  if (!output || typeof output !== "object") {
    throw new Error("probe must return an object");
  }
  if (!PROBE_STATES.has(output.state)) {
    throw new Error(`probe returned unsupported state: ${String(output.state)}`);
  }
  if (!Array.isArray(output.evidence) || output.evidence.some((item) => typeof item !== "string")) {
    throw new Error("probe evidence must be an array of strings");
  }
  if (
    Object.hasOwn(output, "result") &&
    (output.result == null || typeof output.result !== "object")
  ) {
    throw new Error("probe result must be an object when present");
  }
  if (Object.hasOwn(output, "error") && !(output.error instanceof Error)) {
    throw new Error("probe error must be an Error when present");
  }
  return {
    state: output.state,
    evidence: [...output.evidence],
    ...(Object.hasOwn(output, "result")
      ? { result: snapshotSafeValue(output.result, "probe result") }
      : {}),
    ...(Object.hasOwn(output, "error") ? { error: output.error } : {}),
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticLine({ path, state, evidence = [], mismatch }) {
  return (
    `path: ${path}; state: ${state}; ` +
    `evidence: ${evidence.length > 0 ? evidence.join(", ") : "none"}; ` +
    `strict mismatch: ${mismatch}`
  );
}

function contextualError({ platform, role, label, diagnostics, causes = [] }) {
  return new Error(
    `[${platform}] ${role} ${label}:\n${diagnostics.map((line) => `- ${line}`).join("\n")}`,
    causes.length > 0 ? { cause: new AggregateError(causes) } : undefined,
  );
}

function probeCandidates({ platform, role, candidates, probe }) {
  requireText(platform, "platform");
  requireText(role, "role");
  if (!Array.isArray(candidates)) throw new Error("candidates must be an array");
  if (typeof probe !== "function") throw new Error("probe must be a function");

  const probes = [];
  const failures = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      validateCandidate(candidate, index);
      const readOnlyCandidate = Object.freeze({
        path: candidate.path,
        fileName: candidate.fileName,
        source: candidate.source,
      });
      probes.push({
        platform,
        role,
        candidate,
        ...normalizeProbeOutput(probe(readOnlyCandidate)),
      });
    } catch (error) {
      failures.push({ candidate, index, error });
    }
  }

  if (failures.length > 0) {
    const diagnostics = failures.map(({ candidate, index, error }) => {
      const candidatePath = candidate?.path || `<candidate ${index}>`;
      return diagnosticLine({
        path: candidatePath,
        state: "probe-error",
        evidence: [],
        mismatch: errorMessage(error),
      });
    });
    throw contextualError({
      platform,
      role,
      label: "candidate probe failed",
      diagnostics,
      causes: failures.map(({ error }) => error),
    });
  }

  return probes;
}

function formatProbe(probe) {
  let mismatch;
  if (probe.state === "owned-malformed") {
    mismatch = Object.hasOwn(probe, "error")
      ? errorMessage(probe.error)
      : "owned candidate failed its strict contract";
  } else if (probe.state === "irrelevant") {
    mismatch = "candidate is irrelevant";
  } else {
    mismatch = "none";
  }
  return diagnosticLine({
    path: probe.candidate.path,
    state: probe.state,
    evidence: probe.evidence,
    mismatch,
  });
}

function validateProbeRecord(probe, index, platform, role) {
  if (!probe || typeof probe !== "object") {
    throw new Error(`probe ${index} must be an object`);
  }
  requireText(probe.platform, `probe ${index} platform`);
  requireText(probe.role, `probe ${index} role`);
  if (probe.platform !== platform) {
    throw new Error(`probe platform ${probe.platform} does not match ${platform}`);
  }
  if (probe.role !== role) {
    throw new Error(`probe role ${probe.role} does not match ${role}`);
  }
  validateCandidate(probe.candidate, index);
  return {
    platform: probe.platform,
    role: probe.role,
    candidate: probe.candidate,
    ...normalizeProbeOutput(probe),
  };
}

function reduceRequiredRole({ platform, role, probes }) {
  requireText(platform, "platform");
  requireText(role, "role");
  if (!Array.isArray(probes)) throw new Error("probes must be an array");

  const normalized = [];
  const validationFailures = [];
  for (const [index, probe] of probes.entries()) {
    try {
      normalized.push(validateProbeRecord(probe, index, platform, role));
    } catch (error) {
      validationFailures.push({ probe, index, error });
    }
  }
  if (validationFailures.length > 0) {
    throw contextualError({
      platform,
      role,
      label: "probe validation failed",
      diagnostics: validationFailures.map(({ probe, index, error }) =>
        diagnosticLine({
          path: probe?.candidate?.path || `<probe ${index}>`,
          state: probe?.state || "invalid",
          evidence: Array.isArray(probe?.evidence) ? probe.evidence : [],
          mismatch: errorMessage(error),
        }),
      ),
      causes: validationFailures.map(({ error }) => error),
    });
  }

  const exact = normalized.filter((item) => item.state === "exact");
  const malformed = normalized.filter((item) => item.state === "owned-malformed");
  if (exact.length === 1 && malformed.length === 0) {
    return {
      platform,
      role,
      candidate: exact[0].candidate,
      result: exact[0].result,
    };
  }

  const details =
    normalized.length > 0
      ? normalized.map(formatProbe)
      : [
          diagnosticLine({
            path: "<no candidates>",
            state: "missing",
            evidence: [],
            mismatch: "expected exactly one exact candidate, found 0",
          }),
        ];
  throw new Error(
    `[${platform}] ${role} required contract reduction failed ` +
      `(exact candidates: ${exact.length}, owned-malformed: ${malformed.length}):\n` +
      details.map((line) => `- ${line}`).join("\n"),
  );
}

function validateRoleDefinition(definition, index) {
  if (!definition || typeof definition !== "object") {
    throw new Error(`role ${index} must be an object`);
  }
  requireText(definition.role, `role ${index} name`);
  if (!Array.isArray(definition.candidates)) {
    throw new Error(`role ${definition.role} candidates must be an array`);
  }
  if (typeof definition.probe !== "function") {
    throw new Error(`role ${definition.role} probe must be a function`);
  }
}

function planRequiredRoles({ platform, roles }) {
  requireText(platform, "platform");
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error(`[${platform}] required roles must be a non-empty array`);
  }

  const seenRoles = new Set();
  for (const [index, definition] of roles.entries()) {
    validateRoleDefinition(definition, index);
    if (seenRoles.has(definition.role)) {
      throw new Error(`[${platform}] duplicate required role: ${definition.role}`);
    }
    seenRoles.add(definition.role);
  }

  const probedRoles = [];
  const failures = [];
  for (const definition of roles) {
    try {
      probedRoles.push({
        role: definition.role,
        probes: probeCandidates({
          platform,
          role: definition.role,
          candidates: definition.candidates,
          probe: definition.probe,
        }),
      });
    } catch (error) {
      failures.push(error);
    }
  }

  const reducedRoles = [];
  for (const probed of probedRoles) {
    try {
      reducedRoles.push(
        reduceRequiredRole({ platform, role: probed.role, probes: probed.probes }),
      );
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[${platform}] required role plan failed:\n${failures.map((error) => error.message).join("\n")}`,
      { cause: new AggregateError(failures) },
    );
  }

  const validatedRoles = reducedRoles.map((reduced) =>
    Object.freeze({
      ...reduced,
      candidate: Object.freeze({ ...reduced.candidate }),
    }),
  );
  const plan = Object.freeze({
    platform,
    roles: Object.freeze(validatedRoles),
  });
  VALIDATED_PLANS.set(plan, Object.freeze({ platform, roles: Object.freeze(validatedRoles) }));
  return plan;
}

function commitValidatedPlan({ plan, writer }) {
  const validatedPlan = plan && VALIDATED_PLANS.get(plan);
  if (!validatedPlan) {
    throw new Error("commit requires a validated plan from planRequiredRoles");
  }
  if (typeof writer !== "function") throw new Error("writer must be a function");
  return validatedPlan.roles.map((reduced) => writer(reduced));
}

module.exports = {
  probeCandidates,
  reduceRequiredRole,
  planRequiredRoles,
  commitValidatedPlan,
};
