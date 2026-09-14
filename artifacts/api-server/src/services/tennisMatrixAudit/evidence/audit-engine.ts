// Re-export shim. The frozen engine lives in @workspace/truth-engine; the ported evidence
// producers import it by its original relative path, so this keeps those imports resolving
// without duplicating a single line of engine logic.
export * from "@workspace/truth-engine/audit-engine";
