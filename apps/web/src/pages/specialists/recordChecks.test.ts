import assert from "node:assert/strict";
import { test } from "node:test";
import { recordCounts, recordExamId } from "./recordChecks.ts";
import type { ExamRead, SpecialistAgent } from "./types.ts";
const agent: SpecialistAgent = { id:"mine",name:"mine",task:"code",runner:"claude-code",sample:null,acquitted:true,grade:45,seeded:false,simulated:true,examId:"passed" };
const read: ExamRead = { acquitted:true,exam:{ id:"passed",status:"PASSED",visible:{ passed:48,total:48 },hidden:{ passed:8,total:8 },reasons:[],startedAt:null,endedAt:null,simulated:true } };
test("only the viewer's named non-seeded acquittal permits an owner exam read", () => {
  assert.equal(recordExamId(agent,[agent]),"passed");
  assert.equal(recordExamId(agent,[]),null);
  assert.equal(recordExamId({ ...agent,seeded:true },[agent]),null);
  assert.equal(recordExamId({ ...agent,acquitted:false },[agent]),null);
  assert.equal(recordExamId({ ...agent,task:"print-fdm" },[agent]),null);
});
test("counts are real aggregates from the exact passed exam or omitted", () => {
  assert.deepEqual(recordCounts(read,"passed"),{ visible:{ passed:48,total:48 },hidden:{ passed:8,total:8 } });
  assert.equal(recordCounts(read,"different"),null);
  assert.equal(recordCounts({ ...read,exam:{ ...read.exam,status:"FAILED" } },"passed"),null);
  assert.equal(recordCounts(null,"passed"),null);
});
