import type { IntegrationId, JobRecord, JobReporter, ReporterFactory } from "./types.js";

export type IntegrationReporterFactories = Partial<Record<IntegrationId, ReporterFactory>>;

export class MissingIntegrationReporterError extends Error {
  readonly code = "DELIVERY_ADAPTER_MISSING";

  constructor(readonly integration: string) {
    super("No delivery adapter is registered for integration " + JSON.stringify(integration));
    this.name = "MissingIntegrationReporterError";
  }
}

/** Resolves delivery from the integration persisted on each job. */
export class IntegrationReporterRegistry {
  private readonly factories: ReadonlyMap<IntegrationId, ReporterFactory>;

  constructor(factories: IntegrationReporterFactories) {
    this.factories = new Map(Object.entries(factories) as [IntegrationId, ReporterFactory][]);
  }

  reporter(job: JobRecord): JobReporter {
    const factory = this.factories.get(job.integration);
    if (!factory) throw new MissingIntegrationReporterError(job.integration);
    return factory(job);
  }
}
