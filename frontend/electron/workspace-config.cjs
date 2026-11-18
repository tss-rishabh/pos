const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
function invalid() {
  throw new Error('The desktop workspace configuration is unavailable or invalid.');
}
function workspaceUrl(value, development = false) {
  try {
    if (typeof value !== 'string' || value.length < 1 || value.length > 2048) invalid();
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      invalid();
    return url.href;
  } catch {
    invalid();
  }
}
function exactOrigins(input) {
  if (!Array.isArray(input) || input.length > 20) invalid();
  const values = input.map((value) => {
    try {
      if (typeof value !== 'string' || value.length > 2048) invalid();
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        invalid();
      return url.origin;
    } catch {
      invalid();
    }
  });
  return [...new Set(values)];
}
function originList(value = '') {
  if (typeof value !== 'string' || value.length > 16000) invalid();
  return exactOrigins(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}
function validateWorkspace(value, development = false) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'applicationOrigins,customerWebsiteOrigin,oauthOrigins,url,v' ||
    value.v !== VERSION
  )
    invalid();
  const customer =
    value.customerWebsiteOrigin === null ? [] : exactOrigins([value.customerWebsiteOrigin]);
  return Object.freeze({
    v: VERSION,
    url: workspaceUrl(value.url, development),
    oauthOrigins: Object.freeze(exactOrigins(value.oauthOrigins)),
    applicationOrigins: Object.freeze(exactOrigins(value.applicationOrigins)),
    customerWebsiteOrigin: customer[0] ?? null,
  });
}
/** Only nonsecret deployment settings are allowlisted. No cookie, credential,
 * IdP token, renderer preference, arbitrary file path or fallback URL is copied. */
function workspaceFromEnvironment(env = process.env, development = false) {
  const customer = originList(env.POS_CUSTOMER_WEBSITE_ORIGIN || '');
  if (customer.length > 1) invalid();
  return validateWorkspace(
    {
      v: VERSION,
      url: workspaceUrl(env.POS_DESKTOP_URL, development),
      oauthOrigins: originList(env.POS_OAUTH_ORIGINS || ''),
      applicationOrigins: originList(env.POS_APP_LINK_ORIGINS || ''),
      customerWebsiteOrigin: customer[0] ?? null,
    },
    development,
  );
}
function readBundledWorkspace(filename = path.join(__dirname, 'workspace.json')) {
  let fd;
  try {
    fd = fs.openSync(filename, 'r');
    const size = fs.fstatSync(fd);
    if (!size.isFile() || size.size < 1 || size.size > 16384) invalid();
    const bytes = Buffer.alloc(16385);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used < 1 || used > 16384) invalid();
    return validateWorkspace(JSON.parse(bytes.subarray(0, used).toString('utf8')));
  } catch {
    invalid();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
/** Explicit OS environment provisioning remains supported. Otherwise normal
 * Finder/Start-menu launches use the configuration protected by signed ASAR.
 * Environment and bundled allowlists are never implicitly merged. */
function readWorkspaceConfiguration(env = process.env, filename) {
  if (env.POS_DESKTOP_URL) return workspaceFromEnvironment(env, env.NODE_ENV === 'development');
  return readBundledWorkspace(filename);
}
module.exports = { workspaceFromEnvironment, readWorkspaceConfiguration };
