export const ROLES = ["OWNER", "ADMIN", "EDITOR", "ANALYST", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "read",
  "query:write",
  "job:run",
  "product:write",
  "content:write",
  "content:approve",
  "distribution:write",
  "distribution:approve",
  "growth:write",
  "recommendation:decide",
  "revenue:write",
  "integration:manage",
  "apikey:manage",
  "member:manage",
  "settings:manage",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = ["read"];
const ANALYST: Permission[] = [...VIEWER, "query:write", "job:run", "audit:read"];
const EDITOR: Permission[] = [...ANALYST, "product:write", "content:write", "distribution:write", "growth:write"];
const ADMIN: Permission[] = [
  ...EDITOR,
  "content:approve",
  "distribution:approve",
  "recommendation:decide",
  "revenue:write",
  "integration:manage",
  "apikey:manage",
  "member:manage",
  "settings:manage",
];
const OWNER: Permission[] = [...PERMISSIONS];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER),
  ANALYST: new Set(ANALYST),
  EDITOR: new Set(EDITOR),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role]?.has(permission) ?? false;
}

/** A member may only assign roles strictly below their own (owners may assign any). */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === "OWNER") return true;
  return ROLES.indexOf(target) > ROLES.indexOf(actor) && can(actor, "member:manage");
}

export class ForbiddenError extends Error {
  constructor(public permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
  }
}
