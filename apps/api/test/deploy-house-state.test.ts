// The House state root is deployment config, not a hand-made VM file: on a hardened unit
// (ProtectHome/ProtectSystem) the House work port's git state root and the Docker socket need
// explicit grants, and an untracked /etc/systemd drop-in is how they get lost on the next deploy.
// These checks pin the tracked unit to the grant a fresh deploy needs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "../../..");
const unit = readFileSync(join(root, "deploy/acquit-api.service"), "utf8");
const configure = readFileSync(join(root, "deploy/configure.sh"), "utf8");

function serviceSection(unitText: string): string {
	const start = unitText.indexOf("[Service]");
	const install = unitText.indexOf("[Install]");
	assert(start !== -1, "the unit has a [Service] section");
	return unitText.slice(start, install === -1 ? undefined : install);
}

function assignments(section: string, name: string): readonly string[] {
	return section.split("\n").filter(line => line.startsWith(`${name}=`)).map(line => line.slice(name.length + 1));
}

test("the API unit pins the House state root beside the deployment's data", () => {
	assert.ok(assignments(serviceSection(unit), "Environment").includes("XDG_STATE_HOME=/var/lib/acquit/house-state"),
		"the unit sets XDG_STATE_HOME=/var/lib/acquit/house-state");
});

test("the API unit keeps the hardening and grants the data dir and Docker socket within it", () => {
	const section = serviceSection(unit);
	assert.match(section, /^ProtectHome=true$/m, "ProtectHome stays on");
	assert.match(section, /^ProtectSystem=strict$/m, "ProtectSystem stays strict");
	const grants = assignments(section, "ReadWritePaths");
	assert.ok(grants.some(paths => {
		const granted = paths.split(/\s+/);
		return granted.includes("/var/lib/acquit") && granted.includes("/var/run/docker.sock");
	}), `one ReadWritePaths grant must cover both /var/lib/acquit and /var/run/docker.sock (found ${JSON.stringify(grants)})`);
});

test("configure.sh installs the tracked unit, so a deploy reproduces the grants", () => {
	assert.match(configure, /for file in acquit-api\.service acquit-verifier\.service/);
	assert.match(configure, /\/etc\/systemd\/system\/\$file/);
});
