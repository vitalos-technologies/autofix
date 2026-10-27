/**
 * Request headers the proxy sets on every admin-host request for server code
 * (src/proxy.ts). The proxy always overwrites them, so a client cannot choose
 * their values.
 */
export const REQUEST_METHOD_HEADER = "x-autofix-method";
/** The request path, without the query string. */
export const REQUEST_PATH_HEADER = "x-autofix-path";
