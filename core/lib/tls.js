'use strict';

/**
 * A certificate, so the microphone works.
 *
 * Browsers only allow speech recognition — and getUserMedia generally — in a secure
 * context: https, or localhost. A controller served over plain http from `10.42.0.1` is
 * neither, so on a phone the microphone silently never hears anything. No prompt, no error.
 *
 * There is no certificate authority on a private network with no internet, so the
 * certificate is self-signed and generated here. The browser will warn once; accepting it
 * grants the secure context, and the microphone works from then on.
 *
 * Core keeps serving plain http as well, on its usual port. The agents talk to that, and
 * they should: they use curl and PowerShell, which would need a flag to accept a
 * self-signed certificate, and making enrolment depend on that is a good way to lose a
 * teammate's laptop to a TLS error five minutes before a talk. Browsers get https, machines
 * get http, and both reach the same Core.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const log = require('./log');

/** Ten years. This is a demo certificate; expiry is not the threat being managed. */
const DAYS = 3650;

/**
 * Every address the certificate should be valid for.
 *
 * A certificate naming only one IP breaks the moment the machine gets a different one — a
 * different venue, a different interface, a phone tether renumbering the network. Every
 * local address is included so the same file keeps working.
 */
function subjectNames() {
  const names = new Set(['localhost']);
  const ips = new Set(['127.0.0.1', '::1']);

  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces || []) {
      if (entry.family === 'IPv4' && !entry.internal) ips.add(entry.address);
    }
  }

  // 10.42.0.1 is where NetworkManager puts a shared connection, so it is the address the
  // room will use even on a machine where the interface is not up yet.
  ips.add('10.42.0.1');

  return { names: [...names], ips: [...ips] };
}

function opensslAvailable() {
  return spawnSync('sh', ['-c', 'command -v openssl'], { stdio: 'ignore' }).status === 0;
}

/**
 * Make a certificate if there is not one, and return it.
 *
 * Regenerated when the machine's addresses have changed, because a certificate that does
 * not name the address in the URL bar produces a warning the browser will not let you
 * click past on some platforms.
 */
function ensure(dir) {
  const certDir = path.resolve(dir);
  const keyFile = path.join(certDir, 'key.pem');
  const certFile = path.join(certDir, 'cert.pem');
  const stampFile = path.join(certDir, 'addresses.txt');

  const { names, ips } = subjectNames();
  const stamp = [...names, ...ips].sort().join(',');

  const current = (() => {
    try {
      return fs.readFileSync(stampFile, 'utf8').trim();
    } catch {
      return null;
    }
  })();

  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && current === stamp) {
    return { ok: true, key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), regenerated: false };
  }

  if (!opensslAvailable()) {
    log.warn('no openssl, so no https — the microphone will not work from a phone', {
      install: 'sudo apt install -y openssl',
    });
    return { ok: false, reason: 'no_openssl' };
  }

  try {
    fs.mkdirSync(certDir, { recursive: true });
  } catch (err) {
    log.warn('could not create the certificate directory', { dir: certDir, error: err.message });
    return { ok: false, reason: 'no_directory' };
  }

  // -addext keeps everything in one invocation; a config file would be another thing to
  // ship and keep in step with the address list above.
  const san = [...names.map((n) => `DNS:${n}`), ...ips.map((i) => `IP:${i}`)].join(',');

  const result = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyFile,
      '-out', certFile,
      '-days', String(DAYS),
      '-subj', '/CN=JARVIS Core',
      '-addext', `subjectAltName=${san}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }
  );

  if (result.status !== 0) {
    log.warn('could not generate a certificate', {
      error: String(result.stderr || '').trim().split('\n').pop(),
    });
    return { ok: false, reason: 'openssl_failed' };
  }

  try {
    fs.chmodSync(keyFile, 0o600);
    fs.writeFileSync(stampFile, stamp + '\n');
  } catch {
    /* not fatal */
  }

  log.good('certificate generated', { valid_for: `${ips.length} address(es)`, dir: certDir });

  return { ok: true, key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), regenerated: true };
}

module.exports = { ensure, subjectNames };
