import assert from "node:assert/strict";
import test from "node:test";
import { validateSpec } from "../src/spec.ts";
import { SAMPLE_SPEC_JSON } from "../src/samples.ts";

// The job spec is untrusted JSON. A physically impossible dimension, a negative limit, a pad in two nets, a duplicate
// pad name, reversed keepout bounds, or a power-net reference to a missing net must each be refused. The unmodified
// sample is the base for every mutation, and it must validate, so each refusal is caused by its one mutation.

type Json = Record<string, unknown>;

const fresh = (): Json => JSON.parse(SAMPLE_SPEC_JSON) as Json;

const partNamed = (j: Json, ref: string): Json => {
	const found = (j.parts as Json[]).find(p => p.ref === ref);
	assert.ok(found, `no part ${ref} in the sample`);
	return found;
};

const padNamed = (j: Json, ref: string, name: string): Json => {
	const found = (partNamed(j, ref).pads as Json[]).find(p => p.name === name);
	assert.ok(found, `no pad ${ref}.${name} in the sample`);
	return found;
};

const nets = (j: Json): Record<string, string[]> => j.netlist as Record<string, string[]>;

/** Applies one mutation to a fresh sample and asserts the spec is refused. */
function refused(label: string, mutate: (j: Json) => void): void {
	const j = fresh();
	mutate(j);
	assert.equal(validateSpec(j).ok, false, `${label} should be refused`);
}

test("the unmodified sample validates, so each refusal below is caused by its mutation", () => {
	assert.equal(validateSpec(fresh()).ok, true);
});

test("a board with a zero or negative dimension is refused", () => {
	refused("negative width", j => {
		(j.board as Json).size = [-40, 25];
	});
	refused("zero height", j => {
		(j.board as Json).size = [40, 0];
	});
});

test("a negative board tolerance is refused", () => {
	refused("tolerance -0.1", j => {
		(j.board as Json).tolerance = -0.1;
	});
});

test("each negative rule limit is refused on its own", () => {
	for (const key of ["minTrackWidth", "minClearance", "minViaDrill", "minAnnularRing", "edgeClearance"]) {
		refused(key, j => {
			(j.rules as Json)[key] = -1;
		});
	}
});

test("a negative power-net width is refused", () => {
	refused("VIN width -0.5", j => {
		((j.rules as Json).powerNets as Json).VIN = -0.5;
	});
});

test("a power net that names no net in the netlist is refused", () => {
	refused("MISSING", j => {
		((j.rules as Json).powerNets as Json).MISSING = 0.5;
	});
	refused("an own key named constructor", j => {
		(j.rules as Json).powerNets = JSON.parse('{"VIN": 0.5, "constructor": 0.5}') as Json;
	});
});

test("a power net whose netlist entry has no pads is refused", () => {
	refused("VIN with no pads", j => {
		nets(j).VIN = [];
	});
});

test("a pad with a zero or negative size dimension is refused", () => {
	refused("J1.1 width -1", j => {
		padNamed(j, "J1", "1").size = [-1, 1.7];
	});
	refused("J1.1 height 0", j => {
		padNamed(j, "J1", "1").size = [1.7, 0];
	});
});

test("a pad with a zero or negative drill is refused", () => {
	refused("J1.1 drill 0", j => {
		padNamed(j, "J1", "1").drill = 0;
	});
	refused("J1.1 drill -1", j => {
		padNamed(j, "J1", "1").drill = -1;
	});
});

test("a drill on an SMD pad, or a plated hole with no drill, is refused", () => {
	refused("SMD pad with a drill", j => {
		padNamed(j, "U1", "1").drill = 0.5;
	});
	refused("thru-hole pad with no drill", j => {
		delete padNamed(j, "J1", "1").drill;
	});
});

test("two pads with the same name in one part are refused", () => {
	refused("U1 pad 1 twice", j => {
		const dup = { ...padNamed(j, "U1", "1") };
		(partNamed(j, "U1").pads as Json[]).push(dup);
	});
});

test("a pad that is in two nets is refused", () => {
	// J2.3 is already SIG1's only pad. Appending it to SIG2 must not silently keep the first net.
	refused("J2.3 in SIG1 and SIG2", j => {
		(nets(j).SIG2 as string[]).push("J2.3");
	});
});

test("a pad listed twice in one net is refused", () => {
	refused("J2.3 twice in SIG1", j => {
		(nets(j).SIG1 as string[]).push("J2.3");
	});
});

test("a keepout whose bounds are reversed or flat is refused", () => {
	refused("reversed x bounds", j => {
		const k = (j.keepouts as Json[])[0] as Json;
		k.min = [116, 114];
		k.max = [112, 116.5];
	});
	refused("flat y bounds", j => {
		const k = (j.keepouts as Json[])[0] as Json;
		k.max = [116, 114];
	});
});

test("a mounting hole with a zero or negative drill is refused", () => {
	refused("drill 0", j => {
		((j.mountingHoles as Json[])[0] as Json).drill = 0;
	});
});

test("a net named __proto__ is kept as a net, not written into a prototype", () => {
	const j = fresh();
	j.netlist = JSON.parse('{"__proto__": ["J1.1"]}') as Json;
	j.rules = { ...(j.rules as Json), powerNets: {} };
	const r = validateSpec(j);
	if (!r.ok) throw new Error(r.error);
	assert.deepEqual(Object.keys(r.spec.netlist), ["__proto__"]);
	assert.deepEqual(r.spec.netlist["__proto__"], ["J1.1"]);
});
