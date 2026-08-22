package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	_ "modernc.org/sqlite"
)

func TestConversationSessionsAreIndependentAndSoftDeleted(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "sessions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	project, err := db.CreateProject(ctx, "sessions")
	if err != nil {
		t.Fatal(err)
	}
	first, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "unprovisioned" || first.CodexThreadID != "" {
		t.Fatalf("unexpected default session: %+v", first)
	}
	second, err := db.CreateConversationSession(ctx, project.ID, "분석 대화", core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkConversationSessionProvisioning(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	threadID, err := db.SetConversationSessionThreadIfEmpty(ctx, second.ID, "thread-second")
	if err != nil || threadID != "thread-second" {
		t.Fatalf("thread=%q err=%v", threadID, err)
	}
	configuration := core.RunConfiguration{
		Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault,
		ContextProfile: core.ContextProfileLong1M,
	}
	if err := db.UpdateConversationSessionSettings(ctx, second.ID, configuration); err != nil {
		t.Fatal(err)
	}
	renamed, err := db.RenameConversationSession(ctx, second.ID, "새 이름")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Title != "새 이름" || renamed.Model != configuration.Model || renamed.Status != "active" || renamed.ContextProfile != core.ContextProfileLong1M {
		t.Fatalf("renamed session: %+v", renamed)
	}
	if err := db.DeleteConversationSession(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	sessions, err := db.ListConversationSessions(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].ID != second.ID {
		t.Fatalf("active sessions: %+v", sessions)
	}
	if err := db.DeleteConversationSession(ctx, second.ID); !errors.Is(err, ErrLastConversationSession) {
		t.Fatalf("last session delete error = %v", err)
	}
}

func TestConversationSessionTitlesPreserveUnicodeAndRejectDamage(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "session-title-utf8.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	project, err := db.CreateProject(ctx, "unicode session title")
	if err != nil {
		t.Fatal(err)
	}
	const createdTitle = "해석 대화 😀 – 재검증"
	session, err := db.CreateConversationSession(ctx, project.ID, "  "+createdTitle+"  ", core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	if session.Title != createdTitle {
		t.Fatalf("created title = %q, want %q", session.Title, createdTitle)
	}
	const renamedTitle = "후속 대화 🛩️"
	renamed, err := db.RenameConversationSession(ctx, session.ID, renamedTitle)
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Title != renamedTitle {
		t.Fatalf("renamed title = %q, want %q", renamed.Title, renamedTitle)
	}
	for _, damaged := range []string{"손상된 이름 \uFFFD", "invalid \xff"} {
		if _, err := db.CreateConversationSession(ctx, project.ID, damaged, core.RunConfiguration{}); err == nil {
			t.Fatalf("created damaged session title %q", damaged)
		}
		if _, err := db.RenameConversationSession(ctx, session.ID, damaged); err == nil {
			t.Fatalf("renamed session to damaged title %q", damaged)
		}
	}
	stored, err := db.ConversationSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Title != renamedTitle {
		t.Fatalf("rejected rename mutated title to %q", stored.Title)
	}
}

func TestConversationSessionDeleteRejectsRecoverableRun(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "busy-session.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	project, err := db.CreateProject(ctx, "busy")
	if err != nil {
		t.Fatal(err)
	}
	first, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetProjectMainThread(ctx, project.ID, "thread-busy"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateConversationSession(ctx, project.ID, "spare", core.RunConfiguration{}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateConversationRunConfigured(ctx, first.ID, "", "question", "thread-busy", core.RunConfiguration{}); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteConversationSession(ctx, first.ID); !errors.Is(err, ErrConversationSessionBusy) {
		t.Fatalf("busy session delete error = %v", err)
	}
}

func TestConversationSessionMigrationPreservesLegacyThreadAndRun(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	migrations := []string{initialSchema, downloadsSchema, runConfigurationSchema}
	for index, migration := range migrations {
		if _, err := raw.Exec(migration); err != nil {
			t.Fatalf("apply legacy migration %d: %v", index+1, err)
		}
		sum := sha256.Sum256([]byte(migration))
		if _, err := raw.Exec(`INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)`,
			index+1, hex.EncodeToString(sum[:]), formatTime(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	now := formatTime(time.Now())
	if _, err := raw.Exec(`INSERT INTO projects(id, name, main_thread_id, created_at, updated_at) VALUES('prj_legacy','legacy','thread-legacy',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`
INSERT INTO runs(id, project_id, schedule_id, question, status, revision, revision_cycle,
 main_thread_id, report_artifact_id, error, created_at, updated_at, model, reasoning_effort, service_tier)
VALUES('run_legacy','prj_legacy','','question','queued',0,0,'thread-legacy','','',?,?,'','','')`, now, now); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	session, err := db.DefaultConversationSession(ctx, "prj_legacy")
	if err != nil {
		t.Fatal(err)
	}
	if session.CodexThreadID != "thread-legacy" || session.Status != "active" {
		t.Fatalf("migrated session: %+v", session)
	}
	run, err := db.Run(ctx, "run_legacy")
	if err != nil {
		t.Fatal(err)
	}
	if run.ConversationSessionID != session.ID || run.MainThreadID != "thread-legacy" {
		t.Fatalf("migrated run: %+v", run)
	}
}

func TestConversationSessionProvisioningBecomesUnknownAfterRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "restart.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	project, err := db.CreateProject(ctx, "restart")
	if err != nil {
		t.Fatal(err)
	}
	session, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkConversationSessionProvisioning(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	session, err = db.ConversationSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Status != "creation_unknown" || session.CodexThreadID != "" {
		t.Fatalf("recovered session: %+v", session)
	}
}

func TestWorkerOpenDoesNotRecoverPrimarySessionProvisioning(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "aetherops.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	project, err := db.CreateProject(ctx, "worker provisioning isolation")
	if err != nil {
		t.Fatal(err)
	}
	session, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkConversationSessionProvisioning(ctx, session.ID); err != nil {
		t.Fatal(err)
	}

	worker, err := OpenWorker(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	workerSession, err := worker.ConversationSession(ctx, session.ID)
	closeErr := worker.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	if workerSession.Status != "provisioning" || workerSession.CodexThreadID != "" {
		t.Fatalf("worker open changed primary provisioning: %+v", workerSession)
	}
	primarySession, err := db.ConversationSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if primarySession.Status != "provisioning" || primarySession.CodexThreadID != "" {
		t.Fatalf("primary provisioning changed after worker open: %+v", primarySession)
	}
}
