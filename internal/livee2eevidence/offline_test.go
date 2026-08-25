package livee2eevidence

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/livee2econtract"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestVerifyMCPEvidenceRequiresAtomicOriginMarkerAndCASReadback(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	database, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "live-e2e")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "question", "thread-main")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "thread-collect", "")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("actual captured primary source"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.CaptureEvidenceFromMCP(ctx, run.ID, attempt.ID,
		"https://93.184.216.34/primary", "Primary source", "Publisher", "text/plain", receipt); err != nil {
		t.Fatal(err)
	}
	casHashes := map[string]bool{}
	proofs, err := verifyMCPEvidence(ctx, database, objects, run.ID, casHashes)
	if err != nil {
		t.Fatal(err)
	}
	if len(proofs) != 1 || !proofs[0].InternalMCP || !casHashes[receipt.Hash] {
		t.Fatalf("unexpected MCP proof: %+v / %+v", proofs, casHashes)
	}
	if _, err := database.SQL().ExecContext(ctx,
		`UPDATE run_events SET payload_json=json_remove(payload_json,'$.origin') WHERE run_id=? AND kind='evidence.captured'`, run.ID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyMCPEvidence(ctx, database, objects, run.ID, map[string]bool{}); err == nil {
		t.Fatal("evidence without the atomic internal_mcp event marker was accepted")
	}
}

func TestLiveVerificationStageContractRejectsMissingFakeAndOverflow(t *testing.T) {
	regular := livee2econtract.StageProof{
		StageAttemptID: "stg_screen", Stage: string(core.StageCollect), Ordinal: 0, WorkstreamID: "ws-0",
	}
	verification := livee2econtract.StageProof{
		StageAttemptID: "stg_verify", Stage: string(core.StageCollect),
		Ordinal: core.EngineeringVerificationOrdinal, WorkstreamID: "aetherops_engineering_verification",
	}
	ordinarySolver := livee2econtract.SolverProof{
		StageAttemptID: regular.StageAttemptID, RuntimeBundleSHA256: strings.Repeat("a", 64),
		PhysicalArgumentsSHA256: strings.Repeat("b", 64),
	}
	if err := validateLiveCollectorProofs([]livee2econtract.StageProof{regular}); err != nil {
		t.Fatal(err)
	}
	if err := verifyLiveSolverStageContract([]livee2econtract.StageProof{regular}, ordinarySolver); err != nil {
		t.Fatal(err)
	}

	missing := ordinarySolver
	missing.ExecutionPurpose = "independent_verification"
	missing.VerificationOfJobID = "eng_screen"
	missing.VerificationSourceStageAttemptID = regular.StageAttemptID
	if err := verifyLiveSolverStageContract([]livee2econtract.StageProof{regular}, missing); err == nil {
		t.Fatal("independent verification without ordinal 3 was accepted")
	}
	if err := verifyLiveSolverStageContract([]livee2econtract.StageProof{regular, verification}, ordinarySolver); err == nil {
		t.Fatal("fake ordinal-3 bundle without its solver was accepted")
	}

	valid := missing
	valid.StageAttemptID = verification.StageAttemptID
	valid.VerificationSourceRuntimeSHA256 = valid.RuntimeBundleSHA256
	valid.VerificationSourceComponent = "xfoil"
	valid.Component = "xfoil"
	valid.VerificationSourceVersion = "6.99"
	valid.Version = "6.99"
	valid.VerificationSourceSpecSHA256 = strings.Repeat("c", 64)
	valid.VerificationSourcePhysicalSHA256 = strings.Repeat("e", 64)
	valid.VerificationSourceReceiptID = "art_screen_receipt"
	valid.VerificationSourceReceiptSHA256 = strings.Repeat("d", 64)
	if err := validateLiveCollectorProofs([]livee2econtract.StageProof{regular, verification}); err != nil {
		t.Fatal(err)
	}
	if err := verifyLiveSolverStageContract([]livee2econtract.StageProof{regular, verification}, valid); err != nil {
		t.Fatal(err)
	}
	tampered := valid
	tampered.VerificationSourcePhysicalSHA256 = tampered.PhysicalArgumentsSHA256
	if err := verifyLiveSolverStageContract([]livee2econtract.StageProof{regular, verification}, tampered); err == nil {
		t.Fatal("verification that reused the screening physical-resolution identity was accepted")
	}

	overflow := livee2econtract.StageProof{
		StageAttemptID: "stg_overflow", Stage: string(core.StageCollect),
		Ordinal: core.EngineeringVerificationOrdinal + 1, WorkstreamID: "ws-overflow",
	}
	if err := validateLiveCollectorProofs([]livee2econtract.StageProof{regular, overflow}); err == nil {
		t.Fatal("collector ordinal above the reserved verification slot was accepted")
	}
	wrongReserved := verification
	wrongReserved.WorkstreamID = "ws-fake"
	if err := validateLiveCollectorProofs([]livee2econtract.StageProof{regular, wrongReserved}); err == nil {
		t.Fatal("ordinal 3 with a fake workstream was accepted")
	}
}
