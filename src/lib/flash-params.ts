/**
 * Query parameters of a flash message (shared by the server signer and the
 * client component that removes them once shown). No secrets here.
 */
export const FLASH_SIG_PARAM = "fs";
export const FLASH_PARAMS = ["ok", "error", FLASH_SIG_PARAM] as const;
