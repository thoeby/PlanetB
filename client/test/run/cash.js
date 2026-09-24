// The world's cash for a run (PLAN-money.md §1): the issuer and the bank it
// reads from (tools/taler-up.sh), and walletd, which keeps the wallets. Like
// the GeoServer, these are running processes the stories only ever meet
// through the page.
//
// A machine without the Taler binaries on PATH runs the world without cash,
// and says so: every story that needs money then fails on that sentence.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function startCash(repo, { keep }) {
    const sh = (...args) => spawnSync('bash', ['tools/taler-up.sh', ...args],
        { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    if (spawnSync('which', ['taler-exchange-httpd']).status !== 0) {
        return { kind: 'none', why: 'no GNU Taler on PATH (see HANDOFF.md, "Cash")',
            stop() {}, stopIssuer() {}, startIssuer() {} };
    }
    const home = join(repo, 'data/walletd-run');
    if (!keep) {
        sh('reset');
        rmSync(home, { recursive: true, force: true });
    }
    const up = sh();
    if (!up.stdout.includes('<<READY>>')) {
        throw new Error(`the world's cash did not come up:\n${up.stdout}${up.stderr}`);
    }
    mkdirSync(home, { recursive: true });
    const log = openSync(join(repo, 'test-results/run/walletd.log'), 'a');
    const walletd = spawn('splatworld', ['walletd'], { cwd: repo, detached: true,
        env: { ...process.env, WALLETD_HOME: home }, stdio: ['ignore', log, log] });
    return {
        kind: 'taler',
        stop() {
            try { process.kill(-walletd.pid); } catch { walletd.kill(); }
            sh('stop');
        },
        stopIssuer: () => sh('stop-issuer'),
        startIssuer: () => sh(),
    };
}
