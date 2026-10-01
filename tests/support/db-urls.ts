/** System-role URL for a test database: TEST_DATABASE_SYSTEM_URL, or the same database as beacon_system. */
export function testSystemUrl(testUrl: string): string {
  if (process.env.TEST_DATABASE_SYSTEM_URL) return process.env.TEST_DATABASE_SYSTEM_URL;
  const u = new URL(testUrl);
  u.username = "beacon_system";
  u.password = "beacon_system";
  return u.toString();
}
