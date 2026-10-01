/**
 * Railway Infrastructure as Code for the two Beacon services and the media
 * bucket (production environment of the `novarys-beacon` project).
 *
 * It mirrors the live configuration: both services build from this
 * repository's Dockerfile; the web service migrates in its pre-deploy step
 * (`pnpm release`) and is health checked; the worker has no pre-deploy step,
 * no health check and no public domain. Secrets stay in Railway: every
 * existing variable is declared with `preserve()`, and the bucket credentials
 * are references, so no value is ever written here.
 *
 * This file is a named partial: it manages only the resources it declares.
 * The Postgres database is not declared and is never touched by an apply.
 *
 *   railway link                      # project novarys-beacon, environment production
 *   railway config plan               # review: expect no unexpected change or delete
 *   railway config apply
 */
import { bucket, defineRailway, github, preserve, project, service } from "railway/iac";

export const partial = "beacon";

const REPO = "theflippinlabs/Novarys-beacon-";
const BRANCH = "claude/beacon-platform";
const REGION = "us-west2";

export default defineRailway(() => {
  const media = bucket("beacon-media", { region: "sjc" });

  // Bucket credentials as Railway references (they survive a credential reset).
  const mediaStorage = {
    BEACON_MEDIA_S3_ENDPOINT: "${{beacon-media.ENDPOINT}}",
    BEACON_MEDIA_S3_BUCKET: "${{beacon-media.BUCKET}}",
    BEACON_MEDIA_S3_REGION: "${{beacon-media.REGION}}",
    BEACON_MEDIA_S3_ACCESS_KEY_ID: "${{beacon-media.ACCESS_KEY_ID}}",
    BEACON_MEDIA_S3_SECRET_ACCESS_KEY: "${{beacon-media.SECRET_ACCESS_KEY}}",
  };

  const shared = {
    BEACON_BASE_URL: preserve(),
    BEACON_DB_SYSTEM_PASSWORD: preserve(),
    BEACON_DB_SYSTEM_USER: preserve(),
    BEACON_ENCRYPTION_KEY: preserve(),
    BEACON_HASH_SECRET: preserve(),
    DATABASE_URL: preserve(),
    NEXT_TELEMETRY_DISABLED: preserve(),
    NODE_ENV: preserve(),
  };

  const web = service("beacon-web", {
    source: github(REPO, { branch: BRANCH }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      startCommand: "pnpm start",
      preDeployCommand: ["pnpm release"],
      healthcheckPath: "/api/health",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    replicas: { [REGION]: 1 },
    domains: [
      { domain: "novarys.technology", port: 8080 },
      { domain: "www.novarys.technology", port: 8080 },
      { domain: "novarys.tech", port: 8080 },
      { domain: "www.novarys.tech", port: 8080 },
    ],
    env: {
      ...shared,
      ...mediaStorage,
      BEACON_DB_APP_PASSWORD: preserve(),
      BEACON_DB_APP_USER: preserve(),
      BEACON_EMBEDDED_WORKER: preserve(),
      BEACON_SETUP_TOKEN: preserve(),
      DATABASE_ADMIN_URL: preserve(),
    },
  });

  const worker = service("beacon-worker", {
    source: github(REPO, { branch: BRANCH }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      startCommand: "pnpm worker",
      restartPolicyType: "ALWAYS",
    },
    replicas: { [REGION]: 1 },
    env: {
      ...shared,
      ...mediaStorage,
      BEACON_WORKER_CONCURRENCY: preserve(),
    },
  });

  return project("novarys-beacon", { resources: [web, worker, media] });
});
