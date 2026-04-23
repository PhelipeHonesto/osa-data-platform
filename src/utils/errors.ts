/**
 * Typed error hierarchy for Dumont Agent.
 * Every error carries dealId, stage, and timestamp for structured logging
 * and debugging. The communication layer will route these to Mission Control.
 */

/** Base error for all Dumont Agent errors. */
export class DumontError extends Error {
  readonly dealId: string | null;
  readonly stage: string | null;
  readonly timestamp: string;

  constructor(message: string, options?: { dealId?: string; stage?: string }) {
    super(message);
    this.name = "DumontError";
    this.dealId = options?.dealId ?? null;
    this.stage = options?.stage ?? null;
    this.timestamp = new Date().toISOString();
  }
}

/** Thrown when intake parsing or qualification fails. */
export class IntakeError extends DumontError {
  constructor(message: string, options?: { dealId?: string }) {
    super(message, { ...options, stage: "intake" });
    this.name = "IntakeError";
  }
}

/** Thrown when Guardian blocks the pipeline. */
export class GuardianError extends DumontError {
  readonly blockReason: string;

  constructor(message: string, options: { dealId?: string; stage: string; blockReason: string }) {
    super(message, { dealId: options.dealId, stage: options.stage });
    this.name = "GuardianError";
    this.blockReason = options.blockReason;
  }
}

/** Thrown when estimate or quote processing fails. */
export class QuoteError extends DumontError {
  constructor(message: string, options?: { dealId?: string; stage?: string }) {
    super(message, { ...options, stage: options?.stage ?? "quoted" });
    this.name = "QuoteError";
  }
}

/** Thrown when operator sourcing fails. */
export class SourcingError extends DumontError {
  constructor(message: string, options?: { dealId?: string }) {
    super(message, { ...options, stage: "sourced" });
    this.name = "SourcingError";
  }
}

/** Thrown when the pipeline encounters an unrecoverable error. */
export class PipelineError extends DumontError {
  readonly outcome: string;

  constructor(message: string, options: { dealId?: string; stage?: string; outcome: string }) {
    super(message, { dealId: options.dealId, stage: options.stage });
    this.name = "PipelineError";
    this.outcome = options.outcome;
  }
}

/** Thrown when scenario/presentation building fails. */
export class ScenarioError extends DumontError {
  constructor(message: string, options?: { dealId?: string }) {
    super(message, { ...options, stage: "presented" });
    this.name = "ScenarioError";
  }
}
